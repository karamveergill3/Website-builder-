import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GMAIL_CLIENT_ID = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';

const { get, post, put, del, IDENTITY, teardown } = await import('./helpers.js');
const { setSetting } = await import('../server/db.js');
const { buildRawMessage } = await import('../server/lib/gmail.js');

test.after(teardown);

/* ---- Stub Google's token and send endpoints ---- */

const realFetch = globalThis.fetch;
let sends = [];
let sendResponses = [];

function stubGoogle() {
  sends = [];
  sendResponses = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-access', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('gmail.googleapis.com')) {
      sends.push(JSON.parse(opts.body));
      const next = sendResponses.shift();
      if (next) return new Response(JSON.stringify(next.body), { status: next.status,
        headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ id: `msg-${sends.length}`, threadId: 't1' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
}

const connectGmail = () => {
  setSetting('gmail_refresh_token', 'fake-refresh-token');
  setSetting('gmail_email', 'me@gmail.example');
};

/** Decode the base64url RFC 5322 message the route handed to Gmail. */
const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/**
 * A lead that may lawfully be emailed. entity_type defaults to 'corporate'
 * because an unclassified lead is blocked by the PECR gate by design; tests
 * that care about the gate override it.
 */
let seedN = 0;

async function seed({ name, email, opted_out = false,
                      entity_type = 'corporate' } = {}) {
  // A distinct address per lead: suppression is keyed on the address, so a
  // shared one would let an opted-out fixture block every other test.
  email = email ?? `lead${++seedN}@example.co.uk`;
  const lead = (await post('/api/leads', {
    business_name: name, email, opted_out, entity_type,
    company_number: entity_type === 'corporate' ? '01234567' : null,
    category: 'roofers', location: 'Leeds',
  })).body.lead;
  return lead;
}

let templateId;
test('setup: identity and a template', async () => {
  stubGoogle();
  await put('/api/settings', { ...IDENTITY, send_delay_min_seconds: '0', send_delay_max_seconds: '0', daily_cap: '50' });
  const t = await post('/api/templates', { name: 'Cold', subject: 'A website for {{business}}?', body: 'Hi there.' });
  templateId = t.body.template.id;
});

/* ------------------------------------------------------------- the queue */

test('queue refuses opted-out leads, leads with no email, and duplicates', async () => {
  const ok      = await seed({ name: 'Queue Me' });
  const optedOut = await seed({ name: 'Opted Out Ltd', opted_out: true });
  const noEmail  = await seed({ name: 'No Email Ltd', email: '' });

  const res = await post('/api/gmail/queue', {
    template_id: templateId, lead_ids: [ok.id, optedOut.id, noEmail.id, 999999],
  });
  assert.equal(res.body.queued, 1);
  const reasons = res.body.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ['no email address', 'no such lead', 'opted out']);

  // Queueing the same lead twice does not double it up.
  const again = await post('/api/gmail/queue', { template_id: templateId, lead_ids: [ok.id] });
  assert.equal(again.body.queued, 0);
  assert.equal(again.body.skipped[0].reason, 'already queued');

  await post('/api/gmail/queue/clear');
  for (const l of [ok, optedOut, noEmail]) await del(`/api/leads/${l.id}`);
});

test('queue is blocked outright when business identity is incomplete', async () => {
  const lead = await seed({ name: 'Identity Test' });
  await put('/api/settings', { biz_contact_name: '', biz_name: '', biz_address: '', biz_email: '' });

  const res = await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /incomplete/i);

  await put('/api/settings', IDENTITY);
  await del(`/api/leads/${lead.id}`);
});

test('every queued email carries the identity block and opt-out line', async () => {
  const lead = await seed({ name: 'Footer Check' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });
  const q = (await get('/api/gmail/queue')).body.pending[0];

  assert.match(q.body, /Test Web Studio/);
  assert.match(q.body, /1 Test Street, Leeds LS1 1AA/);
  assert.match(q.body, /reply with "STOP"/);
  assert.equal(q.subject, 'A website for Footer Check?');

  await post('/api/gmail/queue/clear');
  await del(`/api/leads/${lead.id}`);
});

/* -------------------------------------------------------------- sending */

test('sending is refused without an explicit confirmation', async () => {
  connectGmail();
  const lead = await seed({ name: 'Confirm Test' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });

  const noConfirm = await post('/api/gmail/send', {});
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.body.error, /explicit confirmation/i);
  assert.equal(sends.length, 0, 'nothing may reach Gmail without confirmation');

  await post('/api/gmail/queue/clear');
  await del(`/api/leads/${lead.id}`);
});

test('sending is refused if the queue changed since it was reviewed', async () => {
  connectGmail();
  const a = await seed({ name: 'Stale A' });
  const b = await seed({ name: 'Stale B' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [a.id, b.id] });

  const res = await post('/api/gmail/send', { confirm: true, expected_count: 5 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /queue changed/i);
  assert.equal(sends.length, 0);

  await post('/api/gmail/queue/clear');
  for (const l of [a, b]) await del(`/api/leads/${l.id}`);
});

/** Wait for the background send loop to finish. */
async function waitForSend() {
  for (let i = 0; i < 120; i++) {
    const s = (await get('/api/gmail/send/status')).body;
    if (!s.active_send?.running) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('send did not finish');
}

test('a confirmed send reaches Gmail, is logged, and advances the lead', async () => {
  connectGmail();
  const lead = await seed({ name: 'Send Me Ltd', email: 'sendme@example.co.uk' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });

  const start = await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  assert.equal(start.status, 202);
  await waitForSend();

  assert.equal(sends.length, 1);
  const msg = decode(sends[0].raw);
  assert.match(msg, /^To: sendme@example\.co\.uk$/m);
  assert.match(msg, /^Subject: A website for Send Me Ltd\?$/m);
  assert.match(msg, /^List-Unsubscribe: <mailto:sender@test\.example\?subject=unsubscribe>$/m,
    'a one-click unsubscribe header is what mail clients surface');
  assert.match(msg, /^From: .*<me@gmail\.example>$/m);

  const body = Buffer.from(msg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /Test Web Studio/, 'identity block travels in the real message');
  assert.match(body, /reply with "STOP"/, 'opt-out line travels in the real message');

  // Logged as proof.
  const entry = (await get(`/api/emails/log?lead_id=${lead.id}`)).body.entries[0];
  assert.equal(entry.channel, 'gmail');
  assert.equal(entry.provider_message_id, 'msg-1');
  assert.equal(entry.to_email, 'sendme@example.co.uk');
  assert.match(entry.body_snapshot, /reply with "STOP"/);

  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(after.status, 'sent');
  assert.ok(after.last_contacted_at);

  await del(`/api/leads/${lead.id}`);
});

test('a lead that opts out AFTER being queued is not sent to', async () => {
  connectGmail();
  const lead = await seed({ name: 'Late Opt Out', email: 'late@example.co.uk' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });

  // The opt-out arrives between review and send — the race that matters most.
  await post(`/api/leads/${lead.id}`.replace('/api/leads', '/api/leads'), {});
  const patched = await fetch(`${(await import('./helpers.js')).base}/api/leads/${lead.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opted_out: true }),
  });
  assert.equal(patched.status, 200);

  const before = sends.length;
  await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  const status = await waitForSend();

  assert.equal(sends.length, before, 'no message may go to an opted-out lead');
  const item = status.recent.find((r) => r.lead_id === lead.id);
  assert.equal(item.status, 'skipped');
  assert.match(item.error, /opted out/i);

  await del(`/api/leads/${lead.id}`);
});

test('the daily cap stops sending and leaves the rest queued', async () => {
  connectGmail();
  // Earlier tests have already sent today, so set the cap relative to that.
  const usedSoFar = (await get('/api/gmail/status')).body.daily.used;
  await put('/api/settings', { daily_cap: String(usedSoFar + 2), send_delay_min_seconds: '0', send_delay_max_seconds: '0' });

  const leads = [];
  for (const n of ['Cap One', 'Cap Two', 'Cap Three', 'Cap Four']) {
    leads.push(await seed({ name: n, email: `${n.replace(/ /g, '').toLowerCase()}@example.co.uk` }));
  }
  try {
    await post('/api/gmail/queue', { template_id: templateId, lead_ids: leads.map((l) => l.id) });

    const before = sends.length;
    const start = await post('/api/gmail/send', { confirm: true });
    assert.equal(start.body.will_send, 2, 'only what the cap allows is even attempted');
    await waitForSend();
    assert.equal(sends.length - before, 2);

    // With the cap now spent, a second attempt is refused up front.
    const second = await post('/api/gmail/send', { confirm: true });
    assert.equal(second.status, 400);
    assert.match(second.body.error, /Daily cap/i);

    const stillPending = (await get('/api/gmail/queue')).body.pending;
    assert.equal(stillPending.length, 2, 'the remainder stays queued rather than being dropped');
  } finally {
    await post('/api/gmail/queue/clear');
    await put('/api/settings', { daily_cap: '500' });
    for (const l of leads) await del(`/api/leads/${l.id}`);
  }
});

test('a Gmail failure is recorded against the item, not swallowed', async () => {
  connectGmail();
  const lead = await seed({ name: 'Fail Co', email: 'fail@example.co.uk' });
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: [lead.id] });

  sendResponses = [{ status: 400, body: { error: { message: 'Invalid recipient' } } }];
  await post('/api/gmail/send', { confirm: true, expected_count: 1 });
  const status = await waitForSend();

  const item = status.recent.find((r) => r.lead_id === lead.id);
  assert.equal(item.status, 'failed');
  assert.match(item.error, /Invalid recipient/);

  const logged = (await get(`/api/emails/log?lead_id=${lead.id}`)).body.entries;
  assert.equal(logged.length, 0, 'a failed send must never appear as proof of sending');

  await del(`/api/leads/${lead.id}`);
});

test('an expired refresh token stops the run rather than hammering Google', async () => {
  connectGmail();
  const leads = [];
  for (const n of ['Auth A', 'Auth B', 'Auth C']) {
    leads.push(await seed({ name: n, email: `${n.replace(/ /g, '')}@example.co.uk` }));
  }
  await post('/api/gmail/queue', { template_id: templateId, lead_ids: leads.map((l) => l.id) });

  const before = sends.length;
  sendResponses = [
    { status: 401, body: { error: { message: 'Invalid Credentials' } } },
    { status: 200, body: { id: 'should-not-happen' } },
  ];
  await post('/api/gmail/send', { confirm: true });
  await waitForSend();

  assert.equal(sends.length - before, 1, 'it stops after the first auth failure');

  await post('/api/gmail/queue/clear');
  for (const l of leads) await del(`/api/leads/${l.id}`);
});

test('OAuth tokens are never returned by the settings API', async () => {
  connectGmail();
  const s = (await get('/api/settings')).body;
  assert.equal(s.settings.gmail_refresh_token, undefined);
  assert.equal(s.settings.gmail_access_token, undefined);
  assert.equal(s.integrations.gmail_connected, true);
  assert.equal(s.integrations.gmail_email, 'me@gmail.example');
  assert.equal(JSON.stringify(s).includes('fake-refresh-token'), false);
});

test('the settings API cannot be used to write a token', async () => {
  const res = await put('/api/settings', { gmail_refresh_token: 'attacker-token' });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------- message construction */

test('buildRawMessage: headers cannot be injected through a subject or name', () => {
  const raw = buildRawMessage({
    to: 'a@b.example',
    subject: 'Hello\r\nBcc: victim@example.com',
    body: 'text',
  });
  const msg = decode(raw);
  assert.doesNotMatch(msg, /^Bcc:/m, 'CRLF in a header value must not create a new header');
  assert.match(msg, /^Subject: Hello Bcc: victim@example\.com$/m);
});

test('buildRawMessage: a non-ASCII subject is RFC 2047 encoded', () => {
  const msg = decode(buildRawMessage({ to: 'a@b.example', subject: 'Café — naïve', body: 'x' }));
  assert.match(msg, /^Subject: =\?UTF-8\?B\?/m);
});

test('buildRawMessage: the body survives a round trip with UTF-8 intact', () => {
  const body = 'Hi — “curly quotes”, £450, café.\n\nBest,';
  const msg = decode(buildRawMessage({ to: 'a@b.example', subject: 's', body }));
  const decoded = Buffer.from(msg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(decoded, body);
});

test('buildRawMessage: no List-Unsubscribe header when no opt-out address exists', () => {
  const msg = decode(buildRawMessage({ to: 'a@b.example', subject: 's', body: 'x' }));
  assert.doesNotMatch(msg, /List-Unsubscribe/);
});

test('the OAuth callback escapes everything it echoes back', async () => {
  const { base } = await import('./helpers.js');
  const payload = '<script>alert(1)</script>';
  const res = await fetch(
    `${base}/api/gmail/callback?error=${encodeURIComponent(payload)}`,
    { redirect: 'manual' }
  );
  const html = await res.text();

  assert.equal(res.status, 400);
  assert.equal(html.includes('<script>alert(1)</script>'), false,
    'query-string content must never be reflected as live markup');
  assert.ok(html.includes('&lt;script&gt;'), 'it should appear escaped');
});

test('a callback without a matching state is refused', async () => {
  const { base } = await import('./helpers.js');
  const res = await fetch(`${base}/api/gmail/callback?code=abc&state=not-one-we-issued`,
    { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not one this app started/i);
});

test('a From display name containing a comma is quoted, not left to split the header', async () => {
  const msg = decode(buildRawMessage({
    to: 'a@b.example',
    from: 'me@gmail.example',
    fromName: 'Smith, Jones & Co',
    subject: 's',
    body: 'x',
  }));
  const from = msg.split('\r\n').find((l) => l.startsWith('From:'));
  assert.equal(from, 'From: "Smith, Jones & Co" <me@gmail.example>');
});

test('a plain From display name is left unquoted', () => {
  const msg = decode(buildRawMessage({
    to: 'a@b.example', from: 'me@gmail.example', fromName: 'Gill Web Studio',
    subject: 's', body: 'x',
  }));
  assert.match(msg, /^From: Gill Web Studio <me@gmail\.example>$/m);
});

test('the daily cap default agrees between the settings API and the send path', async () => {
  // A blank value clears the override, so both sides fall back to the default.
  await put('/api/settings', { daily_cap: '' });
  const settings = (await get('/api/settings')).body.settings;
  const gmail = (await get('/api/gmail/status')).body;
  assert.equal(gmail.daily.cap, Number(settings.daily_cap),
    'the send path and the settings screen must report the same cap');
  await put('/api/settings', { daily_cap: '500' });
});

test('a blank numeric setting clears the override instead of storing zero', async () => {
  await put('/api/settings', { send_delay_min_seconds: '90' });
  assert.equal((await get('/api/gmail/status')).body.delay_min_seconds, 90);

  await put('/api/settings', { send_delay_min_seconds: '' });
  const after = (await get('/api/gmail/status')).body.delay_min_seconds;
  assert.notEqual(after, 0, 'blank must not read as "no delay at all"');
  assert.equal(after, 120, 'it falls back to the default');

  await put('/api/settings', { send_delay_min_seconds: '0', send_delay_max_seconds: '0' });
});
