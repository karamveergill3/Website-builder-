/* Tiny DOM helpers: an escaping template tag, plus toasts and modals. */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for safe interpolation into HTML. */
export const esc = (v) =>
  v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]);

/** Mark a string as pre-escaped HTML so `html` does not escape it again. */
export class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(value);

/**
 * Tagged template that escapes every interpolation. Arrays are joined;
 * `raw(...)` values and nested `html` results pass through untouched.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Raw(out);
}

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/** Replace an element's content with rendered HTML. */
export function mount(el, content) {
  el.innerHTML = render(content);
  return el;
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated event binding: on(root, 'click', '[data-act="x"]', handler). */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (ev) => {
    const target = ev.target.closest(selector);
    if (target && root.contains(target)) handler(ev, target);
  });
}

/* ---------------- Toasts ---------------- */

export function toast(message, { error = false, ms = 3600 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ---------------- Modal ---------------- */

let closeCurrentModal = null;

/**
 * Open a modal. `body` is html; `footer` is html. Resolves with whatever
 * `onSubmit` returns, or null if dismissed.
 */
export function modal({ title, body, footer, wide = false, onMount, onSubmit }) {
  closeCurrentModal?.();

  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = render(html`
      <div class="modal-backdrop" data-backdrop>
        <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
          <div class="modal-head">
            <h2>${title}</h2>
            <button class="ghost" data-close aria-label="Close">✕</button>
          </div>
          <form data-form>
            <div class="modal-body">${body}</div>
            <div class="modal-foot">${footer}</div>
          </form>
        </div>
      </div>
    `);

    const backdrop = root.querySelector('[data-backdrop]');
    const form = root.querySelector('[data-form]');

    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      closeCurrentModal = null;
      resolve(value);
    };
    closeCurrentModal = () => close(null);

    const onKey = (ev) => { if (ev.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) close(null); });
    root.querySelector('[data-close]').addEventListener('click', () => close(null));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const result = onSubmit ? await onSubmit(Object.fromEntries(new FormData(form)), root) : true;
        if (result !== undefined) close(result);
      } catch (err) {
        toast(err.message ?? 'Something went wrong', { error: true });
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    onMount?.(root, close);
    root.querySelector('input, textarea, select')?.focus();
  });
}

/** A yes/no confirmation. Resolves true only if confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return modal({
    title,
    body: html`<p style="margin:0">${message}</p>`,
    footer: html`
      <button type="button" data-close>Cancel</button>
      <button type="submit" class="${danger ? 'danger' : 'primary'}">${confirmLabel}</button>`,
    onSubmit: () => true,
  }).then((v) => v === true);
}

/* ---------------- Formatting ---------------- */

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Drop the year for dates in the current year -- it is just noise in a list.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function relative(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

export const statusPill = (s) => html`<span class="status" data-s="${s}">${s}</span>`;
