"""Quantize a Hugging Face model to MLX with per-layer rules (mlx env).

args: {"hf_path": "<local dir>", "mlx_path": "<out dir>", "bits": 4, "group_size": 64,
       "mode": "affine", "dtype": null|"bfloat16"|..., "recipe": null|"mixed_3_6"|...,
       "rules": [{"pattern": "<regex on module path>", "bits": 6, "group_size": 64, "mode"?: "affine"}
                 | {"pattern": "...", "skip": true}],
       "trust_remote_code": false}

Mirrors ``mlx_lm.convert.convert`` (load -> dtype cast -> quantize_model -> save)
but uses its own quant predicate and reports layout/tensor/progress events.
Precedence per module: user rules (first regex match wins) > the model's own
``quant_predicate`` (e.g. MoE routers kept at 8 bit) > mixed recipe > uniform.

result: {"files":[{"path","bytes"}],"size_bytes":n,"bpw":x,"quantization":{...}}
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import (  # noqa: E402
    Progress,
    emit,
    ensure_empty_dir,
    fail,
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

import importlib  # noqa: E402
import inspect  # noqa: E402
import re  # noqa: E402
import time  # noqa: E402

# Fixed (group_size, bits) defaults per mode, as in mlx_lm.utils.quantize_model.
MODE_DEFAULTS = {"affine": (64, 4), "mxfp4": (32, 4), "nvfp4": (16, 4), "mxfp8": (32, 8)}
AFFINE_BITS = (2, 3, 4, 5, 6, 8)
CONVERSION_DTYPES = ("float16", "bfloat16", "float32")

_DTYPE_SHORT = {
    "bfloat16": "bf16",
    "float16": "f16",
    "float32": "f32",
    "float64": "f64",
    "uint8": "u8",
    "uint16": "u16",
    "uint32": "u32",
    "uint64": "u64",
    "int8": "i8",
    "int16": "i16",
    "int32": "i32",
    "int64": "i64",
    "bool": "bool",
}


def short_dtype(dt) -> str:
    name = str(dt).replace("mlx.core.", "")
    return _DTYPE_SHORT.get(name, name)


def _call_predicate(fn, path, module, config):
    """mlx-lm predicates are (path, module) in 0.32 and (path, module, config) in older releases."""
    try:
        params = inspect.signature(fn).parameters
        positional = [
            p
            for p in params.values()
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.default is p.empty
        ]
        varargs = any(p.kind == p.VAR_POSITIONAL for p in params.values())
        if len(positional) >= 3 or varargs:
            return fn(path, module, config)
        return fn(path, module)
    except (TypeError, ValueError):
        try:
            return fn(path, module)
        except TypeError:
            return fn(path, module, config)


def _local_mixed_predicate(recipe, model, group_size):
    """Copy of mlx_lm.convert.mixed_quant_predicate_builder (mlx-lm 0.32.2)."""
    mode = "affine"
    high_bits = 6
    table = {"mixed_2_6": (2, 6), "mixed_3_4": (3, 4), "mixed_3_6": (3, 6), "mixed_4_6": (4, 6)}
    if recipe not in table:
        fail(f"Unknown mixed recipe '{recipe}'.", f"Use one of: {', '.join(table)}.")
    low_bits, high_bits = table[recipe]
    down_keys = [k for k, _ in model.named_modules() if "down_proj" in k]
    if not down_keys:
        fail("This model has no down_proj layers, so mixed recipes do not apply.", "Use uniform bits or custom rules.")
    layer_location = 0
    for layer_location, k in enumerate(down_keys[0].split(".")):  # noqa: B007
        if k.isdigit():
            break
    num_layers = len(model.layers)

    def predicate(path, module):
        parts = path.split(".")
        index = int(parts[layer_location]) if len(parts) > layer_location and parts[layer_location].isdigit() else 0
        use_more_bits = (
            index < num_layers // 8 or index >= 7 * num_layers // 8 or (index - num_layers // 8) % 3 == 2
        )
        if ("v_proj" in path or "v_a_proj" in path or "v_b_proj" in path) and use_more_bits:
            return {"group_size": group_size, "bits": high_bits, "mode": mode}
        if "down_proj" in path and use_more_bits:
            return {"group_size": group_size, "bits": high_bits, "mode": mode}
        if "lm_head" in path:
            return {"group_size": group_size, "bits": high_bits, "mode": mode}
        return {"group_size": group_size, "bits": low_bits, "mode": mode}

    return predicate


def _compile_rules(rules):
    out = []
    for i, r in enumerate(rules or []):
        if not isinstance(r, dict) or not r.get("pattern"):
            fail(f"Rule #{i + 1} has no pattern.", "Every rule needs a regex 'pattern'.")
        try:
            rx = re.compile(r["pattern"])
        except re.error as e:
            fail(f"Rule #{i + 1} has an invalid regex '{r['pattern']}': {e}", "Fix the pattern (Python regex syntax).")
        out.append((rx, r))
    return out


def main():
    args = load_args()
    set_env("mlx")
    hf_path = os.path.abspath(os.path.expanduser(require(args, "hf_path")))
    mlx_path = require(args, "mlx_path")
    base_mode = (args.get("mode") or "affine").lower()
    dtype_arg = args.get("dtype") or None
    recipe = args.get("recipe") or None
    trust_remote_code = bool(args.get("trust_remote_code", False))
    rules = _compile_rules(args.get("rules"))

    if base_mode not in MODE_DEFAULTS:
        fail(f"Unknown quantization mode '{base_mode}'.", f"Use one of: {', '.join(MODE_DEFAULTS)}.")
    def_gs, def_bits = MODE_DEFAULTS[base_mode]
    base_bits = int(args.get("bits") or def_bits)
    base_gs = int(args.get("group_size") or def_gs)
    if base_mode != "affine" and (base_gs, base_bits) != (def_gs, def_bits):
        log(
            f"{base_mode} always uses {def_bits} bits with group size {def_gs}; "
            f"ignoring bits={base_bits}, group_size={base_gs}."
        )
        base_gs, base_bits = def_gs, def_bits
    if base_mode == "affine" and base_bits not in AFFINE_BITS:
        fail(f"Unsupported bit width {base_bits} for affine mode.", f"Use one of {AFFINE_BITS}.")
    if recipe and base_mode != "affine":
        fail("Mixed recipes only support affine quantization.", "Set mode to affine or remove the recipe.")
    if dtype_arg and dtype_arg not in CONVERSION_DTYPES:
        fail(f"Unsupported dtype '{dtype_arg}'.", f"Use one of: {', '.join(CONVERSION_DTYPES)}.")
    if not os.path.isfile(os.path.join(hf_path, "config.json")):
        fail(f"No config.json in {hf_path}", "Select a downloaded Hugging Face model folder.")
    mlx_path = ensure_empty_dir(mlx_path)

    # ------------------------------------------------------------------ load
    stage("load", "Loading model")
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten, tree_map_with_path
    from mlx_lm import utils as mu

    try:
        mconv = importlib.import_module("mlx_lm.convert")
    except Exception:
        mconv = None

    t0 = time.perf_counter()
    load_kwargs = dict(
        tokenizer_config={"trust_remote_code": trust_remote_code},
        lazy=True,
        return_config=True,
        trust_remote_code=trust_remote_code,
    )
    try:
        model, tokenizer, config = mu.load(hf_path, **load_kwargs)
    except TypeError as e:
        if "trust_remote_code" not in str(e):
            raise
        load_kwargs.pop("trust_remote_code")
        model, tokenizer, config = mu.load(hf_path, **load_kwargs)
    log(f"Model graph loaded lazily in {time.perf_counter() - t0:.1f}s (type: {config.get('model_type')})")
    if config.get("quantization") or config.get("quantization_config"):
        warn("The source model is already quantized; only unquantized layers can be quantized again.")

    # ----------------------------------------------------------- dtype cast
    # Same logic as mlx_lm.convert.convert (transformers 5 writes "dtype" instead of "torch_dtype").
    text_config = config.get("text_config") or {}
    dtype = (
        dtype_arg
        or config.get("torch_dtype")
        or config.get("dtype")
        or text_config.get("dtype")
        or text_config.get("torch_dtype")
    )
    if dtype in CONVERSION_DTYPES:
        log(f"Using dtype {dtype} for unquantized parameters")
        mx_dtype = getattr(mx, dtype)
        cast_predicate = getattr(model, "cast_predicate", lambda _: True)

        def set_dtype(k, v):
            if cast_predicate(k) and mx.issubdtype(v.dtype, mx.floating):
                return v.astype(mx_dtype)
            return v

        model.update(tree_map_with_path(set_dtype, model.parameters()))

    # --------------------------------------------------------------- layout
    params = tree_flatten(model.parameters())
    layout = []
    for name, arr in params:
        module_name = name[: -len(".weight")] if name.endswith(".weight") else name
        layout.append(
            {
                "name": module_name,
                "param": name,
                "shape": [int(s) for s in arr.shape],
                "dtype": short_dtype(arr.dtype),
                "bytes": int(arr.nbytes),
            }
        )
    emit("layout", tensors=layout)
    del params

    # ------------------------------------------------------------ decisions
    stage("plan", "Planning quantization")
    model_pred = getattr(model, "quant_predicate", None)
    if model_pred is not None and not callable(model_pred):
        model_pred = None
    recipe_pred = None
    if recipe:
        builder = getattr(mconv, "mixed_quant_predicate_builder", None) if mconv else None
        if builder is not None:
            try:
                recipe_pred = builder(recipe, model, base_gs)
            except TypeError:
                recipe_pred = builder(recipe, model)
            log(f"Using mlx_lm's built-in '{recipe}' predicate")
        else:
            recipe_pred = _local_mixed_predicate(recipe, model, base_gs)
            warn(f"mlx_lm does not expose mixed_quant_predicate_builder; using iQuantize's copy of the '{recipe}' logic")

    base_params = {"group_size": base_gs, "bits": base_bits, "mode": base_mode}

    def normalize(p):
        if p is True:
            return dict(base_params)
        if not p:
            return None
        if isinstance(p, dict):
            q = dict(base_params)
            q.update({k: v for k, v in p.items() if v is not None})
            if "mode" not in p:
                q["mode"] = "affine" if ("bits" in p or "group_size" in p) else base_mode
            return q
        return dict(base_params)

    leaves = tree_flatten(model.leaf_modules(), is_leaf=nn.Module.is_module)
    decisions = {}
    sources = {}
    skipped = []
    for path, module in leaves:
        if not hasattr(module, "to_quantized") or not hasattr(module, "weight"):
            continue
        source = "uniform"
        dec = None
        matched = False
        for rx, rule in rules:
            if rx.search(path):
                matched = True
                source = "rule"
                if rule.get("skip"):
                    dec = None
                else:
                    rb = int(rule.get("bits") or base_bits)
                    rg = int(rule.get("group_size") or base_gs)
                    rm = (rule.get("mode") or "").lower() or None
                    if rm is None:
                        rm = base_mode if (base_mode == "affine" or (rg, rb) == MODE_DEFAULTS[base_mode]) else "affine"
                    if rm not in MODE_DEFAULTS:
                        fail(f"Rule '{rule['pattern']}' has unknown mode '{rm}'.", f"Use one of: {', '.join(MODE_DEFAULTS)}.")
                    if rm != "affine":
                        rg, rb = MODE_DEFAULTS[rm]
                    elif rb not in AFFINE_BITS:
                        fail(f"Rule '{rule['pattern']}' asks for {rb} bits.", f"Affine mode supports {AFFINE_BITS}.")
                    dec = {"group_size": rg, "bits": rb, "mode": rm}
                break
        if not matched:
            mp = _call_predicate(model_pred, path, module, config) if model_pred is not None else True
            if mp is False:
                source, dec = "model", None
            elif isinstance(mp, dict):
                source, dec = "model", normalize(mp)
            elif recipe_pred is not None:
                source, dec = "recipe", normalize(_call_predicate(recipe_pred, path, module, config))
            else:
                dec = dict(base_params)
        if dec is not None:
            in_dim = int(module.weight.shape[-1])
            # quantize_model() itself also skips layers not divisible by the default group size.
            if in_dim % dec["group_size"] != 0 or in_dim % base_gs != 0:
                skipped.append(path)
                dec = None
                source = "shape"
        decisions[path] = dec
        sources[path] = source

    q_paths = [p for p, d in decisions.items() if d is not None]
    total = len(q_paths)
    if skipped:
        warn(f"{len(skipped)} layer(s) kept unquantized because their input size is not divisible by the group size: "
             + ", ".join(skipped[:8]) + (" ..." if len(skipped) > 8 else ""))
    kept = [p for p, d in decisions.items() if d is None and sources.get(p) != "shape"]
    if kept:
        log(f"{len(kept)} quantizable layer(s) kept in full precision by rules or the model's own predicate")
    if total == 0:
        warn("No layers will be quantized; the model is only converted.")

    # ------------------------------------------------------------- quantize
    stage("quantize", "Quantizing layers")
    counter = {"i": 0}
    tensor_bytes_in = 0
    tensor_bytes_out = 0

    def lookup(path, module, *_rest):
        nonlocal tensor_bytes_in, tensor_bytes_out
        dec = decisions.get(path)
        if dec is None:
            return False
        w = module.weight
        shape = [int(s) for s in w.shape]
        numel = 1
        for s in shape:
            numel *= s
        gs, bits, mode = dec["group_size"], dec["bits"], dec["mode"]
        # affine keeps a scale and a bias per group in the weight dtype; mx/nv fp formats a uint8 scale.
        per_group = 2 * w.dtype.size if mode == "affine" else 1
        bytes_in = int(w.nbytes)
        bytes_out = int(numel * bits // 8 + (numel // gs) * per_group)
        tensor_bytes_in += bytes_in
        tensor_bytes_out += bytes_out
        counter["i"] += 1
        emit(
            "tensor",
            idx=counter["i"],
            total=total,
            name=path,
            param=path + ".weight",
            shape=shape,
            **{"from": short_dtype(w.dtype)},
            to=(f"q{bits}" if mode == "affine" else mode),
            bits=bits,
            group_size=gs,
            mode=mode,
            source=sources.get(path, "uniform"),
            bytes_in=bytes_in,
            bytes_out=bytes_out,
        )
        if dec == base_params:
            return True
        return dict(dec)

    try:
        model, qconfig = mu.quantize_model(model, config, base_gs, base_bits, mode=base_mode, quant_predicate=lookup)
    except TypeError as e:
        if "mode" not in str(e) or base_mode != "affine":
            raise
        model, qconfig = mu.quantize_model(model, config, base_gs, base_bits, quant_predicate=lookup)

    bpw = None
    try:
        bpw = float(mu.compute_bits_per_weight(model))
    except Exception as e:
        warn(f"Could not compute bits per weight: {e}")

    # ----------------------------------------------------------------- save
    stage("save", "Writing MLX model")
    weights = dict(tree_flatten(model.parameters()))
    try:
        n_shards = len(mu.make_shards(weights))
    except Exception:
        n_shards = 1
    total_bytes = int(sum(v.nbytes for v in weights.values()))
    del weights

    byte_prog = Progress(total_bytes, unit="bytes", label="Materializing weights")
    file_prog = Progress(n_shards, unit="files", label="Writing shards")
    state = {"shard": 0, "done": 0}
    orig_save = mx.save_safetensors

    def save_with_progress(file, arrays, *a, **kw):
        state["shard"] += 1
        label = f"Writing {os.path.basename(str(file))} ({state['shard']}/{n_shards})"
        batch, batch_bytes = [], 0
        for v in arrays.values():
            batch.append(v)
            batch_bytes += v.nbytes
            if batch_bytes >= (64 << 20) or len(batch) >= 64:
                mx.eval(*batch)
                state["done"] += batch_bytes
                byte_prog.set(state["done"], label=label)
                batch, batch_bytes = [], 0
        if batch:
            mx.eval(*batch)
            state["done"] += batch_bytes
            byte_prog.set(state["done"], label=label)
        out = orig_save(file, arrays, *a, **kw)
        file_prog.set(state["shard"], label=label, force=True)
        return out

    mx.save_safetensors = save_with_progress
    try:
        mu.save(mlx_path, hf_path, model, tokenizer, qconfig)
    finally:
        mx.save_safetensors = orig_save
    byte_prog.finish()

    # --------------------------------------------------------------- result
    cfg = read_json(os.path.join(mlx_path, "config.json"), {}) or {}
    quant_block = cfg.get("quantization") or cfg.get("quantization_config")
    files = list_files(mlx_path)
    size_bytes = sum(f["bytes"] for f in files)
    if bpw is not None:
        log(f"Effective bits per weight: {bpw:.3f}")
    emit(
        "result",
        files=files,
        size_bytes=size_bytes,
        bpw=bpw,
        quantization=quant_block,
        quantized_layers=total,
        estimated_tensor_bytes_in=tensor_bytes_in,
        estimated_tensor_bytes_out=tensor_bytes_out,
        mlx_path=mlx_path,
    )
    return 0


if __name__ == "__main__":
    run(main)
