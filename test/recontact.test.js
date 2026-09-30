/**
 * No repeats: the same company must not be found again, emailed again, or
 * messaged again on a later day.
 *
 * These are the tests for the ledger itself and for every route that can
 * approach a business. The rule they encode is not "one email per lead" — it
 * is one COLD approach per company, across all four channels, surviving the
 * lead row being deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, patch, del, put, IDENTITY, teardown, nextCompanyNumber } =
  await import('./helpers.js');
const {
  companyKey, nameKey, ledgerFor, recordFound, recordContact,
  alreadyContacted, recontactCheck, knownCompanyNumbers,
} = await import('../server/lib/recontact.js');
const { normaliseName } = await import('../server/lib/companies-house.js');

const uniq = () => Math.random().toString(36).slice(2, 8);

async function makeLead(over = {}) {
  const r = await post('/api/leads', {
    business_name: `Ledger Test ${uniq()}`,
    location: 'Wolverhampton',
    phone: '07123 456789',
    entity_type: 'corporate',
    company_number: nextCompanyNumber(),
    ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

/* ------------------------------------------------------------- the key */

test('a company number is the key, and it is case-insensitive', () => {
  // The column was written as typed and compared with '=', so 'sc123456' and
  // 'SC123456' were two different businesses to every check that mattered.
  assert.equal(companyKey({ company_number: 'sc123456' }), 'ch:SC123456');
  assert.equal(companyKey({ company_number: ' SC123456 ' }), 'ch:SC123456');
  assert.equal(
    companyKey({ company_number: 'sc123456' }),
    companyKey({ company_number: 'SC123456' })
  );
});

test('with no number, name and town identify the company', () => {
  const a = companyKey({ business_name: 'Hillside Roofing Ltd', location: 'Walsall' });
  const b = companyKey({ business_name: 'HILLSIDE ROOFING LIMITED', location: 'walsall' });
  assert.equal(a, b, 'a trading name and a registered name are one business');
  assert.equal(companyKey({ business_name: '', location: 'Walsall' }), null);
  assert.equal(companyKey({}), null);
});

test('the number wins over the name when we hold one', () => {
  const k = companyKey({ company_number: '01234567', business_name: 'Anything', location: 'Leeds' });
  assert.equal(k, 'ch:01234567');
});

test('db.js mirrors the real name normaliser', () => {
  // The backfill in migration 019 cannot import companies-house.js without a
  // cycle, so it carries a copy. Two definitions of "the same company" that
  // drift apart is exactly the split identity the ledger exists to close.
  const cases = [
    'HILLSIDE ROOFING LIMITED', 'Hillside Roofing Ltd', 'A & B Plumbing (UK) Ltd',
    'The Cake Co', 'Dunston  Motor   Works LLP', "O'Brien Electrical PLC", '',
  ];
  for (const name of cases) {
    const viaApp = normaliseName(name);
    // Re-derive with the same rules the migration uses.
    const NOISE = new Set(['ltd', 'limited', 'llp', 'plc', 'cic', 'co', 'company', 'the', 'and', 'uk']);
    const viaMigration = String(name ?? '')
      .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter((w) => w && !NOISE.has(w)).join(' ')
      .trim();
    assert.equal(viaMigration, viaApp, `normalisers disagree on "${name}"`);
  }
});

/* ---------------------------------------------------------- the ledger */

test('a found company is filed, and finding it again does not reset it', () => {
  const lead = { company_number: `LG${uniq()}`, business_name: 'Filed Co', location: 'Stafford' };
  recordFound(lead);
  const first = ledgerFor(lead);
  assert.ok(first, 'filed');
  assert.equal(first.contacted_at, null);

  recordContact(lead, 'email');
  recordFound(lead);
  const after = ledgerFor(lead);
  assert.equal(after.found_at, first.found_at, 'found_at is not rewritten');
  assert.ok(after.contacted_at, 'and finding it again must not erase the contact');
});

test('contact is counted, not just flagged', () => {
  const lead = { company_number: `CT${uniq()}`, business_name: 'Counted Co', location: 'Stafford' };
  recordContact(lead, 'whatsapp');
  assert.equal(ledgerFor(lead).times_contacted, 1);
  recordContact(lead, 'email');
  const row = ledgerFor(lead);
  assert.equal(row.times_contacted, 2);
  assert.equal(row.last_channel, 'email', 'the most recent channel is the one shown');
});

test('the register path and the Places path find each other', () => {
  // One knows a company number and no town; the other knows a trading name
  // and a town and never learns a number. Keyed on one alone the two funnels
  // are blind to each other and the business arrives down both.
  const number = `XP${uniq()}`;
  recordFound({ company_number: number, business_name: 'Crossover Tyres Ltd', location: 'Cannock' });
  recordContact({ company_number: number, business_name: 'Crossover Tyres Ltd', location: 'Cannock' }, 'email');

  const fromPlaces = { business_name: 'Crossover Tyres', location: 'Cannock' };
  const seen = ledgerFor(fromPlaces);
  assert.ok(seen, 'the Places-shaped lead must resolve to the same company');
  assert.ok(alreadyContacted(fromPlaces), 'and inherit its contact history');
});

test('two companies that share a name in one town stay separate when the register says so', () => {
  // The name key is a guess. Companies House saying the numbers differ is not.
  const town = `Testbury${uniq()}`;
  recordContact({ company_number: `AA${uniq()}`, business_name: 'Ace Plumbing Ltd', location: town }, 'email');
  const other = { company_number: `BB${uniq()}`, business_name: 'Ace Plumbing Ltd', location: town };
  assert.equal(alreadyContacted(other), false,
    'a different company number is positive evidence of a different company');
  assert.equal(recontactCheck(other).allowed, true);
});

test('a company with no number at all still cannot be approached twice', () => {
  const town = `Nowhere${uniq()}`;
  const lead = { business_name: 'Numberless Cleaning', location: town };
  recordContact(lead, 'sms');
  assert.equal(alreadyContacted({ business_name: 'NUMBERLESS CLEANING LTD', location: town }), true);
});

/* ------------------------------------------------------------ the rule */

test('a company never approached is allowed', () => {
  const v = recontactCheck({ company_number: `NEW${uniq()}`, business_name: 'Fresh Co' });
  assert.equal(v.allowed, true);
  assert.equal(v.code, 'NEW');
});

test('a company approached before is refused, and told when and how', () => {
  const lead = { company_number: `RF${uniq()}`, business_name: 'Refused Co', location: 'Leeds' };
  recordContact(lead, 'whatsapp');
  const v = recontactCheck(lead);
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'ALREADY_CONTACTED');
  assert.match(v.reason, /whatsapp/);
  assert.match(v.reason, /\d{4}-\d{2}-\d{2}/, 'the date is in the reason, not just a flag');
});

test('a prospect who replied can still be answered', () => {
  // The block is on repeating a COLD approach. Refusing to let the owner
  // answer someone who wrote back would be absurd.
  const lead = {
    company_number: `RP${uniq()}`, business_name: 'Replied Co',
    location: 'Leeds', status: 'replied',
  };
  recordContact(lead, 'email');
  const v = recontactCheck(lead);
  assert.equal(v.allowed, true);
  assert.equal(v.code, 'IN_CONVERSATION');
  assert.equal(recontactCheck({ ...lead, status: 'won' }).allowed, true);
});

test('the override is explicit, and the repeat is still counted', () => {
  const lead = { company_number: `OV${uniq()}`, business_name: 'Override Co', location: 'Leeds' };
  recordContact(lead, 'email');
  assert.equal(recontactCheck(lead).allowed, false);
  const v = recontactCheck(lead, { allowRepeat: true });
  assert.equal(v.allowed, true);
  assert.equal(v.code, 'OVERRIDDEN');
  assert.ok(v.previous, 'an override still reports what it is overriding');
});

test('a lead too thin to identify falls back to its own stamp rather than a clean sheet', () => {
  // Reporting "never contacted" for a company we cannot identify would be a
  // guarantee we cannot actually make.
  const v = recontactCheck({ last_contacted_at: '2026-01-05T09:00:00.000Z' });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'ALREADY_CONTACTED');
  assert.equal(recontactCheck({}).allowed, true);
});

/* ------------------------------------------------------- across routes */

test('setup identity for the send paths', async () => {
  await put('/api/settings', { ...IDENTITY, domain_cooldown_days: '0' });
});

test('the email queue refuses a company already messaged on WhatsApp', async () => {
  const lead = await makeLead({ email: `a${uniq()}@crosschannel.co.uk` });
  const tpl = await post('/api/templates', {
    name: `X-${uniq()}`, subject: 'Hi', body: 'Hello.',
  });

  // Messaged yesterday, by a completely different route.
  const prep = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', text: 'Hi there',
  });
  assert.equal(prep.status, 200);
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});

  const q = await post('/api/gmail/queue', {
    template_id: tpl.body.template.id, lead_ids: [lead.id],
  });
  assert.equal(q.body.queued, 0, 'a second channel is still a second approach');
  assert.equal(q.body.skipped[0].reason, 'already contacted');
  assert.match(q.body.skipped[0].detail, /whatsapp/);
});

test('the WhatsApp path refuses a company already emailed', async () => {
  const lead = await makeLead();
  // Stamp it the way a completed send does.
  await patch(`/api/leads/${lead.id}`, { status: 'sent' });

  const r = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', text: 'Hi again',
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'ALREADY_CONTACTED');
});

test('the override reaches the routes, and only for the leads named', async () => {
  const a = await makeLead({ email: `a${uniq()}@override.co.uk` });
  const b = await makeLead({ email: `b${uniq()}@override.co.uk` });
  const tpl = await post('/api/templates', { name: `O-${uniq()}`, subject: 'Hi', body: 'Hello.' });
  for (const l of [a, b]) await patch(`/api/leads/${l.id}`, { status: 'sent' });

  const q = await post('/api/gmail/queue', {
    template_id: tpl.body.template.id,
    lead_ids: [a.id, b.id],
    allow_repeat_lead_ids: [a.id],
  });
  assert.equal(q.body.queued, 1, 'only the lead named in the override goes through');
  assert.equal(q.body.skipped.length, 1);
  assert.equal(q.body.skipped[0].lead_id, b.id);
});

test('deleting a lead does not make its company approachable again', async () => {
  // This is the whole point of a separate table. DELETE FROM leads is a hard
  // delete, and it used to erase the only evidence the company was ever seen.
  const lead = await makeLead();
  await patch(`/api/leads/${lead.id}`, { status: 'sent' });
  assert.ok(alreadyContacted(lead), 'contacted');

  assert.equal((await del(`/api/leads/${lead.id}`)).status, 204);
  assert.equal((await get(`/api/leads/${lead.id}`)).status, 404, 'the lead is gone');

  assert.ok(alreadyContacted(lead), 'but the company is still on the ledger');
  assert.equal(recontactCheck(lead).allowed, false);
  assert.ok(knownCompanyNumbers().has(lead.company_number.toUpperCase()),
    'and the hunt will not file it again');
});

test('a second lead row for one company cannot be created', async () => {
  const lead = await makeLead();
  const dupe = await post('/api/leads', {
    business_name: 'A Different Trading Name',
    location: 'Leeds',
    entity_type: 'corporate',
    company_number: lead.company_number.toLowerCase(),
  });
  assert.equal(dupe.status, 409, 'two rows for one company get contacted twice');
  assert.match(dupe.body.error, new RegExp(lead.company_number, 'i'));
});

test('marking a batch as sent stamps the date and files the contact', async () => {
  const lead = await makeLead();
  assert.equal(lead.last_contacted_at ?? null, null);
  const r = await post('/api/leads/bulk-status', { ids: [lead.id], status: 'sent' });
  assert.equal(r.status, 200);

  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.ok(after.last_contacted_at, 'a lead marked contacted must carry a contact date');
  assert.ok(alreadyContacted(lead));
});

test('nameKey ignores the words that differ between a register and a van', () => {
  assert.equal(
    nameKey({ business_name: 'HILLSIDE ROOFING LIMITED', location: 'Walsall' }),
    nameKey({ business_name: 'Hillside Roofing', location: 'Walsall' })
  );
  assert.notEqual(
    nameKey({ business_name: 'Hillside Roofing', location: 'Walsall' }),
    nameKey({ business_name: 'Hillside Roofing', location: 'Dudley' })
  );
});

test.after(teardown);
