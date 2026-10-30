// Hash router with lazily imported views. A view module's default export is
// `(container, { params, query }) => cleanup?` (sync or async).

import { clear, h, icon } from './dom.js';
import { store } from './store.js';

export const route = store({ path: '/', name: 'home', params: {}, query: {}, crumbs: [] });

const routes = [];

export function define(pattern, name, load) {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\//g, '\\/').replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ pattern, name, load, re, keys });
}

export function go(path) {
  if (location.hash.slice(1) === path) {
    render();
    return;
  }
  location.hash = path;
}

export function href(path) {
  return `#${path}`;
}

/** Views call this to set the breadcrumbs in the work area header. */
export function setCrumbs(crumbs) {
  route.patch({ crumbs });
}

let container = null;
let cleanup = null;
let token = 0;

export function start(el) {
  container = el;
  window.addEventListener('hashchange', render);
  render();
}

function parse() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { r, path, params, query };
    }
  }
  return null;
}

async function render() {
  const my = ++token;
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
  }
  cleanup = null;
  const match = parse();
  if (!match) {
    location.hash = '/';
    return;
  }
  route.set({ path: match.path, name: match.r.name, params: match.params, query: match.query, crumbs: [] });
  let mod;
  try {
    mod = await match.r.load();
  } catch (e) {
    console.error(e);
    clear(container).appendChild(
      h('div', { class: 'view' }, h('div', { class: 'callout danger' }, icon('triangle-alert'), h('div', null, `Could not load this view: ${e.message}`))),
    );
    return;
  }
  if (my !== token) return;
  clear(container);
  container.scrollTop = 0;
  try {
    const c = await mod.default(container, { params: match.params, query: match.query });
    if (my !== token) {
      if (typeof c === 'function') c();
      return;
    }
    cleanup = c;
  } catch (e) {
    console.error(e);
    container.appendChild(
      h('div', { class: 'view' }, h('div', { class: 'callout danger' }, icon('triangle-alert'), h('div', null, e.message || String(e)))),
    );
  }
}
