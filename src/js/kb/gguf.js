// GGUF / llama.cpp: base (intermediate) types, quant types, options, presets and tools.
// Sizes and "+ppl" figures are quoted from `llama-quantize --help` of the shipped build
// (reference model Llama-3-8B unless noted). They are the tool's own reference numbers,
// measured without an importance matrix; your model will differ.
const QUANTIZE_README = { label: "llama.cpp quantize README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/quantize" };
const IMATRIX_README = { label: "llama.cpp imatrix README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/imatrix" };

export default {
  // ---------------------------------------------------------------- base types
  "gguf.base.auto": {
    title: "Auto (match the source)",
    tagline: "Writes the full-precision GGUF in 16-bit, picking F16 or BF16 to match the original weights.",
    what: "Before quantizing, the original model is converted once into a full-precision GGUF, the 'intermediate'. Every quantized variant is then made from it. Auto lets the converter pick the 16-bit type that matches the source.",
    why: "It is the safe default: a BF16 model stays BF16 (no overflow risk) and an FP16 model stays FP16, so the intermediate is effectively lossless at half the size of F32.",
    meters: { size: 2, quality: 5, effort: 5 },
    technical: "`--outtype auto` is the converter's default in the shipped llama.cpp build. It scans the weight matrices: the first one stored as bfloat16 makes the output BF16, the first stored as float16 makes it F16, and if neither is found (for example an FP32 checkpoint) it falls back to F16. It deliberately ignores `torch_dtype` in config.json because some fine-tunes mislabel it. 1-D tensors such as norms are written as F32 regardless.",
    related: ["gguf.base.F16", "gguf.base.BF16", "gguf.tool.convert", "concept.bf16"],
  },

  "gguf.base.F32": {
    title: "F32 intermediate",
    tagline: "A 32-bit intermediate: lossless for any source, but twice the size of a 16-bit one.",
    what: "Writes the full-precision GGUF with 32-bit floats.",
    why: "Only useful if the source itself is FP32 and you want to avoid any rounding (Auto would pick F16 for it), or a tool needs it. For BF16 and FP16 sources it adds disk usage and time without improving the quantized results.",
    meters: { size: 1, quality: 5, effort: 3 },
    technical: "About 4 bytes per parameter: an 8B model is about 32 GB. llama-quantize's help lists F32 as 26.00G for a 7B model.",
    related: ["gguf.base.auto", "concept.fp32", "concept.disk_space"],
  },

  "gguf.base.F16": {
    title: "F16 intermediate",
    tagline: "A 16-bit float intermediate; widely compatible and practically lossless.",
    what: "Writes the full-precision GGUF with IEEE half-precision floats.",
    why: "Good when the source is FP16, or when you also want to run the unquantized model on hardware with weak BF16 support. For BF16 sources, very rare out-of-range values could overflow, so Auto or BF16 is slightly safer.",
    meters: { size: 2, quality: 5, effort: 5 },
    technical: "`--outtype f16`. The llama-quantize help lists F16 at 14.00G, +0.0020 ppl @ Mistral-7B.",
    related: ["gguf.base.BF16", "gguf.base.auto", "concept.fp16"],
  },

  "gguf.base.BF16": {
    title: "BF16 intermediate",
    tagline: "A 16-bit intermediate with float32's range; ideal for BF16 models.",
    what: "Writes the full-precision GGUF in bfloat16.",
    why: "Exact for BF16 originals, which is most modern models. Quantizing from it gives the same result as from F32 at half the disk space.",
    meters: { size: 2, quality: 5, effort: 5 },
    technical: "`--outtype bf16`. The llama-quantize help lists BF16 at 14.00G, -0.0050 ppl @ Mistral-7B (within measurement noise of F16).",
    related: ["gguf.base.F16", "gguf.base.auto", "concept.bf16"],
  },

  "gguf.base.Q8_0": {
    title: "Q8_0 intermediate",
    tagline: "Converts straight to 8-bit: saves disk, but later quants become requantizations.",
    what: "The converter writes Q8_0 directly instead of a 16-bit file.",
    why: "Handy when disk space is tight or Q8_0 is the only output you want. Making smaller quants from it means requantizing, which needs `--allow-requantize` and loses some quality compared with starting from 16-bit.",
    meters: { size: 3, quality: 4, effort: 5 },
    technical: "`--outtype q8_0`. Q8_0 stores 32 int8 values plus one fp16 scale per block (8.5 bpw). Error from the Q8_0 step is small (+0.0026 ppl @ Llama-3-8B per the help) but it compounds with the next quantization.",
    related: ["gguf.qtype.Q8_0", "concept.requantize", "gguf.opt.allow_requantize"],
  },

  // ---------------------------------------------------------------- quant types
  "gguf.qtype.Q1_0": {
    title: "Q1_0",
    tagline: "Experimental 1-bit type (1.125 bpw); only sensible for models built for 1-bit weights.",
    what: "A newer, very simple type that stores one bit per weight plus a shared scale per block.",
    why: "Ordinary models do not survive 1-bit storage: output becomes nonsense. Use it only for models trained or released specifically for 1-bit weights, following the publisher's instructions.",
    meters: { size: 5, quality: 1, speed: 3, effort: 4 },
    avoidIf: ["The model is a normal 16-bit release", "You need reliable output"],
    technical: "Listed by llama-quantize as `1.125 bpw quantization`. That figure matches 1 bit per weight plus one 16-bit scale per 128 weights. It is a recent addition, so backend kernel coverage and speed vary by build.",
    related: ["concept.ternary", "gguf.qtype.IQ1_S", "concept.bpw"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.qtype.Q2_0": {
    title: "Q2_0",
    tagline: "A plain 2-bit type (2.25 bpw, group 64); a new and simple alternative to Q2_K/IQ2.",
    what: "A newer, straightforward 2-bit format: each weight is a 2-bit code, and every group of 64 weights shares one scale.",
    why: "It is very small, but 2-bit storage badly damages ordinary models. For general use, IQ2_M or Q2_K with an importance matrix are better-tested choices at similar size.",
    meters: { size: 5, quality: 1, speed: 3, effort: 4 },
    avoidIf: ["You want the best quality at about 2.5 bpw (try IQ2_M with an imatrix)"],
    technical: "Listed as `2.25 bpw quantization (group 64)`: 2 bits + 16/64 bits of scale per weight. Recent addition; check llama.cpp release notes for which backends accelerate it.",
    related: ["gguf.qtype.IQ2_M", "gguf.qtype.Q2_K", "concept.group_size"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.qtype.Q4_0": {
    title: "Q4_0",
    tagline: "The classic 4-bit type: simple and fast, but noticeably less accurate than Q4_K_M.",
    what: "A legacy 4-bit format with one scale per block of 32 weights.",
    why: "Its simplicity makes it very fast on CPUs, especially ARM, where llama.cpp can repack it at load time for optimised kernels. Quality per byte is worse than K-quants, so prefer Q4_K_M unless speed on a specific device matters most.",
    meters: { size: 4, quality: 3, speed: 5, effort: 5 },
    goodFor: ["Phones, Raspberry Pi and other ARM CPUs", "Maximum CPU speed at 4-bit"],
    avoidIf: ["Quality is your priority at this size"],
    technical: "llama-quantize reference: 4.34G, +0.4685 ppl @ Llama-3-8B. Block: 32 x 4-bit + fp16 scale = 4.5 bpw, symmetric. Online repacking (into interleaved layouts) applies to Q4_0 on supported CPUs, which is why it can outrun K-quants there.",
    related: ["gguf.qtype.Q4_K_M", "gguf.qtype.Q4_1", "hw.device.edge"],
  },

  "gguf.qtype.Q4_1": {
    title: "Q4_1",
    tagline: "Legacy 4-bit with a per-block minimum; slightly larger than Q4_0, rarely the best pick.",
    what: "Like Q4_0 but each block of 32 also stores a minimum value, so the range can be shifted (asymmetric).",
    why: "It is a little more accurate than Q4_0 but bigger, and K-quants beat both at similar size. Mostly kept for compatibility.",
    meters: { size: 4, quality: 3, speed: 4, effort: 5 },
    technical: "llama-quantize reference: 4.78G, +0.4511 ppl @ Llama-3-8B. Block: 32 x 4-bit + fp16 scale + fp16 min = 5.0 bpw.",
    related: ["gguf.qtype.Q4_0", "gguf.qtype.Q4_K_S", "concept.symmetric"],
  },

  "gguf.qtype.MXFP4_MOE": {
    title: "MXFP4_MOE",
    tagline: "MXFP4 for the expert weights of Mixture-of-Experts models such as gpt-oss.",
    what: "A file type for MoE models: the large expert tensors are stored in MXFP4 (4-bit floats with a shared scale per 32 values), while the other tensors stay at higher precision.",
    why: "gpt-oss was released with its expert weights already in MXFP4, so this type keeps them in their native format with no extra loss. For other MoE models it is a compact option, but compare against K-quants.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    goodFor: ["gpt-oss models", "MoE models where experts dominate the size"],
    avoidIf: ["Dense (non-MoE) models: there are no expert tensors to target"],
    technical: "Listed by llama-quantize as `MXFP4 MoE`. Expert tensors (stacked `ffn_*_exps`) become MXFP4 at 4.25 bpw; every other tensor, including the output head, becomes Q8_0 (per the llama.cpp source of the shipped build).",
    related: ["concept.mxfp4", "concept.moe", "gguf.opt.dry_run"],
  },

  "gguf.qtype.Q5_0": {
    title: "Q5_0",
    tagline: "Legacy 5-bit type; good quality, but Q5_K_S/Q5_K_M are better at the same size.",
    what: "A legacy format storing 5 bits per weight with one scale per block of 32.",
    why: "Close to Q5_K_S in size, with lower quality. Use it only if a target runtime lacks K-quant support.",
    meters: { size: 3, quality: 4, speed: 4, effort: 5 },
    technical: "llama-quantize reference: 5.21G, +0.1316 ppl @ Llama-3-8B. Block: 32 x 5-bit + fp16 scale = 5.5 bpw.",
    related: ["gguf.qtype.Q5_K_S", "gguf.qtype.Q5_1"],
  },

  "gguf.qtype.Q5_1": {
    title: "Q5_1",
    tagline: "Legacy 5-bit with a per-block minimum; bigger than Q5_K_M and slightly worse.",
    what: "Like Q5_0 plus a per-block minimum (asymmetric).",
    why: "Q5_K_M is smaller and more accurate according to llama-quantize's own figures, so this is mainly for compatibility.",
    meters: { size: 3, quality: 4, speed: 4, effort: 5 },
    technical: "llama-quantize reference: 5.65G, +0.1062 ppl @ Llama-3-8B. Block: 32 x 5-bit + fp16 scale + fp16 min = 6.0 bpw.",
    related: ["gguf.qtype.Q5_K_M", "gguf.qtype.Q5_0"],
  },

  "gguf.qtype.IQ2_XXS": {
    title: "IQ2_XXS",
    tagline: "About 2.06 bpw: the smallest practical 2-bit type; needs an importance matrix.",
    what: "An I-quant that encodes groups of weights with a lattice codebook at about 2 bits per weight.",
    why: "Lets large models (30B+) fit where nothing else would, at a clear quality cost. Small models degrade badly. llama-quantize refuses it without an imatrix.",
    meters: { size: 5, quality: 1, speed: 3, effort: 2 },
    goodFor: ["Fitting a very large model into limited memory"],
    avoidIf: ["Models under about 13B", "Tasks needing precision: code, math, facts"],
    technical: "Listed as `2.06 bpw quantization`. Requires `--imatrix`; without it llama-quantize stops with 'this quantization requires an importance matrix'. The output and token-embedding tensors are exempt from that check.",
    related: ["concept.iquants", "concept.imatrix", "gguf.qtype.IQ2_XS", "gguf.opt.imatrix"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.qtype.IQ2_XS": {
    title: "IQ2_XS",
    tagline: "About 2.31 bpw; a little larger and better than IQ2_XXS. Needs an importance matrix.",
    what: "A 2-bit-class I-quant using a lattice codebook.",
    why: "Slightly better quality than IQ2_XXS for a small size increase. Still a heavy compromise, best reserved for big models. Refused without an imatrix.",
    meters: { size: 5, quality: 2, speed: 3, effort: 2 },
    avoidIf: ["Small models", "Precision-critical tasks"],
    technical: "Listed as `2.31 bpw quantization`. Requires `--imatrix`.",
    related: ["concept.iquants", "gguf.qtype.IQ2_S", "gguf.opt.imatrix"],
  },

  "gguf.qtype.IQ2_S": {
    title: "IQ2_S",
    tagline: "About 2.5 bpw I-quant; requires an importance matrix.",
    what: "A 2-bit-class I-quant with a larger codebook than IQ2_XS.",
    why: "A step up in quality from IQ2_XS. Like all IQ2 types, it suits large models where memory is the hard limit. Refused without an imatrix.",
    meters: { size: 5, quality: 2, speed: 3, effort: 2 },
    technical: "Listed as `2.5 bpw quantization`. Requires `--imatrix`.",
    related: ["concept.iquants", "gguf.qtype.IQ2_M", "gguf.opt.imatrix"],
  },

  "gguf.qtype.IQ2_M": {
    title: "IQ2_M",
    tagline: "About 2.7 bpw: the best of the 2-bit types; requires an importance matrix.",
    what: "The largest IQ2 mix, keeping some sensitive tensors at higher precision.",
    why: "Usually the most usable 2-bit option and often better than Q2_K at a similar or smaller size. Quality is still clearly below 3- and 4-bit.",
    meters: { size: 5, quality: 2, speed: 3, effort: 2 },
    goodFor: ["Large models on tight memory", "Experiments with very small files"],
    avoidIf: ["You can afford IQ3_M or Q3_K_M"],
    technical: "Listed as `2.7 bpw quantization`. Most of its tensors are IQ2_S, which llama-quantize refuses to produce without `--imatrix`; some sensitive tensors get IQ3_S or Q4_K.",
    related: ["concept.iquants", "gguf.qtype.Q2_K", "gguf.qtype.IQ3_XXS", "gguf.opt.imatrix"],
  },

  "gguf.qtype.IQ1_S": {
    title: "IQ1_S",
    tagline: "About 1.56 bpw: extreme compression for very large models; requires an importance matrix.",
    what: "One of llama.cpp's smallest codebook types, about one and a half bits per weight.",
    why: "Mostly an experiment or last resort for huge models (100B+). Output is often incoherent on smaller models. Refused without an imatrix.",
    meters: { size: 5, quality: 1, speed: 3, effort: 2 },
    avoidIf: ["Almost every model under 70B", "Any task where accuracy matters"],
    technical: "Listed as `1.56 bpw quantization`. Requires `--imatrix`. Sensitive tensors (output, attn_v) are kept at higher-bit types by llama.cpp's mix rules, so the file average is higher than 1.56.",
    related: ["gguf.qtype.IQ1_M", "concept.iquants", "gguf.opt.imatrix"],
    learnMore: [IMATRIX_README],
  },

  "gguf.qtype.IQ1_M": {
    title: "IQ1_M",
    tagline: "About 1.75 bpw; slightly better than IQ1_S. Still extreme; requires an importance matrix.",
    what: "A 1-bit-class codebook type with a little more information per weight than IQ1_S.",
    why: "Same caveats as IQ1_S: only for very large models when nothing bigger fits. Refused without an imatrix.",
    meters: { size: 5, quality: 1, speed: 3, effort: 2 },
    avoidIf: ["Models under 70B", "Accuracy-sensitive tasks"],
    technical: "Listed as `1.75 bpw quantization`. Requires `--imatrix`.",
    related: ["gguf.qtype.IQ1_S", "concept.iquants", "gguf.opt.imatrix"],
  },

  "gguf.qtype.TQ1_0": {
    title: "TQ1_0",
    tagline: "Ternary packing (1.69 bpw) for models trained with -1/0/+1 weights, like BitNet b1.58.",
    what: "Stores each weight as one of three values with a per-block scale, packed tightly.",
    why: "Near-lossless and tiny for ternary-trained models. On normal models it destroys quality, so only choose it when the model card says the model is ternary.",
    goodFor: ["BitNet b1.58 and other ternary-trained models"],
    avoidIf: ["Any normally trained model"],
    technical: "Listed as `1.69 bpw ternarization`. Packs five ternary values per byte where possible (3^5 = 243 fits in 8 bits). Smaller than TQ2_0 but usually slower to unpack.",
    related: ["concept.ternary", "gguf.qtype.TQ2_0"],
  },

  "gguf.qtype.TQ2_0": {
    title: "TQ2_0",
    tagline: "Ternary type (2.06 bpw) with simpler packing; usually faster than TQ1_0.",
    what: "Stores ternary weights using 2 bits each, plus a per-block scale.",
    why: "For ternary-trained models only. It trades a little size for faster, simpler decoding than TQ1_0.",
    goodFor: ["Ternary-trained models where speed matters more than the last few MB"],
    avoidIf: ["Any normally trained model"],
    technical: "Listed as `2.06 bpw ternarization`. The converter can also write it directly with `--outtype tq2_0` for supported architectures.",
    related: ["concept.ternary", "gguf.qtype.TQ1_0"],
  },

  "gguf.qtype.Q2_K": {
    title: "Q2_K",
    tagline: "The smallest K-quant: tiny files, but a large quality drop without an importance matrix.",
    what: "A K-quant mix using 2-bit Q2_K for most weights and higher-bit types for the sensitive ones.",
    why: "The tool's own figure shows a big perplexity hit (+3.52 on Llama-3-8B without an imatrix). With an imatrix it improves a lot, but IQ2_M or IQ3_XXS are often better at similar size.",
    meters: { size: 4, quality: 1, speed: 4, effort: 4 },
    avoidIf: ["Small models", "You can fit Q3_K_M or IQ3 types"],
    technical: "llama-quantize reference: 2.96G, +3.5199 ppl @ Llama-3-8B. The Q2_K block itself is about 2.63 bpw; attn_v, output and some other tensors get Q3_K/Q4_K/Q6_K, so the file average is higher.",
    related: ["gguf.qtype.Q2_K_S", "gguf.qtype.IQ2_M", "concept.kquants", "gguf.opt.imatrix"],
  },

  "gguf.qtype.Q2_K_S": {
    title: "Q2_K_S",
    tagline: "A leaner Q2_K mix designed to be used with an importance matrix (required).",
    what: "A variant of Q2_K that upgrades fewer tensors and leans on the imatrix to preserve quality.",
    why: "Same nominal size as Q2_K in the tool's table but a smaller perplexity increase. llama-quantize refuses it without an imatrix.",
    meters: { size: 4, quality: 1, speed: 4, effort: 2 },
    technical: "llama-quantize reference: 2.96G, +3.1836 ppl @ Llama-3-8B. Requires `--imatrix`. File types refused without one in this build: IQ1_S, IQ1_M, IQ2_XXS, IQ2_XS, IQ2_S, IQ2_M, IQ3_XXS, IQ3_XS and Q2_K_S.",
    related: ["gguf.qtype.Q2_K", "gguf.opt.imatrix", "concept.kquants"],
  },

  "gguf.qtype.IQ3_XXS": {
    title: "IQ3_XXS",
    tagline: "About 3.06 bpw: the smallest 3-bit I-quant; requires an importance matrix.",
    what: "A 3-bit-class codebook type.",
    why: "Often a better trade than Q2_K at a similar size and a reasonable floor for mid-sized models. Quality is noticeably below 4-bit.",
    meters: { size: 4, quality: 2, speed: 3, effort: 2 },
    technical: "Listed as `3.06 bpw quantization`. Requires `--imatrix`: llama-quantize refuses to write IQ3_XXS tensors without one.",
    related: ["concept.iquants", "gguf.qtype.IQ3_XS", "gguf.qtype.Q2_K"],
  },

  "gguf.qtype.IQ3_XS": {
    title: "IQ3_XS",
    tagline: "About 3.3 bpw I-quant mix between IQ3_XXS and IQ3_S; requires an importance matrix.",
    what: "A 3-bit-class I-quant mix.",
    why: "A middle step when IQ3_S or Q3_K_M is just slightly too large.",
    meters: { size: 4, quality: 3, speed: 3, effort: 2 },
    technical: "Listed as `3.3 bpw quantization`. Built on IQ3_S, but attention Q/K and the middle layers' FFN gate/up tensors are IQ3_XXS, so `--imatrix` is required.",
    related: ["gguf.qtype.IQ3_S", "gguf.qtype.IQ3_XXS", "concept.iquants"],
  },

  "gguf.qtype.IQ3_S": {
    title: "IQ3_S",
    tagline: "About 3.44 bpw: a strong 3-bit I-quant, usually better than Q3_K_S at similar size.",
    what: "A 3-bit codebook type with a larger grid than IQ3_XXS.",
    why: "A good choice when 4-bit does not fit. Runs well on GPUs; on some CPUs I-quants are slower than K-quants.",
    meters: { size: 4, quality: 3, speed: 3, effort: 3 },
    technical: "Listed as `3.44 bpw quantization`. Compare: Q3_K_S is 3.41G, +1.6321 ppl @ Llama-3-8B (without imatrix).",
    related: ["gguf.qtype.IQ3_M", "gguf.qtype.Q3_K_S", "concept.iquants"],
  },

  "gguf.qtype.IQ3_M": {
    title: "IQ3_M",
    tagline: "About 3.66 bpw: the highest-quality 3-bit I-quant mix.",
    what: "An I-quant mix built on IQ3_S that keeps some sensitive tensors at higher precision.",
    why: "Usually the best 3-bit option overall when paired with an imatrix; a common pick for running a model one size class larger than 4-bit would allow.",
    meters: { size: 4, quality: 3, speed: 3, effort: 3 },
    goodFor: ["Squeezing a bigger model into the same memory"],
    technical: "Listed as `3.66 bpw quantization mix`.",
    related: ["gguf.qtype.IQ3_S", "gguf.qtype.Q3_K_M", "concept.mixed_precision"],
  },

  "gguf.qtype.Q3_K_S": {
    title: "Q3_K_S",
    tagline: "Small 3-bit K-quant; a big quality drop versus Q3_K_M for little saving.",
    what: "A 3-bit K-quant mix that keeps almost every tensor at Q3_K.",
    why: "llama-quantize's figures show a much larger perplexity increase than Q3_K_M for about 9% less size. Prefer Q3_K_M or an IQ3 type unless every MB counts.",
    meters: { size: 4, quality: 2, speed: 4, effort: 4 },
    technical: "llama-quantize reference: 3.41G, +1.6321 ppl @ Llama-3-8B.",
    related: ["gguf.qtype.Q3_K_M", "gguf.qtype.IQ3_S", "concept.kquants"],
  },

  "gguf.qtype.Q3_K_M": {
    title: "Q3_K_M",
    tagline: "The balanced 3-bit K-quant: smallest type most people still find usable.",
    what: "A 3-bit K-quant mix that gives sensitive tensors (attention value and output, FFN down projections, the output head) 4- to 6-bit types.",
    why: "A common choice when Q4_K_M is too large. Expect noticeably more errors than 4-bit on reasoning and code.",
    meters: { size: 4, quality: 3, speed: 4, effort: 4 },
    goodFor: ["Tight memory with a 7B-14B model", "Fitting the next model size up"],
    technical: "llama-quantize reference: 3.74G, +0.6569 ppl @ Llama-3-8B. `Q3_K` is an alias for Q3_K_M.",
    related: ["gguf.qtype.Q3_K_L", "gguf.qtype.Q4_K_M", "gguf.qtype.IQ3_M"],
  },

  "gguf.qtype.Q3_K_L": {
    title: "Q3_K_L",
    tagline: "The largest 3-bit K-quant mix; close in size to Q4_0.",
    what: "A 3-bit K-quant mix that gives more tensors (attn_v, ffn_down and others) higher-bit types.",
    why: "Slightly better than Q3_K_M, but at 4.03G it is near Q4_K_S (4.37G), which is clearly better. Pick it only when that small difference in size matters.",
    meters: { size: 4, quality: 3, speed: 4, effort: 4 },
    technical: "llama-quantize reference: 4.03G, +0.5562 ppl @ Llama-3-8B.",
    related: ["gguf.qtype.Q3_K_M", "gguf.qtype.Q4_K_S"],
  },

  "gguf.qtype.IQ4_NL": {
    title: "IQ4_NL",
    tagline: "4.5 bpw non-linear 4-bit type with small blocks; a good Q4_0 replacement.",
    what: "A 4-bit type whose 16 levels are spaced non-uniformly to match how weights are actually distributed, with blocks of 32 weights.",
    why: "More accurate than Q4_0 at the same 4.5 bpw. Its small block size also makes it a fallback for tensors whose rows do not divide into 256-weight K-quant super-blocks.",
    meters: { size: 4, quality: 4, speed: 4, effort: 4 },
    technical: "Listed as `4.50 bpw non-linear quantization`. Benefits from an imatrix but works without one. On some ARM CPUs llama.cpp repacks it at load time for faster kernels, similar to Q4_0.",
    related: ["gguf.qtype.IQ4_XS", "gguf.qtype.Q4_0", "concept.iquants"],
  },

  "gguf.qtype.IQ4_XS": {
    title: "IQ4_XS",
    tagline: "4.25 bpw non-linear 4-bit: close to Q4_K_S quality in a smaller file.",
    what: "A 4-bit non-linear I-quant using 256-weight super-blocks with compact sub-block scales.",
    why: "A popular choice when Q4_K_M is just too big: smaller than Q4_K_S with similar quality, especially with an imatrix.",
    meters: { size: 4, quality: 4, speed: 4, effort: 4 },
    goodFor: ["Getting near-4-bit quality in less memory"],
    technical: "Listed as `4.25 bpw non-linear quantization`.",
    related: ["gguf.qtype.IQ4_NL", "gguf.qtype.Q4_K_S", "concept.iquants"],
  },

  "gguf.qtype.Q4_K_S": {
    title: "Q4_K_S",
    tagline: "Slightly smaller 4-bit K-quant; a bit more loss than Q4_K_M.",
    what: "A 4-bit K-quant mix that keeps most tensors at Q4_K and upgrades only a few early-layer tensors.",
    why: "Saves about 5% versus Q4_K_M with a modest quality cost. Good when Q4_K_M almost fits.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    technical: "llama-quantize reference: 4.37G, +0.2689 ppl @ Llama-3-8B.",
    related: ["gguf.qtype.Q4_K_M", "gguf.qtype.IQ4_XS", "concept.kquants"],
  },

  "gguf.qtype.Q4_K_M": {
    title: "Q4_K_M",
    tagline: "The go-to default: about a third of the 16-bit size with small quality loss.",
    what: "A 4-bit K-quant mix: most weights in Q4_K, with attention value and FFN down projections in about half the layers, plus the output tensor, kept at Q6_K.",
    why: "The most widely used GGUF quant because it balances size, speed and quality well on almost every device. Start here and move up or down only if needed.",
    meters: { size: 4, quality: 4, speed: 4, effort: 5 },
    goodFor: ["A first quant for any model", "Chat, RAG and general use", "Sharing on Hugging Face"],
    avoidIf: ["It doesn't fit your memory (try IQ4_XS or Q3_K_M)", "You need near-lossless output (Q6_K or Q8_0)"],
    technical: "llama-quantize reference: 4.58G, +0.1754 ppl @ Llama-3-8B. `Q4_K` is an alias for Q4_K_M. Upgraded layers follow llama.cpp's use-more-bits rule (first and last eighth of layers plus every third layer between). An imatrix improves it further.",
    related: ["gguf.qtype.Q4_K_S", "gguf.qtype.Q5_K_M", "concept.kquants", "concept.mixed_precision"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.qtype.Q5_K_S": {
    title: "Q5_K_S",
    tagline: "5-bit K-quant: very close to the original, about 14% bigger than Q4_K_M.",
    what: "A 5-bit K-quant mix with nearly all tensors at Q5_K.",
    why: "A good step up from 4-bit when memory allows, particularly for code and math where small errors matter.",
    meters: { size: 3, quality: 4, speed: 4, effort: 5 },
    technical: "llama-quantize reference: 5.21G, +0.1049 ppl @ Llama-3-8B.",
    related: ["gguf.qtype.Q5_K_M", "gguf.qtype.Q4_K_M"],
  },

  "gguf.qtype.Q5_K_M": {
    title: "Q5_K_M",
    tagline: "High-quality 5-bit mix; a common choice when you can spare the memory.",
    what: "A 5-bit K-quant mix that keeps attn_v and ffn_down in about half the layers, plus the output tensor, at Q6_K.",
    why: "Noticeably closer to the original than Q4_K_M (+0.057 vs +0.175 ppl on the tool's reference) for about 16% more size.",
    meters: { size: 3, quality: 4, speed: 4, effort: 5 },
    goodFor: ["Code, math and multilingual use", "Small models (under 4B), which suffer more from 4-bit"],
    technical: "llama-quantize reference: 5.33G, +0.0569 ppl @ Llama-3-8B. `Q5_K` is an alias for Q5_K_M.",
    related: ["gguf.qtype.Q5_K_S", "gguf.qtype.Q6_K", "gguf.qtype.Q4_K_M"],
  },

  "gguf.qtype.Q6_K": {
    title: "Q6_K",
    tagline: "Near-lossless 6-bit: hard to tell apart from the original.",
    what: "A 6-bit K-quant applied to almost every tensor.",
    why: "When you want quality that is practically identical to 16-bit but still want a much smaller file. Often the best 'high quality' option for sharing.",
    meters: { size: 3, quality: 5, speed: 3, effort: 5 },
    goodFor: ["Near-reference quality", "Small models where 4-bit hurts"],
    technical: "llama-quantize reference: 6.14G, +0.0217 ppl @ Llama-3-8B. Q6_K block is about 6.56 bpw.",
    related: ["gguf.qtype.Q8_0", "gguf.qtype.Q5_K_M"],
  },

  "gguf.qtype.Q8_0": {
    title: "Q8_0",
    tagline: "8-bit: practically indistinguishable from the original at about half the 16-bit size.",
    what: "Every weight stored as an 8-bit integer with one scale per block of 32.",
    why: "The safest quantization. Use it as a high-quality reference or for small models, or when memory isn't a concern. It is fast to produce and needs no imatrix.",
    meters: { size: 2, quality: 5, speed: 3, effort: 5 },
    goodFor: ["A quality baseline for comparisons", "Small models", "Plenty of memory"],
    technical: "llama-quantize reference: 7.96G, +0.0026 ppl @ Llama-3-8B. 32 x int8 + fp16 scale = 8.5 bpw.",
    related: ["gguf.qtype.Q6_K", "gguf.base.Q8_0", "eval.reference"],
  },

  "gguf.qtype.F16": {
    title: "F16 (no quantization)",
    tagline: "Unquantized 16-bit output: full quality, full size.",
    what: "Writes (or keeps) the model in 16-bit floats.",
    why: "Useful as the evaluation reference or for GPUs with plenty of memory. Generation is slower than quantized types because nearly twice as many bytes must be read per token as with Q8_0.",
    meters: { size: 1, quality: 5, speed: 2, effort: 5 },
    technical: "llama-quantize reference: 14.00G, +0.0020 ppl @ Mistral-7B.",
    related: ["gguf.base.F16", "concept.fp16", "eval.reference"],
  },

  "gguf.qtype.BF16": {
    title: "BF16 (no quantization)",
    tagline: "Unquantized bfloat16 output: exact for BF16 models, full size.",
    what: "Writes the model in bfloat16.",
    why: "The exact original for most modern models; a good reference for evaluation. Some backends run BF16 slower than F16.",
    meters: { size: 1, quality: 5, speed: 2, effort: 5 },
    technical: "llama-quantize reference: 14.00G, -0.0050 ppl @ Mistral-7B.",
    related: ["gguf.base.BF16", "concept.bf16", "eval.reference"],
  },

  "gguf.qtype.F32": {
    title: "F32 (no quantization)",
    tagline: "32-bit output: twice the size of 16-bit and almost never needed.",
    what: "Writes every tensor as 32-bit floats.",
    why: "Only for debugging or tools that require it. It is not better than BF16/F16 for 16-bit source models.",
    meters: { size: 1, quality: 5, speed: 1, effort: 5 },
    technical: "llama-quantize reference: 26.00G @ 7B.",
    related: ["gguf.base.F32", "concept.fp32"],
  },

  "gguf.qtype.COPY": {
    title: "COPY",
    tagline: "Copies tensors unchanged; for re-sharding or editing metadata without re-quantizing.",
    what: "A special mode that writes a new GGUF with every tensor copied as-is.",
    why: "Useful with `--keep-split` or `--override-kv`, for example to fix a metadata value or change the sharding, with zero quality change.",
    technical: "Listed as `COPY : only copy tensors, no quantizing`.",
    related: ["gguf.opt.override_kv", "gguf.opt.keep_split"],
  },

  // ---------------------------------------------------------------- options
  "gguf.opt.imatrix": {
    title: "Use importance matrix",
    tagline: "Feeds activation statistics to the quantizer so important weights are kept more accurate.",
    what: "Runs `llama-imatrix` on calibration text first, then passes the result to `llama-quantize --imatrix`.",
    why: "Improves quality at 4 bits and below at the cost of extra time (a full-precision forward pass over the calibration text). Required for IQ1_*, IQ2_*, IQ3_XXS, IQ3_XS and Q2_K_S.",
    meters: { quality: 5, effort: 3 },
    goodFor: ["Any quant at 4 bits or lower", "I-quants"],
    avoidIf: ["You only make Q6_K, Q8_0 or 16-bit (little to no benefit)"],
    technical: "`llama-quantize --imatrix imatrix.gguf in.gguf out.gguf TYPE`. One imatrix can be reused for every variant of the same model.",
    related: ["concept.imatrix", "gguf.tool.imatrix", "gguf.opt.imatrix_chunks", "concept.calibration"],
    learnMore: [IMATRIX_README],
  },

  "gguf.opt.imatrix_chunks": {
    title: "Imatrix chunks",
    tagline: "How many chunks of calibration text to process; more chunks are slower but steadier.",
    what: "The calibration text is cut into chunks of the context size. This limits how many of them `llama-imatrix` processes.",
    why: "Too few chunks give noisy statistics; beyond a few hundred the gains are usually small. Time grows linearly with chunks.",
    meters: { quality: 3, effort: 3 },
    technical: "`llama-imatrix --chunks N` (default -1 = all). Tokens processed = chunks x context size; for example 200 chunks x 512 tokens is about 100k tokens. `--chunk N` (alias `--from-chunk`) skips the first N chunks.",
    related: ["gguf.opt.imatrix_ctx", "calib.size", "gguf.tool.imatrix"],
  },

  "gguf.opt.imatrix_ctx": {
    title: "Imatrix context size",
    tagline: "Tokens per calibration chunk; 512 is the standard default.",
    what: "The context length used for each chunk when collecting importance statistics.",
    why: "Most imatrix files in the community are made at 512. Longer chunks capture more long-range behaviour but cost more memory and time per chunk.",
    technical: "`llama-imatrix -c N` (the common default is 512).",
    related: ["gguf.opt.imatrix_chunks", "concept.context_length"],
  },

  "gguf.opt.output_tensor_type": {
    title: "Output tensor type",
    tagline: "Choose the quant type for the output head (output.weight) separately.",
    what: "Overrides the type used for the final layer that scores vocabulary tokens.",
    why: "The output head is sensitive; keeping it at Q8_0 or Q6_K can protect quality in small, low-bit quants for a modest size cost, especially with large vocabularies.",
    technical: "`llama-quantize --output-tensor-type q8_0`. K-quant mixes usually default this tensor to Q6_K already. Tied-embedding models may not have a separate output.weight.",
    related: ["concept.lm_head", "gguf.opt.leave_output_tensor", "gguf.preset.embed_q8"],
  },

  "gguf.opt.token_embedding_type": {
    title: "Token embedding type",
    tagline: "Choose the quant type for the input embedding table separately.",
    what: "Overrides the type of `token_embd.weight`, the table of token vectors.",
    why: "Raising it costs size proportional to vocabulary x hidden size, which is notable in small models. Most of the time the default is fine.",
    technical: "`llama-quantize --token-embedding-type q8_0`.",
    related: ["concept.embeddings", "gguf.preset.embed_q8", "concept.tied_embeddings"],
  },

  "gguf.opt.leave_output_tensor": {
    title: "Leave output tensor",
    tagline: "Keep the output head exactly as in the input file instead of quantizing it.",
    what: "Skips quantization of output.weight.",
    why: "Can help quality, especially when requantizing, but increases size. Usually `--output-tensor-type q8_0` is a better compromise.",
    technical: "`llama-quantize --leave-output-tensor`: 'leave output.weight un(re)quantized'.",
    related: ["gguf.opt.output_tensor_type", "concept.lm_head", "concept.requantize"],
  },

  "gguf.opt.pure": {
    title: "Pure (no mixing)",
    tagline: "Quantize every tensor to exactly the chosen type, disabling the built-in mixes.",
    what: "Turns off llama.cpp's per-tensor rules that give sensitive tensors more bits.",
    why: "Mostly for research and benchmarking a single type. For normal use it lowers quality for little size gain.",
    technical: "`llama-quantize --pure`: 'disable k-quant mixtures and quantize all tensors to the same type'.",
    related: ["concept.mixed_precision", "concept.kquants"],
  },

  "gguf.opt.allow_requantize": {
    title: "Allow requantize",
    tagline: "Permit quantizing an input that is already quantized (lower quality).",
    what: "Lets llama-quantize accept a GGUF whose tensors are already quantized, such as Q8_0.",
    why: "Needed when you only have a quantized source. Quality is worse than quantizing from 16-bit, sometimes severely.",
    technical: "`--allow-requantize`. The tool warns that this 'can severely reduce quality compared to quantizing from 16bit or 32bit'.",
    related: ["concept.requantize", "gguf.base.Q8_0", "gguf.opt.leave_output_tensor"],
  },

  "gguf.opt.tensor_type": {
    title: "Per-tensor types",
    tagline: "Advanced: force specific tensors (by name pattern) to a chosen quant type.",
    what: "Lets you override the type for individual tensors or groups, for example all attention value projections.",
    why: "Powerful for custom mixes, but easy to make files bigger or worse. The app's presets use this for you.",
    technical: "`--tensor-type attn_v=q6_k` (repeatable) or `--tensor-type-file list.txt`. The left side is a regular expression searched within GGUF tensor names such as `blk.0.attn_v.weight`, so `attn_v` matches every layer and `blk\\.0\\.attn_v` only layer 0. Matching tensors override the built-in mix.",
    related: ["gguf.preset.protect_sensitive", "gguf.preset.edges_higher", "concept.mixed_precision"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.opt.keep_split": {
    title: "Keep split",
    tagline: "Write the quantized model in the same shards as the input.",
    what: "If the input GGUF is split into several files, the output is split the same way.",
    why: "Convenient for very large models. Without it, the output is a single file (which the app may later split for upload).",
    technical: "`llama-quantize --keep-split`.",
    related: ["concept.sharding", "gguf.opt.split_max_size", "gguf.tool.split"],
  },

  "gguf.opt.split_max_size": {
    title: "Max shard size",
    tagline: "Split output GGUFs into files no larger than this size.",
    what: "Sets the largest allowed size for each shard when splitting.",
    why: "Hugging Face rejects single files over 50 GB, so the app splits anything above 48 GB by default. Smaller shards also make downloads easier to resume.",
    technical: "`llama-gguf-split --split --split-max-size 48G in.gguf out` (sizes accept M or G). Splits happen at tensor boundaries.",
    related: ["hub.file_limit", "gguf.tool.split", "concept.sharding"],
  },

  "gguf.opt.prune_layers": {
    title: "Prune layers",
    tagline: "Experimental: delete whole transformer layers to shrink the model.",
    what: "Removes the listed layer numbers from the model while quantizing.",
    why: "Can shrink a model further, but usually costs much more quality than a lower-bit quant. Only for experiments where you will measure the result.",
    technical: "`--prune-layers 20,21,22`. The tool marks it 'an advanced option, use with care'.",
    related: ["eval.kld", "concept.params"],
  },

  "gguf.opt.use_temp_file": {
    title: "Use temp file (convert)",
    tagline: "Lower memory use during conversion by staging data in a temporary file.",
    what: "Makes `convert_hf_to_gguf.py` buffer tensor data in a temporary file instead of RAM.",
    why: "Helps when conversion is killed for running out of memory, at the cost of extra disk I/O.",
    technical: "`convert_hf_to_gguf.py --use-temp-file`. The converter already loads tensors lazily by default.",
    related: ["gguf.tool.convert", "concept.disk_space"],
  },

  "gguf.opt.threads": {
    title: "Quantize threads",
    tagline: "CPU threads used by llama-quantize.",
    what: "Number of threads used to quantize each tensor.",
    why: "More threads finish faster. Lower it to keep your computer responsive while a job runs.",
    technical: "Positional `nthreads` argument: `llama-quantize in.gguf out.gguf Q4_K_M 8`. Defaults to the number of hardware threads.",
    related: ["hw.cpu_threads", "settings.threads"],
  },

  "gguf.opt.dry_run": {
    title: "Dry run",
    tagline: "Calculate the final size without actually quantizing.",
    what: "Runs llama-quantize's planning step and prints per-tensor types and the resulting size.",
    why: "Fast and free: it shows the exact output size before you commit to a long job.",
    technical: "`llama-quantize --dry-run model-f32.gguf Q4_K`.",
    related: ["goal.recommendation", "gguf.tool.quantize"],
  },

  "gguf.opt.max_buffer_size": {
    title: "Max buffer size",
    tagline: "Limit memory used while quantizing one very large tensor.",
    what: "Caps how many tensor rows are kept in memory at once while quantizing a tensor.",
    why: "Lower it if quantizing a huge model (for example big MoE expert tensors) runs out of RAM. Leave the default otherwise.",
    technical: "`--max-buffer-size MiB` (default 8192).",
    related: ["hw.ram", "concept.moe"],
  },

  "gguf.opt.include_weights": {
    title: "Include / exclude weights (imatrix)",
    tagline: "Apply the importance matrix only to some tensors, or to all except some.",
    what: "Restricts which tensors use imatrix data during quantization.",
    why: "Rarely needed. Useful for experiments, or when imatrix data for a tensor is missing or unreliable.",
    technical: "`--include-weights name` or `--exclude-weights name` (repeatable). They cannot be used together.",
    related: ["gguf.opt.imatrix", "concept.imatrix"],
  },

  "gguf.opt.override_kv": {
    title: "Override metadata",
    tagline: "Advanced: change a metadata value (key=type:value) in the output GGUF.",
    what: "Sets or replaces a GGUF metadata key in the quantized file.",
    why: "Can fix a wrong setting (for example a tokenizer flag) without reconverting. Wrong values can break the model, so use with care.",
    technical: "`--override-kv KEY=TYPE:VALUE` (types: int, float, bool, str), repeatable; for example `tokenizer.ggml.add_bos_token=bool:false`.",
    related: ["gguf.qtype.COPY", "concept.chat_template"],
  },

  // ---------------------------------------------------------------- presets
  "gguf.preset.none": {
    title: "No preset",
    tagline: "Use llama.cpp's built-in mix for the chosen type, unchanged.",
    what: "No extra per-tensor overrides are added.",
    why: "The built-in _S/_M/_L mixes are already well tuned; this is the right choice most of the time.",
    meters: { size: 4, quality: 3, effort: 5 },
    related: ["concept.kquants", "gguf.preset.protect_sensitive"],
  },

  "gguf.preset.protect_sensitive": {
    title: "Protect sensitive tensors",
    tagline: "Gives attn_v and ffn_down one quant step more in every layer.",
    what: "Adds overrides so the attention value and FFN down projections use the next higher type (for example Q5_K instead of Q4_K) in all layers.",
    why: "These tensors are among the most sensitive. This preset trades a few percent extra size for lower error, mostly useful with _S mixes or at 3 bits.",
    meters: { size: 3, quality: 4, effort: 5 },
    technical: "Implemented with `--tensor-type attn_v=...` and `--tensor-type ffn_down=...`. The _M mixes already upgrade these in about half the layers, so the extra benefit there is smaller.",
    related: ["gguf.opt.tensor_type", "concept.attention", "concept.ffn"],
  },

  "gguf.preset.edges_higher": {
    title: "Higher-precision edges",
    tagline: "Keeps the first and last N blocks at a higher type.",
    what: "Quantizes the first and last few transformer blocks one step higher than the rest.",
    why: "The earliest and final layers tend to be the most sensitive to quantization error, so protecting them buys quality for a small size increase.",
    meters: { size: 3, quality: 4, effort: 5 },
    technical: "Implemented with layer-specific `--tensor-type` regex patterns such as `blk\\.0\\.` and `blk\\.31\\.`. llama.cpp's own Q4_K_M/Q5_K_M mixes use a similar idea for attn_v/ffn_down in the first and last eighth of layers.",
    related: ["gguf.opt.tensor_type", "concept.mixed_precision"],
  },

  "gguf.preset.embed_q8": {
    title: "Embeddings and output at Q8_0",
    tagline: "Keeps token embeddings and the output head at 8-bit.",
    what: "Sets `--token-embedding-type q8_0` and `--output-tensor-type q8_0`.",
    why: "Helps small models and models with large vocabularies, where these tensors are a big share of the error. Adds size roughly proportional to vocabulary x hidden size.",
    meters: { size: 3, quality: 4, effort: 5 },
    goodFor: ["Models under about 4B", "Multilingual models with large vocabularies"],
    related: ["gguf.opt.token_embedding_type", "gguf.opt.output_tensor_type", "concept.embeddings", "concept.lm_head"],
  },

  // ---------------------------------------------------------------- tools
  "gguf.tool.convert": {
    title: "convert_hf_to_gguf.py",
    tagline: "llama.cpp's Python script that turns a Hugging Face model into a GGUF file.",
    what: "Reads the safetensors weights, config and tokenizer, and writes a full-precision (or Q8_0) GGUF with all metadata embedded.",
    why: "It is the first step of every GGUF job. If an architecture is not supported by the installed llama.cpp version, conversion fails here.",
    technical: "`python convert_hf_to_gguf.py MODEL_DIR --outtype {f32,f16,bf16,q8_0,tq1_0,tq2_0,auto} --outfile out.gguf`. Runs in the app's `gguf` Python environment. Vision models may need a separate projector file (`--mmproj`).",
    related: ["gguf.base.auto", "tc.env.gguf", "gguf.opt.use_temp_file"],
    learnMore: [{ label: "convert_hf_to_gguf.py source", url: "https://github.com/ggml-org/llama.cpp/blob/master/convert_hf_to_gguf.py" }],
  },

  "gguf.tool.quantize": {
    title: "llama-quantize",
    tagline: "The llama.cpp tool that produces each quantized GGUF variant.",
    what: "Takes the full-precision GGUF and writes a quantized copy of the chosen type, optionally guided by an importance matrix.",
    why: "It does the real work. Its `--help` output tells the app which types and options this build supports.",
    technical: "Usage: `llama-quantize [options] model-f32.gguf [model-quant.gguf] type [nthreads]`.",
    related: ["gguf.opt.imatrix", "gguf.opt.dry_run", "tc.probe"],
    learnMore: [QUANTIZE_README],
  },

  "gguf.tool.imatrix": {
    title: "llama-imatrix",
    tagline: "Runs calibration text through the model to build the importance matrix.",
    what: "Processes calibration text with the full-precision GGUF and saves per-channel activation statistics.",
    why: "Needed for I-quants and very low-bit K-quants, and helpful for everything at 4 bits and below. It is the slowest optional step.",
    technical: "`llama-imatrix -m model.gguf -f calibration.txt -o imatrix.gguf [--chunks N] [-c 512]`. GGUF output is the default (`--output-format {gguf,dat}`). `--process-output` also collects data for output.weight (off by default). GPU offload speeds it up considerably.",
    related: ["concept.imatrix", "gguf.opt.imatrix_chunks", "calib.wikitext2"],
    learnMore: [IMATRIX_README],
  },

  "gguf.tool.perplexity": {
    title: "llama-perplexity",
    tagline: "Measures perplexity and KL divergence of a GGUF against reference text or logits.",
    what: "Scores how well the model predicts a test text, and can compare a quantized model's token probabilities to the full-precision model's.",
    why: "It gives the most reliable GGUF quality numbers: perplexity, full-distribution KLD, top-token agreement and delta-p.",
    technical: "Perplexity: `llama-perplexity -m q.gguf -f wiki.test.raw -c 512 [--chunks N]`. KLD: first run the reference with `--kl-divergence-base base.kld`, then each quant with `--kl-divergence-base base.kld --kl-divergence`.",
    related: ["eval.ppl", "eval.kld", "eval.top1", "eval.delta_p"],
    learnMore: [{ label: "llama.cpp perplexity README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/perplexity" }],
  },

  "gguf.tool.bench": {
    title: "llama-bench",
    tagline: "Benchmarks prompt processing and generation speed of a GGUF.",
    what: "Runs standard speed tests, by default 512-token prompt processing and 128-token generation, repeated several times.",
    why: "Gives comparable tokens-per-second numbers for each variant on your hardware.",
    technical: "`llama-bench -m q.gguf -p 512 -n 128 -r 5 -o json` (defaults: -p 512, -n 128, 5 repetitions). Reports pp512 and tg128 with standard deviation.",
    related: ["eval.speed_pp", "eval.speed_tg"],
    learnMore: [{ label: "llama-bench README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/llama-bench" }],
  },

  "gguf.tool.server": {
    title: "llama-server",
    tagline: "Serves a GGUF over an OpenAI-compatible HTTP API; used for side-by-side tests.",
    what: "A lightweight HTTP server with chat completions endpoints and a built-in web UI.",
    why: "Useful for running the same prompt suites against each variant with identical settings.",
    technical: "`llama-server -m q.gguf -c 4096 --port 8080`. Endpoints include `/v1/chat/completions` and `/v1/completions`. Applies the GGUF's embedded chat template by default.",
    related: ["eval.sequential", "concept.chat_template", "goal.runtime.llamacpp"],
    learnMore: [{ label: "llama-server README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server" }],
  },

  "gguf.tool.split": {
    title: "llama-gguf-split",
    tagline: "Splits a large GGUF into shards, or merges shards back into one file.",
    what: "Cuts a GGUF into several valid GGUF shards that llama.cpp can load together.",
    why: "Needed to upload files bigger than Hugging Face's 50 GB per-file limit.",
    technical: "`llama-gguf-split --split --split-max-size 48G model.gguf model` produces `model-00001-of-0000N.gguf` and so on. `--merge first-shard.gguf out.gguf` recombines them.",
    related: ["gguf.opt.split_max_size", "hub.file_limit", "concept.sharding"],
    learnMore: [{ label: "gguf-split README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/gguf-split" }],
  },
};
