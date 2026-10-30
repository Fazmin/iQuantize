import { button, callout, dropdown, numberField, segmented, textField, toggle } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { openModal, showError, toast } from '../components/overlay.js';
import { setTheme } from '../components/shell.js';
import { h, icon, replace } from '../lib/dom.js';
import { call } from '../lib/ipc.js';
import { app } from '../lib/store.js';

function section(title, desc, ...body) {
  return h('div', { class: 'settings-section' }, h('div', { class: 's-head' }, h('h3', null, title), h('p', null, desc)), h('div', { class: 's-body' }, body));
}

async function save(key, value) {
  try {
    await call('settings_set', { key, value: String(value) });
    app.patch({ settings: { ...app.get().settings, [key]: String(value) } });
  } catch (e) {
    showError(e, 'Could not save setting');
  }
}

function secretDialog({ title, name, placeholder, help, after }) {
  const input = h('input', { class: 'input mono', type: 'password', placeholder, autocomplete: 'off', spellcheck: 'false' });
  openModal({
    title,
    iconName: 'key-round',
    body: h('div', { class: 'col gap-3' }, h('p', null, help), input, h('p', { class: 'small muted' }, 'Stored encrypted in the local database; the encryption key lives in your OS keychain. It is never shown again or sent to the interface.')),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: async () => {
          try {
            await call('secret_set', { name, value: input.value });
            toast('Saved securely', { kind: 'success' });
            after?.();
          } catch (e) {
            showError(e);
            return false;
          }
        },
      },
    ],
  });
}

export default async function settingsView(root) {
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  const s = app.get().settings;
  const info = app.get().info;

  const accounts = h('div', { class: 'col gap-3' });
  const renderAccounts = async () => {
    let status = { items: [], backend: {} };
    try {
      status = await call('secrets_status');
    } catch (e) {
      showError(e);
    }
    const has = (n) => status.items.find((i) => i.name === n);
    const hf = has('hf_token');
    const oa = has('openai_api_key');
    const hfMeta = h('div', { class: 'meta small muted' }, hf ? `Token ${hf.hint}` : 'Needed for gated models and publishing.');
    const oaMeta = h('div', { class: 'meta small muted' }, oa ? `Key ${oa.hint}` : 'Optional: helps write model cards.');
    replace(
      accounts,
      h(
        'div',
        { class: 'account-row' },
        h('div', { class: 'logo' }, icon('cloud-upload')),
        h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', null, 'Hugging Face'), infoIcon('hub.token')), hfMeta),
        hf ? button('Check', { size: 'sm', kind: 'ghost', onClick: checkHf }) : null,
        button(hf ? 'Replace' : 'Add token', {
          size: 'sm',
          onClick: () =>
            secretDialog({
              title: 'Hugging Face access token',
              name: 'hf_token',
              placeholder: 'hf_…',
              help: 'Create a token at huggingface.co → Settings → Access Tokens. Use a "write" token if you want to publish models.',
              after: () => renderAccounts().then(checkHf),
            }),
        }),
        hf ? button('', { size: 'sm', kind: 'ghost', iconName: 'trash-2', title: 'Remove', onClick: () => call('secret_delete', { name: 'hf_token' }).then(renderAccounts) }) : null,
      ),
      h(
        'div',
        { class: 'account-row' },
        h('div', { class: 'logo' }, icon('sparkles')),
        h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', null, 'OpenAI'), infoIcon('ai.key')), oaMeta),
        oa ? button('Check', { size: 'sm', kind: 'ghost', onClick: checkOpenAI }) : null,
        button(oa ? 'Replace' : 'Add key', {
          size: 'sm',
          onClick: () =>
            secretDialog({
              title: 'OpenAI API key',
              name: 'openai_api_key',
              placeholder: 'sk-…',
              help: 'Used only to help write documentation. Requests go from this app directly to the API base URL below.',
              after: () => renderAccounts().then(checkOpenAI),
            }),
        }),
        oa ? button('', { size: 'sm', kind: 'ghost', iconName: 'trash-2', title: 'Remove', onClick: () => call('secret_delete', { name: 'openai_api_key' }).then(renderAccounts) }) : null,
      ),
      status.backend?.warning ? callout('warning', 'triangle-alert', status.backend.warning) : null,
    );

    async function checkHf() {
      hfMeta.textContent = 'Checking…';
      try {
        const who = await call('hf_whoami');
        hfMeta.textContent = `Signed in as ${who.name} · token role: ${who.role || 'unknown'}${who.orgs?.length ? ` · orgs: ${who.orgs.join(', ')}` : ''}`;
      } catch (e) {
        hfMeta.textContent = e.message;
        hfMeta.classList.add('danger-text');
      }
    }
    async function checkOpenAI() {
      oaMeta.textContent = 'Checking…';
      try {
        const res = await call('ai_models', { refresh: true });
        const avail = res.featured.filter((m) => m.available).length;
        oaMeta.textContent = `Key works · ${avail} of ${res.featured.length} featured models available · ${res.live_count} models on this key`;
      } catch (e) {
        oaMeta.textContent = e.message;
        oaMeta.classList.add('danger-text');
      }
    }
    if (hf) checkHf();
  };

  let aiModelOptions = [{ value: s.ai_default_model, label: s.ai_default_model }];
  const aiModel = dropdown({
    label: 'Default model for documentation',
    info: 'ai.featured',
    value: s.ai_default_model,
    options: aiModelOptions,
    onChange: (v) => save('ai_default_model', v),
  });
  call('ai_models', { refresh: false })
    .then((res) => {
      aiModelOptions = res.featured.map((m) => ({ value: m.id, label: m.label, sub: m.id, group: m.family.toUpperCase(), right: m.available === false ? 'not on key' : '', info: `ai.family.${m.family}` }));
      aiModel.setOptions(aiModelOptions);
    })
    .catch(() => {});

  const wsLabel = h('div', { class: 'mono small selectable ellipsis' }, s.workspace);

  view.append(
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Settings'), h('div', { class: 'sub' }, 'Appearance, storage, performance and connected accounts.'))),
    section(
      'Appearance',
      'Light, dark, or follow the system.',
      segmented({
        label: 'Theme',
        info: 'settings.theme',
        value: s.theme || 'system',
        options: [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        onChange: (v) => setTheme(v).catch(showError),
      }),
    ),
    section(
      'Accounts',
      'Credentials are encrypted at rest. The interface never receives them back.',
      accounts,
      textField({
        label: 'OpenAI-compatible API base URL',
        info: 'ai.base_url',
        value: s.ai_base_url,
        mono: true,
        onChange: (v) => save('ai_base_url', v),
      }),
      aiModel,
      segmented({
        label: 'Default reasoning effort',
        info: 'ai.effort',
        value: s.ai_effort || 'medium',
        options: ['none', 'low', 'medium', 'high'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
        onChange: (v) => save('ai_effort', v),
      }),
      textField({ label: 'Quantized by (shown on model cards)', info: 'hub.model_card', value: s.quantized_by, placeholder: 'Your name or HF username', onChange: (v) => save('quantized_by', v) }),
    ),
    section(
      'Workspace',
      'Where models, quantized outputs and caches are stored. Pick a large, fast drive.',
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-label' }, 'Workspace folder', infoIcon('settings.workspace')),
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'grow card pad', style: { padding: '6px 10px' } }, wsLabel),
          button('Change…', {
            size: 'sm',
            onClick: async () => {
              const p = await call('pick_folder', { title: 'Choose workspace folder' });
              if (!p) return;
              await save('workspace', p);
              wsLabel.textContent = p;
              toast('Workspace updated', { kind: 'success', detail: 'Existing files were not moved.' });
            },
          }),
          button('', { size: 'sm', kind: 'ghost', iconName: 'folder-open', title: 'Reveal', onClick: () => call('reveal_path', { path: wsLabel.textContent }).catch(showError) }),
        ),
      ),
      toggle({
        label: 'Keep intermediate files (F16 GGUF, importance matrix) for faster re-runs',
        info: 'settings.keep_intermediates',
        value: s.keep_intermediates !== 'false',
        onChange: (v) => save('keep_intermediates', v),
      }),
    ),
    section(
      'Performance',
      'Quantization is memory hungry. Running one heavy job at a time is safest.',
      numberField({ label: 'Heavy jobs at once', info: 'settings.concurrency', value: Number(s.concurrency || 1), min: 1, max: 4, onChange: (v) => save('concurrency', v), help: 'Takes effect after restarting the app.' }),
      numberField({ label: 'CPU threads (0 = automatic)', info: 'settings.threads', value: Number(s.threads || 0), min: 0, max: 256, onChange: (v) => save('threads', v) }),
      toggle({ label: 'Notify me when long jobs finish', info: 'settings.notifications', value: s.notifications !== 'false', onChange: (v) => save('notifications', v) }),
    ),
    section(
      'About',
      'Version and folders.',
      h(
        'dl',
        { class: 'kv selectable' },
        h('dt', null, 'Version'),
        h('dd', null, info.version),
        h('dt', null, 'Platform'),
        h('dd', null, `${info.platform.os} · ${info.platform.arch} · ${info.platform.cpu_brand}`),
        h('dt', null, 'App data'),
        h('dd', { class: 'mono' }, info.paths.data),
        h('dt', null, 'Secrets'),
        h('dd', null, info.secrets_backend.kind === 'os-keychain' ? 'Encrypted, key in OS keychain' : 'Encrypted, key in private file'),
      ),
    ),
  );
  renderAccounts();
}
