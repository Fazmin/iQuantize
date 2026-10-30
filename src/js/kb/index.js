// Knowledge base loader. Each content file exports `{ "<id>": entry }`.
// Files are imported with allSettled so a missing or broken file never breaks the app.

const FILES = ['concepts', 'formats', 'gguf', 'mlx', 'onnx', 'hardware', 'goal', 'eval', 'hub', 'ai', 'toolchain'];

const entries = new Map();
const extra = new Map();
let ready = null;

export function load() {
  if (ready) return ready;
  ready = Promise.allSettled(FILES.map((f) => import(`./${f}.js`))).then((results) => {
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        for (const [id, entry] of Object.entries(r.value.default || {})) entries.set(id, { id, file: FILES[i], ...entry });
      } else {
        console.warn(`KB file ${FILES[i]}.js failed to load`, r.reason);
      }
    });
    return entries.size;
  });
  return ready;
}

/** Registers runtime entries (e.g. prompt suites, probed options without static docs). */
export function register(id, entry) {
  extra.set(id, { id, file: 'runtime', ...entry });
}

export function get(id) {
  return entries.get(id) || extra.get(id) || null;
}

export function has(id) {
  return entries.has(id) || extra.has(id);
}

export function all() {
  return [...entries.values(), ...extra.values()];
}

const GROUPS = {
  concepts: 'Concepts',
  formats: 'Formats',
  gguf: 'GGUF · llama.cpp',
  mlx: 'MLX',
  onnx: 'ONNX',
  hardware: 'Hardware',
  goal: 'Goals & recommendations',
  eval: 'Testing & metrics',
  hub: 'Hugging Face',
  ai: 'AI documentation',
  toolchain: 'Environment & settings',
  runtime: 'Other',
};

export function groupLabel(file) {
  return GROUPS[file] || file;
}

export function search(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return all();
  const scored = [];
  for (const e of all()) {
    const title = (e.title || '').toLowerCase();
    const hay = `${title} ${e.tagline || ''} ${e.what || ''} ${e.id}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    scored.push([title.startsWith(needle) ? 0 : title.includes(needle) ? 1 : 2, e]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
