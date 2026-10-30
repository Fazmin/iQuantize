// Live job helpers: subscriptions filtered by job id, a log console and a compact job card.

import { clear, h, icon } from '../lib/dom.js';
import { duration } from '../lib/format.js';
import { call, disposer, on } from '../lib/ipc.js';
import { go } from '../lib/router.js';
import { app } from '../lib/store.js';
import { progressBar } from './controls.js';
import { showError } from './overlay.js';

/** Subscribes to every live stream of one job. Returns an unsubscribe function. */
export function watchJob(id, { onUpdate, onProgress, onLog, onTensor, onMetric } = {}) {
  const d = disposer();
  if (onUpdate) d(on('job:update', (j) => j.id === id && onUpdate(j)));
  if (onProgress) d(on('job:progress', (items) => items.forEach((p) => p.id === id && onProgress(p))));
  if (onLog) d(on('job:log', (p) => p.id === id && onLog(p.lines)));
  if (onTensor) d(on('job:tensor', (p) => p.id === id && onTensor(p.items)));
  if (onMetric) d(on('job:metric', (p) => p.id === id && onMetric(p.items)));
  return d.dispose;
}

const MAX_DOM_LINES = 4000;

/** Scrolling log console: loads history then streams new lines. */
export function logConsole(jobId, { height } = {}) {
  const el = h('div', { class: 'log-console' });
  if (height) el.style.maxHeight = `${height}px`;
  let follow = true;
  el.addEventListener('scroll', () => {
    follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  });
  const add = (lines) => {
    const frag = document.createDocumentFragment();
    for (const l of lines) frag.appendChild(h('div', { class: `log-line ${l.stream}` }, l.text));
    el.appendChild(frag);
    while (el.childElementCount > MAX_DOM_LINES) el.firstElementChild.remove();
    if (follow) el.scrollTop = el.scrollHeight;
  };
  let lastSeq = 0;
  const pending = [];
  let loaded = false;
  const unsub = on('job:log', (p) => {
    if (p.id !== jobId) return;
    if (loaded) add(p.lines);
    else pending.push(...p.lines);
  });
  call('job_logs', { id: jobId, after: 0, limit: 3000 })
    .then((rows) => {
      add(rows);
      lastSeq = rows.length ? rows[rows.length - 1].seq : 0;
      loaded = true;
      // Lines that arrived while loading may duplicate the tail; keep only ones newer by count.
      if (pending.length) add(pending.slice(Math.max(0, pending.length - 200)));
    })
    .catch(() => (loaded = true));
  el.dispose = unsub;
  el.copyText = () => [...el.querySelectorAll('.log-line')].map((n) => n.textContent).join('\n');
  void lastSeq;
  return el;
}

export function statusBadge(status) {
  const map = {
    running: ['running', 'loader-circle', 'Running'],
    queued: ['queued', 'timer', 'Queued'],
    done: ['done', 'circle-check', 'Done'],
    failed: ['failed', 'circle-x', 'Failed'],
    cancelled: ['cancelled', 'circle-stop', 'Cancelled'],
  };
  const [cls, ic, label] = map[status] || ['queued', 'circle', status];
  return h('span', { class: `status ${cls}` }, icon(ic, 'sm'), label);
}

/** Compact live card for a running job (used on Environment, model pages, etc.). */
export function jobCard(job, { showLog = true, logHeight = 220, onDone } = {}) {
  const title = h('div', { class: 'grow ellipsis', style: { fontWeight: '600' } }, job.title);
  const badge = h('span');
  const detail = h('div', { class: 'small muted ellipsis' }, '');
  const bar = progressBar(job.progress || 0);
  const stageEl = h('div', { class: 'small muted' });
  const cancelBtn = h(
    'button',
    { class: 'btn sm ghost', onClick: () => call('job_cancel', { id: job.id }).catch(showError) },
    icon('circle-stop', 'sm'),
    'Cancel',
  );
  const log = showLog ? logConsole(job.id, { height: logHeight }) : null;
  const logWrap = log ? h('div', { class: 'hidden', style: { marginTop: '10px' } }, log) : null;
  const toggleLog = log
    ? h('button', { class: 'btn sm ghost', onClick: () => logWrap.classList.toggle('hidden') }, icon('terminal', 'sm'), 'Log')
    : null;
  const card = h(
    'div',
    { class: 'card pad col gap-3' },
    h('div', { class: 'row' }, title, badge, toggleLog, cancelBtn, h('button', { class: 'btn sm ghost icon-only', title: 'Open job', onClick: () => go(`/jobs/${job.id}`) }, icon('arrow-up-right', 'sm'))),
    bar,
    h('div', { class: 'row between' }, stageEl, detail),
    logWrap,
  );
  const render = (j) => {
    clear(badge).appendChild(statusBadge(j.status));
    const cur = j.stages.find((s) => s.status === 'running');
    const doneCount = j.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    stageEl.textContent = cur ? `${cur.label} · step ${doneCount + 1} of ${j.stages.length}` : j.status === 'done' ? `Finished in ${duration((j.finished_at || 0) - (j.started_at || 0))}` : '';
    cancelBtn.classList.toggle('hidden', !['running', 'queued'].includes(j.status));
    if (j.status === 'done') bar.set(1);
    if (j.status === 'failed') {
      bar.classList.add('danger');
      detail.textContent = (j.error || '').split('\n')[0];
      logWrap?.classList.remove('hidden');
    }
    if (['done', 'failed', 'cancelled'].includes(j.status)) onDone?.(j);
  };
  render(job);
  const unsub = watchJob(job.id, {
    onUpdate: render,
    onProgress: (p) => {
      bar.set(p.progress);
      if (p.detail) detail.textContent = p.detail;
    },
  });
  card.dispose = () => {
    unsub();
    log?.dispose();
  };
  return card;
}

/** Latest known row for a job (from the live store). */
export function knownJob(id) {
  return app.get().jobs.get(id);
}
