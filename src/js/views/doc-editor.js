// Model card editor: Markdown source + sanitized preview, AI writing actions (one or up to
// three models in parallel), a number guard against invented figures, and version history.

import { badge, button, callout, dropdown, segmented } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { openModal, showError, toast } from '../components/overlay.js';
import { clear, debounce, h, icon } from '../lib/dom.js';
import { ago } from '../lib/format.js';
import { call, disposer, on } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';
import { app } from '../lib/store.js';

const ACTIONS = [
  ['draft', 'Draft the full card', 'ai.action.draft'],
  ['beginner', 'Explain for beginners', 'ai.action.beginner'],
  ['faq', 'Add an FAQ', 'ai.action.faq'],
  ['rewrite', 'Rewrite selection', 'ai.action.rewrite'],
  ['tighten', 'Tighten selection', 'ai.action.tighten'],
  ['expand', 'Expand selection', 'ai.action.expand'],
  ['changelog', 'Add a changelog', 'ai.action.changelog'],
];

export default async function docEditor(root, { params }) {
  const d = disposer();
  const view = h('div', { class: 'view full' });
  root.appendChild(view);
  let doc;
  try {
    doc = await call('doc_get', { id: params.id });
  } catch (e) {
    view.appendChild(callout('danger', 'circle-x', e.message));
    return;
  }
  setCrumbs([doc.title]);
  const settings = app.get().settings;
  let aiModels = [];
  let model = settings.ai_default_model || 'gpt-5.6-terra';
  let effort = settings.ai_effort || 'medium';
  let extraModels = [];
  let dirty = false;

  const source = h('textarea', { class: 'doc-source', spellcheck: 'false' });
  source.value = doc.markdown;
  const preview = h('div', { class: 'doc-preview markdown' });
  const status = h('span', { class: 'small muted' }, 'Saved');
  const guardHost = h('div', { class: 'col gap-1' });
  const aiOut = h('div', { class: 'col gap-2' });

  const renderPreview = debounce(async () => {
    try {
      const html = await call('doc_render', { markdown: source.value });
      preview.innerHTML = html; // sanitized by ammonia in Rust; CSP blocks scripts regardless
    } catch (e) {
      console.warn(e);
    }
  }, 150);
  const save = debounce(async (src = 'manual', aiModel = null) => {
    try {
      await call('doc_save', { id: doc.id, markdown: source.value, source: src, aiModel });
      dirty = false;
      status.textContent = 'Saved';
    } catch (e) {
      showError(e);
    }
  }, 700);
  source.addEventListener('input', () => {
    dirty = true;
    status.textContent = 'Editing…';
    renderPreview();
    save();
  });

  const runGuard = async (text) => {
    const flags = await call('doc_guard', { id: doc.id, text }).catch(() => []);
    clear(guardHost);
    if (!flags.length) {
      guardHost.appendChild(h('div', { class: 'small success-text row' }, icon('shield-check', 'sm'), 'Every number traces back to your measurements.', infoIcon('ai.guard')));
      return flags;
    }
    guardHost.appendChild(callout('warning', 'triangle-alert', h('div', null, h('b', null, `${flags.length} number${flags.length > 1 ? 's' : ''} not found in your data. `), 'Check these before publishing: ', infoIcon('ai.guard'), h('ul', null, flags.slice(0, 8).map((f) => h('li', null, h('code', null, f.value), ` …${f.context}…`))))));
    return flags;
  };

  const selection = () => {
    const { selectionStart: s, selectionEnd: e } = source;
    return s !== e ? { start: s, end: e, text: source.value.slice(s, e) } : null;
  };

  function applyResult(action, text, aiModel) {
    const sel = action === 'rewrite' || action === 'tighten' || action === 'expand' ? lastSelection : null;
    if (action === 'draft') source.value = text;
    else if (sel) source.value = source.value.slice(0, sel.start) + text + source.value.slice(sel.end);
    else source.value = `${source.value.trimEnd()}\n\n${text.trim()}\n`;
    renderPreview();
    save('ai', aiModel);
    runGuard(source.value);
  }

  let lastSelection = null;
  const streams = new Map(); // stream -> { model, el, text, action }

  async function runAction(action) {
    if (['rewrite', 'tighten', 'expand'].includes(action)) {
      lastSelection = selection();
      if (!lastSelection) return toast('Select some text in the editor first', { kind: 'warning' });
    }
    const models = [model, ...extraModels].filter((m, i, a) => m && a.indexOf(m) === i).slice(0, 3);
    clear(aiOut);
    for (const m of models) {
      const box = h('div', { class: 'card pad col gap-2' });
      const head = h('div', { class: 'row' }, badge(m, 'accent'), h('span', { class: 'small muted grow' }, 'Writing…'), h('div', { class: 'spinner' }));
      const body = h('div', { class: 'small selectable', style: { whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto' } });
      box.append(head, body);
      aiOut.appendChild(box);
      try {
        const stream = await call('ai_generate', { documentId: doc.id, action, model: m, effort: effort === 'none' ? null : effort, selection: lastSelection?.text || null, markdown: source.value });
        streams.set(stream, { model: m, box, head, body, text: '', action });
      } catch (e) {
        clear(head).append(badge(m, 'danger'), h('span', { class: 'small danger-text' }, e.message));
        if (e.code === 'missing_secret') head.appendChild(button('Add key', { size: 'sm', onClick: () => go('/settings') }));
      }
    }
  }

  d(
    on('ai:delta', (p) => {
      const s = streams.get(p.stream);
      if (!s) return;
      s.text += p.text;
      s.body.textContent = s.text;
      s.body.scrollTop = s.body.scrollHeight;
    }),
  );
  d(
    on('ai:done', (p) => {
      const s = streams.get(p.stream);
      if (!s) return;
      const cost = p.cost != null ? ` · ≈ $${p.cost.toFixed(4)}` : '';
      clear(s.head).append(
        badge(s.model, 'accent'),
        h('span', { class: 'small muted grow' }, `${p.usage?.output_tokens ?? '?'} tokens${cost}`, ' ', infoIcon('ai.cost')),
        button(s.action === 'draft' ? 'Use this draft' : 'Insert', { size: 'sm', kind: 'primary', onClick: () => applyResult(s.action, s.text, s.model) }),
        button('Check numbers', { size: 'sm', onClick: () => runGuard(s.text) }),
      );
    }),
  );
  d(
    on('ai:error', (p) => {
      const s = streams.get(p.stream);
      if (!s) return;
      clear(s.head).append(badge(s.model, 'danger'), h('span', { class: 'small danger-text grow' }, p.message), p.hint ? h('span', { class: 'xs muted' }, p.hint) : null);
    }),
  );

  const modelDrop = dropdown({ value: model, options: [{ value: model, label: model }], onChange: (v) => (model = v) });
  const loadModels = async (refresh) => {
    try {
      const r = await call('ai_models', { refresh });
      aiModels = [
        ...r.featured.map((m) => ({ value: m.id, label: m.label, sub: m.id, right: m.available === false ? 'not on your key' : m.price_in != null ? `$${m.price_in}/$${m.price_out} per 1M` : '', group: m.family.toUpperCase(), info: `ai.family.${m.family}`, disabled: m.available === false })),
        ...r.live.filter((id) => !r.featured.some((f) => f.id === id)).map((id) => ({ value: id, label: id, group: 'Other models on your key', info: 'ai.availability' })),
      ];
      modelDrop.setOptions(aiModels);
    } catch (e) {
      if (refresh) showError(e, 'Could not list models');
    }
  };
  loadModels(false);

  const multi = () => {
    const opts = aiModels.length ? aiModels : [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
    const chosen = new Set(extraModels);
    openModal({
      title: 'Compare drafts from several models',
      iconName: 'columns-2',
      body: h(
        'div',
        { class: 'col gap-2' },
        h('p', { class: 'small' }, 'Up to two extra models write the same section in parallel; pick the best result or merge by hand.'),
        opts
          .filter((o) => o.value !== model && !o.disabled)
          .slice(0, 14)
          .map((o) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: chosen.has(o.value), onChange: (e) => (e.target.checked ? chosen.add(o.value) : chosen.delete(o.value)) }), `${o.label}`)),
      ),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Use these', kind: 'primary', onClick: () => ((extraModels = [...chosen].slice(0, 2)), toast(extraModels.length ? `Comparing with ${extraModels.join(', ')}` : 'Single-model mode', { kind: 'info' })) },
      ],
    });
  };

  const showVersions = async () => {
    const versions = await call('doc_versions', { id: doc.id }).catch(() => []);
    openModal({
      title: 'Version history',
      iconName: 'history',
      wide: true,
      body: h(
        'div',
        { class: 'card list' },
        versions.map((v) =>
          h(
            'div',
            { class: 'list-row' },
            h('div', { class: 'grow' }, h('div', { class: 'title' }, `${v.source === 'ai' ? `AI (${v.ai_model || 'model'})` : v.source === 'template' ? 'Generated template' : 'Edited'}`), h('div', { class: 'meta' }, `${ago(v.created_at)} · ${v.chars.toLocaleString()} characters`)),
            button('Restore', { size: 'sm', onClick: () => ((source.value = v.markdown), renderPreview(), save('manual'), toast('Version restored', { kind: 'success' })) }),
          ),
        ),
      ),
    });
  };

  const regenerate = async () => {
    try {
      source.value = await call('doc_template', { id: doc.id });
      renderPreview();
      save('template');
      toast('Template rebuilt from the latest measurements', { kind: 'success' });
    } catch (e) {
      showError(e);
    }
  };

  const toolbarLeft = h(
    'div',
    { class: 'doc-toolbar' },
    h('b', { class: 'grow ellipsis' }, doc.title),
    status,
    button('', { size: 'sm', kind: 'ghost', iconName: 'history', title: 'Version history', onClick: showVersions }),
    button('Rebuild template', { size: 'sm', kind: 'ghost', iconName: 'refresh-cw', onClick: regenerate }),
    button('Publish', { size: 'sm', kind: 'primary', iconName: 'cloud-upload', onClick: async () => (dirty && (await call('doc_save', { id: doc.id, markdown: source.value })), go(`/publish?doc=${doc.id}`)) }),
  );
  const aiPanel = h(
    'div',
    { class: 'ai-panel' },
    h(
      'div',
      { class: 'row' },
      icon('sparkles', 'sm'),
      h('b', { class: 'nowrap' }, 'Write with AI'),
      infoIcon('ai.provenance'),
      h('div', { style: { width: '220px' } }, modelDrop),
      segmented({ value: effort, options: ['none', 'low', 'medium', 'high'].map((x) => ({ value: x, label: x, info: 'ai.effort' })), onChange: (v) => (effort = v) }),
      button('', { size: 'sm', kind: 'ghost', iconName: 'refresh-cw', title: 'Check which models your key can use', onClick: () => loadModels(true) }),
      button('Compare models', { size: 'sm', kind: 'ghost', iconName: 'columns-2', onClick: multi }),
    ),
    h(
      'div',
      { class: 'row wrap gap-1' },
      ACTIONS.map(([id, label, info]) => {
        const b = button(label, { size: 'sm', onClick: () => runAction(id) });
        import('../components/info.js').then(({ attachInfo }) => attachInfo(b, info));
        return b;
      }),
    ),
    aiOut,
    guardHost,
  );
  view.append(h('div', { class: 'doc-layout' }, h('div', { class: 'doc-pane' }, toolbarLeft, source, aiPanel), h('div', { class: 'doc-pane' }, h('div', { class: 'doc-toolbar' }, icon('eye', 'sm'), h('b', null, 'Preview'), h('span', { class: 'small muted' }, 'as rendered on Hugging Face')), preview)));
  renderPreview();
  runGuard(source.value);
  return () => d.dispose();
}
