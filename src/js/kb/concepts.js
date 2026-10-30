// Core concepts used across all formats.
export default {
  "concept.quantization": {
    title: "Quantization",
    tagline: "Storing a model's numbers with fewer bits so it gets smaller and usually faster.",
    what: "An LLM is mostly a huge list of numbers called weights. Quantization rewrites those numbers with fewer bits each, for example 4 bits instead of 16, so the file and its memory use shrink.",
    why: "A smaller model fits on more devices and usually runs faster, because generating text is often limited by how fast weights can be read from memory. The cost is a small loss of accuracy that grows as you use fewer bits.",
    analogy: "Like saving a photo as a JPEG: much smaller, and at sensible settings you barely notice, but squeeze too hard and artifacts appear.",
    technical: "Most LLM quantization is post-training and weight-only: weights are split into small groups, each group gets a scale (and sometimes an offset), and each weight is stored as a small integer or a tiny float code. At run time the runtime either dequantizes on the fly or uses integer/low-precision kernels. A 16-bit model quantized to about 4.5 effective bits per weight is roughly 3.5x smaller.",
    related: ["concept.bpw", "concept.weight_only", "concept.group_size", "concept.ptq_vs_qat", "format.compare"],
  },

  "concept.bpw": {
    title: "Bits per weight (bpw)",
    tagline: "The average storage cost of one weight, including scales and other overhead.",
    what: "Bits per weight is the average number of bits used to store each weight once everything is counted, including the per-group scales that quantized formats need.",
    why: "It is the most honest way to compare formats: file size is roughly parameters x bpw / 8 bytes. Lower bpw means smaller and usually faster, but lower quality.",
    technical: "Example: a 4-bit format with one 16-bit scale per 32 weights costs 4 + 16/32 = 4.5 bpw (GGUF Q4_0). MLX affine 4-bit with group size 64 stores an fp16 scale and fp16 bias per group: 4 + 32/64 = 4.5 bpw. Mixed formats like Q4_K_M put some tensors at higher precision, so the whole-file average is higher than the nominal type. Size estimate: 8e9 params x 4.5 bpw / 8 = about 4.5e9 bytes, before metadata and any tensors kept at higher precision.",
    related: ["concept.quantization", "concept.group_size", "concept.mixed_precision", "concept.params"],
  },

  "concept.dtype": {
    title: "Data type (dtype)",
    tagline: "The number format used to store values, such as float32, float16, bfloat16 or int4.",
    what: "A data type says how many bits each number uses and how those bits are interpreted, for example as a floating-point number or an integer.",
    why: "It sets the trade-off between size, precision and range. Original models are usually published in 16-bit floats; quantized models use small integer or tiny float types for weights while doing math in a wider type.",
    technical: "Floating-point types split their bits into sign, exponent (range) and mantissa (precision): FP32 is 1/8/23, FP16 is 1/5/10, BF16 is 1/8/7, FP8 E4M3 is 1/4/3 and FP4 E2M1 is 1/2/1. Integer quant types (int8, int4) store codes that are multiplied by a scale to recover approximate values.",
    related: ["concept.fp32", "concept.fp16", "concept.bf16", "concept.fp8", "concept.mxfp4"],
  },

  "concept.fp32": {
    title: "FP32 (float32)",
    tagline: "Full 32-bit floating point: maximum precision, but twice the size of 16-bit.",
    what: "Single-precision floating point, 4 bytes per number. It is the classic training precision and the safest choice for exact math.",
    why: "For inference it is rarely worth it: a 16-bit copy behaves almost identically at half the size. FP32 is mainly useful as a lossless intermediate or when a tool requires it.",
    technical: "1 sign, 8 exponent, 23 mantissa bits. An 8B-parameter model at FP32 needs about 32 GB just for weights. Converting an FP16 or BF16 checkpoint to FP32 does not add any information; it only makes the file bigger.",
    related: ["concept.dtype", "concept.fp16", "concept.bf16", "gguf.base.F32"],
  },

  "concept.fp16": {
    title: "FP16 (float16)",
    tagline: "Half-precision float: 2 bytes per value with good precision but a limited range.",
    what: "A 16-bit floating-point format with more precision bits than BF16 but a much smaller range: the largest value it can hold is 65504.",
    why: "FP16 is widely supported by GPUs and is a good full-quality format, but models trained in BF16 occasionally contain values outside the FP16 range, which then overflow to infinity.",
    technical: "1 sign, 5 exponent, 10 mantissa bits. Converting BF16 to FP16 is lossless only when every value fits the FP16 range; most values do, but rare large activations or weights can overflow. Many quantized formats store their per-group scales in FP16.",
    related: ["concept.dtype", "concept.bf16", "concept.fp32", "gguf.base.F16"],
  },

  "concept.bf16": {
    title: "BF16 (bfloat16)",
    tagline: "A 16-bit float with float32's range but less precision; the usual format of new models.",
    what: "Brain floating point keeps the same 8 exponent bits as FP32, so it can represent the same range of magnitudes, but it has only 7 mantissa bits of precision.",
    why: "Most modern LLMs are trained and released in BF16. Keeping BF16 as your full-precision intermediate avoids any risk of overflow, but some older hardware runs BF16 math slowly or not at all.",
    technical: "1 sign, 8 exponent, 7 mantissa bits. Converting BF16 weights to FP32 is exact; converting to FP16 trades range for precision. Native BF16 math is supported on recent NVIDIA GPUs (Ampere and newer), recent Apple Silicon and many modern CPUs; elsewhere it is emulated and slower.",
    related: ["concept.dtype", "concept.fp16", "concept.fp32", "gguf.base.BF16"],
  },

  "concept.group_size": {
    title: "Group size (block size)",
    tagline: "How many weights share one scale; smaller groups are more accurate but add overhead.",
    what: "Quantized formats split each row of weights into small groups (often 32, 64 or 128 values). Each group gets its own scale, and sometimes an offset, so it can track the local range of its values.",
    why: "Smaller groups follow the data more closely and preserve quality, especially at low bit-widths, but every group adds a few bytes of overhead and can slow kernels slightly.",
    technical: "Overhead per weight = (bits for scale + offset) / group size. With a 16-bit scale and 16-bit offset: group 32 adds 1.0 bpw, group 64 adds 0.5 bpw, group 128 adds 0.25 bpw. GGUF fixes the group layout per type (32 for legacy quants, 256-weight super-blocks for K-quants); MLX exposes it as `--q-group-size`; ONNX Model Builder as `block_size`.",
    related: ["concept.bpw", "concept.scale_zero_point", "mlx.group_size.64", "onnx.opt.block_size"],
  },

  "concept.scale_zero_point": {
    title: "Scale and zero point",
    tagline: "The two numbers that map small stored integers back to real weight values.",
    what: "Each group of quantized weights stores a scale (how big one step is) and optionally a zero point or bias (where the range starts). The real value is roughly code x scale + offset.",
    why: "They are what make 4-bit storage usable: without per-group scales, a handful of large weights would force a coarse step size on everything else.",
    technical: "Asymmetric (affine) quantization: w = scale x (q - zero_point), or in MLX's formulation w = scale x q + bias. Symmetric quantization drops the offset and centres the range on zero: w = scale x q. Scales are usually stored in FP16; microscaling formats such as MXFP4 store a shared 8-bit power-of-two exponent instead.",
    related: ["concept.symmetric", "concept.group_size", "concept.quantization"],
  },

  "concept.symmetric": {
    title: "Symmetric vs asymmetric",
    tagline: "Whether the quantized range is centred on zero (symmetric) or shifted to fit the data.",
    what: "Symmetric quantization uses a range like -7..+7 around zero with only a scale. Asymmetric (affine) quantization also stores an offset so the range can sit wherever the values actually are.",
    why: "Asymmetric uses the available codes more efficiently when a group's values are not centred on zero, which can help quality at low bits. Symmetric is simpler, slightly smaller and often faster.",
    technical: "In ONNX Runtime's MatMulNBits, symmetric gives signed int4 with an implicit zero point; asymmetric gives uint4 with an explicit zero point per block. GGUF Q4_0/Q5_0/Q8_0 are scale-only, while Q4_1/Q5_1 add a minimum; MLX affine mode stores a scale and a bias per group.",
    related: ["concept.scale_zero_point", "onnx.opt.is_symmetric", "mlx.mode.affine"],
  },

  "concept.calibration": {
    title: "Calibration data",
    tagline: "Sample text run through the model so the quantizer knows which weights matter most.",
    what: "Some quantization methods first run a few hundred or thousand short pieces of text through the full-precision model and record how strongly each part of the network is used.",
    why: "With that information the quantizer spends its precision where it matters, which improves quality, especially at 2-3 bits. The trade-off is extra time and memory, and a slight bias toward the kind of text you calibrated on.",
    technical: "Used by llama.cpp's importance matrix, AWQ, GPTQ, MLX DWQ and dynamic quantization, and ONNX GPTQ. Generic web or Wikipedia text is a safe default; for specialised models (code, a particular language) calibration text in that domain usually helps. Very small or repetitive calibration sets can make results worse.",
    related: ["concept.imatrix", "concept.awq", "concept.gptq", "calib.size", "calib.wikitext2"],
  },

  "concept.imatrix": {
    title: "Importance matrix (imatrix)",
    tagline: "llama.cpp's record of which weights matter most, used to quantize them more carefully.",
    what: "An importance matrix is a file produced by `llama-imatrix` from calibration text. It records how strongly each input channel of each weight matrix is activated.",
    why: "`llama-quantize` uses it to minimise error where it matters most. It noticeably improves 2-4 bit quants, and llama-quantize refuses the lowest-bit types (IQ1_S, IQ1_M, IQ2_XXS, IQ2_XS, IQ2_S, IQ2_M, IQ3_XXS, IQ3_XS and Q2_K_S) without one.",
    technical: "For each matrix, `llama-imatrix` accumulates the mean squared activation of every input column. During quantization these values weight the error term when choosing scales and codes, so frequently large inputs are reproduced more faithfully. Recent builds save imatrix files in GGUF format by default (`--output-format gguf`; legacy `.dat` is still available).",
    related: ["gguf.opt.imatrix", "gguf.tool.imatrix", "concept.calibration", "concept.iquants"],
    learnMore: [{ label: "llama.cpp imatrix README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/imatrix" }],
  },

  "concept.mixed_precision": {
    title: "Mixed precision",
    tagline: "Giving sensitive parts of the model more bits and the rest fewer.",
    what: "Instead of using one bit-width everywhere, a mixed scheme keeps a few sensitive tensors (such as attention value projections, FFN down projections, embeddings and the output head) at higher precision.",
    why: "A few percent extra size often buys a large share of the lost quality back. Most good presets (GGUF K-quant _M/_L mixes, MLX mixed recipes) are mixed precision under the hood.",
    technical: "llama.cpp's Q4_K_M and Q5_K_M mixes upgrade attn_v and ffn_down to Q6_K in roughly half the layers (the first and last eighth plus every third layer in between), and K-quant mixes usually store output.weight at Q6_K. MLX's `mixed_*` predicates follow a similar rule for v_proj and down_proj. ONNX Model Builder exposes `matmul_mixed_precision` for int4/int8 mixes.",
    related: ["concept.kquants", "gguf.opt.tensor_type", "mlx.recipe.mixed_4_6", "onnx.opt.matmul_mixed_precision"],
  },

  "concept.outliers": {
    title: "Outliers",
    tagline: "Rare very large values that make low-bit quantization harder.",
    what: "LLMs contain a small number of weights and activation channels with values far larger than the rest.",
    why: "If one group has an outlier, its scale must stretch to cover it, leaving fewer distinct steps for all the normal values in that group. Smaller groups, importance weighting and mixed precision all exist largely to handle outliers.",
    technical: "Activation outliers concentrate in a few hidden-dimension channels; AWQ rescales those channels before quantizing, GPTQ compensates errors using second-order statistics, and the imatrix weights errors by activation energy. Outliers are also why per-tensor int8 activation quantization can hurt LLMs while per-group weight-only quantization works well.",
    related: ["concept.group_size", "concept.awq", "concept.imatrix", "concept.mixed_precision"],
  },

  "concept.ptq_vs_qat": {
    title: "PTQ vs QAT",
    tagline: "Quantizing a finished model (PTQ) vs training it to expect quantization (QAT).",
    what: "Post-training quantization (PTQ) compresses an already-trained model, optionally using calibration data. Quantization-aware training (QAT) simulates quantization during training or fine-tuning so the model learns to tolerate it.",
    why: "Everything iQuantize does is PTQ: fast and needs no training. QAT can give better low-bit quality, but it needs training data, GPUs and time. Some vendors publish QAT checkpoints; quantizing those to the format they were trained for works especially well.",
    technical: "Methods like MLX DWQ sit in between: they keep the quantized weights fixed and fine-tune only the quantization parameters (scales and biases) by distilling from the full-precision model.",
    related: ["concept.quantization", "concept.calibration", "concept.dwq"],
  },

  "concept.weight_only": {
    title: "Weight-only quantization",
    tagline: "Only the stored weights are compressed; the runtime math still uses 16- or 32-bit values.",
    what: "In weight-only schemes the model's weights are stored in low precision, but during inference they are expanded back to a higher precision before being multiplied with the activations.",
    why: "It captures most of the size and speed benefit for local LLM inference (which is limited by memory bandwidth) without the accuracy risk of also quantizing activations.",
    technical: "GGUF and MLX quantization are weight-only (llama.cpp's CPU path may quantize activations to 8-bit internally for dot products). ONNX int4 via MatMulNBits is weight-only, and `accuracy_level` controls the precision of the activation side. ONNX dynamic int8 is different: it quantizes activations on the fly too.",
    related: ["concept.quantization", "onnx.opt.accuracy_level", "onnx.b.int8_dynamic"],
  },

  "concept.kv_cache": {
    title: "KV cache",
    tagline: "Memory the model uses to remember the conversation so far; grows with context length.",
    what: "While generating, the model stores attention keys and values for every past token so it does not recompute them. This store is the KV cache.",
    why: "It needs memory on top of the weights and grows linearly with context length. For long contexts it can rival the size of a small model, so it matters when checking whether a model fits.",
    technical: "Size = 2 (K and V) x layers x KV heads x head dimension x context tokens x bytes per element. Example: Llama-3-8B (32 layers, 8 KV heads, head dim 128) at FP16 needs 2 x 32 x 8 x 128 x 2 bytes = 128 KiB per token, so 8,192 tokens take about 1 GiB. Grouped-query attention (fewer KV heads) and quantized KV caches (for example llama.cpp `--cache-type-k q8_0`) reduce it; sliding-window and hybrid architectures change the formula.",
    related: ["concept.context_length", "concept.attention", "concept.memory_budget", "goal.recommendation"],
  },

  "concept.context_length": {
    title: "Context length",
    tagline: "How many tokens of text the model can consider at once.",
    what: "The context window is the maximum number of tokens (prompt plus reply) the model can attend to. Each model has a trained maximum; you can run with a smaller one.",
    why: "Longer context lets you paste whole documents or keep long chats, but costs KV cache memory and slows prompt processing. Choosing the context you actually need is one of the easiest ways to make a model fit.",
    technical: "A token is roughly three quarters of an English word on typical tokenizers. llama.cpp tools default to a context of 512 for perplexity and imatrix runs (`-c`), but servers and chat apps usually allocate thousands of tokens. Quantization damage tends to show more on long-context retrieval than on short prompts.",
    related: ["concept.kv_cache", "goal.context", "eval.ctx", "concept.tokenizer"],
  },

  "concept.params": {
    title: "Parameters (model size)",
    tagline: "The number of weights in the model, e.g. '8B' means about 8 billion.",
    what: "Parameters are the learned numbers inside the model. The count in a model's name (0.5B, 8B, 70B) is the main driver of its memory needs and, roughly, its capability.",
    why: "Memory for weights is about parameters x bytes per weight: an 8B model is about 16 GB at 16-bit and about 4.5-5 GB at 4-bit. A larger model at 4-bit often beats a smaller model at 8-bit for the same memory.",
    technical: "Counts usually include embeddings. For mixture-of-experts models, distinguish total parameters (what must be stored) from active parameters (what is used per token, which drives speed).",
    related: ["concept.bpw", "concept.moe", "concept.memory_budget"],
  },

  "concept.moe": {
    title: "Mixture of Experts (MoE)",
    tagline: "A model with many expert sub-networks, of which only a few run for each token.",
    what: "An MoE model replaces each feed-forward block with many parallel 'experts' and a small router that picks a few of them per token.",
    why: "All experts must be stored, so memory follows the total parameter count, but each token only uses the active experts, so speed is closer to a much smaller model. Expert weights are usually the bulk of the file, making them the main target for quantization.",
    technical: "Example (approximate, as published): Mixtral 8x7B has about 46.7B total and 12.9B active parameters per token; gpt-oss-20b has about 21B total and 3.6B active. In GGUF, experts are stored as stacked 3D tensors (`ffn_*_exps`); llama.cpp's MXFP4_MOE type targets exactly these.",
    related: ["concept.params", "concept.ffn", "gguf.qtype.MXFP4_MOE", "concept.mxfp4"],
  },

  "concept.embeddings": {
    title: "Token embeddings",
    tagline: "The lookup table that turns each token ID into a vector at the model's input.",
    what: "The embedding table has one row per vocabulary token. The model's first step is to look up the row for each input token.",
    why: "With large vocabularies (150k-250k tokens) this table can be a sizeable share of a small model. It tolerates quantization fairly well because only a few rows are used per token, but some people keep it at 8-bit for safety.",
    technical: "In GGUF this is `token_embd.weight`; in Hugging Face models usually `model.embed_tokens`. Override its type with `--token-embedding-type` in llama-quantize. Some models tie it to the output head.",
    related: ["concept.lm_head", "concept.tied_embeddings", "gguf.opt.token_embedding_type", "concept.tokenizer"],
  },

  "concept.lm_head": {
    title: "Output head (lm_head)",
    tagline: "The final layer that scores every vocabulary token to choose the next one.",
    what: "The output head is a large matrix that turns the model's final hidden state into a score for each token in the vocabulary.",
    why: "Errors here directly change which word gets picked, so it is one of the most quantization-sensitive tensors. Most good presets keep it at higher precision (GGUF K-quant mixes typically use Q6_K for it).",
    technical: "In GGUF it is `output.weight` (overridable with `--output-tensor-type` or kept as-is with `--leave-output-tensor`). In Hugging Face models it is `lm_head`. If the model ties embeddings, the head reuses the embedding table and there may be no separate tensor.",
    related: ["concept.embeddings", "concept.tied_embeddings", "gguf.opt.output_tensor_type", "gguf.opt.leave_output_tensor"],
  },

  "concept.attention": {
    title: "Attention layers",
    tagline: "The part of each layer that lets every token look back at earlier tokens.",
    what: "Attention computes queries, keys and values from each token and uses them to mix in information from earlier context. Its weights are the q, k, v and output projections.",
    why: "The value projection (attn_v / v_proj) is known to be quantization-sensitive, which is why many mixes give it extra bits. Keys and values are also what fill the KV cache.",
    technical: "GGUF tensor names: `attn_q`, `attn_k`, `attn_v`, `attn_output` (or a fused `attn_qkv`). Hugging Face names: `q_proj`, `k_proj`, `v_proj`, `o_proj`. With grouped-query attention there are fewer K/V heads than query heads, shrinking attn_k/attn_v and the KV cache.",
    related: ["concept.kv_cache", "concept.ffn", "gguf.preset.protect_sensitive"],
  },

  "concept.ffn": {
    title: "Feed-forward network (FFN / MLP)",
    tagline: "The per-token 'thinking' block in each layer; holds most of a model's weights.",
    what: "After attention, each layer passes every token through a feed-forward network, usually gate, up and down projections. These matrices make up roughly two-thirds of a typical dense model's weights.",
    why: "Because they dominate the file size, FFN weights drive the size of the quantized model. The down projection (ffn_down / down_proj) is more sensitive and is commonly kept at higher precision.",
    technical: "GGUF names: `ffn_gate`, `ffn_up`, `ffn_down`; MoE models add stacked expert tensors `ffn_gate_exps`, `ffn_up_exps`, `ffn_down_exps`. Hugging Face names: `gate_proj`, `up_proj`, `down_proj`.",
    related: ["concept.attention", "concept.moe", "gguf.preset.protect_sensitive"],
  },

  "concept.norms": {
    title: "Normalization weights",
    tagline: "Tiny but important scaling vectors that are always kept at full precision.",
    what: "Normalization layers (RMSNorm or LayerNorm) rescale activations between blocks. Their weights are small one-dimensional vectors.",
    why: "They are a negligible fraction of the size and very sensitive, so every format keeps them in 32-bit or 16-bit float. You never need to choose a type for them.",
    technical: "llama.cpp's converter stores 1-D tensors such as `attn_norm` and `ffn_norm` as F32 regardless of `--outtype`, and llama-quantize only quantizes 2-D (and stacked 3-D) weight matrices.",
    related: ["concept.attention", "concept.ffn"],
  },

  "concept.tied_embeddings": {
    title: "Tied embeddings",
    tagline: "The model reuses its input embedding table as the output head to save space.",
    what: "Some models, especially small ones, share one matrix between the input embeddings and the output head (`tie_word_embeddings: true` in config.json).",
    why: "It saves a lot of memory in small models with big vocabularies. When quantizing, that one shared matrix affects both reading and writing tokens, so it deserves decent precision.",
    technical: "In GGUF, tied models may have no separate `output.weight`; llama.cpp then uses `token_embd.weight` for both, and llama-quantize gives it the output-tensor treatment (for example Q6_K in K-quant mixes). ONNX Model Builder's `shared_embeddings` option only applies when the model is tied.",
    related: ["concept.embeddings", "concept.lm_head", "onnx.opt.shared_embeddings"],
  },

  "concept.requantize": {
    title: "Requantizing",
    tagline: "Quantizing a model that is already quantized: possible, but errors stack up.",
    what: "Requantizing means converting an already-quantized model (for example Q8_0) into another quantized type (for example Q4_K_M) instead of starting from the 16-bit original.",
    why: "Each step adds rounding error, so the result is worse than quantizing directly from the original. Only do it when the full-precision weights are not available.",
    technical: "llama-quantize refuses quantized inputs unless you pass `--allow-requantize`, and warns that quality can be severely reduced. Q8_0 inputs lose little; starting from 4-bit or lower is much worse.",
    related: ["gguf.opt.allow_requantize", "concept.already_quantized", "gguf.base.Q8_0"],
  },

  "concept.safetensors": {
    title: "Safetensors",
    tagline: "The standard, safe file format for original Hugging Face model weights.",
    what: "Safetensors is a simple file format that stores raw tensors plus a small JSON header. Large models are split across several `model-0000X-of-0000N.safetensors` files with an index.",
    why: "It is the usual input for all three conversion paths. Unlike older pickle-based `.bin` files, loading it cannot run hidden code.",
    technical: "The index file `model.safetensors.index.json` maps each tensor name to a shard. Files are memory-mappable, which keeps conversion memory usage manageable.",
    related: ["concept.sharding", "concept.dtype", "format.gguf"],
    learnMore: [{ label: "Safetensors documentation", url: "https://huggingface.co/docs/safetensors/index" }],
  },

  "concept.tokenizer": {
    title: "Tokenizer",
    tagline: "The component that splits text into the token IDs the model actually reads.",
    what: "A tokenizer turns text into numbered tokens (word pieces) and back. Each model ships its own tokenizer files, such as tokenizer.json.",
    why: "The converted model must use exactly the same tokenizer as the original, or it will produce garbage. Converters copy it automatically, and a missing or custom tokenizer is a common reason conversions fail.",
    technical: "GGUF embeds the vocabulary, merges and special tokens in its metadata (`tokenizer.ggml.*`). MLX and ONNX outputs keep the Hugging Face tokenizer files alongside the weights.",
    related: ["concept.chat_template", "concept.embeddings", "concept.context_length"],
  },

  "concept.chat_template": {
    title: "Chat template",
    tagline: "The exact text layout a chat model expects for system, user and assistant turns.",
    what: "Instruction-tuned models are trained on conversations wrapped in special markers. The chat template, usually a Jinja template in the tokenizer config, recreates that layout.",
    why: "If the template is lost or wrong, the model may ramble, ignore instructions or never stop. A broken template often looks like quantization damage, so check it first when outputs look odd.",
    technical: "GGUF stores it in `tokenizer.chat_template`; llama.cpp, LM Studio and Ollama read it from there (Ollama may also use its own template in a Modelfile). MLX keeps `tokenizer_config.json` or `chat_template.jinja`; ONNX Runtime GenAI reads the Hugging Face tokenizer files.",
    related: ["concept.tokenizer", "gguf.opt.override_kv", "eval.system_prompt"],
  },

  "concept.revision": {
    title: "Revision",
    tagline: "Which version of a Hugging Face repo to use: a branch, tag or commit hash.",
    what: "Hugging Face repos are versioned like Git. A revision pins the exact files you download, for example `main` or a specific commit.",
    why: "Repos can change after you quantize. Recording the commit hash makes your results reproducible and lets the model card say exactly what you started from.",
    technical: "Branch names move; commit hashes never change. Even when you pick a branch, the commit it pointed to at download time is the value to record for provenance.",
    related: ["hub.revision", "ai.provenance", "hub.model_card"],
  },

  "concept.gated": {
    title: "Gated models",
    tagline: "Models that require you to accept terms on Hugging Face before downloading.",
    what: "Some publishers gate their repos: you must be logged in and click to accept a licence or share contact details, sometimes with manual approval.",
    why: "Downloads fail with an authorization error until access is granted to the account that owns your token. The app cannot accept terms for you.",
    technical: "Access is per account. Your token must belong to that account and have at least read access (fine-grained tokens need permission for gated repos you can access). Derivatives you publish usually must respect the original licence.",
    related: ["hub.gated", "hub.token", "concept.license"],
  },

  "concept.license": {
    title: "Licence",
    tagline: "The legal terms for using and redistributing a model and its quantized copies.",
    what: "Every model has a licence such as Apache-2.0, MIT, or a custom community licence. A quantized copy is a derivative of the original.",
    why: "Before publishing a quantized model, check that the licence allows redistribution and whether it requires attribution, the same licence, or naming rules. When in doubt, copy the original licence and link to the source.",
    technical: "Hugging Face model cards declare it in YAML front-matter (`license:`; custom licences use `license: other` plus `license_name` and `license_link`).",
    related: ["hub.license", "concept.gated", "hub.model_card"],
  },

  "concept.sharding": {
    title: "Sharding (split files)",
    tagline: "Splitting one big model into several numbered files.",
    what: "Large models are stored as several shards, such as `model-00001-of-00004.safetensors` or `model-00001-of-00003.gguf`.",
    why: "Shards make downloads resumable and stay under per-file upload limits. Runtimes load all shards when you point them at the first one.",
    technical: "Hugging Face rejects single files over 50 GB, so the app splits GGUF output above 48 GB with `llama-gguf-split`. llama.cpp loads split GGUFs automatically when given the first shard; `--merge` recombines them.",
    related: ["gguf.tool.split", "gguf.opt.split_max_size", "hub.file_limit", "concept.safetensors"],
  },

  "concept.unified_memory": {
    title: "Unified memory",
    tagline: "Apple Silicon's single memory pool shared by CPU and GPU.",
    what: "On Apple Silicon Macs there is no separate video memory: the CPU and GPU use the same RAM.",
    why: "A Mac with lots of RAM can run large models on the GPU, but macOS limits how much of it the GPU may use (often around 70-75% on typical configurations) and the system and apps need the rest.",
    technical: "Metal reports a `recommendedMaxWorkingSetSize`; for example, a 24 GB M4 Pro reports about 19 GB (roughly 74%). The app budgets roughly 70-75% of RAM for GPU work by default. Advanced users can raise the limit with `sysctl iogpu.wired_limit_mb` (resets on reboot), at the risk of starving macOS.",
    related: ["hw.device.apple_silicon", "concept.memory_budget", "concept.vram", "hw.ram"],
  },

  "concept.vram": {
    title: "VRAM (GPU memory)",
    tagline: "Dedicated memory on a graphics card; the model must fit here to run at full speed.",
    what: "Discrete GPUs from NVIDIA, AMD and Intel have their own memory. Weights, the KV cache and working buffers must fit there for fully accelerated inference.",
    why: "If a model does not fit, llama.cpp can keep some layers in system RAM (partial offload), which works but is much slower. VRAM is usually the tightest constraint when choosing a quant.",
    technical: "Budget = weights + KV cache + compute buffers + runtime/driver overhead (a few hundred MB to over 1 GB). On systems with several GPUs, llama.cpp can split layers across them.",
    related: ["concept.memory_budget", "concept.unified_memory", "hw.device.nvidia", "concept.kv_cache"],
  },

  "concept.memory_budget": {
    title: "Memory budget",
    tagline: "How much memory a model may use on your target device after leaving room for everything else.",
    what: "The memory budget is the usable memory for the model: GPU VRAM, or a share of unified memory on a Mac, or system RAM for CPU inference, minus a safety margin.",
    why: "The app compares each variant's estimated footprint against this budget to mark what fits comfortably, what is tight and what will not run.",
    technical: "Estimated footprint = weights (per-tensor params x bpw) + KV cache for your chosen context + runtime overhead. On Macs the GPU budget defaults to about 70-75% of unified memory. These are estimates; actual usage varies by runtime and settings.",
    related: ["goal.recommendation", "goal.memory", "concept.kv_cache", "concept.vram"],
  },

  "concept.disk_space": {
    title: "Disk space",
    tagline: "Quantizing temporarily needs several times the final model size on disk.",
    what: "A conversion keeps the downloaded original, a full-precision intermediate (GGUF) or converted copy, and every quantized output on disk at once.",
    why: "Running out of space mid-job wastes time. As a rough rule, plan for the original size plus the intermediate plus all variants you request; deleting intermediates afterwards frees most of it.",
    technical: "Example (approximate): an 8B BF16 original is about 16 GB, the F16 GGUF intermediate another 16 GB, and each 4-bit variant about 5 GB. The Hugging Face cache keeps downloads until cleared.",
    related: ["settings.keep_intermediates", "settings.hf_cache", "settings.workspace"],
  },

  "concept.awq": {
    title: "AWQ",
    tagline: "Activation-aware quantization: protects the weights that see the largest inputs.",
    what: "Activation-aware Weight Quantization (MIT Han Lab, 2023) uses calibration data to find the input channels with the largest activations and rescales weights so those channels lose less precision.",
    why: "It improves 3-4 bit quality over plain rounding at modest cost. It needs calibration data and enough memory to run the full-precision model.",
    technical: "AWQ searches per-channel scaling factors s, multiplying salient weight columns by s and dividing the preceding activations by s (folded into the previous layer), so the quantization error lands on less important channels. Available in MLX as `mlx_lm.awq`.",
    related: ["mlx.method.awq", "concept.calibration", "concept.gptq", "concept.outliers"],
    learnMore: [{ label: "AWQ paper (arXiv)", url: "https://arxiv.org/abs/2306.00978" }],
  },

  "concept.gptq": {
    title: "GPTQ",
    tagline: "Quantizes weights one at a time while adjusting the rest to cancel the error.",
    what: "GPTQ (Frantar et al., 2022) quantizes each layer column by column, using calibration data to estimate how errors propagate and updating the not-yet-quantized weights to compensate.",
    why: "It is one of the most accurate calibration-based methods at 3-4 bits, but slower than simple rounding and it needs calibration data.",
    technical: "Uses an approximate inverse Hessian (from X X^T of calibration activations) to perform optimal-brain-surgeon-style error compensation per layer. Implemented in MLX (`mlx_lm.gptq`) and in ONNX Runtime's MatMulNBits quantizer (GPTQ config with a calibration data reader).",
    related: ["mlx.method.gptq", "onnx.b.int4_gptq", "concept.calibration", "concept.awq"],
    learnMore: [{ label: "GPTQ paper (arXiv)", url: "https://arxiv.org/abs/2210.17323" }],
  },

  "concept.hqq": {
    title: "HQQ",
    tagline: "Half-Quadratic Quantization: better scales and zero points without calibration data.",
    what: "HQQ optimises each group's scale and zero point to minimise weight error directly, using a fast solver and no calibration text.",
    why: "It is quick and data-free while usually beating plain round-to-nearest, which makes it a good default when you don't have suitable calibration data.",
    technical: "Formulated as a sparsity-promoting loss solved with a half-quadratic splitting method; it optimises the zero point (and optionally scale) per group. Available in ONNX Runtime as `HQQWeightOnlyQuantConfig`.",
    related: ["onnx.b.int4_hqq", "concept.rtn", "concept.scale_zero_point"],
  },

  "concept.rtn": {
    title: "RTN (round-to-nearest)",
    tagline: "The simplest quantization: scale each group and round every weight to the nearest step.",
    what: "Round-to-nearest picks a scale for each group from its minimum and maximum, then rounds each weight to the closest representable value. No calibration data is involved.",
    why: "It is fast and deterministic, and at 8 bits or 5-6 bits it is usually all you need. At 4 bits and below, smarter methods (imatrix, AWQ, GPTQ, HQQ, DWQ) recover noticeable quality.",
    technical: "Plain `mlx_lm.convert` and ONNX `rtn` are RTN with per-group scales. llama.cpp's quantizers without an imatrix are not pure RTN: K-quants search for good scales per block, which is one reason they beat naive rounding.",
    related: ["concept.hqq", "concept.gptq", "mlx.method.convert", "onnx.algo.rtn"],
  },

  "concept.dwq": {
    title: "DWQ (distilled weight quantization)",
    tagline: "MLX technique that fine-tunes quantization scales so the small model mimics the original.",
    what: "DWQ starts from a normally quantized MLX model and then trains only its scales and biases, using the full-precision model as a teacher on calibration text.",
    why: "It often makes a 3- or 4-bit MLX model noticeably closer to the original. It is the slowest MLX method and needs memory for both the teacher and the student model.",
    technical: "The loss is the KL divergence between the teacher's and student's next-token distributions. The quantized integer weights stay fixed; scales and biases are learned. Run via `mlx_lm.dwq`.",
    related: ["mlx.method.dwq", "concept.ptq_vs_qat", "eval.kld", "concept.calibration"],
  },

  "concept.kquants": {
    title: "K-quants",
    tagline: "llama.cpp's main quant family (Q2_K-Q6_K): smart block scales, fast everywhere.",
    what: "K-quants are GGUF types that group weights into 256-weight super-blocks made of smaller sub-blocks, each with its own quantized scale (and minimum for some types).",
    why: "They give much better quality per bit than the older Q4_0/Q5_0 types and run fast on every backend. The _S/_M/_L presets mix types across tensors for extra quality.",
    technical: "Nominal per-type costs from the block layouts: Q2_K about 2.63 bpw, Q3_K about 3.44, Q4_K 4.5, Q5_K 5.5, Q6_K about 6.56. File types like Q4_K_M use these per tensor according to llama.cpp's rules (for example Q6_K for output.weight and for attn_v/ffn_down in about half the layers). An imatrix improves K-quants too, especially Q2_K and Q3_K.",
    related: ["gguf.qtype.Q4_K_M", "concept.iquants", "concept.mixed_precision", "concept.imatrix"],
    learnMore: [{ label: "llama.cpp quantize README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/quantize" }],
  },

  "concept.iquants": {
    title: "I-quants",
    tagline: "llama.cpp's codebook-based quants (IQ1-IQ4) for the best quality at very low bit-widths.",
    what: "I-quants map groups of weights to entries in carefully designed codebooks (lattices) instead of evenly spaced levels.",
    why: "At 2-3.5 bpw they usually beat K-quants of similar size. The trade-offs: they really want an importance matrix, and on some CPUs and older backends they run slower than K-quants.",
    technical: "IQ2/IQ3 types use lattice-based codebooks (IQ2 builds on the E8 lattice); IQ4_NL/IQ4_XS use a non-linear 16-level grid. llama-quantize refuses IQ1_S, IQ1_M, IQ2_XXS, IQ2_XS, IQ2_S, IQ2_M, IQ3_XXS, IQ3_XS and Q2_K_S without `--imatrix`. GPU backends (CUDA, Metal) handle them well.",
    related: ["concept.imatrix", "concept.kquants", "gguf.qtype.IQ4_XS", "gguf.qtype.IQ2_M"],
  },

  "concept.ternary": {
    title: "Ternary weights",
    tagline: "Weights limited to -1, 0 or +1: tiny, but only for models trained that way.",
    what: "Ternary (about 1.58-bit) models, such as BitNet b1.58-style models, are trained so every weight is -1, 0 or +1 times a scale.",
    why: "For these special models, ternary GGUF types (TQ1_0, TQ2_0) are nearly lossless and very small. Applying them to a normal model destroys it.",
    technical: "log2(3) is about 1.58 bits of information per weight. llama.cpp packs ternary values in TQ1_0 (1.69 bpw, tighter packing) and TQ2_0 (2.06 bpw, 2 bits per value, simpler and usually faster). The converter can emit them directly with `--outtype tq1_0` or `tq2_0` for supported architectures.",
    related: ["gguf.qtype.TQ1_0", "gguf.qtype.TQ2_0", "concept.ptq_vs_qat"],
  },

  "concept.mxfp4": {
    title: "MXFP4",
    tagline: "A standard 4-bit float format with one shared scale per 32 values (about 4.25 bpw).",
    what: "MXFP4 is the Open Compute Project's microscaling 4-bit floating-point format: each value is a tiny E2M1 float, and every block of 32 values shares one 8-bit power-of-two scale.",
    why: "It is a hardware-friendly industry format; OpenAI released gpt-oss with its MoE weights in MXFP4. Quality is generally a bit below the best integer 4-bit schemes with smaller groups or importance weighting, but it is compact and well supported on new hardware.",
    technical: "Cost: 4 bits per element + 8 bits per 32-element block = 4.25 bpw. The E8M0 scale is a pure power of two. Supported as GGUF MXFP4 (used by the MXFP4_MOE file type) and MLX `--q-mode mxfp4` (group size fixed at 32).",
    related: ["concept.nvfp4", "gguf.qtype.MXFP4_MOE", "mlx.mode.mxfp4", "concept.fp8"],
  },

  "concept.nvfp4": {
    title: "NVFP4",
    tagline: "NVIDIA's 4-bit float format with an FP8 scale per 16 values (about 4.5 bpw).",
    what: "NVFP4 also stores E2M1 4-bit floats, but uses smaller 16-value blocks and a more precise FP8 (E4M3) scale per block, plus a per-tensor scale.",
    why: "Smaller blocks and finer scales usually make it more accurate than MXFP4 at a slightly higher size. NVIDIA Blackwell GPUs accelerate it natively.",
    technical: "Cost: 4 + 8/16 = 4.5 bpw (plus a negligible per-tensor FP32 scale). Available in MLX via `--q-mode nvfp4` (group size fixed at 16).",
    related: ["concept.mxfp4", "mlx.mode.nvfp4", "concept.fp8"],
  },

  "concept.fp8": {
    title: "FP8",
    tagline: "8-bit floating point, used for weights and math on recent datacenter GPUs.",
    what: "FP8 comes in two variants: E4M3 (more precision) and E5M2 (more range). Some models are published directly in FP8.",
    why: "FP8 roughly halves size versus BF16 with little quality loss, and it is natively accelerated on recent NVIDIA GPUs. For local formats you usually convert from FP8 back to 16-bit first, then quantize.",
    technical: "FP8 checkpoints store per-tensor or per-block scales next to the weights (for example `weight_scale_inv` tensors). MXFP8 (MLX `--q-mode mxfp8`) is the microscaling variant: E4M3 elements with a shared 8-bit scale per 32 values, about 8.25 bpw.",
    related: ["concept.already_quantized", "mlx.mode.mxfp8", "concept.mxfp4", "concept.dtype"],
  },

  "concept.already_quantized": {
    title: "Already-quantized source",
    tagline: "The model you picked is already compressed (GPTQ, AWQ, FP8, MXFP4, GGUF...).",
    what: "Some Hugging Face repos contain quantized weights rather than the 16-bit original, indicated by a `quantization_config` in config.json or by the repo name.",
    why: "Quantizing again stacks errors, and many converters cannot read every pre-quantized format. If possible, choose the original 16-bit repo (often linked as the base model) instead.",
    technical: "llama.cpp's converter can dequantize some formats during conversion (for example certain FP8 checkpoints) and keeps gpt-oss's MXFP4 experts as MXFP4, but support varies by format and version. mlx-lm and ONNX Model Builder generally expect float weights. A `quantization_config` section in config.json is the telltale sign.",
    related: ["concept.requantize", "concept.fp8", "concept.mxfp4", "hub.base_model_relation"],
  },
};
