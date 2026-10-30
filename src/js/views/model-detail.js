// One model: architecture facts, memory needs, compatibility, tensor X-ray and its quantized versions.

import { badge, button, callout } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { confirm, showError, toast } from '../components/overlay.js';
import { tensorMap } from '../components/tensor-map.js';
import { clear, h, icon } from '../lib/dom.js';
import { ago, bytes, num, params as fmtParams } from '../lib/format.js';
import { call } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';
import { compatDots } from './models.js';

function kvCache(a, ctx, bytesPer = 2) {
  if (!a.layers || !a.kv_heads || !a.head_dim) return null;
  return 2 * a.layers * a.kv_heads * a.head_dim * ctx * bytesPer;
}

export default async function modelDetail(root, { params }) {
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  let m;
  try {
    m = await call('model_get', { id: params.id });
  } catch (e) {
    view.appendChild(callout('danger', 'circle-x', e.message));
    return;
  }
  setCrumbs([m.name]);
  const a = m.info?.arch || {};
  const summary = m.info?.summary || {};
  let mapApi = null;

  const tabsHost = h('div');
  const body = h('div');
  const tabs = ['Overview', 'Tensor map', 'Quantized versions'];
  let tab = 'Overview';

  const renderTab = async () => {
    mapApi?.dispose();
    mapApi = null;
    clear(tabsHost).appendChild(h('div', { class: 'tabs' }, tabs.map((t) => h('button', { class: t === tab ? 'on' : '', onClick: () => ((tab = t), renderTab()) }, t))));
    clear(body);
    if (tab === 'Overview') overview();
    if (tab === 'Tensor map') await tensorsTab();
    if (tab === 'Quantized versions') await artifactsTab();
  };

  function overview() {
    const gqa = a.heads && a.kv_heads && a.kv_heads < a.heads ? ` (GQA ${a.heads / a.kv_heads}:1)` : '';
    const archCard = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('layers', 'sm'), 'Architecture'),
      h(
        'div',
        { class: 'card-body' },
        h(
          'dl',
          { class: 'kv' },
          h('dt', null, 'Architecture'),
          h('dd', null, a.architecture || '—'),
          h('dt', null, 'Parameters'),
          h('dd', null, m.params ? `${fmtParams(m.params)} (${num(m.params, 0)})` : '—', ' ', infoIcon('concept.params')),
          h('dt', null, 'Layers'),
          h('dd', null, a.layers ?? '—'),
          h('dt', null, 'Hidden size'),
          h('dd', null, a.hidden_size ?? '—'),
          h('dt', null, 'Attention heads'),
          h('dd', null, a.heads ? `${a.heads} query · ${a.kv_heads} key/value${gqa}` : '—', ' ', infoIcon('concept.attention')),
          h('dt', null, 'Context length'),
          h('dd', null, a.context_length ? `${num(a.context_length, 0)} tokens` : '—', ' ', infoIcon('concept.context_length')),
          h('dt', null, 'Vocabulary'),
          h('dd', null, a.vocab_size ? num(a.vocab_size, 0) : '—', a.tied_embeddings ? ' · tied embeddings' : '', ' ', infoIcon('concept.tied_embeddings')),
          a.experts ? h('dt', null, 'Experts') : null,
          a.experts ? h('dd', null, `${a.experts} experts, ${a.experts_per_token} active per token `, infoIcon('concept.moe')) : null,
          h('dt', null, 'Stored as'),
          h('dd', null, `${m.dtype || a.torch_dtype || '—'} · ${bytes(summary.bytes || m.size_bytes)} · ${summary.tensors ?? '—'} tensors`, ' ', infoIcon('concept.dtype')),
        ),
      ),
    );
    const ctxs = [4096, 8192, 32768, Math.min(a.context_length || 0, 131072)].filter((c, i, arr) => c && arr.indexOf(c) === i && c <= (a.context_length || 0));
    const memCard = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('memory-stick', 'sm'), 'Memory needed to run', infoIcon('concept.kv_cache')),
      h(
        'div',
        { class: 'card-body col gap-2' },
        h('div', { class: 'small muted' }, 'Weights plus the KV cache, which grows with context length (fp16 cache).'),
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Context'), h('th', { class: 'num' }, 'KV cache'), h('th', { class: 'num' }, 'Original'), h('th', { class: 'num' }, '~4.8 bpw'))),
          h(
            'tbody',
            null,
            ctxs.map((c) => {
              const kv = kvCache(a, c) || 0;
              const w16 = summary.bytes || m.size_bytes || 0;
              const w4 = ((m.params || 0) * 4.85) / 8;
              return h('tr', null, h('td', null, `${num(c, 0)} tokens`), h('td', { class: 'num' }, bytes(kv)), h('td', { class: 'num' }, bytes(w16 + kv)), h('td', { class: 'num' }, bytes(w4 + kv)));
            }),
          ),
        ),
      ),
    );
    const compatCard = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, icon('puzzle', 'sm'), 'Format support', infoIcon('format.compare')),
      h(
        'div',
        { class: 'card-body col gap-3' },
        ['gguf', 'mlx', 'onnx'].map((f) => {
          const c = m.compat?.[f] || { status: 'unknown', reason: '' };
          const ic = { yes: 'circle-check', warn: 'triangle-alert', no: 'circle-x', unknown: 'circle-help' }[c.status];
          const cls = { yes: 'success-text', warn: 'warning-text', no: 'danger-text', unknown: 'muted' }[c.status];
          return h('div', { class: 'row top' }, icon(ic, `sm ${cls}`), h('div', { class: 'grow' }, h('b', null, f.toUpperCase()), ' ', infoIcon(`format.${f}`), h('div', { class: 'small muted' }, c.reason)));
        }),
      ),
    );
    const notes = [];
    if (a.quantization) notes.push(callout('warning', 'triangle-alert', `This checkpoint is already quantized (${a.quantization}). Quantizing again compounds the error; prefer the original.`));
    if (a.multimodal) notes.push(callout('info', 'info', 'This is a multimodal model. iQuantize quantizes its language model; vision/audio parts may need extra files (e.g. an mmproj for llama.cpp).'));
    if (!m.exists) notes.push(callout('danger', 'circle-x', `The model folder is missing: ${m.local_path}`));
    body.append(...notes, h('div', { class: 'grid-2', style: { marginTop: notes.length ? '12px' : '0' } }, archCard, h('div', { class: 'col gap-3' }, compatCard, memCard)));
  }

  async function tensorsTab() {
    body.appendChild(h('div', { class: 'row muted' }, h('div', { class: 'spinner' }), 'Reading tensor headers…'));
    try {
      const tensors = await call('model_tensors', { id: m.id });
      clear(body);
      mapApi = tensorMap(tensors, { height: 260 });
      const dt = summary.by_dtype || [];
      body.append(
        h(
          'div',
          { class: 'card pad col gap-3' },
          h('div', { class: 'row' }, h('b', null, 'Tensor map'), infoIcon('concept.attention'), h('span', { class: 'muted small' }, `${tensors.length} tensors. Each column is a transformer block; hover a cell for details. During quantization these cells fill with their new precision.`)),
          mapApi.el,
        ),
        h(
          'div',
          { class: 'card', style: { marginTop: '12px' } },
          h(
            'table',
            { class: 'table' },
            h('thead', null, h('tr', null, h('th', null, 'Stored type'), h('th', { class: 'num' }, 'Parameters'), h('th', { class: 'num' }, 'Bytes'), h('th', { class: 'num' }, 'Bits/weight'))),
            h('tbody', null, dt.map((d) => h('tr', null, h('td', null, d.dtype), h('td', { class: 'num' }, num(d.params, 0)), h('td', { class: 'num' }, bytes(d.bytes)), h('td', { class: 'num' }, d.bits.toFixed(2))))),
          ),
        ),
      );
    } catch (e) {
      clear(body).appendChild(callout('danger', 'circle-x', e.message));
    }
  }

  async function artifactsTab() {
    let arts = [];
    try {
      arts = await call('artifacts_list', { modelId: m.id });
    } catch {
      arts = [];
    }
    if (!arts.length) {
      body.appendChild(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('wand-sparkles', 'lg')), h('h3', null, 'Not quantized yet'), h('p', null, 'Walk through the quantization wizard to make GGUF, MLX or ONNX versions of this model.'), button('Quantize this model', { kind: 'primary', iconName: 'wand-sparkles', onClick: () => go(`/quantize?model=${m.id}`) })),
        ),
      );
      return;
    }
    body.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Format'), h('th', null, 'Variant'), h('th', { class: 'num' }, 'Size'), h('th', { class: 'num' }, 'Bits/weight'), h('th', null, 'Role'), h('th', null, 'Created'), h('th', null, ''))),
          h(
            'tbody',
            null,
            arts.map((x) =>
              h(
                'tr',
                null,
                h('td', null, badge(x.format.toUpperCase(), 'outline')),
                h('td', { class: 'mono' }, x.variant),
                h('td', { class: 'num' }, bytes(x.size_bytes)),
                h('td', { class: 'num' }, x.bpw ? x.bpw.toFixed(2) : '—'),
                h('td', null, x.role === 'reference' ? badge('Reference', 'info') : badge('Quantized', 'accent')),
                h('td', null, ago(x.created_at)),
                h('td', null, h('div', { class: 'row' }, button('', { size: 'sm', kind: 'ghost', iconName: 'folder-open', title: 'Reveal', onClick: () => call('reveal_path', { path: x.path }).catch(showError) }), button('Test', { size: 'sm', onClick: () => go(`/test?a=${x.id}`) }))),
              ),
            ),
          ),
        ),
      ),
    );
  }

  view.append(
    h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        null,
        h('div', { class: 'row' }, h('h1', null, m.name), compatDots(m.compat)),
        h('div', { class: 'sub row wrap' }, m.repo_id ? h('a', { onClick: () => call('open_external', { url: `https://huggingface.co/${m.repo_id}` }) }, `${m.repo_id} ↗`) : h('span', { class: 'mono small' }, m.local_path), m.license ? badge(m.license, 'outline') : null, m.revision ? h('span', { class: 'mono xs muted' }, `@${m.revision.slice(0, 10)}`) : null),
      ),
      h(
        'div',
        { class: 'actions' },
        button('', { kind: 'ghost', iconName: 'folder-open', title: 'Reveal in file manager', onClick: () => call('reveal_path', { path: m.local_path }).catch(showError) }),
        button('', {
          kind: 'ghost',
          iconName: 'trash-2',
          title: 'Remove model',
          onClick: async () => {
            const ok = await confirm({ title: `Remove ${m.name}?`, text: m.source === 'hf' ? 'Removes it from the library and deletes the downloaded files. Quantized versions are kept on disk.' : 'Removes it from the library. Your folder is not touched.', confirmLabel: 'Remove', danger: true });
            if (!ok) return;
            await call('model_delete', { id: m.id, deleteFiles: true }).catch(showError);
            toast('Model removed', { kind: 'success' });
            go('/models');
          },
        }),
        button('Test', { iconName: 'flask-conical', onClick: () => go(`/test?model=${m.id}`) }),
        button('Quantize', { kind: 'primary', iconName: 'wand-sparkles', onClick: () => go(`/quantize?model=${m.id}`) }),
      ),
    ),
    tabsHost,
    body,
  );
  await renderTab();
  return () => mapApi?.dispose();
}
