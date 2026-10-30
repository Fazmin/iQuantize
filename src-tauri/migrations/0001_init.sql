-- iQuantize schema v1. Timestamps are unix milliseconds.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Encrypted with XChaCha20-Poly1305; the key lives in the OS keychain.
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  nonce      BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  hint       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE toolchain_components (
  id           TEXT PRIMARY KEY,
  version      TEXT,
  variant      TEXT,
  path         TEXT,
  status       TEXT NOT NULL,
  size_bytes   INTEGER,
  installed_at INTEGER,
  meta_json    TEXT
);

CREATE TABLE toolchain_capabilities (
  component  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  probed_at  INTEGER NOT NULL,
  PRIMARY KEY (component, key)
);

CREATE TABLE models (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,            -- hf | local
  repo_id        TEXT,
  revision       TEXT,
  local_path     TEXT NOT NULL,
  name           TEXT NOT NULL,
  architecture   TEXT,
  model_type     TEXT,
  params         INTEGER,
  dtype          TEXT,
  context_length INTEGER,
  license        TEXT,
  size_bytes     INTEGER,
  config_json    TEXT,
  info_json      TEXT,
  status         TEXT NOT NULL,            -- downloading | ready | error
  created_at     INTEGER NOT NULL
);

CREATE TABLE model_files (
  model_id   TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  size_bytes INTEGER,
  sha256     TEXT,
  PRIMARY KEY (model_id, path)
);

CREATE TABLE recipes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  format      TEXT NOT NULL,
  params_json TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,               -- install | download | quantize | eval | suite | upload | calibration
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,               -- queued | running | done | failed | cancelled
  model_id    TEXT REFERENCES models(id) ON DELETE SET NULL,
  format      TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error       TEXT,
  progress    REAL NOT NULL DEFAULT 0,
  stage       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_created ON jobs(created_at DESC);

CREATE TABLE job_stages (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL,               -- pending | running | done | skipped | failed | cancelled
  cached      INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER,
  finished_at INTEGER,
  detail      TEXT,
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE job_logs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts     INTEGER NOT NULL,
  stream TEXT NOT NULL,
  line   TEXT NOT NULL
);
CREATE INDEX job_logs_job ON job_logs(job_id, id);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  job_id     TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  model_id   TEXT REFERENCES models(id) ON DELETE CASCADE,
  format     TEXT NOT NULL,                -- gguf | mlx | onnx
  variant    TEXT NOT NULL,                -- e.g. Q4_K_M, 4bit-gs64, int4-cpu
  role       TEXT NOT NULL DEFAULT 'quantized', -- quantized | reference
  path       TEXT NOT NULL,
  size_bytes INTEGER,
  sha256     TEXT,
  bpw        REAL,
  meta_json  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifact_tensors (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  shape       TEXT NOT NULL,
  dtype       TEXT NOT NULL,
  n_elements  INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, idx)
);

CREATE TABLE cache_entries (
  key          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,              -- base_gguf | imatrix | kld_base | onnx_ref
  path         TEXT NOT NULL,
  size_bytes   INTEGER,
  meta_json    TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE calibration_sets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,                -- preset | hf | file
  path       TEXT NOT NULL,
  bytes      INTEGER,
  sha256     TEXT,
  meta_json  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE eval_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,               -- ppl | kld | speed | suite
  model_id    TEXT,
  params_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE eval_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  artifact_id  TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
  reference_id TEXT,
  metric       TEXT NOT NULL,
  value        REAL,
  detail_json  TEXT
);
CREATE INDEX eval_results_artifact ON eval_results(artifact_id);

CREATE TABLE prompt_suites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  builtin     INTEGER NOT NULL DEFAULT 0,
  extra_json  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE prompts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id  TEXT NOT NULL REFERENCES prompt_suites(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  category  TEXT,
  system    TEXT,
  prompt    TEXT NOT NULL,
  reference TEXT
);

CREATE TABLE arena_sessions (
  id          TEXT PRIMARY KEY,
  a_artifact  TEXT NOT NULL,
  b_artifact  TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE arena_turns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  system         TEXT,
  prompt         TEXT NOT NULL,
  a_output       TEXT,
  b_output       TEXT,
  a_metrics_json TEXT,
  b_metrics_json TEXT,
  vote           TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE documents (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  model_id          TEXT REFERENCES models(id) ON DELETE SET NULL,
  artifact_ids_json TEXT NOT NULL,
  markdown          TEXT NOT NULL,
  provenance_json   TEXT,
  repo_id           TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE document_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  markdown    TEXT NOT NULL,
  source      TEXT NOT NULL,               -- template | manual | ai
  ai_model    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE ai_models (
  id         TEXT PRIMARY KEY,
  family     TEXT NOT NULL,
  label      TEXT NOT NULL,
  featured   INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  price_in   REAL,
  price_out  REAL,
  notes      TEXT,
  available  INTEGER,
  checked_at INTEGER
);

CREATE TABLE ai_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  model            TEXT NOT NULL,
  action           TEXT NOT NULL,
  document_id      TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  reasoning_tokens INTEGER,
  cost_estimate    REAL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE uploads (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  document_id TEXT,
  repo_id     TEXT NOT NULL,
  private     INTEGER NOT NULL,
  files_json  TEXT NOT NULL,
  status      TEXT NOT NULL,
  url         TEXT,
  commit_sha  TEXT,
  created_at  INTEGER NOT NULL
);

-- Featured OpenAI models (reconciled against GET /v1/models at runtime; prices are editable estimates).
INSERT INTO ai_models (id, family, label, sort, price_in, price_out, notes) VALUES
  ('gpt-6.1-sol',   'gpt-6.1', 'GPT-6.1 Sol',   10, 2.0,  10.0, 'Newest flagship listing (Sep 2026).'),
  ('gpt-6-sol',     'gpt-6',   'GPT-6 Sol',     20, NULL, NULL, NULL),
  ('gpt-5.6-sol',   'gpt-5.6', 'GPT-5.6 Sol',   30, 5.0,  30.0, 'Flagship of the 5.6 family; alias gpt-5.6.'),
  ('gpt-5.6-terra', 'gpt-5.6', 'GPT-5.6 Terra', 31, 2.5,  15.0, 'Balanced 5.6 model.'),
  ('gpt-5.6-luna',  'gpt-5.6', 'GPT-5.6 Luna',  32, 1.0,  6.0,  'Fastest and cheapest 5.6 model.'),
  ('gpt-5.4',       'gpt-5.4', 'GPT-5.4',       40, NULL, NULL, NULL),
  ('gpt-5.4-pro',   'gpt-5.4', 'GPT-5.4 Pro',   41, 30.0, 180.0,'Responses API only.'),
  ('gpt-5.4-mini',  'gpt-5.4', 'GPT-5.4 mini',  42, 0.75, 4.5,  NULL),
  ('gpt-5.1',       'gpt-5.1', 'GPT-5.1',       50, 1.25, 10.0, 'Older generation.');
