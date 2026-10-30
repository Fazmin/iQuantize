// Goal wizard: target device, runtime, priorities, use cases, and how recommendations work.
export default {
  "goal.device": {
    title: "Target device",
    tagline: "Where the quantized model will run; this decides formats and size limits.",
    what: "Pick the kind of machine the model is for: an Apple Silicon Mac, an NVIDIA or AMD GPU, CPU only, a phone/edge device, or a browser.",
    why: "The device sets the memory budget and which formats run fast. The app filters and ranks variants accordingly.",
    related: ["hw.device.apple_silicon", "hw.device.nvidia", "hw.device.cpu_only", "goal.memory"],
  },

  "goal.memory": {
    title: "Available memory",
    tagline: "How much RAM or VRAM the target device can give the model.",
    what: "The memory of the target: GPU VRAM for discrete GPUs, unified memory for Macs, or system RAM for CPU inference.",
    why: "It is the main constraint on which quant types fit. The app subtracts a safety margin and room for the KV cache and runtime.",
    technical: "On Macs the app uses about 70-75% of unified memory as the GPU budget by default. On discrete GPUs, some VRAM is always taken by the driver, display and compute buffers.",
    related: ["concept.memory_budget", "goal.recommendation", "concept.vram", "concept.unified_memory"],
  },

  "goal.runtime.llamacpp": {
    title: "llama.cpp",
    tagline: "The reference GGUF runtime: CLI and server, on every OS and GPU.",
    what: "llama.cpp's own tools (`llama-cli`, `llama-server`) load GGUF files directly.",
    why: "Supports every GGUF type the installed version knows, the newest architectures first, and fine control over offload and context.",
    related: ["format.gguf", "gguf.tool.server", "goal.runtime.lmstudio"],
  },

  "goal.runtime.lmstudio": {
    title: "LM Studio",
    tagline: "Desktop chat app that runs GGUF on all platforms, and MLX on Apple Silicon.",
    what: "A popular desktop app with a model browser, chat UI and local API server, built on llama.cpp and, on Macs, MLX.",
    why: "Great for sharing models with non-technical users. Its bundled llama.cpp may lag behind the newest quant types for a while.",
    technical: "Searches Hugging Face for GGUF and MLX repos; clear repo names and model cards help users find your quants.",
    related: ["format.gguf", "format.mlx", "goal.runtime.mlx_apps", "hub.model_card"],
  },

  "goal.runtime.ollama": {
    title: "Ollama",
    tagline: "Command-line model runner that imports GGUF files.",
    what: "Ollama runs models from its own library or from GGUF files you import with a Modelfile.",
    why: "Convenient for developers and many integrations. Very new quant types or architectures may not be supported yet.",
    technical: "Import with a Modelfile containing `FROM ./model.gguf`, then `ollama create NAME -f Modelfile`. Ollama can also pull GGUF repos directly from Hugging Face.",
    related: ["format.gguf", "concept.chat_template"],
  },

  "goal.runtime.mlx_apps": {
    title: "MLX apps",
    tagline: "mlx-lm, LM Studio's MLX engine and other Apple Silicon apps that load MLX models.",
    what: "Apps and tools built on Apple's MLX that load MLX-format model folders.",
    why: "Usually the fastest way to run models on a Mac. They only work on Apple Silicon.",
    technical: "Command line: `mlx_lm.generate --model PATH --prompt \"...\"` or `mlx_lm.server`.",
    related: ["format.mlx", "mlx.apple_only", "goal.runtime.lmstudio"],
  },

  "goal.runtime.ort": {
    title: "ONNX Runtime GenAI",
    tagline: "Microsoft's runtime for ONNX LLMs, used in Windows apps, servers and mobile.",
    what: "ONNX Runtime GenAI provides the generation loop, KV cache handling and sampling for ONNX models built by Model Builder.",
    why: "Choose it when you are building an application on ONNX Runtime, especially on Windows or with specific execution providers.",
    related: ["format.onnx", "onnx.engine.builder", "onnx.ep.cpu"],
  },

  "goal.runtime.web": {
    title: "Web (WebGPU)",
    tagline: "Run in the browser via ONNX Runtime Web or Transformers.js.",
    what: "Browser apps that load ONNX models and run them on the GPU through WebGPU.",
    why: "No install for end users, but tight limits on model size and memory. Pick small models with int4.",
    related: ["hw.device.browser", "onnx.ep.webgpu", "format.onnx"],
  },

  "goal.runtime.any": {
    title: "Not sure / any",
    tagline: "Let the app choose the most portable option for your device.",
    what: "The app recommends formats based on your device alone.",
    why: "GGUF is the safest general choice; on Apple Silicon, MLX is worth comparing because it is often faster there.",
    related: ["format.compare", "format.gguf", "goal.recommendation"],
  },

  "goal.priority": {
    title: "Priority",
    tagline: "What matters most: smallest size, best quality, fastest speed, or a balance.",
    what: "Tells the app how to rank variants that fit your memory budget.",
    why: "There is no single best quant: smaller files are faster and fit more devices, larger ones are closer to the original.",
    technical: "Balanced usually lands near 4.5-5 bpw (Q4_K_M, MLX 4-bit). Quality pushes toward 5-8 bpw; size toward 2.5-3.5 bpw with an imatrix or calibrated method.",
    related: ["goal.recommendation", "eval.pareto", "concept.bpw"],
  },

  "goal.context": {
    title: "Context length you need",
    tagline: "How much text you plan to give the model at once; reserves memory for the KV cache.",
    what: "Your typical maximum prompt plus answer length, in tokens.",
    why: "Longer contexts need more KV cache memory, leaving less room for weights. Choosing a realistic value helps the app recommend a better quant.",
    technical: "KV cache per token = 2 x layers x KV heads x head dim x bytes. For Llama-3-8B at FP16 that is 128 KiB per token, about 1 GiB at 8k tokens.",
    related: ["concept.kv_cache", "concept.context_length", "onnx.opt.kv_cache_quant"],
  },

  "goal.usecase.chat": {
    title: "General chat",
    tagline: "Everyday Q&A and conversation; tolerant of mild quantization.",
    what: "Open-ended conversation, explanations and writing help.",
    why: "4-bit quants are usually indistinguishable in casual chat. The reasoning, knowledge and instruction suites are good general checks.",
    related: ["goal.priority", "gguf.qtype.Q4_K_M"],
  },

  "goal.usecase.code": {
    title: "Coding",
    tagline: "Code generation is sensitive: small errors break programs. Favour 5-bit and up.",
    what: "Writing, explaining and fixing code.",
    why: "A single wrong token can break code, and quantization damage shows up early here. Prefer Q5_K_M/Q6_K or calibrated methods, and test with the code suite.",
    related: ["gguf.qtype.Q5_K_M", "eval.exact_match", "concept.calibration"],
  },

  "goal.usecase.rag": {
    title: "RAG / documents",
    tagline: "Answering from long pasted documents; needs context memory and faithful retrieval.",
    what: "Retrieval-augmented generation: the model answers using passages you provide.",
    why: "Long contexts consume KV cache memory, and low-bit quants can lose details buried in long inputs. The needle-in-a-haystack suite checks this.",
    related: ["goal.context", "concept.kv_cache", "eval.exact_match"],
  },

  "goal.usecase.agents": {
    title: "Agents / tool use",
    tagline: "Structured outputs and tool calls: format errors break workflows.",
    what: "The model calls tools, emits JSON or follows multi-step plans.",
    why: "Strict formats are fragile under heavy quantization. Prefer 4.5+ bpw and test with the instruction-following suite.",
    related: ["eval.exact_match", "concept.chat_template", "goal.usecase.code"],
  },

  "goal.usecase.creative": {
    title: "Creative writing",
    tagline: "Stories and brainstorming; quality loss shows as blander text more than as errors.",
    what: "Fiction, role-play and other open-ended generation.",
    why: "More tolerant of quantization than code or math, so smaller quants can be acceptable. Judge by reading outputs, not exact-match scores.",
    related: ["eval.judge", "eval.temperature"],
  },

  "goal.usecase.multilingual": {
    title: "Multilingual",
    tagline: "Non-English use often degrades faster under quantization; calibrate with matching text.",
    what: "Using the model in languages other than English.",
    why: "Less common languages and scripts tend to suffer more at low bits, especially with English-only calibration data. Prefer 5-bit or include your languages in calibration text.",
    related: ["calib.custom_file", "gguf.preset.embed_q8", "concept.calibration"],
  },

  "goal.explore": {
    title: "Explore variants",
    tagline: "Make several quants at once and compare them on a size-vs-quality chart.",
    what: "Produces a sweep of variants (for example Q3_K_M through Q8_0, or MLX 3-8 bit) and evaluates each against the reference.",
    why: "The best way to see where quality starts to drop for this particular model, instead of guessing.",
    technical: "The app plots size against a quality metric (KLD, perplexity or suite score) and highlights the Pareto front: variants not beaten on both size and quality by any other.",
    related: ["eval.pareto", "eval.kld", "eval.reference"],
  },

  "goal.recommendation": {
    title: "How recommendations are computed",
    tagline: "Estimated memory use (weights + KV cache + overhead) compared against your device budget.",
    what: "For each candidate, the app estimates the memory it needs on your device and checks it against your budget, then ranks the ones that fit by your priority.",
    why: "It gives a sensible starting point, but it is an estimate: real usage depends on the runtime, settings and other apps.",
    technical: "Weights = sum over tensors of parameters x bpw of that tensor's type / 8 (llama-quantize --dry-run can give the exact GGUF figure). KV cache = 2 x layers x KV heads x head dim x context x bytes per element. Plus a runtime overhead allowance. Budget = VRAM, or about 70-75% of unified memory on Macs, or system RAM minus headroom on CPU.",
    related: ["concept.memory_budget", "concept.kv_cache", "concept.bpw", "gguf.opt.dry_run"],
  },
};
