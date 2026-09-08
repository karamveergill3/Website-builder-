/**
 * Invoicing — the money has to be exactly right.
 *
 * Amounts are integer pence, numbers are sequential and gap-free, VAT shows
 * only when a VAT number is set, and a build is one payment while maintenance
 * is a recurring monthly charge. These test that, plus the client-facing page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, del, put, base, teardown } = await import('./helpers.js');
const { money, toPence } = await import('../server/lib/invoicing.js');

async function client(name = 'Bloom Nails Ltd') {
  return (await post('/api/invoices/clients', { name, email: 'hi@bloom.example' })).body.client;
}

/* ------------------------------------------------------------------ money */

test('money formats pence as pounds, and toPence is exact', () => {
  assert.equal(money(4999), '£49.99');
  assert.equal(money(120000), '£1,200.00');
  assert.equal(toPence('49.99'), 4999);
  assert.equal(toPence('£1,200'), 120000);
  assert.throws(() => toPence('-5'));
});

/* --------------------------------------------------------------- invoices */

test('an invoice totals its lines exactly, numbered and tokened', async () => {
  await put('/api/settings', { biz_vat_number: '' }); // not VAT registered
  const c = await client();
  const res = await post('/api/invoices', {
    client_id: c.id, kind: 'build',
    lines: [
      { description: 'One-page website', qty: 1, unit_pounds: '600' },
      { description: 'Extra photos', qty: 2, unit_pounds: '25' },
    ],
    notes: 'Website build',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const inv = res.body.invoice;
  assert.equal(inv.subtotal_pence, 65000, '600 + 2×25');
  assert.equal(inv.vat_pence, 0, 'not VAT registered');
  assert.equal(inv.total_pence, 65000);
  assert.match(inv.number, /^INV-\d{4}$/);
  assert.equal(inv.reference, inv.number, 'the bank reference is the number');
  assert.ok(inv.token && inv.token.length >= 24, 'has an unguessable link token');
  assert.equal(inv.status, 'draft');
});

test('invoice numbers are sequential and never reused', async () => {
  const c = await client();
  const a = (await post('/api/invoices', { client_id: c.id, lines: [{ description: 'x', qty: 1, unit_pounds: '10' }] })).body.invoice;
  const b = (await post('/api/invoices', { client_id: c.id, lines: [{ description: 'y', qty: 1, unit_pounds: '10' }] })).body.invoice;
  const na = Number(a.number.split('-')[1]);
  const nb = Number(b.number.split('-')[1]);
  assert.equal(nb, na + 1, 'the next number is one higher');
});

test('VAT shows only when a VAT number is set', async () => {
  await put('/api/settings', { biz_vat_number: 'GB123456789' });
  const c = await client();
  const inv = (await post('/api/invoices', {
    client_id: c.id, lines: [{ description: 'Build', qty: 1, unit_pounds: '600' }],
  })).body.invoice;
  assert.equal(inv.vat_rate, 20);
  assert.equal(inv.vat_pence, 12000, '20% of £600');
  assert.equal(inv.total_pence, 72000);
  await put('/api/settings', { biz_vat_number: '' }); // reset for other tests
});

test('a draft can be deleted; a sent invoice must be voided, not deleted', async () => {
  const c = await client();
  const inv = (await post('/api/invoices', { client_id: c.id, lines: [{ description: 'x', qty: 1, unit_pounds: '10' }] })).body.invoice;
  await post(`/api/invoices/${inv.id}/sent`, {});
  assert.equal((await del(`/api/invoices/${inv.id}`)).status, 400, 'cannot delete a sent invoice');
  const voided = (await post(`/api/invoices/${inv.id}/void`, {})).body.invoice;
  assert.equal(voided.status, 'void');

  const draft = (await post('/api/invoices', { client_id: c.id, lines: [{ description: 'y', qty: 1, unit_pounds: '10' }] })).body.invoice;
  assert.equal((await del(`/api/invoices/${draft.id}`)).status, 204, 'a draft deletes cleanly');
});

test('marking paid records the method', async () => {
  const c = await client();
  const inv = (await post('/api/invoices', { client_id: c.id, lines: [{ description: 'x', qty: 1, unit_pounds: '10' }] })).body.invoice;
  const paid = (await post(`/api/invoices/${inv.id}/paid`, { method: 'paypal' })).body.invoice;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_method, 'paypal');
  assert.ok(paid.paid_at);
});

/* ------------------------------------------------------- maintenance plans */

test('a maintenance plan bills a monthly invoice, and not twice in a month', async () => {
  const c = await client('Peak Roofing Ltd');
  const plan = (await post('/api/invoices/maintenance/plans', {
    client_id: c.id, monthly_pounds: '30', description: 'Hosting & care', started_on: '2026-01-10',
  })).body.plan;
  assert.equal(plan.monthly_pence, 3000);

  const first = await post(`/api/invoices/maintenance/plans/${plan.id}/bill`, {});
  assert.equal(first.status, 201);
  assert.equal(first.body.invoice.kind, 'maintenance');
  assert.equal(first.body.invoice.total_pence, 3000);

  const again = await post(`/api/invoices/maintenance/plans/${plan.id}/bill`, {});
  assert.equal(again.status, 400, 'refuses a second bill in the same month');
});

/* ----------------------------------------------------- client-facing page */

test('the public invoice page renders the numbers and payment details', async () => {
  await put('/api/settings', {
    biz_name: 'Keylo Studios', pay_bank_name: 'K Gill', pay_bank_account: '12345678',
    pay_bank_sortcode: '00-00-00', pay_paypal_link: 'https://paypal.me/keylo',
  });
  const c = await client('Corner Cafe Ltd');
  const inv = (await post('/api/invoices', {
    client_id: c.id, lines: [{ description: 'Website', qty: 1, unit_pounds: '450' }],
  })).body.invoice;

  // The page is public — no cookie needed.
  const res = await fetch(`${base}/i/${inv.token}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Keylo Studios/);
  assert.match(html, /Corner Cafe Ltd/);
  assert.match(html, /£450\.00/);
  assert.match(html, /paypal\.me\/keylo/);
  assert.match(html, new RegExp(inv.reference), 'shows the bank reference');
  assert.doesNotMatch(html, /<script/i, 'no script on a locked-down page');

  // A bad token is a 404, not a leak.
  assert.equal((await fetch(`${base}/i/nope`)).status, 404);
});

test('the invoice page needs no login even though the API does', async () => {
  const c = await client('Gate Check Ltd');
  const inv = (await post('/api/invoices', {
    client_id: c.id, lines: [{ description: 'Website', qty: 1, unit_pounds: '10' }],
  })).body.invoice;
  // API is gated (get() carries the suite's session cookie)...
  assert.equal((await get(`/api/invoices/${inv.id}`)).status, 200);
  // ...the public page is not.
  const noCookie = await fetch(`${base}/i/${inv.token}`, { headers: {} });
  assert.equal(noCookie.status, 200);
});

test.after(teardown);
