// Hardware: accelerators (backends) and target devices.
export default {
  // ---------------------------------------------------------------- accelerators
  "hw.accel.metal": {
    title: "Metal",
    tagline: "Apple's GPU API: how llama.cpp and MLX use the GPU on Apple Silicon Macs.",
    what: "Metal is Apple's graphics and compute framework. llama.cpp's macOS arm64 builds include a Metal backend, and MLX is built on it.",
    why: "On an Apple Silicon Mac it is the fast path for both GGUF and MLX. Nothing extra needs installing.",
    technical: "Usable GPU memory is capped by macOS's recommended working set (a share of unified memory). The app installs llama.cpp's official macOS arm64 build, which includes Metal.",
    related: ["hw.device.apple_silicon", "concept.unified_memory", "format.mlx"],
  },

  "hw.accel.cuda": {
    title: "CUDA",
    tagline: "NVIDIA's GPU platform; the fastest and best-supported path on NVIDIA cards.",
    what: "CUDA is NVIDIA's GPU computing platform. llama.cpp offers CUDA builds, and ONNX Runtime has a CUDA execution provider.",
    why: "Usually the fastest option on NVIDIA GPUs. The build must match your driver: the app picks a CUDA 12.x or 13.x llama.cpp build based on what your driver supports.",
    technical: "The app downloads official llama.cpp release builds (Windows: CUDA 12.4 or 13.4; Linux: CUDA 12.8 or 13.4). Newer drivers run older CUDA builds, not the other way round.",
    related: ["hw.device.nvidia", "tc.accelerator", "onnx.ep.cuda"],
  },

  "hw.accel.vulkan": {
    title: "Vulkan",
    tagline: "Cross-vendor GPU backend: works on NVIDIA, AMD and Intel GPUs on Windows and Linux.",
    what: "Vulkan is an open GPU API. llama.cpp's Vulkan backend runs on most modern GPUs without vendor-specific toolkits.",
    why: "A good choice for AMD and Intel GPUs, or when CUDA/ROCm are unavailable. Speed is often close to vendor backends, though it varies by GPU and quant type.",
    technical: "Needs a GPU driver with Vulkan support. Available in the official llama.cpp releases for Windows and Linux.",
    related: ["hw.device.amd", "hw.accel.rocm", "tc.accelerator"],
  },

  "hw.accel.rocm": {
    title: "ROCm (HIP)",
    tagline: "AMD's GPU compute platform for Radeon and Instinct GPUs on Linux.",
    what: "ROCm is AMD's counterpart to CUDA. llama.cpp's HIP backend uses it.",
    why: "Can be the fastest option on supported AMD GPUs, but supported GPU models and Linux distributions are limited. Vulkan is the simpler fallback.",
    technical: "The app uses the official llama.cpp ROCm build for Linux. Check AMD's support matrix for your GPU.",
    related: ["hw.device.amd", "hw.accel.vulkan"],
  },

  "hw.accel.cpu": {
    title: "CPU only",
    tagline: "Runs on the processor alone: works everywhere, slower for big models.",
    what: "All computation happens on the CPU using vector instructions (AVX2/AVX-512 on x86, NEON on ARM).",
    why: "Always available. Generation speed is limited by memory bandwidth, so smaller quants (4-bit and below) help a lot.",
    technical: "llama.cpp picks optimised kernels for your CPU at run time. Q4_0 and IQ4_NL may be repacked on supported CPUs for faster matrix multiplication.",
    related: ["hw.device.cpu_only", "hw.cpu_threads", "gguf.qtype.Q4_0"],
  },

  "hw.accel.sycl": {
    title: "SYCL",
    tagline: "Intel's oneAPI-based GPU backend for Intel Arc and data-centre GPUs.",
    what: "SYCL is a programming model used by llama.cpp's backend for Intel GPUs, built on Intel oneAPI.",
    why: "Targets Intel GPUs specifically. Vulkan is often easier to set up and may be comparable in speed.",
    technical: "Requires Intel's oneAPI runtime. The app's current llama.cpp download list has no SYCL build, so Intel GPUs use the Vulkan build instead.",
    related: ["hw.accel.vulkan", "hw.accel.openvino"],
  },

  "hw.accel.openvino": {
    title: "OpenVINO",
    tagline: "Intel's inference toolkit for Intel CPUs, integrated GPUs and NPUs.",
    what: "OpenVINO optimises models for Intel hardware. It is most commonly used through ONNX Runtime's OpenVINO execution provider.",
    why: "Relevant if you deploy ONNX models to Intel laptops and want to use the integrated GPU or NPU.",
    technical: "Requires an OpenVINO-enabled ONNX Runtime build on the target machine.",
    related: ["format.onnx", "hw.accel.sycl", "hw.device.edge"],
  },

  // ---------------------------------------------------------------- devices
  "hw.device.apple_silicon": {
    title: "Apple Silicon Mac",
    tagline: "M-series Macs: one shared memory pool, fast GPU via Metal, and MLX support.",
    what: "Macs with M1 or later chips. CPU and GPU share unified memory.",
    why: "Both GGUF (llama.cpp, LM Studio, Ollama) and MLX run well. The app budgets about 70-75% of RAM for the GPU by default.",
    technical: "Memory bandwidth varies a lot between base, Pro, Max and Ultra chips, and generation speed scales with it.",
    related: ["concept.unified_memory", "hw.accel.metal", "mlx.apple_only"],
  },

  "hw.device.nvidia": {
    title: "NVIDIA GPU",
    tagline: "GeForce, RTX or data-centre cards: the model should fit in the card's VRAM.",
    what: "A PC or server with an NVIDIA graphics card.",
    why: "Fastest when the model and KV cache fit entirely in VRAM. llama.cpp can offload part of the model to system RAM if it does not, at reduced speed.",
    technical: "Use CUDA builds. Budget VRAM minus about 0.5-1.5 GB for the driver, display and compute buffers (approximate).",
    related: ["concept.vram", "hw.accel.cuda", "goal.memory"],
  },

  "hw.device.amd": {
    title: "AMD GPU",
    tagline: "Radeon or Instinct cards via Vulkan or ROCm.",
    what: "A PC or server with an AMD graphics card.",
    why: "GGUF runs well through Vulkan (Windows/Linux) or ROCm (Linux). ONNX can use DirectML on Windows where available.",
    related: ["hw.accel.vulkan", "hw.accel.rocm", "concept.vram"],
  },

  "hw.device.cpu_only": {
    title: "CPU only (no GPU)",
    tagline: "A laptop, desktop or server without a usable GPU.",
    what: "The model will run on the processor and system RAM.",
    why: "Smaller quants matter most here: generation speed is limited by memory bandwidth, so it rises roughly in proportion as the file shrinks (a 4-bit model is much faster than 8-bit).",
    goodFor: ["Q4_K_M, Q4_0 or IQ4_XS GGUF", "Small models (1-8B)"],
    related: ["hw.accel.cpu", "hw.ram", "hw.cpu_threads"],
  },

  "hw.device.edge": {
    title: "Phone / edge device",
    tagline: "Phones, single-board computers and small devices with little memory.",
    what: "Low-power ARM devices such as Android phones or Raspberry Pi boards.",
    why: "Memory and bandwidth are scarce, so use small models (about 0.5-4B) at 4-bit. Q4_0 is often fastest on ARM CPUs thanks to llama.cpp's repacking.",
    goodFor: ["Q4_0 or IQ4_NL GGUF", "int4 ONNX for ONNX Runtime mobile apps"],
    related: ["gguf.qtype.Q4_0", "hw.device.cpu_only", "format.onnx"],
  },

  "hw.device.browser": {
    title: "Web browser",
    tagline: "In-page inference with WebGPU; small models only.",
    what: "Running the model inside a web page using the browser's GPU access (WebGPU).",
    why: "No install for the user, but downloads, memory and per-tab limits are tight. Use small models with int4 ONNX.",
    goodFor: ["Demos and privacy-friendly in-page assistants"],
    related: ["onnx.ep.webgpu", "goal.runtime.web"],
  },

  "hw.ram": {
    title: "System RAM",
    tagline: "Your computer's main memory, used by CPU inference and by the quantization jobs themselves.",
    what: "The total memory of the machine. On Apple Silicon it is also the GPU's memory.",
    why: "Converting and calibrating need memory too: conversion is mostly streamed, but imatrix, AWQ, GPTQ and DWQ need to run the full-precision model. Jobs that do not fit will swap heavily or fail.",
    technical: "As a rough guide, calibration methods need memory for the full-precision weights (about 2 bytes x parameters) plus working buffers; DWQ needs room for both teacher and student.",
    related: ["concept.memory_budget", "concept.unified_memory", "gguf.opt.max_buffer_size"],
  },

  "hw.cpu_threads": {
    title: "CPU threads",
    tagline: "How many CPU threads quantization and CPU inference may use.",
    what: "The number of parallel threads used by llama.cpp tools and Python jobs.",
    why: "More threads speed up quantization. For CPU text generation, performance often peaks at the number of performance cores; more threads can even slow it down.",
    technical: "llama-quantize takes a thread count as its last argument; llama.cpp runtimes use `-t`.",
    related: ["gguf.opt.threads", "settings.threads", "settings.concurrency"],
  },
};
