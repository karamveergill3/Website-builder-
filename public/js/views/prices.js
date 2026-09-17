/* Prices: Karam's own price list, kept somewhere he can pull up on a call.
 *
 * Every number lives in one JSON blob under settings.price_list_json, so the
 * screen edits and reads in one go and nothing else in the app has to know the
 * shape. Defaults live below — the ones the research settled on for a UK sole
 * trader cold approach.
 */
import { api } from '../api.js';
import { html, mount, $, toast } from '../dom.js';

/**
 * The starting price list. Every number here was set by two rounds of 2026 UK
 * market research and the "yes-price/walk-away" reality check for a cold-called
 * sole trader — see the conversation transcript for the reasoning behind each.
 * These are defaults only; the moment Karam saves, his own numbers replace them.
 */
const DEFAULTS = {
  pages: {
    one_page: 300,
    extra_page_early: 75,      // 2nd through 5th
    extra_page_late: 100,      // 6th onwards
  },
  booking: {
    simple: 250,               // Fresha / Setmore / Calendly embed, configured
    full: 600,                 // WordPress plugin (Amelia / Bookly)
  },
  payments: {
    stripe: 200,               // Stripe Checkout, one product/service
    stripe_multiple: 300,      // Multiple products
    deposits: 150,             // Deposit taking on top of booking
    direct_debit: 200,         // GoCardless setup
  },
  accounts: {
    login: 400,                // Supabase/Clerk drop-in
    twofa_app: 75,             // TOTP (authenticator app)
    twofa_sms: 125,            // SMS codes
    social_login: 100,         // Google / Facebook OAuth
    portal: 500,               // See past jobs / invoices
  },
  extras: {
    gbp: 50,                   // Google Business Profile setup
    seo: 100,                  // Local SEO + schema markup
    newsletter: 75,            // Mailchimp signup form
    email: 40,                 // Custom domain email (karam@)
    logo_simple: 150,          // Simple wordmark
    logo_mark: 300,            // With icon
    photo_editing_extra: 30,   // Per extra batch of 10 photos
    quote_form: 150,           // Multi-step quote form
    extra_revision: 75,        // Per extra revision round
  },
  monthly: {
    keep_it_live: 12,          // Hosting, SSL, backups, 2 changes a year
    looked_after: 29,          // Above + 2 changes a month same day
    booking_payments: 45,      // Full care for a booking/payments site
  },
};

/**
 * The rows shown on screen, in reading order. Each row is a section, a label,
 * a settings path into the JSON, and a short "for" note that reads as the
 * price's job description rather than as documentation.
 */
const ROWS = [
  { section: 'Pages', rows: [
    ['pages.one_page',         'One page',                       '£'],
    ['pages.extra_page_early', 'Extra page (2nd–5th)',           '£'],
    ['pages.extra_page_late',  'Extra page (6th onwards)',       '£'],
  ]},
  { section: 'Booking', rows: [
    ['booking.simple', 'Simple booking (Fresha / Setmore)', '£'],
    ['booking.full',   'Full booking system (WordPress)',    '£'],
  ]},
  { section: 'Payments', rows: [
    ['payments.stripe',          'Card payments (one product)',  '£'],
    ['payments.stripe_multiple', 'Card payments (many products)','£'],
    ['payments.deposits',        'Deposit taking',               '£'],
    ['payments.direct_debit',    'Direct Debit (GoCardless)',    '£'],
  ]},
  { section: 'Customer accounts', rows: [
    ['accounts.login',        'Login + sign-up',        '£'],
    ['accounts.social_login', 'Google / Facebook login','£'],
    ['accounts.twofa_app',    '2FA (authenticator app)','£'],
    ['accounts.twofa_sms',    '2FA (SMS codes)',        '£'],
    ['accounts.portal',       'Client portal',          '£'],
  ]},
  { section: 'Extras', rows: [
    ['extras.gbp',                 'Google Business Profile', '£'],
    ['extras.seo',                 'Local SEO + schema',      '£'],
    ['extras.quote_form',          'Multi-step quote form',   '£'],
    ['extras.newsletter',          'Newsletter signup',       '£'],
    ['extras.email',               'Custom domain email',     '£'],
    ['extras.logo_simple',         'Logo — simple wordmark',  '£'],
    ['extras.logo_mark',           'Logo — with icon',        '£'],
    ['extras.photo_editing_extra', 'Photo editing — 10 more', '£'],
    ['extras.extra_revision',      'Extra revision round',    '£'],
  ]},
  { section: 'Monthly plans', rows: [
    ['monthly.keep_it_live',     'Keep it live',       '£/mo'],
    ['monthly.looked_after',     'Looked after',       '£/mo'],
    ['monthly.booking_payments', 'Booking & payments', '£/mo'],
  ]},
];

/** Read a dotted path off a nested object, safe against missing branches. */
function pluck(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Write a dotted path into a nested object, creating branches as it goes. */
function poke(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => (o[k] ??= {}), obj);
  parent[last] = value;
}

/** Merge a shallow patch over the defaults so partial saves keep working. */
function mergePrices(saved) {
  const out = structuredClone(DEFAULTS);
  if (!saved || typeof saved !== 'object') return out;
  const walk = (dst, src) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        dst[k] ??= {};
        walk(dst[k], v);
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        dst[k] = v;
      }
    }
  };
  walk(out, saved);
  return out;
}

/** Two-column examples derived from the current numbers, so the totals move
 *  with the inputs. The point of a price list on a call is to talk in
 *  named packages, so the examples matter more than the individual rows. */
function examples(p) {
  const fivePages = p.pages.one_page + 4 * p.pages.extra_page_early;
  return [
    { name: 'Barber',             what: '1 page + booking',                              total: p.pages.one_page + p.booking.simple + p.extras.gbp },
    { name: 'Plumber',            what: '5 pages + quote form + local SEO',              total: fivePages + p.extras.quote_form + p.extras.seo },
    { name: 'Personal trainer',   what: '1 page + booking + Stripe',                     total: p.pages.one_page + p.booking.simple + p.payments.stripe },
    { name: 'Full works',         what: '5 pages + booking + login + 2FA + payments',    total: fivePages + p.booking.simple + p.accounts.login + p.accounts.twofa_app + p.payments.stripe + p.payments.deposits },
  ];
}

export default async function pricesView(root) {
  const settings = await api.settings.get();
  let stored = null;
  try { stored = JSON.parse(settings.settings.price_list_json ?? 'null'); } catch { /* invalid JSON, use defaults */ }
  const prices = mergePrices(stored);

  const money = (n) => (Number.isFinite(n) ? `£${Number(n).toLocaleString('en-GB')}` : '—');

  const drawExamples = () => examples(prices).map((e) => html`
    <tr>
      <td class="c-name"><b>${e.name}</b><br><span class="meta">${e.what}</span></td>
      <td class="num"><b>${money(e.total)}</b></td>
    </tr>`);

  const drawRow = ([path, label, unit]) => {
    const value = pluck(prices, path);
    return html`
      <div class="f price-row">
        <label for="p-${path.replace(/\./g, '-')}">${label}</label>
        <div class="price-input">
          <input id="p-${path.replace(/\./g, '-')}"
                 data-path="${path}" type="number" min="0" step="1"
                 value="${value ?? 0}" inputmode="numeric" autocomplete="off">
          <span class="meta">${unit}</span>
        </div>
      </div>`;
  };

  mount(root, html`
    <div class="bar">
      <h2>Prices</h2>
      <div class="grow"></div>
      <span class="meta">Your own reference. Nothing here goes to prospects automatically.</span>
    </div>

    <form id="prices">
      <div class="cols">
        <div>
          ${ROWS.slice(0, 4).map((s) => html`
            <div class="panel">
              <div class="panel-hd"><h3>${s.section}</h3></div>
              <div class="panel-bd">${s.rows.map(drawRow)}</div>
            </div>`)}
        </div>
        <div>
          ${ROWS.slice(4).map((s) => html`
            <div class="panel">
              <div class="panel-hd"><h3>${s.section}</h3></div>
              <div class="panel-bd">${s.rows.map(drawRow)}</div>
            </div>`)}

          <div class="panel">
            <div class="panel-hd"><h3>Quick examples</h3>
              <span class="meta grow" style="text-align:right">Totals update on save</span>
            </div>
            <div class="panel-bd">
              <table class="rows"><tbody id="p-examples">${drawExamples()}</tbody></table>
            </div>
          </div>
        </div>
      </div>

      <div class="bar" style="margin-top:14px">
        <button type="submit" class="primary">Save prices</button>
        <button type="button" class="mini ghost" data-act="reset">Reset to defaults</button>
        <div class="grow"></div>
        <span class="meta">Last saved: <span id="p-saved">${settings.settings.price_list_json ? 'yes' : 'never'}</span></span>
      </div>
    </form>

    <style>
      .price-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--rule); }
      .price-row:last-child { border-bottom: 0; }
      .price-row label { flex: 1; margin: 0; font-weight: 400; }
      .price-input { display: flex; align-items: center; gap: 6px; }
      .price-input input { width: 90px; text-align: right; }
      .price-input .meta { min-width: 42px; }
      .cols > div { display: flex; flex-direction: column; gap: 14px; }
    </style>
  `);

  const form = $('#prices', root);

  const refreshExamples = () => {
    // Read current input values back into the object so the examples reflect
    // whatever's on screen right now, before the user has hit save.
    const live = mergePrices(prices);
    for (const el of form.querySelectorAll('input[data-path]')) {
      const n = Number(el.value);
      if (Number.isFinite(n)) poke(live, el.dataset.path, n);
    }
    const box = $('#p-examples', root);
    if (box) {
      box.innerHTML = '';
      for (const e of examples(live)) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="c-name"><b>${e.name}</b><br><span class="meta">${e.what}</span></td>`
          + `<td class="num"><b>${money(e.total)}</b></td>`;
        box.appendChild(tr);
      }
    }
  };

  form.addEventListener('input', refreshExamples);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const next = structuredClone(prices);
    for (const el of form.querySelectorAll('input[data-path]')) {
      const n = Number(el.value);
      if (Number.isFinite(n) && n >= 0) poke(next, el.dataset.path, n);
    }
    try {
      await api.settings.save({ price_list_json: JSON.stringify(next) });
      Object.assign(prices, next);
      const saved = $('#p-saved', root);
      if (saved) saved.textContent = new Date().toLocaleString('en-GB');
      toast('Saved');
    } catch (err) {
      toast(err.message ?? 'Save failed', { error: true });
    }
  });

  form.querySelector('[data-act="reset"]').addEventListener('click', () => {
    for (const el of form.querySelectorAll('input[data-path]')) {
      const def = pluck(DEFAULTS, el.dataset.path);
      if (Number.isFinite(def)) el.value = def;
    }
    refreshExamples();
    toast('Restored the shipped numbers. Click Save to keep them.');
  });
}
