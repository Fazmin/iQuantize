// App chrome: title bar, sidebar navigation, the work area header, command palette and shortcuts.

import * as help from '../help/index.js';
import * as kb from '../kb/index.js';
import { clear, h, icon } from '../lib/dom.js';
import { call } from '../lib/ipc.js';
import { go, route } from '../lib/router.js';
import { activeJobs, app } from '../lib/store.js';
import { popupMenu } from './controls.js';
import { inspector } from './inspector.js';
import { openModal } from './overlay.js';

// Sidebar sections. The first has no heading; the rest can be folded.
export const NAV_SECTIONS = [
  {
    id: 'main',
    items: [
      { path: '/', name: 'home', label: 'Home', icon: 'house', key: 'h' },
      { path: '/jobs', name: 'jobs', label: 'Jobs', icon: 'activity', key: 'j' },
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    items: [
      { path: '/models', name: 'models', label: 'Models', icon: 'box', key: 'm' },
      { path: '/quantize', name: 'quantize', label: 'Quantize', icon: 'wand-sparkles', key: 'q' },
      { path: '/test', name: 'test', label: 'Test & Compare', icon: 'flask-conical', key: 't' },
      { path: '/docs', name: 'docs', label: 'Docs', icon: 'file-text', key: 'd' },
      { path: '/publish', name: 'publish', label: 'Publish', icon: 'cloud-upload', key: 'p' },
    ],
  },
  {
    id: 'toolkit',
    label: 'Toolkit',
    items: [
      { path: '/environment', name: 'environment', label: 'Environment', icon: 'wrench', key: 'e' },
      { path: '/settings', name: 'settings', label: 'Settings', icon: 'settings', key: 's' },
    ],
  },
  {
    id: 'support',
    label: 'Support',
    items: [
      { path: '/help', name: 'help', label: 'User guide', icon: 'book-open', key: 'u' },
      { path: '/learn', name: 'learn', label: 'Learn', icon: 'graduation-cap', key: 'l' },
    ],
  },
];
export const NAV = NAV_SECTIONS.flatMap((s) => s.items);

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

const modKey = () => (app.get().info?.platform?.os === 'macos' ? '⌘' : 'Ctrl');

/** Opens the guide article for the current page, or the guide's front page. */
function helpForPage() {
  const id = help.forRoute(route.get().name);
  go(id && route.get().name !== 'help' ? `/help/${id}` : '/help');
}

function toggleSidebar() {
  const shell = document.querySelector('.shell');
  const collapsed = !shell.classList.contains('collapsed');
  shell.classList.toggle('collapsed', collapsed);
  call('settings_set', { key: 'sidebar_collapsed', value: String(collapsed) }).catch(() => {});
}

/* ---------------- Theme ---------------- */

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(pref) {
  const resolved = pref === 'system' || !pref ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  app.patch({ theme: resolved });
  return resolved;
}

media.addEventListener('change', () => {
  if ((app.get().settings.theme || 'system') === 'system') applyTheme('system');
});

export async function setTheme(pref) {
  applyTheme(pref);
  app.patch({ settings: { ...app.get().settings, theme: pref } });
  await call('set_theme', { theme: pref });
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = app.get().settings.theme || 'system';
  return setTheme(order[(order.indexOf(cur) + 1) % order.length]);
}

/* ---------------- Title bar ---------------- */

export function titlebar(os) {
  const jobsPill = h('button', { class: 'jobs-pill hidden', onClick: () => go('/jobs') });
  const renderJobs = () => {
    const n = activeJobs().length;
    jobsPill.classList.toggle('hidden', n === 0);
    clear(jobsPill).append(h('span', { class: 'dot live' }), `${n} running`);
  };
  app.sub(renderJobs);
  renderJobs();

  return h(
    'header',
    { class: 'titlebar', 'data-tauri-drag-region': '' },
    h(
      'div',
      { class: 'tb-nav' },
      h('button', { class: 'tb-btn', title: 'Toggle sidebar ([)', onClick: toggleSidebar }, icon('panel-left')),
      h('button', { class: 'tb-btn', title: 'Back', onClick: () => history.back() }, icon('arrow-left')),
      h('button', { class: 'tb-btn', title: 'Forward', onClick: () => history.forward() }, icon('arrow-right')),
    ),
    h(
      'div',
      { class: 'center' },
      h(
        'button',
        { class: 'search-pill', onClick: () => openPalette() },
        icon('search', 'sm'),
        h('span', { class: 'grow' }, 'Search or jump to…'),
        h('kbd', null, os === 'macos' ? '⌘' : 'Ctrl'),
        h('kbd', null, 'K'),
      ),
    ),
    h('div', { class: 'tb-actions' }, jobsPill),
    os === 'macos'
      ? null
      : h(
          'div',
          { class: 'win-controls' },
          h('button', { title: 'Minimize', onClick: () => call('window_action', { action: 'minimize' }) }, icon('minus', 'sm')),
          h('button', { title: 'Maximize', onClick: () => call('window_action', { action: 'toggle_maximize' }) }, icon('square', 'xs')),
          h('button', { class: 'close', title: 'Close', onClick: () => call('window_action', { action: 'close' }) }, icon('x', 'sm')),
        ),
  );
}

/* ---------------- Work area header ---------------- */

/** Breadcrumbs for the current page on the left, view toggles on the right. */
export function workareaHead() {
  const crumbs = h('div', { class: 'crumbs' });
  const themeBtn = h('button', { class: 'tb-btn', title: 'Theme (system / light / dark)', onClick: cycleTheme });
  const inspBtn = h('button', { class: 'tb-btn', title: 'Info panel (I)', onClick: () => inspector.toggle() }, icon('panel-right'));
  const helpBtn = h('button', { class: 'tb-btn', title: 'Help for this page', onClick: helpForPage }, icon('circle-help'));

  const renderCrumbs = () => {
    const r = route.get();
    const nav = NAV.find((n) => n.name === r.name) || NAV[0];
    const sub = r.crumbs || [];
    helpBtn.classList.toggle('hidden', r.name === 'help');
    clear(crumbs).append(
      h(
        sub.length ? 'a' : 'span',
        { class: `crumb ${sub.length ? '' : 'cur'}`, href: sub.length ? `#${nav.path}` : null },
        icon(nav.icon, 'sm'),
        h('span', { class: 'ellipsis' }, nav.label),
      ),
      sub.flatMap((p, i) => [icon('chevron-right', 'xs'), h('span', { class: `crumb ellipsis ${i === sub.length - 1 ? 'cur' : ''}` }, p)]),
    );
  };
  const render = () => {
    clear(themeBtn).appendChild(icon(THEME_ICON[app.get().settings.theme || 'system']));
    inspBtn.classList.toggle('on', app.get().inspectorOpen);
  };
  route.sub(renderCrumbs);
  app.sub(render);
  renderCrumbs();
  render();

  return h('header', { class: 'workarea-head', 'data-tauri-drag-region': '' }, crumbs, h('div', { class: 'tb-actions' }, helpBtn, themeBtn, inspBtn));
}

/* ---------------- Sidebar ---------------- */

function appMenu(anchor) {
  const pref = app.get().settings.theme || 'system';
  popupMenu(
    anchor,
    [
      { label: 'Settings', icon: 'settings', right: 'G S', onSelect: () => go('/settings') },
      { label: 'Environment', icon: 'wrench', right: 'G E', onSelect: () => go('/environment') },
      { separator: true },
      ...['system', 'light', 'dark'].map((t) => ({
        group: 'Theme',
        label: t[0].toUpperCase() + t.slice(1),
        icon: THEME_ICON[t],
        selected: pref === t,
        onSelect: () => setTheme(t),
      })),
      { separator: true },
      { label: 'Command palette', icon: 'search', right: `${modKey()} K`, onSelect: openPalette },
      { label: 'Keyboard shortcuts', icon: 'command', right: '?', onSelect: showShortcuts },
      { label: 'User guide', icon: 'book-open', right: 'G U', onSelect: () => go('/help') },
    ],
    { minWidth: 220 },
  );
}

function helpMenu(anchor) {
  popupMenu(
    anchor,
    [
      { label: 'User guide', icon: 'book-open', right: 'G U', onSelect: () => go('/help') },
      { label: 'Help for this page', icon: 'circle-help', onSelect: helpForPage },
      { label: 'Troubleshooting', icon: 'life-buoy', onSelect: () => go('/help/help.problems') },
      { separator: true },
      { label: 'Keyboard shortcuts', icon: 'command', right: '?', onSelect: showShortcuts },
      { label: 'Glossary', icon: 'graduation-cap', right: 'G L', onSelect: () => go('/learn') },
    ],
    { minWidth: 220 },
  );
}

export function sidebar() {
  const counts = {};
  const folded = new Set((app.get().settings.nav_folded || '').split(',').filter(Boolean));
  const item = (n) => {
    const count = h('span', { class: 'count' });
    counts[n.name] = count;
    return h('a', { class: 'nav-item', href: `#${n.path}`, title: n.label, data: { name: n.name } }, icon(n.icon), h('span', { class: 'label' }, n.label), count);
  };
  const section = (sec) => {
    const el = h('div', { class: `nav-section ${folded.has(sec.id) ? 'folded' : ''}` });
    const toggle = () => {
      if (folded.has(sec.id)) folded.delete(sec.id);
      else folded.add(sec.id);
      el.classList.toggle('folded', folded.has(sec.id));
      call('settings_set', { key: 'nav_folded', value: [...folded].join(',') }).catch(() => {});
    };
    el.append(
      sec.label ? h('button', { class: 'nav-section-head', onClick: toggle }, h('span', null, sec.label), icon('chevron-down', 'xs')) : null,
      h('div', { class: 'nav-items' }, sec.items.map(item)),
    );
    return el;
  };

  const brand = h(
    'button',
    { class: 'sb-brand', title: 'iQuantize', onClick: () => appMenu(brand) },
    h('img', { src: 'assets/logo.svg', alt: '' }),
    h('span', { class: 'label ellipsis' }, 'iQuantize'),
    icon('chevron-down', 'xs'),
  );
  const envCard = h('div', { class: 'footer-card hidden' });
  const el = h(
    'nav',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'sb-head' },
      brand,
      h('button', { class: 'sb-compose', title: 'New quantization (C)', onClick: () => go('/quantize') }, icon('square-pen', 'sm')),
    ),
    NAV_SECTIONS.map(section),
    h(
      'div',
      { class: 'footer' },
      envCard,
      h('button', { class: 'sb-help', title: 'Help and shortcuts', onClick: (e) => helpMenu(e.currentTarget) }, icon('circle-help', 'sm')),
    ),
  );
  const highlight = () => {
    const r = route.get();
    for (const a of el.querySelectorAll('.nav-item')) a.classList.toggle('active', a.dataset.name === r.name);
  };
  route.sub(highlight);
  highlight();
  app.sub(() => {
    const n = activeJobs().length;
    counts.jobs.textContent = n ? String(n) : '';
    counts.jobs.classList.toggle('live', n > 0);
  });
  el.setEnvWarning = (text) => {
    envCard.classList.toggle('hidden', !text);
    counts.environment.classList.toggle('warn', !!text);
    counts.environment.title = text || '';
    if (text) {
      clear(envCard).append(
        h('div', { class: 'row', style: { color: 'var(--text-2)', fontWeight: '500' } }, icon('package', 'sm'), 'Set up tools'),
        h('div', { style: { margin: '4px 0 8px' } }, text),
        h('a', { href: '#/environment' }, 'Open Environment →'),
      );
    }
  };
  return el;
}

/* ---------------- Command palette ---------------- */

let paletteOpen = false;

function commands() {
  const list = [];
  for (const n of NAV) list.push({ group: 'Go to', label: n.label, icon: n.icon, keys: ['G', n.key.toUpperCase()], run: () => go(n.path) });
  list.push(
    { group: 'Actions', label: 'New quantization', icon: 'wand-sparkles', keys: ['C'], run: () => go('/quantize') },
    { group: 'Actions', label: 'Add a model from Hugging Face', icon: 'download', run: () => go('/models?add=hf') },
    { group: 'Actions', label: 'Import a local model folder', icon: 'folder-open', run: () => go('/models?add=local') },
    { group: 'Actions', label: 'Compare two models side by side', icon: 'columns-2', run: () => go('/test') },
    { group: 'Actions', label: 'Install everything for this machine', icon: 'package', run: () => go('/environment?install=all') },
    { group: 'Actions', label: 'Toggle theme', icon: 'sun', run: cycleTheme },
    { group: 'Actions', label: 'Toggle info panel', icon: 'panel-right', keys: ['I'], run: () => inspector.toggle() },
    { group: 'Actions', label: 'Keyboard shortcuts', icon: 'command', keys: ['?'], run: showShortcuts },
  );
  return list;
}

export function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  help.load().then(() => paletteOpen && render());
  const input = h('input', { class: 'cmdk-input', placeholder: 'Type a command, page, or a term to explain…', spellcheck: 'false' });
  const listEl = h('div', { class: 'cmdk-list' });
  const backdrop = h(
    'div',
    { class: 'modal-backdrop' },
    h('div', { class: 'cmdk' }, input, listEl, h('div', { class: 'cmdk-foot' }, h('span', null, '↑↓ navigate'), h('span', null, '↵ select'), h('span', null, 'esc close'))),
  );
  let focus = 0;
  let current = [];
  const close = () => {
    paletteOpen = false;
    backdrop.remove();
  };
  const run = (c) => {
    close();
    c?.run();
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const base = commands().filter((c) => !q || c.label.toLowerCase().includes(q));
    const guide = q.length >= 2 ? help.search(q).slice(0, 5).map((a) => ({ group: 'User guide', label: a.title, sub: a.summary, icon: 'book-open', run: () => go(`/help/${a.id}`) })) : [];
    const explain = q.length >= 2 ? kb.search(q).slice(0, 8).map((e) => ({ group: 'Explain', label: e.title, sub: e.tagline, icon: 'graduation-cap', run: () => inspector.showEntry(e.id) })) : [];
    current = [...base, ...guide, ...explain];
    focus = Math.min(focus, Math.max(0, current.length - 1));
    clear(listEl);
    let lastGroup = null;
    current.forEach((c, i) => {
      if (c.group !== lastGroup) {
        listEl.appendChild(h('div', { class: 'cmdk-group' }, c.group));
        lastGroup = c.group;
      }
      const row = h(
        'div',
        { class: `cmdk-item ${i === focus ? 'focus' : ''}`, onClick: () => run(c), onMousemove: () => setFocus(i) },
        icon(c.icon || 'arrow-right', 'sm'),
        h('span', { class: 'ellipsis' }, c.label),
        c.sub ? h('span', { class: 'muted small ellipsis grow' }, `— ${c.sub}`) : null,
        c.keys ? h('span', { class: 'right' }, c.keys.map((k) => h('kbd', null, k))) : null,
      );
      listEl.appendChild(row);
    });
    if (!current.length) listEl.appendChild(h('div', { class: 'empty small' }, 'No matches'));
  };
  const setFocus = (i) => {
    if (i === focus) return;
    focus = i;
    listEl.querySelectorAll('.cmdk-item').forEach((el, j) => el.classList.toggle('focus', j === focus));
  };
  input.addEventListener('input', () => {
    focus = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(Math.min(current.length - 1, focus + 1));
      listEl.querySelectorAll('.cmdk-item')[focus]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(Math.max(0, focus - 1));
      listEl.querySelectorAll('.cmdk-item')[focus]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(current[focus]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  render();
  input.focus();
}

function showShortcuts() {
  const rows = [
    [[modKey(), 'K'], 'Command palette'],
    [['C'], 'New quantization'],
    [['I'], 'Toggle info panel'],
    [['['], 'Collapse sidebar'],
    [['?'], 'This list'],
    ...NAV.map((n) => [['G', n.key.toUpperCase()], `Go to ${n.label}`]),
  ];
  openModal({
    title: 'Keyboard shortcuts',
    iconName: 'command',
    body: h(
      'table',
      { class: 'table' },
      h(
        'tbody',
        null,
        rows.map(([keys, label]) => h('tr', null, h('td', null, label), h('td', { class: 'num' }, keys.map((k) => h('kbd', null, k))))),
      ),
    ),
  });
}

export function installShortcuts() {
  let gPending = false;
  let gTimer = null;
  window.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, [contenteditable], select');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      const n = NAV.find((x) => x.key === k);
      if (n) {
        e.preventDefault();
        go(n.path);
      }
      return;
    }
    if (k === 'g') {
      gPending = true;
      gTimer = setTimeout(() => (gPending = false), 900);
    } else if (k === 'c') {
      go('/quantize');
    } else if (k === 'i') {
      inspector.toggle();
    } else if (k === '[') {
      toggleSidebar();
    } else if (e.key === '?') {
      showShortcuts();
    }
  });
}
