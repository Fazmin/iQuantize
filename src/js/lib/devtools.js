// Error forwarding to the Rust log, plus a debug-only automation runner driven by a JSON
// script (IQUANTIZE_DEV_SCRIPT). Release builds return no script, so the runner is inert.

import { call, on } from './ipc.js';
import { go } from './router.js';

export function forwardErrors() {
  const send = (level, parts) => {
    const msg = parts.map((p) => (p instanceof Error ? `${p.message}\n${p.stack || ''}` : typeof p === 'object' ? safeJson(p) : String(p))).join(' ');
    call('dev_log', { level, message: msg }).catch(() => {});
  };
  window.addEventListener('error', (e) => send('error', [e.message, e.filename ? `${e.filename}:${e.lineno}` : '']));
  window.addEventListener('unhandledrejection', (e) => send('error', ['Unhandled rejection:', e.reason]));
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      send(level, args);
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return String(v);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => call('dev_log', { level: 'info', message: `[auto] ${m}` }).catch(() => {});

/** "0.id" walks a path; "find:variant=Q4_K_M.id" finds the first array item with that field value. */
function pick(res, path) {
  if (path.startsWith('find:')) {
    const [cond, ...rest] = path.slice(5).split('.');
    const [k, v] = cond.split('=');
    const hit = (res || []).find((x) => String(x?.[k]) === v);
    return rest.reduce((o, key) => o?.[key], hit);
  }
  return path.split('.').reduce((o, k) => o?.[k], res);
}

function resolveArgs(args, vars) {
  return JSON.parse(JSON.stringify(args || {}), (_, v) => (typeof v === 'string' && v.startsWith('$') && v.slice(1) in vars ? vars[v.slice(1)] : v));
}

function waitJob(id, timeout) {
  return new Promise((resolve) => {
    let lastLog = 0;
    const offP = on('job:progress', (items) => {
      for (const p of items) {
        if (p.id === id && Date.now() - lastLog > 15000) {
          lastLog = Date.now();
          log(`job ${id.slice(0, 8)} ${(p.progress * 100).toFixed(0)}% ${p.stage || ''} ${p.detail || ''}`);
        }
      }
    });
    const finish = (j) => {
      offU();
      offP();
      clearTimeout(t);
      resolve(j);
    };
    const offU = on('job:update', (j) => {
      if (j.id === id && ['done', 'failed', 'cancelled'].includes(j.status)) finish(j);
    });
    const t = setTimeout(() => finish({ id, status: 'timeout' }), timeout);
    call('job_get', { id }).then((j) => ['done', 'failed', 'cancelled'].includes(j.status) && finish(j));
  });
}

export async function runAutomation() {
  let script;
  try {
    script = await call('dev_script');
  } catch {
    return;
  }
  if (!script?.steps) return;
  const vars = {};
  log(`running ${script.steps.length} steps`);
  for (const [i, step] of script.steps.entries()) {
    try {
      if (step.go) {
        go(step.go);
        await sleep(step.wait ?? 1200);
        log(`#${i} at ${step.go}: ${document.querySelector('.content')?.innerText.slice(0, step.textLimit ?? 600).replace(/\s+/g, ' ')}`);
      } else if (step.call) {
        const res = await call(step.call, resolveArgs(step.args, vars));
        if (step.dump) await call('dev_dump', { name: step.dump, value: res });
        if (step.save) vars[step.save] = step.pick ? pick(res, step.pick) : res;
        log(`#${i} ${step.call} → ${safeJson(res).slice(0, step.limit ?? 600)}`);
      } else if (step.waitJob) {
        const id = resolveArgs({ x: step.waitJob }, vars).x;
        const j = await waitJob(id, step.timeout ?? 3_600_000);
        log(`#${i} job ${id} finished: ${j.status}${j.error ? ` — ${j.error}` : ''} ${safeJson(j.result || {}).slice(0, 800)}`);
        if (j.status !== 'done' && step.required !== false) {
          log('stopping: required job did not succeed');
          break;
        }
      } else if (step.wait) {
        await sleep(step.wait);
      } else if (step.click) {
        document.querySelector(step.click)?.click();
        await sleep(step.after ?? 500);
      }
    } catch (e) {
      log(`#${i} error: ${e.message}${e.hint ? ` (${e.hint})` : ''}`);
      if (step.required !== false) break;
    }
  }
  log('done');
  if (script.quit) call('window_action', { action: 'close' });
}
