import test from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, put, del, IDENTITY, teardown } from './helpers.js';

test.after(teardown);

let seedN = 0;

/**
 * A distinct address per lead. Suppression is keyed on the address and
 * outlives the lead, so a shared fixture address would let one opted-out
 * lead block every test that ran after it.
 */
const newLead = (over = {}) => ({
  business_name: 'Hillside Roofing', category: 'roofers', location: 'Otley',
  email: `lead${++seedN}@hillside.example`, ...over,
});

/**
 * A lead that may lawfully be emailed: a limited company on its own domain.
 * Anything less is blocked by the PECR gate, which is the point of the gate.
 */
const sendableLead = (over = {}) => newLead({
  business_name: 'Hillside Roofing Ltd',
  entity_type: 'corporate',
  company_number: '01234567',
  ...over,
});

test('health check reports the database in use', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('leads: create, read, update, delete', async () => {
  const created = await post('/api/leads', newLead());
  assert.equal(created.status, 201);
  const id = created.body.lead.id;
  assert.equal(created.body.lead.status, 'new');
  assert.equal(created.body.lead.opted_out, false);

  const read = await get(`/api/leads/${id}`);
  assert.equal(read.body.lead.business_name, 'Hillside Roofing');
  assert.deepEqual(read.body.history, []);

  const updated = await patch(`/api/leads/${id}`, { status: 'replied', notes: 'called back' });
  assert.equal(updated.body.lead.status, 'replied');
  assert.equal(updated.body.lead.notes, 'called back');
  // A partial patch must not blank out untouched fields.
  assert.equal(updated.body.lead.category, 'roofers');

  assert.equal((await del(`/api/leads/${id}`)).status, 204);
  assert.equal((await get(`/api/leads/${id}`)).status, 404);
});

test('leads: validation rejects bad input', async () => {
  assert.equal((await post('/api/leads', { category: 'x' })).status, 400);
  assert.equal((await post('/api/leads', newLead({ email: 'nope' }))).status, 400);
  assert.equal((await post('/api/leads', newLead({ status: 'bogus' }))).status, 400);
});

test('leads: a google place id can only be imported once', async () => {
  const a = await post('/api/leads', newLead({ google_place_id: 'ChIJ_unique_1' }));
  assert.equal(a.status, 201);
  const b = await post('/api/leads', newLead({ business_name: 'Dup', google_place_id: 'ChIJ_unique_1' }));
  assert.equal(b.status, 409);
  await del(`/api/leads/${a.body.lead.id}`);
});

test('leads: moving to "sent" by hand stamps the contact date', async () => {
  const { body } = await post('/api/leads', newLead({ business_name: 'Stamp Test' }));
  assert.equal(body.lead.last_contacted_at, null);
  const moved = await patch(`/api/leads/${body.lead.id}`, { status: 'sent' });
  assert.ok(moved.body.lead.last_contacted_at, 'expected last_contacted_at to be set');
  await del(`/api/leads/${body.lead.id}`);
});

test('leads: stats and status filtering agree', async () => {
  const ids = [];
  for (const s of ['new', 'sent', 'sent', 'replied', 'won', 'lost']) {
    const r = await post('/api/leads', newLead({ business_name: `S ${s} ${ids.length}`, status: s }));
    ids.push(r.body.lead.id);
  }
  const stats = (await get('/api/leads/stats')).body;
  assert.equal(stats.awaiting_reply, 2, 'awaiting reply counts leads sat at "sent"');
  assert.equal(stats.replied, 1);
  assert.equal(stats.won, 1);
  assert.equal(stats.by_status.lost, 1);

  const sent = (await get('/api/leads?status=sent')).body.leads;
  assert.equal(sent.length, 2);
  assert.ok(sent.every((l) => l.status === 'sent'));

  assert.equal((await get('/api/leads?status=nonsense')).status, 400);
  for (const id of ids) await del(`/api/leads/${id}`);
});

test('leads: free-text search matches name, town and notes', async () => {
  const r = await post('/api/leads', newLead({ business_name: 'Searchable Ltd', location: 'Skipton', notes: 'thatched roof' }));
  assert.equal((await get('/api/leads?q=Searchable')).body.leads.length, 1);
  assert.equal((await get('/api/leads?q=Skipton')).body.leads.length, 1);
  assert.equal((await get('/api/leads?q=thatched')).body.leads.length, 1);
  assert.equal((await get('/api/leads?q=zzzznothing')).body.leads.length, 0);
  await del(`/api/leads/${r.body.lead.id}`);
});

test('templates: create, warn on typos, reject duplicate names, update, delete', async () => {
  const c = await post('/api/templates', { name: 'T1', subject: 'Hi {{business}}', body: 'in {{location}}' });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.warnings, []);

  const typo = await post('/api/templates', { name: 'T2', subject: '{{buisness}}', body: 'x' });
  assert.equal(typo.body.warnings.length, 1);
  assert.match(typo.body.warnings[0], /buisness/);

  assert.equal((await post('/api/templates', { name: 'T1', subject: 'a', body: 'b' })).status, 409);

  const u = await put(`/api/templates/${c.body.template.id}`, { subject: 'Changed' });
  assert.equal(u.body.template.subject, 'Changed');
  assert.equal(u.body.template.body, 'in {{location}}', 'omitted fields keep their value');

  assert.equal((await del(`/api/templates/${typo.body.template.id}`)).status, 204);
  assert.equal((await del(`/api/templates/${c.body.template.id}`)).status, 204);
});

test('settings: only known keys are writable, and numbers are range-checked', async () => {
  assert.equal((await put('/api/settings', { nonsense: 'x' })).status, 400);
  assert.equal((await put('/api/settings', { biz_email: 'not-an-email' })).status, 400);
  assert.equal((await put('/api/settings', { daily_cap: '9999' })).status, 400);
  assert.equal((await put('/api/settings', { daily_cap: '25' })).status, 200);
});

test('compliance: an email cannot be produced until identity details are set', async () => {
  // Start from a blank identity.
  await put('/api/settings', { biz_contact_name: '', biz_name: '', biz_address: '', biz_email: '' });

  const lead = (await post('/api/leads', sendableLead({ business_name: 'Footer Test Ltd' }))).body.lead;
  const tpl = (await post('/api/templates', { name: 'FT', subject: 'Hi {{business}}', body: 'Body.' })).body.template;

  const blocked = await get(`/api/emails/preview?lead_id=${lead.id}&template_id=${tpl.id}`);
  assert.equal(blocked.body.compliant, false);
  assert.equal(blocked.body.can_send, false);
  assert.equal(blocked.body.mailto, null, 'no mailto draft until the email would be lawful');

  const logBlocked = await post('/api/emails/log', { lead_id: lead.id, template_id: tpl.id, channel: 'copy' });
  assert.equal(logBlocked.status, 422);

  await put('/api/settings', IDENTITY);
  const ok = await get(`/api/emails/preview?lead_id=${lead.id}&template_id=${tpl.id}`);
  assert.equal(ok.body.compliant, true);
  assert.ok(ok.body.mailto);
  assert.match(ok.body.body, /Test Web Studio/, 'identity block is appended');
  assert.match(ok.body.body, /1 Test Street, Leeds LS1 1AA/, 'postal address is appended');
  assert.match(ok.body.body, /reply and say so/, 'opt-out line is appended');

  await del(`/api/leads/${lead.id}`);
  await del(`/api/templates/${tpl.id}`);
});

test('opt-out is a hard exclusion on every path', async () => {
  await put('/api/settings', IDENTITY);
  const lead = (await post('/api/leads', sendableLead({ business_name: 'Opted Out Co Ltd', opted_out: true }))).body.lead;
  const tpl = (await post('/api/templates', { name: 'OO', subject: 's', body: 'b' })).body.template;

  assert.equal(lead.opted_out, true);
  assert.equal((await get(`/api/emails/preview?lead_id=${lead.id}&template_id=${tpl.id}`)).status, 400);
  assert.equal((await post('/api/emails/log', { lead_id: lead.id, template_id: tpl.id })).status, 400);

  await del(`/api/leads/${lead.id}`);
  await del(`/api/templates/${tpl.id}`);
});

test('sending logs a snapshot, advances the lead, and survives later edits', async () => {
  await put('/api/settings', IDENTITY);
  const lead = (await post('/api/leads', sendableLead({ business_name: 'Snapshot Co Ltd' }))).body.lead;
  const tpl = (await post('/api/templates', { name: 'Snap', subject: 'Hi {{business}}', body: 'Original wording.' })).body.template;

  const sent = await post('/api/emails/log', { lead_id: lead.id, template_id: tpl.id, channel: 'mailto' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.entry.subject_snapshot, 'Hi Snapshot Co Ltd');
  assert.equal(sent.body.entry.to_email, lead.email);
  assert.match(sent.body.entry.body_snapshot, /Original wording/);
  assert.equal(sent.body.lead.status, 'sent', 'a "new" lead advances to "sent"');
  assert.ok(sent.body.lead.last_contacted_at);

  // Editing the template must not rewrite what was already sent.
  await put(`/api/templates/${tpl.id}`, { body: 'Completely different now.' });
  const entry = (await get(`/api/emails/log/${sent.body.entry.id}`)).body.entry;
  assert.match(entry.body_snapshot, /Original wording/);

  // Deleting the lead keeps the proof of what went out.
  await del(`/api/leads/${lead.id}`);
  const after = (await get(`/api/emails/log/${sent.body.entry.id}`)).body.entry;
  assert.equal(after.lead_id, null);
  assert.equal(after.lead_name, 'Snapshot Co Ltd');
  assert.equal(after.to_email, lead.email);

  await del(`/api/templates/${tpl.id}`);
});

test('logging does not demote a lead that is already further along', async () => {
  await put('/api/settings', IDENTITY);
  const lead = (await post('/api/leads', sendableLead({ business_name: 'Won Co Ltd', status: 'won' }))).body.lead;
  const tpl = (await post('/api/templates', { name: 'W', subject: 's', body: 'b' })).body.template;
  const sent = await post('/api/emails/log', { lead_id: lead.id, template_id: tpl.id });
  assert.equal(sent.body.lead.status, 'won');
  await del(`/api/leads/${lead.id}`);
  await del(`/api/templates/${tpl.id}`);
});

test('unknown API routes return JSON 404, not the SPA shell', async () => {
  const r = await get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Unknown API endpoint');
});

/* ------------------------------------------------- identity seeding */

test('the identity seed reads .env and never overwrites a manual edit', async () => {
  const { seedIdentityFromEnv, envIdentityKeys } =
    await import('../server/lib/identity.js');
  const { getSetting, setSetting } = await import('../server/db.js');

  // A value already set by hand must survive: .env is a convenience, not an
  // authority. Settings is where the user's own decision lives.
  setSetting('biz_name', 'Set By Hand');
  process.env.BIZ_TRADING_NAME = 'From Env';
  process.env.BIZ_PLACE_OF_REGISTRATION = 'England and Wales';

  const seeded = seedIdentityFromEnv();
  assert.equal(getSetting('biz_name'), 'Set By Hand', 'a manual edit wins');
  assert.ok(seeded.includes('biz_place_of_registration'), 'an empty one is filled');
  assert.equal(getSetting('biz_place_of_registration'), 'England and Wales');

  // Seeding twice must be a no-op, since the doctor and the server both run it.
  assert.deepEqual(seedIdentityFromEnv(), [], 'idempotent');

  assert.ok(envIdentityKeys().includes('BIZ_TRADING_NAME'),
    'envIdentityKeys reports what is actually set, so the doctor can tell '
    + '"you never wrote these down" apart from "they are there but misspelt"');

  delete process.env.BIZ_TRADING_NAME;
  delete process.env.BIZ_PLACE_OF_REGISTRATION;
});
