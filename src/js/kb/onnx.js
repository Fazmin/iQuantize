// ONNX: Engine A (onnxruntime-genai Model Builder) and Engine B (Optimum export + onnxruntime.quantization).
const BUILDER_README = { label: "Model Builder README", url: "https://github.com/microsoft/onnxruntime-genai/tree/main/src/python/py/models" };
const ORT_QUANT_DOCS = { label: "ONNX Runtime quantization docs", url: "https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html" };

export default {
  // ---------------------------------------------------------------- engines
  "onnx.engine.builder": {
    title: "Model Builder (Engine A)",
    tagline: "onnxruntime-genai's one-step exporter: optimised LLM graph plus int4/int8 quantization.",
    what: "Model Builder reads a Hugging Face model (or a GGUF) and writes an ONNX model, tuned for a chosen execution provider, ready for ONNX Runtime GenAI, including its genai_config.json and tokenizer files.",
    why: "It is the recommended path for LLMs: fast, memory-efficient, and the output runs directly in ONNX Runtime GenAI apps. It supports only the architectures it knows.",
    meters: { quality: 4, speed: 4, effort: 4 },
    goodFor: ["Llama, Mistral, Phi, Qwen, Gemma, gpt-oss, Granite, SmolLM3, DeepSeek, ChatGLM, Nemotron, ERNIE 4.5, LFM2 and more"],
    avoidIf: ["The architecture is not supported (use Engine B instead)"],
    technical: "`python -m onnxruntime_genai.models.builder -m MODEL_ID -o OUT -p int4 -e cpu --extra_options block_size=32 accuracy_level=4`. Use `-i` for a local folder or a GGUF file. The app installs onnxruntime-genai 0.18.x in its `onnx` environment.",
    related: ["onnx.engine.optimum", "onnx.precision.int4", "tc.env.onnx", "format.onnx"],
    learnMore: [BUILDER_README],
  },

  "onnx.engine.optimum": {
    title: "Optimum + ORT quantization (Engine B)",
    tagline: "Generic export with Hugging Face Optimum, then quantization with onnxruntime.quantization.",
    what: "Exports the model to ONNX with Optimum, then applies either dynamic int8 quantization or weight-only int4 (RTN, HQQ or GPTQ).",
    why: "Covers models Model Builder does not support. The resulting graphs are less specialised for LLM generation, so they are usually slower and may not plug straight into ONNX Runtime GenAI.",
    meters: { quality: 4, speed: 3, effort: 3 },
    technical: "Export: `optimum-cli export onnx --model MODEL OUT/`. Quantize: `onnxruntime.quantization.quantize_dynamic(...)` for int8, or `MatMulNBitsQuantizer` (from `onnxruntime.quantization.matmul_nbits_quantizer`) for int4.",
    related: ["onnx.engine.builder", "onnx.b.int8_dynamic", "onnx.b.int4_weight"],
    learnMore: [ORT_QUANT_DOCS],
  },

  // ---------------------------------------------------------------- precision (Model Builder -p)
  "onnx.precision.int4": {
    title: "int4",
    tagline: "4-bit weights for MatMuls (MatMulNBits): the usual choice for running LLMs in ONNX.",
    what: "Weights of the large matrix multiplications are stored as 4-bit integers in blocks, each block with its own scale (and zero point if asymmetric).",
    why: "About a quarter of the 16-bit size for the quantized layers, with good quality. The default choice for CPU, DirectML and WebGPU deployments.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    technical: "`-p int4`. Effective bpw for block size 32 with an fp16 scale is about 4.5 (more with a zero point). Tune with `block_size`, `accuracy_level`, `is_symmetric` and `algo_config`.",
    related: ["onnx.opt.block_size", "onnx.opt.accuracy_level", "onnx.algo.default", "concept.weight_only"],
    learnMore: [BUILDER_README],
  },

  "onnx.precision.int8": {
    title: "int8",
    tagline: "8-bit weights: about half the 16-bit size, close to original quality.",
    what: "Quantizes the MatMul weights to 8 bits.",
    why: "A safer, larger option than int4 when quality matters more than size.",
    meters: { size: 3, quality: 5, speed: 3, effort: 5 },
    technical: "`-p int8`. Produces the same MatMulNBits operators as int4 but with 8-bit weights, and shares the same options (block_size, is_symmetric, accuracy_level, algo_config).",
    related: ["onnx.precision.int4", "onnx.opt.matmul_mixed_precision"],
  },

  "onnx.precision.fp16": {
    title: "fp16",
    tagline: "Unquantized half precision: full quality, typical for CUDA and WebGPU.",
    what: "Exports the model in 16-bit floats without weight quantization.",
    why: "Best quality and a good baseline, but large. Fast on GPUs; on CPUs fp16 is often not the fastest path.",
    meters: { size: 2, quality: 5, speed: 3, effort: 5 },
    technical: "`-p fp16`.",
    related: ["concept.fp16", "onnx.ep.cuda", "eval.reference"],
  },

  "onnx.precision.bf16": {
    title: "bf16",
    tagline: "Unquantized bfloat16 export; matches most original models exactly.",
    what: "Exports the model in bfloat16.",
    why: "Exact for BF16 originals. Support depends on the execution provider and hardware.",
    meters: { size: 2, quality: 5, speed: 3, effort: 5 },
    technical: "`-p bf16`. Check that your target execution provider supports bf16 kernels.",
    related: ["concept.bf16", "onnx.precision.fp16"],
  },

  "onnx.precision.fp32": {
    title: "fp32",
    tagline: "Full 32-bit export: largest and slowest; mainly for debugging.",
    what: "Exports the model in 32-bit floats.",
    why: "Rarely useful for LLM inference. Whether `-p fp32` is accepted depends on the installed onnxruntime-genai version; the app only shows it if the probe finds it.",
    meters: { size: 1, quality: 5, speed: 2, effort: 5 },
    technical: "`-p fp32`. Separately, WebGPU builds can force FP32 model inputs/outputs for GPUs without FP16 support.",
    related: ["concept.fp32", "tc.probe"],
  },

  // ---------------------------------------------------------------- execution providers
  "onnx.ep.cpu": {
    title: "CPU",
    tagline: "Runs anywhere; best paired with int4 and accuracy level 4.",
    what: "Builds the model for ONNX Runtime's default CPU execution provider.",
    why: "Universal and easy to deploy. Generation speed depends on memory bandwidth and core count.",
    technical: "`-e cpu`. int8 activation compute (`accuracy_level=4`) is usually fastest on modern CPUs.",
    related: ["onnx.opt.accuracy_level", "hw.device.cpu_only"],
  },

  "onnx.ep.cuda": {
    title: "CUDA",
    tagline: "For NVIDIA GPUs with the CUDA build of ONNX Runtime GenAI.",
    what: "Builds the model for the CUDA execution provider.",
    why: "Fast on NVIDIA GPUs. The person running it needs the CUDA-enabled ONNX Runtime GenAI package and compatible drivers.",
    technical: "`-e cuda`.",
    related: ["hw.device.nvidia", "hw.accel.cuda"],
  },

  "onnx.ep.webgpu": {
    title: "WebGPU",
    tagline: "For running in browsers (and native WebGPU apps) on any modern GPU.",
    what: "Builds the model for the WebGPU execution provider.",
    why: "Enables in-browser inference without installs. Keep the model small: browsers limit memory and download sizes.",
    technical: "`-e webgpu`. Typically paired with int4. ONNX Runtime Web (also used by Transformers.js) can load the result.",
    related: ["hw.device.browser", "goal.runtime.web"],
  },

  "onnx.ep.dml": {
    title: "DirectML",
    tagline: "For Windows GPUs of any vendor via DirectX 12; available in some builds.",
    what: "Builds the model for the DirectML execution provider.",
    why: "Covers NVIDIA, AMD and Intel GPUs on Windows. Only offered if the installed Model Builder lists it.",
    technical: "`-e dml`, when listed by the installed Model Builder (current versions list cpu, cuda, dml, webgpu and NvTensorRtRtx).",
    related: ["hw.device.amd", "goal.runtime.ort", "tc.probe"],
  },

  // ---------------------------------------------------------------- extra options
  "onnx.opt.block_size": {
    title: "Block size",
    tagline: "Weights per int4 block sharing one scale; 32 is the default and most accurate common choice.",
    what: "The number of consecutive weights that share a scale (and zero point) in int4 quantization.",
    why: "Smaller blocks are more accurate but slightly larger; larger blocks save space at some quality cost.",
    meters: { size: 3, quality: 4 },
    technical: "`--extra_options block_size=32` (accepted: 16, 32, 64, 128, 256; default 32). Older versions used the key `int4_block_size`; whether that old name still works depends on the version.",
    related: ["concept.group_size", "onnx.precision.int4"],
  },

  "onnx.opt.accuracy_level": {
    title: "Accuracy level",
    tagline: "Minimum precision for int4 MatMul math: 1=fp32, 2=fp16, 3=bf16, 4=int8.",
    what: "Controls the precision of the activation side when multiplying by int4 weights (the MatMulNBits operator).",
    why: "Level 4 (int8) is usually fastest on CPUs with a small accuracy cost; levels 1-3 keep activations in floating point for maximum accuracy.",
    technical: "`--extra_options accuracy_level=4`. Level 4 means activations are quantized to int8 and the int4 weights upcast to int8 for the computation. Default is 4 for the CPU execution provider and 0 (unset) for others, per Model Builder's help text. Older versions used `int4_accuracy_level`.",
    related: ["onnx.precision.int4", "onnx.ep.cpu", "concept.weight_only"],
  },

  "onnx.opt.algo_config": {
    title: "Quantization algorithm",
    tagline: "How int4 values are chosen: default, rtn or k_quant.",
    what: "Selects the algorithm used to compute int4 weights and scales.",
    why: "k_quant searches for better scales (similar to llama.cpp K-quants) at a small time cost; default and rtn are the fastest.",
    technical: "`--extra_options algo_config=k_quant` (default `default`). Legacy compound values are aliases: `rtn_last` = rtn + last_matmul:int8; `k_quant_last` = k_quant + last_matmul:int8; `k_quant_mixed` = k_quant + last_matmul:int8,mixed_layers:int8; `k_quant_linear` = k_quant + last_matmul:int8,linear_attn:int8. Older versions used `int4_algo_config`.",
    related: ["onnx.algo.default", "onnx.algo.rtn", "onnx.algo.k_quant", "onnx.opt.matmul_mixed_precision"],
  },

  "onnx.opt.is_symmetric": {
    title: "Symmetric int4",
    tagline: "On: signed int4 with no zero point (default). Off: uint4 with a zero point per block.",
    what: "Chooses between symmetric (centred on zero) and asymmetric quantization for int4 blocks.",
    why: "Asymmetric can be a little more accurate when block values are not centred on zero, at a small size cost.",
    technical: "`--extra_options is_symmetric=false` gives uint4 with explicit zero points. Default is true.",
    related: ["concept.symmetric", "concept.scale_zero_point"],
  },

  "onnx.opt.exclude_embeds": {
    title: "Exclude embedding layer",
    tagline: "Removes the embedding layer from the graph; the model then takes embeddings, not token IDs.",
    what: "Builds the ONNX model without its token embedding layer, so its input is `inputs_embeds` instead of `input_ids`.",
    why: "Only for pipelines that compute embeddings elsewhere, such as vision-language models. It does not mean 'skip quantizing the embeddings'; a normal chat app cannot use the result on its own.",
    avoidIf: ["You want a standalone chat model"],
    technical: "`--extra_options exclude_embeds=true`. To keep the embeddings at full precision instead, leave this off: embeddings (`Gather`) are only quantized if `Gather` is added to `op_types_to_quantize` or `shared_embeddings` is on.",
    related: ["concept.embeddings", "onnx.opt.exclude_lm_head"],
    learnMore: [BUILDER_README],
  },

  "onnx.opt.exclude_lm_head": {
    title: "Exclude LM head",
    tagline: "Removes the output head; the model returns hidden states instead of token scores.",
    what: "Builds the ONNX model without the language-modelling head, so its output is hidden states instead of logits.",
    why: "For embedding extraction or custom pipelines. It does not keep the head at higher precision; a model without a head cannot generate text by itself.",
    avoidIf: ["You want a model that generates text"],
    technical: "`--extra_options exclude_lm_head=true`. To keep the head at higher precision instead, use `matmul_mixed_precision=last_matmul:int8`, or `nodes_to_exclude=/lm_head/MatMul` to leave it unquantized. Cannot be combined with `shared_embeddings`.",
    related: ["concept.lm_head", "onnx.opt.matmul_mixed_precision", "onnx.opt.exclude_embeds"],
    learnMore: [BUILDER_README],
  },

  "onnx.opt.shared_embeddings": {
    title: "Shared embeddings",
    tagline: "Store one weight matrix for both the embedding layer and the output head.",
    what: "For models whose embeddings and output head are tied, keeps a single shared copy in the ONNX model.",
    why: "Saves a lot of space in small models with large vocabularies. Requires the original model to have tied embeddings.",
    technical: "`--extra_options shared_embeddings=true`. Requires `tie_word_embeddings: true` in the source config (otherwise the build fails with an error). Quantized weights are shared via GatherBlockQuantized. Enabling it also quantizes the shared table (adds `Gather` to the quantized op types). Recent README versions say it is switched on automatically for tied models, while the help text says the default is false, so set it explicitly if it matters.",
    related: ["concept.tied_embeddings", "concept.embeddings", "concept.lm_head"],
  },

  "onnx.opt.matmul_mixed_precision": {
    title: "MatMul mixed precision",
    tagline: "Keep chosen MatMuls at int8 while the rest are int4.",
    what: "A list of selector:type pairs that assigns int4 or int8 to groups of MatMuls.",
    why: "Raising the most sensitive layers to int8 recovers quality for a modest size increase, much like GGUF's _M mixes.",
    technical: "A comma-separated list of `selector:type` pairs, e.g. `matmul_mixed_precision=last_matmul:int8,mixed_layers:int8`. Selectors: `last_matmul` (the final MatMul, usually `/lm_head/MatMul`), `mixed_layers` (llama.cpp's mixed strategy: qkv/v and down projections in the first and last eighth of layers plus every third layer), `linear_attn` (linear-attention projections and their MLPs in hybrid models). Types: int4, int8. Works with any `algo_config`.",
    related: ["concept.mixed_precision", "onnx.opt.algo_config", "concept.lm_head"],
    learnMore: [BUILDER_README],
  },

  "onnx.opt.kv_cache_quant": {
    title: "KV cache quantization",
    tagline: "Store the attention cache in lower precision to save memory at long contexts (CPU/CUDA).",
    what: "Quantizes the keys and values stored during generation.",
    why: "Reduces memory for long contexts, with some quality risk. Only available for the CPU and CUDA execution providers, and the static schemes need a calibration step first.",
    technical: "`--extra_options kv_cache_quant_scheme=...`: `none` (default), `int8_per_tensor`/`int8_per_channel`, `int4_per_tensor`/`int4_per_channel`, `fp8_per_tensor`/`fp8_per_channel`, or `int4_per_token`/`int8_per_token` (CUDA paged attention). The per-tensor and per-channel schemes require `kv_cache_scale_file` with calibrated per-layer scales. Exact availability depends on the installed version.",
    related: ["concept.kv_cache", "goal.context", "tc.probe"],
  },

  // ---------------------------------------------------------------- algorithms (Model Builder)
  "onnx.algo.default": {
    title: "default",
    tagline: "Model Builder's standard fast, data-free int4 quantizer.",
    what: "Lets ONNX Runtime's quantizer use its default algorithm, which is round-to-nearest.",
    why: "Fast and reliable; a good starting point. Results are essentially RTN; only the node naming differs from `rtn`.",
    meters: { quality: 3, effort: 5 },
    technical: "`algo_config=default`.",
    related: ["onnx.algo.k_quant", "onnx.algo.rtn"],
  },

  "onnx.algo.rtn": {
    title: "rtn",
    tagline: "Plain round-to-nearest int4: fastest, simplest.",
    what: "Rounds each weight to the nearest level in its block.",
    why: "Predictable and fast; usually slightly behind k_quant at the same size.",
    meters: { quality: 3, effort: 5 },
    technical: "`algo_config=rtn`.",
    related: ["concept.rtn", "onnx.algo.k_quant"],
  },

  "onnx.algo.k_quant": {
    title: "k_quant",
    tagline: "Searches for better block scales, inspired by llama.cpp K-quants.",
    what: "Tries candidate scales per block and keeps the ones with the lowest error.",
    why: "Often more accurate than default or rtn for little extra time, and still needs no calibration data.",
    meters: { quality: 4, effort: 4 },
    technical: "`algo_config=k_quant`. Legacy `k_quant_mixed` (adds int8 for some layers) and `k_quant_last` (int8 last MatMul) are still accepted.",
    related: ["concept.kquants", "onnx.opt.matmul_mixed_precision"],
  },

  // ---------------------------------------------------------------- Engine B options
  "onnx.b.int8_dynamic": {
    title: "Dynamic int8",
    tagline: "Weights stored as int8; activations quantized on the fly at run time.",
    what: "Quantizes weights to 8 bits ahead of time and computes activation scales during inference.",
    why: "Simple and needs no calibration data. Good on CPUs, but quantizing activations can hurt LLMs more than weight-only schemes.",
    meters: { size: 3, quality: 3, speed: 3, effort: 5 },
    technical: "`onnxruntime.quantization.quantize_dynamic(model_in, model_out, weight_type=QuantType.QInt8, per_channel=..., reduce_range=...)`.",
    related: ["onnx.b.per_channel", "onnx.b.reduce_range", "onnx.b.qoperator", "concept.weight_only"],
    learnMore: [ORT_QUANT_DOCS],
  },

  "onnx.b.int4_weight": {
    title: "Weight-only int4",
    tagline: "4-bit MatMul weights via MatMulNBitsQuantizer; activations stay in floating point.",
    what: "Replaces MatMul weights with block-quantized 4-bit weights.",
    why: "The best size/quality trade-off in Engine B for LLMs. Choose RTN, HQQ or GPTQ as the algorithm.",
    meters: { size: 4, quality: 4, speed: 4, effort: 4 },
    technical: "`MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True, algo_config=...)` from `onnxruntime.quantization.matmul_nbits_quantizer`.",
    related: ["onnx.b.int4_rtn", "onnx.b.int4_hqq", "onnx.b.int4_gptq"],
    learnMore: [ORT_QUANT_DOCS],
  },

  "onnx.b.per_channel": {
    title: "Per-channel",
    tagline: "One scale per output channel instead of one per tensor: more accurate int8.",
    what: "Gives each output channel of a weight matrix its own quantization scale.",
    why: "Usually improves int8 accuracy noticeably for little cost.",
    technical: "`quantize_dynamic(..., per_channel=True)`.",
    related: ["onnx.b.int8_dynamic", "concept.group_size"],
  },

  "onnx.b.reduce_range": {
    title: "Reduce range",
    tagline: "Quantize weights to 7 bits to avoid overflow on CPUs without VNNI instructions.",
    what: "Uses a 7-bit range for weights instead of the full 8 bits.",
    why: "Can improve accuracy on older x86 CPUs without VNNI, especially with per-channel. Unnecessary on modern CPUs.",
    technical: "`quantize_dynamic(..., reduce_range=True)`.",
    related: ["onnx.b.int8_dynamic", "onnx.b.per_channel"],
  },

  "onnx.b.qdq": {
    title: "QDQ format",
    tagline: "Quantization shown as explicit Quantize/Dequantize nodes around normal ops.",
    what: "Represents quantization with QuantizeLinear/DequantizeLinear pairs that runtimes fuse into fast kernels.",
    why: "Preferred by many hardware execution providers (for example TensorRT and NPU backends) and by static quantization.",
    technical: "`QuantFormat.QDQ`. MatMulNBitsQuantizer can also emit blocked DequantizeLinear + MatMul in QDQ form instead of MatMulNBits.",
    related: ["onnx.b.qoperator", "onnx.engine.optimum"],
  },

  "onnx.b.qoperator": {
    title: "QOperator format",
    tagline: "Quantization baked into dedicated integer operators such as MatMulInteger or MatMulNBits.",
    what: "Uses special quantized operators instead of Q/DQ node pairs.",
    why: "Runs efficiently on ONNX Runtime's CPU provider. Dynamic quantization produces operator-style graphs.",
    technical: "`QuantFormat.QOperator`.",
    related: ["onnx.b.qdq", "onnx.b.int8_dynamic"],
  },

  "onnx.b.int4_rtn": {
    title: "int4 RTN",
    tagline: "Round-to-nearest int4: fast, data-free.",
    what: "Engine B int4 using simple per-block rounding.",
    why: "Quickest option; quality is fine for many models but trails HQQ and GPTQ.",
    meters: { quality: 3, effort: 5 },
    technical: "`RTNWeightOnlyQuantConfig`.",
    related: ["concept.rtn", "onnx.b.int4_hqq"],
  },

  "onnx.b.int4_hqq": {
    title: "int4 HQQ",
    tagline: "Optimised scales and zero points without calibration data.",
    what: "Engine B int4 using Half-Quadratic Quantization.",
    why: "Usually better than RTN, still fast and needs no calibration text.",
    meters: { quality: 4, effort: 4 },
    technical: "`HQQWeightOnlyQuantConfig` (asymmetric, block-wise).",
    related: ["concept.hqq", "onnx.b.int4_rtn", "onnx.b.int4_gptq"],
  },

  "onnx.b.int4_gptq": {
    title: "int4 GPTQ",
    tagline: "Calibration-based int4 with error compensation; most accurate, slowest.",
    what: "Engine B int4 using GPTQ with a calibration data reader.",
    why: "Often the most accurate int4 in Engine B; needs calibration data, time and memory.",
    meters: { quality: 4, effort: 2 },
    technical: "`GPTQWeightOnlyQuantConfig(calibration_data_reader=...)`.",
    related: ["concept.gptq", "concept.calibration", "onnx.b.int4_hqq"],
  },
};
