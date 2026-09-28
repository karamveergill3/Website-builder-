/**
 * A prospect replies on WhatsApp; the answer back is drafted for the rep.
 *
 * WhatsApp keeps its chats to itself, so the reply is pasted in. What comes
 * back must be the right KIND of answer (the questions to a "yes", a price to
 * "how much?", a polite close to "no thanks", nothing at all to "stop"),
 * written the way the openers are (short, no dashes), and signed by the rep
 * who owns the lead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { get, post, put, teardown, nextCompanyNumber } = await import('./helpers.js');
const { classifyReply, draftReply } = await import('../server/lib/reply-draft.js');
const { ASK_DEFAULTS } = await import('../server/lib/ask.js');
const { extractByRules } = await import('../server/lib/brief.js');

test.after(teardown);

const LEAD = { business_name: 'Barlows Window Cleaning Services Ltd', location: 'Stoke-On-Trent' };
const BARLOWS = '1. Barlows Window Cleaning\n2. Ring us\n3. Stoke and Newcastle\n4. No logo, got photos\n5. Blue';
const draftOf = (body, over = {}) => draftReply({
  body, brief: extractByRules(body, LEAD), lead: LEAD, sender: 'Javier',
  ask: ASK_DEFAULTS, prices: { from: 300, monthly: 12 }, ...over,
});
const noDashes = (text) => assert.ok(!/[—–]|\s-\s/.test(text), `a dash crept in:\n${text}`);

/* ------------------------------------------------------ what kind of reply */

test('each kind of reply is recognised', () => {
  const cases = {
    'Yes please go for it': 'yes',
    'Yeah go on then 👍': 'yes',
    "We don't have a website yet, so yes please": 'yes',
    'How much would it cost?': 'price',
    'No thanks, we are fine': 'no',
    'nope': 'no',
    'We already have a website mate': 'has_site',
    "We've got a site already thanks": 'has_site',
    'Stop messaging me': 'stop',
    'STOP': 'stop',
    'Not right now, too busy. Maybe later': 'later',
    [BARLOWS]: 'answers',
    'Sounds interesting, what is this about?': 'other',
  };
  for (const [body, intent] of Object.entries(cases)) {
    assert.equal(classifyReply(body, extractByRules(body, LEAD), LEAD), intent, body);
  }
});

test('"stop by any time" is not a request to stop', () => {
  assert.notEqual(classifyReply('Stop by any time, would love to see it', {}, LEAD), 'stop');
});

/* ------------------------------------------------------------ the answers */

test('a "yes" gets the five questions from the Ask screen, signed by the owner', () => {
  const d = draftOf('Yes please go for it');
  for (const row of ASK_DEFAULTS.questions) assert.ok(d.text.includes(row.q), row.q);
  assert.match(d.text, /\nJavier$/);
  noDashes(d.text);
});

test('answers to the questions are read back, with nothing missing', () => {
  const d = draftOf(BARLOWS);
  assert.equal(d.intent, 'answers');
  assert.match(d.text, /Name on the site: Barlows Window Cleaning/);
  assert.match(d.text, /Main thing visitors do: call you/);
  assert.match(d.text, /Areas: .*Stoke.*Newcastle/);
  assert.match(d.text, /Logo: no worries/);
  assert.match(d.text, /Photos: brilliant/);
  assert.match(d.text, /Colours: blue/);
  assert.ok(!/one more thing|couple more/i.test(d.text), 'every question was answered');
  assert.match(d.text, /mock up over to you/);
  assert.deepEqual(d.actions.map((a) => a.id), ['build']);
  noDashes(d.text);
});

test('whatever they left out is asked again, in the Ask screen’s words', () => {
  const d = draftOf('1. Barlows Window Cleaning\n2. Ring us\n3. Stoke and Newcastle\n4. Got photos');
  assert.match(d.text, /Just one more thing: Any brand colours you like\?/);
});

test('"how much?" gets the free mock up and the starting prices', () => {
  const d = draftOf('How much would it cost?');
  assert.match(d.text, /completely free/);
  assert.match(d.text, /£300/);
  assert.match(d.text, /£12 a month/);
  noDashes(d.text);
  const both = draftOf('Yes please, how much is it though?');
  assert.ok(both.text.includes(ASK_DEFAULTS.questions[0].q), 'a yes with a price question also gets the questions');
});

test('no, later, has a site and stop each get the right close', () => {
  const no = draftOf('No thanks');
  assert.match(no.text, /won't message again/);
  assert.deepEqual(no.actions.map((a) => a.id), ['optout']);
  assert.match(draftOf('Not right now').text, /No rush/);
  const site = draftOf('We already have a website');
  assert.deepEqual(site.actions.map((a) => a.id), ['has-site']);
  const stop = draftOf('Stop messaging me');
  assert.equal(stop.text, '', 'nothing is sent to someone who said stop');
  for (const d of [no, site]) noDashes(d.text);
});

test('the mock up message carries its link', () => {
  const d = draftOf('anything', { kind: 'mockup', mockupUrl: 'https://app.example/m/abc123/' });
  assert.match(d.text, /https:\/\/app\.example\/m\/abc123\//);
  noDashes(d.text);
});

/* ------------------------------------------ reading answers to the Ask order */

test('the brief is read in the Ask screen’s order: name, action, areas, logo and photos, colours', () => {
  const b = extractByRules(BARLOWS, LEAD);
  assert.equal(b.trading_name, 'Barlows Window Cleaning');
  assert.equal(b.primary_cta, 'call');
  assert.ok(b.areas.includes('Stoke') && b.areas.includes('Newcastle'), JSON.stringify(b.areas));
  assert.equal(b.has_logo, false);
  assert.equal(b.has_photos, true, '"No logo, got photos": the no is about the logo');
  assert.deepEqual(b.brand_colours, ['blue']);
});

test('the server’s copy of the Ask questions matches the Ask screen’s', () => {
  const screen = readFileSync(new URL('../public/js/views/phase2.js', import.meta.url), 'utf8');
  for (const row of ASK_DEFAULTS.questions) assert.ok(screen.includes(row.q), row.q);
  assert.ok(screen.includes(ASK_DEFAULTS.intro));
  assert.ok(screen.includes(ASK_DEFAULTS.outro));
});

/* --------------------------------------------------------------- the routes */

async function lead(name, over = {}) {
  const r = await post('/api/leads', {
    business_name: name, location: 'Stoke-On-Trent', phone: '07936 103926',
    entity_type: 'corporate', company_number: nextCompanyNumber(), category: 'window cleaner', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

test('pasting a reply returns the drafted answer, signed by the lead’s owner', async () => {
  await put('/api/settings', { biz_name: 'Keylo Studios' });
  const cailan = (await post('/api/auth/users', {
    name: 'cailan jassal', email: 'cailan.draft@test.example', password: 'rep-pass-123', role: 'rep',
  })).body.user;
  const l = await lead('Barlows Window Cleaning Services Ltd', { assigned_to: cailan.id });

  const r = await post('/api/replies/manual', { lead_id: l.id, channel: 'whatsapp', body: 'Yes please!' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.draft.intent, 'yes');
  assert.match(r.body.draft.text, /\nCailan$/, 'signed by the owner: capitalised, first name only');
  assert.equal(r.body.draft.wa_number, '447936103926', 'ready to open in WhatsApp');

  const again = await get(`/api/replies/${r.body.reply_id}/draft`);
  assert.equal(again.body.draft.text, r.body.draft.text);
});

test('"stop" opts them out on the spot, and nothing is drafted', async () => {
  const l = await lead('Stop Please Ltd');
  const r = await post('/api/replies/manual', { lead_id: l.id, channel: 'whatsapp', body: 'Stop messaging me' });
  assert.equal(r.body.draft.intent, 'stop');
  assert.equal(r.body.draft.text, '');
  const after = (await get(`/api/leads/${l.id}`)).body.lead;
  assert.equal(after.opted_out, true);
  assert.equal(after.status, 'lost');
});

test('answers, then build, then the mock up message with a full link', async () => {
  const l = await lead('Mockup Flow Ltd');
  const r = await post('/api/replies/manual', {
    lead_id: l.id, channel: 'whatsapp', body: BARLOWS, origin: 'https://app.example',
  });
  assert.equal(r.body.draft.intent, 'answers');
  const built = await post('/api/mockups', { reply_id: r.body.reply_id });
  assert.ok([200, 201].includes(built.status), JSON.stringify(built.body));
  const m = await get(`/api/replies/${r.body.reply_id}/draft?kind=mockup&origin=https://app.example`);
  assert.match(m.body.draft.text, /https:\/\/app\.example\/m\/[a-z0-9]+\//i);
});

test('"we have a website" can be recorded on the lead in one click', async () => {
  const l = await lead('Got A Site Ltd');
  const r = await post(`/api/leads/${l.id}/has-website`, {});
  assert.equal(r.status, 200);
  const after = (await get(`/api/leads/${l.id}`)).body.lead;
  assert.equal(after.has_website, 1);
  assert.equal(after.status, 'lost');
});
