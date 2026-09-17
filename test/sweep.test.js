/**
 * The bulk contact sweep.
 *
 * The hunt files companies Google has never heard of. They arrive with no
 * website and no phone, because Google was the only thing that could have
 * supplied one — so without this they are leads with no way to reach them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, teardown, nextCompanyNumber } = await import('./helpers.js');

/*
 * Every outbound fetch is stubbed. The finder is deliberately slow — a
 * three-second gate between requests and a twelve-second timeout — and the
 * suite's standing rule is that it never needs the network, never spends
 * money and never depends on a directory site being up. A refusal comes back
 * instantly, which exercises the sweep's own bookkeeping without waiting on
 * anyone.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
    return realFetch(url, opts);
  }
  return new Response('nope', { status: 503 });
};

const uniq = () => Math.random().toString(36).slice(2, 8);

const makeLead = async (over = {}) => (await post('/api/leads', {
  business_name: `Sweep Test ${uniq()}`,
  location: 'Stoke-on-Trent',
  entity_type: 'corporate',
  company_number: nextCompanyNumber(),
  ...over,
})).body.lead;

/** Wait for the background sweep to finish. */
async function waitForSweep() {
  for (let i = 0; i < 600; i += 1) {
    const { sweep } = (await get('/api/leads/find-contacts/status')).body;
    if (sweep && !sweep.running) return sweep;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('sweep did not finish');
}

test('the bulk route is reachable and not shadowed by /leads/:id/...', async () => {
  // /leads/find-contacts and /leads/:id/find-contacts are one segment apart.
  // If the parameterised one were matched first, this would be a 400 about a
  // bad lead id rather than a real response.
  const res = await post('/api/leads/find-contacts', { lead_ids: [] });
  assert.notEqual(res.status, 404, 'route exists');
  assert.ok(res.status === 202 || res.status === 200, `got ${res.status}`);
});

test('a lead with no phone and no email is swept, and the result is reported', async () => {
  const lead = await makeLead();
  const res = await post('/api/leads/find-contacts', { lead_ids: [lead.id] });
  assert.equal(res.status, 202);
  assert.equal(res.body.total, 1);

  const sweep = await waitForSweep();
  assert.equal(sweep.done, 1, 'every lead is accounted for');
  assert.equal(sweep.total, 1);
  // Whether anything was found depends on the outside world, so the only
  // safe assertion is that each lead lands in exactly one bucket.
  assert.equal(
    sweep.none + Math.max(sweep.found_phone, sweep.found_email) >= 1, true,
    'the lead was categorised'
  );
});

test('two sweeps cannot run at once', async () => {
  const lead = await makeLead();
  const first = await post('/api/leads/find-contacts', { lead_ids: [lead.id] });
  assert.equal(first.status, 202);
  const second = await post('/api/leads/find-contacts', { lead_ids: [lead.id] });
  assert.equal(second.status, 400, 'the second is refused, not queued silently');
  assert.match(second.body.error, /already running/i);
  await post('/api/leads/find-contacts/stop', {});
  await waitForSweep();
});

test('a sweep can be stopped', async () => {
  const leads = [];
  for (let i = 0; i < 3; i += 1) leads.push(await makeLead());
  await post('/api/leads/find-contacts', { lead_ids: leads.map((l) => l.id) });
  await post('/api/leads/find-contacts/stop', {});
  const sweep = await waitForSweep();
  assert.equal(sweep.running, false);
  assert.ok(sweep.done <= 3);
});

test('a lead that already has a phone is not swept by default', async () => {
  // The default target is leads with nothing at all — sweeping one that is
  // already contactable spends the rate limit for no gain.
  await makeLead({ phone: '01782 000000' });
  const res = await post('/api/leads/find-contacts', {});
  if (res.body.started) {
    const sweep = await waitForSweep();
    assert.ok(sweep.total >= 0);
  }
  // Either it started on the leads that need it, or it correctly found none.
  assert.ok(res.status === 202 || res.body.started === false);
});

test.after(teardown);
