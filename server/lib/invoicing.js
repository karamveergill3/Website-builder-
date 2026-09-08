/**
 * Invoices, in a way that stands up as a real financial record.
 *
 * A few decisions that matter:
 *
 *   - Money is stored as integer PENCE, never a float. £49.99 is 4999. Floats
 *     lose pennies over a VAT calculation and an invoice that is a penny out
 *     is not a document anyone should send.
 *
 *   - Invoice numbers are sequential and gap-free, drawn from a single counter
 *     in the settings table inside the same transaction as the insert, so two
 *     reps on the shared hub can't mint the same number.
 *
 *   - VAT is driven by whether a VAT number is set in Settings. A business
 *     that is not VAT-registered must NOT show VAT; one that is must show its
 *     number and the VAT line. Getting this wrong is a legal problem, not a
 *     cosmetic one, so it keys off the one place the number lives.
 *
 *   - A build is one payment. The client may choose to pay it monthly through
 *     Klarna or PayPal Pay Later, but in that case the provider pays Keylo in
 *     full and collects the monthly instalments from the client — so there is
 *     nothing per-month for Keylo to track. Maintenance is the opposite: a
 *     genuine recurring monthly charge Keylo bills itself.
 */
import { randomBytes } from 'node:crypto';
import { db, getSetting, setSetting, getSettings } from '../db.js';
import { nowIso } from './http.js';
import { esc, safeUrl } from './site-builder.js';
import { configured as paypalConfigured } from './paypal.js';
import { configured as stripeConfigured } from './stripe.js';

/* ------------------------------------------------------------------ money */

/** Pence → "£1,234.50". Always two decimals, thousands separated. */
export function money(pence, currency = 'GBP') {
  const n = Math.round(Number(pence) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}

/** "49.99" or 49.99 → 4999 pence. Rejects nonsense rather than storing NaN. */
export function toPence(pounds) {
  const n = Number(String(pounds ?? '').replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw badReq('Amount must be a positive number.');
  return Math.round(n * 100);
}

/* -------------------------------------------------------------- VAT + totals */

/**
 * The VAT rate to apply, as a whole-number percent. Zero unless a VAT number
 * is recorded in Settings — an unregistered business charges no VAT and must
 * not imply it does. The rate itself is overridable (invoice_vat_rate) for the
 * rare non-20% case, but defaults to the UK standard when a number is present.
 */
export function vatRate() {
  const registered = String(getSetting('biz_vat_number', '') ?? '').trim() !== '';
  if (!registered) return 0;
  const r = Number(getSetting('invoice_vat_rate', '20'));
  return Number.isFinite(r) && r >= 0 ? r : 20;
}

/** Sum lines and apply VAT, all in pence. Lines are {qty, unit_pence}. */
export function totals(lines, rate = vatRate()) {
  const subtotal = lines.reduce((n, l) => n + Math.round(l.qty * l.unit_pence), 0);
  const vat = Math.round(subtotal * (rate / 100));
  return { subtotal_pence: subtotal, vat_pence: vat, total_pence: subtotal + vat, vat_rate: rate };
}

/* ------------------------------------------------------------ numbering */

/**
 * The next invoice number, e.g. "KEY-0007", advancing a counter held in the
 * settings table. Must be called inside a transaction with the insert so the
 * number can't be handed to two invoices at once.
 */
export function nextNumber() {
  const prefix = String(getSetting('invoice_prefix', 'INV') || 'INV').trim();
  const seq = Number(getSetting('invoice_seq', '0')) + 1;
  setSetting('invoice_seq', String(seq));
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

/* ---------------------------------------------------------------- clients */

export function createClient({ name, contact_name, email, phone, address, lead_id } = {}) {
  const n = String(name ?? '').trim();
  if (!n) throw badReq('A client business name is required.');
  const info = db.prepare(
    `INSERT INTO clients (name, contact_name, email, phone, address, lead_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(n, s(contact_name), s(email), s(phone), s(address), lead_id ?? null, nowIso());
  return getClient(Number(info.lastInsertRowid));
}

export const getClient = (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id) ?? null;
export const listClients = () =>
  db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();

/* --------------------------------------------------------------- invoices */

/**
 * Create an invoice with its line items, in one transaction so the number,
 * the totals and the lines can never disagree.
 *
 * `lines` are [{ description, qty, unit_pence }]. `kind` is 'build' or
 * 'maintenance'. Returns the full invoice with lines and client attached.
 */
export function createInvoice({ client_id, kind = 'build', lines = [], notes, due_at, created_by } = {}) {
  if (!getClient(client_id)) throw badReq('Unknown client.');
  const clean = normaliseLines(lines);
  if (!clean.length) throw badReq('An invoice needs at least one line.');
  if (!['build', 'maintenance'].includes(kind)) throw badReq('Unknown invoice kind.');

  const t = totals(clean);
  const now = nowIso();

  const make = db.transaction(() => {
    const number = nextNumber();
    const info = db.prepare(
      `INSERT INTO invoices
         (number, client_id, kind, status, currency,
          subtotal_pence, vat_pence, total_pence, vat_rate,
          issued_at, due_at, notes, token, reference, created_at, created_by)
       VALUES (@number, @client_id, @kind, 'draft', 'GBP',
          @subtotal, @vat, @total, @rate,
          NULL, @due, @notes, @token, @number, @now, @created_by)`
    ).run({
      number,
      client_id,
      kind,
      subtotal: t.subtotal_pence,
      vat: t.vat_pence,
      total: t.total_pence,
      rate: t.vat_rate,
      due: s(due_at) ?? tomorrowFrom(now),
      notes: s(notes),
      token: randomBytes(16).toString('hex'),
      now,
      created_by: created_by ?? null,
    });
    const id = Number(info.lastInsertRowid);
    const insLine = db.prepare(
      `INSERT INTO invoice_lines (invoice_id, description, qty, unit_pence, position)
       VALUES (?, ?, ?, ?, ?)`
    );
    clean.forEach((l, i) => insLine.run(id, l.description, l.qty, l.unit_pence, i));
    return id;
  });
  return getInvoice(make());
}

export function getInvoice(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  return inv ? withParts(inv) : null;
}

export function getInvoiceByToken(token) {
  const inv = db.prepare('SELECT * FROM invoices WHERE token = ?').get(String(token ?? ''));
  return inv ? withParts(inv) : null;
}

export function listInvoices({ status, client_id } = {}) {
  const where = [];
  const params = {};
  if (status) { where.push('i.status = @status'); params.status = status; }
  if (client_id) { where.push('i.client_id = @client_id'); params.client_id = client_id; }
  return db.prepare(
    `SELECT i.* FROM invoices i
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY i.created_at DESC, i.id DESC`
  ).all(params).map(withParts);
}

/** Mark an invoice issued/sent (stamps issued_at the first time). */
export function markSent(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFoundErr('Invoice not found.');
  db.prepare(
    "UPDATE invoices SET status = 'sent', issued_at = COALESCE(issued_at, ?) WHERE id = ?"
  ).run(nowIso(), id);
  return getInvoice(id);
}

/** Record a payment. method ∈ full | bank | paypal | klarna | stripe. ref is a
 * receipt reference (e.g. the PayPal capture id or Stripe payment id). */
export function markPaid(id, method, ref = null) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFoundErr('Invoice not found.');
  const m = ['full', 'bank', 'paypal', 'klarna', 'stripe'].includes(method) ? method : 'other';
  db.prepare(
    "UPDATE invoices SET status = 'paid', paid_at = ?, paid_method = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?"
  ).run(nowIso(), m, ref, id);
  return getInvoice(id);
}

/** Remember the PayPal order created for an invoice, so the return redirect
 * can be matched back to it. */
export function setPayPalOrder(id, orderId) {
  db.prepare('UPDATE invoices SET paypal_order_id = ? WHERE id = ?').run(String(orderId), id);
  return getInvoice(id);
}

/** Remember the Stripe Checkout session created for an invoice, so its return
 * redirect can be matched back to it. */
export function setStripeSession(id, sessionId) {
  db.prepare('UPDATE invoices SET stripe_session_id = ? WHERE id = ?').run(String(sessionId), id);
  return getInvoice(id);
}

export function voidInvoice(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFoundErr('Invoice not found.');
  db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(id);
  return getInvoice(id);
}

/* ------------------------------------------------------- maintenance plans */

export function createMaintenancePlan({ client_id, monthly_pounds, description, started_on } = {}) {
  if (!getClient(client_id)) throw badReq('Unknown client.');
  const pence = toPence(monthly_pounds);
  if (pence <= 0) throw badReq('A monthly amount is required.');
  const start = s(started_on) ?? nowIso().slice(0, 10);
  const info = db.prepare(
    `INSERT INTO maintenance_plans
       (client_id, monthly_pence, description, active, started_on, next_due_on, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(client_id, pence, s(description), start, start, nowIso());
  return getPlan(Number(info.lastInsertRowid));
}

export const getPlan = (id) => db.prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(id) ?? null;
export const listPlans = () => db.prepare(
  `SELECT p.*, c.name AS client_name FROM maintenance_plans p
   JOIN clients c ON c.id = p.client_id ORDER BY p.active DESC, c.name COLLATE NOCASE`
).all();

export function setPlanActive(id, active) {
  db.prepare('UPDATE maintenance_plans SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getPlan(id);
}

/**
 * Raise this month's maintenance invoice for a plan and advance next_due_on by
 * a month. Idempotent-ish: refuses if the plan already has an invoice dated in
 * the current due month, so double-clicking "bill" doesn't double-charge.
 */
export function billPlan(id, { created_by } = {}) {
  const plan = getPlan(id);
  if (!plan) throw notFoundErr('Plan not found.');
  if (!plan.active) throw badReq('This plan is paused.');

  // Dedupe on the actual calendar month the bill is raised in, so clicking
  // "bill" twice — or two reps both doing it — cannot charge one client twice
  // in the same month. The plan's next_due_on is only a display hint.
  const today = nowIso().slice(0, 10);
  const monthTag = today.slice(0, 7); // YYYY-MM
  const already = db.prepare(
    `SELECT 1 FROM invoices
      WHERE client_id = ? AND kind = 'maintenance' AND substr(created_at, 1, 7) = ?`
  ).get(plan.client_id, monthTag);
  if (already) throw badReq(`Already billed this client for ${monthTag}.`);

  const inv = createInvoice({
    client_id: plan.client_id,
    kind: 'maintenance',
    due_at: today,
    notes: plan.description ?? 'Website maintenance & hosting',
    lines: [{ description: plan.description ?? 'Website maintenance & hosting',
              qty: 1, unit_pence: plan.monthly_pence }],
    created_by,
  });
  db.prepare('UPDATE maintenance_plans SET next_due_on = ? WHERE id = ?')
    .run(addMonth(today), id);
  return inv;
}

/* ------------------------------------------------------------------ helpers */

const s = (v) => { const t = String(v ?? '').trim(); return t || null; };

function normaliseLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => ({
      description: String(l.description ?? '').trim(),
      qty: Math.max(1, Math.round(Number(l.qty) || 1)),
      unit_pence: l.unit_pence != null ? Math.round(Number(l.unit_pence) || 0) : toPence(l.unit_pounds),
    }))
    .filter((l) => l.description && l.unit_pence >= 0);
}

function withParts(inv) {
  const lines = db.prepare(
    'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id'
  ).all(inv.id);
  const client = getClient(inv.client_id);
  return { ...inv, lines, client };
}

/** First of next month if the date is a month-end-safe add. Keeps the day. */
function addMonth(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // If the next month is shorter (e.g. 31 Jan → Feb), setUTCMonth overflows;
  // pull back to the last day of the intended month.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** The day after a timestamp, as YYYY-MM-DD. The default due date: a build is
 * payable within 24 hours unless the owner sets a later date on the invoice. */
function tomorrowFrom(iso) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function badReq(message) { const e = new Error(message); e.status = 400; return e; }
function notFoundErr(message) { const e = new Error(message); e.status = 404; return e; }

/* ---------------------------------------------------- the invoice document */

const day = (iso) => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Which ways to pay are actually configured, so we never show an empty box. */
export function paymentOptions(settings = getSettings()) {
  const v = (k) => String(settings[k] ?? '').trim();
  const bank = v('pay_bank_name') && v('pay_bank_account')
    ? { name: v('pay_bank_name'), sortcode: v('pay_bank_sortcode'), account: v('pay_bank_account') }
    : null;
  return { bank, paypal: v('pay_paypal_link') || null, klarna: v('pay_klarna_note') || null };
}

/**
 * The client-facing invoice, as a self-contained HTML page. No script, inline
 * CSS only, so it renders under the same locked-down CSP as a mockup and can
 * be printed to PDF straight from the browser. Everything variable is escaped:
 * a client or business name is untrusted text.
 */
export function renderInvoicePage(inv, settings = getSettings()) {
  const v = (k) => String(settings[k] ?? '').trim();
  const pay = paymentOptions(settings);
  const isPaid = inv.status === 'paid';
  const isBuild = inv.kind === 'build';

  const bizName = v('biz_name') || 'Your business';
  const lines = inv.lines.map((l) => `
      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty}</td>
        <td class="num">${money(l.unit_pence, inv.currency)}</td>
        <td class="num">${money(l.qty * l.unit_pence, inv.currency)}</td>
      </tr>`).join('');

  const vatRow = inv.vat_rate > 0 ? `
      <tr><td class="lbl">VAT (${inv.vat_rate}%)</td><td class="num">${money(inv.vat_pence, inv.currency)}</td></tr>` : '';

  // How to pay. A build may be paid in full or spread monthly via PayPal /
  // Klarna (they pay us in full, the client repays them); maintenance is a
  // straight monthly charge.
  const payBlocks = [];
  // Live card / Klarna / Clearpay when Stripe is connected: a form that posts
  // back to us, we create the Checkout session server-side and redirect to
  // Stripe's hosted page. Which methods appear (card, Klarna Pay in 3, Clearpay
  // Pay in 4, wallets) is set in the Stripe Dashboard, not here. No script, so
  // it works under the locked-down CSP (which allows form-action 'self').
  if (stripeConfigured()) {
    payBlocks.push(`
      <div class="pay">
        <h4>Card${isBuild ? ', Klarna or Clearpay' : ''}</h4>
        <form method="POST" action="/i/${esc(inv.token)}/pay/stripe">
          <button class="btn" type="submit">Pay ${money(inv.total_pence, inv.currency)} by card${isBuild ? ' or instalments' : ''}</button>
        </form>
        ${isBuild ? '<p class="fine">Pay by debit or credit card, or choose Klarna (Pay in 3) or Clearpay (Pay in 4) at checkout to spread the cost. Either way it settles the invoice in full.</p>' : ''}
      </div>`);
  }
  // Live "Pay now" when PayPal is connected: a form that posts back to us, we
  // create the order server-side and redirect to PayPal. No script, so it
  // works under the locked-down CSP (which allows form-action 'self'). Falls
  // back to a plain PayPal link when only that is configured.
  if (paypalConfigured()) {
    payBlocks.push(`
      <div class="pay">
        <h4>Card or PayPal${isBuild ? ', pay now or spread it monthly' : ''}</h4>
        <form method="POST" action="/i/${esc(inv.token)}/pay/paypal">
          <button class="btn" type="submit">Pay ${money(inv.total_pence, inv.currency)} with PayPal</button>
        </form>
        ${isBuild ? '<p class="fine">At checkout you can pay the full amount or choose PayPal Pay in 3 to spread it over monthly instalments, and either way it settles the invoice in full.</p>' : ''}
      </div>`);
  } else if (pay.paypal) {
    payBlocks.push(`
      <div class="pay">
        <h4>Card or PayPal${isBuild ? ', pay now or spread it monthly' : ''}</h4>
        <p><a class="btn" href="${safeUrl(pay.paypal)}" target="_blank" rel="noopener">Pay ${money(inv.total_pence, inv.currency)} with PayPal</a></p>
        ${isBuild ? '<p class="fine">At checkout you can pay the full amount or choose PayPal Pay in 3 to spread it over monthly instalments, and either way it settles the invoice in full.</p>' : ''}
      </div>`);
  }
  if (pay.klarna && isBuild) {
    payBlocks.push(`
      <div class="pay">
        <h4>Klarna — pay monthly</h4>
        <p>${esc(pay.klarna)}</p>
      </div>`);
  }
  if (pay.bank) {
    payBlocks.push(`
      <div class="pay">
        <h4>Bank transfer</h4>
        <table class="bank">
          <tr><td>Account name</td><td>${esc(pay.bank.name)}</td></tr>
          ${pay.bank.sortcode ? `<tr><td>Sort code</td><td>${esc(pay.bank.sortcode)}</td></tr>` : ''}
          <tr><td>Account number</td><td>${esc(pay.bank.account)}</td></tr>
          <tr><td>Reference</td><td><b>${esc(inv.reference)}</b></td></tr>
        </table>
        <p class="fine">Please quote the reference so we can match your payment.</p>
      </div>`);
  }

  const payment = isPaid
    ? '<div class="paid-banner">Paid — thank you.</div>'
    : (payBlocks.length
        ? `<div class="pays"><h3>How to pay</h3>${payBlocks.join('')}</div>`
        : '');

  return `<!doctype html>
<html lang="en-GB"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(inv.number)} — ${esc(bizName)}</title>
<style>
  :root { --ink:#1a2620; --muted:#6b756e; --line:#e2e0d5; --green:#1d4633; --paper:#faf9f3; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f0efe7; color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .sheet { max-width:760px; margin:24px auto; background:var(--paper); padding:44px;
    border:1px solid var(--line); border-radius:10px; }
  .top { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; }
  .top h1 { font-size:1.6rem; margin:0 0 4px; letter-spacing:.5px; }
  .biz { font-weight:600; font-size:1.05rem; }
  .muted { color:var(--muted); font-size:.85rem; white-space:pre-line; }
  .meta { text-align:right; }
  .meta .num { font-size:1.5rem; font-weight:700; color:var(--green); }
  .parties { display:flex; justify-content:space-between; gap:24px; margin:28px 0 8px; flex-wrap:wrap; }
  .parties h4 { margin:0 0 4px; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  table { width:100%; border-collapse:collapse; }
  .items { margin-top:20px; }
  .items th { text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em;
    color:var(--muted); border-bottom:2px solid var(--line); padding:8px 6px; }
  .items td { padding:10px 6px; border-bottom:1px solid var(--line); }
  .num { text-align:right; white-space:nowrap; }
  .totals { margin:14px 0 0 auto; width:280px; }
  .totals td { padding:6px 6px; }
  .totals .lbl { color:var(--muted); }
  .totals .grand td { border-top:2px solid var(--line); font-weight:700; font-size:1.1rem; padding-top:10px; }
  .pays { margin-top:32px; border-top:1px solid var(--line); padding-top:20px; }
  .pays h3 { margin:0 0 12px; }
  .pay { margin-bottom:18px; }
  .pay h4 { margin:0 0 6px; }
  .btn { display:inline-block; background:var(--green); color:#fff; text-decoration:none;
    padding:11px 20px; border-radius:8px; font-weight:600; }
  .bank td { padding:3px 14px 3px 0; }
  .bank td:first-child { color:var(--muted); }
  .fine { color:var(--muted); font-size:.82rem; }
  .paid-banner { margin-top:28px; background:#e7f2ea; color:var(--green); font-weight:700;
    text-align:center; padding:14px; border-radius:8px; }
  .terms { margin-top:28px; color:var(--muted); font-size:.82rem; border-top:1px solid var(--line); padding-top:14px; white-space:pre-line; }
  @media print { body { background:#fff; } .sheet { border:0; margin:0; max-width:none; } }
</style></head>
<body>
  <div class="sheet">
    <div class="top">
      <div>
        <div class="biz">${esc(bizName)}</div>
        <div class="muted">${esc([v('biz_address')].filter(Boolean).join('\n'))}</div>
        <div class="muted">${esc([v('biz_email'), v('biz_phone'), v('biz_website')].filter(Boolean).join(' · '))}</div>
        <div class="muted">${esc([
          v('biz_company_number') && `Company no. ${v('biz_company_number')}`,
          v('biz_vat_number') && `VAT ${v('biz_vat_number')}`,
        ].filter(Boolean).join('  ·  '))}</div>
      </div>
      <div class="meta">
        <h1>INVOICE</h1>
        <div class="num">${esc(inv.number)}</div>
        <div class="muted">Issued ${esc(day(inv.issued_at ?? inv.created_at))}</div>
        ${inv.due_at ? `<div class="muted">Due ${esc(day(inv.due_at))}</div>` : ''}
      </div>
    </div>

    <div class="parties">
      <div>
        <h4>Billed to</h4>
        <div class="biz">${esc(inv.client?.name ?? '')}</div>
        <div class="muted">${esc([
          inv.client?.contact_name, inv.client?.address, inv.client?.email, inv.client?.phone,
        ].filter(Boolean).join('\n'))}</div>
      </div>
      <div class="meta">
        <h4>${isBuild ? 'Website build' : 'Website maintenance'}</h4>
        ${inv.notes ? `<div class="muted">${esc(inv.notes)}</div>` : ''}
      </div>
    </div>

    <table class="items">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
      <tbody>${lines}</tbody>
    </table>

    <table class="totals">
      <tr><td class="lbl">Subtotal</td><td class="num">${money(inv.subtotal_pence, inv.currency)}</td></tr>
      ${vatRow}
      <tr class="grand"><td>Total</td><td class="num">${money(inv.total_pence, inv.currency)}</td></tr>
    </table>

    ${payment}

    <div class="terms">${esc([
      v('invoice_terms') || 'Payment is due within 24 hours of the invoice date.',
      v('invoice_footer'),
    ].filter(Boolean).join('\n\n'))}</div>
  </div>
</body></html>`;
}
