/**
 * Automated PayPal Checkout for an invoice.
 *
 * PayPal's HTTP is stubbed (no live account), so these prove the wiring: the
 * invoice shows a real Pay button when connected, starting a payment creates
 * an order for the invoice's exact amount and redirects to PayPal, and the
 * return only marks the invoice paid when PayPal reports COMPLETED AND the
 * captured amount and currency match to the penny. The money-safety checks
 * are the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_CLIENT_ID = 'test-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.PAYPAL_ENV = 'sandbox';

const { get, post, put, base, teardown } = await import('./helpers.js');
const { _resetToken } = await import('../server/lib/paypal.js');

/* Stub only PayPal's hosts; everything else (the app on 127.0.0.1) passes through. */
const realFetch = globalThis.fetch;
let capture = { status: 'COMPLETED', value: '650.00', currency: 'GBP', id: 'CAP-1' };
let orderCounter = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('paypal.com')) return realFetch(url, opts);
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  if (u.endsWith('/v1/oauth2/token')) return json({ access_token: 'A', expires_in: 3000 });
  if (u.endsWith('/v2/checkout/orders')) {
    const id = `ORDER-${++orderCounter}`;
    return json({ id, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
  }
  if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(u)) {
    return json({
      status: capture.status,
      purchase_units: [{ payments: { captures: [{
        id: capture.id, status: capture.status,
        amount: { value: capture.value, currency_code: capture.currency },
      }] } }],
    });
  }
  return json({ message: 'unexpected' }, 500);
};

async function makeInvoice(pounds = '650') {
  await put('/api/settings', { biz_name: 'Keylo Studios' });
  const c = (await post('/api/invoices/clients', { name: 'Pay Test Ltd' })).body.client;
  return (await post('/api/invoices', {
    client_id: c.id, lines: [{ description: 'Website', qty: 1, unit_pounds: pounds }],
  })).body.invoice;
}

const page = (token) => realFetch(`${base}/i/${token}`).then((r) => r.text());

test('a connected PayPal shows a real Pay button on the invoice', async () => {
  const inv = await makeInvoice();
  const html = await page(inv.token);
  assert.match(html, /Pay .*with PayPal/);
  assert.match(html, new RegExp(`action="/i/${inv.token}/pay/paypal"`), 'a form that posts back to us');
});

test('starting a payment creates an order and redirects to PayPal', async () => {
  _resetToken();
  const inv = await makeInvoice();
  const res = await realFetch(`${base}/i/${inv.token}/pay/paypal`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /paypal\.com\/checkoutnow\?token=ORDER-/);
  // The order id is remembered against the invoice for the return.
  const after = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.match(after.paypal_order_id, /^ORDER-/);
});

test('the return captures and marks paid when the amount matches', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/paypal`, { method: 'POST', redirect: 'manual' });
  const order = (await get(`/api/invoices/${inv.id}`)).body.invoice.paypal_order_id;
  capture = { status: 'COMPLETED', value: '650.00', currency: 'GBP', id: 'CAP-OK' };

  const res = await realFetch(`${base}/i/${inv.token}/paypal/return?token=${order}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const paid = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_method, 'paypal');
  assert.equal(paid.payment_ref, 'CAP-OK', 'the PayPal capture id is kept as the receipt');
});

test('a captured amount that does NOT match the invoice is refused', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/paypal`, { method: 'POST', redirect: 'manual' });
  const order = (await get(`/api/invoices/${inv.id}`)).body.invoice.paypal_order_id;
  capture = { status: 'COMPLETED', value: '5.00', currency: 'GBP', id: 'CAP-BAD' }; // underpaid

  await realFetch(`${base}/i/${inv.token}/paypal/return?token=${order}`, { redirect: 'manual' });
  const still = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.notEqual(still.status, 'paid', 'a mismatched amount must never mark it paid');
});

test('a return with an order id we did not issue is ignored', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/paypal`, { method: 'POST', redirect: 'manual' });
  capture = { status: 'COMPLETED', value: '650.00', currency: 'GBP', id: 'CAP-X' };
  // A forged order id that isn't the one stored on the invoice.
  await realFetch(`${base}/i/${inv.token}/paypal/return?token=ORDER-FORGED`, { redirect: 'manual' });
  const still = (await get(`/api/invoices/${inv.id}`)).body.invoice;
  assert.notEqual(still.status, 'paid');
});

test('an incomplete capture (client abandoned) does not mark paid', async () => {
  const inv = await makeInvoice('650');
  await realFetch(`${base}/i/${inv.token}/pay/paypal`, { method: 'POST', redirect: 'manual' });
  const order = (await get(`/api/invoices/${inv.id}`)).body.invoice.paypal_order_id;
  capture = { status: 'PAYER_ACTION_REQUIRED', value: '650.00', currency: 'GBP', id: 'CAP-N' };
  await realFetch(`${base}/i/${inv.token}/paypal/return?token=${order}`, { redirect: 'manual' });
  assert.notEqual((await get(`/api/invoices/${inv.id}`)).body.invoice.status, 'paid');
});

test.after(() => { globalThis.fetch = realFetch; teardown(); });
