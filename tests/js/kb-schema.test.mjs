// Schema test for the built-in knowledge base (src/js/kb/*.js).
// Run from the project root: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";

import concepts from "../../src/js/kb/concepts.js";
import formats from "../../src/js/kb/formats.js";
import gguf from "../../src/js/kb/gguf.js";
import mlx from "../../src/js/kb/mlx.js";
import onnx from "../../src/js/kb/onnx.js";
import hardware from "../../src/js/kb/hardware.js";
import goal from "../../src/js/kb/goal.js";
import evalKb from "../../src/js/kb/eval.js";
import hub from "../../src/js/kb/hub.js";
import ai from "../../src/js/kb/ai.js";
import toolchain from "../../src/js/kb/toolchain.js";

const FILES = {
  "concepts.js": concepts,
  "formats.js": formats,
  "gguf.js": gguf,
  "mlx.js": mlx,
  "onnx.js": onnx,
  "hardware.js": hardware,
  "goal.js": goal,
  "eval.js": evalKb,
  "hub.js": hub,
  "ai.js": ai,
  "toolchain.js": toolchain,
};

const ALLOWED_KEYS = new Set([
  "title", "tagline", "what", "why", "analogy", "meters", "goodFor",
  "avoidIf", "technical", "related", "learnMore",
]);
const METER_KEYS = new Set(["size", "quality", "speed", "effort"]);
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i;

const GGUF_QTYPES = [
  "Q1_0", "Q2_0", "Q4_0", "Q4_1", "MXFP4_MOE", "Q5_0", "Q5_1", "IQ2_XXS",
  "IQ2_XS", "IQ2_S", "IQ2_M", "IQ1_S", "IQ1_M", "TQ1_0", "TQ2_0", "Q2_K",
  "Q2_K_S", "IQ3_XXS", "IQ3_S", "IQ3_M", "IQ3_XS", "Q3_K_S", "Q3_K_M",
  "Q3_K_L", "IQ4_NL", "IQ4_XS", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M",
  "Q6_K", "Q8_0", "F16", "BF16", "F32", "COPY",
];

const REQUIRED = {
  "concepts.js": [
    "concept.quantization", "concept.bpw", "concept.dtype", "concept.fp32",
    "concept.fp16", "concept.bf16", "concept.group_size",
    "concept.scale_zero_point", "concept.symmetric", "concept.calibration",
    "concept.imatrix", "concept.mixed_precision", "concept.outliers",
    "concept.ptq_vs_qat", "concept.weight_only", "concept.kv_cache",
    "concept.context_length", "concept.params", "concept.moe",
    "concept.embeddings", "concept.lm_head", "concept.attention",
    "concept.ffn", "concept.norms", "concept.tied_embeddings",
    "concept.requantize", "concept.safetensors", "concept.tokenizer",
    "concept.chat_template", "concept.revision", "concept.gated",
    "concept.license", "concept.sharding", "concept.unified_memory",
    "concept.vram", "concept.memory_budget", "concept.disk_space",
    "concept.awq", "concept.gptq", "concept.hqq", "concept.rtn",
    "concept.dwq", "concept.kquants", "concept.iquants", "concept.ternary",
    "concept.mxfp4", "concept.nvfp4", "concept.fp8",
    "concept.already_quantized",
  ],
  "formats.js": ["format.gguf", "format.mlx", "format.onnx", "format.compare"],
  "gguf.js": [
    "gguf.base.F32", "gguf.base.F16", "gguf.base.BF16", "gguf.base.Q8_0",
    "gguf.base.auto",
    ...GGUF_QTYPES.map((t) => `gguf.qtype.${t}`),
    "gguf.opt.imatrix", "gguf.opt.imatrix_chunks", "gguf.opt.imatrix_ctx",
    "gguf.opt.output_tensor_type", "gguf.opt.token_embedding_type",
    "gguf.opt.leave_output_tensor", "gguf.opt.pure",
    "gguf.opt.allow_requantize", "gguf.opt.tensor_type",
    "gguf.opt.keep_split", "gguf.opt.split_max_size",
    "gguf.opt.prune_layers", "gguf.opt.use_temp_file", "gguf.opt.threads",
    "gguf.opt.dry_run", "gguf.opt.max_buffer_size",
    "gguf.opt.include_weights", "gguf.opt.override_kv",
    "gguf.preset.none", "gguf.preset.protect_sensitive",
    "gguf.preset.edges_higher", "gguf.preset.embed_q8",
    "gguf.tool.convert", "gguf.tool.quantize", "gguf.tool.imatrix",
    "gguf.tool.perplexity", "gguf.tool.bench", "gguf.tool.server",
    "gguf.tool.split",
  ],
  "mlx.js": [
    "mlx.bits.2", "mlx.bits.3", "mlx.bits.4", "mlx.bits.5", "mlx.bits.6",
    "mlx.bits.8", "mlx.group_size.32", "mlx.group_size.64",
    "mlx.group_size.128", "mlx.mode.affine", "mlx.mode.mxfp4",
    "mlx.mode.nvfp4", "mlx.mode.mxfp8", "mlx.recipe.none",
    "mlx.recipe.mixed_2_6", "mlx.recipe.mixed_3_4", "mlx.recipe.mixed_3_6",
    "mlx.recipe.mixed_4_6", "mlx.dtype.float16", "mlx.dtype.bfloat16",
    "mlx.dtype.float32", "mlx.method.convert", "mlx.method.awq",
    "mlx.method.gptq", "mlx.method.dwq", "mlx.method.dynamic_quant",
    "mlx.opt.rules", "mlx.opt.trust_remote_code", "mlx.opt.num_samples",
    "mlx.opt.sequence_length", "mlx.opt.target_bpw", "mlx.apple_only",
  ],
  "onnx.js": [
    "onnx.engine.builder", "onnx.engine.optimum", "onnx.precision.int4",
    "onnx.precision.int8", "onnx.precision.fp16", "onnx.precision.bf16",
    "onnx.precision.fp32", "onnx.ep.cpu", "onnx.ep.cuda", "onnx.ep.webgpu",
    "onnx.ep.dml", "onnx.opt.block_size", "onnx.opt.accuracy_level",
    "onnx.opt.algo_config", "onnx.opt.is_symmetric",
    "onnx.opt.exclude_embeds", "onnx.opt.exclude_lm_head",
    "onnx.opt.shared_embeddings", "onnx.opt.matmul_mixed_precision",
    "onnx.opt.kv_cache_quant", "onnx.algo.default", "onnx.algo.rtn",
    "onnx.algo.k_quant", "onnx.b.int8_dynamic", "onnx.b.int4_weight",
    "onnx.b.per_channel", "onnx.b.reduce_range", "onnx.b.qdq",
    "onnx.b.qoperator", "onnx.b.int4_rtn", "onnx.b.int4_hqq",
    "onnx.b.int4_gptq",
  ],
  "hardware.js": [
    "hw.accel.metal", "hw.accel.cuda", "hw.accel.vulkan", "hw.accel.rocm",
    "hw.accel.cpu", "hw.accel.sycl", "hw.accel.openvino",
    "hw.device.apple_silicon", "hw.device.nvidia", "hw.device.amd",
    "hw.device.cpu_only", "hw.device.edge", "hw.device.browser", "hw.ram",
    "hw.cpu_threads",
  ],
  "goal.js": [
    "goal.device", "goal.memory", "goal.runtime.llamacpp",
    "goal.runtime.lmstudio", "goal.runtime.ollama", "goal.runtime.mlx_apps",
    "goal.runtime.ort", "goal.runtime.web", "goal.runtime.any",
    "goal.priority", "goal.context", "goal.usecase.chat", "goal.usecase.code",
    "goal.usecase.rag", "goal.usecase.agents", "goal.usecase.creative",
    "goal.usecase.multilingual", "goal.explore", "goal.recommendation",
  ],
  "eval.js": [
    "eval.reference", "eval.ppl", "eval.kld", "eval.top1", "eval.delta_p",
    "eval.speed_pp", "eval.speed_tg", "eval.ttft", "eval.peak_mem",
    "eval.exact_match", "eval.rouge_l", "eval.token_overlap", "eval.judge",
    "eval.vote", "eval.temperature", "eval.top_p", "eval.seed",
    "eval.max_tokens", "eval.system_prompt", "eval.sequential",
    "eval.dataset.wikitext2", "eval.chunks", "eval.ctx", "eval.kld_topk",
    "eval.pareto", "eval.divergence",
  ],
  "hub.js": [
    "hub.token", "hub.token_role", "hub.namespace", "hub.repo_name",
    "hub.private", "hub.update_existing", "hub.commit_message",
    "hub.file_limit", "hub.base_model_relation", "hub.license",
    "hub.model_card", "hub.xet", "hub.gated", "hub.revision",
    "hub.search_filters",
  ],
  "ai.js": [
    "ai.key", "ai.base_url", "ai.featured", "ai.family.gpt-6.1",
    "ai.family.gpt-6", "ai.family.gpt-5.6", "ai.family.gpt-5.4",
    "ai.family.gpt-5.1", "ai.effort", "ai.action.draft",
    "ai.action.beginner", "ai.action.rewrite", "ai.action.tighten",
    "ai.action.expand", "ai.action.faq", "ai.action.changelog",
    "ai.multi_draft", "ai.guard", "ai.cost", "ai.availability",
    "ai.provenance",
  ],
  "toolchain.js": [
    "tc.uv", "tc.python", "tc.llamacpp", "tc.env.gguf", "tc.env.mlx",
    "tc.env.onnx", "tc.env.core", "tc.accelerator", "tc.probe", "tc.doctor",
    "settings.workspace", "settings.theme", "settings.concurrency",
    "settings.hf_cache", "settings.keep_intermediates", "settings.threads",
    "settings.notifications", "calib.wikitext2", "calib.pile_val",
    "calib.c4", "calib.custom_file", "calib.hf_dataset", "calib.size",
  ],
};

// Build the merged id -> {file, entry} map once (also detects duplicates).
const merged = new Map();
const duplicates = [];
for (const [file, mod] of Object.entries(FILES)) {
  for (const [id, entry] of Object.entries(mod)) {
    if (merged.has(id)) duplicates.push(`${id} (${merged.get(id).file} and ${file})`);
    else merged.set(id, { file, entry });
  }
}

test("every KB file exports a non-empty plain object", () => {
  for (const [file, mod] of Object.entries(FILES)) {
    assert.equal(typeof mod, "object", `${file} default export is not an object`);
    assert.ok(mod !== null && !Array.isArray(mod), `${file} default export must be a plain object`);
    assert.ok(Object.keys(mod).length > 0, `${file} is empty`);
  }
});

test("no duplicate ids across files", () => {
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(", ")}`);
});

test("every entry has title, tagline (<= 110 chars), what and why", () => {
  const problems = [];
  for (const [id, { file, entry }] of merged) {
    for (const key of ["title", "tagline", "what", "why"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        problems.push(`${file}:${id} missing ${key}`);
      }
    }
    if (typeof entry.tagline === "string" && entry.tagline.length > 110) {
      problems.push(`${file}:${id} tagline is ${entry.tagline.length} chars`);
    }
  }
  assert.deepEqual(problems, []);
});

test("entries only use known keys, with the right value types and no HTML", () => {
  const problems = [];
  for (const [id, { file, entry }] of merged) {
    for (const [key, value] of Object.entries(entry)) {
      if (!ALLOWED_KEYS.has(key)) problems.push(`${file}:${id} unknown key ${key}`);
      if (["title", "tagline", "what", "why", "analogy", "technical"].includes(key)) {
        if (typeof value !== "string") problems.push(`${file}:${id}.${key} must be a string`);
        else if (HTML_TAG.test(value)) problems.push(`${file}:${id}.${key} contains HTML`);
      }
      if (["goodFor", "avoidIf", "related"].includes(key)) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
          problems.push(`${file}:${id}.${key} must be an array of non-empty strings`);
        } else if (value.some((v) => HTML_TAG.test(v))) {
          problems.push(`${file}:${id}.${key} contains HTML`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("meters are integers 1-5 using only size/quality/speed/effort", () => {
  const problems = [];
  for (const [id, { file, entry }] of merged) {
    if (entry.meters === undefined) continue;
    if (typeof entry.meters !== "object" || entry.meters === null || Array.isArray(entry.meters)) {
      problems.push(`${file}:${id} meters must be an object`);
      continue;
    }
    for (const [k, v] of Object.entries(entry.meters)) {
      if (!METER_KEYS.has(k)) problems.push(`${file}:${id} meters has unknown key ${k}`);
      if (!Number.isInteger(v) || v < 1 || v > 5) problems.push(`${file}:${id} meters.${k}=${v} not an integer 1-5`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every related id exists", () => {
  const missing = [];
  for (const [id, { file, entry }] of merged) {
    for (const rel of entry.related ?? []) {
      if (!merged.has(rel)) missing.push(`${file}:${id} -> ${rel}`);
      if (rel === id) missing.push(`${file}:${id} relates to itself`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every learnMore item has a label and an https:// url", () => {
  const problems = [];
  for (const [id, { file, entry }] of merged) {
    if (entry.learnMore === undefined) continue;
    if (!Array.isArray(entry.learnMore)) {
      problems.push(`${file}:${id} learnMore must be an array`);
      continue;
    }
    for (const lm of entry.learnMore) {
      if (typeof lm?.label !== "string" || lm.label.trim() === "") problems.push(`${file}:${id} learnMore item missing label`);
      if (typeof lm?.url !== "string" || !lm.url.startsWith("https://")) problems.push(`${file}:${id} learnMore url not https: ${lm?.url}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("all required ids exist in the expected file", () => {
  const missing = [];
  for (const [file, ids] of Object.entries(REQUIRED)) {
    for (const id of ids) {
      const hit = merged.get(id);
      if (!hit) missing.push(`${id} (expected in ${file})`);
      else if (hit.file !== file) missing.push(`${id} is in ${hit.file}, expected ${file}`);
    }
  }
  assert.deepEqual(missing, []);
});
