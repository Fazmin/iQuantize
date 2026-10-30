"""Shared helpers for iQuantize driver scripts.

Contract (see the Rust side): every driver is started as
    <venv python> -u -I -X utf8 <drivers_dir>/<name>.py '<json args>'
and talks back through single-line events on stdout:
    @@IQ {"t":"progress","done":3,"total":10,...}
Everything else a driver or a library prints is shown as a raw log line.

To keep the event stream clean, this module keeps a private handle on the real
stdout for events and points ``sys.stdout`` at stderr, so stray ``print()``
calls from libraries (which may use ``end="\\r"``) can never split an event
line. Native code that writes to file descriptor 1 directly still lands on
stdout, but each event is written as one complete line under a lock.
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
import traceback

PREFIX = "@@IQ "

# --------------------------------------------------------------------------
# stdio setup
# --------------------------------------------------------------------------


def _reconfigure(stream):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass


_reconfigure(sys.stdout)
_reconfigure(sys.stderr)

# Real stdout is reserved for events; library prints go to stderr.
_EVENT_OUT = sys.stdout
sys.stdout = sys.stderr

_EMIT_LOCK = threading.Lock()
_CURRENT_ENV: str | None = None
_RESULT_SENT = False


def set_env(name: str | None) -> None:
    """Remember which managed venv this driver runs in (used for repair hints)."""
    global _CURRENT_ENV
    _CURRENT_ENV = name


def get_env() -> str | None:
    return _CURRENT_ENV


# --------------------------------------------------------------------------
# events
# --------------------------------------------------------------------------


def _jsonable(obj):
    """Convert numpy scalars/arrays, paths, sets and non-finite floats to plain JSON."""
    if obj is None or isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, os.PathLike):
        return os.fspath(obj)
    # numpy / mlx scalars and arrays without importing them
    item = getattr(obj, "item", None)
    tolist = getattr(obj, "tolist", None)
    shape = getattr(obj, "shape", None)
    if shape is not None and tolist is not None and len(tuple(shape)) > 0:
        return _jsonable(tolist())
    if item is not None:
        try:
            return _jsonable(item())
        except Exception:
            pass
    return str(obj)


def emit(t: str, **fields) -> None:
    """Write one structured event line to stdout and flush immediately."""
    global _RESULT_SENT
    obj = {"t": t}
    obj.update(fields)
    line = PREFIX + json.dumps(
        _jsonable(obj), ensure_ascii=True, separators=(",", ":"), allow_nan=False
    )
    with _EMIT_LOCK:
        if t == "result":
            _RESULT_SENT = True
        try:
            _EVENT_OUT.write(line + "\n")
            _EVENT_OUT.flush()
        except (BrokenPipeError, ValueError):
            # Parent went away; nothing sensible left to do.
            pass


def stage(key: str, label: str, **extra) -> None:
    emit("stage", key=key, label=label, **extra)


def log(message: str, level: str = "info", **extra) -> None:
    emit("log", level=level, message=str(message), **extra)


def warn(message: str, **extra) -> None:
    log(message, level="warn", **extra)


def result(**payload) -> None:
    emit("result", **payload)


def metric(name: str, value, step=None, **extra) -> None:
    fields = {"name": name, "value": value}
    if step is not None:
        fields["step"] = step
    fields.update(extra)
    emit("metric", **fields)


# --------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------


class DriverError(Exception):
    """An expected failure with a user-facing message and optional hint."""

    def __init__(self, message: str, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint


def fail(message: str, hint: str | None = None):
    raise DriverError(message, hint)


def _repair_hint(env: str | None = None) -> str:
    env = env or _CURRENT_ENV
    if env:
        return f"Repair the {env} environment in Environment."
    return "Repair the Python environment in Environment."


def _http_status(exc) -> int | None:
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    if isinstance(code, int):
        return code
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


_MEMORY_HINT = (
    "The machine ran out of memory. Try a smaller model, a shorter context or fewer "
    "chunks, or close other apps and retry."
)


def describe_exception(exc: BaseException) -> tuple[str, str | None]:
    """Map an exception to (message, hint)."""
    if isinstance(exc, DriverError):
        return exc.message, exc.hint

    name = type(exc).__name__
    text = str(exc).strip() or name
    low = text.lower()

    if isinstance(exc, ModuleNotFoundError):
        mod = getattr(exc, "name", None) or text
        return f"Missing Python package: {mod}", _repair_hint()
    if isinstance(exc, ImportError):
        return f"Import failed: {text}", _repair_hint()
    if isinstance(exc, MemoryError):
        return "Out of memory", _MEMORY_HINT

    # Hugging Face Hub errors (huggingface_hub.errors.*) without importing the hub.
    status = _http_status(exc)
    if name == "GatedRepoError" or (status in (401, 403) and "gated" in low):
        return (
            "This model is gated on Hugging Face and access was refused.",
            "Accept the model license on its Hugging Face page and add a token with read access.",
        )
    if name == "RepositoryNotFoundError" or status == 404 and "repo" in low:
        return (
            "Hugging Face repository not found (or it is private).",
            "Check the repo id. Private or gated repos need a token with read access.",
        )
    if status == 401:
        return (
            "Hugging Face rejected the request (401 Unauthorized).",
            "Accept the model license on its Hugging Face page and add a token with read access.",
        )
    if status == 403:
        return (
            "Hugging Face denied access (403 Forbidden).",
            "Accept the model license on its Hugging Face page and add a token with read access.",
        )
    if status == 429:
        return "Hugging Face rate limit reached (429).", "Wait a few minutes, or add a token, then retry."
    if name in ("OfflineModeIsEnabled",):
        return "Hugging Face offline mode is enabled.", "Disable offline mode to download files."
    if name in ("ConnectError", "ConnectionError", "ConnectTimeout", "ReadTimeout", "TimeoutException"):
        return f"Network error: {text}", "Check your internet connection and retry."

    if isinstance(exc, FileNotFoundError):
        return f"File not found: {text}", "Check that the path exists and was not moved or deleted."
    if isinstance(exc, PermissionError):
        return f"Permission denied: {text}", "Choose a folder you can write to, or check its permissions."
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return "The disk is full.", "Free up disk space or choose an output folder on another drive."

    memory_markers = (
        "out of memory",
        "insufficient memory",
        "failed to allocate",
        "cannot allocate memory",
        "bad_alloc",
        "kiogpucommandbuffercallbackerroroutofmemory",
    )
    if any(m in low for m in memory_markers):
        return f"Out of memory: {text}", _MEMORY_HINT

    return f"{name}: {text}", None


def load_args() -> dict:
    """Parse argv[1] as a JSON object. Emits an error event and exits 1 if invalid."""
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        emit("error", message="Missing JSON arguments (argv[1]).", hint="This is an iQuantize bug; please report it.")
        sys.exit(1)
    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        emit("error", message=f"Invalid JSON arguments: {e}", hint="This is an iQuantize bug; please report it.")
        sys.exit(1)
    if not isinstance(args, dict):
        emit("error", message="JSON arguments must be an object.", hint="This is an iQuantize bug; please report it.")
        sys.exit(1)
    return args


def require(args: dict, key: str):
    val = args.get(key)
    if val is None or (isinstance(val, str) and not val.strip()):
        fail(f"Missing required argument '{key}'.", "This is an iQuantize bug; please report it.")
    return val


def run(main, env: str | None = None) -> None:
    """Run ``main()``; convert exceptions into an error event and exit codes."""
    if env is not None and _CURRENT_ENV is None:
        set_env(env)
    try:
        rc = main()
    except KeyboardInterrupt:
        try:
            log("Cancelled", level="warn")
        except Exception:
            pass
        _flush_all()
        os._exit(130)
    except SystemExit:
        _flush_all()
        raise
    except BaseException as exc:  # noqa: BLE001 - we want everything
        try:
            traceback.print_exc(file=sys.stderr)
        except Exception:
            pass
        msg, hint = describe_exception(exc)
        fields = {"message": msg}
        if hint:
            fields["hint"] = hint
        emit("error", **fields)
        _flush_all()
        sys.exit(1)
    _flush_all()
    sys.exit(int(rc or 0))


def _flush_all():
    for s in (_EVENT_OUT, sys.stderr):
        try:
            s.flush()
        except Exception:
            pass


# --------------------------------------------------------------------------
# progress
# --------------------------------------------------------------------------


class Progress:
    """Throttled progress reporter (at most ~10 events/s, final value always sent)."""

    def __init__(self, total=0, unit: str = "steps", label: str = "", min_interval: float = 0.1):
        self.total = int(total or 0)
        self.unit = unit
        self.label = label
        self.done = 0
        self.min_interval = min_interval
        self._last = 0.0
        self._last_sent = None
        self._lock = threading.Lock()

    def _send(self, force: bool):
        now = time.monotonic()
        state = (self.done, self.total, self.label)
        if not force and (now - self._last) < self.min_interval:
            return
        if state == self._last_sent and not force:
            return
        self._last = now
        self._last_sent = state
        emit("progress", done=int(self.done), total=int(self.total), unit=self.unit, label=self.label)

    def set(self, done, total=None, label: str | None = None, force: bool = False):
        with self._lock:
            self.done = int(done)
            if total is not None:
                self.total = int(total)
            if label is not None:
                self.label = label
            finished = self.total > 0 and self.done >= self.total
            self._send(force or finished)

    def update(self, n=1, label: str | None = None):
        self.set(self.done + n, label=label)

    def finish(self, label: str | None = None):
        with self._lock:
            if self.total and self.done < self.total:
                self.done = self.total
            if label is not None:
                self.label = label
            self._send(True)


_DEVNULL = None


def _devnull():
    global _DEVNULL
    if _DEVNULL is None:
        _DEVNULL = open(os.devnull, "w", encoding="utf-8")
    return _DEVNULL


def install_tqdm_hook(label: str | None = None, unit: str | None = None, quiet: bool = True) -> bool:
    """Monkeypatch tqdm so every bar also emits throttled ``progress`` events.

    Call this BEFORE importing libraries that subclass tqdm at import time
    (huggingface_hub, datasets, transformers). ``unit`` overrides the unit;
    otherwise byte bars ("B") map to "bytes" and others to "steps".
    With ``quiet=True`` the textual bar is sent to /dev/null (events replace it).
    """
    try:
        import tqdm as tqdm_pkg
        import tqdm.std as tqdm_std
    except Exception:
        return False

    def wrap(base):
        if base is None or getattr(base, "_iq_hooked", False):
            return base

        class IQTqdm(base):  # type: ignore[misc, valid-type]
            _iq_hooked = True

            def __init__(self, *a, **kw):
                if quiet and kw.get("file") is None and not kw.get("gui"):
                    kw["file"] = _devnull()
                if kw.get("disable") is None:
                    # disable=None means "auto-disable on non-TTY": we need counting.
                    kw["disable"] = False
                self._iq_last = 0.0
                super().__init__(*a, **kw)

            def _iq_report(self, final: bool):
                try:
                    if getattr(self, "disable", False):
                        return
                    now = time.monotonic()
                    if not final and now - self._iq_last < 0.1:
                        return
                    self._iq_last = now
                    bar_unit = str(getattr(self, "unit", "it") or "it")
                    u = unit or ("bytes" if bar_unit in ("B", "b", "byte", "bytes") else "steps")
                    desc = str(getattr(self, "desc", "") or "").strip().rstrip(":").strip()
                    if label and desc:
                        lab = f"{label}: {desc}"
                    else:
                        lab = label or desc or "Working"
                    total = getattr(self, "total", None) or 0
                    state = (int(self.n), int(total), lab)
                    if state == getattr(self, "_iq_sent", None):
                        return
                    self._iq_sent = state
                    emit("progress", done=state[0], total=state[1], unit=u, label=lab)
                except Exception:
                    pass

            def update(self, n=1):
                r = super().update(n)
                self._iq_report(False)
                return r

            def close(self):
                if not getattr(self, "_iq_closed", False):
                    self._iq_closed = True
                    self._iq_report(True)
                return super().close()

        IQTqdm.__name__ = getattr(base, "__name__", "tqdm")
        IQTqdm.__qualname__ = IQTqdm.__name__
        return IQTqdm

    hooked_std = wrap(tqdm_std.tqdm)
    tqdm_std.tqdm = hooked_std
    tqdm_pkg.tqdm = hooked_std
    for modname in ("tqdm.auto", "tqdm.autonotebook", "tqdm.asyncio"):
        try:
            mod = __import__(modname, fromlist=["tqdm"])
            cls = getattr(mod, "tqdm", None)
            if cls is not None and cls is not hooked_std:
                mod.tqdm = wrap(cls)
        except Exception:
            pass
    # huggingface_hub keeps its own subclass; patch it too if already imported.
    hub_tqdm = sys.modules.get("huggingface_hub.utils.tqdm")
    if hub_tqdm is not None and getattr(hub_tqdm, "tqdm", None) is not None:
        try:
            hub_tqdm.tqdm = wrap(hub_tqdm.tqdm)
        except Exception:
            pass
    return True


# --------------------------------------------------------------------------
# misc utilities
# --------------------------------------------------------------------------


def human_bytes(n) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000.0
    return f"{n:.1f} PB"


def dir_size(path) -> int:
    total = 0
    path = os.fspath(path)
    if os.path.isfile(path):
        return os.path.getsize(path)
    for root, _dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            try:
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def list_files(path) -> list[dict]:
    """[{"path": relative posix path, "bytes": size}] for every file under ``path``."""
    out = []
    base = os.fspath(path)
    for root, dirs, files in os.walk(base):
        dirs.sort()
        for f in sorted(files):
            fp = os.path.join(root, f)
            if os.path.islink(fp):
                continue
            try:
                size = os.path.getsize(fp)
            except OSError:
                continue
            rel = os.path.relpath(fp, base).replace(os.sep, "/")
            out.append({"path": rel, "bytes": int(size)})
    return out


def package_versions(names) -> dict:
    """{name: version or None} using importlib.metadata (names are normalized)."""
    from importlib import metadata

    out = {}
    for name in names:
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            out[name] = None
        except Exception:
            out[name] = None
    return out


def ensure_empty_dir(path, what: str = "Output folder") -> str:
    """Create ``path`` or verify it is empty. Returns the absolute path."""
    path = os.path.abspath(os.path.expanduser(os.fspath(path)))
    if os.path.exists(path):
        if not os.path.isdir(path):
            fail(f"{what} exists and is a file: {path}", "Choose a new folder name.")
        visible = [n for n in os.listdir(path) if n not in (".DS_Store",)]
        if visible:
            fail(f"{what} is not empty: {path}", "Choose an empty or new folder.")
    else:
        os.makedirs(path, exist_ok=True)
    return path


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


class Timer:
    def __init__(self):
        self.t0 = time.perf_counter()

    def ms(self) -> float:
        return (time.perf_counter() - self.t0) * 1000.0


__all__ = [
    "PREFIX",
    "DriverError",
    "Progress",
    "Timer",
    "describe_exception",
    "dir_size",
    "emit",
    "ensure_empty_dir",
    "fail",
    "get_env",
    "human_bytes",
    "install_tqdm_hook",
    "list_files",
    "load_args",
    "log",
    "metric",
    "package_versions",
    "read_json",
    "require",
    "result",
    "run",
    "set_env",
    "stage",
    "warn",
]
