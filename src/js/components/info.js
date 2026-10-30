// The info system: every selectable control carries a KB id. Hover/focus shows a
// plain-English popover; clicking the ⓘ button pins the full entry in the Inspector.

import * as kb from '../kb/index.js';
import { h, icon, placeNear, richText } from '../lib/dom.js';
import { call } from '../lib/ipc.js';
import { inspector } from './inspector.js';

const METER_LABELS = { size: 'Smaller file', quality: 'Quality', speed: 'Speed', effort: 'Ease' };
const DEV = true;

let pop = null;
let showTimer = null;
let hideTimer = null;
let currentAnchor = null;

function missing(id) {
  if (DEV) console.warn(`[info] no KB entry for "${id}"`);
  return { id, title: id, tagline: 'No description yet.', what: '', why: '' };
}

function meters(m) {
  const wrap = h('div', { class: 'meters' });
  for (const k of ['quality', 'size', 'speed', 'effort']) {
    if (m[k] == null) continue;
    const bar = h('div', { class: 'meter', title: `${m[k]} / 5` });
    for (let i = 1; i <= 5; i++) bar.appendChild(h('i', { class: i <= m[k] ? 'on' : '' }));
    wrap.append(h('span', null, METER_LABELS[k]), bar);
  }
  return wrap;
}

function list(items) {
  return h('ul', null, items.map((t) => h('li', null, richText(t))));
}

/** Renders a KB entry. `full` adds technical details, related links and sources. */
export function renderEntry(id, { full = false, note = null, onRelated = (r) => inspector.showEntry(r) } = {}) {
  const e = kb.get(id) || missing(id);
  const body = h('div', { class: 'kb-entry' });
  body.append(h('div', { class: 'kb-title' }, e.title), h('div', { class: 'kb-tagline' }, richText(e.tagline)));
  if (note) {
    const n = typeof note === 'function' ? note() : note;
    if (n) body.append(h('div', { class: 'kb-note' }, h('div', { class: 'kb-label' }, 'For your model'), n instanceof Node ? n : richText(n)));
  }
  if (e.what) body.append(h('div', null, h('div', { class: 'kb-label' }, 'What it is'), richText(e.what)));
  if (e.why) body.append(h('div', null, h('div', { class: 'kb-label' }, 'Why it matters'), richText(e.why)));
  if (e.analogy) body.append(h('div', { class: 'kb-analogy' }, richText(e.analogy)));
  if (e.meters) body.append(meters(e.meters));
  if (e.goodFor?.length || e.avoidIf?.length) {
    const cols = h('div', { class: full ? '' : 'kb-cols' });
    if (e.goodFor?.length) cols.append(h('div', null, h('div', { class: 'kb-label' }, 'Good for'), list(e.goodFor)));
    if (e.avoidIf?.length) cols.append(h('div', null, h('div', { class: 'kb-label' }, 'Avoid if'), list(e.avoidIf)));
    body.append(cols);
  }
  if (full) {
    if (e.technical) body.append(h('div', null, h('div', { class: 'kb-label' }, 'Technical details'), h('div', { class: 'kb-tech' }, richText(e.technical))));
    if (e.related?.length) {
      body.append(
        h(
          'div',
          null,
          h('div', { class: 'kb-label' }, 'Related'),
          h(
            'div',
            { class: 'kb-related' },
            e.related.filter((r) => kb.has(r)).map((r) => h('button', { onClick: () => onRelated(r) }, kb.get(r).title)),
          ),
        ),
      );
    }
    const links = (e.learnMore || []).filter((l) => l.url?.startsWith('https://'));
    if (links.length) {
      body.append(
        h(
          'div',
          null,
          h('div', { class: 'kb-label' }, 'Learn more'),
          h('ul', null, links.map((l) => h('li', null, h('a', { onClick: () => call('open_external', { url: l.url }) }, l.label)))),
        ),
      );
    }
  } else if (e.technical || e.related?.length) {
    body.append(h('div', { class: 'kb-foot' }, 'Click ⓘ to pin this with technical details.'));
  }
  return body;
}

function hidePop() {
  clearTimeout(showTimer);
  pinned = false;
  if (pop) {
    pop.remove();
    pop = null;
  }
  if (currentAnchor) currentAnchor.classList.remove('active');
  currentAnchor = null;
}

let pinned = false;

function scheduleHide() {
  if (pinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePop, 140);
}

function showPop(anchor, id, note, { full = false } = {}) {
  clearTimeout(hideTimer);
  if (currentAnchor === anchor && pop && !full) return;
  hidePop();
  pinned = full;
  currentAnchor = anchor;
  anchor.classList.add('active');
  pop = h('div', { class: `pop ${full ? 'pinned' : ''}`, role: full ? 'dialog' : 'tooltip' }, renderEntry(id, { note, full, onRelated: (r) => showPop(anchor, r, null, { full: true }) }));
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  placeNear(pop, rect, { side: rect.left > window.innerWidth * 0.55 ? 'bottom' : 'right', gap: 8 });
}

/**
 * Attaches hover/focus info to any element. `note` (string | Node | () => …) adds
 * model-specific context such as estimated size.
 */
export function attachInfo(el, id, { note = null, delay = 320 } = {}) {
  if (!id) return el;
  el.dataset.info = id;
  const enter = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => showPop(el, id, note), delay);
  };
  el.addEventListener('mouseenter', enter);
  el.addEventListener('focus', enter);
  el.addEventListener('mouseleave', () => {
    clearTimeout(showTimer);
    scheduleHide();
  });
  el.addEventListener('blur', () => {
    clearTimeout(showTimer);
    scheduleHide();
  });
  return el;
}

/** The ⓘ button: hover previews, click pins the full entry (Inspector, or in place inside dialogs). */
export function infoIcon(id, opts = {}) {
  const btn = h(
    'button',
    {
      class: 'info-btn',
      type: 'button',
      'aria-label': 'More information',
      onClick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // The Inspector sits behind modals, so inside a dialog pin the full entry in place.
        if (btn.closest('.modal-backdrop')) {
          showPop(btn, id, opts.note, { full: true });
          return;
        }
        hidePop();
        inspector.showEntry(id, opts.note);
      },
    },
    icon('info'),
  );
  return attachInfo(btn, id, { ...opts, delay: 120 });
}

window.addEventListener('scroll', (e) => {
  if (!pinned || !pop?.contains(e.target)) hidePop();
}, true);
document.addEventListener('mousedown', (e) => {
  if (pinned && pop && !pop.contains(e.target) && !currentAnchor?.contains(e.target)) hidePop();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePop();
});
