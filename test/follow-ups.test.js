/**
 * WhatsApp follow-ups, each with a mock up of their site already built.
 *
 *   - the first WhatsApp builds their mock up, so it is ready by the time a
 *     follow-up is due
 *   - a follow-up comes due 3 days after the last message, twice at most
 *     (Settings), and nothing lets one go early or a third go at all
 *   - the first carries the mock up's link; the second checks they saw it
 *   - it goes to the chat the first message went to
 *   - a reply, an opt-out or a lost lead stops them
 *   - the one-approach rule still holds for everything that isn't a due follow-up
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OLLAMA_HOST = '127.0.0.1:1';

const { get, post, put, patch, base, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');

test.after(teardown);

const ORIGIN = 'https://keylo.example';
const DAY = 86_400_000;

/** A lead messaged on WhatsApp `daysAgo` days ago (the send backdated). */
async function messaged(name, phone, daysAgo = 0, category = 'dog groomer') {
  const r = await post('/api/leads', {
    business_name: name, location: 'Burton', phone, entity_type: 'corporate',
    company_number: nextCompanyNumber(), category,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const prep = await post('/api/outreach/prepare', { lead_id: r.body.lead.id, channel: 'whatsapp', text: 'Hi there' });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  if (daysAgo) backdate(r.body.lead.id, daysAgo);
  return r.body.lead;
}

/** Move every WhatsApp sent to this lead `days` further into the past. */
function backdate(leadId, days) {
  for (const e of db.prepare(
    "SELECT id, confirmed_sent_at FROM outreach_events WHERE lead_id = ? AND confirmed_sent_at IS NOT NULL"
  ).all(leadId)) {
    const at = new Date(Date.parse(e.confirmed_sent_at) - days * DAY).toISOString();
    db.prepare('UPDATE outreach_events SET confirmed_sent_at = ? WHERE id = ?').run(at, e.id);
  }
}

const leadOf = async (id) => (await get(`/api/leads/${id}`)).body.lead;

/** Draft, prepare, and confirm one follow-up. */
async function followUp(id) {
  const draft = await post(`/api/leads/${id}/follow-up`, { origin: ORIGIN });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const prep = await post('/api/outreach/prepare', {
    lead_id: id, channel: 'whatsapp', text: draft.body.text, follow_up: true, mockup_id: draft.body.mockup.id,
  });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  return { draft: draft.body, prep: prep.body };
}

test('the first WhatsApp builds their mock up, ready before any follow-up is due', async () => {
  const l = await messaged('Perfect Paws Ltd', '07700 950001');
  const lead = await leadOf(l.id);
  assert.ok(lead.mockup_token, 'built on the send');
  const page = await fetch(`${base}/m/${lead.mockup_token}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Perfect Paws/);
  assert.match(html, /<meta property="og:title" content="Perfect Paws/, 'WhatsApp shows their name under the link');
  assert.equal(lead.follow_up.state, 'waiting');
  assert.equal(lead.follow_up_due, false);
});

test('not due for 3 days: nothing lets it go early', async () => {
  const l = await messaged('Early Bird Grooming Ltd', '07700 950002', 2);
  const draft = await post(`/api/leads/${l.id}/follow-up`, { origin: ORIGIN });
  assert.equal(draft.status, 422);
  assert.equal(draft.body.code, 'NOT_DUE');
  assert.match(draft.body.error, /due on/);
  const prep = await post('/api/outreach/prepare', { lead_id: l.id, channel: 'whatsapp', text: 'Hi again', follow_up: true });
  assert.equal(prep.status, 422);
  assert.equal(prep.body.code, 'NOT_DUE');
  // And a plain second WhatsApp is still the second cold approach it always was.
  const again = await post('/api/outreach/prepare', { lead_id: l.id, channel: 'whatsapp', text: 'Hi again' });
  assert.equal(again.status, 422);
  assert.equal(again.body.code, 'ALREADY_CONTACTED');
});

test('due after 3 days: the first follow-up carries the mock up link, to the same chat', async () => {
  const l = await messaged('Waggy Tails Ltd', '07700 950003', 3);
  const before = await leadOf(l.id);
  assert.equal(before.follow_up_due, true);
  assert.equal(before.follow_up.state, 'due');

  const due = (await get('/api/leads/follow-ups')).body;
  assert.ok(due.due.some((d) => d.id === l.id));
  assert.ok(due.mine >= 1, 'an unassigned lead counts as yours');

  // Their number changes after the first message: the follow-up still goes
  // to the chat the first one did.
  db.prepare("UPDATE leads SET phone = '07700 959999' WHERE id = ?").run(l.id);

  const { draft, prep } = await followUp(l.id);
  assert.equal(draft.template_name, 'Follow-up — WhatsApp');
  assert.equal(draft.mockup.token, before.mockup_token, 'the mock up built on the first send, not a new one');
  assert.ok(draft.text.includes(`${ORIGIN}/m/${before.mockup_token}/`), draft.text);
  assert.match(draft.text, /Waggy Tails/);
  assert.match(draft.text, /No pressure at all\./);
  assert.doesNotMatch(draft.text, /\{\{|—/, 'every placeholder filled, no dashes');
  assert.equal(prep.e164, '+447700950003');

  const ev = db.prepare('SELECT kind, mockup_id FROM outreach_events WHERE id = ?').get(prep.event_id);
  assert.equal(ev.kind, 'follow_up');
  assert.equal(ev.mockup_id, draft.mockup.id);
  assert.ok(db.prepare('SELECT sent_at FROM mockups WHERE id = ?').get(draft.mockup.id).sent_at);

  const after = await leadOf(l.id);
  assert.equal(after.status, 'sent', 'still waiting on them');
  assert.equal(after.follow_up.state, 'waiting', 'the next is 3 days from this one');
  assert.equal(after.follow_up.sent, 1);
  assert.ok(Date.parse(after.follow_up.at) > Date.now() + 2 * DAY);
});

test('the second checks they saw it, and after that they are left alone', async () => {
  const l = await messaged('Two Step Grooming Ltd', '07700 950004', 3);
  await followUp(l.id);
  backdate(l.id, 3);
  const second = await followUp(l.id);
  assert.equal(second.draft.template_name, 'Follow-up 2 — WhatsApp');
  assert.match(second.draft.text, /Just checking you saw the mock up/);

  backdate(l.id, 10);
  const lead = await leadOf(l.id);
  assert.equal(lead.follow_up.state, 'done');
  assert.equal(lead.follow_up_due, false);
  const third = await post(`/api/leads/${l.id}/follow-up`, { origin: ORIGIN });
  assert.equal(third.status, 422);
  assert.match(third.body.error, /2 follow-ups already/);
});

test('a reply, an opt-out or a lost lead stops them', async () => {
  const replied = await messaged('Answered Ltd', '07700 950005', 5);
  await post('/api/replies/whatsapp-paste', {
    text: '[10:00, 18/06/2025] +44 7700 950005: Who is this?', lead_id: replied.id,
  });
  const optedOut = await messaged('Opted Out Ltd', '07700 950006', 5);
  db.prepare('UPDATE leads SET opted_out = 1 WHERE id = ?').run(optedOut.id);
  const lost = await messaged('Lost Ltd', '07700 950007', 5);
  assert.equal((await patch(`/api/leads/${lost.id}`, { status: 'lost' })).status, 200);

  const due = (await get('/api/leads/follow-ups')).body.due.map((d) => d.id);
  for (const l of [replied, optedOut, lost]) {
    assert.ok(!due.includes(l.id), `${l.business_name} is not due`);
    const r = await post(`/api/leads/${l.id}/follow-up`, { origin: ORIGIN });
    assert.equal(r.status, 422, l.business_name);
  }
});

test('Settings: how many days, and how many at most (0 turns them off)', async () => {
  const l = await messaged('Settings Check Ltd', '07700 950008', 4);
  assert.equal((await leadOf(l.id)).follow_up_due, true);

  assert.equal((await put('/api/settings', { followup_days: '5' })).status, 200);
  assert.equal((await leadOf(l.id)).follow_up_due, false, '4 days is not 5');

  assert.equal((await put('/api/settings', { followup_days: '3', followup_max: '0' })).status, 200);
  assert.equal((await leadOf(l.id)).follow_up, null, 'turned off');
  assert.ok(!(await get('/api/leads/follow-ups')).body.due.some((d) => d.id === l.id));

  assert.equal((await put('/api/settings', { followup_days: '0' })).status, 400);
  assert.equal((await put('/api/settings', { followup_max: '2' })).status, 200);
});

test('a follow-up only by WhatsApp, and only with their own mock up', async () => {
  const l = await messaged('Guard Rails Ltd', '07700 950009', 3);
  const other = await messaged('Someone Else Ltd', '07700 950010');
  const sms = await post('/api/outreach/prepare', { lead_id: l.id, channel: 'sms', text: 'Hi', follow_up: true });
  assert.equal(sms.status, 400);
  const theirs = (await leadOf(other.id)).mockup_token;
  const id = db.prepare('SELECT id FROM mockups WHERE token = ?').get(theirs).id;
  const wrong = await post('/api/outreach/prepare', {
    lead_id: l.id, channel: 'whatsapp', text: 'Hi', follow_up: true, mockup_id: id,
  });
  assert.equal(wrong.status, 400);
});

test('"it never sent" on a follow-up undoes only the follow-up', async () => {
  const l = await messaged('Undo Follow Ltd', '07700 950011', 3);
  await followUp(l.id);
  const r = await post(`/api/leads/${l.id}/whatsapp-unsend`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const lead = r.body.lead;
  assert.ok(lead.whatsapp_sent_at, 'still on the WhatsApp screen: the first message went');
  assert.equal(lead.status, 'sent');
  assert.equal(lead.follow_up_due, true, 'due again');
});

test('when they reply, the Replies screen shows the mock up already built', async () => {
  const l = await messaged('Reply Shows Mockup Ltd', '07700 950012', 3);
  const token = (await leadOf(l.id)).mockup_token;
  await post('/api/replies/whatsapp-paste', {
    text: '[10:00, 18/06/2025] +44 7700 950012: Looks good, how much would it be?', lead_id: l.id,
  });
  const reply = (await get('/api/replies')).body.replies.find((x) => x.lead_id === l.id);
  assert.equal(reply.mockup?.token, token);
});

test('both follow-up messages are shipped and seeded', async () => {
  const names = (await get('/api/templates')).body.templates.map((t) => t.name);
  assert.ok(names.includes('Follow-up — WhatsApp'));
  assert.ok(names.includes('Follow-up 2 — WhatsApp'));
});
