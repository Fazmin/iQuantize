// Tiny DOM builder. Never uses innerHTML for untrusted text, never sets the `style`
// attribute (CSP forbids inline styles); styles go through CSSOM instead.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Convention: views pass conditional children (`cond ? node : null`) to append(). The native
// method would render "null", so skip null/undefined/boolean children everywhere.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  const native = proto.append;
  proto.append = function append(...children) {
    native.apply(this, children.flat().filter((c) => c != null && c !== false && c !== true));
  };
}

function append(el, child) {
  if (child == null || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(el, c);
    return;
  }
  if (child instanceof Node) {
    el.appendChild(child);
    return;
  }
  el.appendChild(document.createTextNode(String(child)));
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      if (isSvg) el.setAttribute('class', cls);
      else el.className = cls;
    } else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = dv;
    } else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') {
      el.textContent = v;
    } else if (k === 'ref') {
      v(el);
    } else if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly')) {
      el[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/** h('div', { class: 'x', onClick }, child1, 'text', [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (props instanceof Node || Array.isArray(props) || typeof props !== 'object')) {
    children.unshift(props);
    props = null;
  }
  applyProps(el, props, false);
  append(el, children);
  return el;
}

/** SVG element builder. */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

/** Lucide icon from the local sprite. */
export function icon(name, cls = '') {
  return s('svg', { class: `icon ${cls}`.trim(), 'aria-hidden': 'true' }, s('use', { href: `assets/icons.svg#${name}` }));
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** Renders plain text with `backtick` spans as <code>, safely. */
export function richText(str) {
  const frag = document.createDocumentFragment();
  if (!str) return frag;
  const parts = String(str).split(/(`[^`]+`)/g);
  for (const p of parts) {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) frag.appendChild(h('code', null, p.slice(1, -1)));
    else if (p) frag.appendChild(document.createTextNode(p));
  }
  return frag;
}

/** Positions a fixed-position floating element next to an anchor rect, kept on screen. */
export function placeNear(floating, anchorRect, { side = 'bottom', gap = 6, align = 'start' } = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fr = floating.getBoundingClientRect();
  let x;
  let y;
  if (side === 'right') {
    x = anchorRect.right + gap;
    y = anchorRect.top;
    if (x + fr.width > vw - 8) x = anchorRect.left - fr.width - gap;
  } else {
    x = align === 'end' ? anchorRect.right - fr.width : anchorRect.left;
    y = anchorRect.bottom + gap;
    if (y + fr.height > vh - 8) y = anchorRect.top - fr.height - gap;
  }
  x = Math.max(8, Math.min(x, vw - fr.width - 8));
  y = Math.max(8, Math.min(y, vh - fr.height - 8));
  floating.style.left = `${Math.round(x)}px`;
  floating.style.top = `${Math.round(y)}px`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttleRaf(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}
