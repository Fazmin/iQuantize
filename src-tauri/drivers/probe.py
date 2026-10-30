"""Probe a managed environment: Python version, package versions and capabilities.

args: {"env": "gguf"|"mlx"|"onnx"|"core", "convert_script": "<path, gguf only>"}
result: {"t":"result","python":"3.12.x","packages":{...},"caps":{...}}

Never fails hard on a broken package: problems are reported inside ``caps``
(``error`` fields) so the UI can offer a repair.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import emit, load_args, log, package_versions, run, set_env, stage  # noqa: E402

import ast  # noqa: E402
import json  # noqa: E402
import platform  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

PACKAGES = {
    "gguf": ["numpy", "torch", "transformers", "safetensors", "sentencepiece", "protobuf", "gguf", "mistral-common", "tokenizers"],
    "mlx": ["mlx", "mlx-metal", "mlx-lm", "transformers", "tokenizers", "huggingface_hub", "numpy", "safetensors", "sentencepiece", "jinja2", "protobuf"],
    "onnx": [
        "onnxruntime",
        "onnxruntime-genai",
        "onnx",
        "onnx-ir",
        "torch",
        "transformers",
        "tokenizers",
        "huggingface_hub",
        "numpy",
        "optimum",
        "optimum-onnx",
        "psutil",
        "jinja2",
        "ml_dtypes",
    ],
    "core": ["huggingface_hub", "hf_xet", "datasets", "numpy", "pyarrow", "fsspec", "zstandard"],
}

SUBPROCESS_TIMEOUT = 180

_FLAG_RE = re.compile(r"(?<![\w-])(--[A-Za-z0-9][\w-]*)")
_CHOICES_RE = re.compile(r"(--[A-Za-z0-9][\w-]*)\s+\{([^}]*)\}")


def _py_cmd(*args):
    return [sys.executable, "-I", "-X", "utf8", *args]


def _run_cmd(cmd, timeout=SUBPROCESS_TIMEOUT):
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["TQDM_DISABLE"] = "1"
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            timeout=timeout,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"timed out after {timeout}s"
    except OSError as e:
        return -1, "", str(e)


def _last_error_line(text: str) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    lines = [ln for ln in lines if not ln.startswith("objc[")]
    for ln in reversed(lines):
        if re.match(r"^[A-Za-z_.]*(Error|Exception)\b", ln):
            return ln[:500]
    return lines[-1][:500] if lines else ""


def parse_help_text(text: str) -> dict:
    """Parse an argparse --help text into flags and {flag: choices}."""
    flags = []
    for f in _FLAG_RE.findall(text or ""):
        if f not in flags and f != "--help":
            flags.append(f)
    choices = {}
    for flag, ch in _CHOICES_RE.findall(text or ""):
        choices.setdefault(flag, [c.strip() for c in ch.split(",") if c.strip()])
    return {"flags": flags, "choices": choices}


def parser_info(parser) -> dict:
    """Structured info from an argparse.ArgumentParser instance."""
    flags, choices, options = [], {}, []
    for act in getattr(parser, "_actions", []):
        opts = list(getattr(act, "option_strings", []) or [])
        if not opts or "--help" in opts:
            continue
        long_opts = [o for o in opts if o.startswith("--")] or opts
        flags.extend(long_opts)
        ch = getattr(act, "choices", None)
        entry = {"flags": opts, "dest": act.dest}
        if ch is not None:
            ch = [c if isinstance(c, (str, int, float, bool)) else str(c) for c in ch]
            for o in long_opts:
                choices[o] = ch
            entry["choices"] = ch
        default = getattr(act, "default", None)
        if isinstance(default, (str, int, float, bool)) or default is None:
            entry["default"] = default
        if act.help and act.help != "==SUPPRESS==":
            entry["help"] = str(act.help)
        options.append(entry)
    return {"flags": flags, "choices": choices, "options": options}


def safe_format_help(parser) -> str:
    """format_help() that survives stray '%' characters in help strings."""
    try:
        return parser.format_help()
    except Exception:
        pass
    for act in getattr(parser, "_actions", []):
        if isinstance(act.help, str):
            act.help = re.sub(r"%(?!\()", "%%", act.help)
    try:
        return parser.format_help()
    except Exception as e:  # pragma: no cover
        return f"(help unavailable: {e})"


# --------------------------------------------------------------------------
# gguf
# --------------------------------------------------------------------------

_REGISTER_RE = re.compile(
    r"@\s*(?:[A-Za-z_][\w]*\.)*(?:ModelBase|Model|TextModel|MmprojModel)\s*\.\s*register\s*\(([^)]*)\)",
    re.S,
)
_STR_RE = re.compile(r"""(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')""")


def _strings(s: str):
    return [a or b for a, b in _STR_RE.findall(s)]


def _ast_dict_keys(src: str, var_name: str):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    for node in tree.body:
        targets = []
        value = None
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
            value = node.value
        if var_name in targets and isinstance(value, ast.Dict):
            return [k.value for k in value.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    return None


def _ast_argparse_choices(src: str, flag: str):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add_argument"):
            continue
        names = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
        if flag not in names:
            continue
        for kw in node.keywords:
            if kw.arg == "choices":
                try:
                    return [str(x) for x in ast.literal_eval(kw.value)]
                except Exception:
                    return None
    return None


def gguf_caps(args) -> dict:
    caps = {"convert_archs": [], "outtypes": []}
    script = args.get("convert_script")
    if not script:
        caps["error"] = "No convert_script path given."
        return caps
    script = os.path.abspath(os.path.expanduser(script))
    if not os.path.isfile(script):
        caps["error"] = f"convert script not found: {script}"
        return caps

    sources = [script]
    conv_dir = os.path.join(os.path.dirname(script), "conversion")
    if os.path.isdir(conv_dir):
        # llama.cpp >= ~b11900 keeps model registrations in a sibling package.
        caps["layout"] = "package"
        found = []
        for root, dirs, files in os.walk(conv_dir):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            found.extend(os.path.join(root, f) for f in files if f.endswith(".py"))
        sources += sorted(found)
    else:
        caps["layout"] = "single-file"

    archs = set()
    text_map = mmproj_map = None
    for path in sources:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
        except OSError:
            continue
        for m in _REGISTER_RE.finditer(src):
            archs.update(_strings(m.group(1)))
        if os.path.basename(path) == "__init__.py":
            text_map = _ast_dict_keys(src, "TEXT_MODEL_MAP") or text_map
            mmproj_map = _ast_dict_keys(src, "MMPROJ_MODEL_MAP") or mmproj_map
        if path == script:
            outtypes = _ast_argparse_choices(src, "--outtype")
            if outtypes is None:
                m = re.search(r"""["']--outtype["'][^)]*?choices\s*=\s*\[([^\]]*)\]""", src, re.S)
                outtypes = _strings(m.group(1)) if m else []
            caps["outtypes"] = outtypes
    if text_map:
        archs.update(text_map)
    caps["convert_archs"] = sorted(a for a in archs if a)
    if mmproj_map:
        caps["mmproj_archs"] = sorted(mmproj_map)
    caps["source_files"] = len(sources)
    gguf_py = os.path.join(os.path.dirname(script), "gguf-py", "pyproject.toml")
    if os.path.isfile(gguf_py):
        try:
            with open(gguf_py, "r", encoding="utf-8") as f:
                m = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
            if m:
                caps["gguf_py_version"] = m.group(1)
        except OSError:
            pass
    return caps


# --------------------------------------------------------------------------
# mlx
# --------------------------------------------------------------------------

MLX_METHODS = ["awq", "gptq", "dwq", "dynamic_quant"]


def _mlx_method(name: str) -> dict:
    import importlib.util

    tried = []
    for module in (f"mlx_lm.quant.{name}", f"mlx_lm.{name}"):
        try:
            spec = importlib.util.find_spec(module)
        except Exception:
            spec = None
        if spec is None:
            tried.append(module)
            continue
        rc, out, err = _run_cmd(_py_cmd("-m", module, "--help"))
        if rc == 0 and "usage" in out.lower():
            info = parse_help_text(out)
            return {"available": True, "module": module, "flags": info["flags"], "choices": info["choices"], "help": out}
        tried.append(module)
    # Unified CLI: python -m mlx_lm <name> --help
    rc, out, err = _run_cmd(_py_cmd("-m", "mlx_lm", name, "--help"))
    if rc == 0 and "usage" in out.lower():
        info = parse_help_text(out)
        return {"available": True, "module": f"mlx_lm {name}", "flags": info["flags"], "choices": info["choices"], "help": out}
    return {"available": False, "flags": [], "tried": tried, "error": _last_error_line(err) or None}


def mlx_caps() -> dict:
    caps = {}
    try:
        import mlx.core as mx

        dev = {}
        try:
            info = mx.device_info() if hasattr(mx, "device_info") else mx.metal.device_info()
            dev = {k: v for k, v in dict(info).items() if isinstance(v, (int, float, str, bool))}
        except Exception:
            pass
        try:
            dev["metal_available"] = bool(mx.metal.is_available())
        except Exception:
            pass
        caps["device"] = dev
    except Exception as e:
        caps["error"] = f"mlx import failed: {type(e).__name__}: {e}"

    # convert options
    convert = {"q_modes": [], "quant_predicates": [], "dtypes": [], "flags": []}
    try:
        import importlib

        # NB: ``from mlx_lm import convert`` returns the re-exported function.
        mconv = importlib.import_module("mlx_lm.convert")
        if hasattr(mconv, "configure_parser"):
            info = parser_info(mconv.configure_parser())
            convert["source"] = "configure_parser"
        else:
            raise AttributeError("configure_parser missing")
    except Exception as e:
        log(f"mlx_lm.convert introspection failed ({type(e).__name__}: {e}); falling back to --help", level="warn")
        rc, out, err = _run_cmd(_py_cmd("-m", "mlx_lm", "convert", "--help"))
        if rc != 0 or "usage" not in out.lower():
            rc, out, err = _run_cmd(_py_cmd("-m", "mlx_lm.convert", "--help"))
        info = parse_help_text(out)
        convert["source"] = "help"
        if rc != 0:
            convert["error"] = _last_error_line(err) or f"exit code {rc}"
    ch = info.get("choices", {})
    convert["q_modes"] = ch.get("--q-mode", [])
    convert["quant_predicates"] = ch.get("--quant-predicate", [])
    convert["dtypes"] = ch.get("--dtype", [])
    convert["flags"] = info.get("flags", [])
    if "options" in info:
        convert["options"] = info["options"]
    caps["convert"] = convert

    # learned/calibrated methods (each probed in its own subprocess, in parallel)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {name: ex.submit(_mlx_method, name) for name in MLX_METHODS}
        caps["methods"] = {name: fut.result() for name, fut in futures.items()}

    # model types = architecture modules in mlx_lm/models
    model_types = []
    try:
        import importlib.util

        spec = importlib.util.find_spec("mlx_lm.models")
        models_dir = os.path.dirname(spec.origin) if spec and spec.origin else None
        if models_dir and os.path.isdir(models_dir):
            for fname in sorted(os.listdir(models_dir)):
                if not fname.endswith(".py") or fname.startswith("_"):
                    continue
                stem = fname[:-3]
                try:
                    with open(os.path.join(models_dir, fname), "r", encoding="utf-8", errors="replace") as f:
                        src = f.read()
                except OSError:
                    continue
                has_args = re.search(r"^class ModelArgs\b", src, re.M)
                has_model = re.search(r"^class Model\(|^from\s+\S+\s+import[^\n]*\bModel\b", src, re.M)
                if has_args and has_model:
                    model_types.append(stem)
    except Exception as e:
        caps["model_types_error"] = str(e)
    caps["model_types"] = model_types
    try:
        from mlx_lm import utils as mu

        remap = getattr(mu, "MODEL_REMAPPING", None)
        if isinstance(remap, dict):
            caps["model_type_aliases"] = dict(remap)
    except Exception:
        pass
    return caps


# --------------------------------------------------------------------------
# onnx
# --------------------------------------------------------------------------

# Runs in a child process: imports the builder exactly like ``python -m`` would,
# but intercepts parse_args() to grab the parser. (``--help`` itself crashes in
# onnxruntime-genai 0.18.0 because one help string contains a bare '%'.)
_BUILDER_CAPTURE = r"""
import argparse, json, re, runpy, sys
class _Captured(Exception):
    pass
def _grab(self, *a, **k):
    raise _Captured(self)
argparse.ArgumentParser.parse_args = _grab
sys.argv = ["builder", "--help"]
try:
    runpy.run_module("onnxruntime_genai.models.builder", run_name="__main__")
    print(json.dumps({"ok": False, "error": "parser not captured"}))
except _Captured as c:
    parser = c.args[0]
    acts = []
    for a in parser._actions:
        if isinstance(a.help, str):
            a.help = re.sub(r"%(?!\()", "%%", a.help)
        acts.append({"flags": list(a.option_strings), "dest": a.dest,
                     "choices": [str(x) for x in a.choices] if a.choices is not None else None,
                     "help": a.help if isinstance(a.help, str) else None,
                     "default": a.default if isinstance(a.default, (str, int, float, bool)) or a.default is None else str(a.default)})
    try:
        text = parser.format_help()
    except Exception as e:
        text = "(help unavailable: %s)" % e
    print("@@CAPTURE " + json.dumps({"ok": True, "actions": acts, "help": text}))
"""


def _extra_option_keys(help_text: str):
    keys = []
    for m in re.finditer(r"^ {4}([a-z][a-z0-9_]*) = ", help_text or "", re.M):
        if m.group(1) not in keys:
            keys.append(m.group(1))
    if not keys:  # different indentation: take the shallowest "key = " level
        found = re.findall(r"^( +)([a-z][a-z0-9_]*) = ", help_text or "", re.M)
        if found:
            depth = min(len(sp) for sp, _ in found)
            for sp, k in found:
                if len(sp) == depth and k not in keys:
                    keys.append(k)
    return keys


def _builder_from_source(builder_py: str) -> dict:
    """Static fallback: read add_argument() calls from builder.py with ast."""
    with open(builder_py, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    tree = ast.parse(src)
    acts = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add_argument"):
            continue
        flags = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
        entry = {"flags": flags, "choices": None, "help": None}
        for kw in node.keywords:
            if kw.arg == "choices":
                try:
                    entry["choices"] = [str(x) for x in ast.literal_eval(kw.value)]
                except Exception:
                    pass
            elif kw.arg == "help":
                val = kw.value
                if isinstance(val, ast.Call) and val.args:  # textwrap.dedent("...")
                    val = val.args[0]
                if isinstance(val, ast.Constant) and isinstance(val.value, str):
                    import textwrap

                    entry["help"] = textwrap.dedent(val.value)
                elif isinstance(val, ast.JoinedStr):
                    entry["help"] = "".join(
                        v.value for v in val.values if isinstance(v, ast.Constant) and isinstance(v.value, str)
                    )
        acts.append(entry)
    lines = ["usage: python -m onnxruntime_genai.models.builder [options]", "", "options:"]
    for a in acts:
        lines.append("  " + ", ".join(a["flags"]) + (" {" + ",".join(a["choices"]) + "}" if a["choices"] else ""))
        if a["help"]:
            lines.extend("      " + ln for ln in a["help"].splitlines())
    return {"actions": acts, "help": "\n".join(lines)}


def onnx_caps() -> dict:
    import importlib.util

    caps = {}
    builder = {"precisions": [], "execution_providers": [], "extra_option_keys": [], "help": "", "flags": []}
    spec = None
    try:
        spec = importlib.util.find_spec("onnxruntime_genai")
    except Exception:
        spec = None
    pkg_dir = os.path.dirname(spec.origin) if spec and spec.origin else None
    models_dir = os.path.join(pkg_dir, "models") if pkg_dir else None
    builder_py = os.path.join(models_dir, "builder.py") if models_dir else None

    data = None
    rc, out, err = _run_cmd(_py_cmd("-c", _BUILDER_CAPTURE))
    for line in out.splitlines():
        if line.startswith("@@CAPTURE "):
            try:
                data = json.loads(line[len("@@CAPTURE "):])
            except json.JSONDecodeError:
                data = None
    if data and data.get("ok"):
        builder["importable"] = True
        builder["source"] = "parser"
    else:
        builder["importable"] = False
        builder["error"] = _last_error_line(err) or (data or {}).get("error") or f"exit code {rc}"
        if builder_py and os.path.isfile(builder_py):
            try:
                data = _builder_from_source(builder_py)
                builder["source"] = "static"
            except Exception as e:
                builder["static_error"] = f"{type(e).__name__}: {e}"
                data = None
    if data:
        acts = data.get("actions", [])
        for a in acts:
            fl = a.get("flags") or []
            if "--precision" in fl:
                builder["precisions"] = a.get("choices") or []
            if "--execution_provider" in fl:
                builder["execution_providers"] = a.get("choices") or []
            if "--extra_options" in fl:
                builder["extra_option_keys"] = _extra_option_keys(a.get("help") or "")
            builder["flags"].extend(f for f in fl if f.startswith("--") and f != "--help")
        builder["help"] = data.get("help") or ""
    caps["builder"] = builder

    # Architectures the builder knows (string literals in its sources).
    archs = set()
    files = []
    if models_dir and os.path.isdir(models_dir):
        files.append(os.path.join(models_dir, "builder.py"))
        bdir = os.path.join(models_dir, "builders")
        if os.path.isdir(bdir):
            for root, _d, fs in os.walk(bdir):
                files.extend(os.path.join(root, f) for f in fs if f.endswith(".py"))
    rx = re.compile(r"""["']([A-Za-z0-9_]+For(?:CausalLM|ConditionalGeneration))["']""")
    for fp in files:
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                archs.update(rx.findall(f.read()))
        except OSError:
            pass
    caps["architectures"] = sorted(archs)

    try:
        import onnxruntime as ort

        caps["ort_providers"] = list(ort.get_available_providers())
    except Exception as e:
        caps["ort_error"] = f"{type(e).__name__}: {e}"
    try:
        from onnxruntime.quantization import matmul_nbits_quantizer as mnq

        algos = {
            "default": "DefaultWeightOnlyQuantConfig",
            "rtn": "RTNWeightOnlyQuantConfig",
            "hqq": "HQQWeightOnlyQuantConfig",
            "gptq": "GPTQWeightOnlyQuantConfig",
            "k_quant": "KQuantWeightOnlyQuantConfig",
        }
        caps["ort_weight_only_algos"] = [k for k, cls in algos.items() if hasattr(mnq, cls)]
    except Exception as e:
        caps["ort_quant_error"] = f"{type(e).__name__}: {e}"
    try:
        caps["optimum_export"] = importlib.util.find_spec("optimum.exporters.onnx") is not None
    except Exception:
        caps["optimum_export"] = False
    return caps


def main():
    args = load_args()
    env = args.get("env") or "core"
    set_env(env)
    if env not in PACKAGES:
        emit("error", message=f"Unknown env '{env}'", hint="This is an iQuantize bug; please report it.")
        return 1
    stage("probe", f"Probing {env} environment")
    packages = package_versions(PACKAGES[env])
    caps = {}
    if env == "gguf":
        caps = gguf_caps(args)
    elif env == "mlx":
        caps = mlx_caps()
    elif env == "onnx":
        caps = onnx_caps()
    emit(
        "result",
        python=platform.python_version(),
        packages=packages,
        caps=caps,
        env=env,
        executable=sys.executable,
        platform={"system": platform.system(), "machine": platform.machine(), "release": platform.release()},
    )
    return 0


if __name__ == "__main__":
    run(main)
