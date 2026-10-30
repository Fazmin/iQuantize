// Optional AI writing assistant (OpenAI Responses API) for model cards and release notes.
const OPENAI_MODELS = { label: "OpenAI models documentation", url: "https://platform.openai.com/docs/models" };

export default {
  "ai.key": {
    title: "OpenAI API key",
    tagline: "Your key for the optional AI writing features; usage is billed to your OpenAI account.",
    what: "An API key from the OpenAI platform. It is sent with each AI request to the configured base URL.",
    why: "Needed only for AI drafting, rewriting and judging. Quantization, evaluation and uploads work without it.",
    technical: "Create and revoke keys in the OpenAI platform dashboard. A project-scoped key with a spending limit is a sensible precaution.",
    related: ["ai.base_url", "ai.cost", "ai.availability"],
  },

  "ai.base_url": {
    title: "API base URL",
    tagline: "Where AI requests are sent; leave the default unless you use a compatible proxy or gateway.",
    what: "The root URL for API calls, by default `https://api.openai.com/v1`.",
    why: "Change it only for a gateway or proxy that implements the OpenAI Responses API. Your key is sent to this address, so only use endpoints you trust.",
    technical: "The app calls `POST {base}/responses` and lists models with `GET {base}/models`.",
    related: ["ai.key", "ai.availability"],
  },

  "ai.featured": {
    title: "Featured models",
    tagline: "A short, curated list of OpenAI models, checked against what your key can actually use.",
    what: "The app ships a list of recommended model ids and reconciles it with the live `/v1/models` list for your key.",
    why: "Saves you from picking ids that do not exist for your account. Models missing from your key's list are marked unavailable.",
    related: ["ai.availability", "ai.family.gpt-5.6", "ai.family.gpt-6.1"],
    learnMore: [OPENAI_MODELS],
  },

  "ai.family.gpt-6.1": {
    title: "GPT-6.1",
    tagline: "OpenAI's newest listed family here (Sol, Sept 2026); the most capable choice for drafting.",
    what: "Per OpenAI's published listing, GPT-6.1 Sol (`gpt-6.1-sol`) was released in September 2026.",
    why: "A good choice for the most careful drafts. Newer flagship models typically cost more per token than smaller siblings; check current pricing.",
    technical: "Model id: `gpt-6.1-sol`. Availability depends on your account; the app checks it against `/v1/models`.",
    related: ["ai.family.gpt-6", "ai.effort", "ai.cost"],
    learnMore: [OPENAI_MODELS],
  },

  "ai.family.gpt-6": {
    title: "GPT-6",
    tagline: "The GPT-6 family (Sol), the generation before GPT-6.1.",
    what: "Per OpenAI's published listing, the GPT-6 family includes Sol (`gpt-6-sol`).",
    why: "A strong option if GPT-6.1 is not available to your key.",
    technical: "Model id: `gpt-6-sol`.",
    related: ["ai.family.gpt-6.1", "ai.family.gpt-5.6"],
    learnMore: [OPENAI_MODELS],
  },

  "ai.family.gpt-5.6": {
    title: "GPT-5.6 (Sol, Terra, Luna)",
    tagline: "July 2026 family in three tiers: Sol (flagship), Terra (balanced), Luna (fastest, cheapest).",
    what: "Per OpenAI's published listing, GPT-5.6 launched in July 2026 with Sol (`gpt-5.6-sol`, alias `gpt-5.6`), Terra (`gpt-5.6-terra`) and Luna (`gpt-5.6-luna`).",
    why: "Terra is a sensible default for model cards; Luna is ideal for quick rewrites and multi-drafts where cost matters; Sol for the most demanding text.",
    technical: "The alias `gpt-5.6` points to Sol. Pick the tier per action to balance cost and quality.",
    related: ["ai.family.gpt-5.4", "ai.multi_draft", "ai.cost"],
    learnMore: [OPENAI_MODELS],
  },

  "ai.family.gpt-5.4": {
    title: "GPT-5.4",
    tagline: "Earlier family: gpt-5.4, gpt-5.4-pro (Responses API only) and gpt-5.4-mini.",
    what: "Per OpenAI's published listing: `gpt-5.4`, `gpt-5.4-pro` (available only through the Responses API) and the smaller `gpt-5.4-mini`.",
    why: "Still capable for documentation tasks; mini is an inexpensive option. The app uses the Responses API, so pro works here.",
    related: ["ai.family.gpt-5.6", "ai.family.gpt-5.1"],
    learnMore: [OPENAI_MODELS],
  },

  "ai.family.gpt-5.1": {
    title: "GPT-5.1",
    tagline: "An older model (`gpt-5.1`), useful as a fallback if newer ones are unavailable.",
    what: "Per OpenAI's published listing, `gpt-5.1` is an earlier GPT-5-series model.",
    why: "Works for simple rewrites; newer families generally produce better drafts.",
    related: ["ai.family.gpt-5.4", "ai.availability"],
  },

  "ai.effort": {
    title: "Reasoning effort",
    tagline: "How much the model thinks before answering: more effort is slower and costs more.",
    what: "A Responses API setting that controls how many internal reasoning tokens a reasoning model may spend.",
    why: "Low effort is fine for rewording; higher effort helps for drafting a full card from many facts. Supported levels vary by model.",
    technical: "Sent as `reasoning: { effort: \"low\" | \"medium\" | \"high\" }` (some models offer additional levels). Reasoning tokens are billed as output tokens.",
    related: ["ai.cost", "ai.action.draft"],
  },

  "ai.action.draft": {
    title: "Draft model card",
    tagline: "Writes a first draft of the model card from your real settings and measured results.",
    what: "Sends the provenance data (source, settings, tool versions, metrics) to the model and asks for a complete README.",
    why: "Saves time and produces a consistent structure. Always review it: the number guard flags figures that do not come from your data.",
    related: ["ai.provenance", "ai.guard", "hub.model_card"],
  },

  "ai.action.beginner": {
    title: "Beginner-friendly",
    tagline: "Rewrites the text for newcomers: plain words, short sentences, explained jargon.",
    what: "Rewrites the selected text so someone new to local LLMs can follow it.",
    why: "Many people downloading quants are not experts; a clear 'which file should I pick?' section helps them.",
    related: ["ai.action.rewrite", "ai.action.faq"],
  },

  "ai.action.rewrite": {
    title: "Rewrite",
    tagline: "Rephrases the selected text while keeping its meaning and facts.",
    what: "Produces an alternative wording of the selection.",
    why: "Useful when a paragraph reads awkwardly. Numbers should stay unchanged; the guard checks this.",
    related: ["ai.action.tighten", "ai.guard"],
  },

  "ai.action.tighten": {
    title: "Tighten",
    tagline: "Makes the text shorter and crisper without losing information.",
    what: "Removes repetition and filler from the selection.",
    why: "Model cards are scanned quickly; concise text gets read.",
    related: ["ai.action.rewrite", "ai.action.expand"],
  },

  "ai.action.expand": {
    title: "Expand",
    tagline: "Adds explanation and detail to the selected text.",
    what: "Elaborates on the selection, for example explaining what a quant type means.",
    why: "Helpful for short notes that need context. Expanded text is more likely to introduce unsupported claims, so review it.",
    related: ["ai.action.tighten", "ai.guard"],
  },

  "ai.action.faq": {
    title: "Generate FAQ",
    tagline: "Writes a short Q&A section, such as 'Which file should I download?'.",
    what: "Creates common questions and answers based on your variants and results.",
    why: "Answers what most users ask before they download: which file fits their hardware and which app can run it.",
    related: ["ai.action.draft", "goal.recommendation"],
  },

  "ai.action.changelog": {
    title: "Changelog",
    tagline: "Summarises what changed in this upload compared with the previous one.",
    what: "Drafts a short list of changes, such as added quant types or a new source revision.",
    why: "Useful when updating an existing repo; it can also serve as the commit message.",
    related: ["hub.commit_message", "hub.update_existing"],
  },

  "ai.multi_draft": {
    title: "Multiple drafts",
    tagline: "Generates several versions at once so you can pick the best one.",
    what: "Runs the same request more than once (optionally on different models) and shows the results side by side.",
    why: "Gives you choice and makes inconsistencies obvious. Costs proportionally more tokens.",
    related: ["ai.cost", "ai.family.gpt-5.6"],
  },

  "ai.guard": {
    title: "Number guard",
    tagline: "Flags numbers in AI-written text that don't appear in your actual data.",
    what: "After generation, every number in the AI output is checked against the provenance data (sizes, bpw, metrics, versions). Numbers without a match are highlighted.",
    why: "Language models sometimes invent plausible-looking figures. The guard catches most of these so a model card never states made-up results.",
    technical: "A flagged number is not necessarily wrong (for example a rounded value or a well-known constant), but it deserves a check before publishing.",
    related: ["ai.provenance", "ai.action.draft"],
  },

  "ai.cost": {
    title: "Cost",
    tagline: "AI features are billed per token by OpenAI to your account.",
    what: "Each request costs input tokens (your data and instructions) plus output tokens (the text written, including any reasoning tokens).",
    why: "Drafting a model card is usually a small cost, but multi-drafts, high reasoning effort and AI judging over many prompts add up.",
    technical: "Prices differ by model and change over time; see OpenAI's pricing page.",
    related: ["ai.effort", "ai.multi_draft", "eval.judge"],
    learnMore: [{ label: "OpenAI API pricing", url: "https://openai.com/api/pricing/" }],
  },

  "ai.availability": {
    title: "Not available for your key",
    tagline: "This featured model id isn't in the model list your API key returns.",
    what: "The app compared its featured list with your key's `/v1/models` response and did not find this id.",
    why: "Access can depend on account tier, organisation settings, region or rollout stage. Pick another model, or check your OpenAI account.",
    related: ["ai.featured", "ai.key", "ai.base_url"],
  },

  "ai.provenance": {
    title: "Provenance data",
    tagline: "The verified facts about this job that the AI is allowed to use.",
    what: "A structured record of the source repo and commit, tool versions, quantization settings, file sizes and measured metrics.",
    why: "Grounding the AI in recorded facts keeps model cards accurate and reproducible, and lets the number guard check the output.",
    related: ["ai.guard", "concept.revision", "hub.model_card"],
  },
};
