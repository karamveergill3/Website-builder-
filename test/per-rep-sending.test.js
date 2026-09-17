/**
 * Each rep sends from their own mailbox.
 *
 * On a one-person hub every email goes out from the single address in
 * Settings. On a team that is wrong twice over: the business being contacted
 * replies to whoever is on the From line, and a reply to Cailan's message
 * landing in Karam's inbox is how a lead goes cold. So a rep with their own
 * address on the business domain sends as themselves.
 *
 * The rules these tests pin down:
 *
 *   - the address is stored per user, validated, and clearable
 *   - a message goes out as whoever QUEUED it, read at send time, so a queue
 *     row that waits overnight is still theirs
 *   - a rep with no address of their own falls back to the shared identity —
 *     name AND address together, never a mix, because "Cailan <karam@...>"
 *     reads as spoofing
 *   - {{my_email}} in the body names the same mailbox as the From header
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.RESEND_API_KEY = 're_test_per_rep';

const { base, get, post, put, IDENTITY, teardown, nextCompanyNumber } =
  await import('./helpers.js');

test.after(teardown);

/* ---- Stub Resend, capturing what each send actually asked for ---- */

const realFetch = globalThis.fetch;
let sends = [];

globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.resend.com')) {
    sends.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: `re-${sends.length}` }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

/* ---- A second signed-in identity, so a rep can act as themselves ---- */

async function call(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

let seedN = 0;
const seed = async (name) => (await post('/api/leads', {
  business_name: name,
  email: `perrep${++seedN}@example.co.uk`,
  entity_type: 'corporate',
  company_number: nextCompanyNumber(),
  category: 'roofers',
  location: 'Leeds',
})).body.lead;

/** Wait for the background send loop to finish. */
async function waitForSend() {
  for (let i = 0; i < 120; i++) {
    const s = (await get('/api/gmail/send/status')).body;
    if (!s.active_send?.running) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('send did not finish');
}

/** Queue one lead as `cookie`, send it, and hand back the Resend payload. */
async function sendOneAs(cookie, leadId) {
  sends = [];
  await call('POST', '/api/gmail/queue',
    { cookie, body: { template_id: templateId, lead_ids: [leadId] } });
  const start = await call('POST', '/api/gmail/send',
    { cookie, body: { confirm: true, expected_count: 1 } });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await waitForSend();
  assert.equal(sends.length, 1, 'exactly one message should have left');
  return sends[0];
}

let templateId;
let repCookie;

test('setup: identity, a template, and a rep with their own address', async () => {
  await put('/api/settings', {
    ...IDENTITY,
    send_delay_min_seconds: '0', send_delay_max_seconds: '0', daily_cap: '50',
    window_enabled: '0', warmup_enabled: '0', domain_cooldown_days: '0',
  });
  const t = await post('/api/templates', {
    name: 'Cold', subject: 'A website for {{business}}?', body: 'Hi there. Reply to {{my_email}}.',
  });
  templateId = t.body.template.id;

  const created = await post('/api/auth/users', {
    name: 'Cailan Test', email: 'cailan@personal.example', password: 'rep-pass-123',
    work_email: 'cailan@test.example', role: 'rep',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.user.work_email, 'cailan@test.example');

  const login = await call('POST', '/api/auth/login',
    { body: { email: 'cailan@personal.example', password: 'rep-pass-123' } });
  assert.equal(login.status, 200);
  repCookie = login.cookie;
});

/* ------------------------------------------------------- the address itself */

test('the sending address is separate from the address they sign in with', async () => {
  const me = await call('GET', '/api/auth/me', { cookie: repCookie });
  assert.equal(me.body.user.email, 'cailan@personal.example', 'signs in with their own');
  assert.equal(me.body.user.work_email, 'cailan@test.example', 'sends from the business one');
});

test('a sending address that is not an email address is refused', async () => {
  const res = await call('PATCH', '/api/auth/me',
    { cookie: repCookie, body: { work_email: 'not an address' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not look like an email/i);

  // And the good one is still there — a refused edit must not clear it.
  const me = await call('GET', '/api/auth/me', { cookie: repCookie });
  assert.equal(me.body.user.work_email, 'cailan@test.example');
});

test('a rep can set their own sending address without an admin', async () => {
  const res = await call('PATCH', '/api/auth/me',
    { cookie: repCookie, body: { work_email: 'CAILAN@Test.Example' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.work_email, 'cailan@test.example', 'stored lowercased');
});

/* -------------------------------------------------------------- the send */

test('a rep’s email goes out from their own mailbox, and replies come back to it', async () => {
  const lead = await seed('Rep Sends Ltd');
  const sent = await sendOneAs(repCookie, lead.id);

  assert.equal(sent.from, 'Cailan Test <cailan@test.example>');
  assert.deepEqual(sent.reply_to, ['cailan@test.example'],
    'a reply has to reach the person who wrote it, not the shared inbox');
});

test('the body names the same mailbox as the From header', async () => {
  const lead = await seed('Token Match Ltd');
  const sent = await sendOneAs(repCookie, lead.id);

  assert.match(sent.text, /Reply to cailan@test\.example\./,
    '{{my_email}} must not invite a reply to a different mailbox than the headers do');
});

test('someone with no address of their own sends under the shared identity', async () => {
  // The admin in the test fixture has never been given a work_email.
  const lead = await seed('Fallback Ltd');
  sends = [];
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });
  await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  await waitForSend();

  assert.equal(sends.length, 1);
  assert.equal(sends[0].from, 'Test Web Studio <sender@test.example>');
  assert.deepEqual(sends[0].reply_to, ['sender@test.example']);
  assert.match(sends[0].text, /Reply to sender@test\.example\./);
});

test('the shared fallback takes the shared name too, never a mixed pair', async () => {
  // Blanking the address must take the name with it: the recipient seeing
  // "Cailan Test <sender@test.example>" is a mismatch a filter reads as
  // spoofing and a human reads as a mistake.
  await call('PATCH', '/api/auth/me', { cookie: repCookie, body: { work_email: '' } });
  const me = await call('GET', '/api/auth/me', { cookie: repCookie });
  assert.equal(me.body.user.work_email, '', 'blank clears it');

  const lead = await seed('Mixed Pair Ltd');
  const sent = await sendOneAs(repCookie, lead.id);

  assert.equal(sent.from, 'Test Web Studio <sender@test.example>');
  assert.deepEqual(sent.reply_to, ['sender@test.example']);
});

test('the queue says who each message will come from before it is sent', async () => {
  await call('PATCH', '/api/auth/me',
    { cookie: repCookie, body: { work_email: 'cailan@test.example' } });

  const mine = await seed('Shown In Outbox Ltd');
  await call('POST', '/api/gmail/queue',
    { cookie: repCookie, body: { template_id: templateId, lead_ids: [mine.id] } });

  const row = (await get('/api/gmail/queue')).body.pending
    .find((q) => q.business_name === 'Shown In Outbox Ltd');
  assert.deepEqual(row.from, { name: 'Cailan Test', address: 'cailan@test.example' });

  await post('/api/gmail/queue/clear');
});

test('the sender is whoever queued it, not whoever pressed send', async () => {
  // A rep stages their leads; the admin presses Send (an end-of-day sweep, or
  // the queue sat overnight). The message is still the rep's.
  const lead = await seed('Queued By Rep Ltd');
  sends = [];
  await call('POST', '/api/gmail/queue',
    { cookie: repCookie, body: { template_id: templateId, lead_ids: [lead.id] } });

  await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  await waitForSend();

  assert.equal(sends.length, 1);
  assert.equal(sends[0].from, 'Cailan Test <cailan@test.example>');
});

test('changing a sending address cannot split a staged message in two', async () => {
  // The body is frozen when the message is staged. If the From line were
  // resolved later instead, this sequence produced headers naming the new
  // mailbox and a body still saying "reply to" the old one — the message
  // contradicting itself, which is exactly what a spam filter reads as forgery.
  const lead = await seed('Stale Sender Ltd');

  // Staged while they still had no address of their own.
  await call('PATCH', '/api/auth/me', { cookie: repCookie, body: { work_email: '' } });
  sends = [];
  await call('POST', '/api/gmail/queue',
    { cookie: repCookie, body: { template_id: templateId, lead_ids: [lead.id] } });

  // Given one afterwards, before the queue is sent.
  await call('PATCH', '/api/auth/me',
    { cookie: repCookie, body: { work_email: 'cailan@test.example' } });

  await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  await waitForSend();

  assert.equal(sends.length, 1);
  const address = sends[0].from.match(/<(.+)>/)[1];
  assert.deepEqual(sends[0].reply_to, [address], 'Reply-To must match the From address');
  assert.match(sends[0].text, new RegExp(`Reply to ${address.replace('.', '\\.')}\\.`),
    'the body must name the same mailbox the headers do');

  // And it is the one the message was composed with, not the later one.
  assert.equal(sends[0].from, 'Test Web Studio <sender@test.example>');
});

test('an admin can set a rep’s sending address for them', async () => {
  const users = (await get('/api/auth/users')).body.users;
  const rep = users.find((u) => u.email === 'cailan@personal.example');

  const done = await call('PATCH', `/api/auth/users/${rep.id}`, {
    body: { work_email: 'cailan.jassal@test.example' },
    cookie: (await call('POST', '/api/auth/login', {
      body: { email: 'admin@test.example', password: 'test-pass-123' },
    })).cookie,
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.work_email, 'cailan.jassal@test.example');
});
