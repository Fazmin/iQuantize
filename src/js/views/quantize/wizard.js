// Quantization wizard: source → goal → format → options → calibration/eval → review & start.
// State survives navigating away (module scope) so users can peek at Learn or Models.

import { button, callout } from '../../components/controls.js';
import { infoIcon } from '../../components/info.js';
import { showError, toast } from '../../components/overlay.js';
import { clear, debounce, h, icon } from '../../lib/dom.js';
import { bytes, fixed } from '../../lib/format.js';
import { call } from '../../lib/ipc.js';
import { go, setCrumbs } from '../../lib/router.js';
import { app } from '../../lib/store.js';
import { stepCalibration, stepFormat, stepGoal, stepHead, stepOptions, stepSource, variantLabelMlx, variantLabelOnnx } from './steps.js';

const STEPS = [
  ['source', 'Model'],
  ['goal', 'Goal'],
  ['format', 'Format'],
  ['options', 'Options'],
  ['calibration', 'Calibration & tests'],
  ['review', 'Review & start'],
];

let saved = null;

function defaults() {
  const info = app.get().info;
  const p = info?.platform || {};
  const nvidia = p.gpus?.find((g) => g.vendor === 'nvidia');
  const device = p.apple_silicon ? 'apple' : nvidia ? 'nvidia' : 'cpu';
  const memGb = Math.round(((device === 'nvidia' ? nvidia.vram_bytes : p.total_ram) || 16e9) / 1024 ** 3);
  return {
    step: 'source',
    modelId: null,
    goal: { device, memory_gb: memGb, runtime: 'any', priority: 50, context: 8192, usecase: 'chat' },
    formats: new Set(['gguf']),
    optionsTab: 'gguf',
    gguf: { base: 'auto', types: ['Q4_K_M'], imatrix: { enabled: false, chunks: 128, ctx: 512 }, output_tensor_type: null, token_embedding_type: null, leave_output_tensor: false, pure: false, tensor_types: [], keep_split: false, split_max_size_gb: 48, use_temp_file: false },
    mlx: { method: 'convert', variants: [{ bits: 4, group_size: 64, mode: 'affine', recipe: null, dtype: null }], rules: [], trust_remote_code: false, num_samples: null, sequence_length: null, target_bpw: null },
    onnx: { engine: 'builder', variants: [{ precision: 'int4', ep: device === 'nvidia' ? 'cuda' : 'cpu', block_size: 32, accuracy_level: 4, algo: 'k_quant', is_symmetric: true, head_int8: true }] },
    calibration: { source: 'wikitext2-train', path: null, dataset: null, split: 'train', column: 'text' },
    eval: { ppl: true, kld: true, chunks: 40, ctx: 512 },
    recs: null,
    estimates: {},
    estimateExtras: null,
  };
}

function recipes(ws) {
  const out = [];
  if (ws.formats.has('gguf')) out.push({ format: 'gguf', ...ws.gguf, tensor_types: ws.gguf.tensor_types.filter((r) => r.pattern), calibration: ws.calibration, eval: ws.eval });
  if (ws.formats.has('mlx')) out.push({ format: 'mlx', ...ws.mlx, rules: ws.mlx.rules.filter((r) => r.pattern), calibration: ws.calibration, eval: ws.eval });
  if (ws.formats.has('onnx')) out.push({ format: 'onnx', ...ws.onnx, eval: ws.eval });
  return out;
}

/** Everything a GGUF type card needs: estimate all types at once. */
function estimateRecipes(ws) {
  const all = ws.catalog.gguf.types.filter((t) => !t.alias_of).map((t) => t.name);
  return {
    gguf: { format: 'gguf', ...ws.gguf, types: all, tensor_types: ws.gguf.tensor_types.filter((r) => r.pattern) },
    mlx: { format: 'mlx', ...ws.mlx, rules: ws.mlx.rules.filter((r) => r.pattern) },
    onnx: { format: 'onnx', ...ws.onnx },
  };
}

export default async function wizard(root, { query }) {
  setCrumbs([]);
  const view = h('div', { class: 'view wide' });
  root.appendChild(view);
  const ws = saved || defaults();
  saved = ws;
  try {
    [ws.models, ws.catalog] = await Promise.all([call('models_list'), call('quant_catalog')]);
    ws.models = await Promise.all(ws.models.map((m) => call('model_get', { id: m.id }).catch(() => m)));
  } catch (e) {
    view.appendChild(callout('danger', 'circle-x', e.message));
    return;
  }
  if (!ws.catalog.mlx.supported) ws.formats.delete('mlx');

  ws.setModel = (id) => {
    if (ws.modelId !== id) {
      ws.modelId = id;
      ws.recs = null;
      ws.estimates = {};
    }
    ws.model = ws.models.find((m) => m.id === id) || null;
  };
  if (query.model) ws.setModel(query.model);
  else if (ws.modelId) ws.setModel(ws.modelId);
  else if (ws.models.length === 1 && ws.models[0].status === 'ready') ws.setModel(ws.models[0].id);
  if (ws.modelId && ws.step === 'source' && query.model) ws.step = 'goal';
  if (query.step && STEPS.some((s) => s[0] === query.step)) ws.step = query.step;
  if (query.formats) ws.formats = new Set(query.formats.split(',').filter((f) => ['gguf', 'mlx', 'onnx'].includes(f)));

  ws.applyCandidate = (c) => {
    ws.formats = new Set([c.format]);
    ws.optionsTab = c.format;
    if (c.format === 'gguf') {
      ws.gguf.types = [c.variant];
      if (c.needs_imatrix) ws.gguf.imatrix.enabled = true;
    } else if (c.format === 'mlx') {
      ws.mlx.method = 'convert';
      ws.mlx.variants = c.recipe.variants.map((v) => ({ ...v }));
    } else {
      ws.onnx.engine = 'builder';
      ws.onnx.variants = c.recipe.variants.map((v) => ({ ...v }));
    }
    toast(`Applied ${c.format.toUpperCase()} ${c.variant}`, { kind: 'success', detail: 'Fine-tune it in Options, or go straight to Review.' });
    refreshEstimates();
  };
  ws.applyExplore = (cands) => {
    ws.formats = new Set(cands.map((c) => c.format));
    const g = cands.filter((c) => c.format === 'gguf');
    if (g.length) {
      ws.gguf.types = g.map((c) => c.variant);
      if (g.some((c) => c.needs_imatrix)) ws.gguf.imatrix.enabled = true;
    }
    const m = cands.filter((c) => c.format === 'mlx');
    if (m.length) ws.mlx.variants = m.flatMap((c) => c.recipe.variants.map((v) => ({ ...v })));
    const o = cands.filter((c) => c.format === 'onnx');
    if (o.length) ws.onnx.variants = o.flatMap((c) => c.recipe.variants.map((v) => ({ ...v })));
    ws.eval.ppl = ws.eval.kld = true;
    toast('Explore mode', { kind: 'info', detail: `${cands.length} variants will be built and measured so you can compare size against quality.` });
    refreshEstimates();
  };

  const nav = h('div', { class: 'stepper' });
  const summary = h('div', { class: 'wizard-summary col gap-2' });
  const body = h('div', { class: 'wizard-body' });
  view.append(h('div', { class: 'wizard' }, h('div', { class: 'wizard-nav' }, h('h1', { style: { fontSize: '18px' } }, 'New quantization'), nav, summary), body));

  const canEnter = (id) => {
    const i = STEPS.findIndex((s) => s[0] === id);
    if (i > 0 && !ws.modelId) return false;
    if (i > 2 && !ws.formats.size) return false;
    return true;
  };

  async function refreshEstimatesNow() {
    if (!ws.modelId) return;
    const recs = estimateRecipes(ws);
    for (const f of ['gguf', 'mlx', 'onnx']) {
      if (f !== 'gguf' && !ws.formats.has(f)) continue;
      try {
        const r = await call('quant_estimate', { modelId: ws.modelId, recipe: recs[f] });
        ws.estimates[f] = r;
        ws.estimateExtras = r;
      } catch (e) {
        console.warn(e);
      }
    }
    if (['options', 'review', 'source'].includes(ws.step)) render(false);
    renderSummary();
  }
  const refreshEstimates = debounce(refreshEstimatesNow, 250);

  function selectedEstimates() {
    const rows = [];
    for (const f of ws.formats) {
      const variants = f === 'gguf' ? ws.gguf.types : f === 'mlx' ? ws.mlx.variants.map(variantLabelMlx) : ws.onnx.variants.map(variantLabelOnnx);
      for (const v of variants) {
        const e = ws.estimates[f]?.items?.find((x) => x.variant === v);
        rows.push({ format: f, variant: v, est: e?.estimate, tier: e?.tier });
      }
    }
    return rows;
  }

  function renderSummary() {
    const rows = selectedEstimates();
    const total = rows.reduce((a, r) => a + (r.est?.bytes || 0), 0);
    clear(summary).append(
      h('div', { class: 'muted xs' }, 'Model'),
      h('div', { class: 'ellipsis', style: { fontWeight: '600' } }, ws.model?.name || 'Not chosen'),
      h('div', { class: 'muted xs', style: { marginTop: '6px' } }, `${rows.length} output${rows.length === 1 ? '' : 's'}`),
      ...rows.slice(0, 8).map((r) => h('div', { class: 'row between small' }, h('span', { class: 'mono ellipsis' }, `${r.format.toUpperCase()} ${r.variant}`), h('span', { class: 'muted nowrap' }, r.est ? bytes(r.est.bytes) : '…'))),
      rows.length > 8 ? h('div', { class: 'small muted' }, `+${rows.length - 8} more`) : null,
      total ? h('div', { class: 'big', style: { marginTop: '6px' } }, bytes(total)) : null,
      total ? h('div', { class: 'xs muted' }, 'estimated total output size') : null,
    );
  }

  function renderNav() {
    const cur = STEPS.findIndex((s) => s[0] === ws.step);
    clear(nav).append(
      ...STEPS.map(([id, label], i) =>
        h(
          'button',
          { class: `step ${id === ws.step ? 'current' : i < cur ? 'done' : ''}`, disabled: !canEnter(id), onClick: () => ((ws.step = id), render()) },
          h('span', { class: 'n' }, i < cur ? icon('check', 'xs') : String(i + 1)),
          label,
        ),
      ),
    );
  }

  function reviewStep() {
    const el = h('div');
    const rs = recipes(ws);
    const rows = selectedEstimates();
    const total = rows.reduce((a, r) => a + (r.est?.bytes || 0), 0);
    const srcBytes = ws.model?.size_bytes || 0;
    const scratch = ws.formats.has('gguf') ? srcBytes * 1.05 : 0;
    const name = h('input', { class: 'input', placeholder: 'Recipe name, e.g. "Mac 16 GB balanced"' });
    el.append(
      stepHead('Review and start', 'Each format runs as its own background job: you can keep using the app, and watch every tensor being quantized live.'),
      h(
        'div',
        { class: 'card' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Output'), h('th', { class: 'num' }, 'Estimated size'), h('th', { class: 'num' }, 'Bits/weight'), h('th', null, 'Expected quality'))),
          h(
            'tbody',
            null,
            rows.map((r) => h('tr', null, h('td', { class: 'mono' }, `${r.format.toUpperCase()} · ${r.variant}`), h('td', { class: 'num' }, r.est ? bytes(r.est.bytes) : '…'), h('td', { class: 'num' }, r.est ? fixed(r.est.bpw, 2) : '…'), h('td', null, r.tier || '—'))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'grid-3', style: { marginTop: '12px' } },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Outputs', infoIcon('concept.disk_space')), h('div', { class: 'value' }, bytes(total))),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Temporary space'), h('div', { class: 'value' }, bytes(scratch)), h('div', { class: 'delta' }, 'Full-precision GGUF, kept as the reference for tests')),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Steps'), h('div', { class: 'value' }, String(rs.length)), h('div', { class: 'delta' }, rs.map((r) => r.format.toUpperCase()).join(' · '))),
      ),
      h(
        'ul',
        { class: 'small', style: { color: 'var(--text-2)', marginTop: '14px' } },
        ws.formats.has('gguf') ? h('li', null, `GGUF: convert → ${ws.gguf.imatrix.enabled ? 'importance matrix → ' : ''}quantize ${ws.gguf.types.join(', ')}${ws.eval.kld ? ' → measure perplexity + KLD' : ''}`) : null,
        ws.formats.has('mlx') ? h('li', null, `MLX (${ws.mlx.method}): ${ws.mlx.variants.map(variantLabelMlx).join(', ')}${ws.eval.kld ? ' → measure perplexity + KLD' : ''}`) : null,
        ws.formats.has('onnx') ? h('li', null, `ONNX (${ws.onnx.engine}): ${ws.onnx.variants.map(variantLabelOnnx).join(', ')}${ws.eval.kld ? ' → build reference → measure' : ''}`) : null,
      ),
      h(
        'div',
        { class: 'card pad row', style: { marginTop: '14px' } },
        name,
        button('Save as recipe', {
          iconName: 'save',
          onClick: async () => {
            try {
              for (const r of rs) await call('recipe_save', { name: `${name.value || 'Recipe'} (${r.format.toUpperCase()})`, recipe: r });
              toast('Recipe saved', { kind: 'success' });
            } catch (e) {
              showError(e);
            }
          },
        }),
      ),
    );
    return el;
  }

  function footer() {
    const i = STEPS.findIndex((s) => s[0] === ws.step);
    const next = STEPS[i + 1];
    const prev = STEPS[i - 1];
    const startBtn = button('Start quantization', {
      kind: 'primary',
      iconName: 'play',
      onClick: async () => {
        startBtn.disabled = true;
        try {
          const ids = await call('quant_start', { modelId: ws.modelId, recipes: recipes(ws) });
          toast(`Started ${ids.length} job${ids.length > 1 ? 's' : ''}`, { kind: 'success' });
          saved = null;
          go(`/jobs/${ids[0]}`);
        } catch (e) {
          startBtn.disabled = false;
          showError(e, 'Could not start');
        }
      },
    });
    return h(
      'div',
      { class: 'wizard-foot' },
      prev ? button('Back', { kind: 'ghost', iconName: 'arrow-left', onClick: () => ((ws.step = prev[0]), render()) }) : null,
      h('span', { class: 'spacer' }),
      button('Reset', { kind: 'ghost', onClick: () => ((saved = null), go('/quantize')) }),
      next ? button(`Continue: ${next[1]}`, { kind: 'primary', disabled: !canEnter(next[0]), onClick: () => ((ws.step = next[0]), render()) }) : startBtn,
    );
  }

  function render(scrollTop = true) {
    renderNav();
    renderSummary();
    const step = { source: stepSource, goal: stepGoal, format: stepFormat, options: stepOptions, calibration: stepCalibration, review: reviewStep }[ws.step];
    const rerender = () => {
      render(false);
      refreshEstimates();
    };
    const content = step(ws, rerender);
    const y = root.scrollTop;
    clear(body).append(content, footer());
    root.scrollTop = scrollTop ? 0 : y;
  }

  render();
  refreshEstimatesNow();
}
