// Publish a model card + its outputs to Hugging Face.

import { badge, button, callout, dropdown, empty, textField, toggle } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { jobCard } from '../components/jobs.js';
import { showError } from '../components/overlay.js';
import { clear, h, icon } from '../lib/dom.js';
import { ago, bytes } from '../lib/format.js';
import { call, disposer } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

export default async function publishView(root, { query }) {
  setCrumbs([]);
  const d = disposer();
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  const [docs, uploads] = await Promise.all([call('docs_list').catch(() => []), call('uploads_list').catch(() => [])]);
  view.append(h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Publish'), h('div', { class: 'sub' }, 'Upload a model card and its files to Hugging Face. Large files use Xet storage and resume if interrupted.'))));
  if (!docs.length) {
    view.appendChild(h('div', { class: 'card' }, empty({ iconName: 'cloud-upload', title: 'Nothing to publish yet', text: 'Create a model card in Docs first: it decides which files go into the repository.', action: button('Open Docs', { kind: 'primary', onClick: () => go('/docs') }) })));
    return;
  }
  let docId = query.doc && docs.some((x) => x.id === query.doc) ? query.doc : docs[0].id;
  let who = null;
  let ns = '';
  let name = '';
  let priv = true;
  let message = 'Upload quantized model with iQuantize';
  const accountHost = h('div');
  const planHost = h('div');
  const jobHost = h('div');
  const nsDrop = dropdown({ label: 'Owner', info: 'hub.namespace', value: '', options: [], onChange: (v) => (ns = v) });
  const nameField = textField({ label: 'Repository name', info: 'hub.repo_name', value: '', mono: true, onInput: (v) => (name = v.trim()) });

  const suggest = async () => {
    const doc = await call('doc_get', { id: docId });
    const formats = [...new Set((doc.provenance.outputs || []).map((o) => o.format.toUpperCase()))];
    name = `${doc.provenance.model?.name || 'model'}-${formats.join('-')}`.replace(/[^A-Za-z0-9._-]/g, '-');
    nameField.input.value = name;
  };

  const loadAccount = async () => {
    try {
      who = await call('hf_whoami');
      ns = who.name;
      nsDrop.setOptions([{ value: who.name, label: who.name, sub: 'Your account' }, ...who.orgs.map((o) => ({ value: o, label: o, sub: 'Organization' }))]);
      nsDrop.setValue(ns);
      clear(accountHost).appendChild(
        h(
          'div',
          { class: 'account-row' },
          h('div', { class: 'logo' }, icon('user')),
          h('div', { class: 'grow' }, h('b', null, `Signed in as ${who.name}`), h('div', { class: 'small muted' }, `Token role: ${who.role} `, infoIcon('hub.token_role'))),
          who.can_write ? badge('Can publish', 'success') : badge('Read-only token', 'danger'),
        ),
      );
    } catch (e) {
      clear(accountHost).appendChild(callout('warning', 'key-round', h('div', null, h('b', null, 'Connect Hugging Face first. '), e.message, ' ', h('a', { onClick: () => go('/settings') }, 'Open Settings →'))));
    }
  };

  const check = async () => {
    const repo = `${ns}/${name}`;
    clear(planHost).appendChild(h('div', { class: 'row muted' }, h('div', { class: 'spinner' }), 'Checking…'));
    try {
      const plan = await call('publish_prepare', { documentId: docId, repoId: repo });
      clear(planHost).append(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, icon('list-checks', 'sm'), `${plan.files.length + 2} files · ${bytes(plan.total_bytes)}`, plan.repo.exists ? badge('Updates existing repository', 'warning') : badge('New repository', 'accent'), infoIcon(plan.repo.exists ? 'hub.update_existing' : 'hub.repo_name')),
          h(
            'table',
            { class: 'table' },
            h(
              'tbody',
              null,
              h('tr', null, h('td', { class: 'mono' }, 'README.md'), h('td', { class: 'num' }, 'model card')),
              h('tr', null, h('td', { class: 'mono' }, 'quantization_report.json'), h('td', { class: 'num' }, 'provenance')),
              plan.files.map((f) => h('tr', null, h('td', { class: 'mono' }, f.path), h('td', { class: 'num' }, bytes(f.bytes), f.bytes > 50e9 ? ' ' : null, f.bytes > 50e9 ? badge('over 50 GB', 'danger') : null))),
            ),
          ),
        ),
        ...plan.warnings.map((w) => h('div', { style: { marginTop: '8px' } }, callout('warning', 'triangle-alert', w))),
        h(
          'div',
          { class: 'row', style: { marginTop: '12px' } },
          h('span', { class: 'spacer' }),
          button(`Publish to ${repo}`, {
            kind: 'primary',
            iconName: 'cloud-upload',
            disabled: plan.blocked || !who?.can_write,
            onClick: async () => {
              try {
                const id = await call('publish_start', { documentId: docId, repoId: repo, private: priv, message });
                const job = await call('job_get', { id });
                const card = jobCard(job, {
                  onDone: (j) => {
                    if (j.status === 'done')
                      jobHost.appendChild(
                        callout('success', 'circle-check', h('div', null, h('b', null, 'Published! '), h('a', { onClick: () => call('open_external', { url: j.result?.url || `https://huggingface.co/${repo}` }) }, `Open ${repo} on Hugging Face ↗`))),
                      );
                  },
                });
                d(card.dispose);
                clear(jobHost).appendChild(card);
              } catch (e) {
                showError(e, 'Could not start the upload');
              }
            },
          }),
        ),
      );
    } catch (e) {
      clear(planHost).appendChild(callout('danger', 'circle-x', h('div', null, e.message, e.hint ? h('div', { class: 'small' }, e.hint) : null)));
    }
  };

  view.append(
    h(
      'div',
      { class: 'card pad col gap-4' },
      dropdown({ label: 'Model card to publish', info: 'hub.model_card', value: docId, options: docs.map((x) => ({ value: x.id, label: x.title, sub: x.repo_id ? `Last published to ${x.repo_id}` : 'Not published yet' })), onChange: (v) => ((docId = v), suggest()) }),
      accountHost,
      h('div', { class: 'grid-2' }, nsDrop, nameField),
      h('div', { class: 'grid-2' }, toggle({ label: 'Private repository', info: 'hub.private', value: priv, onChange: (v) => (priv = v) }), textField({ label: 'Commit message', info: 'hub.commit_message', value: message, onInput: (v) => (message = v) })),
      h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Hugging Face limits single files to 50 GB; iQuantize splits large GGUF files automatically. ', infoIcon('hub.file_limit')), button('Check before publishing', { iconName: 'shield-check', onClick: check })),
    ),
    h('div', { style: { marginTop: '14px' } }, planHost),
    h('div', { style: { marginTop: '14px' } }, jobHost),
    uploads.length ? h('div', { class: 'section-title' }, 'Published') : null,
    uploads.length
      ? h(
          'div',
          { class: 'card list' },
          uploads.map((u) => h('div', { class: 'list-row', onClick: () => u.url && call('open_external', { url: u.url }) }, icon('cloud-upload', 'sm'), h('div', { class: 'grow' }, h('div', { class: 'title' }, u.repo_id), h('div', { class: 'meta' }, `${u.private ? 'Private' : 'Public'} · ${ago(u.created_at)}`)), icon('external-link', 'sm'))),
        )
      : null,
  );
  await Promise.all([loadAccount(), suggest()]);
  return () => d.dispose();
}
