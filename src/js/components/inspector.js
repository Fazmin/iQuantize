// Right-hand panel that shows pinned info entries or contextual details.

import * as kb from '../kb/index.js';
import { clear, h, icon } from '../lib/dom.js';
import { app } from '../lib/store.js';

let panel = null;
let titleEl = null;
let bodyEl = null;
const history = [];

function setOpen(open) {
  app.patch({ inspectorOpen: open });
  panel?.classList.toggle('closed', !open);
}

function placeholder() {
  return h(
    'div',
    { class: 'inspector-empty' },
    icon('circle-help', 'lg'),
    h('div', null, 'Hover any option to see what it does. Click the ⓘ next to it to pin the full explanation here.'),
    h('a', { href: '#/learn' }, 'Browse the glossary →'),
  );
}

export const inspector = {
  mount(el) {
    panel = el;
    panel.className = 'inspector closed';
    titleEl = h('div', { class: 'grow ellipsis' }, 'Info');
    bodyEl = h('div', { class: 'inspector-body selectable' }, placeholder());
    panel.append(
      h(
        'div',
        { class: 'inspector-head' },
        h('button', { class: 'btn ghost sm icon-only', title: 'Back', onClick: () => this.back() }, icon('arrow-left', 'sm')),
        titleEl,
        h('button', { class: 'btn ghost sm icon-only', title: 'Close (I)', onClick: () => this.close() }, icon('x', 'sm')),
      ),
      bodyEl,
    );
  },
  async showEntry(id, note) {
    const { renderEntry } = await import('./info.js');
    history.push({ id, note });
    titleEl.textContent = kb.get(id)?.title || 'Info';
    clear(bodyEl).appendChild(renderEntry(id, { full: true, note }));
    bodyEl.scrollTop = 0;
    setOpen(true);
  },
  show(title, node) {
    history.push({ title, node });
    titleEl.textContent = title;
    clear(bodyEl).appendChild(node);
    setOpen(true);
  },
  back() {
    history.pop();
    const prev = history.pop();
    if (!prev) {
      titleEl.textContent = 'Info';
      clear(bodyEl).appendChild(placeholder());
      return;
    }
    if (prev.id) this.showEntry(prev.id, prev.note);
    else this.show(prev.title, prev.node);
  },
  toggle() {
    setOpen(!app.get().inspectorOpen);
  },
  close() {
    setOpen(false);
  },
};
