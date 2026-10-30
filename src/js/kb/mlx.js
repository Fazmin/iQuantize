// MLX (Apple mlx-lm) quantization options.
// Affine overhead: each group stores an fp16 scale and fp16 bias, so effective bpw = bits + 32 / group_size.
const MLX_LM = { label: "mlx-lm repository", url: "https://github.com/ml-explore/mlx-lm" };

export default {
  // ---------------------------------------------------------------- bits
  "mlx.bits.2": {
    title: "2-bit",
    tagline: "Smallest MLX setting (about 2.5 bpw at group 64); heavy quality loss.",
    what: "Stores each weight as a 2-bit integer with a per-group scale and bias.",
    why: "Plain 2-bit rounding badly damages most models. If you need this size, use a mixed recipe (mixed_2_6) or DWQ and check results carefully.",
    meters: { size: 5, quality: 1, speed: 5, effort: 5 },
    avoidIf: ["Models under about 30B", "Code, math or factual tasks"],
    technical: "Effective bpw = 2 + 32/group_size: 3.0 at group 32, 2.5 at 64, 2.25 at 128.",
    related: ["mlx.recipe.mixed_2_6", "mlx.method.dwq", "mlx.bits.3"],
  },

  "mlx.bits.3": {
    title: "3-bit",
    tagline: "About 3.5 bpw at group 64: small, with noticeable loss; pairs well with DWQ or mixed recipes.",
    what: "Stores each weight as a 3-bit integer with a per-group scale and bias.",
    why: "Lets larger models fit, but plain 3-bit rounding loses clearly more than 4-bit. Mixed recipes (mixed_3_4, mixed_3_6) or DWQ recover much of the gap.",
    meters: { size: 4, quality: 2, speed: 4, effort: 5 },
    technical: "Effective bpw = 3 + 32/group_size: 4.0 at group 32, 3.5 at 64, 3.25 at 128.",
    related: ["mlx.recipe.mixed_3_6", "mlx.method.dwq", "mlx.bits.4"],
  },

  "mlx.bits.4": {
    title: "4-bit",
    tagline: "The standard MLX choice (about 4.5 bpw at group 64): small, fast, good quality.",
    what: "Stores each weight as a 4-bit integer with a per-group scale and bias. This is mlx-lm's default.",
    why: "The best all-round trade-off and the most common MLX quant on Hugging Face. Similar in size to GGUF Q4_K_M.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    goodFor: ["A first MLX quant for any model", "Everyday chat and RAG"],
    technical: "Effective bpw = 4 + 32/group_size: 5.0 at group 32, 4.5 at 64, 4.25 at 128. `mlx_lm.convert --hf-path MODEL -q --q-bits 4 --q-group-size 64`.",
    related: ["mlx.group_size.64", "mlx.recipe.mixed_4_6", "gguf.qtype.Q4_K_M"],
    learnMore: [MLX_LM],
  },

  "mlx.bits.5": {
    title: "5-bit",
    tagline: "About 5.5 bpw at group 64: a quality step up from 4-bit.",
    what: "Stores each weight as a 5-bit integer with a per-group scale and bias.",
    why: "Noticeably closer to the original than 4-bit for about 22% more size. A good fit for small models and precision-sensitive tasks.",
    meters: { size: 3, quality: 4, speed: 4, effort: 5 },
    technical: "Effective bpw = 5 + 32/group_size: 6.0 at group 32, 5.5 at 64, 5.25 at 128.",
    related: ["mlx.bits.4", "mlx.bits.6"],
  },

  "mlx.bits.6": {
    title: "6-bit",
    tagline: "About 6.5 bpw at group 64: near-lossless for most models.",
    what: "Stores each weight as a 6-bit integer with a per-group scale and bias.",
    why: "Hard to distinguish from the original in practice, still much smaller than 16-bit.",
    meters: { size: 3, quality: 5, speed: 3, effort: 5 },
    technical: "Effective bpw = 6 + 32/group_size: 7.0 at group 32, 6.5 at 64, 6.25 at 128.",
    related: ["mlx.bits.8", "mlx.bits.5"],
  },

  "mlx.bits.8": {
    title: "8-bit",
    tagline: "About 8.5 bpw at group 64: practically identical to the original, half the 16-bit size.",
    what: "Stores each weight as an 8-bit integer with a per-group scale and bias.",
    why: "The safe, high-quality option and a good baseline for comparisons.",
    meters: { size: 2, quality: 5, speed: 3, effort: 5 },
    technical: "Effective bpw = 8 + 32/group_size: 9.0 at group 32, 8.5 at 64, 8.25 at 128. For an 8-bit float alternative see MXFP8.",
    related: ["mlx.mode.mxfp8", "eval.reference", "mlx.bits.6"],
  },

  // ---------------------------------------------------------------- group size
  "mlx.group_size.32": {
    title: "Group size 32",
    tagline: "Finer groups: best accuracy, but adds about 1 bit per weight of overhead.",
    what: "Every 32 weights share one scale and bias.",
    why: "Helps most at 2-4 bits, where each group's range matters a lot. Costs about 0.5 bpw more than group 64.",
    meters: { size: 3, quality: 5, speed: 4, effort: 5 },
    technical: "Overhead = 32 bits / 32 weights = 1.0 bpw (4-bit becomes about 5.0 bpw).",
    related: ["mlx.group_size.64", "concept.group_size"],
  },

  "mlx.group_size.64": {
    title: "Group size 64",
    tagline: "The default: a good balance of accuracy and overhead (+0.5 bpw).",
    what: "Every 64 weights share one scale and bias.",
    why: "The setting most published MLX models use. Change it only for a specific reason.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    technical: "Overhead = 32 / 64 = 0.5 bpw (4-bit becomes about 4.5 bpw). `--q-group-size 64`.",
    related: ["mlx.group_size.32", "mlx.group_size.128", "concept.group_size"],
  },

  "mlx.group_size.128": {
    title: "Group size 128",
    tagline: "Coarser groups: smallest overhead (+0.25 bpw) but slightly lower accuracy.",
    what: "Every 128 weights share one scale and bias.",
    why: "Saves about 0.25 bpw versus group 64. Fine at 6-8 bits; at 2-4 bits the quality cost is more noticeable.",
    meters: { size: 4, quality: 3, speed: 4, effort: 5 },
    technical: "Overhead = 32 / 128 = 0.25 bpw (4-bit becomes about 4.25 bpw).",
    related: ["mlx.group_size.64", "concept.group_size"],
  },

  // ---------------------------------------------------------------- modes
  "mlx.mode.affine": {
    title: "Affine (integer)",
    tagline: "Default MLX mode: integers with a per-group scale and bias. Supports 2-8 bits.",
    what: "Weights become small unsigned integers; each group stores a scale and a bias so w is approximately scale x q + bias.",
    why: "The most flexible and widely supported MLX mode, and the only one that works with mixed recipes and the advanced methods.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    technical: "`--q-mode affine` (default). Effective bpw = bits + 32/group_size.",
    related: ["concept.scale_zero_point", "mlx.recipe.mixed_4_6", "mlx.mode.mxfp4"],
  },

  "mlx.mode.mxfp4": {
    title: "MXFP4",
    tagline: "4-bit floats with a shared power-of-two scale per 32 values (about 4.25 bpw).",
    what: "Uses the OCP microscaling FP4 format: E2M1 values with one 8-bit (E8M0) scale per block of 32.",
    why: "Slightly smaller than affine 4-bit at group 64, and a natural fit for models released in MXFP4 (such as gpt-oss). Accuracy is often a little below affine 4-bit for ordinary models.",
    meters: { size: 4, quality: 3, speed: 4, effort: 5 },
    technical: "`--q-mode mxfp4`. mlx-lm uses the format's own settings by default (4 bits, group 32). Mixed recipes are affine-only, so they are not available in this mode.",
    related: ["concept.mxfp4", "mlx.mode.nvfp4", "mlx.mode.affine"],
  },

  "mlx.mode.nvfp4": {
    title: "NVFP4",
    tagline: "4-bit floats with an FP8 scale per 16 values (about 4.5 bpw).",
    what: "Uses NVIDIA's FP4 format: E2M1 values with a finer FP8 (E4M3) scale for every 16 values.",
    why: "Smaller blocks and finer scales usually make it more accurate than MXFP4, at about the same size as affine 4-bit/group 64.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    technical: "`--q-mode nvfp4`. mlx-lm uses the format's own settings by default (4 bits, group 16).",
    related: ["concept.nvfp4", "mlx.mode.mxfp4"],
  },

  "mlx.mode.mxfp8": {
    title: "MXFP8",
    tagline: "8-bit floats with a shared scale per 32 values (about 8.25 bpw).",
    what: "Uses the OCP microscaling FP8 format: E4M3 values with one 8-bit scale per block of 32.",
    why: "A near-lossless 8-bit option, slightly smaller than affine 8-bit at group 64.",
    meters: { size: 2, quality: 5, speed: 3, effort: 5 },
    technical: "`--q-mode mxfp8`. mlx-lm uses the format's own settings by default (8 bits, group 32).",
    related: ["concept.fp8", "mlx.bits.8"],
  },

  // ---------------------------------------------------------------- mixed recipes
  "mlx.recipe.none": {
    title: "No recipe (uniform)",
    tagline: "Every quantized layer uses the same bit-width and group size.",
    what: "All weight matrices are quantized identically.",
    why: "Simple and predictable. At 4 bits and above this is usually fine; at 2-3 bits a mixed recipe often helps.",
    meters: { size: 4, quality: 3, effort: 5 },
    related: ["mlx.recipe.mixed_4_6", "concept.mixed_precision"],
  },

  "mlx.recipe.mixed_2_6": {
    title: "mixed_2_6",
    tagline: "Mostly 2-bit, with sensitive layers at 6-bit; the most usable way to get MLX near 2-3 bpw.",
    what: "Quantizes most layers to 2 bits but keeps selected sensitive layers at 6 bits.",
    why: "Much better than uniform 2-bit at a modest size increase. Still a strong compromise; best for large models.",
    meters: { size: 5, quality: 2, effort: 5 },
    technical: "`--quant-predicate mixed_2_6` (affine mode only). In mlx-lm 0.32.2 the high bit-width goes to v_proj and down_proj in about half the layers (first and last eighth, plus every third layer between, mirroring llama.cpp's Q4_K_M rule) and to lm_head; embeddings stay at the low bit-width.",
    related: ["mlx.recipe.mixed_3_6", "concept.mixed_precision", "mlx.bits.2"],
  },

  "mlx.recipe.mixed_3_4": {
    title: "mixed_3_4",
    tagline: "Mostly 3-bit with sensitive layers at 4-bit; small, with a gentle quality boost.",
    what: "Quantizes most layers to 3 bits and the sensitive ones to 4 bits.",
    why: "The smallest of the 3-bit recipes. Use it when mixed_3_6 is slightly too big.",
    meters: { size: 4, quality: 2, effort: 5 },
    technical: "`--quant-predicate mixed_3_4` (affine mode only).",
    related: ["mlx.recipe.mixed_3_6", "mlx.bits.3"],
  },

  "mlx.recipe.mixed_3_6": {
    title: "mixed_3_6",
    tagline: "Mostly 3-bit with sensitive layers at 6-bit; a strong option between 3 and 4 bits.",
    what: "Quantizes most layers to 3 bits and the sensitive ones to 6 bits.",
    why: "Recovers a good share of 3-bit's loss. Comparable in spirit to GGUF Q3_K_M.",
    meters: { size: 4, quality: 3, effort: 5 },
    technical: "`--quant-predicate mixed_3_6` (affine mode only).",
    related: ["mlx.recipe.mixed_3_4", "mlx.recipe.mixed_4_6", "gguf.qtype.Q3_K_M"],
  },

  "mlx.recipe.mixed_4_6": {
    title: "mixed_4_6",
    tagline: "Mostly 4-bit with sensitive layers at 6-bit; the MLX analogue of Q4_K_M.",
    what: "Quantizes most layers to 4 bits and the sensitive ones to 6 bits.",
    why: "A small size increase over uniform 4-bit for a measurable quality gain. A good default when memory allows.",
    meters: { size: 4, quality: 4, effort: 5 },
    goodFor: ["Better 4-bit quality without slow calibration methods"],
    technical: "`--quant-predicate mixed_4_6` (affine mode only).",
    related: ["mlx.bits.4", "gguf.qtype.Q4_K_M", "concept.mixed_precision"],
  },

  // ---------------------------------------------------------------- dtype
  "mlx.dtype.float16": {
    title: "float16",
    tagline: "Store non-quantized parts in float16: fast on all Apple Silicon.",
    what: "Sets the dtype for parameters that are not quantized (norms, biases and any layers left unquantized), or for the whole model if you do not quantize.",
    why: "Works well on every Apple Silicon generation. For BF16-trained models, values outside float16's range are rare but possible.",
    meters: { size: 4, quality: 4, speed: 5, effort: 5 },
    technical: "`--dtype float16`. If omitted, mlx-lm uses the model's configured dtype.",
    related: ["concept.fp16", "mlx.dtype.bfloat16"],
  },

  "mlx.dtype.bfloat16": {
    title: "bfloat16",
    tagline: "Keep non-quantized parts in bfloat16, matching most modern models.",
    what: "Uses bfloat16 for the parameters that are not quantized.",
    why: "Exact for BF16 originals and avoids overflow risk. Newer Apple Silicon handles it natively; on older chips it can be slower than float16.",
    meters: { size: 4, quality: 5, speed: 4, effort: 5 },
    technical: "`--dtype bfloat16`.",
    related: ["concept.bf16", "mlx.dtype.float16"],
  },

  "mlx.dtype.float32": {
    title: "float32",
    tagline: "Keep non-quantized parts in float32; larger and slower, rarely needed.",
    what: "Uses 32-bit floats for the parameters that are not quantized.",
    why: "Only for debugging or numerically delicate models. For unquantized conversions it doubles the size.",
    meters: { size: 2, quality: 5, speed: 2, effort: 5 },
    technical: "`--dtype float32`.",
    related: ["concept.fp32", "mlx.dtype.bfloat16"],
  },

  // ---------------------------------------------------------------- methods
  "mlx.method.convert": {
    title: "Standard convert (RTN)",
    tagline: "Fast, data-free quantization with mlx_lm.convert: minutes, not hours.",
    what: "Rounds each weight group to the nearest level. No calibration data is needed.",
    why: "Quick and reliable, and at 4 bits and above usually good enough. For 2-3 bits consider DWQ, AWQ or a mixed recipe.",
    meters: { quality: 3, effort: 5 },
    technical: "`mlx_lm.convert --hf-path MODEL -q --q-bits 4 --q-group-size 64 [--q-mode affine] [--quant-predicate mixed_4_6] [--dtype bfloat16]`.",
    related: ["concept.rtn", "mlx.bits.4", "mlx.method.dwq"],
    learnMore: [MLX_LM],
  },

  "mlx.method.awq": {
    title: "AWQ",
    tagline: "Activation-aware scaling before quantizing; better 3-4 bit quality, needs calibration.",
    what: "Uses calibration text to find important input channels and rescales weights so they lose less precision.",
    why: "Improves low-bit quality over plain rounding. Takes longer and needs memory to run the full-precision model.",
    meters: { quality: 4, effort: 3 },
    technical: "`mlx_lm/quant/awq.py`: `--bits`, `--group-size`, `--num-samples` (default 128), `--sequence-length` (default 512); embeddings can get their own setting via `--embed-bits`. It needs per-architecture support, so some models are rejected.",
    related: ["concept.awq", "mlx.opt.num_samples", "calib.pile_val"],
  },

  "mlx.method.gptq": {
    title: "GPTQ",
    tagline: "Error-compensating quantization using calibration data; strong at 3-4 bits.",
    what: "Quantizes weights column by column, adjusting the remaining ones to cancel the error measured on calibration text.",
    why: "Often among the most accurate methods at low bits. Slower than convert and needs calibration data.",
    meters: { quality: 4, effort: 3 },
    technical: "`mlx_lm/quant/gptq.py`: `--bits`, `--group-size`, `--num-samples` (default -1 = all calibration samples), `--sequence-length` (default 512). Layers it does not handle use `--fallback-bits`.",
    related: ["concept.gptq", "mlx.opt.num_samples", "mlx.method.awq"],
  },

  "mlx.method.dwq": {
    title: "DWQ (distilled)",
    tagline: "Trains quantization scales to imitate the original model; best MLX low-bit quality.",
    what: "Starts from a normal quantized model, then fine-tunes its scales and biases so its outputs match the full-precision teacher.",
    why: "Frequently the best quality for 3-4 bit MLX models. The slowest option, and it needs memory for both the teacher and the quantized model.",
    meters: { quality: 5, effort: 2 },
    goodFor: ["Getting the most out of 3- or 4-bit on a Mac with enough memory"],
    avoidIf: ["The full-precision model does not fit in memory", "You need a result in minutes"],
    technical: "`mlx_lm/quant/dwq.py`: `--model` (the full-precision teacher), optional `--quantized-model` to start from, `--num-samples` (default 2048), `--max-seq-length` (default 1025), `--learning-rate`, `--batch-size`. It trains scales and biases to minimise the KL divergence to the teacher's token distributions.",
    related: ["concept.dwq", "mlx.opt.num_samples", "mlx.opt.sequence_length", "eval.kld"],
  },

  "mlx.method.dynamic_quant": {
    title: "Dynamic quantization",
    tagline: "Measures each layer's sensitivity and picks its bits to hit a target size.",
    what: "Estimates how much each layer suffers from quantization, then gives more bits to sensitive layers and fewer to robust ones.",
    why: "An automatic mixed-precision recipe tailored to this model, aimed at a target average bits per weight.",
    meters: { quality: 4, effort: 3 },
    technical: "`mlx_lm/quant/dynamic_quant.py`: `--target-bpw` (default 5.0) with `--low-bits` (default 4) and `--high-bits` (default 5), both at group size 64 by default. Layer sensitivities are estimated on calibration data and can be saved and reused (`--sensitivities`).",
    related: ["mlx.opt.target_bpw", "concept.mixed_precision", "mlx.recipe.mixed_4_6"],
  },

  // ---------------------------------------------------------------- options
  "mlx.opt.rules": {
    title: "Custom layer rules",
    tagline: "Pin specific layers (by name pattern) to their own bits or group size.",
    what: "Rules match layer names, such as `lm_head` or `layers.0.`, and assign them different quantization settings, or leave them unquantized.",
    why: "Useful for protecting a known-sensitive layer or reproducing a published recipe. Leave empty unless you know what you need.",
    technical: "Applied through mlx-lm's quantization predicate, which returns per-layer `bits`/`group_size` (or false to skip). Rules apply in affine mode.",
    related: ["concept.mixed_precision", "mlx.recipe.mixed_4_6", "gguf.opt.tensor_type"],
  },

  "mlx.opt.trust_remote_code": {
    title: "Trust remote code",
    tagline: "Allow running Python code shipped in the model repo; only for repos you trust.",
    what: "Some models need custom Python code from their repository (often for the tokenizer) to load.",
    why: "Enabling it runs that code on your computer with your permissions. Only turn it on for publishers you trust.",
    technical: "`mlx_lm.convert --trust-remote-code`. Leave off unless loading fails without it.",
    related: ["concept.tokenizer", "tc.env.mlx"],
  },

  "mlx.opt.num_samples": {
    title: "Calibration samples",
    tagline: "How many calibration texts AWQ, GPTQ, DWQ or dynamic quant use.",
    what: "The number of text samples drawn from the calibration dataset.",
    why: "More samples give steadier statistics but take longer (and for DWQ, longer training). Very few samples can overfit.",
    meters: { quality: 3, effort: 3 },
    technical: "Total calibration tokens = samples x sequence length. mlx-lm defaults differ by method: AWQ 128, GPTQ all available samples, DWQ 2048 (DWQ uses them as training data).",
    related: ["mlx.opt.sequence_length", "calib.size", "concept.calibration"],
  },

  "mlx.opt.sequence_length": {
    title: "Sequence length",
    tagline: "Tokens per calibration sample.",
    what: "How long each calibration sample is, in tokens.",
    why: "Longer samples represent real use better but need more memory and time per sample.",
    technical: "`--sequence-length` for AWQ and GPTQ (default 512); DWQ calls it `--max-seq-length` (default 1025). Memory grows with it, so reduce it if a calibrated method runs out of memory.",
    related: ["mlx.opt.num_samples", "calib.size"],
  },

  "mlx.opt.target_bpw": {
    title: "Target bits per weight",
    tagline: "The average bpw dynamic quantization aims for.",
    what: "Dynamic quantization assigns per-layer bits so the whole model averages close to this value.",
    why: "Lets you aim at a size directly. The target has to sit between what all-low and all-high would cost; with mlx-lm's defaults (4-bit and 5-bit layers) the default target 5.0 gives a mix of both.",
    technical: "`--target-bpw`. Size is approximately parameters x target bpw / 8 bytes.",
    related: ["mlx.method.dynamic_quant", "concept.bpw"],
  },

  "mlx.apple_only": {
    title: "Apple Silicon only",
    tagline: "MLX runs only on Apple Silicon Macs (M1 and later).",
    what: "MLX uses Apple's Metal GPU and unified memory, so both creating and running MLX models require an Apple Silicon Mac.",
    why: "On Intel Macs, Windows or Linux the MLX options are unavailable. Choose GGUF for portable output.",
    technical: "The app's `mlx` environment installs mlx-lm (0.32.x) and is only created on macOS arm64.",
    related: ["format.mlx", "hw.device.apple_silicon", "tc.env.mlx"],
  },
};
