"""Fetch calibration / evaluation text from a Hugging Face dataset (core env).

args: {"preset": "wikitext2-test"|"wikitext2-train"|"pile-val"|"c4-en"|null,
       "dataset": "<hf id>"|null, "config": null|"...", "split": "train", "column": "text",
       "max_chars": 2000000, "max_rows": null, "out_path": "<txt path>",
       "join": null|"raw"|"blank"}

Rows are streamed (nothing large is cached) and concatenated until max_chars.
``join``: "blank" joins non-empty texts with a blank line (default for most
sets); "raw" concatenates rows verbatim, which for wikitext-2-raw reproduces
the original ``wiki.test.raw`` file used by llama.cpp's perplexity tool
(default for the wikitext presets).

result: {"out_path":..., "chars":n, "rows":n, "sha256":"..."}
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import (  # noqa: E402
    Progress,
    emit,
    fail,
    install_tqdm_hook,
    load_args,
    log,
    require,
    run,
    set_env,
    stage,
)

import hashlib  # noqa: E402

PRESETS = {
    "wikitext2-test": {"dataset": "Salesforce/wikitext", "config": "wikitext-2-raw-v1", "split": "test", "join": "raw"},
    "wikitext2-train": {"dataset": "Salesforce/wikitext", "config": "wikitext-2-raw-v1", "split": "train", "join": "raw"},
    "pile-val": {"dataset": "mit-han-lab/pile-val-backup", "config": None, "split": "validation", "join": "blank"},
    "c4-en": {"dataset": "allenai/c4", "config": "en", "split": "validation", "join": "blank"},
}


def main():
    args = load_args()
    set_env("core")
    out_path = os.path.abspath(os.path.expanduser(require(args, "out_path")))
    preset = args.get("preset") or None
    if preset:
        if preset not in PRESETS:
            fail(f"Unknown preset '{preset}'.", f"Use one of: {', '.join(PRESETS)}.")
        spec = dict(PRESETS[preset])
    else:
        spec = {
            "dataset": require(args, "dataset"),
            "config": args.get("config") or None,
            "split": args.get("split") or "train",
            "join": "blank",
        }
    if args.get("join") in ("raw", "blank"):
        spec["join"] = args["join"]
    column = args.get("column") or "text"
    max_chars = int(args.get("max_chars") or 2_000_000)
    max_rows = args.get("max_rows")
    max_rows = int(max_rows) if max_rows else None
    if max_chars <= 0:
        fail("max_chars must be positive.")

    install_tqdm_hook(label="Downloading")
    stage("open", f"Opening {spec['dataset']}" + (f" ({spec['config']})" if spec["config"] else "") + f" [{spec['split']}]")
    import datasets

    try:
        datasets.logging.set_verbosity_warning()
    except Exception:
        pass
    try:
        ds = datasets.load_dataset(spec["dataset"], spec["config"], split=spec["split"], streaming=True)
    except ImportError as e:
        # e.g. pile-val is a .jsonl.zst file and needs the zstandard package
        fail(f"Reading this dataset needs an extra package: {e}", "Repair the core environment in Environment.")
    except ValueError as e:
        msg = str(e)
        if "split" in msg.lower():
            fail(f"Split '{spec['split']}' not found: {msg}", "Check the split name on the dataset page.")
        if "config" in msg.lower() or "builderconfig" in msg.lower():
            fail(f"Config problem: {msg}", "Set the dataset config (subset) name shown on the dataset page.")
        raise

    stage("fetch", "Collecting text")
    prog = Progress(max_chars, unit="chars", label="Collecting text")
    parts = []
    sep = "" if spec["join"] == "raw" else "\n\n"
    counters = {"chars": 0, "rows": 0}
    try:
        _collect(ds, column, spec, sep, parts, prog, max_chars, max_rows, counters)
    except ValueError as e:
        msg = str(e)
        if "zstd" in msg.lower() or "compression type" in msg.lower():
            fail(
                f"This dataset is zstd-compressed and the 'zstandard' package is missing ({msg}).",
                "Repair the core environment in Environment (it needs the zstandard package).",
            )
        raise
    rows = counters["rows"]

    content = "".join(parts)
    if len(content) > max_chars:
        content = content[:max_chars]
    if not content.strip():
        fail("No text was collected from this dataset.", "Check the column name and split.")
    prog.finish()

    stage("write", "Writing text file")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    data = content.encode("utf-8")
    tmp = out_path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, out_path)
    sha = hashlib.sha256(data).hexdigest()
    log(f"Wrote {len(content):,} chars from {rows:,} rows to {out_path}")
    emit(
        "result",
        out_path=out_path,
        chars=len(content),
        rows=rows,
        sha256=sha,
        bytes=len(data),
        dataset=spec["dataset"],
        config=spec["config"],
        split=spec["split"],
        join=spec["join"],
    )
    return 0


def _collect(ds, column, spec, sep, parts, prog, max_chars, max_rows, counters):
    chars = 0
    rows = 0
    for row in ds:
        if column not in row:
            fail(
                f"Column '{column}' not found. Available columns: {', '.join(map(str, row.keys()))}",
                "Set the text column name.",
            )
        text = row[column]
        if text is None:
            continue
        if not isinstance(text, str):
            text = str(text)
        if spec["join"] != "raw":
            text = text.strip()
            if not text:
                continue
            if parts:
                text = sep + text
        parts.append(text)
        chars += len(text)
        rows += 1
        prog.set(min(chars, max_chars))
        if chars >= max_chars:
            break
        if max_rows is not None and rows >= max_rows:
            break
    counters["chars"] = chars
    counters["rows"] = rows


if __name__ == "__main__":
    run(main, env="core")
