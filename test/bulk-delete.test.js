/**
 * Clearing the list.
 *
 * "Delete all" is the button you press when a day's hunt turned up rubbish,
 * so it has to be quick and it has to be safe. Two records deliberately
 * outlive the rows, and both of them are the difference between a tidy list
 * and a complaint:
 *
 *   - an opt-out. Deleting the lead must not un-block the business.
 *   - the company ledger. It is the whole no-repeat guarantee, and it was
 *     built to survive a single delete for exactly this reason. Clearing the
 *     list must not hand every company on it back to tomorrow's hunt.
 *
 * The escape hatch is `forget`, and it is deliberately narrow: only companies
 * that have never been contacted can be forgotten. A contact date cannot be
 * argued away by deleting something.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, patch, del, teardown, nextCompanyNumber } = await import('./helpers.js');
const { ledgerFor, knownCompanyNumbers } = await import('../server/lib/recontact.js');
const { isSuppressed } = await import('../server/lib/suppression.js');

const uniq = () => Math.random().toString(36).slice(2, 8);

async function makeLead(over = {}) {
  const r = await post('/api/leads', {
    business_name: `Wipe Test ${uniq()}`,
    location: 'Stafford',
    category: 'roofers',
    entity_type: 'corporate',
    company_number: nextCompanyNumber(),
    ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

const listed = async () => (await get('/api/leads')).body.leads;

async function clear() {
  await post('/api/leads/bulk-delete', { all: true, forget: true });
}

/* ------------------------------------------------------------- the ask */

test('delete all empties the list', async () => {
  await clear();
  await makeLead();
  await makeLead();
  assert.equal((await listed()).length, 2);

  const res = await post('/api/leads/bulk-delete', { all: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, 2);
  assert.deepEqual(await listed(), []);
});

test('deleting by id leaves the rest alone', async () => {
  await clear();
  const doomed = await makeLead();
  const keeper = await makeLead();

  const res = await post('/api/leads/bulk-delete', { ids: [doomed.id] });
  assert.equal(res.body.deleted, 1);
  assert.deepEqual((await listed()).map((l) => l.id), [keeper.id]);
});

test('with neither ids nor all it refuses rather than guessing', async () => {
  // The dangerous default would be to treat "no ids" as "everything".
  await clear();
  await makeLead();
  const res = await post('/api/leads/bulk-delete', {});
  assert.equal(res.status, 400);
  assert.equal((await listed()).length, 1, 'and nothing was deleted');
});

/* ---------------------------------------------------------- the ledger */

test('clearing the list does not hand the companies back to the hunt', async () => {
  // company_ledger outliving a deleted lead is the entire no-repeat
  // guarantee. A bulk delete that wiped it would make the next hunt re-find
  // every business on the list and offer it as new.
  await clear();
  const lead = await makeLead();
  const number = lead.company_number;
  assert.ok(knownCompanyNumbers().has(number), 'filed as found on creation');

  await post('/api/leads/bulk-delete', { all: true });
  assert.ok(knownCompanyNumbers().has(number),
    'the company is still on the found list, so the hunt will not re-file it');
});

test('forget lets a never-contacted company be found again', async () => {
  await clear();
  const lead = await makeLead();
  const number = lead.company_number;

  const res = await post('/api/leads/bulk-delete', { all: true, forget: true });
  assert.equal(res.body.forgotten, 1);
  assert.equal(res.body.kept, 0);
  assert.equal(knownCompanyNumbers().has(number), false,
    'a business never approached can come round again');
  assert.equal(ledgerFor({ company_number: number }), null);
});

test('forget will not forget a company that has been contacted', async () => {
  // The point of the contact date is that it cannot be undone by deleting
  // something. Otherwise "delete all" is a way to cold-message the same
  // roofer twice, which is exactly what earns a PECR complaint.
  await clear();
  const lead = await makeLead({ email: 'seen@example.com' });
  await patch(`/api/leads/${lead.id}`, { status: 'sent' });
  assert.ok(ledgerFor({ company_number: lead.company_number })?.contacted_at,
    'marking it sent stamps the ledger');

  const res = await post('/api/leads/bulk-delete', { all: true, forget: true });
  assert.equal(res.body.kept, 1, 'reported, not silently ignored');
  assert.equal(res.body.forgotten, 0);
  assert.ok(knownCompanyNumbers().has(lead.company_number));
  assert.ok(ledgerFor({ company_number: lead.company_number })?.contacted_at,
    'the contact date survives');
});

test('a mixed batch forgets only the untouched half', async () => {
  await clear();
  const fresh = await makeLead();
  const done = await makeLead({ email: 'done@example.com' });
  await patch(`/api/leads/${done.id}`, { status: 'sent' });

  const res = await post('/api/leads/bulk-delete', { all: true, forget: true });
  assert.equal(res.body.deleted, 2);
  assert.equal(res.body.forgotten, 1);
  assert.equal(res.body.kept, 1);
  assert.equal(knownCompanyNumbers().has(fresh.company_number), false);
  assert.equal(knownCompanyNumbers().has(done.company_number), true);
});

/* ------------------------------------------------------------- opt-out */

test('an opt-out made before the address was known still follows it out', async () => {
  // Most no-website trades are phone-only, so the opt-out gets set with no
  // address to suppress. If an email turns up afterwards, nothing goes back
  // and records it — so deleting the lead is the last chance, and without
  // this the next import makes them contactable again.
  await clear();
  const email = `optout-${uniq()}@example.com`;
  const lead = await makeLead({ phone: '07700 900111' });
  await patch(`/api/leads/${lead.id}`, { opted_out: true });
  assert.equal(isSuppressed(email), false, 'nothing to suppress yet');
  await patch(`/api/leads/${lead.id}`, { email });

  const res = await post('/api/leads/bulk-delete', { all: true, forget: true });
  assert.equal(res.body.deleted, 1);
  assert.equal(res.body.suppressed, 1);
  assert.ok(isSuppressed(email), 'still blocked with the lead gone');
});

test('the single-lead delete closes the same hole', async () => {
  await clear();
  const email = `optout-${uniq()}@example.com`;
  const lead = await makeLead({ phone: '07700 900222' });
  await patch(`/api/leads/${lead.id}`, { opted_out: true });
  await patch(`/api/leads/${lead.id}`, { email });

  assert.equal((await del(`/api/leads/${lead.id}`)).status, 204);
  assert.ok(isSuppressed(email));
});

test.after(teardown);
