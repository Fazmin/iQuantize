// Boot: load settings + platform, build the shell, wire live job updates, start routing.

import { inspector } from './components/inspector.js';
import { showError, toast } from './components/overlay.js';
import { applyTheme, installShortcuts, sidebar, titlebar, workareaHead } from './components/shell.js';
import * as kb from './kb/index.js';
import { forwardErrors, runAutomation } from './lib/devtools.js';
import { h } from './lib/dom.js';
import { call, on } from './lib/ipc.js';
import { define, go, start } from './lib/router.js';
import { app } from './lib/store.js';

define('/', 'home', () => import('./views/home.js'));
define('/models', 'models', () => import('./views/models.js'));
define('/models/:id', 'models', () => import('./views/model-detail.js'));
define('/quantize', 'quantize', () => import('./views/quantize/wizard.js'));
define('/jobs', 'jobs', () => import('./views/jobs.js'));
define('/jobs/:id', 'jobs', () => import('./views/job-detail.js'));
define('/test', 'test', () => import('./views/test/index.js'));
define('/docs', 'docs', () => import('./views/docs.js'));
define('/docs/:id', 'docs', () => import('./views/doc-editor.js'));
define('/publish', 'publish', () => import('./views/publish.js'));
define('/environment', 'environment', () => import('./views/environment.js'));
define('/learn', 'learn', () => import('./views/learn.js'));
define('/help', 'help', () => import('./views/help.js'));
define('/help/:id', 'help', () => import('./views/help.js'));
define('/settings', 'settings', () => import('./views/settings.js'));

const KIND_LABEL = { quantize: 'Quantization', install: 'Install', download: 'Download', eval: 'Evaluation', suite: 'Prompt suite', upload: 'Upload', calibration: 'Calibration data' };

function onJobUpdate(job) {
  const prev = app.get().jobs.get(job.id);
  const jobs = new Map(app.get().jobs);
  jobs.set(job.id, job);
  app.patch({ jobs });
  const finished = prev && prev.status !== job.status && ['done', 'failed'].includes(job.status);
  if (!finished) return;
  const label = KIND_LABEL[job.kind] || 'Job';
  if (job.status === 'done') {
    toast(`${label} finished`, { kind: 'success', detail: job.title, action: { label: 'Open', onClick: () => go(`/jobs/${job.id}`) } });
  } else {
    toast(`${label} failed`, { kind: 'danger', detail: job.title, timeout: 9000, action: { label: 'Details', onClick: () => go(`/jobs/${job.id}`) } });
  }
  if (app.get().settings.notifications !== 'false' && ['quantize', 'eval', 'upload', 'suite'].includes(job.kind)) {
    call('notify', { title: `${label} ${job.status === 'done' ? 'finished' : 'failed'}`, body: job.title }).catch(() => {});
  }
}

async function boot() {
  forwardErrors();
  const [info, settings] = await Promise.all([call('app_info'), call('settings_get')]);
  app.patch({ info, settings });
  applyTheme(settings.theme);
  document.documentElement.classList.add(`platform-${info.platform.os}`);
  await kb.load();

  const root = document.getElementById('app');
  const shell = h('div', { class: `shell ${settings.sidebar_collapsed === 'true' ? 'collapsed' : ''}` });
  const content = h('main', { class: 'content' });
  const insp = h('aside');
  const nav = sidebar();
  shell.append(nav, h('section', { class: 'workarea' }, workareaHead(), h('div', { class: 'workarea-body' }, content, insp)));
  root.append(titlebar(info.platform.os), shell);
  inspector.mount(insp);
  installShortcuts();

  const jobs = await call('jobs_list', { limit: 200 });
  app.patch({ jobs: new Map(jobs.map((j) => [j.id, j])) });
  on('job:update', onJobUpdate);

  start(content);
  await call('app_ready');

  // Nudge first-time users toward the one-click install.
  call('toolchain_status')
    .then((st) => {
      const missing = st.components.filter((c) => c.required && c.status !== 'installed');
      nav.setEnvWarning(missing.length ? `${missing.length} required component${missing.length > 1 ? 's' : ''} not installed yet.` : null);
      on('toolchain:changed', (s) => {
        const m = s.components.filter((c) => c.required && c.status !== 'installed');
        nav.setEnvWarning(m.length ? `${m.length} required component${m.length > 1 ? 's' : ''} not installed yet.` : null);
      });
    })
    .catch(() => {});

  runAutomation();
}

boot().catch((e) => {
  showError(e, 'iQuantize could not start');
  call('app_ready').catch(() => {});
});
