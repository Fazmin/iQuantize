// Dev-only UI harness: serves src/ with a mocked window.__TAURI__ and screenshots routes
// in Chrome (via Playwright) so the UI can be checked headlessly.
//
//   node tests/ui/harness.mjs [outDir] [route ...]
//
// Requires Playwright (PLAYWRIGHT_PATH to its package dir, or `npx playwright` cache).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../src');
const outDir = path.resolve(process.argv[2] || path.join(here, 'out'));
const routes = process.argv.slice(3).length ? process.argv.slice(3) : ['/', '/learn', '/settings'];

function findPlaywright() {
  if (process.env.PLAYWRIGHT_PATH) return process.env.PLAYWRIGHT_PATH;
  const npx = path.join(process.env.HOME, '.npm/_npx');
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) {
    const p = path.join(npx, d, 'node_modules/playwright');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Playwright not found. Run `npx playwright --version` once or set PLAYWRIGHT_PATH.');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'";

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/__mock.js') {
    const dir = path.join(here, 'fixtures');
    const data = {};
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.json')) data[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`window.__MOCK_DATA = ${JSON.stringify(data)};\n` + fs.readFileSync(path.join(here, 'mock-tauri.js'), 'utf8'));
    return;
  }
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let body = fs.readFileSync(f);
  if (p === '/index.html') body = Buffer.from(body.toString().replace('<script type="module"', '<script src="/__mock.js"></script>\n    <script type="module"'));
  // Same CSP as the app (plus 'unsafe-inline' only so Playwright can evaluate), so violations show up.
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
  res.end(body);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const require = createRequire(import.meta.url);
const { chromium } = require(findPlaywright());
const browser = await chromium.launch({ channel: 'chrome' });
fs.mkdirSync(outDir, { recursive: true });
const problems = [];
for (const theme of (process.env.THEMES || 'dark,light').split(',')) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DPR || 1), colorScheme: theme });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${theme}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${theme}] pageerror: ${e.message}`));
  for (const r of routes) {
    await page.goto(`http://127.0.0.1:${port}/#${r}`);
    await page.waitForTimeout(Number(process.env.WAIT || 900));
    for (const sel of (process.env.CLICK || '').split(',').filter(Boolean)) {
      await page.click(sel);
      await page.waitForTimeout(500);
    }
    // SCROLL=".list,.list" scrolls each matching element to its end, in order (e.g. to trigger paging).
    for (const sel of (process.env.SCROLL || '').split(',').filter(Boolean)) {
      await page.$eval(sel, (el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(700);
    }
    if (process.env.COUNT) console.log('count', process.env.COUNT, await page.$$eval(process.env.COUNT, (els) => els.length));
    if (process.env.HOVER) {
      const el = await page.$(process.env.HOVER);
      if (el) {
        await el.hover();
        await page.waitForTimeout(600);
      }
    }
    const name = `${r.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}-${theme}.png`;
    await page.screenshot({ path: path.join(outDir, name), fullPage: !!process.env.FULL });
    console.log('shot', name);
  }
  await ctx.close();
}
await browser.close();
server.close();
if (problems.length) {
  console.log('\nProblems:\n' + [...new Set(problems)].join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nNo console errors.');
}
