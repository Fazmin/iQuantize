// Model cards: list existing documents, or create one for a set of quantized outputs.

import { badge, button, checkbox, empty } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { confirm, showError } from '../components/overlay.js';
import { clear, h } from '../lib/dom.js';
import { ago, bytes } from '../lib/format.js';
import { call } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

export default async function docsView(root, { query }) {
  setCrumbs([]);
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  const [docs, arts, models] = await Promise.all([call('docs_list').catch(() => []), call('artifacts_list', {}).catch(() => []), call('models_list').catch(() => [])]);

  // Pre-select outputs from a finished job (?job=) or a model (?model=).
  let preset = [];
  if (query.job) preset = arts.filter((a) => a.job_id === query.job && a.role !== 'reference').map((a) => a.id);
  const quantized = arts.filter((a) => a.role !== 'reference' && a.exists);
  let modelId = query.model || (preset.length ? quantized.find((a) => a.id === preset[0])?.model_id : quantized[0]?.model_id);
  const selected = new Set(preset.length ? preset : quantized.filter((a) => a.model_id === modelId).map((a) => a.id));

  const picker = h('div', { class: 'col gap-2' });
  const renderPicker = () => {
    clear(picker);
    const byModel = models.filter((m) => quantized.some((a) => a.model_id === m.id));
    for (const m of byModel) {
      picker.appendChild(h('div', { class: 'small muted', style: { marginTop: '6px' } }, m.name));
      for (const a of quantized.filter((x) => x.model_id === m.id)) {
        picker.appendChild(
          checkbox({
            label: `${a.format.toUpperCase()} ${a.variant}`,
            sub: `${bytes(a.size_bytes)}${a.metrics.kld_mean != null ? ` · KLD ${a.metrics.kld_mean.toFixed(4)}` : ''}`,
            checked: selected.has(a.id),
            disabled: modelId && a.model_id !== modelId && selected.size > 0,
            onChange: (v) => {
              if (v) {
                selected.add(a.id);
                modelId = a.model_id;
              } else selected.delete(a.id);
              if (!selected.size) modelId = null;
              renderPicker();
            },
          }),
        );
      }
    }
  };

  const create = async () => {
    if (!selected.size) return;
    try {
      const id = await call('doc_create', { modelId, artifactIds: [...selected] });
      go(`/docs/${id}`);
    } catch (e) {
      showError(e, 'Could not create the model card');
    }
  };

  view.append(
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Docs'), h('div', { class: 'sub' }, 'Model cards (README.md) for Hugging Face, generated from exactly how each file was made and measured. Edit them yourself or let an OpenAI model help.'))),
  );
  if (quantized.length) {
    renderPicker();
    view.append(
      h(
        'div',
        { class: 'card pad col gap-3' },
        h('div', { class: 'row' }, h('b', null, 'New model card'), infoIcon('hub.model_card'), h('span', { class: 'small muted' }, 'Pick the outputs it should describe (one model; usually one format per repository).')),
        picker,
        h('div', null, button('Create model card', { kind: 'primary', iconName: 'file-text', onClick: create })),
      ),
    );
  }
  view.append(h('div', { class: 'section-title' }, 'Documents'));
  if (!docs.length) {
    view.appendChild(h('div', { class: 'card' }, empty({ iconName: 'file-text', title: 'No model cards yet', text: quantized.length ? 'Create one above.' : 'Quantize a model first, then document it here.' })));
  } else {
    view.appendChild(
      h(
        'div',
        { class: 'card list' },
        docs.map((d) =>
          h(
            'div',
            { class: 'list-row', onClick: () => go(`/docs/${d.id}`) },
            h('div', { class: 'grow' }, h('div', { class: 'title' }, d.title), h('div', { class: 'meta' }, `Edited ${ago(d.updated_at)} · ${d.chars.toLocaleString()} characters`)),
            d.repo_id ? badge(`Published: ${d.repo_id}`, 'success') : badge('Draft', 'outline'),
            button('', {
              size: 'sm',
              kind: 'ghost',
              iconName: 'trash-2',
              onClick: async (e) => {
                e.stopPropagation();
                if (await confirm({ title: 'Delete this model card?', text: 'Its version history is deleted too.', confirmLabel: 'Delete', danger: true })) {
                  await call('doc_delete', { id: d.id });
                  go('/docs');
                }
              },
            }),
          ),
        ),
      ),
    );
  }
  if (preset.length && query.auto === '1') create();
}
