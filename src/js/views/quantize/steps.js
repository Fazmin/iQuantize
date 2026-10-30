// Wizard steps: source, goal (recommendations), format, per-format options, calibration/eval.

import { badge, button, callout, checkbox, dropdown, empty, numberField, optionCard, segmented, slider, textField, toggle } from '../../components/controls.js';
import { attachInfo, infoIcon } from '../../components/info.js';
import { showError } from '../../components/overlay.js';
import { clear, debounce, h, icon } from '../../lib/dom.js';
import { bitsColorVar, bytes, fixed, num, params as fmtParams } from '../../lib/format.js';
import { call } from '../../lib/ipc.js';
import { go } from '../../lib/router.js';
import { compatDots } from '../models.js';

const STARS = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

export function stepHead(title, text) {
  return h('div', { class: 'wizard-step-head' }, h('h2', null, title), h('p', null, text));
}

/* ---------------- Source ---------------- */

export function stepSource(ws, rerender) {
  const el = h('div');
  el.append(stepHead('Choose the model to quantize', 'Start from the original, full-precision model (usually BF16 or FP16 safetensors). Quantizing an already-quantized model compounds the error.'));
  if (!ws.models.length) {
    el.append(
      h(
        'div',
        { class: 'card' },
        empty({
          iconName: 'box',
          title: 'Your library is empty',
          text: 'Add a model from Hugging Face or import a folder first.',
          action: button('Add a model', { kind: 'primary', iconName: 'download', onClick: () => go('/models?add=hf') }),
        }),
      ),
    );
    return el;
  }
  const grid = h('div', { class: 'grid-2' });
  for (const m of ws.models) {
    grid.appendChild(
      optionCard({
        title: m.name,
        desc: [m.params ? fmtParams(m.params) : null, m.dtype, m.size_bytes ? bytes(m.size_bytes) : null, m.architecture].filter(Boolean).join(' · '),
        info: 'concept.params',
        selected: ws.modelId === m.id,
        disabled: m.status !== 'ready',
        badges: [compatDots(m.compat), m.status !== 'ready' ? badge(m.status, 'warning') : null].filter(Boolean),
        onClick: () => {
          ws.setModel(m.id);
          rerender();
        },
      }),
    );
  }
  el.append(grid, h('div', { class: 'row', style: { marginTop: '12px' } }, button('Add another model', { kind: 'ghost', iconName: 'plus', onClick: () => go('/models?add=hf') })));
  if (ws.model) el.append(modelNotes(ws));
  return el;
}

function modelNotes(ws) {
  const m = ws.model;
  const notes = [];
  const a = m.info?.arch || {};
  if (a.quantization) notes.push(callout('warning', 'triangle-alert', h('div', null, h('b', null, `Already quantized (${a.quantization}). `), 'Results will be worse than starting from the original weights. ', infoIcon('concept.already_quantized'))));
  const odd = ws.estimateExtras?.row_widths?.not_256_aligned || [];
  if (odd.length)
    notes.push(
      callout(
        'info',
        'info',
        h('div', null, h('b', null, 'Heads-up for GGUF: '), `some weight rows are ${odd.join(', ')} wide, not a multiple of 256. llama.cpp then stores those tensors with a simpler 32-wide format (e.g. Q4_K → Q5_0), so files come out larger than the type name suggests. This is normal for small models. `, infoIcon('concept.kquants')),
      ),
    );
  if (a.multimodal) notes.push(callout('info', 'info', 'Multimodal model: the language model is quantized; vision/audio towers may need extra steps per format.'));
  return notes.length ? h('div', { class: 'col gap-2', style: { marginTop: '16px' } }, notes) : h('div');
}

/* ---------------- Goal ---------------- */

const DEVICES = [
  ['apple', 'Apple Silicon Mac', 'hw.device.apple_silicon'],
  ['nvidia', 'NVIDIA GPU', 'hw.device.nvidia'],
  ['amd', 'AMD GPU', 'hw.device.amd'],
  ['cpu', 'CPU only', 'hw.device.cpu_only'],
  ['edge', 'Phone / edge', 'hw.device.edge'],
  ['browser', 'Web browser', 'hw.device.browser'],
];
const RUNTIMES = [
  ['any', 'No preference', 'goal.runtime.any'],
  ['llamacpp', 'llama.cpp', 'goal.runtime.llamacpp'],
  ['lmstudio', 'LM Studio', 'goal.runtime.lmstudio'],
  ['ollama', 'Ollama', 'goal.runtime.ollama'],
  ['mlx_apps', 'MLX apps (mlx-lm, LM Studio MLX)', 'goal.runtime.mlx_apps'],
  ['ort', 'ONNX Runtime (Windows, servers, mobile)', 'goal.runtime.ort'],
  ['web', 'In the browser (WebGPU)', 'goal.runtime.web'],
];
const USECASES = [
  ['chat', 'Chat'],
  ['code', 'Code'],
  ['rag', 'RAG / docs'],
  ['agents', 'Agents & tools'],
  ['creative', 'Creative'],
  ['multilingual', 'Multilingual'],
];

export function stepGoal(ws, rerender) {
  const g = ws.goal;
  const el = h('div');
  const recHost = h('div', { class: 'col gap-3' });
  const refresh = debounce(async () => {
    if (!ws.modelId) return;
    clear(recHost).appendChild(h('div', { class: 'row muted small' }, h('div', { class: 'spinner' }), 'Working out what fits…'));
    try {
      ws.recs = await call('quant_recommend', { modelId: ws.modelId, goal: g });
      renderRecs();
    } catch (e) {
      clear(recHost).appendChild(callout('danger', 'circle-x', e.message));
    }
  }, 300);
  const set = (k) => (v) => {
    g[k] = v;
    refresh();
  };

  function renderRecs() {
    const r = ws.recs;
    clear(recHost);
    if (!r) return;
    recHost.append(
      h(
        'div',
        { class: 'row small muted' },
        icon('memory-stick', 'sm'),
        `Memory budget ${bytes(r.budget_bytes)} · KV cache at ${num(g.context, 0)} tokens ≈ ${bytes(r.kv_bytes)}`,
        infoIcon('goal.recommendation'),
      ),
    );
    if (!r.best.length) recHost.append(callout('warning', 'triangle-alert', 'Nothing fits this budget. Lower the context length, raise the memory, or pick a smaller model.'));
    const cards = h('div', { class: 'grid-3' });
    for (const c of r.best) {
      cards.appendChild(
        optionCard({
          title: `${c.format.toUpperCase()} · ${c.variant}`,
          info: c.kb,
          desc: `${bytes(c.est_bytes)} file · ${fixed(c.bpw, 2)} bits/weight · needs ~${bytes(c.mem_bytes)}`,
          right: h('span', { class: 'small', title: c.tier }, STARS(c.stars)),
          children: h(
            'div',
            { class: 'col gap-1 rec-card' },
            h('div', { class: 'small', style: { fontWeight: '500' } }, c.tier),
            c.reasons.slice(0, 2).map((x) => h('div', { class: 'why' }, `• ${x}`)),
            c.warnings.map((x) => h('div', { class: 'why warning-text' }, `⚠ ${x}`)),
            h('div', { class: 'row', style: { marginTop: '6px' } }, button('Use this', { size: 'sm', kind: 'primary', onClick: (ev) => (ev.stopPropagation(), ws.applyCandidate(c), rerender()) })),
          ),
        }),
      );
    }
    recHost.append(cards);
    const fitting = r.candidates.filter((c) => c.fits);
    recHost.append(
      h(
        'div',
        { class: 'row' },
        button(`Explore: try the ${Math.min(5, fitting.length)} best options and compare`, {
          iconName: 'chart-scatter',
          onClick: () => {
            ws.applyExplore(fitting.slice(0, 5));
            rerender();
          },
        }),
        infoIcon('goal.explore'),
      ),
    );
    const table = h(
      'table',
      { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Option'), h('th', { class: 'num' }, 'File'), h('th', { class: 'num' }, 'Memory'), h('th', null, 'Expected quality'), h('th', null, ''))),
      h(
        'tbody',
        null,
        r.candidates.map((c) =>
          h(
            'tr',
            null,
            h('td', null, h('span', { class: 'mono' }, `${c.format.toUpperCase()} ${c.variant}`), ' ', infoIcon(c.kb)),
            h('td', { class: 'num' }, bytes(c.est_bytes)),
            h('td', { class: 'num' }, bytes(c.mem_bytes)),
            h('td', null, `${STARS(c.stars)} ${c.tier}`),
            h('td', null, c.fits ? badge('fits', 'success') : badge('too big', 'danger')),
          ),
        ),
      ),
    );
    const det = h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer', margin: '6px 0' } }, `All ${r.candidates.length} options considered`), h('div', { class: 'card', style: { marginTop: '8px' } }, table));
    recHost.append(det);
  }

  el.append(
    stepHead('What do you want it to run on?', 'Tell iQuantize where the model will run and what matters most. It estimates size and memory for every option and recommends the best fit, with reasons.'),
    h(
      'div',
      { class: 'card pad col gap-4' },
      segmented({ label: 'Device', info: 'goal.device', value: g.device, options: DEVICES.map(([v, l, i]) => ({ value: v, label: l, info: i })), onChange: set('device') }),
      h(
        'div',
        { class: 'grid-2' },
        slider({ label: 'Memory available for the model', info: 'goal.memory', min: 2, max: 256, step: 1, value: g.memory_gb, format: (v) => `${v} GB`, onChange: set('memory_gb'), help: 'Unified memory on a Mac, VRAM on a GPU, or RAM for CPU.' }),
        dropdown({ label: 'Where will you run it?', info: 'goal.runtime.any', value: g.runtime, options: RUNTIMES.map(([v, l, i]) => ({ value: v, label: l, info: i })), onChange: set('runtime') }),
      ),
      h(
        'div',
        { class: 'grid-2' },
        slider({ label: 'Priority', info: 'goal.priority', min: 0, max: 100, step: 5, value: g.priority, format: (v) => (v < 35 ? 'Quality first' : v > 65 ? 'Size & speed first' : 'Balanced'), marks: ['Best quality', 'Balanced', 'Smallest & fastest'], onChange: set('priority') }),
        segmented({
          label: 'Context length you need',
          info: 'goal.context',
          value: g.context,
          options: [2048, 4096, 8192, 32768, 131072].map((c) => ({ value: c, label: c >= 1024 ? `${c / 1024}k` : String(c) })),
          onChange: set('context'),
        }),
      ),
      segmented({ label: 'Main use', info: `goal.usecase.${g.usecase}`, value: g.usecase, options: USECASES.map(([v, l]) => ({ value: v, label: l, info: `goal.usecase.${v}` })), onChange: set('usecase') }),
    ),
    h('div', { class: 'section-title' }, icon('sparkles', 'sm'), 'Recommendations'),
    recHost,
  );
  if (ws.recs) renderRecs();
  else refresh();
  return el;
}

/* ---------------- Format ---------------- */

export function stepFormat(ws, rerender) {
  const el = h('div');
  const cat = ws.catalog;
  const compat = ws.model?.compat || {};
  const fmt = [
    ['gguf', 'GGUF', 'llama.cpp, LM Studio, Ollama, Jan… Runs on every OS, CPU or GPU.', { size: 4, quality: 4, speed: 4, effort: 5 }],
    ['mlx', 'MLX', "Apple's native format: usually the fastest on Apple Silicon Macs.", { size: 4, quality: 4, speed: 5, effort: 5 }],
    ['onnx', 'ONNX', 'ONNX Runtime GenAI: Windows (DirectML), servers (CUDA), mobile and the web (WebGPU).', { size: 3, quality: 4, speed: 4, effort: 3 }],
  ];
  const grid = h('div', { class: 'grid-3' });
  for (const [id, name, desc, meters] of fmt) {
    const installed = cat.installed[id];
    const c = compat[id] || { status: 'unknown' };
    const unsupported = (id === 'mlx' && !cat.mlx.supported) || c.status === 'no';
    const badges = [
      badge(c.status === 'yes' ? 'Supported' : c.status === 'warn' ? 'Check notes' : c.status === 'no' ? 'Not supported' : 'Unknown', { yes: 'success', warn: 'warning', no: 'danger' }[c.status] || ''),
      installed ? null : badge('Tools not installed', 'outline'),
    ].filter(Boolean);
    grid.appendChild(
      optionCard({
        title: name,
        desc,
        info: `format.${id}`,
        meters,
        selected: ws.formats.has(id),
        disabled: unsupported,
        badges,
        children: c.reason ? h('div', { class: 'small muted' }, c.reason) : null,
        onClick: () => {
          if (!installed) {
            go('/environment');
            return;
          }
          if (ws.formats.has(id)) ws.formats.delete(id);
          else ws.formats.add(id);
          rerender();
        },
      }),
    );
  }
  el.append(
    stepHead('Pick output formats', 'You can produce several at once; each becomes its own job. Not sure? Hover a card, or open "Which format should I choose?".'),
    grid,
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'small muted' }, 'Which format should I choose?'), infoIcon('format.compare')),
  );
  return el;
}

/* ---------------- Options ---------------- */

function sizeNote(ws, fmt, variant) {
  const e = ws.estimates[fmt]?.items?.find((x) => x.variant === variant);
  if (!e) return null;
  return `≈ ${bytes(e.estimate.bytes)} · ${fixed(e.estimate.bpw, 2)} bits/weight${e.tier ? ` · expected quality: ${e.tier}` : ''}`;
}

const GGUF_GROUPS = [
  ['Recommended', ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'IQ4_XS', 'Q3_K_M', 'IQ3_M']],
  ['K-quants', ['Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'Q2_K', 'Q2_K_S']],
  ['I-quants (need an importance matrix below 4 bits)', ['IQ4_XS', 'IQ4_NL', 'IQ3_M', 'IQ3_S', 'IQ3_XS', 'IQ3_XXS', 'IQ2_M', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S']],
  ['Legacy & special', ['Q8_0', 'Q5_1', 'Q5_0', 'Q4_1', 'Q4_0', 'Q2_0', 'Q1_0', 'TQ2_0', 'TQ1_0', 'MXFP4_MOE', 'F16', 'BF16']],
];

const PRESETS = {
  none: [],
  protect_sensitive: [
    { pattern: 'attn_v', type: 'Q6_K' },
    { pattern: 'ffn_down', type: 'Q6_K' },
  ],
  edges_higher: [
    { pattern: 'blk\\.(0|1)\\.', type: 'Q6_K' },
    { pattern: 'blk\\.(LAST)\\.', type: 'Q6_K' },
  ],
  embed_q8: [],
};

function ggufOptions(ws, rerender) {
  const g = ws.gguf;
  const types = ws.catalog.gguf.types.filter((t) => !t.alias_of);
  const byName = new Map(types.map((t) => [t.name, t]));
  const budget = ws.recs?.budget_bytes;
  const el = h('div', { class: 'col gap-4' });
  const forced = g.types.some((t) => byName.get(t)?.requires_imatrix);

  const grid = (names) =>
    h(
      'div',
      { class: 'qtype-grid' },
      names
        .filter((n) => byName.has(n))
        .map((n) => {
          const t = byName.get(n);
          const est = ws.estimates.gguf?.items?.find((x) => x.variant === n);
          const on = g.types.includes(n);
          const fits = budget && est ? est.estimate.bytes + (ws.recs?.kv_bytes || 0) < budget : null;
          const card = h(
            'div',
            {
              class: `qtype ${on ? 'on' : ''}`,
              role: 'checkbox',
              'aria-checked': String(on),
              tabindex: '0',
              onClick: () => {
                g.types = on ? g.types.filter((x) => x !== n) : [...g.types, n];
                rerender();
              },
            },
            h('div', { class: 'nm' }, h('i', { class: 'swatch', style: { background: bitsColorVar(t.body_bpw) } }), n, t.requires_imatrix ? icon('lock', 'xs') : null, h('span', { class: 'spacer' }), on ? icon('circle-check', 'sm accent-text') : null),
            h('div', { class: 'ln' }, h('span', null, est ? bytes(est.estimate.bytes) : '…'), h('span', null, est ? `${fixed(est.estimate.bpw, 2)} bpw` : `${fixed(t.body_bpw, 2)} bpw`)),
            h('div', { class: 'ln' }, h('span', null, est?.tier || ''), fits == null ? null : h('span', { class: fits ? 'success-text fit' : 'danger-text fit' }, fits ? 'fits' : 'too big')),
          );
          attachInfo(card, t.kb, { note: () => [sizeNote(ws, 'gguf', n), t.ppl_delta_8b != null ? `On Llama-3-8B this type adds ~${fixed(t.ppl_delta_8b, 3)} perplexity${t.ppl_estimated ? ' (estimated)' : ''}.` : null, t.requires_imatrix ? 'Requires an importance matrix (turned on automatically).' : null].filter(Boolean).join(' ') });
          return card;
        }),
    );

  el.append(
    h(
      'div',
      { class: 'card pad col gap-3' },
      h('div', { class: 'row' }, h('b', null, 'Quantization types'), infoIcon('concept.kquants'), h('span', { class: 'muted small' }, `${g.types.length} selected · each becomes its own file`)),
      ...GGUF_GROUPS.map(([label, names]) => h('div', { class: 'col gap-2' }, h('div', { class: 'small muted' }, label), grid(names))),
    ),
    h(
      'div',
      { class: 'card pad col gap-3' },
      toggle({
        label: forced ? 'Importance matrix (required by a selected type)' : 'Use an importance matrix (calibration)',
        info: 'gguf.opt.imatrix',
        value: g.imatrix.enabled || forced,
        disabled: forced,
        onChange: (v) => ((g.imatrix.enabled = v), rerender()),
        help: 'Measures which weights matter most on sample text, then protects them. Strongly recommended below 4 bits; cached and reused afterwards.',
      }),
      g.imatrix.enabled || forced
        ? h(
            'div',
            { class: 'grid-2' },
            numberField({ label: 'Calibration chunks', info: 'gguf.opt.imatrix_chunks', value: g.imatrix.chunks, min: 8, max: 2000, onChange: (v) => (g.imatrix.chunks = v) }),
            numberField({ label: 'Tokens per chunk', info: 'gguf.opt.imatrix_ctx', value: g.imatrix.ctx, min: 128, max: 8192, step: 128, onChange: (v) => (g.imatrix.ctx = v) }),
          )
        : null,
    ),
    h(
      'details',
      { class: 'card pad' },
      h('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, 'Advanced'),
      h(
        'div',
        { class: 'col gap-4', style: { marginTop: '14px' } },
        segmented({
          label: 'Intermediate precision',
          info: 'gguf.base.auto',
          value: g.base,
          options: [
            { value: 'auto', label: 'Auto', info: 'gguf.base.auto' },
            { value: 'bf16', label: 'BF16', info: 'gguf.base.BF16' },
            { value: 'f16', label: 'F16', info: 'gguf.base.F16' },
            { value: 'f32', label: 'F32', info: 'gguf.base.F32' },
            { value: 'q8_0', label: 'Q8_0', info: 'gguf.base.Q8_0' },
          ],
          onChange: (v) => (g.base = v),
        }),
        h(
          'div',
          { class: 'grid-2' },
          dropdown({
            label: 'Output (LM head) type',
            info: 'gguf.opt.output_tensor_type',
            value: g.output_tensor_type || '',
            options: [{ value: '', label: 'Default for the chosen type' }, ...['Q8_0', 'Q6_K', 'Q5_K', 'Q4_K', 'F16', 'BF16'].map((t) => ({ value: t, label: t, info: `gguf.qtype.${t === 'Q5_K' ? 'Q5_K_M' : t === 'Q4_K' ? 'Q4_K_M' : t}` }))],
            onChange: (v) => (g.output_tensor_type = v || null),
          }),
          dropdown({
            label: 'Token embedding type',
            info: 'gguf.opt.token_embedding_type',
            value: g.token_embedding_type || '',
            options: [{ value: '', label: 'Default for the chosen type' }, ...['Q8_0', 'Q6_K', 'Q5_K', 'Q4_K', 'F16'].map((t) => ({ value: t, label: t }))],
            onChange: (v) => (g.token_embedding_type = v || null),
          }),
        ),
        h(
          'div',
          { class: 'grid-2' },
          toggle({ label: 'Leave output tensor unquantized', info: 'gguf.opt.leave_output_tensor', value: g.leave_output_tensor, onChange: (v) => (g.leave_output_tensor = v) }),
          toggle({ label: 'Pure (no k-quant mixing)', info: 'gguf.opt.pure', value: g.pure, onChange: (v) => (g.pure = v) }),
        ),
        rulesEditor(ws, rerender),
        h(
          'div',
          { class: 'grid-2' },
          numberField({ label: 'Split files larger than', info: 'gguf.opt.split_max_size', value: g.split_max_size_gb, min: 1, max: 49, suffix: 'GB', onChange: (v) => (g.split_max_size_gb = v) }),
          toggle({ label: 'Low-memory conversion (temp file)', info: 'gguf.opt.use_temp_file', value: g.use_temp_file, onChange: (v) => (g.use_temp_file = v) }),
        ),
      ),
    ),
  );
  return el;
}

function rulesEditor(ws, rerender) {
  const g = ws.gguf;
  const layers = ws.model?.info?.arch?.layers || 32;
  const rows = h('div', { class: 'col gap-2 rules-table' });
  const render = () => {
    clear(rows);
    g.tensor_types.forEach((r, i) => {
      rows.appendChild(
        h(
          'div',
          { class: 'row' },
          h('input', { class: 'input mono', value: r.pattern, placeholder: 'regex, e.g. attn_v or blk\\.0\\.', onChange: (e) => (r.pattern = e.target.value) }),
          h('span', { class: 'muted' }, '→'),
          h('div', { style: { width: '150px' } }, dropdown({ value: r.type, options: ['Q8_0', 'Q6_K', 'Q5_K', 'Q4_K', 'Q3_K', 'IQ4_XS', 'F16'].map((t) => ({ value: t, label: t })), onChange: (v) => (r.type = v) })),
          button('', { size: 'sm', kind: 'ghost', iconName: 'x', onClick: () => (g.tensor_types.splice(i, 1), render()) }),
        ),
      );
    });
  };
  render();
  const preset = (id) => {
    if (id === 'embed_q8') {
      g.token_embedding_type = 'Q8_0';
      g.output_tensor_type = 'Q8_0';
    } else {
      g.tensor_types = PRESETS[id].map((r) => ({ ...r, pattern: r.pattern.replace('LAST', `${layers - 2}|${layers - 1}`) }));
    }
    rerender();
  };
  return h(
    'div',
    { class: 'col gap-2' },
    h('div', { class: 'field-label' }, 'Per-tensor precision rules', infoIcon('gguf.opt.tensor_type')),
    h(
      'div',
      { class: 'row wrap' },
      h('span', { class: 'small muted' }, 'Presets:'),
      [
        ['protect_sensitive', 'Protect attention V + FFN down', 'gguf.preset.protect_sensitive'],
        ['edges_higher', 'First/last layers higher', 'gguf.preset.edges_higher'],
        ['embed_q8', 'Embeddings & head at Q8_0', 'gguf.preset.embed_q8'],
        ['none', 'Clear', 'gguf.preset.none'],
      ].map(([id, label, info]) => {
        const b = button(label, { size: 'sm', onClick: () => preset(id) });
        attachInfo(b, info);
        return b;
      }),
    ),
    rows,
    h('div', null, button('Add rule', { size: 'sm', kind: 'ghost', iconName: 'plus', onClick: () => (g.tensor_types.push({ pattern: '', type: 'Q6_K' }), render()) })),
  );
}

function mlxOptions(ws, rerender) {
  const m = ws.mlx;
  const methods = ws.catalog.mlx.methods || {};
  const modes = ws.catalog.mlx.convert?.q_modes || ['affine', 'mxfp4', 'nvfp4', 'mxfp8'];
  const recipes = ws.catalog.mlx.convert?.quant_predicates || ['mixed_2_6', 'mixed_3_4', 'mixed_3_6', 'mixed_4_6'];
  const el = h('div', { class: 'col gap-4' });
  el.append(
    h(
      'div',
      { class: 'card pad col gap-3' },
      segmented({
        label: 'Method',
        info: `mlx.method.${m.method}`,
        value: m.method,
        options: ['convert', 'awq', 'gptq', 'dwq', 'dynamic_quant'].map((id) => ({
          value: id,
          label: { convert: 'Standard', awq: 'AWQ', gptq: 'GPTQ', dwq: 'DWQ (distilled)', dynamic_quant: 'Dynamic' }[id],
          info: `mlx.method.${id}`,
          disabled: id !== 'convert' && !methods[id]?.available,
        })),
        onChange: (v) => ((m.method = v), rerender()),
      }),
      m.method !== 'convert'
        ? h(
            'div',
            { class: 'grid-3' },
            numberField({ label: 'Calibration samples', info: 'mlx.opt.num_samples', value: m.num_samples || 128, min: 8, max: 4096, onChange: (v) => (m.num_samples = v) }),
            numberField({ label: 'Sequence length', info: 'mlx.opt.sequence_length', value: m.sequence_length || 512, min: 128, max: 8192, step: 128, onChange: (v) => (m.sequence_length = v) }),
            m.method === 'dynamic_quant' ? numberField({ label: 'Target bits per weight', info: 'mlx.opt.target_bpw', value: m.target_bpw || 4.5, min: 2, max: 8, step: 0.1, onChange: (v) => (m.target_bpw = v) }) : null,
          )
        : null,
    ),
  );
  m.variants.forEach((v, i) => {
    const affine = v.mode === 'affine';
    el.append(
      h(
        'div',
        { class: 'card pad col gap-3' },
        h('div', { class: 'row' }, h('b', null, `Variant ${i + 1}`), h('span', { class: 'muted small' }, sizeNote(ws, 'mlx', variantLabelMlx(v)) || ''), h('span', { class: 'spacer' }), m.variants.length > 1 ? button('', { size: 'sm', kind: 'ghost', iconName: 'trash-2', onClick: () => (m.variants.splice(i, 1), rerender()) }) : null),
        segmented({ label: 'Quantization mode', info: `mlx.mode.${v.mode}`, value: v.mode, options: modes.map((x) => ({ value: x, label: x, info: `mlx.mode.${x}` })), onChange: (x) => ((v.mode = x), x !== 'affine' && (v.recipe = null), rerender()) }),
        affine
          ? h(
              'div',
              { class: 'grid-2' },
              segmented({ label: 'Bits', info: `mlx.bits.${v.bits}`, value: v.bits, options: [2, 3, 4, 5, 6, 8].map((b) => ({ value: b, label: String(b), info: `mlx.bits.${b}` })), onChange: (x) => ((v.bits = x), rerender()) }),
              segmented({ label: 'Group size', info: `mlx.group_size.${v.group_size}`, value: v.group_size, options: [32, 64, 128].map((b) => ({ value: b, label: String(b), info: `mlx.group_size.${b}` })), onChange: (x) => ((v.group_size = x), rerender()) }),
            )
          : callout('info', 'info', `${v.mode} uses fixed block scaling, so bits and group size are set by the format.`),
        h(
          'div',
          { class: 'grid-2' },
          affine
            ? dropdown({ label: 'Mixed-precision recipe', info: `mlx.recipe.${v.recipe || 'none'}`, value: v.recipe || '', options: [{ value: '', label: 'None (uniform)', info: 'mlx.recipe.none' }, ...recipes.map((r) => ({ value: r, label: r, info: `mlx.recipe.${r}` }))], onChange: (x) => ((v.recipe = x || null), rerender()) })
            : h('div'),
          dropdown({ label: 'Unquantized parts stored as', info: `mlx.dtype.${v.dtype || 'bfloat16'}`, value: v.dtype || '', options: [{ value: '', label: 'Same as the model' }, ...['float16', 'bfloat16', 'float32'].map((d) => ({ value: d, label: d, info: `mlx.dtype.${d}` }))], onChange: (x) => (v.dtype = x || null) }),
        ),
      ),
    );
  });
  el.append(
    h('div', { class: 'row' }, button('Add another variant', { iconName: 'plus', onClick: () => (m.variants.push({ bits: 4, group_size: 64, mode: 'affine', recipe: null, dtype: null }), rerender()) })),
    mlxRules(ws),
    toggle({ label: 'Trust remote code (only for models that need custom code)', info: 'mlx.opt.trust_remote_code', value: m.trust_remote_code, onChange: (v) => (m.trust_remote_code = v) }),
  );
  return el;
}

export function variantLabelMlx(v) {
  if (v.mode !== 'affine') return v.mode;
  if (v.recipe) return `${v.recipe}-gs${v.group_size}`;
  return `${v.bits}bit-gs${v.group_size}`;
}

function mlxRules(ws) {
  const m = ws.mlx;
  const rows = h('div', { class: 'col gap-2' });
  const render = () => {
    clear(rows);
    m.rules.forEach((r, i) =>
      rows.appendChild(
        h(
          'div',
          { class: 'row' },
          h('input', { class: 'input mono', value: r.pattern, placeholder: 'regex on module path, e.g. lm_head|v_proj', onChange: (e) => (r.pattern = e.target.value) }),
          h('span', { class: 'muted' }, '→'),
          h('div', { style: { width: '170px' } }, dropdown({ value: r.bits, options: [0, 2, 3, 4, 5, 6, 8].map((b) => ({ value: b, label: b === 0 ? 'Keep full precision' : `${b}-bit` })), onChange: (v) => (r.bits = v) })),
          button('', { size: 'sm', kind: 'ghost', iconName: 'x', onClick: () => (m.rules.splice(i, 1), render()) }),
        ),
      ),
    );
  };
  render();
  return h(
    'details',
    { class: 'card pad' },
    h('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, 'Per-layer rules'),
    h('div', { class: 'col gap-2', style: { marginTop: '12px' } }, h('div', { class: 'field-label' }, 'First matching rule wins', infoIcon('mlx.opt.rules')), rows, h('div', null, button('Add rule', { size: 'sm', kind: 'ghost', iconName: 'plus', onClick: () => (m.rules.push({ pattern: 'lm_head', bits: 6 }), render()) }))),
  );
}

export function variantLabelOnnx(v) {
  let s = `${v.precision}-${v.ep}`;
  if (v.precision === 'int4') {
    s += `-b${v.block_size}`;
    if (v.algo !== 'default') s += `-${v.algo}`;
    if (v.head_int8) s += '-head8';
  }
  return s;
}

function onnxOptions(ws, rerender) {
  const o = ws.onnx;
  const eps = ws.catalog.onnx.execution_providers || ['cpu'];
  const precs = (ws.catalog.onnx.builder?.precisions || ['int4', 'int8', 'fp16', 'bf16', 'fp32']).filter((p) => ['int4', 'int8', 'fp16', 'bf16', 'fp32'].includes(p));
  const el = h('div', { class: 'col gap-4' });
  el.append(
    h(
      'div',
      { class: 'card pad' },
      segmented({
        label: 'Engine',
        info: `onnx.engine.${o.engine}`,
        value: o.engine,
        options: [
          { value: 'builder', label: 'ORT GenAI model builder (recommended)', info: 'onnx.engine.builder' },
          { value: 'optimum', label: 'Optimum + ORT quantizer', info: 'onnx.engine.optimum' },
        ],
        onChange: (v) => ((o.engine = v), rerender()),
      }),
    ),
  );
  o.variants.forEach((v, i) => {
    const q = v.precision === 'int4' || v.precision === 'int8';
    el.append(
      h(
        'div',
        { class: 'card pad col gap-3' },
        h('div', { class: 'row' }, h('b', null, `Variant ${i + 1}`), h('span', { class: 'muted small' }, sizeNote(ws, 'onnx', variantLabelOnnx(v)) || ''), h('span', { class: 'spacer' }), o.variants.length > 1 ? button('', { size: 'sm', kind: 'ghost', iconName: 'trash-2', onClick: () => (o.variants.splice(i, 1), rerender()) }) : null),
        h(
          'div',
          { class: 'grid-2' },
          segmented({ label: 'Precision', info: `onnx.precision.${v.precision}`, value: v.precision, options: precs.map((p) => ({ value: p, label: p.toUpperCase(), info: `onnx.precision.${p}` })), onChange: (x) => ((v.precision = x), rerender()) }),
          segmented({ label: 'Runs on', info: `onnx.ep.${v.ep}`, value: v.ep, options: eps.map((e) => ({ value: e, label: { cpu: 'CPU', cuda: 'CUDA', webgpu: 'WebGPU', dml: 'DirectML' }[e] || e, info: `onnx.ep.${e}` })), onChange: (x) => ((v.ep = x), rerender()) }),
        ),
        q
          ? h(
              'div',
              { class: 'grid-2' },
              segmented({ label: 'Block size', info: 'onnx.opt.block_size', value: v.block_size, options: [32, 64, 128].map((b) => ({ value: b, label: String(b) })), onChange: (x) => ((v.block_size = x), rerender()) }),
              segmented({
                label: 'Algorithm',
                info: 'onnx.opt.algo_config',
                value: v.algo,
                options: [
                  { value: 'default', label: 'Default (RTN)', info: 'onnx.algo.default' },
                  { value: 'rtn', label: 'RTN', info: 'onnx.algo.rtn' },
                  { value: 'k_quant', label: 'K-quant', info: 'onnx.algo.k_quant' },
                ],
                onChange: (x) => ((v.algo = x), rerender()),
              }),
            )
          : null,
        q
          ? h(
              'div',
              { class: 'grid-3' },
              dropdown({ label: 'Compute accuracy level', info: 'onnx.opt.accuracy_level', value: v.accuracy_level, options: [0, 1, 2, 3, 4].map((a) => ({ value: a, label: { 0: '0 · unset', 1: '1 · fp32', 2: '2 · fp16', 3: '3 · bf16', 4: '4 · int8 (fastest on CPU)' }[a] })), onChange: (x) => (v.accuracy_level = x) }),
              toggle({ label: 'Symmetric', info: 'onnx.opt.is_symmetric', value: v.is_symmetric, onChange: (x) => ((v.is_symmetric = x), rerender()) }),
              v.precision === 'int4' ? toggle({ label: 'Keep the output head at INT8', info: 'onnx.opt.matmul_mixed_precision', value: v.head_int8, onChange: (x) => ((v.head_int8 = x), rerender()) }) : h('div'),
            )
          : null,
        v.algo === 'k_quant' && v.ep === 'cpu' ? h('div', { class: 'small muted' }, 'K-quant gives better quality than RTN but is slow on CPU (minutes even for small models).') : null,
      ),
    );
  });
  el.append(h('div', { class: 'row' }, button('Add another variant', { iconName: 'plus', onClick: () => (o.variants.push({ precision: 'int8', ep: o.variants[0]?.ep || 'cpu', block_size: 32, accuracy_level: 4, algo: 'default', is_symmetric: true, head_int8: false }), rerender()) })));
  return el;
}

export function stepOptions(ws, rerender) {
  const el = h('div');
  const formats = [...ws.formats];
  if (!formats.includes(ws.optionsTab)) ws.optionsTab = formats[0];
  el.append(stepHead('Fine-tune the recipe', 'Defaults are sensible; every option explains itself when you hover it. Sizes update for your model as you choose.'));
  if (!formats.length) {
    el.append(callout('info', 'info', 'Pick at least one format in the previous step.'));
    return el;
  }
  el.append(h('div', { class: 'tabs' }, formats.map((f) => h('button', { class: f === ws.optionsTab ? 'on' : '', onClick: () => ((ws.optionsTab = f), rerender()) }, f.toUpperCase()))));
  const body = { gguf: ggufOptions, mlx: mlxOptions, onnx: onnxOptions }[ws.optionsTab](ws, rerender);
  el.append(body);
  return el;
}

/* ---------------- Calibration & evaluation ---------------- */

const CALIB = [
  ['wikitext2-train', 'WikiText-2', 'Clean encyclopedic English. A common, safe default.', 'calib.wikitext2'],
  ['pile-val', 'The Pile (sample)', 'Mixed web, books, code and papers: broader coverage.', 'calib.pile_val'],
  ['c4-en', 'C4 English', 'Large cleaned web crawl text.', 'calib.c4'],
  ['file', 'My own text', 'A .txt or .jsonl file that looks like your real use.', 'calib.custom_file'],
  ['hf', 'A Hugging Face dataset', 'Any dataset with a text column.', 'calib.hf_dataset'],
];

export function stepCalibration(ws, rerender) {
  const el = h('div');
  const c = ws.calibration;
  const needCalib = (ws.formats.has('gguf') && (ws.gguf.imatrix.enabled || ws.gguf.types.some((t) => ws.catalog.gguf.types.find((x) => x.name === t)?.requires_imatrix))) || (ws.formats.has('mlx') && ws.mlx.method !== 'convert');
  el.append(stepHead('Calibration & evaluation', 'Calibration text guides smart quantization methods. Evaluation measures how close each output stays to the original on the same text.'));
  const cards = h('div', { class: 'grid-3' });
  for (const [id, title, desc, info] of CALIB) cards.appendChild(optionCard({ title, desc, info, compact: true, selected: c.source === id, onClick: () => ((c.source = id), rerender()) }));
  const extra = [];
  if (c.source === 'file')
    extra.push(
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow mono small card pad', style: { padding: '6px 10px' } }, c.path || 'No file chosen'),
        button('Choose file…', {
          onClick: async () => {
            const p = await call('pick_file', { title: 'Calibration text', extensions: ['txt', 'jsonl', 'json', 'md'] }).catch(showError);
            if (p) {
              c.path = p;
              rerender();
            }
          },
        }),
      ),
    );
  if (c.source === 'hf')
    extra.push(
      h(
        'div',
        { class: 'grid-3' },
        textField({ label: 'Dataset id', info: 'calib.hf_dataset', value: c.dataset || '', placeholder: 'owner/dataset', onChange: (v) => (c.dataset = v) }),
        textField({ label: 'Split', info: 'calib.hf_dataset', value: c.split || 'train', onChange: (v) => (c.split = v) }),
        textField({ label: 'Text column', info: 'calib.hf_dataset', value: c.column || 'text', onChange: (v) => (c.column = v) }),
      ),
    );
  el.append(
    needCalib
      ? h('div', { class: 'card pad col gap-3' }, h('div', { class: 'row' }, h('b', null, 'Calibration text'), infoIcon('concept.calibration')), cards, ...extra)
      : callout('info', 'info', 'No calibration needed for the options you picked. Turn on the importance matrix (GGUF) or a calibration method (MLX) to use it.'),
    h(
      'div',
      { class: 'card pad col gap-3', style: { marginTop: '16px' } },
      h('div', { class: 'row' }, h('b', null, 'Automatic evaluation'), infoIcon('eval.reference')),
      checkbox({ label: 'Measure quality: perplexity + KL divergence vs the original', info: 'eval.kld', checked: ws.eval.ppl && ws.eval.kld, onChange: (v) => ((ws.eval.ppl = v), (ws.eval.kld = v), rerender()) }),
      ws.eval.kld
        ? h(
            'div',
            { class: 'grid-2' },
            slider({ label: 'Evaluation size', info: 'eval.chunks', min: 10, max: 200, step: 10, value: ws.eval.chunks, format: (v) => `${v} chunks (${num(v * ws.eval.ctx, 0)} tokens)`, onChange: (v) => (ws.eval.chunks = v) }),
            segmented({ label: 'Tokens per chunk', info: 'eval.ctx', value: ws.eval.ctx, options: [512, 1024, 2048].map((x) => ({ value: x, label: String(x) })), onChange: (v) => (ws.eval.ctx = v) }),
          )
        : null,
      h('div', { class: 'small muted' }, 'Uses the WikiText-2 test split, the standard benchmark text, so numbers are comparable across formats.'),
    ),
  );
  return el;
}
