/**
 * Replies pasted out of WhatsApp.
 *
 * There is no free way for the site to read WhatsApp, so a reply comes in by
 * copy and paste: select their messages on WhatsApp Desktop, Ctrl+C, Ctrl+V
 * on the Sent via WhatsApp screen. Copied that way, each message carries who
 * sent it, and for a prospect not saved in the phone that is their number.
 * These pin:
 *
 *   - the three layouts WhatsApp copies and exports in are all read
 *   - the number finds the lead, with nobody choosing it
 *   - our own messages in the paste are left out; only theirs since our last
 *     one is what gets answered
 *   - pasting the same messages again files nothing twice
 *   - when the paste cannot say whose it is, the rep is asked, and a number
 *     they confirm is remembered
 *   - "stop" is honoured the moment it is filed
 *   - nothing is ever sent
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Nothing listens here, so no brief ever waits on a local model.
process.env.OLLAMA_HOST = '127.0.0.1:1';

const { parseWhatsApp, theirSide, nameFit, senderPhone } = await import('../server/lib/wa-paste.js');
const { get, post, req, teardown, nextCompanyNumber } = await import('./helpers.js');
const { db } = await import('../server/db.js');

test.after(teardown);

/* ------------------------------------------------------------ reading */

test('WhatsApp Desktop copy: their messages, our messages, and a message over two lines', () => {
  const p = parseWhatsApp(`[16:58, 15/06/2025] Keylo Studios: Hi, my name is Cailan from Keylo Studios.
[17:05, 15/06/2025] +44 7700 900123: Yes please
that would be great
[17:06, 15/06/2025] +44 7700 900123: How much is it?`);
  assert.equal(p.headed, true);
  assert.equal(p.messages.length, 3);
  const [ours, one, two] = p.messages;
  assert.equal(ours.sender, 'Keylo Studios');
  assert.equal(one.phone, '+447700900123');
  assert.equal(one.text, 'Yes please\nthat would be great');
  // 17:05 in June is British Summer Time: 16:05 UTC.
  assert.equal(one.at, '2025-06-15T16:05:00.000Z');
  assert.equal(two.text, 'How much is it?');
});

test('iPhone export: invisible marks, seconds, odd spaces and WhatsApp’s own notices', () => {
  const p = parseWhatsApp([
    '‎[15/01/2025, 09:30:12] Perfect Paws: ‎Messages and calls are end-to-end encrypted.',
    '[15/01/2025, 09:31:40] Perfect Paws: Morning, yes please',
    '‎[15/01/2025, 09:32:02] Perfect Paws: ‎image omitted',
  ].join('\n'));
  assert.deepEqual(p.messages.map((m) => m.text), ['Morning, yes please', '[a photo]']);
  // January is GMT: no shift.
  assert.equal(p.messages[0].at, '2025-01-15T09:31:40.000Z');
  assert.equal(p.messages[0].phone, null, 'a saved contact is a name, not a number');
});

test('Android export: 12 hour times, notices with no sender, media left out', () => {
  const p = parseWhatsApp([
    '15/06/2025, 5:04 pm - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
    '15/06/2025, 5:05 pm - +44 7700 900123: Yes',
    '<Media omitted>',
    '15/06/2025, 5:07 pm - +44 7700 900123: <Media omitted>',
  ].join('\n'));
  assert.deepEqual(p.messages.map((m) => m.text), ['Yes\n[a photo or file]', '[a photo or file]']);
  assert.equal(p.messages[0].at, '2025-06-15T16:05:00.000Z');
});

test('a single message copied on its own has no header, and is taken whole', () => {
  const p = parseWhatsApp('Yes please, how much would it be?');
  assert.equal(p.headed, false);
  assert.deepEqual(p.messages, [{ sender: null, phone: null, at: null, text: 'Yes please, how much would it be?' }]);
});

test('a time in the future is not trusted', () => {
  const p = parseWhatsApp('[09:00, 01/01/2099] +44 7700 900123: hello');
  assert.equal(p.messages[0].at, null);
});

test('only their messages since our last one are answered; if we had the last word, their last run', () => {
  const p = parseWhatsApp(`[10:00, 15/06/2025] +44 7700 900123: Who is this?
[10:01, 15/06/2025] Karam: Karam from Keylo Studios
[10:02, 15/06/2025] +44 7700 900123: Oh right
[10:02, 15/06/2025] +44 7700 900123: Go on then`);
  const them = (m) => m.phone === '+447700900123';
  let side = theirSide(p.messages, (m) => !them(m));
  assert.deepEqual(side.latest['+447700900123'].map((m) => m.text), ['Oh right', 'Go on then']);

  const answered = parseWhatsApp(`[10:00, 15/06/2025] +44 7700 900123: Yes
[10:00, 15/06/2025] +44 7700 900123: Please
[10:01, 15/06/2025] Karam: Great, what's your trading name?`);
  side = theirSide(answered.messages, (m) => !them(m));
  assert.deepEqual(side.latest['+447700900123'].map((m) => m.text), ['Yes', 'Please']);
});

test('a saved contact name is matched to a business by its own words', () => {
  assert.ok(nameFit('Dave Perfect Paws', 'Perfect Paws Burton Ltd') >= 0.66);
  assert.equal(nameFit('Mum', 'Perfect Paws Burton Ltd'), 0);
  assert.equal(nameFit('Services Ltd', 'Hillside Services Ltd'), 0, 'filler words prove nothing');
  assert.equal(senderPhone('+44 7700 900123'), '+447700900123');
  assert.equal(senderPhone('Dave'), null);
});

/* ------------------------------------------------------------- filing */

let seq = 0;
const number = () => {
  seq += 1;
  const tail = String(900000 + seq).padStart(6, '0');
  return { national: `07700 ${tail}`, e164: `+447700${tail}`, shown: `+44 7700 ${tail}` };
};

async function lead(name, phone, { whatsapp = true } = {}) {
  const r = await post('/api/leads', {
    business_name: name,
    location: 'Burton upon Trent',
    phone: phone.national,
    entity_type: 'corporate',
    company_number: nextCompanyNumber(),
    category: 'dog groomers',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (whatsapp) {
    const prep = await post('/api/outreach/prepare', { lead_id: r.body.lead.id, channel: 'whatsapp', text: 'Hi there' });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    await post(`/api/outreach/${prep.body.event_id}/sent`, {});
  }
  return r.body.lead;
}

const paste = (text, extra = {}) => post('/api/replies/whatsapp-paste', { text, ...extra });
const repliesFor = (id) => db.prepare('SELECT * FROM replies WHERE lead_id = ? ORDER BY id').all(id);

test('a paste finds its own lead by number, leaves our messages out, and drafts the answer', async () => {
  const phone = number();
  const l = await lead('Perfect Paws Burton Ltd', phone);
  const r = await paste(`[16:58, 15/06/2025] Keylo Studios: Hi, my name is Javier from Keylo Studios.
[17:05, 15/06/2025] ${phone.shown}: Yes please
[17:06, 15/06/2025] ${phone.shown}: How much is it?`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.filed, true);
  assert.equal(r.body.lead.id, l.id);
  assert.equal(r.body.messages, 2);

  const [reply] = repliesFor(l.id);
  assert.equal(reply.channel, 'whatsapp');
  assert.equal(reply.body, 'Yes please\nHow much is it?', 'our opener is not filed as theirs');
  assert.equal(reply.received_at, '2025-06-15T16:06:00.000Z');
  assert.equal(reply.thread_id, phone.e164);

  assert.equal(r.body.draft.intent, 'price');
  assert.equal(r.body.draft.wa_number, phone.e164.slice(1), 'the answer goes back to the chat it came from');
  assert.equal((await get(`/api/leads/${l.id}`)).body.lead.status, 'replied');
});

test('the same paste again files nothing; a longer one files only what is new', async () => {
  const phone = number();
  const l = await lead('Bark Avenue Ltd', phone);
  const first = `[09:00, 16/06/2025] ${phone.shown}: Yes please`;
  assert.equal((await paste(first)).status, 201);

  const again = await paste(first);
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.ok(again.body.draft.text, 'the answer is shown again');
  assert.equal(repliesFor(l.id).length, 1);

  const more = await paste(`${first}\n[09:10, 16/06/2025] ${phone.shown}: We're called Bark Avenue`);
  assert.equal(more.status, 201);
  assert.equal(more.body.messages, 1);
  const rows = repliesFor(l.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].body, "We're called Bark Avenue");
});

test('a number on no lead: the rep is asked, and the number is remembered after', async () => {
  const known = number();
  const l = await lead('Wagging Tails Ltd', known);
  const other = number();   // they replied from a different phone

  const ask = await paste(`[11:00, 16/06/2025] ${other.shown}: Is this about the website?`);
  assert.equal(ask.status, 200);
  assert.equal(ask.body.need_lead, true);
  assert.equal(ask.body.reason, 'unknown-number');
  assert.equal(ask.body.sender.phone, other.e164);
  assert.match(ask.body.preview, /website/);
  assert.ok(ask.body.candidates.some((c) => c.id === l.id), 'recently messaged leads are offered');

  const filed = await paste(`[11:00, 16/06/2025] ${other.shown}: Is this about the website?`, { lead_id: l.id });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.lead.id, l.id);

  const next = await paste(`[11:30, 16/06/2025] ${other.shown}: Yes go on then`);
  assert.equal(next.status, 201, 'the number now finds the lead by itself');
  assert.equal(next.body.lead.id, l.id);
});

test('a single message with no header asks whose it is, then files it', async () => {
  const phone = number();
  const l = await lead('Muddy Paws Ltd', phone);
  const ask = await paste('Yes please');
  assert.equal(ask.body.need_lead, true);
  assert.equal(ask.body.reason, 'no-header');

  const filed = await paste('Yes please', { lead_id: l.id });
  assert.equal(filed.status, 201);
  assert.equal(repliesFor(l.id)[0].body, 'Yes please');
  assert.equal(filed.body.draft.wa_number, phone.e164.slice(1));
});

test('a saved contact name offers the lead it fits first', async () => {
  const phone = number();
  const l = await lead('Scruffy Dog Grooming Ltd', phone);
  const ask = await paste('[12:00, 16/06/2025] Sarah Scruffy Dog: Yes please');
  assert.equal(ask.body.need_lead, true);
  assert.equal(ask.body.reason, 'name');
  assert.equal(ask.body.candidates[0].id, l.id);
  assert.ok(ask.body.candidates[0].fit > 0);
});

test('a lead never messaged through the site is still found by its own phone', async () => {
  const phone = number();
  const l = await lead('Posh Paws Ltd', phone, { whatsapp: false });
  const r = await paste(`[13:00, 16/06/2025] ${phone.shown}: Who gave you my number?`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.lead.id, l.id);
});

test('one number on two leads, never messaged: the rep chooses', async () => {
  const phone = number();
  const a = await lead('Twin Groomers Ltd', phone, { whatsapp: false });
  const b = await lead('Twin Groomers Mobile Ltd', phone, { whatsapp: false });
  const r = await paste(`[14:00, 16/06/2025] ${phone.shown}: Yes`);
  assert.equal(r.body.need_lead, true);
  assert.equal(r.body.reason, 'several');
  assert.deepEqual(r.body.candidates.slice(0, 2).map((c) => c.id).sort(), [a.id, b.id].sort());
});

test('"stop" is honoured the moment it is filed', async () => {
  const phone = number();
  const l = await lead('Stop Please Ltd', phone);
  const r = await paste(`[15:00, 16/06/2025] ${phone.shown}: Stop`);
  assert.equal(r.status, 201);
  assert.equal(r.body.draft.intent, 'stop');
  const after = (await get(`/api/leads/${l.id}`)).body.lead;
  assert.equal(after.opted_out, true);
  assert.equal(after.status, 'lost');
});

test('a paste of only our own messages files nothing', async () => {
  const phone = number();
  await lead('Only Ours Ltd', phone);
  const r = await paste('[16:00, 16/06/2025] Test Admin: Just checking in');
  assert.equal(r.status, 400);
});

test('the WhatsApp screen shows what they said last, with its reply to draft from', async () => {
  const phone = number();
  const l = await lead('Latest Word Ltd', phone);
  const r = await paste(`[17:00, 16/06/2025] ${phone.shown}: Can you do Saturday?`);
  const row = (await get('/api/leads?pile=whatsapp&limit=1000')).body.leads.find((x) => x.id === l.id);
  assert.equal(row.last_reply, 'Can you do Saturday?');
  assert.equal(row.last_reply_id, r.body.reply_id);
  const drafted = await get(`/api/replies/${r.body.reply_id}/draft`);
  assert.equal(drafted.status, 200);
  assert.ok(drafted.body.draft.text);
});

test('nothing is sent: a paste writes no send record and no email', async () => {
  const phone = number();
  const l = await lead('Nothing Sent Ltd', phone);
  const before = {
    events: db.prepare('SELECT COUNT(*) AS n FROM outreach_events WHERE lead_id = ?').get(l.id).n,
    mail: db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n,
  };
  await paste(`[18:00, 16/06/2025] ${phone.shown}: Sounds good`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outreach_events WHERE lead_id = ?').get(l.id).n, before.events);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n, before.mail);
});

/* ------------------------------------------------ review fixes (round 1) */

test('reading: a line of times inside a message stays in it, and emoji keep their joins', () => {
  const p = parseWhatsApp('[17:05, 27/09/2025] +44 7700 900123: I can do any of these\n30/09/25 10.00 - 12.00\nwhichever suits');
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].text, 'I can do any of these\n30/09/25 10.00 - 12.00\nwhichever suits');
  const shrug = '\u{1F937}‍♂️';
  assert.equal(parseWhatsApp(`[17:05, 27/09/2025] +44 7700 900123: ${shrug} no idea`).messages[0].text, `${shrug} no idea`);
});

test('"stop" among other messages still opts them out', async () => {
  const phone = number();
  const l = await lead('Stop Among Others Ltd', phone);
  const r = await paste(`[15:00, 16/06/2025] ${phone.shown}: Who is this?\n[15:01, 16/06/2025] ${phone.shown}: Stop`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.stopped, true);
  assert.equal((await get(`/api/leads/${l.id}`)).body.lead.opted_out, true);
});

test('"stop" from a number opts out every business that number is on', async () => {
  const phone = number();
  const a = await lead('Shared Number One Ltd', phone);
  const b = await lead('Shared Number Two Ltd', phone, { whatsapp: false });
  const r = await paste(`[10:00, 20/06/2025] ${phone.shown}: Stop`);
  assert.equal(r.status, 201);
  assert.equal((await get(`/api/leads/${a.id}`)).body.lead.opted_out, true);
  assert.equal((await get(`/api/leads/${b.id}`)).body.lead.opted_out, true);
});

test('a paste from one business\'s number is not filed under another', async () => {
  const phoneA = number();
  const a = await lead('Right Business Ltd', phoneA);
  const b = await lead('Wrong Row Ltd', number());
  const r = await paste(`[15:00, 16/06/2025] ${phoneA.shown}: Stop`, { lead_id: b.id });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Right Business Ltd/);
  assert.equal(repliesFor(b.id).length, 0);
  assert.equal((await get(`/api/leads/${b.id}`)).body.lead.opted_out, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contact_signals WHERE lead_id = ? AND kind = 'whatsapp'").get(b.id).n, 0);
  assert.equal(repliesFor(a.id).length, 0, 'nothing filed anywhere until the rep chooses');
});

test('our own message under a name we do not know is not filed as theirs', async () => {
  const l = await lead('Dave The Plumber Ltd', number());
  const r = await paste(`[16:58, 15/06/2025] Kam: Hi Dave, it's Kam. I made you a free website mock up, want to see it?
[17:05, 15/06/2025] Dave Plumber: Yes please, how much?`, { lead_id: l.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(repliesFor(l.id).at(-1).body, 'Yes please, how much?');
  assert.equal(r.body.draft.intent, 'price');
});

test('the same short reply on a later day is filed again; pasted twice in a row it is not', async () => {
  const l = await lead('Yes Again Ltd', number());
  assert.equal((await paste('Yes', { lead_id: l.id })).status, 201);
  assert.equal((await paste('Yes', { lead_id: l.id })).body.already, true, 'a double paste files once');
  // A day later they say "Yes" to something new.
  db.prepare("UPDATE wa_paste_seen SET seen_at = '2020-01-01T00:00:00.000Z' WHERE lead_id = ?").run(l.id);
  assert.equal((await paste('Yes', { lead_id: l.id })).status, 201);
  assert.equal(repliesFor(l.id).length, 2);
});

test('a message pasted on its own and later with its header is filed once', async () => {
  const phone = number();
  const l = await lead('Both Ways Ltd', phone);
  assert.equal((await paste('Can you do Saturday?', { lead_id: l.id })).status, 201);
  const now = new Date(Date.now() - 60_000);
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  const again = await paste(`[${hhmm}, ${date}] ${phone.shown}: Can you do Saturday?`);
  assert.equal(again.body.already, true, JSON.stringify(again.body));
  assert.equal(repliesFor(l.id).length, 1);
});

test('a number confirmed by the rep is trusted even if a directory listed it first', async () => {
  const l = await lead('Directory Listed Ltd', number());
  const other = number();
  db.prepare(`INSERT INTO contact_signals (lead_id, kind, value, source, confidence, first_seen_at, last_seen_at)
              VALUES (?, 'whatsapp', ?, 'web:www.yell.com', 85, ?, ?)`).run(l.id, other.e164, 'x', 'x');
  assert.equal((await paste(`[09:00, 16/06/2025] ${other.shown}: Yes please`)).body.need_lead, true);
  assert.equal((await paste(`[09:00, 16/06/2025] ${other.shown}: Yes please`, { lead_id: l.id })).status, 201);
  const next = await paste(`[09:10, 16/06/2025] ${other.shown}: How much is it?`);
  assert.equal(next.status, 201, 'matched by itself now');
  assert.equal(next.body.lead.id, l.id);
});

/* ------------------------------------------------------- read, then file */

const read = (text, extra = {}) => post('/api/replies/whatsapp-read', { text, ...extra });

test('reading a paste saves nothing: it says whose it is and drafts the answer', async () => {
  const phone = number();
  const l = await lead('Read Only Grooming Ltd', phone);
  const before = repliesFor(l.id).length;
  const r = await read(`[10:00, 17/06/2025] ${phone.shown}: How much would it be?`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lead.id, l.id);
  assert.equal(r.body.how, 'number');
  assert.equal(r.body.sure, true);
  assert.equal(r.body.their_text, 'How much would it be?');
  assert.equal(r.body.draft.intent, 'price');
  assert.ok(r.body.draft.text);
  assert.equal(repliesFor(l.id).length, before, 'nothing filed by reading');
  assert.equal((await get(`/api/leads/${l.id}`)).body.lead.status, 'sent');
});

test('with no number, what the message says picks the business, as a guess to check', async () => {
  const l = await lead('Zebedee Grooming Parlour Ltd', number());
  const r = await read("Hi, it's Zebedee Grooming here, yes please go ahead");
  assert.equal(r.body.lead.id, l.id);
  assert.equal(r.body.how, 'text');
  assert.equal(r.body.sure, false);
  assert.match(r.body.why, /zebedee/i);
  assert.ok(r.body.candidates.some((c) => c.id === l.id));
});

test('with nothing to go on, the latest business messaged is offered, and the rep can change it', async () => {
  const l = await lead('Most Recent Send Ltd', number());
  const r = await read('Sounds good to me');
  assert.equal(r.body.how, 'recent');
  assert.equal(r.body.lead.id, l.id);
  assert.equal(r.body.sure, false);
  const other = r.body.candidates.find((c) => c.id !== l.id);
  const chosen = await read('Sounds good to me', { lead_id: other.id });
  assert.equal(chosen.body.lead.id, other.id);
  assert.equal(chosen.body.how, 'chosen');
  assert.equal(chosen.body.draft.lead_id, other.id);
});

test('a reply can be deleted; with none left they are back to awaiting a reply', async () => {
  const phone = number();
  const l = await lead('Deleted Reply Ltd', phone);
  const r = await paste(`[10:00, 18/06/2025] ${phone.shown}: Wrong person, sorry`);
  assert.equal((await get(`/api/leads/${l.id}`)).body.lead.status, 'replied');
  const del = await req('DELETE', `/api/replies/${r.body.reply_id}`);
  assert.equal(del.status, 204);
  assert.equal(repliesFor(l.id).length, 0);
  assert.equal((await get(`/api/leads/${l.id}`)).body.lead.status, 'sent');
  assert.equal((await req('DELETE', `/api/replies/${r.body.reply_id}`)).status, 404);
  // Its messages are no longer "already filed": pasted again, it files.
  assert.equal((await paste(`[10:00, 18/06/2025] ${phone.shown}: Wrong person, sorry`)).status, 201);
});
