/**
 * Leads someone has messaged on WhatsApp move to their own screen.
 *
 * The Leads screen is the list of people still to approach. Once a WhatsApp
 * send is confirmed, the lead belongs on "Sent via WhatsApp" instead, and it
 * stays there whatever happens next (replied, won, lost). These tests pin:
 *
 *   - a confirmed WhatsApp send moves the lead; a prepared-but-unsent one,
 *     or one sent by text, does not
 *   - the counts above each screen match that screen's list
 *   - "Delete all" on the Leads screen cannot reach the WhatsApp screen
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, post, patch, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { ledgerFor } = await import('../server/lib/recontact.js');

test.after(teardown);

let n = 0;
async function lead(name) {
  const r = await post('/api/leads', {
    business_name: name,
    location: 'Leeds',
    phone: `07123 45${String(6000 + (n += 1)).padStart(4, '0')}`,
    entity_type: 'corporate',
    company_number: nextCompanyNumber(),
    category: 'roofers',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

async function send(l, channel, { confirm = true } = {}) {
  const prep = await post('/api/outreach/prepare', { lead_id: l.id, channel, text: 'Hi there' });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  if (confirm) await post(`/api/outreach/${prep.body.event_id}/sent`, {});
}

const ids = async (pile) =>
  (await get(`/api/leads?pile=${pile}`)).body.leads.map((l) => l.id);

let whatsapped;
let texted;
let unsent;
let fresh;

test('setup: four leads, reached four different ways', async () => {
  whatsapped = await lead('Messaged Ltd');
  texted = await lead('Texted Ltd');
  unsent = await lead('Opened Not Sent Ltd');
  fresh = await lead('Untouched Ltd');
  await send(whatsapped, 'whatsapp');
  await send(texted, 'sms');
  await send(unsent, 'whatsapp', { confirm: false });
});

test('a confirmed WhatsApp send moves the lead off Leads', async () => {
  const onLeads = await ids('leads');
  const onWhatsApp = await ids('whatsapp');

  assert.ok(!onLeads.includes(whatsapped.id), 'no longer on Leads');
  assert.ok(onWhatsApp.includes(whatsapped.id), 'on Sent via WhatsApp');

  for (const l of [texted, unsent, fresh]) {
    assert.ok(onLeads.includes(l.id), `${l.business_name} stays on Leads`);
    assert.ok(!onWhatsApp.includes(l.id), `${l.business_name} is not a WhatsApp send`);
  }
});

test('without a pile, the list is every lead, as before', async () => {
  const all = (await get('/api/leads')).body.leads.map((l) => l.id);
  for (const l of [whatsapped, texted, unsent, fresh]) assert.ok(all.includes(l.id));
});

test('each lead says when it went on WhatsApp', async () => {
  const [w] = (await get('/api/leads?pile=whatsapp')).body.leads;
  assert.match(w.whatsapp_sent_at, /^\d{4}-\d{2}-\d{2}T/);
  const f = (await get(`/api/leads/${fresh.id}`)).body.lead;
  assert.equal(f.whatsapp_sent_at, null);
});

test('marking a WhatsApp lead replied, won or lost keeps it on that screen', async () => {
  for (const status of ['replied', 'won', 'lost']) {
    const r = await patch(`/api/leads/${whatsapped.id}`, { status });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await ids('whatsapp')).includes(whatsapped.id), `still there when ${status}`);
    assert.ok(!(await ids('leads')).includes(whatsapped.id));
  }
  await patch(`/api/leads/${whatsapped.id}`, { status: 'sent' });
});

test('setting it back to "awaiting reply" is a correction, not a second approach', async () => {
  const before = ledgerFor(whatsapped);
  assert.equal(before.last_channel, 'whatsapp');
  await patch(`/api/leads/${whatsapped.id}`, { status: 'replied' });
  await patch(`/api/leads/${whatsapped.id}`, { status: 'sent' });
  const after = ledgerFor(whatsapped);
  assert.equal(after.times_contacted, before.times_contacted, 'no extra contact filed');
  assert.equal(after.last_channel, 'whatsapp', 'and the channel is not overwritten');
  assert.equal(after.contacted_at, before.contacted_at, 'nor the date moved');
});

test('each lead carries the number the WhatsApp went to, for the chat link', async () => {
  const w = (await get(`/api/leads/${whatsapped.id}`)).body.lead;
  assert.match(w.whatsapp_to, /^\+447123/);
});

test('the WhatsApp list is ordered by when it was sent, not when the lead was found', async () => {
  // An older lead messaged now goes to the top, so a cap trims the oldest sends.
  const older = await lead('Found Long Ago Ltd');
  db.prepare("UPDATE leads SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(older.id);
  await send(older, 'whatsapp');
  const list = (await get('/api/leads?pile=whatsapp&sort=whatsapp')).body.leads.map((l) => l.id);
  assert.equal(list[0], older.id);
  // Put it back, so the counts below are about the four leads above.
  await post(`/api/leads/${older.id}/whatsapp-unsend`, {});
  await post('/api/leads/bulk-delete', { ids: [older.id] });
});

test('the tiles above each screen count that screen only', async () => {
  const leads = (await get('/api/leads/stats?pile=leads')).body;
  const wa = (await get('/api/leads/stats?pile=whatsapp')).body;
  const all = (await get('/api/leads/stats')).body;

  assert.equal(wa.total, (await ids('whatsapp')).length);
  assert.equal(leads.total, (await ids('leads')).length);
  assert.equal(leads.total + wa.total, all.total, 'the two screens add up to every lead');
  assert.equal(wa.awaiting_reply, 1);
  assert.equal(wa.by_status.sent, 1);
});

test('"Need checking" counts every pile, because Check register checks every pile', async () => {
  const scoped = (await get('/api/leads/stats?pile=leads')).body.unclassified;
  const all = (await get('/api/leads/stats')).body.unclassified;
  assert.equal(scoped, all);
});

test('"Not sent" puts a WhatsApp that never went back on Leads, as not contacted', async () => {
  const oops = await lead('Not On WhatsApp Ltd');
  await send(oops, 'whatsapp');
  assert.ok((await ids('whatsapp')).includes(oops.id));

  const r = await post(`/api/leads/${oops.id}/whatsapp-unsend`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await ids('leads')).includes(oops.id), 'back on Leads');
  assert.ok(!(await ids('whatsapp')).includes(oops.id));
  assert.equal(r.body.lead.status, 'new');
  assert.equal(r.body.lead.contacted_before, false, 'free to approach properly');
  assert.equal(ledgerFor(oops).contacted_at, null);

  assert.equal((await post(`/api/leads/${oops.id}/whatsapp-unsend`, {})).status, 400,
    'nothing to undo a second time');
  await post('/api/leads/bulk-delete', { ids: [oops.id] });
});

test('"Not sent" leaves any other contact on the record', async () => {
  const both = await lead('Texted Then WhatsApped Ltd');
  await send(both, 'sms');
  // The company has been texted already, so a WhatsApp is a deliberate repeat.
  const prep = await post('/api/outreach/prepare',
    { lead_id: both.id, channel: 'whatsapp', text: 'Hi again', allow_repeat: true });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});

  const r = await post(`/api/leads/${both.id}/whatsapp-unsend`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.status, 'sent', 'the text still happened');
  assert.equal(r.body.lead.contacted_before, true);
  assert.ok(ledgerFor(both).contacted_at, 'and the record of it stays');
  await post('/api/leads/bulk-delete', { ids: [both.id] });
});

test('"Not sent" undoes only the latest WhatsApp; one that really went stays on record', async () => {
  const twice = await lead('Messaged Twice Ltd');
  await send(twice, 'whatsapp');                       // really went
  const before = ledgerFor(twice);
  await patch(`/api/leads/${twice.id}`, { status: 'replied' });
  // A follow-up to a reply, confirmed but never actually sent.
  const prep = await post('/api/outreach/prepare', { lead_id: twice.id, channel: 'whatsapp', text: 'Follow up' });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});

  const r = await post(`/api/leads/${twice.id}/whatsapp-unsend`, {});
  assert.equal(r.status, 200);
  assert.ok((await ids('whatsapp')).includes(twice.id), 'the first WhatsApp still counts');
  const after = ledgerFor(twice);
  assert.ok(after.contacted_at, 'the real contact is still on the record');
  assert.equal(after.times_contacted, before.times_contacted);
  assert.equal(r.body.lead.status, 'replied', 'and their reply is not forgotten');
  await post('/api/leads/bulk-delete', { ids: [twice.id] });
});

test('tapping Open and then "I sent it" is one message, not two', async () => {
  const tapped = await lead('Double Tapped Ltd');
  const prep = await post('/api/outreach/prepare', { lead_id: tapped.id, channel: 'whatsapp', text: 'Hi' });
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  assert.equal(ledgerFor(tapped).times_contacted, 1);
  // So "Not sent" puts it fully back, free to approach.
  const r = await post(`/api/leads/${tapped.id}/whatsapp-unsend`, {});
  assert.equal(r.body.lead.contacted_before, false);
  await post('/api/leads/bulk-delete', { ids: [tapped.id] });
});

test('an unknown pile is refused rather than ignored', async () => {
  assert.equal((await get('/api/leads?pile=bogus')).status, 400);
  assert.equal((await get('/api/leads/stats?pile=bogus')).status, 400);
});

test('"Delete all" on the Leads screen leaves the WhatsApp screen alone', async () => {
  const res = await post('/api/leads/bulk-delete', { all: true, pile: 'leads' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await ids('leads'), [], 'Leads is empty');
  assert.deepEqual(await ids('whatsapp'), [whatsapped.id], 'the WhatsApp lead survived');
});
