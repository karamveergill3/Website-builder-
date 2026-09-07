/**
 * The reply → brief → mockup pipeline, over the real HTTP routes.
 * No Gmail and no Ollama are involved: replies go in through the manual
 * path, and the brief is produced by the rules alone.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// Nothing listens here, so any accidental model call fails fast instead of
// hanging the suite for two minutes.
process.env.OLLAMA_HOST = '127.0.0.1:1';

const { post, get, patch, base, teardown } = await import('./helpers.js');
const { MOCKUP_ROOT } = await import('../server/routes/mockups.js');

const built = [];
after(() => {
  for (const token of built) {
    rmSync(`${MOCKUP_ROOT}/${token}`, { recursive: true, force: true });
  }
  teardown();
});

async function makeLead(over = {}) {
  const r = await post('/api/leads', {
    business_name: 'Hillside Roofing Ltd',
    category: 'roofer',
    location: 'Wolverhampton',
    phone: '07123456789',
    email: `dave${Math.random().toString(36).slice(2, 8)}@hillsideroofing.co.uk`,
    entity_type: 'corporate',
    company_number: `${Math.floor(Math.random() * 9e7 + 1e7)}`,
    ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

const GOOD_REPLY = `1. We do roofing, guttering and flat roofs.
2. No logo yet but I have loads of photos of past jobs.
3. Mainly people ringing us.`;

/* --------------------------------------------------------------- replies */

test('a pasted reply is stored, extracted, and flips the lead to replied', async () => {
  const lead = await makeLead();
  const r = await post('/api/replies/manual', {
    lead_id: lead.id, channel: 'whatsapp', body: GOOD_REPLY,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const b = r.body.brief;
  assert.deepEqual(b.services, ['Roofing', 'Guttering', 'Flat roofs']);
  assert.equal(b.primary_cta, 'call');
  assert.equal(b.has_photos, true);
  assert.equal(b.source, 'rules', 'no model is running, so rules must carry it');

  const after = await get(`/api/leads/${lead.id}`);
  assert.equal(after.body.lead.status, 'replied');
});

test('a reply needs a lead and a body', async () => {
  const lead = await makeLead();
  assert.equal((await post('/api/replies/manual', { body: 'hi' })).status, 400);
  assert.equal((await post('/api/replies/manual', { lead_id: lead.id })).status, 400);
  assert.equal(
    (await post('/api/replies/manual', { lead_id: lead.id, body: 'hi', channel: 'carrier-pigeon' })).status,
    400
  );
});

test('the replies list carries the brief alongside the message', async () => {
  const lead = await makeLead();
  await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });

  const r = await get(`/api/replies?lead_id=${lead.id}`);
  assert.equal(r.status, 200);
  const [reply] = r.body.replies;
  assert.equal(reply.business_name, 'Hillside Roofing Ltd');
  assert.ok(reply.brief, 'brief should be joined in');
  assert.equal(reply.brief.primary_cta, 'call');
  assert.equal(reply.mockup, null, 'nothing built yet');
});

test('gmail readiness is reported rather than assumed', async () => {
  const r = await get('/api/replies');
  assert.equal(r.status, 200);
  assert.equal(r.body.gmail.ready, false);
  assert.equal(r.body.gmail.code, 'NOT_CONNECTED');
});

test('syncing without Gmail connected fails loudly, not silently', async () => {
  const r = await post('/api/replies/sync', {});
  assert.equal(r.status, 422);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'NOT_CONNECTED');
});

/* ---------------------------------------------------------------- brief */

test('a user edit to the brief sticks and is flagged as theirs', async () => {
  const lead = await makeLead();
  const made = await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });
  const replyId = made.body.reply_id;

  const r = await patch(`/api/replies/${replyId}/brief`, {
    services: ['Roofing', 'Chimney repairs'],
    primary_cta: 'quote',
    has_logo: true,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.brief.services, ['Roofing', 'Chimney repairs']);
  assert.equal(r.body.brief.primary_cta, 'quote');
  assert.equal(r.body.brief.has_logo, true);
  assert.equal(r.body.brief.edited_by_user, true);
});

test('an invalid CTA is refused rather than stored', async () => {
  const lead = await makeLead();
  const made = await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });
  const r = await patch(`/api/replies/${made.body.reply_id}/brief`, { primary_cta: 'telepathy' });
  assert.equal(r.status, 400);
});

test('re-extracting replaces the brief', async () => {
  const lead = await makeLead();
  const made = await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });
  const r = await post(`/api/replies/${made.body.reply_id}/extract`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.brief.primary_cta, 'call');
});

/* -------------------------------------------------------------- mockups */

test('a mockup builds from a reply and serves on its token', async () => {
  const lead = await makeLead();
  const made = await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });

  const r = await post('/api/mockups', { reply_id: made.body.reply_id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body.mockup;
  built.push(m.token);

  assert.match(m.token, /^[0-9a-f]{32}$/);
  assert.equal(m.url, `/m/${m.token}/`);
  assert.deepEqual(m.pages, ['index.html', 'services.html', 'about.html', 'contact.html']);

  // Every page must actually be reachable.
  for (const page of ['', 'services.html', 'about.html', 'contact.html']) {
    const res = await fetch(`${base}/m/${m.token}/${page}`);
    assert.equal(res.status, 200, `/m/${m.token}/${page}`);
    const html = await res.text();
    assert.ok(html.includes('Hillside Roofing Ltd'), page);
  }
});

test('the served mockup carries a restrictive CSP and noindex', async () => {
  const lead = await makeLead();
  const made = await post('/api/replies/manual', { lead_id: lead.id, body: GOOD_REPLY });
  const r = await post('/api/mockups', { reply_id: made.body.reply_id });
  built.push(r.body.mockup.token);

  const res = await fetch(`${base}/m/${r.body.mockup.token}/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/, 'must not allow scripts by default');
  assert.ok(!/script-src[^;]*unsafe/i.test(csp), 'must not permit inline script');
  assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('an unknown token is a 404, and the root cannot be listed', async () => {
  assert.equal((await fetch(`${base}/m/${'0'.repeat(32)}/`)).status, 404);
  assert.equal((await fetch(`${base}/m/`)).status, 404);
});

test('a mockup can be built from a lead alone, with no reply', async () => {
  const lead = await makeLead({ business_name: 'No Reply Yet Ltd' });
  const r = await post('/api/mockups', { lead_id: lead.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  built.push(r.body.mockup.token);

  const html = await (await fetch(`${base}/m/${r.body.mockup.token}/`)).text();
  assert.ok(html.includes('No Reply Yet Ltd'));
});

test('mockups needs something to build from', async () => {
  assert.equal((await post('/api/mockups', {})).status, 400);
  assert.equal((await post('/api/mockups', { lead_id: 999999 })).status, 404);
});

test('the ollama probe reports honestly and names the fallback', async () => {
  const r = await get('/api/ollama');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'nothing is listening on 127.0.0.1:1');
  assert.match(r.body.fallback, /rules/i, 'must say what happens without it');
});

test('hostile content in a reply cannot execute in the served mockup', async () => {
  const lead = await makeLead({ business_name: 'Evil <script>alert(1)</script> Ltd' });
  await post('/api/replies/manual', {
    lead_id: lead.id,
    body: '1. <img src=x onerror=alert(1)>\n3. "><script>bad()</script>',
  });
  const r = await post('/api/mockups', { lead_id: lead.id });
  built.push(r.body.mockup.token);

  const html = await (await fetch(`${base}/m/${r.body.mockup.token}/`)).text();
  assert.ok(!/<script>alert/i.test(html));
  assert.ok(!/<script>bad\(/i.test(html));
  assert.ok(!/<img[^>]*onerror/i.test(html));
});
