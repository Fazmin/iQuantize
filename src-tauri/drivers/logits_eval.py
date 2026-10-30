"""Perplexity, reference logits and KL-divergence evaluation (mlx or onnx env).

args: {"backend": "mlx"|"onnx", "model": "<dir>", "text_path": "<utf-8 text file>",
       "ctx": 512, "chunks": 20, "mode": "ppl"|"save_ref"|"kld",
       "ref_path": "<.npz>", "top_k": 64,
       "use_ref_tokens": false,          # kld: evaluate on the reference's token ids if ours differ
       "onnx_method": "auto"|"genai"|"session",
       "trust_remote_code": false}

Like llama-perplexity: the text is tokenized once, split into non-overlapping
windows of ``ctx`` tokens, and only the second half of each window is scored
(logits at positions ctx/2 .. ctx-2 predict tokens ctx/2+1 .. ctx-1), so every
scored token has at least ctx/2 tokens of context.

ONNX: uses onnxruntime-genai (Generator.append_tokens(window) then
get_output("logits"), which returns [1, ctx, vocab] for the whole window in
0.18.x). If a model only returns last-token logits, falls back to running the
decoder ONNX file directly with onnxruntime.InferenceSession and an empty KV
cache, using the input names from genai_config.json.

KLD: KL(P_ref || P_q) per position over the reference's top-k token ids plus
one "tail" bucket holding the remaining probability mass (q's tail = 1 - sum of
q over those ids). Exact when the reference tail is ~0, a slight underestimate
otherwise.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import (  # noqa: E402
    Progress,
    Timer,
    emit,
    fail,
    load_args,
    log,
    metric,
    read_json,
    require,
    run,
    set_env,
    stage,
    warn,
)

import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import time  # noqa: E402


# --------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------


class MlxBackend:
    name = "mlx"

    def __init__(self, path, trust_remote_code=False):
        import mlx.core as mx
        from mlx_lm.utils import load

        self.mx = mx
        kwargs = {"tokenizer_config": {"trust_remote_code": trust_remote_code}}
        try:
            self.model, self.tokenizer = load(path, trust_remote_code=trust_remote_code, **kwargs)
        except TypeError:
            self.model, self.tokenizer = load(path, **kwargs)

    def tokenize(self, text):
        import numpy as np

        return np.asarray(self.tokenizer.encode(text), dtype=np.int64)

    def logprobs(self, window, start, stop):
        """log-softmax (float32 numpy, [stop-start, vocab]) for positions start..stop-1."""
        import numpy as np

        mx = self.mx
        x = mx.array(window.astype(np.int32))[None]
        logits = self.model(x)[0, start:stop].astype(mx.float32)
        lp = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        mx.eval(lp)
        out = np.array(lp)
        del logits, lp, x
        try:
            mx.clear_cache()
        except Exception:
            pass
        return out


_ORT_TYPES = {
    "tensor(float)": "float32",
    "tensor(float16)": "float16",
    "tensor(double)": "float64",
    "tensor(int64)": "int64",
    "tensor(int32)": "int32",
    "tensor(bool)": "bool",
}


class OnnxBackend:
    name = "onnx"

    def __init__(self, path, method="auto"):
        import onnxruntime_genai as og

        self.og = og
        self.path = path
        self.method = method
        self.gc = read_json(os.path.join(path, "genai_config.json"))
        if not self.gc:
            fail(f"No genai_config.json in {path}", "Select an ONNX model folder produced by the ONNX builder.")
        self.context_length = int(self.gc.get("model", {}).get("context_length") or 0)
        self.model = og.Model(og.Config(path))
        self.tokenizer = og.Tokenizer(self.model)
        self._session = None
        self._warned = False

    def tokenize(self, text):
        import numpy as np

        return np.asarray(self.tokenizer.encode(text), dtype=np.int64)

    def _genai_logits(self, window):
        import numpy as np

        og = self.og
        n = len(window)
        params = og.GeneratorParams(self.model)
        max_len = n if not self.context_length else min(max(n, 1), self.context_length)
        params.set_search_options(max_length=max_len, batch_size=1)
        gen = og.Generator(self.model, params)
        gen.append_tokens(window.astype(np.int32))
        logits = np.asarray(gen.get_output("logits"))
        del gen, params
        if logits.ndim == 3:
            logits = logits[0]
        return logits

    def _session_logits(self, window):
        import numpy as np
        import onnxruntime as ort

        dec = self.gc["model"]["decoder"]
        if self._session is None:
            so = ort.SessionOptions()
            so.log_severity_level = 3
            self._session = ort.InferenceSession(
                os.path.join(self.path, dec["filename"]), so, providers=["CPUExecutionProvider"]
            )
            log(f"Using onnxruntime.InferenceSession on {dec['filename']} for full-window logits")
        sess = self._session
        names = dec.get("inputs", {})
        kv_heads = int(dec.get("num_key_value_heads") or dec.get("num_attention_heads"))
        head_size = int(dec.get("head_size"))
        past_rx = []
        for key in ("past_key_names", "past_value_names"):
            pat = names.get(key)
            if pat:
                past_rx.append(re.compile("^" + re.escape(pat).replace("%d", r"\d+") + "$"))
        n = len(window)
        feeds = {}
        for inp in sess.get_inputs():
            dt = _ORT_TYPES.get(inp.type)
            if dt is None:
                fail(f"Unsupported ONNX input type {inp.type} for {inp.name}")
            if inp.name == names.get("input_ids", "input_ids"):
                feeds[inp.name] = window[None].astype(dt)
            elif inp.name == names.get("attention_mask", "attention_mask"):
                feeds[inp.name] = np.ones((1, n), dtype=dt)
            elif inp.name == names.get("position_ids", "position_ids"):
                feeds[inp.name] = np.arange(n, dtype=dt)[None]
            elif any(rx.match(inp.name) for rx in past_rx):
                feeds[inp.name] = np.zeros((1, kv_heads, 0, head_size), dtype=dt)
            else:
                fail(f"Don't know how to feed ONNX input '{inp.name}'", "Use onnx_method 'genai' for this model.")
        out_name = dec.get("outputs", {}).get("logits", "logits")
        logits = sess.run([out_name], feeds)[0]
        if logits.ndim == 3:
            logits = logits[0]
        return logits

    def logprobs(self, window, start, stop):
        import numpy as np

        n = len(window)
        logits = None
        if self.method in ("auto", "genai"):
            logits = self._genai_logits(window)
            if logits.shape[0] != n:
                if self.method == "genai":
                    fail(
                        f"onnxruntime-genai returned logits for {logits.shape[0]} of {n} positions.",
                        "Use onnx_method 'session' for this model.",
                    )
                if not self._warned:
                    warn("onnxruntime-genai returned only last-token logits; switching to onnxruntime.InferenceSession")
                    self._warned = True
                self.method = "session"
                logits = None
        if logits is None:
            logits = self._session_logits(window)
        x = np.asarray(logits[start:stop], dtype=np.float32)
        m = x.max(axis=-1, keepdims=True)
        lse = m + np.log(np.exp(x - m).sum(axis=-1, keepdims=True, dtype=np.float64)).astype(np.float32)
        return x - lse


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _ppl_stats(nll):
    import numpy as np

    nll = np.asarray(nll, dtype=np.float64)
    n = nll.size
    mean = float(nll.mean()) if n else float("nan")
    ppl = math.exp(mean) if n else float("nan")
    if n > 1:
        stderr = float(nll.std(ddof=1)) / math.sqrt(n)
        ppl_stderr = ppl * stderr  # delta method, as in llama-perplexity / mlx_lm.perplexity
    else:
        ppl_stderr = None
    return ppl, ppl_stderr


def _tokenize_enough(backend, text, need_tokens):
    """Tokenize a generous prefix of the text; fall back to the whole text if too short."""
    if need_tokens > 0:
        limit = need_tokens * 12 + 4096
        if limit < len(text):
            toks = backend.tokenize(text[:limit])
            if len(toks) >= need_tokens + 8:
                return toks
    return backend.tokenize(text)


def _topk(logp, k):
    import numpy as np

    k = min(k, logp.shape[1])
    idx = np.argpartition(-logp, k - 1, axis=1)[:, :k]
    vals = np.take_along_axis(logp, idx, axis=1)
    # descending log-prob; ties (common with bf16 logits) broken by lower token id like argmax
    order = np.lexsort((idx, -vals), axis=1)
    ids = np.take_along_axis(idx, order, axis=1)
    vals = np.take_along_axis(vals, order, axis=1)
    mass = np.exp(vals.astype(np.float64)).sum(axis=1)
    tail = np.log(np.clip(1.0 - mass, 1e-12, None))
    return ids.astype(np.int32), vals.astype(np.float32), tail.astype(np.float32)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main():
    args = load_args()
    backend_name = (args.get("backend") or "").lower()
    if backend_name not in ("mlx", "onnx"):
        fail(f"Unknown backend '{backend_name}'.", "Use 'mlx' or 'onnx'.")
    set_env(backend_name)
    model_dir = os.path.abspath(os.path.expanduser(require(args, "model")))
    text_path = os.path.abspath(os.path.expanduser(require(args, "text_path")))
    mode = (args.get("mode") or "ppl").lower()
    if mode not in ("ppl", "save_ref", "kld"):
        fail(f"Unknown mode '{mode}'.", "Use ppl, save_ref or kld.")
    ctx = int(args.get("ctx") or 512)
    chunks = int(args.get("chunks") if args.get("chunks") is not None else 20)
    top_k = int(args.get("top_k") or 64)
    ref_path = args.get("ref_path")
    if mode in ("save_ref", "kld") and not ref_path:
        fail("ref_path is required for save_ref and kld.", "This is an iQuantize bug; please report it.")
    if ref_path:
        ref_path = os.path.abspath(os.path.expanduser(ref_path))
    if ctx < 8:
        fail("ctx must be at least 8 tokens.")
    if not os.path.isfile(text_path):
        fail(f"Text file not found: {text_path}", "Fetch an evaluation text first.")

    import numpy as np

    ref = None
    if mode == "kld":
        if not os.path.isfile(ref_path):
            fail(f"Reference file not found: {ref_path}", "Run save_ref on the unquantized model first.")
        with np.load(ref_path, allow_pickle=False) as z:
            ref = {k: z[k] for k in z.files}
        ctx_ref = int(ref["ctx"])
        if ctx_ref != ctx:
            log(f"Using the reference's context size {ctx_ref} (requested {ctx})")
        ctx = ctx_ref
        windows_ref = int(ref["windows"])
        if chunks > 0 and chunks < windows_ref:
            log(f"Using all {windows_ref} reference chunks (requested {chunks})")
        top_k = int(ref["top_k"])

    # ---------------------------------------------------------------- load
    stage("load", "Loading model")
    t = Timer()
    if backend_name == "mlx":
        backend = MlxBackend(model_dir, trust_remote_code=bool(args.get("trust_remote_code", False)))
    else:
        backend = OnnxBackend(model_dir, method=(args.get("onnx_method") or "auto").lower())
        if backend.context_length and ctx > backend.context_length:
            fail(f"ctx {ctx} exceeds the model context length {backend.context_length}.", "Use a smaller ctx.")
    load_ms = t.ms()
    log(f"Model loaded in {load_ms / 1000:.1f}s")

    # ------------------------------------------------------------ tokenize
    stage("tokenize", "Tokenizing text")
    with open(text_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    if ref is not None:
        need = int(ref["windows"]) * ctx
    else:
        need = chunks * ctx if chunks > 0 else 0
    tokens = _tokenize_enough(backend, text, need)
    del text

    if ref is not None:
        ref_tokens = ref["tokens"].astype(np.int64)
        windows = int(ref["windows"])
        need = windows * ctx
        same = len(tokens) >= need and np.array_equal(tokens[:need], ref_tokens[:need])
        if not same:
            mism = None
            m = min(len(tokens), need)
            diff = np.nonzero(tokens[:m] != ref_tokens[:m])[0]
            if diff.size:
                mism = int(diff[0])
            if args.get("use_ref_tokens"):
                warn(
                    "Token ids differ from the reference"
                    + (f" (first difference at token {mism})" if mism is not None else " (text too short)")
                    + "; evaluating on the reference's token ids."
                )
                tokens = ref_tokens
            else:
                fail(
                    "The token ids differ from the reference"
                    + (f" (first difference at token {mism})." if mism is not None else " (the text is too short)."),
                    "Use the same text file and a model with the same tokenizer, or recreate the reference.",
                )
    else:
        avail = len(tokens) // ctx
        if avail < 1:
            fail(f"The text has only {len(tokens)} tokens, fewer than one window of {ctx}.", "Use a longer text or a smaller ctx.")
        windows = min(chunks, avail) if chunks > 0 else avail
        if chunks > avail:
            warn(f"Only {avail} windows of {ctx} tokens are available (requested {chunks}).")
    first = ctx // 2
    n_score = ctx - 1 - first
    log(f"{len(tokens):,} tokens; evaluating {windows} window(s) of {ctx}, scoring {n_score} positions each")

    # ------------------------------------------------------------- evaluate
    stage("eval", {"ppl": "Computing perplexity", "save_ref": "Computing reference logits", "kld": "Computing KL divergence"}[mode])
    prog = Progress(windows, unit="chunks", label="Evaluating")
    nll_all = []
    ref_ids, ref_lp, ref_tail, ref_target = [], [], [], []
    kld_all, top1_all, dp_all = [], [], []
    t_eval = time.perf_counter()
    for w in range(windows):
        win = tokens[w * ctx : (w + 1) * ctx]
        logp = backend.logprobs(win, first, ctx - 1)  # [n_score, V]
        targets = win[first + 1 : ctx]
        rows = np.arange(n_score)
        tgt_lp = logp[rows, targets].astype(np.float64)
        nll_all.append(-tgt_lp)

        if mode == "save_ref":
            ids, vals, tail = _topk(logp, top_k)
            ref_ids.append(ids)
            ref_lp.append(vals)
            ref_tail.append(tail)
            ref_target.append(tgt_lp.astype(np.float32))
        elif mode == "kld":
            sl = slice(w * n_score, (w + 1) * n_score)
            ids = ref["topk_ids"][sl].astype(np.int64)
            lp_ref = ref["topk_logp"][sl].astype(np.float64)
            tail_ref = ref["tail_logp"][sl].astype(np.float64)
            p_ref = np.exp(lp_ref)
            pt_ref = np.exp(tail_ref)
            z = p_ref.sum(axis=1) + pt_ref
            log_z = np.log(z)
            lp_ref_n = lp_ref - log_z[:, None]
            p_ref = p_ref / z[:, None]
            pt_ref = pt_ref / z
            lq = np.take_along_axis(logp, ids, axis=1).astype(np.float64)
            q_sel = np.exp(lq)
            q_tail = np.clip(1.0 - q_sel.sum(axis=1), 1e-12, None)
            kl = (p_ref * (lp_ref_n - lq)).sum(axis=1) + pt_ref * (np.log(pt_ref) - np.log(q_tail))
            kld_all.append(kl)
            # tie-aware: the reference's top-1 token also has q's highest log-prob
            top1_all.append(lq[:, 0] >= logp.max(axis=1).astype(np.float64))
            dp_all.append(np.abs(p_ref[:, 0] - q_sel[:, 0]))

        ppl_run, _ = _ppl_stats(np.concatenate(nll_all))
        metric("ppl", ppl_run, step=w + 1)
        if mode == "kld":
            metric("kld", float(np.concatenate(kld_all).mean()), step=w + 1)
            metric("top1", float(np.concatenate(top1_all).mean()), step=w + 1)
        prog.set(w + 1, label=f"Chunk {w + 1}/{windows}")
    eval_s = time.perf_counter() - t_eval

    nll = np.concatenate(nll_all)
    ppl, ppl_stderr = _ppl_stats(nll)
    positions = int(nll.size)
    common = {"tokens": int(len(tokens)), "chunks": windows, "ctx": ctx, "positions": positions, "eval_seconds": round(eval_s, 3)}

    if mode == "ppl":
        emit("result", ppl=ppl, ppl_stderr=ppl_stderr, **common)
        return 0

    if mode == "save_ref":
        stage("save", "Saving reference")
        os.makedirs(os.path.dirname(ref_path) or ".", exist_ok=True)
        meta = {
            "backend": backend_name,
            "model": model_dir,
            "text_path": text_path,
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ppl": ppl,
        }
        tmp = ref_path + ".part"
        with open(tmp, "wb") as f:
            np.savez_compressed(
                f,
                tokens=tokens[: windows * ctx].astype(np.int32),
                ctx=np.int64(ctx),
                first=np.int64(first),
                windows=np.int64(windows),
                top_k=np.int64(top_k),
                topk_ids=np.concatenate(ref_ids),
                topk_logp=np.concatenate(ref_lp),
                tail_logp=np.concatenate(ref_tail),
                target_logp=np.concatenate(ref_target),
                meta=np.array(json.dumps(meta)),
            )
        os.replace(tmp, ref_path)
        emit(
            "result",
            ref_path=ref_path,
            positions=positions,
            ppl=ppl,
            ppl_stderr=ppl_stderr,
            top_k=top_k,
            bytes=os.path.getsize(ref_path),
            **{k: v for k, v in common.items() if k != "positions"},
        )
        return 0

    # kld
    kld = np.concatenate(kld_all)
    top1 = np.concatenate(top1_all)
    dp = np.concatenate(dp_all)
    ref_ppl = None
    if "target_logp" in ref:
        ref_ppl, _ = _ppl_stats(-ref["target_logp"][:positions].astype(np.float64))
    emit(
        "result",
        kld_mean=float(kld.mean()),
        kld_median=float(np.median(kld)),
        kld_p99=float(np.percentile(kld, 99)),
        kld_max=float(kld.max()),
        kld_stderr=float(kld.std(ddof=1) / math.sqrt(kld.size)) if kld.size > 1 else None,
        top1_agreement=float(top1.mean()),
        delta_p_mean=float(dp.mean()),
        ppl=ppl,
        ppl_stderr=ppl_stderr,
        ref_ppl=ref_ppl,
        approximation=f"top-k + tail bucket, k={top_k}",
        **common,
    )
    return 0


if __name__ == "__main__":
    run(main)
