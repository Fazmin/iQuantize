"""Persistent ONNX Runtime GenAI chat server over stdio (onnx env).

Reads one JSON command per line from stdin:
  {"cmd":"load","path":"<dir with genai_config.json>", "provider"?: "follow_config"|"cpu"|...}
      -> {"t":"result","ok":true,"cmd":"load","load_ms":...}
  {"cmd":"generate","id":"r1","messages":[{"role":"user","content":"..."}],
   "max_tokens":256,"temperature":0.0,"top_p":1.0,"top_k"?:50,"seed":42}
      -> {"t":"token","id":"r1","text":"..."}* then
         {"t":"result","cmd":"generate","id":"r1","ttft_ms":...,"tokens":n,"tok_per_s":...,
          "prompt_tokens":n,"total_ms":...,"finish_reason":"stop"|"length"|"cancelled"}
  {"cmd":"cancel","id":"r1"}   (checked between tokens)
  {"cmd":"quit"}               (also on stdin EOF)

Per-command failures emit {"t":"error","cmd":...,"id":...,"message":...,"hint":...}
and the server keeps running; only startup failures (e.g. onnxruntime_genai not
importable) end the process with exit code 1.

Chat template order: onnxruntime-genai Tokenizer.apply_chat_template (with
chat_template.jinja if the model folder has one) -> Jinja2 render of
tokenizer_config.json's chat_template -> plain "role: content" lines.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iq_common import DriverError, describe_exception, emit, log, read_json, run, set_env, warn  # noqa: E402

import json  # noqa: E402
import queue  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402


class State:
    def __init__(self):
        self.cancelled = set()
        self.lock = threading.Lock()
        self.quit = threading.Event()
        self.current_id = None


STATE = State()


def reader(q: "queue.Queue"):
    """Read stdin lines; handle cancel/quit immediately, queue everything else."""
    stdin = sys.stdin.buffer
    while True:
        try:
            raw = stdin.readline()
        except Exception:
            raw = b""
        if not raw:
            STATE.quit.set()
            q.put({"cmd": "quit"})
            return
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            if not isinstance(cmd, dict):
                raise ValueError("command must be a JSON object")
        except Exception as e:
            emit("error", cmd=None, message=f"Invalid command line: {e}")
            continue
        name = cmd.get("cmd")
        if name == "cancel":
            with STATE.lock:
                STATE.cancelled.add(str(cmd.get("id")))
            continue
        if name == "quit":
            STATE.quit.set()
        q.put(cmd)
        if name == "quit":
            return


# --------------------------------------------------------------------------
# chat templates
# --------------------------------------------------------------------------


def _token_text(tok):
    if isinstance(tok, dict):
        return tok.get("content") or ""
    return tok or ""


class ChatFormatter:
    def __init__(self, model_dir, tokenizer):
        self.model_dir = model_dir
        self.tokenizer = tokenizer
        self.last_path = None
        jinja_path = os.path.join(model_dir, "chat_template.jinja")
        self.template_file = None
        if os.path.isfile(jinja_path):
            with open(jinja_path, "r", encoding="utf-8") as f:
                self.template_file = f.read()
        tc = read_json(os.path.join(model_dir, "tokenizer_config.json"), {}) or {}
        tmpl = tc.get("chat_template")
        if isinstance(tmpl, list):  # [{"name": "default", "template": "..."}]
            named = {t.get("name"): t.get("template") for t in tmpl if isinstance(t, dict)}
            tmpl = named.get("default") or next(iter(named.values()), None)
        self.hf_template = self.template_file or tmpl
        self.bos = _token_text(tc.get("bos_token"))
        self.eos = _token_text(tc.get("eos_token"))

    def _note(self, path, reason=None):
        if path != self.last_path:
            if path == "genai":
                log("Chat template: onnxruntime-genai Tokenizer.apply_chat_template")
            elif path == "jinja2":
                warn("Chat template: rendered with Jinja2 from the model's template" + (f" ({reason})" if reason else ""))
            else:
                warn("Chat template: none usable, using plain 'role: content' format" + (f" ({reason})" if reason else ""))
            self.last_path = path

    def render(self, messages):
        msgs = [{"role": str(m.get("role", "user")), "content": str(m.get("content", ""))} for m in messages]
        reason = None
        if hasattr(self.tokenizer, "apply_chat_template"):
            try:
                kwargs = {"add_generation_prompt": True}
                if self.template_file:
                    kwargs["template_str"] = self.template_file
                out = self.tokenizer.apply_chat_template(json.dumps(msgs, ensure_ascii=False), **kwargs)
                if out:
                    self._note("genai")
                    return out
                reason = "genai returned an empty prompt"
            except Exception as e:
                reason = f"genai: {e}"
        if self.hf_template:
            try:
                from jinja2.sandbox import ImmutableSandboxedEnvironment

                def raise_exception(message):
                    raise ValueError(message)

                def strftime_now(fmt):
                    return time.strftime(fmt)

                env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
                env.globals["raise_exception"] = raise_exception
                env.globals["strftime_now"] = strftime_now
                out = env.from_string(self.hf_template).render(
                    messages=msgs,
                    add_generation_prompt=True,
                    bos_token=self.bos,
                    eos_token=self.eos,
                )
                self._note("jinja2", reason)
                return out
            except ImportError:
                reason = (reason + "; " if reason else "") + "jinja2 not installed"
            except Exception as e:
                reason = (reason + "; " if reason else "") + f"jinja2: {e}"
        lines = [f"{m['role']}: {m['content']}" for m in msgs]
        lines.append("assistant:")
        self._note("plain", reason)
        return "\n".join(lines)


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------


class Server:
    def __init__(self):
        import onnxruntime_genai as og

        self.og = og
        self.model = None
        self.tokenizer = None
        self.formatter = None
        self.path = None
        self.context_length = 0
        self.eos_ids = set()

    def load(self, cmd):
        og = self.og
        path = cmd.get("path")
        if not path:
            raise DriverError("load needs a 'path'.", "This is an iQuantize bug; please report it.")
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(os.path.join(path, "genai_config.json")):
            raise DriverError(f"No genai_config.json in {path}", "Select an ONNX model folder produced by the ONNX builder.")
        t0 = time.perf_counter()
        self.model = self.tokenizer = self.formatter = None
        config = og.Config(path)
        provider = cmd.get("provider")
        if provider and provider != "follow_config":
            config.clear_providers()
            if provider != "cpu":
                config.append_provider(provider)
        self.model = og.Model(config)
        self.tokenizer = og.Tokenizer(self.model)
        self.formatter = ChatFormatter(path, self.tokenizer)
        gc = read_json(os.path.join(path, "genai_config.json"), {}) or {}
        self.context_length = int(gc.get("model", {}).get("context_length") or 0)
        eos = None
        try:
            eos = self.tokenizer.eos_token_ids
            eos = eos() if callable(eos) else eos
        except Exception:
            eos = None
        if eos is None:
            eos = gc.get("model", {}).get("eos_token_id")
        if isinstance(eos, int):
            eos = [eos]
        self.eos_ids = {int(e) for e in (eos or [])}
        self.path = path
        load_ms = (time.perf_counter() - t0) * 1000.0
        emit("result", ok=True, cmd="load", load_ms=load_ms, path=path, context_length=self.context_length)

    def generate(self, cmd):
        import numpy as np

        og = self.og
        rid = str(cmd.get("id") or "")
        if self.model is None:
            raise DriverError("No model loaded.", "Load a model before generating.")
        messages = cmd.get("messages") or []
        if not isinstance(messages, list) or not messages:
            raise DriverError("generate needs a non-empty 'messages' list.")
        max_tokens = max(1, int(cmd.get("max_tokens") or 256))
        temperature = float(cmd.get("temperature") if cmd.get("temperature") is not None else 0.0)
        top_p = float(cmd.get("top_p") if cmd.get("top_p") is not None else 1.0)
        top_k = cmd.get("top_k")
        seed = cmd.get("seed")

        t0 = time.perf_counter()
        prompt = self.formatter.render(messages)
        ids = np.asarray(self.tokenizer.encode(prompt), dtype=np.int32)
        n_prompt = int(ids.size)
        max_length = n_prompt + max_tokens
        if self.context_length:
            if n_prompt >= self.context_length:
                raise DriverError(
                    f"The prompt has {n_prompt} tokens; the model context is {self.context_length}.",
                    "Shorten the conversation.",
                )
            max_length = min(max_length, self.context_length)

        params = og.GeneratorParams(self.model)
        opts = {"max_length": max_length, "batch_size": 1}
        if temperature <= 0:
            opts["do_sample"] = False  # greedy
        else:
            opts.update(do_sample=True, temperature=temperature, top_p=top_p)
            if top_k:
                opts["top_k"] = int(top_k)
        params.set_search_options(**opts)
        if seed is not None:
            try:
                params.set_search_options(random_seed=int(seed))
            except Exception as e:
                warn(f"random_seed not supported by this onnxruntime-genai: {e}")

        gen = og.Generator(self.model, params)
        gen.append_tokens(ids)
        stream = self.tokenizer.create_stream()
        STATE.current_id = rid
        n = 0
        t_first = None
        finish = "length"
        try:
            while n < max_tokens:
                with STATE.lock:
                    if rid in STATE.cancelled or STATE.quit.is_set():
                        STATE.cancelled.discard(rid)
                        finish = "cancelled"
                        break
                if gen.is_done():
                    finish = "stop"
                    break
                gen.generate_next_token()
                tok = int(gen.get_next_tokens()[0])
                n += 1
                if t_first is None:
                    t_first = time.perf_counter()
                if tok in self.eos_ids:
                    finish = "stop"
                    break
                text = stream.decode(tok)
                if text:
                    emit("token", id=rid, text=text)
            else:
                finish = "length"
        finally:
            STATE.current_id = None
            del gen, params
        t_end = time.perf_counter()
        if t_first is not None and n > 1 and t_end > t_first:
            tok_per_s = (n - 1) / (t_end - t_first)
        elif t_first is not None and t_end > t0:
            tok_per_s = n / (t_end - t0)
        else:
            tok_per_s = 0.0
        if finish == "length" and self.context_length and n_prompt + n >= self.context_length:
            finish = "context"
        emit(
            "result",
            cmd="generate",
            id=rid,
            ttft_ms=((t_first - t0) * 1000.0) if t_first else None,
            tokens=n,
            tok_per_s=tok_per_s,
            prompt_tokens=n_prompt,
            total_ms=(t_end - t0) * 1000.0,
            finish_reason=finish,
        )


def main():
    set_env("onnx")
    server = Server()  # fails fast (exit 1) if onnxruntime_genai is missing
    q: "queue.Queue" = queue.Queue()
    threading.Thread(target=reader, args=(q,), daemon=True).start()
    log("onnx_infer ready")
    while True:
        cmd = q.get()
        name = cmd.get("cmd")
        if name == "quit":
            break
        try:
            if name == "load":
                server.load(cmd)
            elif name == "generate":
                server.generate(cmd)
            else:
                raise DriverError(f"Unknown command '{name}'.")
        except MemoryError:
            emit("error", cmd=name, id=cmd.get("id"), message="Out of memory", hint="Try a smaller model or close other apps.")
        except Exception as exc:  # keep serving
            import traceback

            traceback.print_exc(file=sys.stderr)
            msg, hint = describe_exception(exc)
            fields = {"cmd": name, "message": msg}
            if cmd.get("id") is not None:
                fields["id"] = cmd.get("id")
            if hint:
                fields["hint"] = hint
            emit("error", **fields)
    return 0


if __name__ == "__main__":
    run(main, env="onnx")
