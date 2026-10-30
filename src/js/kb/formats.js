// Output formats and how to choose between them.
export default {
  "format.gguf": {
    title: "GGUF (llama.cpp)",
    tagline: "A single-file format for llama.cpp, LM Studio, Ollama and many other local apps.",
    what: "GGUF packs the weights, tokenizer, chat template and model settings into one file (or a few shards). It is produced and read by llama.cpp and the many apps built on it.",
    why: "It is the most portable choice: it runs on Mac, Windows and Linux, on CPU or on NVIDIA, AMD, Intel and Apple GPUs, and offers the widest range of quant types from about 1.5 to 8 bits.",
    meters: { size: 5, quality: 4, speed: 4, effort: 4 },
    goodFor: ["Sharing a model with the widest audience", "LM Studio, Ollama, llama.cpp server", "Partial GPU offload when VRAM is short"],
    avoidIf: ["Your target app only accepts MLX or ONNX"],
    technical: "Pipeline: `convert_hf_to_gguf.py` writes a full-precision GGUF (F16/BF16/F32 or Q8_0), optional `llama-imatrix` collects importance data, then `llama-quantize` produces each variant. Quant types are chosen per tensor, so one file can mix precisions.",
    related: ["format.compare", "gguf.tool.convert", "gguf.tool.quantize", "concept.kquants", "goal.runtime.llamacpp"],
    learnMore: [
      { label: "GGUF on Hugging Face", url: "https://huggingface.co/docs/hub/gguf" },
      { label: "llama.cpp repository", url: "https://github.com/ggml-org/llama.cpp" },
    ],
  },

  "format.mlx": {
    title: "MLX (Apple)",
    tagline: "Apple's native format for fast inference on Apple Silicon Macs.",
    what: "MLX is Apple's machine-learning framework. An MLX model is a folder of safetensors weights plus config and tokenizer files, quantized with mlx-lm.",
    why: "On Apple Silicon it is often the fastest way to run a model and it supports advanced quantization (AWQ, GPTQ, DWQ, mixed recipes). It only runs on Apple Silicon, so it is not for sharing with Windows or Linux users.",
    meters: { size: 4, quality: 4, speed: 5, effort: 4 },
    goodFor: ["Mac-only workflows", "LM Studio's MLX engine and other MLX apps", "Trying DWQ for better low-bit quality"],
    avoidIf: ["You are not on Apple Silicon", "Your audience uses Windows, Linux or NVIDIA GPUs"],
    technical: "Quantized with `mlx_lm.convert -q` (affine integers, 2-8 bits, group size 32/64/128, or MXFP4/NVFP4/MXFP8 modes). Effective bpw for affine = bits + 32/group_size because each group stores an fp16 scale and bias.",
    related: ["format.compare", "mlx.apple_only", "mlx.method.convert", "goal.runtime.mlx_apps"],
    learnMore: [{ label: "mlx-lm repository", url: "https://github.com/ml-explore/mlx-lm" }],
  },

  "format.onnx": {
    title: "ONNX (ONNX Runtime)",
    tagline: "A portable graph format for ONNX Runtime apps on Windows, Linux, mobile and the web.",
    what: "ONNX stores the model as a computation graph plus weights. ONNX Runtime GenAI runs it with an execution provider such as CPU, CUDA, DirectML or WebGPU.",
    why: "Choose it when you are building an app on ONNX Runtime (for example Windows apps or in-browser WebGPU demos). For general local chat, GGUF or MLX are usually simpler.",
    meters: { size: 4, quality: 4, speed: 3, effort: 3 },
    goodFor: ["Apps built on ONNX Runtime GenAI", "Browser inference via WebGPU", "Windows integration"],
    avoidIf: ["You just want to chat locally in LM Studio or Ollama", "The model architecture is not supported by Model Builder"],
    technical: "Engine A, onnxruntime-genai Model Builder, exports an optimised LLM graph and quantizes MatMuls to int4 (MatMulNBits) or int8 in one step. Engine B exports with Hugging Face Optimum and quantizes with `onnxruntime.quantization` (dynamic int8 or weight-only int4). The output is tied to an execution provider chosen at build time.",
    related: ["format.compare", "onnx.engine.builder", "onnx.engine.optimum", "goal.runtime.ort"],
    learnMore: [{ label: "onnxruntime-genai repository", url: "https://github.com/microsoft/onnxruntime-genai" }],
  },

  "format.compare": {
    title: "Choosing a format",
    tagline: "GGUF for portability, MLX for Macs, ONNX for ONNX Runtime apps.",
    what: "The three formats target different runtimes. The 'right' one depends on where the model will run and which app will load it, more than on quality.",
    why: "At similar bits per weight, the formats land in a similar quality range; the bigger differences are which devices and apps can load them and how fast they run there.",
    goodFor: [
      "GGUF: sharing broadly, LM Studio/Ollama/llama.cpp, any OS or GPU",
      "MLX: personal use on an Apple Silicon Mac, maximum Mac speed",
      "ONNX: developers shipping ONNX Runtime apps, WebGPU, Windows",
    ],
    technical: "Rules of thumb: if unsure, start with GGUF Q4_K_M. On a Mac, compare GGUF Q4_K_M with MLX 4-bit (group 64): same ballpark size, often faster in MLX. For ONNX, int4 with block size 32 is the common default. Use the app's evaluation to compare variants on your own prompts.",
    related: ["format.gguf", "format.mlx", "format.onnx", "goal.runtime.any", "goal.recommendation"],
  },
};
