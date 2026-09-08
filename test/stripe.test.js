/**
 * Automated Stripe Checkout for an invoice (card / Klarna / Clearpay).
 *
 * Stripe's HTTP is stubbed (no live account), so these prove the wiring: the
 * invoice shows a real Pay button when connected, starting a payment creates a
 * Checkout session for the invoice's exact amount and redirects to Stripe, and
 * the return only marks the invoice paid when Stripe reports the session PAID
 * AND the amount and currency match to the penny. The money-safety checks are
 * the point — the same guarantees as the PayPal path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_SECRET_KEY = 'sk_test_x';

const { get, post, put, base, teardown } = await import('./helpers.js');

/* Stub only Stripe's host; everything else (the app on 127.0.0.1) passes through. */
const realFetch = globalThis.fetch;
let session = { payment_status: 'paid', amount_total: 65000, currency: 'gbp', payment_intent: 'pi_1', status: 'complete' };
let sessionCounter = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('api.stripe.com')) return realFetch(url, opts);
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  if (u.endsWith('/v1/checkout/sessions') && (opts.method ?? 'GET') === 'POST') {
    const id = `cs_${++sessionCounter}`;
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (/\/v1\/checkout\/sessions\/[^/]+$/.test(u)) {
    return json({ ...session });
  }
  return json({ error: { message: 'unexpected' } }, 500);
};

async function makeInvoice(pounds = '650') {
  await put('/api/settings', { biz_name: 'Keylo Studios' });
  const c = (await post('/api/invoices/clients', { name: 'Stripe Test Ltd' })).body.client;
  return (await post('/api/invoices', {
    client_id: c.id, lines: [{ description: 'Website', qty: 1, unit_pounds: pounds }],
  })).body.invoice;
}

const page = (token) => realFetch(`${base}/i/${token}`).then((r) => r.text());

test('a connected Stripe shows a real Pay button on the invoice', async () => {
  const inv = await makeInvoice();
  const html = await page(inv.token);
  assert.match(html, /Pay .*by card/);
  assert.match(html, new RegExp(`action="/i/${inv.token}/pay/stripe"`), 'a form that posts back to us');
});

test('starting a payment creates a session and redirects to Stripe', async () => {
  const inv = await makeInvoice();
  const res = await realFetch(`${base}/i/${inv.token}/pay/stripe`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /checkout\.stripe\.com\/c\/pay\/cs_/);
  const after = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.match(after.stripe_session_id, /^cs_/, 'the session id is remembered against the invoice');
});

test('the return marks paid when the amount matches', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/stripe`, { method: 'POST', redirect: 'manual' });
  const sid = (await get(`/api/invoices/${inv.id}`)).body.invoice.stripe_session_id;
  session = { payment_status: 'paid', amount_total: 65000, currency: 'gbp', payment_intent: 'pi_OK', status: 'complete' };

  const res = await realFetch(`${base}/i/${inv.token}/stripe/return?session_id=${sid}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const paid = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_method, 'stripe');
  assert.equal(paid.payment_ref, 'pi_OK', 'the Stripe payment id is kept as the receipt');
});

test('an amount that does NOT match the invoice is refused', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/stripe`, { method: 'POST', redirect: 'manual' });
  const sid = (await get(`/api/invoices/${inv.id}`)).body.invoice.stripe_session_id;
  session = { payment_status: 'paid', amount_total: 500, currency: 'gbp', payment_intent: 'pi_BAD', status: 'complete' }; // underpaid

  await realFetch(`${base}/i/${inv.token}/stripe/return?session_id=${sid}`, { redirect: 'manual' });
  const still = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.notEqual(still.status, 'paid', 'a mismatched amount must never mark it paid');
});

test('a return with a session id we did not issue is ignored', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/stripe`, { method: 'POST', redirect: 'manual' });
  session = { payment_status: 'paid', amount_total: 65000, currency: 'gbp', payment_intent: 'pi_X', status: 'complete' };
  await realFetch(`${base}/i/${inv.token}/stripe/return?session_id=cs_FORGED`, { redirect: 'manual' });
  const still = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.notEqual(still.status, 'paid');
});

test('an unpaid session (client abandoned) does not mark paid', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/stripe`, { method: 'POST', redirect: 'manual' });
  const sid = (await get(`/api/invoices/${inv.id}`)).body.invoice.stripe_session_id;
  session = { payment_status: 'unpaid', amount_total: 65000, currency: 'gbp', payment_intent: null, status: 'open' };
  await realFetch(`${base}/i/${inv.token}/stripe/return?session_id=${sid}`, { redirect: 'manual' });
  assert.notEqual((await get(`/api/invoices/${inv.id}`)).body.invoice.status, 'paid');
});

test.after(() => { globalThis.fetch = realFetch; teardown(); });
