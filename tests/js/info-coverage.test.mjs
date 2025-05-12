// Every info id referenced by the UI must exist in the knowledge base, so no control is
// ever without an explanation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kbDir = path.join(root, 'src/js/kb');
const FILES = ['concepts', 'formats', 'gguf', 'mlx', 'onnx', 'hardware', 'goal', 'eval', 'hub', 'ai', 'toolchain'];

async function kbIds() {
  const ids = new Set();
  for (const f of FILES) {
    // A file URL, not a path: on Windows `import('D:\\…')` reads "d:" as a URL scheme.
    const mod = await import(pathToFileURL(path.join(kbDir, `${f}.js`)).href);
    for (const id of Object.keys(mod.default)) ids.add(id);
  }
  return ids;
}

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.js') && !dir.endsWith('kb') ? [path.join(dir, e.name)] : []));
}

const PATTERNS = [/info:\s*'([^']+)'/g, /info:\s*`([^`]+)`/g, /infoIcon\('([^']+)'/g, /infoIcon\(`([^`]+)`/g, /attachInfo\([^,]+,\s*'([^']+)'/g, /kb:\s*'([^']+)'/g];

test('every info id used by the UI exists in the knowledge base', async () => {
  const ids = await kbIds();
  const missing = [];
  let checked = 0;
  for (const file of sources(path.join(root, 'src/js'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const id = m[1];
        if (id === 'info') continue; // icon-name maps such as { info: 'info' }
        checked++;
        if (id.includes('${')) {
          // Template ids: at least one KB entry must share the static prefix.
          const prefix = id.slice(0, id.indexOf('${'));
          if (prefix && ![...ids].some((k) => k.startsWith(prefix))) missing.push(`${path.relative(root, file)}: ${id}`);
        } else if (!ids.has(id)) {
          missing.push(`${path.relative(root, file)}: ${id}`);
        }
      }
    }
  }
  assert.ok(checked > 100, `expected many info references, found ${checked}`);
  assert.deepEqual(missing, [], `Missing KB entries:\n${missing.join('\n')}`);
});

test('the Rust toolchain components reference existing KB entries', async () => {
  const ids = await kbIds();
  const rust = fs.readFileSync(path.join(root, 'src-tauri/src/toolchain/mod.rs'), 'utf8');
  const kbRefs = [...rust.matchAll(/kb: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(kbRefs.length >= 7);
  for (const id of kbRefs) assert.ok(ids.has(id), `missing ${id}`);
});
