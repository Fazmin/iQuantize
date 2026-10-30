// "Model X-ray": a canvas grid of every weight tensor. Columns are transformer blocks
// (embeddings on the left, output head on the right), rows are tensor kinds. Cells start in
// the source precision and fill with their new bit-width colour as quantization reaches them.

import { h } from '../lib/dom.js';
import { bytes, num } from '../lib/format.js';

const KIND_ORDER = [
  ['attn_q', 'Attention Q'],
  ['attn_k', 'Attention K'],
  ['attn_v', 'Attention V'],
  ['attn_qkv', 'Attention QKV'],
  ['attn_output', 'Attention out'],
  ['ffn_gate', 'FFN gate'],
  ['ffn_up', 'FFN up'],
  ['ffn_gate_up', 'FFN gate+up'],
  ['ffn_down', 'FFN down'],
  ['ffn_gate_exps', 'Experts gate'],
  ['ffn_up_exps', 'Experts up'],
  ['ffn_down_exps', 'Experts down'],
  ['ffn_gate_inp', 'Router'],
  ['norm', 'Norms'],
  ['other', 'Other'],
];

const BIT_STOPS = [
  [1.6, '--bits-1', '≤1.6'],
  [2.7, '--bits-2', '2'],
  [3.7, '--bits-3', '3'],
  [4.7, '--bits-4', '4'],
  [5.7, '--bits-5', '5'],
  [7, '--bits-6', '6'],
  [9, '--bits-8', '8'],
  [17, '--bits-16', '16'],
  [99, '--bits-32', '32'],
];

function hfKind(rest) {
  const r = rest.toLowerCase();
  if (/experts?\.\d+\.(gate_proj|w1)|experts\.gate/.test(r)) return 'ffn_gate_exps';
  if (/experts?\.\d+\.(up_proj|w3)|experts\.up/.test(r)) return 'ffn_up_exps';
  if (/experts?\.\d+\.(down_proj|w2)|experts\.down/.test(r)) return 'ffn_down_exps';
  if (/gate_up_proj/.test(r)) return 'ffn_gate_up';
  if (/(^|\.)(q_proj|wq|query)(\.|$)/.test(r)) return 'attn_q';
  if (/(^|\.)(k_proj|wk|key)(\.|$)/.test(r)) return 'attn_k';
  if (/(^|\.)(v_proj|wv|value)(\.|$)/.test(r)) return 'attn_v';
  if (/qkv|query_key_value|c_attn|wqkv/.test(r)) return 'attn_qkv';
  if (/(o_proj|out_proj|attn\.c_proj|self_attn\.dense|attention\.dense|wo)(\.|$)/.test(r)) return 'attn_output';
  if (/(mlp|feed_forward|ffn)\.(gate|router)(\.|$)|router/.test(r)) return 'ffn_gate_inp';
  if (/(gate_proj|w1|fc1)(\.|$)/.test(r)) return 'ffn_gate';
  if (/(up_proj|w3|c_fc|dense_h_to_4h)(\.|$)/.test(r)) return 'ffn_up';
  if (/(down_proj|w2|fc2|mlp\.c_proj|dense_4h_to_h)(\.|$)/.test(r)) return 'ffn_down';
  if (/norm|ln_/.test(r)) return 'norm';
  return 'other';
}

function ggufKind(k) {
  if (/norm/.test(k)) return 'norm';
  if (KIND_ORDER.some(([id]) => id === k)) return k;
  if (k.startsWith('attn_q')) return 'attn_q';
  if (k.startsWith('attn_k')) return 'attn_k';
  if (k.startsWith('attn_v')) return 'attn_v';
  return 'other';
}

/** Maps any tensor/module name to { block: number|'embed'|'head'|'other', kind }. */
export function classify(name) {
  const n = name.replace(/\.(weight|bias|scales|biases)$/, '');
  if (/(vision|visual|vit\.|mm_projector|multi_modal|audio|image)/i.test(n)) return { block: 'other', kind: 'other' };
  let m = n.match(/^blk\.(\d+)\.(.+)$/);
  if (m) return { block: Number(m[1]), kind: ggufKind(m[2]) };
  if (/^token_embd/.test(n)) return { block: 'embed', kind: 'other' };
  if (/^output_norm/.test(n)) return { block: 'head', kind: 'norm' };
  if (/^output$/.test(n)) return { block: 'head', kind: 'other' };
  m = n.match(/(?:^|\.)(?:layers|h|blocks|layer|decoder\.layers)\.(\d+)\.(.+)$/);
  if (m) return { block: Number(m[1]), kind: hfKind(m[2]) };
  if (/embed_tokens|wte|word_embeddings|tok_embeddings|embedding/.test(n)) return { block: 'embed', kind: 'other' };
  if (/lm_head/.test(n)) return { block: 'head', kind: 'other' };
  if (/(^|\.)(norm|ln_f|final_layernorm|final_layer_norm)$/.test(n)) return { block: 'head', kind: 'norm' };
  return { block: 'other', kind: 'other' };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function bitsVar(bits) {
  for (const [max, v] of BIT_STOPS) if (bits <= max) return v;
  return '--bits-32';
}

export function bitsFromDtype(dtype) {
  const d = String(dtype || '').toUpperCase();
  if (/F32|FLOAT32/.test(d)) return 32;
  if (/F16|BF16|FLOAT16|BFLOAT16/.test(d)) return 16;
  if (/Q8|INT8|MXFP8|^8$/.test(d)) return 8.5;
  if (/Q6/.test(d)) return 6.56;
  if (/Q5/.test(d)) return 5.5;
  if (/Q4|IQ4|INT4|MXFP4|NVFP4/.test(d)) return 4.5;
  if (/Q3|IQ3/.test(d)) return 3.4;
  if (/Q2|IQ2|TQ2/.test(d)) return 2.4;
  if (/IQ1|TQ1|Q1/.test(d)) return 1.6;
  const m = d.match(/(\d+)/);
  return m ? Number(m[1]) : 16;
}

/**
 * tensors: [{ name, shape, dtype, bytes, n_elements, bits? }]
 * Returns { el, markDone(name, info), markActive(name), markBlock(block, bits), reset(), stats() }.
 */
export function tensorMap(tensors, { height = 210, showLegend = true } = {}) {
  const cells = new Map(); // key "block|kind" -> cell
  const byName = new Map();
  let maxBlock = -1;
  const kinds = new Set();
  for (const t of tensors) {
    const c = classify(t.name);
    if (typeof c.block === 'number') maxBlock = Math.max(maxBlock, c.block);
    kinds.add(c.kind);
    const key = `${c.block}|${c.kind}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { block: c.block, kind: c.kind, tensors: [], params: 0, srcBytes: 0, srcBits: 0, done: 0, outBytes: 0, outParams: 0, active: false };
      cells.set(key, cell);
    }
    const n = t.n_elements || (t.shape || []).reduce((a, b) => a * b, 1);
    const bits = t.bits || bitsFromDtype(t.dtype);
    cell.tensors.push({ name: t.name, shape: t.shape, dtype: t.dtype, n, bytes: t.bytes || (n * bits) / 8, srcBits: bits, out: null });
    cell.params += n;
    cell.srcBytes += t.bytes || (n * bits) / 8;
    byName.set(t.name.replace(/\.(weight|bias)$/, ''), { cell, idx: cell.tensors.length - 1 });
  }
  for (const c of cells.values()) c.srcBits = c.params ? (c.srcBytes * 8) / c.params : 16;
  const rowKinds = KIND_ORDER.filter(([k]) => kinds.has(k));
  const columns = [];
  if ([...cells.values()].some((c) => c.block === 'embed')) columns.push('embed');
  for (let b = 0; b <= maxBlock; b++) columns.push(b);
  if ([...cells.values()].some((c) => c.block === 'head')) columns.push('head');
  if ([...cells.values()].some((c) => c.block === 'other')) columns.push('other');

  const canvas = h('canvas');
  const tip = h('div', { class: 'xray-tip hidden' });
  const legend = showLegend
    ? h(
        'div',
        { class: 'xray-legend' },
        h('span', null, h('i', { style: { background: 'var(--cell-empty)' } }), 'Waiting'),
        BIT_STOPS.slice(0, 8).map(([, v, label]) => h('span', null, h('i', { style: { background: `var(${v})` } }), `${label}-bit`)),
        h('span', { class: 'muted' }, 'Faded = original precision · solid = quantized'),
      )
    : null;
  const el = h('div', { class: 'xray col gap-2' }, canvas, legend);
  document.body.appendChild(tip);

  const labelW = 96;
  const pad = 4;
  let W = 0;
  let geometry = null;
  let pulse = 0;
  let raf = null;
  let anyActive = false;

  function layout() {
    W = el.clientWidth || 900;
    const rows = rowKinds.length || 1;
    const cols = columns.length || 1;
    const cw = Math.max(3, Math.min(26, (W - labelW - pad) / cols));
    const ch = Math.max(10, Math.min(22, (height - 22) / rows));
    geometry = { cw, ch, rows, cols, H: rows * ch + 22 };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(geometry.H * dpr);
    canvas.style.height = `${geometry.H}px`;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function colX(i) {
    return labelW + i * geometry.cw;
  }

  function draw() {
    if (!geometry) layout();
    const ctx = canvas.getContext('2d');
    const { cw, ch } = geometry;
    ctx.clearRect(0, 0, W, geometry.H);
    const textColor = cssVar('--text-3');
    const empty = cssVar('--cell-empty');
    const accent = cssVar('--accent');
    ctx.font = '10.5px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    rowKinds.forEach(([k, label], r) => {
      ctx.fillStyle = textColor;
      ctx.fillText(label, 0, r * ch + ch / 2);
      columns.forEach((col, i) => {
        const cell = cells.get(`${col}|${k}`);
        const x = colX(i) + 1;
        const y = r * ch + 1;
        const w = Math.max(1, cw - 2);
        const hh = ch - 2;
        if (!cell) return;
        const total = cell.tensors.length;
        if (cell.done === 0) {
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = cssVar(bitsVar(cell.srcBits));
          ctx.fillRect(x, y, w, hh);
          ctx.globalAlpha = 1;
          if (cell.srcBits >= 16) {
            ctx.fillStyle = empty;
            ctx.globalAlpha = 0.55;
            ctx.fillRect(x, y, w, hh);
            ctx.globalAlpha = 1;
          }
        } else {
          const bits = cell.outParams ? (cell.outBytes * 8) / cell.outParams : cell.srcBits;
          ctx.fillStyle = cssVar(bitsVar(bits));
          const frac = cell.done / total;
          ctx.fillRect(x, y + hh * (1 - frac), w, hh * frac);
          if (frac < 1) {
            ctx.globalAlpha = 0.25;
            ctx.fillRect(x, y, w, hh * (1 - frac));
            ctx.globalAlpha = 1;
          }
        }
        if (cell.active) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.55 + 0.45 * Math.sin(pulse / 4);
          ctx.strokeRect(x - 0.5, y - 0.5, w + 1, hh + 1);
          ctx.globalAlpha = 1;
        }
      });
    });
    // Column labels.
    ctx.fillStyle = textColor;
    const yLab = geometry.rows * ch + 12;
    const every = Math.max(1, Math.ceil(30 / cw));
    let lastEnd = -Infinity;
    columns.forEach((col, i) => {
      const lbl = col === 'embed' ? 'emb' : col === 'head' ? 'out' : col === 'other' ? '…' : typeof col === 'number' && col % every === 0 ? String(col) : '';
      const x = colX(i) + 1;
      if (!lbl || x < lastEnd + 4) return;
      ctx.fillText(lbl, x, yLab);
      lastEnd = x + ctx.measureText(lbl).width;
    });
  }

  function animate() {
    pulse++;
    draw();
    raf = anyActive ? requestAnimationFrame(animate) : null;
  }

  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (!geometry || x < labelW) return null;
    const ci = Math.floor((x - labelW) / geometry.cw);
    const ri = Math.floor(y / geometry.ch);
    if (ri < 0 || ri >= rowKinds.length || ci < 0 || ci >= columns.length) return null;
    return cells.get(`${columns[ci]}|${rowKinds[ri][0]}`) || null;
  }

  canvas.addEventListener('mousemove', (ev) => {
    const c = cellAt(ev);
    if (!c) {
      tip.classList.add('hidden');
      return;
    }
    const where = c.block === 'embed' ? 'Embeddings' : c.block === 'head' ? 'Output head' : c.block === 'other' ? 'Other tensors' : `Block ${c.block}`;
    const kindLabel = (KIND_ORDER.find(([k]) => k === c.kind) || [, c.kind])[1];
    const first = c.tensors[0];
    const out = c.tensors.filter((t) => t.out);
    tip.replaceChildren(
      h('div', null, h('b', null, `${where} · ${kindLabel}`)),
      h('div', null, c.tensors.length === 1 ? first.name : `${c.tensors.length} tensors`),
      h('div', null, `${num(c.params / 1e6, 2)}M params${first.shape ? ` · shape ${first.shape.join('×')}` : ''}`),
      h('div', null, `Before: ${first.dtype} · ${bytes(c.srcBytes)}`),
      out.length ? h('div', null, `After: ${[...new Set(out.map((t) => t.out.to))].join(', ')} · ${bytes(c.outBytes)} (${((c.outBytes * 8) / Math.max(1, c.outParams)).toFixed(2)} bpw)`) : h('div', { class: 'muted' }, 'Not quantized yet'),
    );
    tip.classList.remove('hidden');
    const tr = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tr.width - 8)}px`;
    tip.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - tr.height - 8)}px`;
  });
  canvas.addEventListener('mouseleave', () => tip.classList.add('hidden'));

  const ro = new ResizeObserver(() => {
    layout();
    draw();
  });
  ro.observe(el);

  let activeCell = null;
  function setActive(cell) {
    if (activeCell) activeCell.active = false;
    activeCell = cell;
    if (cell) cell.active = true;
    anyActive = !!cell;
    if (anyActive && !raf) raf = requestAnimationFrame(animate);
  }

  function lookup(name) {
    const key = name.replace(/\.(weight|bias)$/, '');
    if (byName.has(key)) return byName.get(key);
    const c = classify(name);
    const cell = cells.get(`${c.block}|${c.kind}`);
    if (!cell) return null;
    const idx = cell.tensors.findIndex((t) => !t.out);
    return { cell, idx: idx < 0 ? 0 : idx };
  }

  const api = {
    el,
    /** Marks one tensor as quantized. info: { to, bits, bytes_out } */
    markDone(name, info) {
      const hit = lookup(name);
      if (!hit) return false;
      const t = hit.cell.tensors[hit.idx];
      if (!t.out) hit.cell.done++;
      else {
        hit.cell.outBytes -= t.out.bytes;
        hit.cell.outParams -= t.n;
      }
      t.out = { to: info.to, bits: info.bits, bytes: info.bytes_out ?? (t.n * (info.bits || 4)) / 8 };
      hit.cell.outBytes += t.out.bytes;
      hit.cell.outParams += t.n;
      setActive(hit.cell.done < hit.cell.tensors.length ? hit.cell : null);
      if (!raf) draw();
      return true;
    },
    markActive(name) {
      const hit = lookup(name);
      setActive(hit ? hit.cell : null);
      if (!raf) draw();
    },
    /** Marks every cell of a block (ONNX builder reports per layer). */
    markBlock(block, bits, to) {
      for (const cell of cells.values()) {
        if (cell.block !== block) continue;
        for (const t of cell.tensors) {
          if (t.out) continue;
          const b = cell.kind === 'norm' ? t.srcBits : bits;
          t.out = { to: cell.kind === 'norm' ? t.dtype : to, bits: b, bytes: (t.n * b) / 8 };
          cell.done++;
          cell.outBytes += t.out.bytes;
          cell.outParams += t.n;
        }
      }
      const nextCol = typeof block === 'number' ? block + 1 : null;
      const next = nextCol != null ? [...cells.values()].find((c) => c.block === nextCol) : null;
      setActive(next || null);
      if (!raf) draw();
    },
    finish() {
      setActive(null);
      draw();
    },
    stats() {
      let total = 0;
      let done = 0;
      let src = 0;
      let out = 0;
      let outParams = 0;
      let params = 0;
      for (const c of cells.values()) {
        total += c.tensors.length;
        done += c.done;
        src += c.srcBytes;
        out += c.outBytes;
        outParams += c.outParams;
        params += c.params;
      }
      return { total, done, srcBytes: src, outBytes: out, outParams, params };
    },
    /** Histogram of output bits weighted by params: [{ bits, params, label }]. */
    histogram() {
      const hist = new Map();
      for (const c of cells.values())
        for (const t of c.tensors) {
          if (!t.out) continue;
          const key = t.out.to;
          const e = hist.get(key) || { label: key, bits: t.out.bits, params: 0 };
          e.params += t.n;
          hist.set(key, e);
        }
      return [...hist.values()].sort((a, b) => b.params - a.params);
    },
    dispose() {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      tip.remove();
    },
  };
  requestAnimationFrame(() => {
    layout();
    draw();
  });
  return api;
}
