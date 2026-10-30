// Glossary of every KB entry plus an interactive "Quantization 101" demo.

import { segmented, toggle } from '../components/controls.js';
import { renderEntry } from '../components/info.js';
import * as kb from '../kb/index.js';
import { clear, h, icon, s } from '../lib/dom.js';
import { bytes } from '../lib/format.js';
import { setCrumbs } from '../lib/router.js';

function seededWeights(n) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = Math.max(1e-9, rnd());
    const v = rnd();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.35);
  }
  out[13] = 1.55; // a couple of outliers show why small groups help
  out[47] = -1.3;
  return out;
}

function quantize(ws, bits, gs, symmetric) {
  const deq = new Array(ws.length);
  const levels = [];
  for (let g = 0; g < ws.length; g += gs) {
    const grp = ws.slice(g, g + gs);
    if (symmetric) {
      const qmax = 2 ** (bits - 1) - 1;
      const amax = Math.max(...grp.map(Math.abs)) || 1e-8;
      const scale = amax / qmax;
      grp.forEach((w, i) => {
        const q = Math.max(-qmax - 1, Math.min(qmax, Math.round(w / scale)));
        deq[g + i] = q * scale;
      });
      levels.push({ start: g, end: g + grp.length, values: Array.from({ length: 2 * qmax + 2 }, (_, k) => (k - qmax - 1) * scale) });
    } else {
      const qmax = 2 ** bits - 1;
      const lo = Math.min(...grp);
      const hi = Math.max(...grp);
      const scale = (hi - lo) / qmax || 1e-8;
      const zero = Math.round(-lo / scale);
      grp.forEach((w, i) => {
        const q = Math.max(0, Math.min(qmax, Math.round(w / scale) + zero));
        deq[g + i] = (q - zero) * scale;
      });
      levels.push({ start: g, end: g + grp.length, values: Array.from({ length: qmax + 1 }, (_, k) => (k - zero) * scale) });
    }
  }
  return { deq, levels };
}

function q101() {
  const ws = seededWeights(64);
  const state = { bits: 4, gs: 16, symmetric: true };
  const W = 860;
  const H = 240;
  const pad = { l: 34, r: 10, t: 12, b: 20 };
  const svgEl = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const stats = h('div', { class: 'stats' });
  const x = (i) => pad.l + ((i + 0.5) / ws.length) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((1.8 - v) / 3.6) * (H - pad.t - pad.b);

  const draw = () => {
    const { deq, levels } = quantize(ws, state.bits, state.gs, state.symmetric);
    clear(svgEl);
    [-1.5, -1, -0.5, 0, 0.5, 1, 1.5].forEach((v) => {
      svgEl.append(
        s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: 'var(--border)', 'stroke-width': v === 0 ? 1.2 : 0.6 }),
        s('text', { x: 4, y: y(v) + 3, fill: 'var(--text-4)', 'font-size': 10 }, v.toFixed(1)),
      );
    });
    levels.forEach((lv, gi) => {
      if (gi % 2 === 0) svgEl.append(s('rect', { x: x(lv.start) - (x(1) - x(0)) / 2, y: pad.t, width: x(lv.end) - x(lv.start), height: H - pad.t - pad.b, fill: 'var(--hover)' }));
      if (lv.values.length <= 64)
        lv.values.forEach((v) => {
          if (v < -1.8 || v > 1.8) return;
          svgEl.append(s('line', { x1: x(lv.start) - 3, x2: x(lv.end - 1) + 3, y1: y(v), y2: y(v), stroke: 'var(--accent)', 'stroke-opacity': 0.18, 'stroke-width': 1 }));
        });
    });
    let se = 0;
    let maxErr = 0;
    ws.forEach((w, i) => {
      const e = deq[i] - w;
      se += e * e;
      maxErr = Math.max(maxErr, Math.abs(e));
      svgEl.append(
        s('line', { x1: x(i), x2: x(i), y1: y(w), y2: y(deq[i]), stroke: 'var(--danger)', 'stroke-width': 1.5, 'stroke-opacity': 0.8 }),
        s('circle', { cx: x(i), cy: y(w), r: 3.2, fill: 'var(--text-2)' }),
        s('rect', { x: x(i) - 3, y: y(deq[i]) - 3, width: 6, height: 6, rx: 1, fill: 'var(--bits-4)' }),
      );
    });
    const overhead = state.symmetric ? 16 / state.gs : 32 / state.gs;
    const bpw = state.bits + overhead;
    clear(stats).append(
      h('span', null, 'Effective bits/weight ', h('b', null, bpw.toFixed(2))),
      h('span', null, 'RMS error ', h('b', null, Math.sqrt(se / ws.length).toFixed(4))),
      h('span', null, 'Worst error ', h('b', null, maxErr.toFixed(3))),
      h('span', null, '8B model ≈ ', h('b', null, bytes((8e9 * bpw) / 8))),
    );
  };
  draw();

  return h(
    'div',
    { class: 'card q101' },
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', null, 'Quantization 101'), h('span', { class: 'muted small' }, '64 example weights: grey dots are originals, amber squares are what the quantized model stores, red lines are the error.')),
    h(
      'div',
      { class: 'row wrap gap-6', style: { marginBottom: '12px' } },
      segmented({ label: 'Bits', info: 'concept.bpw', value: 4, options: [2, 3, 4, 6, 8].map((b) => ({ value: b, label: `${b}-bit` })), onChange: (v) => ((state.bits = v), draw()) }),
      segmented({ label: 'Group size', info: 'concept.group_size', value: 16, options: [8, 16, 32, 64].map((g) => ({ value: g, label: String(g) })), onChange: (v) => ((state.gs = v), draw()) }),
      h('div', { style: { minWidth: '220px' } }, toggle({ label: 'Symmetric (no zero point)', info: 'concept.symmetric', value: true, onChange: (v) => ((state.symmetric = v), draw()) })),
    ),
    svgEl,
    stats,
  );
}

export default async function learnView(root, { query }) {
  setCrumbs([]);
  await kb.load();
  const view = h('div', { class: 'view wide' });
  root.appendChild(view);
  const list = h('div', { class: 'glossary' });
  const detail = h('div', { class: 'card pad selectable' });
  let selected = query.id || 'concept.quantization';

  const showDetail = (id) => {
    selected = id;
    clear(detail).appendChild(renderEntry(id, { full: true }));
    list.querySelectorAll('.g-item').forEach((el) => el.classList.toggle('on', el.dataset.id === id));
  };

  const renderList = (q) => {
    clear(list);
    const groups = new Map();
    for (const e of kb.search(q || '')) {
      if (!groups.has(e.file)) groups.set(e.file, []);
      groups.get(e.file).push(e);
    }
    for (const [file, entries] of groups) {
      list.appendChild(h('div', { class: 'g-head' }, kb.groupLabel(file)));
      for (const e of entries) {
        list.appendChild(
          h('div', { class: `g-item ${e.id === selected ? 'on' : ''}`, data: { id: e.id }, onClick: () => showDetail(e.id) }, h('div', null, e.title), h('div', { class: 'tg ellipsis' }, e.tagline)),
        );
      }
    }
    if (!groups.size) list.appendChild(h('div', { class: 'empty small' }, 'Nothing matches.'));
  };

  const searchInput = h('input', { class: 'input', placeholder: `Search ${kb.all().length} explanations…`, onInput: (e) => renderList(e.target.value) });

  view.append(
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Learn'), h('div', { class: 'sub' }, 'Everything the app can explain, in one place. Every option you can pick links here.'))),
    q101(),
    h('div', { class: 'section-title' }, icon('book-open', 'sm'), 'Glossary'),
    h('div', { class: 'learn-layout' }, h('div', { class: 'col' }, h('div', { class: 'input-with-icon' }, icon('search', 'sm'), searchInput), list), detail),
  );
  renderList('');
  showDetail(selected);
}
