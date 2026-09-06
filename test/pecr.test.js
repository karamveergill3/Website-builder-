import test from 'node:test';
import assert from 'node:assert/strict';
import { sendability, isFreeMail, looksCorporate, emailDomain } from '../server/lib/pecr.js';

const lead = (over = {}) => ({
  id: 1, business_name: 'Acme Roofing Ltd', email: 'info@acmeroofing.co.uk',
  opted_out: 0, entity_type: 'corporate', ...over,
});

test('a limited company on its own domain may be cold-emailed', () => {
  const v = sendability(lead());
  assert.equal(v.allowed, true);
  assert.equal(v.code, 'OK');
});

test('an unclassified lead is blocked until it has been checked', () => {
  const v = sendability(lead({ entity_type: 'unknown' }));
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'UNCLASSIFIED');
  assert.match(v.reason, /limited company or LLP/);
});

test('a sole trader is blocked: PECR reg 22 makes them an individual subscriber', () => {
  const v = sendability(lead({ entity_type: 'individual', business_name: 'Dave the Roofer' }));
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'INDIVIDUAL_SUBSCRIBER');
  assert.match(v.reason, /consent/i);
});

test('a personal mailbox is blocked even when the business is a company', () => {
  for (const addr of ['dave@gmail.com', 'dave@hotmail.co.uk', 'dave@btinternet.com',
                      'dave@yahoo.co.uk', 'dave@icloud.com', 'dave@sky.com']) {
    const v = sendability(lead({ email: addr }));
    assert.equal(v.allowed, false, `${addr} should be blocked`);
    assert.equal(v.code, 'FREE_MAIL');
  }
});

test('opt-out beats every other consideration', () => {
  const v = sendability(lead({ opted_out: 1 }));
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'OPTED_OUT');
});

test('a suppressed address is blocked even on a lead that looks fine', () => {
  const v = sendability(lead(), { suppressed: true });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'SUPPRESSED');
});

test('a lead with no email is blocked with a distinct reason', () => {
  const v = sendability(lead({ email: null }));
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'NO_EMAIL');
});

test('looksCorporate only ever suggests — it recognises the usual suffixes', () => {
  for (const n of ['Acme Ltd', 'Acme Limited', 'Acme PLC', 'Acme LLP',
                   'Acme CIC', 'Acme Cyf', 'Acme Roofing Ltd.']) {
    assert.equal(looksCorporate(n), true, n);
  }
  for (const n of ['Dave the Roofer', 'Hillside Roofing', 'A & B Plastering',
                   'Smith and Sons']) {
    assert.equal(looksCorporate(n), false, n);
  }
});

test('emailDomain and isFreeMail are case-insensitive and whitespace-tolerant', () => {
  assert.equal(emailDomain('  Dave@GMAIL.com '), 'gmail.com');
  assert.equal(isFreeMail('Dave@GMAIL.com'), true);
  assert.equal(isFreeMail('dave@acmeroofing.co.uk'), false);
  assert.equal(isFreeMail(''), false);
  assert.equal(isFreeMail(null), false);
});

/* --------------------- suppression address normalisation ------------------- */

const { norm, domainOf } = await import('../server/lib/suppression.js');

test('an opt-out cannot be defeated by a plus-tag', () => {
  assert.equal(norm('dave+leads@acmeroofing.co.uk'), 'dave@acmeroofing.co.uk');
});

test('gmail-style dot aliasing normalises to one mailbox', () => {
  assert.equal(norm('dave.smith@gmail.com'), 'davesmith@gmail.com');
  assert.equal(norm('DaveSmith+x@googlemail.com'), 'davesmith@googlemail.com');
});

test('dots are significant on hosts that treat them that way', () => {
  assert.equal(norm('dave.smith@acmeroofing.co.uk'), 'dave.smith@acmeroofing.co.uk');
});

test('domainOf reads the normalised domain', () => {
  assert.equal(domainOf('  Dave+x@Acme.CO.UK '), 'acme.co.uk');
});

/* -------------------------- per-channel sendability ---------------------- */

test('sendability(whatsapp) allows a corporate lead with a phone', () => {
  const v = sendability(lead({ phone: '07123456789' }), { channel: 'whatsapp' });
  assert.equal(v.allowed, true);
  assert.equal(v.channel, 'whatsapp');
});

test('sendability(whatsapp) refuses without a phone', () => {
  const v = sendability(lead(), { channel: 'whatsapp' });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'NO_PHONE');
});

test('sendability(sms) refuses a sole trader — same reg 22 rule', () => {
  const v = sendability(
    lead({ entity_type: 'individual', phone: '07123456789' }),
    { channel: 'sms' }
  );
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'INDIVIDUAL_SUBSCRIBER');
  assert.match(v.reason, /message/);
});

test('sendability(call) allows a corporate but carries CTPS advice', () => {
  const v = sendability(lead({ phone: '01132002000' }), { channel: 'call' });
  assert.equal(v.allowed, true);
  assert.match(v.advice, /CTPS/);
});

test('sendability defaults to email when no channel is given (back-compat)', () => {
  const v = sendability(lead());
  assert.equal(v.allowed, true);
  assert.equal(v.channel, 'email');
});

test('sendability(email) still checks email-specific rules', () => {
  const v = sendability(lead({ email: null, phone: '07123456789' }), { channel: 'email' });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'NO_EMAIL');
});

test('sendability rejects unknown channels', () => {
  const v = sendability(lead(), { channel: 'fax' });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'BAD_CHANNEL');
});

test('opt-out still beats every channel', () => {
  for (const channel of ['email', 'whatsapp', 'sms', 'call']) {
    const v = sendability(lead({ opted_out: 1, phone: '07123456789' }), { channel });
    assert.equal(v.allowed, false, channel);
    assert.equal(v.code, 'OPTED_OUT', channel);
  }
});
