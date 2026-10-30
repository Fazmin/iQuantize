"""Prompt-processing / generation speed benchmark (mlx or onnx env).

args: {"backend": "mlx"|"onnx", "model": "<dir>", "prompt_tokens": 512,
       "gen_tokens": 128, "repeats": 3, "warmup": true}
result: {"pp_tok_s":..., "tg_tok_s":..., "ttft_ms":..., "peak_mem_bytes":...|null,
         "load_ms":..., "runs":[...]}

Prompts are random token ids (like ``mlx_lm.benchmark``) and EOS is ignored so
every run generates exactly ``gen_tokens`` tokens. Values are means over the
repeats; peak_mem_bytes is the maximum.
MLX: tokens/s as reported by mlx_lm.stream_generate; memory = mx.get_peak_memory().
ONNX: onnxruntime-genai Generator; memory = peak process RSS (psutil sampling,
or resource.getrusage when psutil is missing).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import Progress, Timer, emit, fail, load_args, log, read_json, require, run, set_env, stage  # noqa: E402

import threading  # noqa: E402
import time  # noqa: E402


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


# --------------------------------------------------------------------------
# MLX
# --------------------------------------------------------------------------


def bench_mlx(model_dir, prompt_tokens, gen_tokens, repeats, warmup, trust_remote_code):
    import mlx.core as mx
    from mlx_lm import stream_generate
    from mlx_lm.utils import load

    get_peak = getattr(mx, "get_peak_memory", None) or getattr(mx.metal, "get_peak_memory", None)
    reset_peak = getattr(mx, "reset_peak_memory", None) or getattr(mx.metal, "reset_peak_memory", None)

    stage("load", "Loading model")
    t = Timer()
    kwargs = {"return_config": True, "tokenizer_config": {"trust_remote_code": trust_remote_code}}
    try:
        model, tokenizer, config = load(model_dir, trust_remote_code=trust_remote_code, **kwargs)
    except TypeError:
        model, tokenizer, config = load(model_dir, **kwargs)
    load_ms = t.ms()

    # Never stop early on EOS.
    try:
        tokenizer.eos_token_ids = []
    except Exception:
        tokenizer._eos_token_ids = set()

    vocab = config.get("vocab_size") or (config.get("text_config") or {}).get("vocab_size") or 32000
    mx.random.seed(0)
    prompt = mx.random.randint(0, int(vocab), (prompt_tokens,)).tolist()

    def one_run(p, n):
        t0 = time.perf_counter()
        first = None
        last = None
        for resp in stream_generate(model, tokenizer, p, max_tokens=n):
            if first is None:
                first = time.perf_counter()
            last = resp
        return t0, first, last

    if warmup:
        stage("warmup", "Warming up")
        one_run(prompt, 4)  # full-length prompt so prefill kernels are warm too

    stage("bench", "Benchmarking")
    prog = Progress(repeats, unit="steps", label="Benchmark runs")
    runs = []
    for i in range(repeats):
        if reset_peak:
            reset_peak()
        t0, first, last = one_run(prompt, gen_tokens)
        peak = int(get_peak()) if get_peak else None
        r = {
            "pp_tok_s": float(last.prompt_tps),
            "tg_tok_s": float(last.generation_tps),
            "ttft_ms": (first - t0) * 1000.0,
            "generated": int(last.generation_tokens),
            "peak_mem_bytes": peak,
        }
        runs.append(r)
        prog.set(i + 1, label=f"Run {i + 1}/{repeats}: {r['tg_tok_s']:.1f} tok/s")
    return load_ms, runs, "mx.get_peak_memory"


# --------------------------------------------------------------------------
# ONNX
# --------------------------------------------------------------------------


class _RssSampler:
    """Track peak RSS of this process (psutil) while the benchmark runs."""

    def __init__(self, interval=0.02):
        self.peak = None
        self._stop = threading.Event()
        self._thread = None
        try:
            import psutil

            self._proc = psutil.Process()
            self.source = "psutil rss"
        except Exception:
            self._proc = None
            self.source = "resource.ru_maxrss"
        self.interval = interval

    def sample(self):
        if self._proc is not None:
            try:
                rss = int(self._proc.memory_info().rss)
                self.peak = rss if self.peak is None else max(self.peak, rss)
            except Exception:
                pass
        else:
            try:
                import resource

                v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                v = int(v) if sys.platform == "darwin" else int(v) * 1024  # bytes on macOS, KiB on Linux
                self.peak = v if self.peak is None else max(self.peak, v)
            except Exception:
                pass

    def _loop(self):
        while not self._stop.wait(self.interval):
            self.sample()

    def start(self):
        self.sample()
        if self._proc is not None:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join()
        self.sample()
        return self.peak


def bench_onnx(model_dir, prompt_tokens, gen_tokens, repeats, warmup):
    import numpy as np
    import onnxruntime_genai as og

    gc = read_json(os.path.join(model_dir, "genai_config.json"))
    if not gc:
        fail(f"No genai_config.json in {model_dir}", "Select an ONNX model folder produced by the ONNX builder.")
    ctx_len = int(gc.get("model", {}).get("context_length") or 0)
    vocab = int(gc.get("model", {}).get("vocab_size") or 32000)
    if ctx_len and prompt_tokens + gen_tokens > ctx_len:
        fail(f"prompt_tokens + gen_tokens exceeds the model context ({ctx_len}).", "Use fewer tokens.")

    sampler = _RssSampler()
    sampler.start()
    stage("load", "Loading model")
    t = Timer()
    model = og.Model(og.Config(model_dir))
    load_ms = t.ms()

    rng = np.random.default_rng(0)
    prompt = rng.integers(0, vocab, size=prompt_tokens, dtype=np.int64).astype(np.int32)

    def one_run(p, n):
        total = len(p) + n
        params = og.GeneratorParams(model)
        # min_length == max_length keeps EOS from ending the run early.
        params.set_search_options(max_length=total, min_length=total, do_sample=False, batch_size=1)
        gen = og.Generator(model, params)
        t0 = time.perf_counter()
        gen.append_tokens(p)  # prefill
        t_prefill = time.perf_counter()
        gen.generate_next_token()  # sample first token from the prefill logits
        t_first = time.perf_counter()
        count = 1
        while count < n and not gen.is_done():
            gen.generate_next_token()
            count += 1
        t_end = time.perf_counter()
        del gen, params
        return {
            "pp_tok_s": len(p) / max(t_prefill - t0, 1e-9),
            "tg_tok_s": (count - 1) / max(t_end - t_first, 1e-9) if count > 1 else None,
            "ttft_ms": (t_first - t0) * 1000.0,
            "generated": count,
        }

    if warmup:
        stage("warmup", "Warming up")
        one_run(prompt, 4)  # full-length prompt so prefill kernels are warm too

    stage("bench", "Benchmarking")
    prog = Progress(repeats, unit="steps", label="Benchmark runs")
    runs = []
    for i in range(repeats):
        r = one_run(prompt, gen_tokens)
        sampler.sample()
        r["peak_mem_bytes"] = sampler.peak
        runs.append(r)
        tg = r["tg_tok_s"] or 0.0
        prog.set(i + 1, label=f"Run {i + 1}/{repeats}: {tg:.1f} tok/s")
    sampler.stop()
    return load_ms, runs, sampler.source


def main():
    args = load_args()
    backend = (args.get("backend") or "").lower()
    if backend not in ("mlx", "onnx"):
        fail(f"Unknown backend '{backend}'.", "Use 'mlx' or 'onnx'.")
    set_env(backend)
    model_dir = os.path.abspath(os.path.expanduser(require(args, "model")))
    prompt_tokens = int(args.get("prompt_tokens") or 512)
    gen_tokens = int(args.get("gen_tokens") or 128)
    repeats = max(1, int(args.get("repeats") or 3))
    warmup = bool(args.get("warmup", True))
    if prompt_tokens < 1 or gen_tokens < 2:
        fail("prompt_tokens must be >= 1 and gen_tokens >= 2.")
    if not os.path.isdir(model_dir):
        fail(f"Model folder not found: {model_dir}")

    if backend == "mlx":
        load_ms, runs, mem_source = bench_mlx(
            model_dir, prompt_tokens, gen_tokens, repeats, warmup, bool(args.get("trust_remote_code", False))
        )
    else:
        load_ms, runs, mem_source = bench_onnx(model_dir, prompt_tokens, gen_tokens, repeats, warmup)

    peaks = [r.get("peak_mem_bytes") for r in runs if r.get("peak_mem_bytes") is not None]
    res = {
        "pp_tok_s": _mean([r["pp_tok_s"] for r in runs]),
        "tg_tok_s": _mean([r["tg_tok_s"] for r in runs]),
        "ttft_ms": _mean([r["ttft_ms"] for r in runs]),
        "peak_mem_bytes": max(peaks) if peaks else None,
        "load_ms": load_ms,
        "prompt_tokens": prompt_tokens,
        "gen_tokens": gen_tokens,
        "repeats": repeats,
        "memory_source": mem_source,
        "runs": runs,
    }
    log(
        f"pp {res['pp_tok_s']:.1f} tok/s, tg {(res['tg_tok_s'] or 0):.1f} tok/s, "
        f"ttft {res['ttft_ms']:.0f} ms"
    )
    emit("result", **res)
    return 0


if __name__ == "__main__":
    run(main)
