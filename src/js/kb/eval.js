// Evaluation: metrics, generation settings and datasets.
const PPL_README = { label: "llama.cpp perplexity README", url: "https://github.com/ggml-org/llama.cpp/tree/master/tools/perplexity" };

export default {
  "eval.reference": {
    title: "Reference model",
    tagline: "The unquantized (or highest-precision) model every variant is compared against.",
    what: "The baseline for all comparisons, usually the 16-bit original or, if that does not fit, a Q8_0 or 8-bit copy.",
    why: "Metrics like KLD, top-1 agreement and divergence are measured relative to this model, so a good reference makes the numbers meaningful.",
    technical: "Using Q8_0 as the reference is common when BF16 does not fit; its own deviation (+0.0026 ppl @ Llama-3-8B per llama-quantize) is far smaller than typical 4-bit differences.",
    related: ["eval.kld", "eval.divergence", "gguf.qtype.Q8_0"],
  },

  "eval.ppl": {
    title: "Perplexity (PPL)",
    tagline: "How surprised the model is by real text; lower is better.",
    what: "Perplexity measures how well a model predicts each next token of a test text. It is the exponential of the average negative log-probability of the correct tokens.",
    why: "A quick, standard health check: a quantized model's perplexity should be close to the reference's. Small differences are hard to interpret, which is why KLD is often more informative.",
    technical: "PPL = exp(-(1/N) sum log p(token_i | context)). Only compare numbers produced with the same text, tokenizer, context size and chunk count. llama-perplexity reports a running estimate with an uncertainty.",
    related: ["eval.kld", "eval.dataset.wikitext2", "gguf.tool.perplexity"],
    learnMore: [PPL_README],
  },

  "eval.kld": {
    title: "KL divergence (KLD)",
    tagline: "How different the quantized model's predictions are from the reference's; 0 means identical.",
    what: "At every position, KLD compares the full probability distribution over next tokens from the quantized model with the reference model's, then averages.",
    why: "More sensitive than perplexity: two models can have similar perplexity yet disagree on many tokens. It is the best single number for 'how much did quantization change this model'.",
    technical: "KL(P_ref || P_quant) = sum_t P_ref(t) log(P_ref(t) / P_quant(t)), averaged over tokens. For GGUF, llama-perplexity computes it over the full vocabulary: first `--kl-divergence-base base.kld` with the reference to save logits, then `--kl-divergence-base base.kld --kl-divergence` for each variant. It reports mean, median and high percentiles; the high percentiles reveal rare big mistakes.",
    related: ["eval.kld_topk", "eval.top1", "eval.delta_p", "eval.reference"],
    learnMore: [PPL_README],
  },

  "eval.top1": {
    title: "Top-1 agreement",
    tagline: "How often the quantized model's most likely next token matches the reference's.",
    what: "The percentage of positions where both models rank the same token first.",
    why: "Easy to understand: with greedy decoding, every disagreement is a point where the text could change. 100% means identical greedy output on this text.",
    technical: "llama-perplexity reports it as 'Same top p'.",
    related: ["eval.kld", "eval.divergence", "eval.delta_p"],
  },

  "eval.delta_p": {
    title: "Delta p",
    tagline: "Change in the probability given to the correct next token, quantized vs reference.",
    what: "For each position, the difference between the quantized and reference model's probability for the token that actually comes next.",
    why: "A negative mean means the quantized model is, on average, less confident about the right answer. Its spread shows how often large swings happen.",
    technical: "llama-perplexity reports mean, RMS and percentiles of delta p (as percentages) in KL-divergence mode.",
    related: ["eval.kld", "eval.top1"],
  },

  "eval.speed_pp": {
    title: "Prompt processing speed",
    tagline: "How fast the model reads your input, in tokens per second.",
    what: "The rate at which the model processes the prompt before it starts answering.",
    why: "Matters for long prompts, documents and RAG: it largely determines time to first token. It is compute-bound, so it depends on GPU or CPU power more than on file size.",
    technical: "llama-bench reports this as pp512 (512-token prompt) by default.",
    related: ["eval.speed_tg", "eval.ttft", "gguf.tool.bench"],
  },

  "eval.speed_tg": {
    title: "Generation speed",
    tagline: "How fast the model writes its answer, in tokens per second.",
    what: "The rate of producing new tokens, one at a time.",
    why: "This is what you feel while reading a reply. It is mostly limited by memory bandwidth, so smaller quants are usually faster.",
    technical: "llama-bench reports this as tg128 (128 generated tokens) by default.",
    related: ["eval.speed_pp", "concept.bpw", "gguf.tool.bench"],
  },

  "eval.ttft": {
    title: "Time to first token",
    tagline: "Delay between sending a prompt and seeing the first word of the reply.",
    what: "Measured from the request to the first generated token; includes prompt processing and any model warm-up.",
    why: "Determines how responsive the model feels, especially with long prompts.",
    technical: "Roughly prompt length / prompt processing speed, plus overhead. The first request after loading can be slower.",
    related: ["eval.speed_pp", "eval.speed_tg"],
  },

  "eval.peak_mem": {
    title: "Peak memory",
    tagline: "The most memory a variant used while running the tests.",
    what: "The highest memory use observed for the runtime process during evaluation.",
    why: "Confirms whether a variant really fits your target device, including KV cache and buffers, not just the file size.",
    technical: "Measured on this machine with the evaluation's context size; other runtimes and settings will differ.",
    related: ["concept.memory_budget", "goal.recommendation", "eval.ctx"],
  },

  "eval.exact_match": {
    title: "Exact match",
    tagline: "Whether the answer equals the expected reference answer.",
    what: "Compares the model's final answer with the suite's reference answer, typically after normalising case, whitespace and punctuation.",
    why: "Objective and strict: good for math, facts and short answers. It cannot judge open-ended text.",
    technical: "Prompts with a null reference are not scored by exact match.",
    related: ["eval.rouge_l", "eval.token_overlap", "eval.judge"],
  },

  "eval.rouge_l": {
    title: "ROUGE-L",
    tagline: "Similarity based on the longest shared word sequence; 1.0 means identical order and words.",
    what: "Measures how much of one text appears, in order, in the other, using the longest common subsequence of words.",
    why: "Useful for comparing a quantized model's output with the reference model's output on summaries and explanations.",
    technical: "Reported as an F-measure combining LCS-based precision and recall.",
    related: ["eval.token_overlap", "eval.exact_match"],
  },

  "eval.token_overlap": {
    title: "Token overlap",
    tagline: "Share of words the two answers have in common, ignoring order.",
    what: "Compares the bags of words in two answers and reports an F1-style overlap score.",
    why: "A forgiving similarity measure for answers that are worded differently but contain the same content.",
    related: ["eval.rouge_l", "eval.exact_match"],
  },

  "eval.judge": {
    title: "AI judge",
    tagline: "An AI model grades or compares answers when there is no single correct answer.",
    what: "Sends the prompt and the answers to an AI model (via your API key) and asks it to score or pick the better one.",
    why: "Scales human-like judgement to many prompts. Judges have biases (for example toward longer answers or whichever option comes first), so answer order should be randomised and scores treated as indicative.",
    technical: "Uses the AI provider configured in settings, so each judged prompt costs API tokens.",
    related: ["eval.vote", "ai.key", "ai.cost"],
  },

  "eval.vote": {
    title: "Your vote",
    tagline: "Pick the better of two answers yourself.",
    what: "A side-by-side comparison where you choose which answer is better (or a tie), ideally without knowing which variant wrote which.",
    why: "Your own judgement on your own prompts is the most relevant signal. Blind, randomised order reduces bias.",
    related: ["eval.judge", "eval.divergence"],
  },

  "eval.temperature": {
    title: "Temperature",
    tagline: "Randomness of generation: 0 is deterministic, higher is more varied.",
    what: "Scales the model's token probabilities before sampling. Low values pick the likeliest tokens; high values allow more surprising ones.",
    why: "For comparing quantized variants, use 0 (greedy) so differences come from the model, not chance. Raise it only to test creative output.",
    related: ["eval.top_p", "eval.seed", "eval.divergence"],
  },

  "eval.top_p": {
    title: "Top-p",
    tagline: "Sample only from the smallest set of tokens whose probabilities add up to p.",
    what: "Nucleus sampling: cuts off unlikely tokens before sampling.",
    why: "Only matters when temperature is above 0. Keep it identical across variants for a fair comparison.",
    related: ["eval.temperature", "eval.seed"],
  },

  "eval.seed": {
    title: "Seed",
    tagline: "Fixes the random number sequence so sampled runs can be repeated.",
    what: "A number that initialises the sampler's randomness.",
    why: "With the same seed and settings, a runtime usually reproduces the same output, which makes comparisons fairer. Different runtimes or hardware may still differ.",
    related: ["eval.temperature", "eval.top_p"],
  },

  "eval.max_tokens": {
    title: "Max tokens",
    tagline: "Upper limit on the length of each answer.",
    what: "The maximum number of tokens the model may generate per prompt.",
    why: "Prevents runaway answers and controls test time. Set it high enough that correct answers are not cut off, or exact-match scores will suffer.",
    related: ["eval.exact_match", "eval.ttft"],
  },

  "eval.system_prompt": {
    title: "System prompt",
    tagline: "Instructions given to the model before every test prompt.",
    what: "Text sent as the system message, using the model's chat template.",
    why: "Keep it identical across variants. Some suites set their own system prompt for specific prompts.",
    related: ["concept.chat_template", "eval.temperature"],
  },

  "eval.sequential": {
    title: "Run one model at a time",
    tagline: "Load and test variants one after another instead of all at once.",
    what: "Each variant is loaded, tested and unloaded before the next starts.",
    why: "Avoids running out of memory and keeps speed measurements fair, since models don't compete for the GPU. Takes longer overall.",
    related: ["eval.peak_mem", "settings.concurrency"],
  },

  "eval.dataset.wikitext2": {
    title: "WikiText-2",
    tagline: "The standard Wikipedia-based test text for perplexity and KLD.",
    what: "A public dataset of Wikipedia articles; its raw test split is the usual text for perplexity comparisons.",
    why: "Widely used, so results are comparable with others' numbers (when settings match). It is English encyclopedic text, so it under-represents code, chat and other languages.",
    technical: "llama.cpp's reference figures use `wiki.test.raw` from WikiText-2 raw.",
    related: ["eval.ppl", "eval.kld", "calib.wikitext2"],
  },

  "eval.chunks": {
    title: "Chunks",
    tagline: "How many context-sized pieces of the test text to score; more is slower but more precise.",
    what: "The test text is split into chunks of the context size; this limits how many are evaluated.",
    why: "Fewer chunks are faster but noisier. Use the same number for every variant.",
    technical: "`llama-perplexity --chunks N` (default -1 = all).",
    related: ["eval.ctx", "eval.ppl", "eval.kld"],
  },

  "eval.ctx": {
    title: "Evaluation context",
    tagline: "Tokens per chunk when measuring perplexity or KLD.",
    what: "The context size used for each scored chunk.",
    why: "512 is the common default and what most published numbers use. Results at different context sizes are not comparable.",
    technical: "`llama-perplexity -c 512`.",
    related: ["eval.chunks", "concept.context_length"],
  },

  "eval.kld_topk": {
    title: "Approximate KLD (top-k)",
    tagline: "For MLX and ONNX we estimate KLD from the reference's top-k tokens plus a 'rest' bucket.",
    what: "MLX and ONNX runtimes do not have llama.cpp's full-distribution KLD mode, so the app stores the reference model's k most likely tokens and their log-probabilities at each position, plus one bucket for all other tokens, and compares the quantized model on the same buckets.",
    why: "It keeps storage small and works across runtimes, but it is an approximation: it can only underestimate the true KLD, and it is not directly comparable with llama.cpp's full-vocabulary KLD numbers.",
    technical: "Per position: KL_approx = sum over the k tokens of p_i log(p_i / q_i) + p_rest log(p_rest / q_rest), where p_rest = 1 - sum p_i and q_rest = 1 - sum q_i. Merging tokens into one bucket cannot increase KL (log-sum inequality), so this is a lower bound on the true value. The gap is small when the reference puts most probability on its top-k. If the quantized runtime does not report a probability for one of those tokens, a bound or floor has to be used, adding further approximation. Compare approximate KLD only against other approximate KLD values computed with the same k.",
    related: ["eval.kld", "eval.reference", "format.mlx", "format.onnx"],
  },

  "eval.pareto": {
    title: "Pareto front",
    tagline: "The variants where you can't get smaller without losing quality, or better without growing.",
    what: "On the size-vs-quality chart, a variant is on the Pareto front if no other variant is both smaller and better.",
    why: "Variants off the front are dominated: there is always a better choice. Pick from the front according to your memory budget.",
    related: ["goal.explore", "eval.kld", "goal.priority"],
  },

  "eval.divergence": {
    title: "First divergence",
    tagline: "The first token where the quantized model's answer differs from the reference's.",
    what: "With greedy decoding, both models generate the same prompt; the app highlights the first position where their outputs differ.",
    why: "Later divergence means the variant behaves more like the original. Early divergence on simple prompts is a warning sign.",
    technical: "Only meaningful with temperature 0 and identical settings and templates. After the first difference, the two texts usually drift apart, so later differences are less informative.",
    related: ["eval.top1", "eval.temperature", "eval.reference"],
  },
};
