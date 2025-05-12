// Dev-only demo recorder: drives the UI (mocked bridge, real captured data) through a 45 s
// scripted tour with a visible cursor and captions, and encodes it to an MP4.
//
//   node tests/ui/demo.mjs [out.mp4]
//   node tests/ui/demo.mjs --hero [out.png]   light-mode still of the live view, framed as a window
//
// Requires Playwright (as for harness.mjs) and ffmpeg on PATH. The quantization replay uses the
// real Q4_K_M tensor table (tests/ui/demo/q4_k_m_tensors.json) and llama-quantize log
// (fixtures/job_logs.json); the arena replays a real turn (tests/ui/demo/arena_turn.json).
// Playback is slowed down so it can be followed: the real quantize step took 0.3 s.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../src');
const hero = process.argv[2] === '--hero';
const outFile = path.resolve(process.argv[hero ? 3 : 2] || path.join(here, 'out', hero ? 'iquantize-hero.png' : 'iquantize-demo.mp4'));
const LENGTH = 45; // seconds
const VIEW = { width: 1600, height: 900 };
const SCALE = 1.2; // 1600×900 CSS px → 1920×1080 video

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

// Same server as harness.mjs, minus the CSP header: the demo overlay injects its own <style>.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/__mock.js') {
    const dir = path.join(here, 'fixtures');
    const data = {};
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) data[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
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
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(body);
});

// Runs in the page before any app code: demo-only mock handlers, the replays and the overlay.
function demoInit(data) {
  const M = () => window.__MOCK_DATA || {};
  const emit = (ev, payload) => window.__mockEmit(ev, payload);
  const LIVE = 'demo-live';
  let live = null;
  const liveJob = () => {
    if (live) return live;
    const base = M().job_get;
    const t = Date.now();
    live = {
      ...base,
      id: LIVE,
      status: 'running',
      progress: 0.28,
      started_at: t - 11000,
      finished_at: null,
      result: null,
      stages: base.stages.map((s, i) => (i < 3 ? s : { ...s, status: i === 3 ? 'running' : 'pending', started_at: i === 3 ? t : null, finished_at: null, detail: null })),
    };
    return live;
  };
  const quantLog = () => {
    const l = M().job_logs;
    const i = l.findIndex((x) => x.text.startsWith('▸ Quantize Q4_K_M'));
    const k = l.findIndex((x, j) => j > i && x.text.startsWith('▸ '));
    return { before: l.slice(0, i), during: l.slice(i, k), next: l[k] };
  };

  // Replays the real Q4_K_M step: log lines, one tensor event per quantized tensor, progress.
  // `until` stops part-way, leaving the step running.
  window.__demoLive = (ms = 4800, until = Infinity) => {
    const { during, next } = quantLog();
    const isTensor = (x) => /^\[\s*\d+\//.test(x.text);
    const first = during.findIndex(isTensor);
    const groups = [];
    for (const line of during.slice(first)) {
      if (isTensor(line)) groups.push([line]);
      else groups[groups.length - 1].push(line);
    }
    const T = data.tensors;
    const total = T.length;
    const tick = 40;
    const per = Math.ceil(total / ((ms - 300) / tick));
    emit('job:tensor', { id: LIVE, items: [{ t: 'reset', variant: 'Q4_K_M' }] });
    emit('job:log', { id: LIVE, lines: during.slice(0, 2) });
    setTimeout(() => emit('job:log', { id: LIVE, lines: during.slice(2, first) }), 150);
    const started = performance.now();
    let i = 0;
    const step = () => {
      const items = [];
      const lines = [];
      for (let n = 0; n < per && i < total && i < until; n++, i++) {
        const t = T[i];
        items.push({ t: 'tensor', idx: i + 1, total, name: t.name, shape: t.shape, to: t.dtype, bits: (t.bytes * 8) / t.n, bytes_out: t.bytes });
        lines.push(...groups[i]);
      }
      emit('job:log', { id: LIVE, lines });
      emit('job:tensor', { id: LIVE, items });
      const last = items[items.length - 1];
      const frac = i / total;
      const el = (performance.now() - started) / 1000;
      emit('job:progress', [{ id: LIVE, progress: 0.28 + 0.1 * frac, stage: 'quantize:Q4_K_M', detail: `${last.name} → ${last.to} · tensor ${i} of ${total}`, extra: { eta_s: frac > 0.02 ? el / frac - el : 0 } }]);
      if (i < total && i < until) setTimeout(step, tick);
      else if (i === total) {
        const j = liveJob();
        const now = Date.now();
        // The real step took 368 ms; the pipeline shows that, not the slowed-down replay.
        j.stages = j.stages.map((s, n) => (n === 3 ? { ...s, status: 'done', finished_at: s.started_at + 368 } : n === 4 ? { ...s, status: 'running', started_at: now } : s));
        j.progress = 0.4;
        emit('job:update', { ...j });
        emit('job:log', { id: LIVE, lines: [next] });
      }
    };
    setTimeout(step, 300);
  };

  // Replays the real arena turn, slowed 2.5× so the difference in speed is visible.
  const SLOW = 2.5;
  function arenaReplay(stream) {
    const A = data.arena;
    let end = 0;
    for (const side of ['a', 'b']) {
      const m = A[`${side}_metrics`];
      const toks = A[`${side}_output`].split(/(?=\s)|(?=\.)/);
      const ttft = m.ttft_ms * SLOW;
      const gap = ((m.total_ms - m.ttft_ms) * SLOW) / Math.max(1, toks.length - 1);
      emit('arena:status', { stream, side, status: 'loading' });
      setTimeout(() => emit('arena:status', { stream, side, status: 'generating' }), ttft * 0.5);
      toks.forEach((text, n) => setTimeout(() => emit('arena:delta', { stream, side, text }), ttft + n * gap));
      const done = m.total_ms * SLOW + 40;
      setTimeout(() => emit('arena:done', { stream, side, metrics: m }), done);
      end = Math.max(end, done);
    }
    setTimeout(() => emit('arena:saved', { stream, turn_id: 1 }), end + 120);
  }

  // Enough Markdown for the model card preview (the app renders it in Rust).
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  function markdown(src) {
    let out = '';
    const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
    if (fm) {
      out += `<pre class="frontmatter">${esc(fm[1])}</pre>`;
      src = src.slice(fm[0].length);
    }
    const lines = src.split('\n');
    const block = (l) => /^(```|#{1,6}\s|\||\d+\.\s|[-*]\s|<)/.test(l) || !l.trim();
    for (let i = 0; i < lines.length; ) {
      const l = lines[i];
      let m;
      if (/^```/.test(l)) {
        const buf = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
        i++;
        out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      } else if ((m = l.match(/^(#{1,6})\s+(.*)/))) {
        out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++;
      } else if (/^\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const align = cells(rows[1]).map((c) => (/:$/.test(c) ? ' align="right"' : ''));
        const row = (r, tag) => `<tr>${cells(r).map((c, j) => `<${tag}${align[j]}>${inline(c)}</${tag}>`).join('')}</tr>`;
        out += `<table><thead>${row(rows[0], 'th')}</thead><tbody>${rows.slice(2).map((r) => row(r, 'td')).join('')}</tbody></table>`;
      } else if (/^(\d+\.|[-*])\s/.test(l)) {
        const tag = /^\d/.test(l) ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length && (/^(\d+\.|[-*])\s/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
          if (/^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim();
          else items.push(lines[i].replace(/^(\d+\.|[-*])\s/, ''));
          i++;
        }
        out += `<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`;
      } else if (!l.trim() || /^</.test(l)) {
        i++;
      } else {
        const buf = [];
        while (i < lines.length && !block(lines[i])) buf.push(lines[i++]);
        out += `<p>${inline(buf.join(' '))}</p>`;
      }
    }
    return out;
  }

  window.__MOCK_FIXTURES = {
    job_get: ({ id }) => (id === LIVE ? liveJob() : M().job_get),
    job_logs: ({ id }) => (id === LIVE ? quantLog().before : M().job_logs),
    system_stats: () => ({ cpu: 58 + Math.random() * 30, ram_used: 14.1e9 + Math.random() * 0.5e9, ram_total: 25.8e9, disk_free: 164e9, children_rss: 0.42e9 + Math.random() * 0.2e9 }),
    arena_run: () => {
      setTimeout(() => arenaReplay('demo-stream'), 0);
      return 'demo-stream';
    },
    arena_vote: () => null,
    doc_render: ({ markdown: md }) => markdown(md),
    // The card is the deterministic template built from measurements, so the guard has nothing to flag.
    doc_guard: () => [],
    hf_whoami: () => ({ name: 'demo-user', role: 'write', can_write: true, orgs: [] }),
    // What the real plan stages: the card's own artifacts, at their real sizes.
    publish_prepare: () => {
      const arts = M().artifacts_list.filter((a) => M().doc_get.artifact_ids.includes(a.id));
      const files = arts.map((a) => ({ path: a.path.split('/').pop(), bytes: a.size_bytes }));
      return { user: { name: 'demo-user', can_write: true }, repo: { exists: false }, files, total_bytes: files.reduce((s, f) => s + f.bytes, 0), warnings: [], blocked: false };
    },
  };

  // Overlay: macOS window controls, a cursor that follows the real mouse, captions and title cards.
  const css = `
    #demo-lights{position:fixed;top:14px;left:14px;display:flex;gap:8px;z-index:2147483640;pointer-events:none}
    #demo-lights i{display:block;width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.25)}
    #demo-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));transition:opacity .3s ease}
    #demo-cursor.off{opacity:0}
    .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(163,171,255,.9);background:rgba(94,106,210,.25);z-index:2147483646;pointer-events:none;animation:demo-ripple .45s ease-out forwards}
    @keyframes demo-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.25);opacity:0}}
    #demo-caption{position:fixed;left:50%;bottom:30px;z-index:2147483645;pointer-events:none;display:flex;align-items:center;gap:14px;padding:11px 22px 11px 12px;border-radius:999px;
      background:rgba(18,18,22,.86);backdrop-filter:blur(16px) saturate(150%);border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 50px rgba(0,0,0,.55);
      font:500 20px/1.3 Inter,sans-serif;letter-spacing:-.01em;color:#f3f4f7;white-space:nowrap;opacity:0;transform:translate(-50%,10px);transition:opacity .26s ease,transform .26s ease}
    #demo-caption.on{opacity:1;transform:translate(-50%,0)}
    #demo-caption.top{bottom:auto;top:52px}
    #demo-caption.right{left:auto;right:28px;transform:translate(0,10px)}
    #demo-caption.right.on{transform:translate(0,0)}
    #demo-caption b{font:650 12px/1 Inter,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:#d2d6ff;background:linear-gradient(180deg,#6c77dd,#4b53c8);padding:8px 11px;border-radius:999px}
    #demo-card{position:fixed;inset:0;z-index:2147483644;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;pointer-events:none;opacity:0;transition:opacity .5s ease;
      background:radial-gradient(900px 520px at 50% 38%,rgba(94,106,210,.34),transparent 65%),radial-gradient(700px 400px at 50% 110%,rgba(75,83,200,.25),transparent 70%),#0b0b0e;font-family:Inter,sans-serif}
    #demo-card.on{opacity:1}
    #demo-card img{width:104px;height:104px;filter:drop-shadow(0 20px 44px rgba(94,106,210,.55))}
    #demo-card h1{margin:4px 0 0;font-size:72px;font-weight:700;letter-spacing:-.035em;color:#fff}
    #demo-card p{margin:0;font-size:24px;line-height:1.45;color:#b8bbc2;text-align:center}
    #demo-card .chips{display:flex;gap:10px;margin-top:8px}
    #demo-card .chips span{padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e9eaed;font-size:15px;font-weight:600;letter-spacing:.02em}
    #demo-card .url{margin-top:6px;font-size:17px;color:#a3abff;letter-spacing:.01em}
    #demo-fade{position:fixed;inset:0;z-index:2147483646;background:#0b0b0e;pointer-events:none;opacity:0;transition:opacity .16s ease}
    #demo-fade.on{opacity:1}
    #demo-tick{position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:2147483642;pointer-events:none;animation:demo-tick 1s linear infinite}
    @keyframes demo-tick{from{opacity:.01}to{opacity:.02}}`;
  const CARDS = {
    title: `<img src="assets/logo.svg" alt=""><h1>iQuantize</h1><p>Quantize LLMs on your desktop, and see exactly what changes.</p><div class="chips"><span>GGUF</span><span>MLX</span><span>ONNX</span></div>`,
    end: `<img src="assets/logo.svg" alt=""><h1>iQuantize</h1><p>Plan, quantize, compare and publish, in one app.</p><div class="url">Open source · MIT or Apache-2.0 · github.com/Fazmin/iQuantize</div>`,
  };
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div id="demo-lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div id="demo-fade"></div><div id="demo-card"></div><div id="demo-caption"></div><div id="demo-tick"></div>
      <svg id="demo-cursor" width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.8v17.4l4.5-4.3 3 6.6 3-1.3-3-6.5h6.2z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    document.body.append(...wrap.children);
    const cursor = document.getElementById('demo-cursor');
    window.addEventListener('mousemove', (e) => (cursor.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 3}px)`), true);
    window.addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        r.className = 'demo-ripple';
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  });
  window.__demoUI = {
    caption(kicker, text, pos = 'bottom') {
      const el = document.getElementById('demo-caption');
      const show = () => {
        el.innerHTML = `<b>${kicker}</b><span>${text}</span>`;
        el.classList.toggle('top', pos === 'top');
        el.classList.toggle('right', pos === 'right');
        el.classList.add('on');
      };
      if (el.classList.contains('on')) {
        el.classList.remove('on');
        setTimeout(show, 280);
      } else show();
    },
    hideCaption: () => document.getElementById('demo-caption').classList.remove('on'),
    card(name, instant) {
      const el = document.getElementById('demo-card');
      if (instant) el.style.transition = 'none';
      if (name) el.innerHTML = CARDS[name];
      el.classList.toggle('on', !!name);
      document.getElementById('demo-cursor').classList.toggle('off', !!name);
      if (instant) requestAnimationFrame(() => (el.style.transition = ''));
    },
    fade: (on) => document.getElementById('demo-fade').classList.toggle('on', on),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const require = createRequire(import.meta.url);
const { chromium } = require(findPlaywright());
// Screencast frames ignore the emulated scale factor; forcing it renders them at 1080p for real.
const browser = await chromium.launch({ channel: 'chrome', args: hero ? [] : [`--force-device-scale-factor=${SCALE}`] });
const HERO = { width: 1440, height: 900, pad: 48 };
const ctx = await browser.newContext(hero ? { viewport: HERO, deviceScaleFactor: 2, colorScheme: 'light' } : { viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: 'dark' });
const data = {
  tensors: JSON.parse(fs.readFileSync(path.join(here, 'demo/q4_k_m_tensors.json'), 'utf8')),
  arena: JSON.parse(fs.readFileSync(path.join(here, 'demo/arena_turn.json'), 'utf8')),
};
await ctx.addInitScript(demoInit, data);
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

// Cursor helpers: eased, time-based movement so the overlay cursor glides and scenes keep time.
let mx = VIEW.width * 0.62;
let my = VIEW.height * 0.72;
async function moveTo(x, y, ms = 600) {
  const [sx, sy] = [mx, my];
  const start = Date.now();
  for (let t = 0; t < 1; ) {
    t = Math.min(1, (Date.now() - start) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(12);
  }
  [mx, my] = [x, y];
}
async function box(locator) {
  const b = await locator.first().boundingBox();
  if (!b) throw new Error(`Not visible: ${locator}`);
  return b;
}
async function moveToEl(locator, ms, { fx = 0.5, fy = 0.5 } = {}) {
  const b = await box(locator);
  await moveTo(b.x + b.width * fx, b.y + b.height * fy, ms);
}
async function click() {
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
}
const ui = (fn, ...args) => page.evaluate(([f, a]) => window.__demoUI[f](...a), [fn, args]);
async function cut(hash, ready) {
  await ui('hideCaption');
  await ui('fade', true);
  await sleep(170);
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForSelector(ready, { state: 'visible' });
  await sleep(80);
  await ui('fade', false);
}

if (hero) {
  // Three-quarters through the real Q4_K_M step, after a few system samples have come in.
  await page.goto(`${base}#/jobs/demo-live`);
  await page.waitForSelector('.workarea canvas', { state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(4600);
  await page.evaluate(() => window.__demoLive(4800, 204));
  await page.getByText('204 of 272 tensors quantized').waitFor();
  await sleep(400);
  const shot = await page.screenshot();
  // Rounded corners, a hairline border and a soft shadow on transparency read as a window on light and dark pages.
  const frame = await browser.newPage({ viewport: { width: HERO.width + 2 * HERO.pad, height: HERO.height + 2 * HERO.pad }, deviceScaleFactor: 2 });
  await frame.setContent(
    `<body style="margin:0;background:transparent"><img src="data:image/png;base64,${shot.toString('base64')}" style="display:block;margin:${HERO.pad}px;width:${HERO.width}px;height:${HERO.height}px;border-radius:12px;box-shadow:0 0 0 1px rgba(0,0,0,.12),0 20px 48px rgba(0,0,0,.16)"></body>`,
  );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await frame.screenshot({ path: outFile, omitBackground: true });
  await browser.close();
  server.close();
  console.log(`hero → ${outFile}`);
  if (problems.length) console.log('\nProblems:\n' + [...new Set(problems)].join('\n'));
  process.exit(problems.length ? 1 : 0);
}

await page.goto(`${base}#/`);
await page.waitForSelector('.workarea .view-head, .workarea h1', { state: 'visible' });
await page.evaluate(() => document.fonts.ready);
await ui('card', 'title', true);
await page.mouse.move(mx, my);
await sleep(600);

// Capture compositor frames with their timestamps; ffmpeg turns them into constant-rate video.
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const frameDir = fs.mkdtempSync(path.join(path.dirname(outFile), '.frames-'));
const frames = [];
let capturing = true;
const cdp = await ctx.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data: jpg, metadata, sessionId }) => {
  if (!capturing) return;
  const file = path.join(frameDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(jpg, 'base64'));
  frames.push({ file, ts: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92 });
const t0 = Date.now();
const at = async (sec, scene) => {
  const late = Date.now() - (t0 + sec * 1000);
  if (late > 0) console.log(`${scene}: ${(late / 1000).toFixed(2)} s behind schedule`);
  else await sleep(-late);
};

async function tour() {
  // 0–2.4 s: title card over Home.
  await at(2.4);
  await ui('card', null);

  // 2.4–8.2 s: New quantization → Goal: recommendations with reasons.
  const content = page.locator('.workarea');
  await moveToEl(content.getByRole('button', { name: 'New quantization' }), 800);
  await click();
  await page.waitForSelector('.wizard', { state: 'visible' });
  await ui('caption', 'Plan', 'Tell it where the model will run. Get ranked recommendations, with reasons.');
  await sleep(500);
  await moveToEl(page.getByRole('button', { name: 'Continue: Goal' }), 650);
  await click();
  await page.getByText('Recommendations').first().waitFor();
  await sleep(500);
  await moveToEl(page.locator('.wizard-body').getByText('Near-lossless; a safe choice', { exact: false }), 1000, { fx: 0.3 });
  await at(8.2, 'options');

  // 8.2–12.6 s: Options: every choice explained and sized for this model.
  await moveToEl(page.locator('.stepper .step').filter({ hasText: 'Options' }), 650);
  await click();
  await page.getByText('Quantization types').first().waitFor();
  await ui('caption', 'Explain', 'Every option is explained, with sizes estimated for your model.');
  await sleep(300);
  await moveToEl(page.locator('.wizard-body').getByText('Q4_K_M', { exact: true }), 800);
  await at(12.6, 'live');

  // 12.6–20.8 s: live quantization: the X-ray fills, the size meter shrinks, the log streams.
  await cut('/jobs/demo-live', '.workarea canvas');
  await ui('caption', 'Quantize', 'Watch every tensor get quantized, live.');
  await page.evaluate(() => window.__demoLive(5600));
  await moveTo(VIEW.width * 0.8, VIEW.height * 0.3, 1000);
  await at(18.4, 'tooltip');
  const map = await box(page.locator('.workarea canvas'));
  await moveTo(map.x + map.width * 0.42, map.y + map.height * 0.3, 800);
  await at(20.8, 'arena');

  // 20.8–27.8 s: arena: the quantized model and the original answer side by side.
  const turn = data.arena;
  await cut(`/test?a=${turn.a}&b=${turn.b}`, '.arena');
  await ui('caption', 'Compare', 'Chat with the quantized model and the original, side by side.', 'top');
  await sleep(300);
  await moveToEl(page.getByPlaceholder('Ask both models the same thing'), 650, { fx: 0.25 });
  await click();
  await page.keyboard.type(turn.prompt, { delay: 12 });
  await moveToEl(page.getByRole('button', { name: 'Send to both' }), 500);
  await click();
  const same = page.getByRole('button', { name: 'About the same' });
  await same.waitFor({ state: 'visible' });
  await sleep(700);
  await moveToEl(same, 550);
  await click();
  await at(27.8, 'quality');

  // 27.8–32 s: size vs. quality across every output.
  await moveToEl(page.locator('.tabs button').filter({ hasText: 'Quality & speed' }), 600);
  await click();
  await page.getByText('Size vs. quality').first().waitFor();
  await ui('caption', 'Measure', 'Perplexity, KL divergence and speed, measured against the original.');
  const chart = await box(page.locator('.workarea svg').filter({ hasText: 'Q4_K_M' }));
  await moveTo(chart.x + chart.width * 0.55, chart.y + chart.height * 0.42, 900);
  await at(32.0, 'docs');

  // 32–36 s: the model card, written from the measurements and checked against them.
  await cut('/docs/b97ac634c9f34783b9a7782ad75f27ec', '.doc-preview table');
  await ui('caption', 'Document', 'A model card written from your measurements. Every number is checked.', 'right');
  await moveToEl(page.getByText('Every number traces back to your measurements.'), 1000, { fx: 0.3 });
  await at(36.0, 'publish');

  // 36–41.4 s: publish: account, repository and a file plan checked before anything uploads.
  await cut('/publish', '.workarea .account-row');
  await ui('caption', 'Publish', 'Check everything first, then publish to Hugging Face.');
  await moveToEl(page.getByRole('button', { name: 'Check before publishing' }), 800);
  await click();
  const publish = page.getByRole('button', { name: /^Publish to / });
  await publish.waitFor({ state: 'visible' });
  await sleep(400);
  await moveToEl(publish, 800);
  await at(41.4, 'end card');

  // 41.4–45 s: end card.
  await ui('hideCaption');
  await ui('card', 'end');
  await at(LENGTH + 0.3, 'finish');
}

try {
  await tour();
} catch (e) {
  capturing = false;
  await page.screenshot({ path: outFile.replace(/\.mp4$/, '') + '-error.png' }).catch(() => {});
  fs.rmSync(frameDir, { recursive: true, force: true });
  await browser.close();
  server.close();
  throw e;
}
capturing = false;
await cdp.send('Page.stopScreencast');
const tEnd = frames.at(-1).ts + 0.3;
await browser.close();
server.close();

// The video starts at t0 (the schedule's zero): drop earlier frames, keeping the one on screen then.
const first = Math.max(0, frames.findLastIndex((f) => f.ts <= t0 / 1000));
frames.splice(0, first);
frames[0].ts = Math.max(frames[0].ts, t0 / 1000);
// Each frame lasts until the next one; the concat demuxer + fps filter make it constant-rate.
const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.ts ?? tEnd) - f.ts).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
fs.writeFileSync(path.join(frameDir, 'list.txt'), list);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(frameDir, 'list.txt'), '-vf', `crop=${Math.round(VIEW.width * SCALE)}:${Math.round(VIEW.height * SCALE)}:0:0,fps=60,format=yuv420p`, '-t', String(LENGTH), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', outFile]);
fs.rmSync(frameDir, { recursive: true, force: true });
const span = frames.at(-1).ts - frames[0].ts;
console.log(`${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(0)} fps captured) → ${outFile}`);
if (problems.length) {
  console.log('\nProblems:\n' + [...new Set(problems)].join('\n'));
  process.exitCode = 1;
}
