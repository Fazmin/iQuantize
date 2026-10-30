// Form controls. Every selectable control requires an `info` KB id so users can always
// find out what a choice means; per-option info is supported where options differ.

import * as kb from '../kb/index.js';
import { h, icon, placeNear, richText } from '../lib/dom.js';
import { attachInfo, infoIcon } from './info.js';

function requireInfo(info, label) {
  if (!info) console.warn(`[info] control "${label}" has no info id`);
  else if (!kb.has(info)) console.warn(`[info] control "${label}" references unknown KB id "${info}"`);
}

/** Label row + control + optional help text. */
export function field({ label, info, hint, help, note }, control) {
  requireInfo(info, label);
  return h(
    'div',
    { class: 'field' },
    label || info
      ? h('div', { class: 'field-label' }, label ? h('span', null, label) : null, info ? infoIcon(info, { note }) : null, hint ? h('span', { class: 'hint' }, hint) : null)
      : null,
    control,
    help ? h('div', { class: 'field-help' }, richText(help)) : null,
  );
}

/** Segmented control: options [{ value, label, info?, disabled?, note? }]. */
export function segmented({ label, info, hint, help, value, options, onChange, note }) {
  let current = value;
  const seg = h('div', { class: 'seg', role: 'radiogroup' });
  const buttons = options.map((o) => {
    const b = h(
      'button',
      {
        type: 'button',
        class: o.value === current ? 'on' : '',
        disabled: o.disabled,
        role: 'radio',
        'aria-checked': String(o.value === current),
        onClick: () => {
          if (o.disabled || o.value === current) return;
          current = o.value;
          buttons.forEach((x, i) => x.classList.toggle('on', options[i].value === current));
          onChange?.(current);
        },
      },
      o.label,
    );
    if (o.info) attachInfo(b, o.info, { note: o.note });
    return b;
  });
  seg.append(...buttons);
  if (!label && !info) return seg;
  const f = field({ label, info, hint, help, note }, seg);
  f.setValue = (v) => {
    current = v;
    buttons.forEach((x, i) => x.classList.toggle('on', options[i].value === v));
  };
  return f;
}

let openMenu = null;
function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest?.('.dropdown-btn')) closeMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

/** Opens a floating menu next to an anchor. items: [{ label, sub, right, icon, info, disabled, selected, group, onSelect }] */
export function popupMenu(anchor, items, { minWidth } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'listbox' });
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  let lastGroup = null;
  for (const it of items) {
    if (it.separator) {
      menu.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.group && it.group !== lastGroup) {
      menu.appendChild(h('div', { class: 'menu-group' }, it.group));
      lastGroup = it.group;
    }
    const row = h(
      'div',
      {
        class: `menu-item ${it.selected ? 'selected' : ''} ${it.disabled ? 'disabled' : ''}`,
        role: 'option',
        'aria-selected': String(!!it.selected),
        onClick: () => {
          if (it.disabled) return;
          closeMenu();
          it.onSelect?.();
        },
      },
      it.icon ? icon(it.icon, 'sm') : null,
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, it.label), it.sub ? h('div', { class: 'sub' }, it.sub) : null),
      it.right ? h('span', { class: 'right' }, it.right) : null,
      it.selected ? h('span', { class: 'check' }, icon('check', 'sm')) : null,
    );
    if (it.info) attachInfo(row, it.info, { note: it.note, delay: 250 });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(minWidth || 0, rect.width)}px`;
  placeNear(menu, rect, { gap: 4 });
  openMenu = menu;
  return menu;
}

/** Custom dropdown with per-option info. options: [{ value, label, sub, right, info, disabled, group }] */
export function dropdown({ label, info, hint, help, value, options, onChange, placeholder = 'Select…', note }) {
  let current = value;
  const valueEl = h('span', { class: 'grow ellipsis' });
  const render = () => {
    const o = options.find((x) => x.value === current);
    valueEl.textContent = o ? o.label : placeholder;
    valueEl.classList.toggle('muted', !o);
  };
  render();
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'dropdown-btn',
      onClick: () =>
        popupMenu(
          btn,
          options.map((o) => ({
            ...o,
            selected: o.value === current,
            onSelect: () => {
              current = o.value;
              render();
              onChange?.(current);
            },
          })),
        ),
    },
    valueEl,
    icon('chevron-down', 'sm'),
  );
  const wrap = h('div', { class: 'dropdown' }, btn);
  const f = label || info ? field({ label, info, hint, help, note }, wrap) : wrap;
  f.setValue = (v) => {
    current = v;
    render();
  };
  f.setOptions = (opts) => {
    options = opts;
    render();
  };
  return f;
}

/** On/off switch with label and info. */
export function toggle({ label, info, value, onChange, help, disabled, note }) {
  requireInfo(info, label);
  let on = !!value;
  const sw = h('button', {
    type: 'button',
    class: `switch ${on ? 'on' : ''}`,
    role: 'switch',
    'aria-checked': String(on),
    disabled,
    onClick: () => {
      on = !on;
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(on));
      onChange?.(on);
    },
  });
  const el = h(
    'div',
    { class: 'col gap-1' },
    h('div', { class: 'switch-row' }, sw, h('span', { class: 'grow', onClick: () => !disabled && sw.click() }, label), info ? infoIcon(info, { note }) : null),
    help ? h('div', { class: 'field-help' }, richText(help)) : null,
  );
  el.setValue = (v) => {
    on = !!v;
    sw.classList.toggle('on', on);
  };
  return el;
}

/** Checkbox row (used for multi-select lists). */
export function checkbox({ label, info, checked, onChange, sub, disabled, note }) {
  let on = !!checked;
  const box = h('span', { class: `cbox ${on ? 'on' : ''}` }, icon('check', 'xs'));
  const row = h(
    'label',
    {
      class: `check-row ${disabled ? 'muted' : ''}`,
      onClick: (e) => {
        e.preventDefault();
        if (disabled) return;
        on = !on;
        box.classList.toggle('on', on);
        onChange?.(on);
      },
    },
    box,
    h('span', { class: 'grow' }, label, sub ? h('span', { class: 'muted small' }, ` ${sub}`) : null),
    info ? infoIcon(info, { note }) : null,
  );
  row.setValue = (v) => {
    on = !!v;
    box.classList.toggle('on', on);
  };
  return row;
}

/** Range slider with live value label. */
export function slider({ label, info, min, max, step = 1, value, onChange, format = (v) => v, marks, help, note }) {
  const out = h('span', { class: 'hint num' }, format(value));
  const input = h('input', {
    type: 'range',
    class: 'range',
    min,
    max,
    step,
    value,
    onInput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      onChange?.(v);
    },
  });
  requireInfo(info, label);
  const el = h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-label' }, h('span', null, label), info ? infoIcon(info, { note }) : null, out),
    input,
    marks ? h('div', { class: 'slider-marks' }, marks.map((m) => h('span', null, m))) : null,
    help ? h('div', { class: 'field-help' }, richText(help)) : null,
  );
  el.setValue = (v) => {
    input.value = v;
    out.textContent = format(v);
  };
  return el;
}

export function numberField({ label, info, value, min, max, step = 1, onChange, suffix, help, hint, note }) {
  const input = h('input', {
    type: 'number',
    class: 'input num',
    value,
    min,
    max,
    step,
    onChange: (e) => {
      let v = Number(e.target.value);
      if (Number.isNaN(v)) v = value;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      e.target.value = v;
      onChange?.(v);
    },
  });
  const ctl = suffix ? h('div', { class: 'input-group' }, input, h('span', { class: 'muted small row' }, suffix)) : input;
  const f = field({ label, info, help, hint, note }, ctl);
  f.setValue = (v) => (input.value = v);
  return f;
}

export function textField({ label, info, value = '', placeholder, onChange, onInput, mono, type = 'text', help, hint, note, multiline, rows }) {
  const props = {
    class: `${multiline ? 'textarea' : 'input'} ${mono ? 'mono' : ''}`,
    placeholder,
    spellcheck: 'false',
    onChange: (e) => onChange?.(e.target.value),
    onInput: (e) => onInput?.(e.target.value),
  };
  const input = multiline ? h('textarea', { ...props, rows: rows || 4 }) : h('input', { ...props, type });
  input.value = value;
  const f = label || info ? field({ label, info, help, hint, note }, input) : input;
  f.input = input;
  return f;
}

/** Large selectable card used for formats, presets, recommendations. */
export function optionCard({ title, desc, info, selected, onClick, meters, badges, disabled, iconName, note, compact, right, children }) {
  requireInfo(info, title);
  const meterEl = meters
    ? h(
        'div',
        { class: 'meters inline' },
        Object.entries(meters).map(([k, v]) => {
          const bar = h('span', { class: 'meter' });
          for (let i = 1; i <= 5; i++) bar.appendChild(h('i', { class: i <= v ? 'on' : '' }));
          const lbl = { size: 'Size', quality: 'Quality', speed: 'Speed', effort: 'Ease' }[k] || k;
          return h('span', null, h('span', { class: 'muted' }, lbl), bar);
        }),
      )
    : null;
  const card = h(
    'div',
    {
      class: `opt-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''} ${compact ? 'compact' : ''}`,
      role: 'button',
      tabindex: disabled ? '-1' : '0',
      'aria-pressed': String(!!selected),
      onClick: () => !disabled && onClick?.(),
      onKeydown: (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault();
          onClick?.();
        }
      },
    },
    h(
      'div',
      { class: 'title' },
      iconName ? icon(iconName) : null,
      h('span', { class: 'ellipsis' }, title),
      info ? infoIcon(info, { note }) : null,
      right || null,
      h('span', { class: 'tick' }, icon('circle-check', 'sm')),
    ),
    desc ? h('div', { class: 'desc' }, richText(desc)) : null,
    badges?.length ? h('div', { class: 'row wrap gap-1' }, badges) : null,
    meterEl,
    children || null,
  );
  card.setSelected = (v) => {
    card.classList.toggle('selected', !!v);
    card.setAttribute('aria-pressed', String(!!v));
  };
  return card;
}

export function badge(text, kind = '', iconName) {
  return h('span', { class: `badge ${kind}` }, iconName ? icon(iconName, 'xs') : null, text);
}

export function button(label, { kind = '', iconName, onClick, disabled, size = '', title, kbd } = {}) {
  return h(
    'button',
    { type: 'button', class: `btn ${kind} ${size} ${!label ? 'icon-only' : ''}`.trim(), onClick, disabled, title },
    iconName ? icon(iconName, size === 'sm' ? 'sm' : '') : null,
    label || null,
    kbd ? h('span', { class: 'kbd-hint' }, kbd) : null,
  );
}

export function callout(kind, iconName, ...content) {
  return h('div', { class: `callout ${kind}` }, icon(iconName || { info: 'info', warning: 'triangle-alert', danger: 'circle-x', success: 'circle-check' }[kind] || 'info'), h('div', { class: 'grow' }, content));
}

export function progressBar(frac, { indeterminate, kind = '', thin } = {}) {
  const bar = h('i');
  const el = h('div', { class: `progress ${kind} ${thin ? 'thin' : ''} ${indeterminate ? 'indeterminate' : ''}` }, bar);
  el.set = (f) => {
    el.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
  };
  if (!indeterminate && frac != null) el.set(frac);
  return el;
}

export function empty({ iconName = 'box', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'art' }, icon(iconName, 'lg')), h('h3', null, title), text ? h('p', null, richText(text)) : null, action || null);
}
