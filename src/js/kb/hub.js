// Hugging Face Hub: tokens, repos, uploads and model cards.
const HUB_UPLOAD_DOCS = { label: "huggingface_hub upload guide", url: "https://huggingface.co/docs/huggingface_hub/guides/upload" };
const MODEL_CARD_DOCS = { label: "Hugging Face model cards", url: "https://huggingface.co/docs/hub/model-cards" };

export default {
  "hub.token": {
    title: "Hugging Face token",
    tagline: "Your personal access key for downloading gated/private models and uploading results.",
    what: "An access token created at huggingface.co under Settings > Access Tokens. It identifies your account to the Hub.",
    why: "Public models download without one, but gated or private repos and all uploads need it. Treat it like a password.",
    technical: "Sent as a bearer token by huggingface_hub. You can revoke and recreate tokens at any time on the website.",
    related: ["hub.token_role", "concept.gated", "hub.namespace"],
    learnMore: [{ label: "User access tokens", url: "https://huggingface.co/docs/hub/security-tokens" }],
  },

  "hub.token_role": {
    title: "Token role",
    tagline: "Read tokens can download; uploading needs write access or a fine-grained token with write permission.",
    what: "Tokens have a role: read (download only), write (download and push to your repos), or fine-grained (permissions you pick per repo or organisation).",
    why: "Use the least access that works. Fine-grained tokens limited to the namespaces you upload to are the safest choice for publishing.",
    technical: "A fine-grained token needs repo write permission for the target user or organisation namespace, and access to gated repos if you download them with it.",
    related: ["hub.token", "hub.namespace"],
  },

  "hub.namespace": {
    title: "Namespace (owner)",
    tagline: "The user or organisation the new repo will belong to.",
    what: "The first part of a repo id, as in `namespace/repo-name`. It can be your username or an organisation where you have write rights.",
    why: "Publishing under an organisation keeps team models together; your token must be allowed to write there.",
    related: ["hub.repo_name", "hub.token_role"],
  },

  "hub.repo_name": {
    title: "Repository name",
    tagline: "The name of the new model repo, e.g. `Qwen3-8B-GGUF`.",
    what: "The second part of the repo id. Letters, numbers, dashes, underscores and dots are allowed.",
    why: "Clear names help people find your quant: a common convention is the original model name plus the format, such as `-GGUF` or `-4bit-mlx` / `-MLX-4bit`.",
    related: ["hub.namespace", "hub.search_filters"],
  },

  "hub.private": {
    title: "Private repo",
    tagline: "Only you (and your organisation) can see the repo until you make it public.",
    what: "Creates the repository as private.",
    why: "Good for testing a release before sharing. You can switch it to public later on the website.",
    technical: "Private storage may be subject to account quotas on Hugging Face.",
    related: ["hub.gated", "hub.update_existing"],
  },

  "hub.update_existing": {
    title: "Update an existing repo",
    tagline: "Add or replace files in a repo that already exists instead of creating a new one.",
    what: "Uploads into an existing repository as a new commit. Files with the same name are replaced; others are kept.",
    why: "Useful for adding more quant types to an earlier release. Older versions remain in the repo history.",
    related: ["hub.commit_message", "hub.revision"],
    learnMore: [HUB_UPLOAD_DOCS],
  },

  "hub.commit_message": {
    title: "Commit message",
    tagline: "A short note describing this upload, shown in the repo history.",
    what: "Every upload is a commit; this message describes it.",
    why: "Helps you and others see what changed, for example 'Add Q5_K_M and Q6_K'.",
    related: ["hub.update_existing", "ai.action.changelog"],
  },

  "hub.file_limit": {
    title: "50 GB per-file limit",
    tagline: "Hugging Face rejects single files over 50 GB, so big GGUFs are split above 48 GB.",
    what: "The Hub has a hard limit of 50 GB per file. The app splits any GGUF above 48 GB into shards with llama-gguf-split, leaving a safety margin.",
    why: "Without splitting, the upload would fail at the end. Split GGUFs load normally: point llama.cpp or LM Studio at the first shard.",
    technical: "Shards are named `name-00001-of-0000N.gguf`. MLX and ONNX outputs are already written as multiple smaller files.",
    related: ["gguf.tool.split", "gguf.opt.split_max_size", "concept.sharding"],
    learnMore: [{ label: "Hub storage limits", url: "https://huggingface.co/docs/hub/storage-limits" }],
  },

  "hub.base_model_relation": {
    title: "Base model relation",
    tagline: "Tells Hugging Face your repo is a quantized version of the original model.",
    what: "Model card metadata: `base_model: org/original` plus `base_model_relation: quantized`.",
    why: "Links your quant to the original's model tree so people can find it, and makes clear it is not a fine-tune.",
    technical: "Other relation values are `adapter`, `merge` and `finetune`. `base_model` should be the exact repo id you quantized from.",
    related: ["hub.model_card", "concept.already_quantized"],
    learnMore: [MODEL_CARD_DOCS],
  },

  "hub.license": {
    title: "License field",
    tagline: "The licence declared in your model card; normally the same as the original model's.",
    what: "The `license` field in the model card's YAML metadata.",
    why: "A quantized model is a derivative, so it usually must carry the original licence and any attribution it requires.",
    technical: "Custom licences use `license: other` with `license_name` and `license_link`.",
    related: ["concept.license", "hub.model_card"],
  },

  "hub.model_card": {
    title: "Model card",
    tagline: "The repo's README: what this quant is, how it was made and how to use it.",
    what: "A README.md with YAML front-matter (licence, base model, tags) followed by a human-readable description.",
    why: "A clear card builds trust and helps people choose the right file. The app drafts one from your actual settings and results.",
    technical: "Typical front-matter: `base_model`, `base_model_relation: quantized`, `license`, `tags` (for example gguf, mlx), `pipeline_tag`.",
    related: ["hub.base_model_relation", "ai.action.draft", "ai.provenance"],
    learnMore: [MODEL_CARD_DOCS],
  },

  "hub.xet": {
    title: "Xet storage",
    tagline: "Hugging Face's storage backend for large files; uploads only the chunks that changed.",
    what: "Xet is the Hub's newer storage system replacing Git LFS for large files. It splits files into chunks and de-duplicates them.",
    why: "Re-uploading a file that only changed slightly, or files that share content, transfers much less data.",
    technical: "Used through huggingface_hub with the `hf_xet` package, which the app installs in its `core` environment.",
    related: ["tc.env.core", "hub.file_limit"],
  },

  "hub.gated": {
    title: "Gate your upload",
    tagline: "Require people to accept terms before downloading your repo.",
    what: "Turns on access requests for the repo, approved automatically or manually.",
    why: "Some licences require users to accept terms; if the original model is gated, gating your quant can be appropriate.",
    technical: "Configured in the repo settings on Hugging Face.",
    related: ["concept.gated", "hub.license", "hub.private"],
  },

  "hub.revision": {
    title: "Source revision",
    tagline: "Which branch or commit of the source model to download.",
    what: "Usually `main`. You can enter a branch, tag or commit hash.",
    why: "Pinning a commit guarantees you quantize exactly the files you expect, even if the source repo is updated later.",
    technical: "Branch names can move; a commit hash never changes, so it is the value worth citing in the model card.",
    related: ["concept.revision", "ai.provenance"],
  },

  "hub.search_filters": {
    title: "Search filters",
    tagline: "Narrow Hugging Face search by task, library, size, licence or popularity.",
    what: "Filters applied when browsing models to quantize, or to check whether quants already exist.",
    why: "Helps find the original (unquantized) model and see whether someone already published the quant you want.",
    technical: "Useful filters: text-generation task, safetensors library, sort by downloads or trending. Search for the model name plus GGUF or MLX to find existing quants.",
    related: ["hub.repo_name", "concept.already_quantized"],
  },
};
