// Toolchain (managed Python, environments, llama.cpp), app settings and calibration data sources.
export default {
  // ---------------------------------------------------------------- toolchain
  "tc.uv": {
    title: "uv",
    tagline: "A fast Python package and environment manager the app uses to install its tools.",
    what: "uv, made by Astral and written in Rust, downloads Python, creates virtual environments and installs packages. The app downloads its own copy into the app's data folder.",
    why: "It keeps everything self-contained: nothing is installed into your system Python, and environments can be repaired or rebuilt quickly.",
    technical: "The app uses uv to install a managed Python and one isolated virtual environment per format (gguf, mlx, onnx, core).",
    related: ["tc.python", "tc.env.core", "tc.doctor"],
    learnMore: [{ label: "uv documentation", url: "https://docs.astral.sh/uv/" }],
  },

  "tc.python": {
    title: "Managed Python 3.12",
    tagline: "A private Python installed by uv for the app; your system Python is left untouched.",
    what: "uv installs a managed Python 3.12 just for iQuantize.",
    why: "A known Python version avoids conflicts with other software and makes installs reproducible across machines.",
    technical: "Lives in the app's data folder alongside uv, separate from any Python you installed yourself.",
    related: ["tc.uv", "tc.env.gguf", "tc.env.onnx"],
  },

  "tc.llamacpp": {
    title: "llama.cpp binaries",
    tagline: "Prebuilt llama.cpp tools (quantize, imatrix, perplexity, bench, server, gguf-split).",
    what: "The app downloads the official llama.cpp release for your operating system and accelerator from GitHub.",
    why: "Prebuilt binaries avoid compiling C++ yourself, and choosing the right accelerator build makes imatrix, perplexity and testing much faster.",
    technical: "Builds offered: macOS arm64 (Metal) and x64 (CPU); Windows CPU, CUDA 12.4/13.4, Vulkan and arm64; Linux CPU, Vulkan, CUDA 12.8/13.4 and ROCm, plus arm64 Linux builds. After installing, the app probes each tool's `--help`.",
    related: ["tc.accelerator", "tc.probe", "gguf.tool.quantize"],
    learnMore: [{ label: "llama.cpp releases", url: "https://github.com/ggml-org/llama.cpp/releases" }],
  },

  "tc.env.gguf": {
    title: "gguf environment",
    tagline: "Python environment for llama.cpp's converter (convert_hf_to_gguf.py and gguf-py).",
    what: "An isolated virtual environment containing the conversion script's requirements and the `gguf` Python package.",
    why: "Needed for the first step of every GGUF job: turning Hugging Face weights into a GGUF file.",
    technical: "The converter script, its requirements and gguf-py are taken from the same llama.cpp release tag as the binaries, so both know the same architectures and types.",
    related: ["gguf.tool.convert", "tc.uv", "tc.llamacpp"],
  },

  "tc.env.mlx": {
    title: "mlx environment",
    tagline: "Python environment with mlx-lm 0.32.x; Apple Silicon only.",
    what: "An isolated virtual environment containing mlx-lm and its dependencies.",
    why: "Runs MLX conversion, the advanced quantization methods (AWQ, GPTQ, DWQ, dynamic quant) and MLX evaluation.",
    technical: "Only created on macOS arm64, since MLX requires Apple Silicon.",
    related: ["mlx.apple_only", "mlx.method.convert", "tc.uv"],
  },

  "tc.env.onnx": {
    title: "onnx environment",
    tagline: "Python environment with onnxruntime-genai 0.18.x, PyTorch and Transformers.",
    what: "An isolated virtual environment for Model Builder and the Optimum/ONNX Runtime quantization path.",
    why: "Model Builder needs PyTorch and Transformers to read the source model. This is the largest environment to download.",
    technical: "NVIDIA machines can use the CUDA build of onnxruntime-genai instead. Engine B's Optimum exporter (`optimum-onnx`) is an optional add-on.",
    related: ["onnx.engine.builder", "onnx.engine.optimum", "tc.uv"],
  },

  "tc.env.core": {
    title: "core environment",
    tagline: "Python environment for Hugging Face downloads, uploads and calibration datasets.",
    what: "An isolated virtual environment with `huggingface_hub[hf_xet]` and `datasets`.",
    why: "Handles talking to the Hub (including fast Xet transfers) and fetching calibration and evaluation text.",
    related: ["hub.xet", "calib.hf_dataset", "tc.uv"],
  },

  "tc.accelerator": {
    title: "Accelerator build",
    tagline: "Which llama.cpp build to install: Metal, CUDA, Vulkan, ROCm or CPU.",
    what: "Selects the llama.cpp release package that matches your GPU.",
    why: "The right build makes imatrix, perplexity, benchmarks and tests run on your GPU. The wrong one either fails to start or falls back to slow CPU work.",
    technical: "For NVIDIA, choose a CUDA version your driver supports (a newer driver can run an older CUDA build). Vulkan is a good fallback for AMD and Intel GPUs.",
    related: ["hw.accel.cuda", "hw.accel.vulkan", "hw.accel.metal", "tc.llamacpp"],
  },

  "tc.probe": {
    title: "Capability probe",
    tagline: "The app checks what your installed tools support, so it never offers a missing option.",
    what: "After installing, the app runs each tool's `--help` and records which quant types, flags and choices this exact version supports.",
    why: "Tools change between versions. Probing keeps the interface honest: options the installed version lacks are not shown.",
    technical: "For example, the quant types list comes from `llama-quantize --help`, and Model Builder precisions and execution providers come from its argument parser.",
    related: ["tc.doctor", "tc.llamacpp", "gguf.tool.quantize"],
  },

  "tc.doctor": {
    title: "Doctor",
    tagline: "Checks that every component is installed and working.",
    what: "Runs health checks on uv, Python, each environment, the llama.cpp binaries and the accelerator.",
    why: "The quickest way to find out why a job failed to start, such as a missing environment or a GPU build that doesn't load.",
    related: ["tc.probe", "tc.uv", "tc.accelerator"],
  },

  // ---------------------------------------------------------------- settings
  "settings.workspace": {
    title: "Workspace folder",
    tagline: "Where the app stores intermediates, quantized outputs and reports.",
    what: "The folder used for all job files.",
    why: "Put it on a drive with plenty of free space: a single job can temporarily need several times the final model size.",
    related: ["concept.disk_space", "settings.keep_intermediates"],
  },

  "settings.theme": {
    title: "Theme",
    tagline: "Light, dark, or follow your system setting.",
    what: "Chooses the app's colour scheme.",
    why: "Purely visual; it doesn't affect any results.",
  },

  "settings.concurrency": {
    title: "Concurrent jobs",
    tagline: "How many quantization jobs may run at the same time.",
    what: "The maximum number of jobs the queue runs in parallel.",
    why: "One at a time is safest: conversion, calibration and evaluation are memory- and disk-hungry, and parallel jobs compete for them.",
    related: ["settings.threads", "eval.sequential", "hw.ram"],
  },

  "settings.hf_cache": {
    title: "Hugging Face cache",
    tagline: "Where downloaded source models are kept so they don't need downloading again.",
    what: "The folder huggingface_hub uses for downloaded files.",
    why: "Original models are large. Pointing the cache to a big drive avoids filling your system disk; clearing it frees space.",
    technical: "Defaults to the standard Hugging Face cache location (under `~/.cache/huggingface` unless `HF_HOME` or `HF_HUB_CACHE` is set).",
    related: ["concept.disk_space", "settings.workspace"],
  },

  "settings.keep_intermediates": {
    title: "Keep intermediates",
    tagline: "Keep the full-precision GGUF and imatrix after a job, or delete them to save space.",
    what: "Controls whether temporary files such as the F16/BF16 GGUF and imatrix are kept after a job completes.",
    why: "Keeping them makes it fast to add more quant types later. Deleting them frees a lot of disk space.",
    related: ["concept.disk_space", "gguf.base.auto", "gguf.opt.imatrix"],
  },

  "settings.threads": {
    title: "Thread limit",
    tagline: "Maximum CPU threads jobs may use.",
    what: "Caps the threads used by llama.cpp tools and Python jobs.",
    why: "Use all threads for speed, or leave some free to keep your computer responsive.",
    related: ["hw.cpu_threads", "gguf.opt.threads", "settings.concurrency"],
  },

  "settings.notifications": {
    title: "Notifications",
    tagline: "Get a system notification when a long job finishes or fails.",
    what: "Enables desktop notifications for job completion and errors.",
    why: "Quantizing large models can take a long time; this lets you get on with other things.",
  },

  // ---------------------------------------------------------------- calibration data
  "calib.wikitext2": {
    title: "WikiText-2",
    tagline: "Wikipedia text: a safe, general-purpose default for calibration.",
    what: "Clean English encyclopedic text from the WikiText-2 dataset.",
    why: "A neutral default that works well for general models. Calibrating on the training split keeps the test split, used for perplexity evaluation, unseen.",
    avoidIf: ["Your model is mainly for code or non-English text"],
    related: ["eval.dataset.wikitext2", "concept.calibration", "calib.c4"],
  },

  "calib.pile_val": {
    title: "Pile validation",
    tagline: "A diverse mix of web, books, code and papers; the AWQ authors' default.",
    what: "Samples from the validation split of The Pile, a large mixed-domain English corpus.",
    why: "More varied than Wikipedia, which makes it a good general choice, especially for AWQ.",
    technical: "Commonly loaded from the `mit-han-lab/pile-val-backup` dataset on Hugging Face.",
    related: ["mlx.method.awq", "concept.awq", "calib.c4"],
  },

  "calib.c4": {
    title: "C4",
    tagline: "Cleaned web text, the traditional calibration set for GPTQ.",
    what: "Samples from C4 (Colossal Clean Crawled Corpus), a large filtered English web crawl.",
    why: "Represents everyday web language; a sound default for GPTQ and general models.",
    technical: "Commonly loaded from `allenai/c4` (English subset); only a small number of samples is streamed.",
    related: ["concept.gptq", "calib.pile_val", "calib.wikitext2"],
  },

  "calib.custom_file": {
    title: "Custom text file",
    tagline: "Calibrate with your own text, matching how you will actually use the model.",
    what: "A plain-text file you provide, such as code, chats or documents in your language.",
    why: "Calibration data that resembles real use often gives the best results for that use. Include variety; a tiny or repetitive file can make results worse.",
    goodFor: ["Code models", "Non-English models", "Domain-specific assistants"],
    related: ["concept.calibration", "calib.size", "goal.usecase.multilingual"],
  },

  "calib.hf_dataset": {
    title: "Hugging Face dataset",
    tagline: "Use any text dataset from the Hub for calibration.",
    what: "Pick a dataset id, split and text column; the app streams the samples it needs.",
    why: "An easy way to get domain-specific calibration text without preparing files yourself.",
    technical: "Loaded with the `datasets` library in the core environment. Gated datasets need a token with access.",
    related: ["tc.env.core", "calib.custom_file", "calib.size"],
  },

  "calib.size": {
    title: "Calibration size",
    tagline: "How much calibration text to use: more is steadier but slower.",
    what: "The amount of calibration text, set as a number of samples or chunks multiplied by their length in tokens.",
    why: "Too little gives noisy statistics; beyond a moderate amount the gains are small and runtime keeps growing.",
    technical: "For llama.cpp imatrix, tokens = chunks x context (for example 200 x 512, about 100k tokens). For MLX methods, tokens = samples x sequence length.",
    related: ["gguf.opt.imatrix_chunks", "mlx.opt.num_samples", "concept.calibration"],
  },
};
