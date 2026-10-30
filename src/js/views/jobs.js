// All background work in one list: installs, downloads, quantizations, evaluations, uploads.

import { badge, empty, progressBar } from '../components/controls.js';
import { statusBadge } from '../components/jobs.js';
import { clear, h } from '../lib/dom.js';
import { ago, duration } from '../lib/format.js';
import { call, disposer, on } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

const KINDS = [
  ['all', 'All'],
  ['quantize', 'Quantize'],
  ['eval', 'Evaluate'],
  ['download', 'Downloads'],
  ['upload', 'Uploads'],
  ['install', 'Installs'],
];

export default async function jobsView(root) {
  setCrumbs([]);
  const d = disposer();
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  let kind = 'all';
  let jobs = [];
  const list = h('div');
  const bars = new Map();

  const render = () => {
    clear(list);
    const rows = jobs.filter((j) => kind === 'all' || j.kind === kind || (kind === 'eval' && j.kind === 'suite'));
    if (!rows.length) {
      list.appendChild(h('div', { class: 'card' }, empty({ iconName: 'activity', title: 'Nothing here yet', text: 'Quantizations, downloads, installs and evaluations show up here while they run and afterwards.' })));
      return;
    }
    bars.clear();
    list.appendChild(
      h(
        'div',
        { class: 'card list' },
        rows.map((j) => {
          const live = ['running', 'queued'].includes(j.status);
          const bar = live ? progressBar(j.progress, { thin: true }) : null;
          if (bar) bars.set(j.id, bar);
          const cur = j.stages.find((s) => s.status === 'running');
          return h(
            'div',
            { class: 'list-row', onClick: () => go(`/jobs/${j.id}`) },
            h('div', { style: { width: '110px' } }, statusBadge(j.status)),
            h(
              'div',
              { class: 'grow col gap-1', style: { minWidth: '0' } },
              h('div', { class: 'title ellipsis' }, j.title),
              live ? h('div', { class: 'meta ellipsis' }, cur ? cur.label : 'Waiting for a free slot…') : j.error ? h('div', { class: 'meta ellipsis danger-text' }, j.error.split('\n')[0]) : null,
              bar,
            ),
            badge(j.kind, 'outline'),
            h('span', { class: 'meta nowrap', style: { width: '120px', textAlign: 'right' } }, j.finished_at ? duration(j.finished_at - (j.started_at || j.created_at)) : ago(j.created_at)),
          );
        }),
      ),
    );
  };

  const tabBar = h('div', { class: 'tabs' });
  const renderTabs = () =>
    clear(tabBar).append(...KINDS.map(([v, l]) => h('button', { class: v === kind ? 'on' : '', onClick: () => ((kind = v), renderTabs(), render()) }, l)));
  renderTabs();

  const load = async () => {
    jobs = await call('jobs_list', { limit: 300 }).catch(() => []);
    render();
  };

  view.append(
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Jobs'), h('div', { class: 'sub' }, 'Everything iQuantize runs in the background. Close this page any time; work continues.'))),
    tabBar,
    list,
  );
  await load();
  d(
    on('job:update', (j) => {
      const i = jobs.findIndex((x) => x.id === j.id);
      if (i >= 0) jobs[i] = j;
      else jobs.unshift(j);
      render();
    }),
  );
  d(on('job:progress', (items) => items.forEach((p) => bars.get(p.id)?.set(p.progress))));
  return () => d.dispose();
}
