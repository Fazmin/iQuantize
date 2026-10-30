// One-click toolchain: components, accelerator variants, live installs and a system doctor.

import { badge, button, callout, dropdown } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { jobCard } from '../components/jobs.js';
import { confirm, showError, toast } from '../components/overlay.js';
import { clear, h, icon } from '../lib/dom.js';
import { bytes, datetime } from '../lib/format.js';
import { call, disposer, on } from '../lib/ipc.js';
import { setCrumbs } from '../lib/router.js';

const ICONS = { uv: 'package', python: 'terminal', llama_cpp: 'cpu', env_core: 'cloud-upload', env_gguf: 'file-code', env_mlx: 'microchip', env_onnx: 'puzzle' };
const STATUS = {
  installed: ['success', 'Installed'],
  installing: ['accent', 'Installing…'],
  not_installed: ['', 'Not installed'],
  broken: ['danger', 'Needs repair'],
  unsupported: ['outline', 'Not available here'],
};

export default async function environmentView(root, { query }) {
  setCrumbs([]);
  const d = disposer();
  const view = h('div', { class: 'view' });
  root.appendChild(view);

  const jobsHost = h('div', { class: 'col gap-3' });
  const list = h('div', { class: 'card' });
  const doctorHost = h('div', { class: 'doctor-grid' }, h('div', { class: 'spinner' }));
  const capsHost = h('div');
  const cards = new Map();
  const variantChoice = {};

  const installAllBtn = button('Install everything', { kind: 'primary', iconName: 'download' });
  view.append(
    h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        null,
        h('h1', null, 'Environment'),
        h('div', { class: 'sub' }, 'Everything iQuantize needs to quantize, test and publish models, installed privately inside the app with one click. Nothing touches your system Python.'),
      ),
      h('div', { class: 'actions' }, button('Re-probe tools', { kind: 'ghost', iconName: 'refresh-cw', onClick: () => call('toolchain_reprobe').then(watchNew).catch(showError) }), installAllBtn),
    ),
    jobsHost,
    h('div', { class: 'section-title' }, icon('package', 'sm'), 'Components', infoIcon('tc.probe')),
    list,
    h('div', { class: 'section-title' }, icon('shield-check', 'sm'), 'System check', infoIcon('tc.doctor')),
    doctorHost,
    h('div', { class: 'section-title' }, icon('list-checks', 'sm'), 'What your installed tools support'),
    capsHost,
  );

  const watching = new Set();
  function watchNew(jobId) {
    if (!jobId || watching.has(jobId)) return;
    watching.add(jobId);
    call('job_get', { id: jobId })
      .then((job) => {
        const card = jobCard(job, {
          logHeight: 260,
          onDone: (j) => {
            setTimeout(() => {
              if (j.status === 'done') {
                card.dispose();
                card.remove();
                watching.delete(jobId);
              }
              refresh();
              loadCaps();
            }, 1500);
          },
        });
        d(card.dispose);
        jobsHost.prepend(card);
      })
      .catch(showError);
  }

  async function install(ids, force = false) {
    try {
      const jobId = await call('toolchain_install', { components: ids, variant: variantChoice.llama_cpp || null, force });
      watchNew(jobId);
      refresh();
    } catch (e) {
      showError(e, 'Could not start install');
    }
  }

  installAllBtn.addEventListener('click', async () => {
    try {
      const jobId = await call('toolchain_install_all');
      watchNew(jobId);
      refresh();
    } catch (e) {
      if (e.message?.includes('already installed')) toast('Everything is already installed', { kind: 'success' });
      else showError(e, 'Could not start install');
    }
  });

  function row(c) {
    const [kind, label] = STATUS[c.status] || ['', c.status];
    const actions = h('div', { class: 'row' });
    if (c.id === 'llama_cpp' && c.variants.length > 1 && c.status !== 'unsupported') {
      const cur = variantChoice.llama_cpp || c.variant || c.recommended_variant;
      variantChoice.llama_cpp = cur;
      actions.appendChild(
        h(
          'div',
          { style: { width: '210px' } },
          dropdown({
            value: cur,
            options: c.variants.map((v) => ({
              value: v.id,
              label: v.label,
              sub: v.id === c.recommended_variant ? 'Recommended for this machine' : '',
              info: `hw.accel.${v.accel}`,
            })),
            onChange: (v) => (variantChoice.llama_cpp = v),
          }),
        ),
      );
    }
    if (c.status === 'not_installed') actions.appendChild(button('Install', { size: 'sm', kind: 'primary', onClick: () => install([c.id]) }));
    if (c.status === 'broken') actions.appendChild(button('Repair', { size: 'sm', kind: 'primary', iconName: 'wrench', onClick: () => install([c.id], true) }));
    if (c.status === 'installed') {
      actions.appendChild(button('Reinstall', { size: 'sm', kind: 'ghost', onClick: () => install([c.id], true) }));
      actions.appendChild(
        button('', {
          size: 'sm',
          kind: 'ghost',
          iconName: 'trash-2',
          title: 'Remove',
          onClick: async () => {
            if (!(await confirm({ title: `Remove ${c.label}?`, text: 'You can reinstall it any time with one click.', confirmLabel: 'Remove', danger: true }))) return;
            call('toolchain_remove', { id: c.id }).then(refresh).catch(showError);
          },
        }),
      );
    }
    if (c.status === 'installing') actions.appendChild(h('div', { class: 'spinner' }));
    const meta = [];
    if (c.version) meta.push(c.version);
    if (c.variant) meta.push(c.variants.find((v) => v.id === c.variant)?.label || c.variant);
    if (c.size_bytes) meta.push(bytes(c.size_bytes));
    if (c.installed_at) meta.push(`installed ${datetime(c.installed_at)}`);
    return h(
      'div',
      { class: 'env-row' },
      h('div', { class: 'ic' }, icon(ICONS[c.id] || 'package')),
      h(
        'div',
        { class: 'col gap-1', style: { minWidth: '0' } },
        h('div', { class: 'name' }, c.label, infoIcon(c.kb), badge(label, kind), c.required ? null : badge('Optional', 'outline')),
        h('div', { class: 'meta' }, c.unsupported_reason || c.description),
        meta.length ? h('div', { class: 'meta mono xs' }, meta.join(' · ')) : null,
      ),
      actions,
    );
  }

  async function refresh() {
    let st;
    try {
      st = await call('toolchain_status');
    } catch (e) {
      showError(e);
      return;
    }
    clear(list);
    for (const c of st.components) {
      const r = row(c);
      cards.set(c.id, r);
      list.appendChild(r);
      if (c.job_id) watchNew(c.job_id);
    }
    const missing = st.components.filter((c) => c.supported && c.status !== 'installed');
    installAllBtn.disabled = missing.length === 0;
    installAllBtn.lastChild.textContent = missing.length ? `Install everything (${missing.length})` : 'All installed';
  }

  async function loadDoctor() {
    try {
      const doc = await call('toolchain_doctor');
      clear(doctorHost);
      for (const c of doc.checks) {
        doctorHost.appendChild(
          h(
            'div',
            { class: 'doctor-item' },
            icon(c.ok ? 'circle-check' : 'triangle-alert', c.ok ? 'sm success-text' : 'sm warning-text'),
            h('div', { class: 'col gap-1 grow', style: { minWidth: '0' } }, h('div', { class: 'k row' }, c.label, c.kb ? infoIcon(c.kb) : null), h('div', { class: 'v selectable' }, c.value), !c.ok && c.hint ? h('div', { class: 'small muted' }, c.hint) : null),
          ),
        );
      }
    } catch (e) {
      clear(doctorHost).appendChild(callout('danger', 'circle-x', e.message));
    }
  }

  async function loadCaps() {
    let caps = {};
    try {
      caps = await call('toolchain_capabilities');
    } catch {
      /* not fatal */
    }
    const items = [];
    const qt = caps.llama_cpp?.quant_types;
    if (qt) items.push(['GGUF quantization types', `${qt.filter((t) => !t.alias_of).length} types`, qt.map((t) => t.name).join(', ')]);
    const archs = caps.env_gguf?.caps?.convert_archs;
    if (archs) items.push(['GGUF convertible architectures', `${archs.length}`, archs.slice(0, 40).join(', ') + (archs.length > 40 ? '…' : '')]);
    const mlx = caps.env_mlx?.caps;
    if (mlx) items.push(['MLX quantization modes', (mlx.convert?.q_modes || []).join(', '), `${(mlx.model_types || []).length} model families · methods: ${Object.entries(mlx.methods || {}).filter(([, v]) => v.available).map(([k]) => k).join(', ') || 'convert only'}`]);
    const onnx = caps.env_onnx?.caps;
    if (onnx) items.push(['ONNX precisions', (onnx.builder?.precisions || []).join(', '), `Execution providers: ${(onnx.builder?.execution_providers || []).join(', ')} · ${(onnx.architectures || []).length} architectures`]);
    clear(capsHost).appendChild(
      items.length
        ? h(
            'div',
            { class: 'card' },
            h(
              'table',
              { class: 'table' },
              h('tbody', null, items.map(([k, v, more]) => h('tr', null, h('td', { style: { width: '240px' } }, h('b', null, k)), h('td', null, h('div', null, v), h('div', { class: 'small muted selectable' }, more))))),
            ),
          )
        : h('div', { class: 'muted small' }, 'Install the tools to see exactly which options and model families they support.'),
    );
  }

  d(on('toolchain:changed', () => refresh()));
  await refresh();
  loadDoctor();
  loadCaps();
  // Resume watching installs started elsewhere.
  try {
    const jobs = await call('jobs_list', { kind: 'install', limit: 5 });
    jobs.filter((j) => ['running', 'queued'].includes(j.status)).forEach((j) => watchNew(j.id));
  } catch {
    /* ignore */
  }
  if (query.install === 'all') installAllBtn.click();
  return () => d.dispose();
}
