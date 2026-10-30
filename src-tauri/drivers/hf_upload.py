"""Upload a folder to a Hugging Face model repo (core env).

args: {"repo_id": "user/name", "folder": "<dir>", "private": true,
       "allow_patterns": [...]|null, "commit_message": "...", "large": false}
result: {"url": "https://huggingface.co/<repo_id>", "commit_sha": ...|null, "commit_url": ...|null}

The token comes only from the HF_TOKEN environment variable (or the token saved
under HF_HOME); it is never printed.

huggingface_hub API differences handled here:
  * 0.x / 1.x: ``upload_folder`` makes one commit; ``upload_large_folder`` (used
    when large=true) is resumable but takes no commit_message and returns None.
  * 2.x: ``upload_large_folder`` is gone; ``upload_folder`` itself streams
    through hf_xet, splits big folders into several commits and resumes.
Progress: tqdm bars are hooked, and hub 2.x's private live display
(``_upload_pipeline._LiveDisplay``) is wrapped to report transferred bytes.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import (  # noqa: E402
    DriverError,
    Progress,
    emit,
    fail,
    install_tqdm_hook,
    list_files,
    load_args,
    log,
    require,
    run,
    set_env,
    stage,
    warn,
)

import fnmatch  # noqa: E402
import re  # noqa: E402

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]*/[A-Za-z0-9][A-Za-z0-9_.\-]*$")
DEFAULT_IGNORE = [".DS_Store", "**/.DS_Store", ".cache/**", "*.part"]


def _status(exc):
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    return code if isinstance(code, int) else None


def _server_message(exc):
    msg = getattr(exc, "server_message", None)
    return (msg or "").strip()


def map_hub_error(exc, repo_id, action):
    code = _status(exc)
    detail = _server_message(exc)
    tail = f" Server said: {detail}" if detail else ""
    if code == 401:
        return DriverError(
            f"Hugging Face rejected the token while trying to {action} (401 Unauthorized).{tail}",
            "Add a valid Hugging Face token with write access in Settings.",
        )
    if code == 403:
        return DriverError(
            f"Permission denied for {repo_id} while trying to {action} (403 Forbidden).{tail}",
            "Use a token with write access. Fine-grained tokens need write permission for this namespace "
            "(user or organization).",
        )
    if code == 409:
        return DriverError(
            f"Conflict while trying to {action} {repo_id} (409).{tail}",
            "A repo with this name may exist as a dataset or Space, or another upload is in progress. "
            "Choose a different name or retry in a moment.",
        )
    if code == 404:
        return DriverError(
            f"{repo_id} was not found while trying to {action} (404).{tail}",
            "Check the namespace in the repo id, and that your token can write to it.",
        )
    if code == 429:
        return DriverError(f"Rate limited by Hugging Face (429).{tail}", "Wait a few minutes and retry.")
    if code is not None and code >= 500:
        return DriverError(f"Hugging Face server error ({code}).{tail}", "Retry later; uploads resume where they stopped.")
    return None


def _matches(rel, patterns):
    return any(fnmatch.fnmatch(rel, p) for p in patterns)


def selected_files(folder, allow_patterns):
    files = list_files(folder)
    out = []
    for f in files:
        rel = f["path"]
        if rel.startswith(".git/") or "/.git/" in rel or rel.startswith(".cache/huggingface/"):
            continue
        if _matches(rel, DEFAULT_IGNORE):
            continue
        if allow_patterns and not _matches(rel, allow_patterns):
            continue
        out.append(f)
    return out


def hook_live_display(total_bytes, total_files):
    """Wrap huggingface_hub 2.x's upload display so it reports progress events."""
    try:
        from huggingface_hub import _upload_pipeline as up
    except Exception:
        return False
    base = getattr(up, "_LiveDisplay", None)
    if base is None or getattr(base, "_iq_hooked", False):
        return False

    class IQLiveDisplay(base):  # type: ignore[misc, valid-type]
        _iq_hooked = True

        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            # Not a TTY: force the counters on, but never draw to the terminal.
            self._tty = False
            self._active = True
            self._iq_bytes = Progress(total_bytes, unit="bytes", label="Uploading")
            self._iq_files = Progress(total_files, unit="files", label="Committing")

        def _iq_emit(self, final=False):
            try:
                with self._lock:
                    sent = int(getattr(self, "_xet_bytes", 0))
                    committed = int(getattr(self, "_committed", 0))
                    commits = int(getattr(self, "_nb_commits", 0))
                    uploaded = len(getattr(self, "_xet_done", ()) or ())
                    xet_total = int(getattr(self, "_xet_total", 0))
                label = f"Uploading ({uploaded}/{xet_total} large files)" if xet_total else "Uploading"
                self._iq_bytes.set(min(sent, total_bytes) if total_bytes else sent, label=label, force=final)
                lab2 = f"Committed {committed}/{total_files} files" + (f" in {commits} commits" if commits > 1 else "")
                self._iq_files.set(committed, label=lab2, force=final)
            except Exception:
                pass

        def _render_loop(self):
            while not self._stop_event.wait(0.5):
                self._iq_emit()

        def close(self):
            try:
                super().close()
            finally:
                self._iq_emit(final=True)

    up._LiveDisplay = IQLiveDisplay
    return True


def main():
    args = load_args()
    set_env("core")
    repo_id = str(require(args, "repo_id")).strip()
    folder = os.path.abspath(os.path.expanduser(require(args, "folder")))
    private = bool(args.get("private", True))
    allow_patterns = args.get("allow_patterns") or None
    if isinstance(allow_patterns, str):
        allow_patterns = [allow_patterns]
    commit_message = (args.get("commit_message") or "").strip() or "Upload with iQuantize"
    large = bool(args.get("large", False))

    if not REPO_RE.match(repo_id) or len(repo_id) > 96:
        fail(f"Invalid repo id '{repo_id}'.", "Use the form 'username/model-name' (letters, digits, '-', '_', '.').")
    if not os.path.isdir(folder):
        fail(f"Folder not found: {folder}", "Check that the model folder still exists.")
    files = selected_files(folder, allow_patterns)
    if not files:
        fail("No files to upload in this folder (after filters).", "Check the folder and the allow patterns.")
    total_bytes = sum(f["bytes"] for f in files)
    log(f"{len(files)} file(s), {total_bytes:,} bytes selected for upload")

    install_tqdm_hook(label="Uploading", unit="bytes")
    import huggingface_hub
    from huggingface_hub import HfApi

    token = os.environ.get("HF_TOKEN") or None
    if token is None:
        try:
            token = huggingface_hub.get_token()
        except Exception:
            token = None
    if not token:
        fail("No Hugging Face token is configured.", "Add a Hugging Face token with write access in Settings.")
    api = HfApi(token=token)

    stage("auth", "Checking token")
    try:
        who = api.whoami()
        name = who.get("name") if isinstance(who, dict) else None
        if name:
            log(f"Authenticated as {name}")
    except Exception as e:
        mapped = map_hub_error(e, repo_id, "check the token")
        if mapped:
            raise mapped from None
        raise

    stage("create_repo", f"Creating {repo_id}")
    try:
        repo_url = api.create_repo(repo_id, repo_type="model", private=private, exist_ok=True)
    except Exception as e:
        mapped = map_hub_error(e, repo_id, "create")
        if mapped:
            raise mapped from None
        raise
    url = str(getattr(repo_url, "url", None) or f"https://huggingface.co/{repo_id}")

    stage("upload", "Uploading files")
    hooked = hook_live_display(total_bytes, len(files))
    commit_sha = None
    commit_url = None
    ignore = DEFAULT_IGNORE
    try:
        if large and hasattr(api, "upload_large_folder"):
            log("Using upload_large_folder (resumable, multi-commit; commit message is not configurable)")
            api.upload_large_folder(
                repo_id=repo_id,
                folder_path=folder,
                repo_type="model",
                allow_patterns=allow_patterns,
                ignore_patterns=ignore,
                private=private,
            )
        else:
            if large:
                log(
                    f"huggingface_hub {huggingface_hub.__version__} uploads large folders through upload_folder "
                    "(streamed, split into several commits when needed, resumable)"
                )
            info = api.upload_folder(
                repo_id=repo_id,
                folder_path=folder,
                repo_type="model",
                commit_message=commit_message,
                allow_patterns=allow_patterns,
                ignore_patterns=ignore,
            )
            commit_sha = getattr(info, "oid", None)
            commit_url = getattr(info, "commit_url", None)
    except Exception as e:
        mapped = map_hub_error(e, repo_id, "upload to")
        if mapped:
            raise mapped from None
        raise
    if not hooked:
        emit("progress", done=total_bytes, total=total_bytes, unit="bytes", label="Uploaded")
    if commit_sha is None and not large:
        warn("The upload finished but no commit information was returned.")
    emit("result", url=url, commit_sha=commit_sha, commit_url=commit_url, files=len(files), bytes=total_bytes, private=private)
    return 0


if __name__ == "__main__":
    run(main, env="core")
