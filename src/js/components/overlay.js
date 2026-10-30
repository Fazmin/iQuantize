// Modals, confirmations and toasts.

import { h, icon, richText } from '../lib/dom.js';

let toastHost = null;

export function toast(title, { kind = 'info', detail, timeout = 5000, action } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const ic = { success: 'circle-check', danger: 'circle-x', warning: 'triangle-alert', info: 'info' }[kind] || 'info';
  const el = h(
    'div',
    { class: `toast ${kind}` },
    icon(ic),
    h(
      'div',
      { class: 'grow col gap-1' },
      h('div', { class: 'title' }, title),
      detail ? h('div', { class: 'selectable' }, richText(detail)) : null,
      action ? h('div', null, h('button', { class: 'btn sm', onClick: () => (action.onClick(), close()) }, action.label)) : null,
    ),
    h('button', { class: 'btn ghost sm icon-only x', onClick: () => close() }, icon('x', 'sm')),
  );
  const close = () => el.remove();
  toastHost.appendChild(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

/** Shows an error (AppError or Error) as a toast with its hint. */
export function showError(e, title = 'Something went wrong') {
  console.error(e);
  const msg = e?.message || String(e);
  const detail = e?.hint ? `${msg}\n\n${e.hint}` : msg;
  return toast(title, { kind: 'danger', detail, timeout: 9000 });
}

let modalStack = [];

export function openModal({ title, body, actions = [], wide = false, onClose, iconName, className = '' }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (result) => {
    backdrop.remove();
    modalStack = modalStack.filter((m) => m !== backdrop);
    document.removeEventListener('keydown', onKey);
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === backdrop) close(null);
  };
  const footer = actions.length
    ? h(
        'div',
        { class: 'modal-foot' },
        actions.map((a) =>
          h(
            'button',
            {
              class: `btn ${a.kind || ''}`,
              disabled: a.disabled,
              onClick: async () => {
                if (a.onClick) {
                  const keep = await a.onClick();
                  if (keep === false) return;
                }
                close(a.value ?? a.label);
              },
            },
            a.label,
          ),
        ),
      )
    : null;
  const modal = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, iconName ? icon(iconName) : null, h('span', { class: 'grow' }, title), h('button', { class: 'btn ghost sm icon-only', onClick: () => close(null) }, icon('x', 'sm'))),
    h('div', { class: 'modal-body selectable' }, body),
    footer,
  );
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(null);
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  modalStack.push(backdrop);
  setTimeout(() => modal.querySelector('input, textarea, button.primary')?.focus(), 30);
  return { close, el: modal };
}

export function confirm({ title, text, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: h('p', null, richText(text)),
      actions: [
        { label: 'Cancel', kind: 'ghost', value: false },
        { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', value: true },
      ],
      onClose: (r) => resolve(r === true),
    });
  });
}
