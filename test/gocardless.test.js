/**
 * Direct Debit for maintenance plans (GoCardless).
 *
 * GoCardless's HTTP is stubbed (no live account), so these prove the wiring:
 * a connected account is advertised to the UI, setting a plan up creates a
 * billing-request flow and hands back an authorisation link (marking the plan
 * pending), and the client's return fulfils the mandate, creates the monthly
 * subscription for the plan amount and marks the plan active. Two safety points
 * matter most: an unfinished authorisation must NOT activate the plan, and a
 * second return must NOT create a second subscription.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOCARDLESS_ACCESS_TOKEN = 'sandbox_x';

const { get, post, base, teardown } = await import('./helpers.js');

/* Stub only GoCardless's host; the app on 127.0.0.1 passes through. */
const realFetch = globalThis.fetch;
let brq = { id: 'BRQ_1', status: 'fulfilled', links: { mandate_request_mandate: 'MD_1' } };
let subCount = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('gocardless.com')) return realFetch(url, opts);
  const method = opts.method ?? 'GET';
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  if (u.endsWith('/billing_requests') && method === 'POST') {
    return json({ billing_requests: { id: brq.id, status: 'pending' } });
  }
  if (u.endsWith('/billing_request_flows') && method === 'POST') {
    return json({ billing_request_flows: { authorisation_url: 'https://pay-sandbox.gocardless.com/flow/RE123' } });
  }
  if (/\/billing_requests\/[^/]+\/actions\/fulfil$/.test(u) && method === 'POST') {
    // Only fulfils if a mandate is actually available in the current state.
    if (brq.links?.mandate_request_mandate) {
      return json({ billing_requests: { id: brq.id, status: 'fulfilled', links: brq.links } });
    }
    return json({ error: { message: 'not ready' } }, 422);
  }
  if (/\/billing_requests\/[^/]+$/.test(u) && method === 'GET') {
    return json({ billing_requests: brq });
  }
  if (u.endsWith('/subscriptions') && method === 'POST') {
    subCount += 1;
    return json({ subscriptions: { id: 'SB_1' } });
  }
  return json({ error: { message: `unexpected ${method} ${u}` } }, 500);
};

async function makePlan(pounds = '30') {
  const c = (await post('/api/invoices/clients', { name: 'DD Test Ltd' })).body.client;
  return (await post('/api/invoices/maintenance/plans', {
    client_id: c.id, monthly_pounds: pounds, description: 'Website care plan', started_on: '2026-01-12',
  })).body.plan;
}

const planById = async (id) =>
  (await get('/api/invoices/maintenance/plans')).body.plans.find((p) => p.id === id);

test('a connected GoCardless is advertised to the UI', async () => {
  const s = (await get('/api/settings')).body;
  assert.equal(s.integrations.direct_debit_configured, true);
});

test('setting up Direct Debit returns an authorisation link and marks the plan pending', async () => {
  const plan = await makePlan();
  const res = await post(`/api/invoices/maintenance/plans/${plan.id}/direct-debit`);
  assert.equal(res.status, 200);
  assert.match(res.body.authorisation_url, /pay-sandbox\.gocardless\.com\/flow\//);

  const after = await planById(plan.id);
  assert.equal(after.dd_status, 'pending');
  assert.equal(after.gc_billing_request_id, 'BRQ_1');
  assert.ok(after.dd_token, 'the plan gets an unguessable return token');
});

test('the return fulfils the mandate, subscribes and marks the plan active', async () => {
  brq = { id: 'BRQ_1', status: 'fulfilled', links: { mandate_request_mandate: 'MD_1' } };
  subCount = 0;
  const plan = await makePlan('45');
  await post(`/api/invoices/maintenance/plans/${plan.id}/direct-debit`);
  const token = (await planById(plan.id)).dd_token;

  const res = await realFetch(`${base}/dd/${token}/return`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Direct Debit set up/);

  const after = await planById(plan.id);
  assert.equal(after.dd_status, 'active');
  assert.equal(after.gc_mandate_id, 'MD_1');
  assert.equal(after.gc_subscription_id, 'SB_1');
  assert.equal(subCount, 1, 'exactly one subscription is created');
});

test('a second return does not create a second subscription', async () => {
  brq = { id: 'BRQ_1', status: 'fulfilled', links: { mandate_request_mandate: 'MD_1' } };
  subCount = 0;
  const plan = await makePlan('45');
  await post(`/api/invoices/maintenance/plans/${plan.id}/direct-debit`);
  const token = (await planById(plan.id)).dd_token;

  await realFetch(`${base}/dd/${token}/return`);
  await realFetch(`${base}/dd/${token}/return`); // client refreshes the page
  assert.equal(subCount, 1, 'the guard stops a duplicate subscription');
});

test('an unfinished authorisation never activates the plan', async () => {
  brq = { id: 'BRQ_1', status: 'pending', links: {} }; // client left before authorising
  subCount = 0;
  const plan = await makePlan('45');
  await post(`/api/invoices/maintenance/plans/${plan.id}/direct-debit`);
  const token = (await planById(plan.id)).dd_token;

  const res = await realFetch(`${base}/dd/${token}/return`);
  assert.match(await res.text(), /Not completed/);
  const after = await planById(plan.id);
  assert.notEqual(after.dd_status, 'active', 'no mandate means no activation');
  assert.equal(subCount, 0, 'and no subscription');
});

test('an unknown return token is a 404', async () => {
  const res = await realFetch(`${base}/dd/deadbeef/return`);
  assert.equal(res.status, 404);
});

test.after(() => { globalThis.fetch = realFetch; teardown(); });
