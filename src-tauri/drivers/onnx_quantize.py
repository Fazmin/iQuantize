"""ONNX export and post-training quantization, "Engine B" (onnx env).

args: {"mode": "export"|"int8_dynamic"|"int4_weight",
       "model": "<hf dir or onnx dir>", "out": "<dir>",
       "task": "text-generation-with-past",
       "per_channel": true, "reduce_range": false, "quant_format": "QDQ"|"QOperator",
       "weight_type": "qint8"|"quint8",                       # int8_dynamic
       "int4": {"algo": "rtn"|"hqq"|"gptq"|"k_quant"|"default", "block_size": 32,
                "is_symmetric": true, "accuracy_level": 4, "bits": 4,
                "nodes_to_exclude": [], "op_types": ["MatMul"],
                "calib_samples": 8, "calib_seq_len": 512},
       "calib_path": null|"<utf-8 text>",                     # required for gptq
       "exporter": "auto"|"optimum"|"builder"}

export: optimum.exporters.onnx.main_export (package optimum-onnx) when it is
  importable; otherwise (optimum-onnx 0.1.x pins transformers<4.58, so it is
  usually absent next to transformers 5) the onnxruntime-genai model builder
  at fp32/cpu, which also writes genai_config.json.
int8_dynamic: onnxruntime.quantization.quantize_dynamic per .onnx file
  (always QOperator: dynamic quantization has no QDQ form), external data on.
int4_weight: onnxruntime.quantization.matmul_nbits_quantizer.MatMulNBitsQuantizer
  "rtn"/"default" -> DefaultWeightOnlyQuantConfig (ORT's native blockwise round-to-nearest)
  "hqq"           -> HQQWeightOnlyQuantConfig (asymmetric, QOperator only)
  "gptq"          -> GPTQWeightOnlyQuantConfig + a calibration reader over calib_path
  "k_quant"       -> KQuantWeightOnlyQuantConfig
If "model" is a Hugging Face folder without .onnx files, the quantize modes
export it first (into a temporary folder inside "out").

result: {"files":[{"path","bytes"}],"size_bytes":n, ...}
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import (  # noqa: E402
    Progress,
    emit,
    ensure_empty_dir,
    fail,
    install_tqdm_hook,
    list_files,
    load_args,
    log,
    read_json,
    require,
    run,
    set_env,
    stage,
    warn,
)

import importlib.util  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402

WEIGHT_EXTS = (
    ".onnx",
    ".onnx.data",
    ".onnx_data",
    ".data",
    ".safetensors",
    ".bin",
    ".pt",
    ".pth",
    ".gguf",
    ".msgpack",
    ".h5",
    ".part",
)

# onnx.TensorProto data types -> (short name, bytes per element)
_ONNX_DT = {
    1: ("f32", 4),
    2: ("u8", 1),
    3: ("i8", 1),
    4: ("u16", 2),
    5: ("i16", 2),
    6: ("i32", 4),
    7: ("i64", 8),
    9: ("bool", 1),
    10: ("f16", 2),
    11: ("f64", 8),
    12: ("u32", 4),
    13: ("u64", 8),
    16: ("bf16", 2),
    17: ("f8e4m3fn", 1),
    18: ("f8e4m3fnuz", 1),
    19: ("f8e5m2", 1),
    20: ("f8e5m2fnuz", 1),
    21: ("u4", 0.5),
    22: ("i4", 0.5),
}


def onnx_files_in(folder):
    out = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            if f.endswith(".onnx"):
                out.append(os.path.relpath(os.path.join(root, f), folder))
    return out


AUX_PATTERNS = (
    "config.json",
    "generation_config.json",
    "genai_config.json",
    "tokenizer*",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.*",
    "merges.txt",
    "*.jinja",
    "chat_template*",
    "*.tiktoken",
    "tiktoken.model",
    "spiece.model",
    "sentencepiece*.model",
    "preprocessor_config.json",
    "processor_config.json",
)


def copy_aux_files(src, dst):
    """Copy tokenizer/config/template files (not weights) from src to dst (top level)."""
    import fnmatch

    copied = []
    for name in sorted(os.listdir(src)):
        sp = os.path.join(src, name)
        if not os.path.isfile(sp) or name.startswith("."):
            continue
        if name.lower().endswith(WEIGHT_EXTS) or not any(fnmatch.fnmatch(name, p) for p in AUX_PATTERNS):
            continue
        dp = os.path.join(dst, name)
        if os.path.exists(dp):
            continue
        shutil.copy2(sp, dp)
        copied.append(name)
    return copied


def initializer_layout(path, prefix=""):
    """[(name, shape, dtype, bytes)] for every initializer, without loading weight data."""
    import onnx

    model = onnx.load(path, load_external_data=False)
    out = {}
    for init in model.graph.initializer:
        dt, size = _ONNX_DT.get(init.data_type, (str(init.data_type), 1))
        numel = 1
        for d in init.dims:
            numel *= int(d)
        out[init.name] = {
            "name": prefix + init.name,
            "shape": [int(d) for d in init.dims],
            "dtype": dt,
            "bytes": int(numel * size),
        }
    count = {}
    for node in model.graph.node:
        count[node.op_type] = count.get(node.op_type, 0) + 1
    del model
    return out, count


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------


def _optimum_available():
    try:
        return importlib.util.find_spec("optimum.exporters.onnx") is not None
    except Exception:
        return False


def export_model(hf_dir, out_dir, task, exporter="auto"):
    """Export a Hugging Face folder to ONNX in out_dir. Returns the exporter used."""
    if not os.path.isfile(os.path.join(hf_dir, "config.json")):
        fail(f"No config.json in {hf_dir}", "Select a downloaded Hugging Face model folder.")
    use_optimum = exporter == "optimum" or (exporter == "auto" and _optimum_available())
    if exporter == "optimum" and not _optimum_available():
        fail(
            "optimum-onnx is not installed in the onnx environment.",
            "Install optimum-onnx (needs transformers < 4.58) or use exporter 'builder'.",
        )
    if use_optimum:
        stage("export", "Exporting with optimum")
        install_tqdm_hook(label="Exporting")
        from optimum.exporters.onnx import main_export

        main_export(
            model_name_or_path=hf_dir,
            output=out_dir,
            task=task or "text-generation-with-past",
            device="cpu",
            local_files_only=True,
        )
        return "optimum"

    stage("export", "Exporting with the ONNX Runtime GenAI builder (fp32, cpu)")
    if exporter == "auto":
        log("optimum-onnx is not available; exporting with onnxruntime_genai.models.builder at fp32")
    if task and task not in ("text-generation-with-past", "text-generation", "auto"):
        warn(f"The GenAI builder only exports decoder LLMs; task '{task}' is ignored.")
    cfg = read_json(os.path.join(hf_dir, "config.json"), {}) or {}
    n_layers = int(cfg.get("num_hidden_layers") or (cfg.get("text_config") or {}).get("num_hidden_layers") or 0)
    cache_dir = os.path.join(out_dir, ".iq_builder_cache")
    os.makedirs(cache_dir, exist_ok=True)
    cmd = [
        sys.executable,
        "-u",
        "-I",
        "-X",
        "utf8",
        "-m",
        "onnxruntime_genai.models.builder",
        "-i",
        hf_dir,
        "-o",
        out_dir,
        "-p",
        "fp32",
        "-e",
        "cpu",
        "-c",
        cache_dir,
    ]
    env = dict(os.environ)
    env["TQDM_DISABLE"] = "1"
    prog = Progress(n_layers or 0, unit="steps", label="Reading layers")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env
    )
    layer_rx = re.compile(r"Reading layer (\d+)")
    tail = []
    buf = b""
    while True:
        chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for raw in parts:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if not line or line.startswith("objc["):
                continue
            m = layer_rx.search(line)
            if m and n_layers:
                prog.set(int(m.group(1)) + 1, label=f"Reading layer {int(m.group(1)) + 1}/{n_layers}")
            elif line.startswith("Saving ") and "%|" in line:
                continue  # per-tensor save bars
            else:
                print(line, file=sys.stderr)
            tail.append(line)
            tail = tail[-30:]
    rc = proc.wait()
    shutil.rmtree(cache_dir, ignore_errors=True)
    if rc != 0:
        err = next((ln for ln in reversed(tail) if "Error" in ln or "error" in ln), tail[-1] if tail else "")
        if "not supported" in err.lower() or "NotImplementedError" in err:
            fail(f"The ONNX builder does not support this architecture: {err}", "Pick a model whose architecture is listed in Environment.")
        fail(f"ONNX builder failed (exit {rc}): {err}", "See the log for details.")
    return "onnxruntime_genai.builder"


# --------------------------------------------------------------------------
# GPTQ calibration data
# --------------------------------------------------------------------------


def _load_tokenizer(model_dir):
    tj = os.path.join(model_dir, "tokenizer.json")
    if os.path.isfile(tj):
        try:
            from tokenizers import Tokenizer

            tok = Tokenizer.from_file(tj)
            return lambda text: tok.encode(text).ids
        except Exception:
            pass
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_dir)
    return lambda text: tok(text)["input_ids"]


def make_calibration_reader(onnx_path, model_dir, text_path, n_samples, seq_len):
    import numpy as np
    import onnx
    from onnxruntime.quantization import CalibrationDataReader

    with open(text_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    encode = _load_tokenizer(model_dir)
    ids = np.asarray(encode(text[: max(n_samples * seq_len * 12, 200_000)]), dtype=np.int64)
    if ids.size < seq_len:
        fail("The calibration text is too short.", "Fetch a larger calibration text.")
    n = min(n_samples, ids.size // seq_len)
    if n < n_samples:
        warn(f"Calibration text only yields {n} samples of {seq_len} tokens.")

    gc = read_json(os.path.join(model_dir, "genai_config.json"), {}) or {}
    dec = gc.get("model", {}).get("decoder", {})
    hf = read_json(os.path.join(model_dir, "config.json"), {}) or {}
    kv_heads = dec.get("num_key_value_heads") or hf.get("num_key_value_heads") or hf.get("num_attention_heads")
    head_dim = dec.get("head_size") or hf.get("head_dim")
    if not head_dim and hf.get("hidden_size") and hf.get("num_attention_heads"):
        head_dim = hf["hidden_size"] // hf["num_attention_heads"]

    model = onnx.load(onnx_path, load_external_data=False)
    init_names = {i.name for i in model.graph.initializer}
    np_types = {1: np.float32, 10: np.float16, 11: np.float64, 7: np.int64, 6: np.int32, 9: np.bool_}
    specs = []
    for inp in model.graph.input:
        if inp.name in init_names:
            continue
        tt = inp.type.tensor_type
        dims = [d.dim_value if d.HasField("dim_value") else None for d in tt.shape.dim]
        specs.append((inp.name, np_types.get(tt.elem_type, np.float32), dims))
    del model

    def feeds_for(window):
        L = len(window)
        feed = {}
        for name, dt, dims in specs:
            lname = name.lower()
            if lname == "input_ids":
                feed[name] = window[None].astype(dt)
            elif lname == "attention_mask":
                feed[name] = np.ones((1, L), dtype=dt)
            elif lname == "position_ids":
                feed[name] = np.arange(L, dtype=dt)[None]
            elif "past" in lname and ("key" in lname or "value" in lname):
                h = dims[1] if len(dims) > 1 and dims[1] else kv_heads
                d = dims[3] if len(dims) > 3 and dims[3] else head_dim
                if not h or not d:
                    fail(f"Cannot infer the KV-cache shape for input {name}.")
                feed[name] = np.zeros((1, int(h), 0, int(d)), dtype=dt)
            elif lname == "use_cache_branch":
                feed[name] = np.array([False])
            else:
                fail(f"Don't know how to feed model input '{name}' for GPTQ calibration.", "Use the rtn or hqq algorithm.")
        return feed

    samples = [feeds_for(ids[i * seq_len : (i + 1) * seq_len]) for i in range(n)]

    class Reader(CalibrationDataReader):
        def __init__(self, data):
            self.data = data
            self.pos = 0

        def get_next(self):
            if self.pos >= len(self.data):
                return None
            self.pos += 1
            return self.data[self.pos - 1]

        def rewind(self):
            self.pos = 0

    return Reader(samples), n


# --------------------------------------------------------------------------
# quantization
# --------------------------------------------------------------------------


def quantize_int8_dynamic(src, dst, args):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    if (args.get("quant_format") or "QOperator").upper() == "QDQ":
        warn("Dynamic int8 quantization has no QDQ form; using QOperator (DynamicQuantizeLinear + MatMulInteger).")
    wt = (args.get("weight_type") or "qint8").lower()
    weight_type = QuantType.QUInt8 if wt == "quint8" else QuantType.QInt8
    quantize_dynamic(
        model_input=src,
        model_output=dst,
        per_channel=bool(args.get("per_channel", True)),
        reduce_range=bool(args.get("reduce_range", False)),
        weight_type=weight_type,
        use_external_data_format=True,
        extra_options={"MatMulConstBOnly": True},
    )


def quantize_int4(src, dst, args, layout, model_dir, file_idx, n_files, counters):
    from onnxruntime.quantization import matmul_nbits_quantizer as mnq
    from onnxruntime.quantization.quant_utils import QuantFormat

    q = dict(args.get("int4") or {})
    algo = (q.get("algo") or "rtn").lower()
    block = int(q.get("block_size") or 32)
    sym = bool(q.get("is_symmetric", True))
    acc = q.get("accuracy_level", 4)
    acc = int(acc) if acc is not None else None
    bits = int(q.get("bits") or 4)
    op_types = tuple(q.get("op_types") or ("MatMul",))
    exclude = list(q.get("nodes_to_exclude") or [])
    fmt_name = (args.get("quant_format") or "QOperator").upper()
    qfmt = QuantFormat.QDQ if fmt_name == "QDQ" else QuantFormat.QOperator
    if bits not in (2, 4, 8):
        fail(f"Unsupported bits {bits} for weight-only quantization.", "Use 4 (or 8/2 with the rtn algorithm).")

    if algo in ("rtn", "default"):
        cfg = mnq.DefaultWeightOnlyQuantConfig(
            block_size=block,
            is_symmetric=sym,
            accuracy_level=acc,
            quant_format=qfmt,
            op_types_to_quantize=op_types,
            bits=bits,
        )
    else:
        if qfmt == QuantFormat.QDQ:
            warn(f"{algo} only supports the QOperator format; using QOperator.")
            qfmt = QuantFormat.QOperator
        if bits != 4 and algo != "hqq":
            warn(f"{algo} quantizes to 4 bits; ignoring bits={bits}.")
            bits = 4
        if algo == "hqq":
            if sym:
                log("HQQ is asymmetric (uint4 with zero points); is_symmetric is ignored.")
            sym = False
            cfg = mnq.HQQWeightOnlyQuantConfig(block_size=block, bits=bits, op_types_to_quantize=op_types)
        elif algo == "k_quant":
            cls = getattr(mnq, "KQuantWeightOnlyQuantConfig", None)
            if cls is None:
                fail("k_quant is not available in this onnxruntime.", "Use rtn or hqq.")
            cfg = cls(op_types_to_quantize=op_types)
        elif algo == "rtn_inc":
            cfg = mnq.RTNWeightOnlyQuantConfig(op_types_to_quantize=op_types)
        elif algo == "gptq":
            calib = args.get("calib_path")
            if not calib or not os.path.isfile(calib):
                fail("GPTQ needs calibration text (calib_path).", "Fetch a calibration text first, then retry.")
            reader, n = make_calibration_reader(
                src,
                model_dir,
                calib,
                int(q.get("calib_samples") or 8),
                int(q.get("calib_seq_len") or 512),
            )
            log(f"GPTQ calibration: {n} samples (each MatMul input runs one forward pass per sample)")
            cfg = mnq.GPTQWeightOnlyQuantConfig(
                calibration_data_reader=reader,
                percdamp=float(q.get("percdamp") or 0.01),
                block_size=int(q.get("gptq_block_size") or 128),
                actorder=bool(q.get("actorder", False)),
                mse=False,
                perchannel=True,
                op_types_to_quantize=op_types,
            )
        else:
            fail(f"Unknown int4 algorithm '{algo}'.", "Use rtn, hqq, gptq or k_quant.")

    quant = mnq.MatMulNBitsQuantizer(
        model=src,
        bits=bits,
        block_size=block,
        is_symmetric=sym,
        accuracy_level=acc,
        nodes_to_exclude=exclude,
        quant_format=qfmt,
        op_types_to_quantize=op_types,
        algo_config=cfg,
    )

    node_q = getattr(quant, "node_quantizer", None)
    total_nodes = sum(1 for n in quant.model.model.graph.node if n.op_type in op_types)
    prog = Progress(total_nodes, unit="tensors", label="Quantizing weights")
    if node_q is not None and hasattr(node_q, "quantize"):
        orig = node_q.quantize
        state = {"seen": 0}
        to_name = ("int" if sym else "uint") + str(bits)

        def wrapped(node, graph_stack, *a, **kw):
            out = orig(node, graph_stack, *a, **kw)
            state["seen"] += 1
            prog.set(state["seen"], label=f"Quantizing weights ({file_idx}/{n_files})")
            try:
                changed = any(
                    o.op_type in ("MatMulNBits", "GatherBlockQuantized", "DequantizeLinear") for o in (out or [])
                )
                if changed:
                    wname = node.input[0] if node.op_type == "Gather" else node.input[1]
                    info = layout.get(wname)
                    if info:
                        numel = 1
                        for d in info["shape"]:
                            numel *= d
                        scale_b = 2 if info["dtype"] in ("f16", "bf16") else 4
                        per_group = scale_b + (0 if sym else 0.5)
                        counters["idx"] += 1
                        emit(
                            "tensor",
                            idx=counters["idx"],
                            total=counters["total"],
                            name=info["name"],
                            node=node.name,
                            op=node.op_type,
                            shape=info["shape"],
                            **{"from": info["dtype"]},
                            to=to_name,
                            bits=bits,
                            group_size=block,
                            bytes_in=info["bytes"],
                            bytes_out=int(numel * bits / 8 + (numel / block) * per_group),
                        )
            except Exception:
                pass
            return out

        node_q.quantize = wrapped
    else:
        # INC-based algorithms report through weight_only.simple_progress_bar(total, done).
        try:
            from onnxruntime.quantization.neural_compressor import weight_only as wo

            def _bar(total, done, *_a, **_k):
                prog.set(int(done), total=int(total), label=f"{algo.upper()}: quantizing weights ({file_idx}/{n_files})")

            wo.simple_progress_bar = _bar
        except Exception:
            log(f"{algo}: progress is reported by onnxruntime in the log")

    # The INC-based algorithms (gptq, k_quant, rtn_inc) build an InferenceSession from
    # serialized bytes; onnxruntime >= 1.2x only resolves external data relative to the
    # current directory then, so run from the model's folder. Large (>2GB) models also get
    # a temporary "<model>_augment.onnx" written next to the source, removed afterwards.
    src_abs = os.path.abspath(src)
    before = set(os.listdir(os.path.dirname(src_abs)))
    old_cwd = os.getcwd()
    os.chdir(os.path.dirname(src_abs))
    try:
        quant.process()
    finally:
        os.chdir(old_cwd)
        for name in set(os.listdir(os.path.dirname(src_abs))) - before:
            if "_augment" in name:
                try:
                    os.remove(os.path.join(os.path.dirname(src_abs), name))
                except OSError:
                    pass
    prog.finish()
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    # The INC paths load the source lazily, so untouched initializers can still point at
    # offsets inside the *source* external-data file. Pull them into memory first, or the
    # saved model would reference data that is not in its own .data file.
    import onnx
    from onnx.external_data_helper import load_external_data_for_model

    proto = quant.model.model
    if any(t.data_location == onnx.TensorProto.EXTERNAL for t in proto.graph.initializer):
        load_external_data_for_model(proto, os.path.dirname(src_abs))
    quant.model.save_model_to_file(dst, True)


def main():
    args = load_args()
    set_env("onnx")
    mode = (args.get("mode") or "").lower()
    if mode not in ("export", "int8_dynamic", "int4_weight"):
        fail(f"Unknown mode '{mode}'.", "Use export, int8_dynamic or int4_weight.")
    src_dir = os.path.abspath(os.path.expanduser(require(args, "model")))
    out_dir = ensure_empty_dir(require(args, "out"))
    task = args.get("task") or "text-generation-with-past"
    exporter_pref = (args.get("exporter") or "auto").lower()
    if not os.path.isdir(src_dir):
        fail(f"Model folder not found: {src_dir}")

    extra = {"mode": mode}
    if mode == "export":
        extra["exporter"] = export_model(src_dir, out_dir, task, exporter_pref)
        copy_aux_files(src_dir, out_dir)
        files = list_files(out_dir)
        emit("result", files=files, size_bytes=sum(f["bytes"] for f in files), **extra)
        return 0

    # quantize modes
    onnx_dir = src_dir
    tmp_export = None
    if not onnx_files_in(src_dir):
        if os.path.isfile(os.path.join(src_dir, "config.json")):
            tmp_export = os.path.join(out_dir, ".iq_export_tmp")
            os.makedirs(tmp_export, exist_ok=True)
            log("No .onnx files in the input folder; exporting it first")
            extra["exporter"] = export_model(src_dir, tmp_export, task, exporter_pref)
            copy_aux_files(src_dir, tmp_export)
            onnx_dir = tmp_export
        else:
            fail(f"No .onnx files in {src_dir}", "Select an exported ONNX model folder or a Hugging Face folder.")

    rel_files = onnx_files_in(onnx_dir)
    n_files = len(rel_files)

    # layout of all initializers before quantizing
    stage("layout", "Reading model layout")
    layouts = {}
    all_tensors = []
    op_counts = {}
    for rel in rel_files:
        prefix = "" if n_files == 1 else rel[:-5] + ":"
        lay, cnt = initializer_layout(os.path.join(onnx_dir, rel), prefix)
        layouts[rel] = lay
        all_tensors.extend(lay.values())
        for k, v in cnt.items():
            op_counts[k] = op_counts.get(k, 0) + v
    emit("layout", tensors=all_tensors)
    if mode == "int4_weight" and op_counts.get("MatMulNBits") and not op_counts.get("MatMul"):
        warn("This model is already weight-only quantized (MatMulNBits); nothing left to quantize.")

    counters = {"idx": 0, "total": 0}
    if mode == "int4_weight":
        op_types = tuple((args.get("int4") or {}).get("op_types") or ("MatMul",))
        counters["total"] = sum(op_counts.get(op, 0) for op in op_types)

    file_prog = Progress(n_files, unit="files", label="Quantizing")
    for i, rel in enumerate(rel_files, 1):
        src = os.path.join(onnx_dir, rel)
        dst = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        stage("quantize", f"Quantizing {rel} ({i}/{n_files})", file=rel)
        if mode == "int8_dynamic":
            quantize_int8_dynamic(src, dst, args)
        else:
            quantize_int4(src, dst, args, layouts[rel], onnx_dir, i, n_files, counters)
        file_prog.set(i, label=f"Quantized {rel}", force=True)

    stage("finish", "Copying tokenizer and config files")
    copied = copy_aux_files(onnx_dir, out_dir)
    if onnx_dir != src_dir:
        copy_aux_files(src_dir, out_dir)
    if tmp_export:
        shutil.rmtree(tmp_export, ignore_errors=True)
    if counters["idx"]:
        extra["quantized_tensors"] = counters["idx"]
    files = list_files(out_dir)
    emit("result", files=files, size_bytes=sum(f["bytes"] for f in files), copied=copied, **extra)
    return 0


if __name__ == "__main__":
    run(main, env="onnx")
