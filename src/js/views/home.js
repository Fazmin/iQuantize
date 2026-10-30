// Home: guided checklist for first runs, workspace stats, recent jobs and outputs.

import { badge, button } from '../components/controls.js';
import { statusBadge } from '../components/jobs.js';
import { h, icon } from '../lib/dom.js';
import { ago, bytes } from '../lib/format.js';
import { call } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';
import { app } from '../lib/store.js';

export default async function homeView(root) {
  setCrumbs([]);
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  const [tc, models, arts, jobs, docs, uploads, stats] = await Promise.all([
    call('toolchain_status').catch(() => ({ components: [] })),
    call('models_list').catch(() => []),
    call('artifacts_list', {}).catch(() => []),
    call('jobs_list', { limit: 8 }).catch(() => []),
    call('docs_list').catch(() => []),
    call('uploads_list').catch(() => []),
    call('system_stats').catch(() => null),
  ]);
  const required = tc.components.filter((c) => c.required && c.supported);
  const toolsOk = required.length > 0 && required.every((c) => c.status === 'installed');
  const quantized = arts.filter((a) => a.role !== 'reference');
  const tested = arts.some((a) => a.metrics?.kld_mean != null || a.metrics?.suite_exact != null);
  const steps = [
    [toolsOk, 'Install the tools', 'One click installs Python, llama.cpp and the per-format environments privately.', '/environment', 'Open Environment'],
    [models.length > 0, 'Add a model', 'Download an original model from Hugging Face or import a folder.', '/models?add=hf', 'Add a model'],
    [quantized.length > 0, 'Quantize it', 'Pick a goal and a format; watch every tensor shrink live.', '/quantize', 'Start the wizard'],
    [tested, 'Compare with the original', 'Chat side by side and measure perplexity, KL divergence and speed.', '/test', 'Test & Compare'],
    [docs.length > 0 && uploads.length > 0, 'Document and publish', 'Generate a model card (AI optional) and upload to Hugging Face.', '/docs', 'Open Docs'],
  ];
  const nextIdx = steps.findIndex((s) => !s[0]);
  const name = app.get().info?.platform?.cpu_brand;

  view.append(
    h(
      'div',
      { class: 'hero' },
      h('div', { class: 'grow' }, h('h1', null, 'Quantization workspace'), h('p', null, `Make LLMs smaller and faster as GGUF, MLX or ONNX, see exactly what changes, and ship them with a proper model card.${name ? ` Running on ${name}.` : ''}`)),
      button('New quantization', { kind: 'primary', size: 'lg', iconName: 'wand-sparkles', onClick: () => go('/quantize') }),
    ),
    h(
      'div',
      { class: 'grid-4' },
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('box', 'sm'), 'Models'), h('div', { class: 'value' }, String(models.length))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('layers', 'sm'), 'Quantized outputs'), h('div', { class: 'value' }, String(quantized.length)), h('div', { class: 'delta' }, bytes(quantized.reduce((a, x) => a + (x.size_bytes || 0), 0)))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('cloud-upload', 'sm'), 'Published'), h('div', { class: 'value' }, String(uploads.length))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('hard-drive', 'sm'), 'Free disk'), h('div', { class: 'value' }, stats?.disk_free ? bytes(stats.disk_free) : '—')),
    ),
    h('div', { class: 'section-title' }, icon('list-checks', 'sm'), 'Getting started'),
    h(
      'div',
      { class: 'card checklist' },
      steps.map(([done, title, text, path, cta], i) =>
        h(
          'div',
          { class: `check-item ${done ? 'done' : ''}` },
          h('span', { class: 'n' }, done ? icon('check', 'xs') : String(i + 1)),
          h('div', { class: 'grow' }, h('div', { class: 't' }, title), h('div', { class: 'small muted' }, text)),
          i === nextIdx ? button(cta, { kind: 'primary', size: 'sm', onClick: () => go(path) }) : done ? badge('Done', 'success') : null,
        ),
      ),
    ),
    jobs.length ? h('div', { class: 'section-title' }, icon('activity', 'sm'), 'Recent activity') : null,
    jobs.length
      ? h(
          'div',
          { class: 'card list' },
          jobs.map((j) => h('div', { class: 'list-row', onClick: () => go(`/jobs/${j.id}`) }, h('div', { style: { width: '110px' } }, statusBadge(j.status)), h('div', { class: 'grow title ellipsis' }, j.title), badge(j.kind, 'outline'), h('span', { class: 'meta' }, ago(j.created_at)))),
        )
      : null,
  );
}
