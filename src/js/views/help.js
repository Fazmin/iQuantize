// User guide: a hub with search and topic cards, and article pages with a chapter
// nav on the left and an "On this page" outline on the right.

import { attachInfo } from '../components/info.js';
import { inspector } from '../components/inspector.js';
import { NAV } from '../components/shell.js';
import * as help from '../help/index.js';
import * as kb from '../kb/index.js';
import { clear, h, icon } from '../lib/dom.js';
import { call } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

/* ---------------- Inline text ---------------- */

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\))/g;

function link(label, target) {
  if (target.startsWith('help:')) return h('a', { class: 'help-xref', href: `#/help/${target.slice(5)}` }, label);
  if (target.startsWith('term:')) {
    const id = target.slice(5);
    const a = h('a', { class: 'help-term', onClick: () => inspector.showEntry(id) }, label);
    return attachInfo(a, id);
  }
  if (target.startsWith('#/')) return h('a', { class: 'help-route', href: target }, label);
  return h('a', { onClick: () => call('open_external', { url: target }) }, `${label} ↗`);
}

function inline(str) {
  const frag = document.createDocumentFragment();
  for (const part of String(str ?? '').split(TOKEN)) {
    if (!part) continue;
    let m;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) frag.append(h('strong', null, part.slice(2, -2)));
    else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) frag.append(h('code', null, part.slice(1, -1)));
    else if (part.startsWith('[[') && part.endsWith(']]')) frag.append(h('span', { class: 'keys' }, part.slice(2, -2).split('+').map((k) => h('kbd', null, k))));
    else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part))) frag.append(link(m[1], m[2]));
    else frag.append(document.createTextNode(part));
  }
  return frag;
}

/** Highlights each search word inside plain text (text nodes only). */
function highlight(text, q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return document.createTextNode(text);
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const frag = document.createDocumentFragment();
  for (const part of text.split(re)) {
    if (!part) continue;
    frag.append(words.includes(part.toLowerCase()) ? h('mark', null, part) : document.createTextNode(part));
  }
  return frag;
}

const slug = (t) => help.stripInline(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- Blocks ---------------- */

const CALLOUTS = {
  tip: ['Tip', 'sparkles'],
  note: ['Note', 'info'],
  warn: ['Important', 'triangle-alert'],
};

const BLOCKS = {
  p: (t) => h('p', null, inline(t)),
  h: (t) => h('h2', { id: `s-${slug(t)}` }, inline(t)),
  h3: (t) => h('h3', null, inline(t)),
  list: (items) => h('ul', null, items.map((t) => h('li', null, inline(t)))),
  steps: (items) =>
    h(
      'ol',
      { class: 'help-steps' },
      items.map((s, i) =>
        h(
          'li',
          null,
          h('span', { class: 'n' }, String(i + 1)),
          typeof s === 'string' ? h('div', { class: 'b' }, inline(s)) : h('div', { class: 'b' }, h('div', { class: 't' }, inline(s.title)), s.text ? h('div', null, inline(s.text)) : null),
        ),
      ),
    ),
  defs: (rows) => h('dl', { class: 'help-defs' }, rows.map(([t, d]) => [h('dt', null, inline(t)), h('dd', null, inline(d))])),
  table: ({ head, rows }) =>
    h(
      'div',
      { class: 'help-table' },
      h('table', { class: 'table' }, h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c))))))),
    ),
  keys: (rows) =>
    h(
      'div',
      { class: 'help-keys' },
      rows.map(([keys, label]) => h('div', { class: 'help-key' }, h('span', { class: 'grow' }, inline(label)), h('span', { class: 'keys' }, keys.map((k) => h('kbd', null, k))))),
    ),
  action: ({ label, go: path, icon: iconName = 'arrow-right' }) =>
    h('div', null, h('a', { class: 'btn help-action', href: path }, icon(iconName, 'sm'), label)),
};
for (const [type, [label, iconName]] of Object.entries(CALLOUTS)) {
  BLOCKS[type] = (t) => h('div', { class: `help-callout ${type}` }, icon(iconName, 'sm'), h('div', null, h('div', { class: 'label' }, label), h('div', null, inline(t))));
}

function renderBlock(b) {
  const [type, value] = Object.entries(b)[0];
  const fn = BLOCKS[type];
  if (!fn) {
    console.warn(`[help] unknown block "${type}"`);
    return null;
  }
  return fn(value);
}

/* ---------------- Shared pieces ---------------- */

function chapterTile(c, size = '') {
  return h('span', { class: `help-tile tone-${c.tone} ${size}` }, icon(c.icon, size === 'lg' ? '' : 'sm'));
}

function searchBox(value, onInput, placeholder = 'Search the guide…') {
  const input = h('input', { class: 'input', type: 'search', value, placeholder, spellcheck: 'false', onInput: (e) => onInput(e.target.value) });
  return { el: h('div', { class: 'input-with-icon help-search' }, icon('search', 'sm'), input), input };
}

function resultList(q) {
  const results = help.search(q);
  if (!results.length) {
    return h(
      'div',
      { class: 'help-empty' },
      icon('search', 'lg'),
      h('div', null, `Nothing in the guide matches “${q}”.`),
      h('div', { class: 'muted small' }, 'Try a shorter word, or look the term up in ', h('a', { href: `#/learn` }, 'Learn'), '.'),
    );
  }
  return h(
    'div',
    { class: 'help-results' },
    h('div', { class: 'muted small' }, `${results.length} article${results.length === 1 ? '' : 's'}`),
    results.map((a) => {
      const c = help.chapter(a.chapter);
      return h(
        'a',
        { class: 'help-result', href: `#/help/${a.id}` },
        chapterTile(c),
        h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, c.title), h('div', { class: 'title' }, highlight(a.title, q)), h('div', { class: 'snip' }, highlight(help.snippet(a, q), q))),
        icon('chevron-right', 'sm'),
      );
    }),
  );
}

/* ---------------- Hub ---------------- */

const START_PATH = [
  ['setup.environment', 'Set up the tools', 'package'],
  ['models.add-hf', 'Add a model', 'download'],
  ['quantize.wizard', 'Quantize it', 'wand-sparkles'],
  ['test.overview', 'Compare', 'flask-conical'],
  ['publish.overview', 'Publish', 'cloud-upload'],
];
const POPULAR = ['start.quick-start', 'quantize.formats', 'test.quality', 'publish.token', 'help.problems'];

function hub(view, query) {
  setCrumbs([]);
  const below = h('div');
  const browse = () => {
    const topics = h(
      'div',
      { class: 'help-chapters' },
      help.CHAPTERS.map((c) => {
        const list = help.inChapter(c.id);
        return h(
          'div',
          { class: 'help-chapter' },
          h('a', { class: 'head', href: list[0] ? `#/help/${list[0].id}` : '#/help' }, chapterTile(c, 'lg'), h('div', null, h('h3', null, c.title), h('div', { class: 'muted small' }, `${list.length} articles`))),
          h('p', { class: 'blurb' }, c.blurb),
          h('ul', null, list.slice(0, 4).map((a) => h('li', null, h('a', { href: `#/help/${a.id}` }, a.title)))),
          list.length > 4 ? h('a', { class: 'more', href: `#/help/${list[4].id}` }, `${list.length - 4} more`, icon('arrow-right', 'xs')) : null,
        );
      }),
    );
    return [
      h('div', { class: 'section-title' }, icon('workflow', 'sm'), 'The workflow, start to finish'),
      h(
        'div',
        { class: 'help-path' },
        START_PATH.map(([id, label, iconName], i) =>
          h('a', { class: 'step', href: `#/help/${id}` }, h('span', { class: 'n' }, String(i + 1)), icon(iconName, 'sm'), h('span', { class: 'ellipsis' }, label)),
        ),
      ),
      h('div', { class: 'section-title' }, icon('book-open', 'sm'), 'Browse by topic'),
      topics,
      h(
        'div',
        { class: 'help-more grid-3' },
        h('a', { class: 'card pad', href: '#/help/help.shortcuts' }, icon('command'), h('div', null, h('h4', null, 'Keyboard shortcuts'), h('div', { class: 'muted small' }, 'Move around without the mouse.'))),
        h('a', { class: 'card pad', href: '#/learn' }, icon('graduation-cap'), h('div', null, h('h4', null, 'Glossary'), h('div', { class: 'muted small' }, `${kb.all().length} plain-English explanations in Learn.`))),
        h('a', { class: 'card pad', href: '#/help/help.problems' }, icon('life-buoy'), h('div', null, h('h4', null, 'Something not working?'), h('div', { class: 'muted small' }, 'Fixes for the most common problems.'))),
      ),
    ];
  };
  const show = (q) => clear(below).append(q.trim() ? resultList(q) : browse());
  const search = searchBox(query.q || '', show, `Search ${help.all().length} articles…`);
  view.append(
    h(
      'div',
      { class: 'help-hero' },
      h('div', { class: 'eyebrow' }, icon('book-open', 'sm'), 'User guide'),
      h('h1', null, 'How can we help?'),
      h('p', null, 'Step-by-step guides for every part of iQuantize, from your first download to publishing a model card on Hugging Face.'),
      search.el,
      h(
        'div',
        { class: 'popular' },
        h('span', { class: 'muted small' }, 'Popular:'),
        POPULAR.map((id) => help.get(id)).filter(Boolean).map((a) => h('a', { class: 'chip', href: `#/help/${a.id}` }, a.title)),
      ),
    ),
    below,
  );
  show(query.q || '');
}

/* ---------------- Article ---------------- */

function sideNav(current) {
  const nav = h('nav', { class: 'help-nav' });
  const groups = h('div', { class: 'groups' });
  const render = (q) => {
    const needle = q.trim();
    const hits = needle ? new Set(help.search(needle).map((a) => a.id)) : null;
    clear(groups);
    for (const c of help.CHAPTERS) {
      const list = help.inChapter(c.id).filter((a) => !hits || hits.has(a.id));
      if (!list.length) continue;
      groups.append(
        h(
          'div',
          { class: 'group' },
          h('div', { class: 'g-head' }, chapterTile(c), c.title),
          list.map((a) => h('a', { class: `g-item ${a.id === current.id ? 'on' : ''}`, href: `#/help/${a.id}` }, a.title)),
        ),
      );
    }
    if (!groups.children.length) groups.append(h('div', { class: 'muted small' }, 'No matches.'));
  };
  const search = searchBox('', render, 'Filter articles…');
  nav.append(h('a', { class: 'home', href: '#/help' }, icon('arrow-left', 'sm'), 'All topics'), search.el, groups);
  render('');
  return nav;
}

function article(view, root, a, query) {
  const c = help.chapter(a.chapter);
  setCrumbs([a.title]);
  const blocks = (a.body || []).map(renderBlock);
  const headings = blocks.filter((b) => b?.tagName === 'H2');
  const { prev, next } = help.neighbors(a.id);
  const page = NAV.find((n) => help.ROUTE_ARTICLE[n.name] === a.id && n.name !== 'learn');

  const toc = h('aside', { class: 'help-toc' });
  if (headings.length >= 2) {
    toc.append(
      h('div', { class: 'toc-head' }, 'On this page'),
      headings.map((el) => h('a', { data: { target: el.id }, onClick: () => el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, el.textContent)),
    );
  }

  const body = h(
    'article',
    { class: 'help-article selectable' },
    h('a', { class: 'eyebrow', href: `#/help/${help.inChapter(c.id)[0].id}` }, chapterTile(c), c.title),
    h('h1', null, a.title),
    h('p', { class: 'lead' }, inline(a.summary)),
    h(
      'div',
      { class: 'meta' },
      h('span', null, icon('timer', 'xs'), `${help.readingMinutes(a)} min read`),
      page ? h('a', { href: `#${page.path}` }, icon('arrow-up-right', 'xs'), `Open ${page.label}`) : null,
    ),
    h('div', { class: 'help-body' }, blocks),
    a.terms?.length
      ? h(
          'div',
          { class: 'help-terms' },
          h('div', { class: 'label' }, 'Terms used in this article'),
          h('div', { class: 'chips' }, a.terms.filter((id) => kb.has(id)).map((id) => attachInfo(h('button', { class: 'chip', onClick: () => inspector.showEntry(id) }, kb.get(id).title), id))),
        )
      : null,
    h(
      'div',
      { class: 'help-pager' },
      prev ? h('a', { class: 'prev', href: `#/help/${prev.id}` }, h('span', { class: 'dir' }, icon('arrow-left', 'xs'), 'Previous'), h('span', { class: 'title' }, prev.title)) : h('span'),
      next ? h('a', { class: 'next', href: `#/help/${next.id}` }, h('span', { class: 'dir' }, 'Next', icon('arrow-right', 'xs')), h('span', { class: 'title' }, next.title)) : h('span'),
    ),
  );

  const nav = sideNav(a);
  view.append(h('div', { class: 'help-layout' }, nav, body, toc));
  // Keep the current article visible in a long chapter list.
  const list = nav.querySelector('.groups');
  const current = list.querySelector('.g-item.on');
  const top = current ? current.offsetTop - list.offsetTop : 0;
  if (top > list.clientHeight * 0.6) list.scrollTop = top - list.clientHeight / 3;

  // Highlight the outline entry for the section being read.
  let observer = null;
  if (headings.length >= 2 && 'IntersectionObserver' in window) {
    const links = new Map([...toc.querySelectorAll('a')].map((l) => [l.dataset.target, l]));
    const setActive = (id) => links.forEach((l, k) => l.classList.toggle('on', k === id));
    setActive(headings[0].id);
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top);
        if (visible.length) setActive(visible[0].target.id);
      },
      { root, rootMargin: '0px 0px -70% 0px' },
    );
    headings.forEach((el) => observer.observe(el));
  }
  if (query.s) document.getElementById(`s-${query.s}`)?.scrollIntoView({ block: 'start' });
  return () => observer?.disconnect();
}

export default async function helpView(root, { params, query }) {
  await Promise.all([help.load(), kb.load()]);
  const view = h('div', { class: 'view help-view' });
  root.appendChild(view);
  if (!params.id) return hub(view, query);
  const a = help.get(params.id);
  if (!a) {
    go('/help');
    return undefined;
  }
  return article(view, root, a, query);
}
