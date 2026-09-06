/**
 * End-to-end tests for the multichannel outreach routes:
 *   POST /api/leads/:id/find-contacts     — discovery
 *   POST /api/outreach/prepare            — gate + deep link + log
 *   POST /api/outreach/:id/sent           — confirm dispatched
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { post, get, teardown } from './helpers.js';

after(() => teardown());

/** Create a lead marked corporate with a UK mobile. */
async function makeCorporateLead(overrides = {}) {
  const body = {
    business_name: 'Acme Roofing Ltd',
    location: 'Leeds',
    phone: '07123 456789',
    entity_type: 'corporate',
    company_number: `${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`,
    ...overrides,
  };
  const r = await post('/api/leads', body);
  assert.equal(r.status, 201, `lead create failed: ${JSON.stringify(r.body)}`);
  return r.body.lead;
}

test('prepare returns a wa.me URL for a corporate lead', async () => {
  const lead = await makeCorporateLead();
  const r = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', text: 'Hi Acme — quick chat?',
  });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/wa\.me\/447/);
  assert.match(r.body.url, /text=/);
  assert.equal(r.body.channel, 'whatsapp');
  assert.equal(r.body.e164, '+447123456789');
});

test('prepare returns an sms: URL', async () => {
  const lead = await makeCorporateLead();
  const r = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'sms', text: 'Hi',
  });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^sms:\+447123456789\?body=/);
});

test('prepare returns tel: for a call, and no message body', async () => {
  const lead = await makeCorporateLead();
  const r = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'call',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'tel:+447123456789');
  assert.equal(r.body.text, null);
  assert.match(r.body.advice, /CTPS/);
});

test('prepare refuses when the lead is a sole trader', async () => {
  const lead = await makeCorporateLead({ entity_type: 'individual', company_number: '' });
  // Sole traders come back after the requireCorporateEvidence branch — recreate without a number.
  const r = await post('/api/leads', {
    business_name: 'Dave the Roofer',
    location: 'Leeds',
    phone: '07999 111222',
    entity_type: 'individual',
  });
  assert.equal(r.status, 201);
  const dave = r.body.lead;

  const rr = await post('/api/outreach/prepare', {
    lead_id: dave.id, channel: 'whatsapp', text: 'Hi',
  });
  assert.equal(rr.status, 422);
  assert.equal(rr.body.code, 'INDIVIDUAL_SUBSCRIBER');
  assert.equal(rr.body.channel, 'whatsapp');
  void lead;
});

test('prepare refuses when the lead has no phone number', async () => {
  const lead = await makeCorporateLead({ phone: null });
  const r = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', text: 'Hi',
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'NO_PHONE');
});

test('prepare refuses opted-out leads on every channel', async () => {
  const lead = await makeCorporateLead({ opted_out: true });
  for (const channel of ['whatsapp', 'sms', 'call']) {
    const r = await post('/api/outreach/prepare', {
      lead_id: lead.id, channel, text: 'Hi',
    });
    assert.equal(r.status, 422, `${channel} should be blocked`);
    assert.equal(r.body.code, 'OPTED_OUT');
  }
});

test('marking an outreach sent updates the lead status and last_contacted_at', async () => {
  const lead = await makeCorporateLead();
  const prep = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', text: 'Hi',
  });
  assert.equal(prep.status, 200);
  const eventId = prep.body.event_id;

  const sent = await post(`/api/outreach/${eventId}/sent`, {});
  assert.equal(sent.status, 200);
  assert.ok(sent.body.confirmed_sent_at);

  const after = await get(`/api/leads/${lead.id}`);
  assert.equal(after.body.lead.status, 'sent');
  assert.ok(after.body.lead.last_contacted_at);
});

test('signals list is empty for a fresh lead', async () => {
  const lead = await makeCorporateLead();
  const r = await get(`/api/leads/${lead.id}/signals`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.signals, []);
});

test('promoting a hand-added signal updates the lead email', async () => {
  const lead = await makeCorporateLead();
  // Inject a signal via the DB (simpler than mocking the finder here).
  const { db } = await import('../server/db.js');
  const info = db.prepare(
    `INSERT INTO contact_signals
       (lead_id, kind, value, source, confidence, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(lead.id, 'email', 'hello@acme.co.uk', 'test', 85, new Date().toISOString(), new Date().toISOString());
  const sid = info.lastInsertRowid;

  const promoted = await post(`/api/leads/${lead.id}/signals/${sid}/promote`, {});
  assert.equal(promoted.status, 200);

  const after = await get(`/api/leads/${lead.id}`);
  assert.equal(after.body.lead.email, 'hello@acme.co.uk');
});

test('prepare from a template respects the channel column', async () => {
  const lead = await makeCorporateLead();
  const tpl = await post('/api/templates', {
    name: `T-${Date.now()}`,
    subject: '',
    body: 'Hi {{business}} — quick chat?',
    channel: 'whatsapp',
  });
  assert.equal(tpl.status, 201);
  const templateId = tpl.body.template.id;

  const prep = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', template_id: templateId,
  });
  assert.equal(prep.status, 200);
  assert.equal(prep.body.text, 'Hi Acme Roofing Ltd — quick chat?');

  // Using an email-channel template for whatsapp should be refused.
  const wrongTpl = await post('/api/templates', {
    name: `E-${Date.now()}`,
    subject: 'Hi', body: 'Hello', channel: 'email',
  });
  assert.equal(wrongTpl.status, 201);
  const wrong = await post('/api/outreach/prepare', {
    lead_id: lead.id, channel: 'whatsapp', template_id: wrongTpl.body.template.id,
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /email/);
});
