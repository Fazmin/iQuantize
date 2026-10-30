// User guide loader. Each chapter file exports an array of articles:
//   { id, title, summary, body: [block, …], terms?: [kbId, …] }
// Blocks are one-key objects, e.g. { p: 'text' }, { h: 'Heading' }, { steps: [...] }; the
// help view renders them. Text supports **bold**, `code`, [[⌘+K]] key caps and
// [label](target) links where target is help:<id>, term:<kb id>, #/<route> or https://….

export const CHAPTERS = [
  { id: 'start', file: 'getting-started', title: 'Getting started', icon: 'rocket', tone: 'accent', blurb: 'What iQuantize does, a five-minute first run, and a tour of the interface.' },
  { id: 'models', file: 'models', title: 'Models', icon: 'box', tone: 'info', blurb: 'Download from Hugging Face, import local folders and read the model page.' },
  { id: 'quantize', file: 'quantize', title: 'Quantize', icon: 'wand-sparkles', tone: 'violet', blurb: 'Pick a format, follow the wizard and tune GGUF, MLX and ONNX options.' },
  { id: 'jobs', file: 'jobs', title: 'Jobs & live view', icon: 'activity', tone: 'teal', blurb: 'Follow work as it runs, read the live view, and recover from failures.' },
  { id: 'test', file: 'testing', title: 'Test & Compare', icon: 'flask-conical', tone: 'orange', blurb: 'Chat side by side, run prompt suites and measure quality and speed.' },
  { id: 'docs', file: 'docs', title: 'Docs & model cards', icon: 'file-text', tone: 'pink', blurb: 'Generate a model card from measurements and refine it with AI.' },
  { id: 'publish', file: 'publish', title: 'Publish', icon: 'cloud-upload', tone: 'blue', blurb: 'Check, upload and verify a release on Hugging Face.' },
  { id: 'setup', file: 'environment', title: 'Environment & settings', icon: 'wrench', tone: 'green', blurb: 'Install and repair the toolchain, configure the app and manage secrets.' },
  { id: 'help', file: 'troubleshooting', title: 'Troubleshooting & FAQ', icon: 'circle-help', tone: 'red', blurb: 'Fixes for common problems, answers to common questions, and shortcuts.' },
];

/** The article the "Help for this page" button opens, by route name. */
export const ROUTE_ARTICLE = {
  home: 'start.overview',
  models: 'models.add-hf',
  quantize: 'quantize.wizard',
  jobs: 'jobs.live-view',
  test: 'test.overview',
  docs: 'docs.model-card',
  publish: 'publish.overview',
  environment: 'setup.environment',
  learn: 'start.tour',
  settings: 'setup.settings',
};

const articles = [];
const byId = new Map();
let ready = null;

export function load() {
  if (ready) return ready;
  ready = Promise.allSettled(CHAPTERS.map((c) => import(`./${c.file}.js`))).then((results) => {
    results.forEach((r, i) => {
      const chapter = CHAPTERS[i];
      if (r.status !== 'fulfilled') {
        console.warn(`Help chapter ${chapter.file}.js failed to load`, r.reason);
        return;
      }
      for (const a of r.value.default || []) {
        const article = { ...a, chapter: chapter.id, text: plainText(a) };
        articles.push(article);
        byId.set(a.id, article);
      }
    });
    return articles.length;
  });
  return ready;
}

export function all() {
  return articles;
}

export function get(id) {
  return byId.get(id) || null;
}

export function chapter(id) {
  return CHAPTERS.find((c) => c.id === id) || null;
}

export function inChapter(id) {
  return articles.filter((a) => a.chapter === id);
}

export function forRoute(name) {
  return ROUTE_ARTICLE[name] || null;
}

/** Previous and next article in reading order (chapters in order, articles in file order). */
export function neighbors(id) {
  const i = articles.findIndex((a) => a.id === id);
  return { prev: i > 0 ? articles[i - 1] : null, next: i >= 0 && i < articles.length - 1 ? articles[i + 1] : null };
}

export function readingMinutes(article) {
  return Math.max(1, Math.round(article.text.split(/\s+/).length / 200));
}

/** Strips inline markup: links keep their label, key caps keep their keys. */
export function stripInline(str) {
  return String(str)
    .replace(/\[\[([^\]]+)\]\]/g, (_, k) => k.replace(/\+/g, ' '))
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function blockText(b) {
  const [type, v] = Object.entries(b)[0];
  if (typeof v === 'string') return v;
  if (type === 'steps' || type === 'list') return v.map((s) => (typeof s === 'string' ? s : `${s.title} ${s.text || ''}`)).join(' ');
  if (type === 'defs') return v.map(([t, d]) => `${t} ${d}`).join(' ');
  if (type === 'table') return [...v.head, ...v.rows.flat()].join(' ');
  if (type === 'keys') return v.map(([, label]) => label).join(' ');
  if (type === 'action') return v.label;
  return '';
}

function plainText(a) {
  return stripInline([a.title, a.summary, ...(a.body || []).map(blockText)].join(' '));
}

/** Ranked search over titles, summaries and body text. */
export function search(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const scored = [];
  for (const a of articles) {
    const title = a.title.toLowerCase();
    const summary = a.summary.toLowerCase();
    const text = a.text.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    const score = (title.includes(needle) ? 0 : words.every((w) => title.includes(w)) ? 1 : summary.includes(needle) ? 2 : 3) - (title.startsWith(needle) ? 0.5 : 0);
    scored.push([score, a]);
  }
  return scored.sort((x, y) => x[0] - y[0]).map((x) => x[1]);
}

/** A short excerpt of the article around the first match. */
export function snippet(article, q, len = 160) {
  const needle = q.trim().toLowerCase().split(/\s+/)[0];
  const text = article.text.slice(article.title.length + 1);
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return article.summary;
  const start = Math.max(0, at - 50);
  return `${start ? '…' : ''}${text.slice(start, start + len).trim()}${start + len < text.length ? '…' : ''}`;
}
