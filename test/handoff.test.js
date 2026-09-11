import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalisePhone, whatsappLink, smsLink, telLink, handoff } from '../server/lib/handoff.js';

/* ------------------------------------------------------- normalisePhone */

test('normalisePhone accepts UK mobile in national form', () => {
  const r = normalisePhone('07123 456789');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+447123456789');
  assert.equal(r.mobile, true);
});

test('normalisePhone accepts E.164 with plus', () => {
  const r = normalisePhone('+447123456789');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+447123456789');
});

test('normalisePhone accepts 00-prefixed international', () => {
  const r = normalisePhone('00447123456789');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+447123456789');
});

test('normalisePhone accepts UK landline with punctuation', () => {
  const r = normalisePhone('(0113) 200-2000');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+441132002000');
  assert.equal(r.mobile, false);
});

test('normalisePhone rejects premium rate', () => {
  const r = normalisePhone('09001234567');
  assert.equal(r.ok, false);
  assert.match(r.reason, /premium/);
});

test('normalisePhone rejects non-UK country codes', () => {
  const r = normalisePhone('+14155551234');
  assert.equal(r.ok, false);
  assert.match(r.reason, /UK/);
});

test('normalisePhone rejects too-short numbers', () => {
  const r = normalisePhone('123');
  assert.equal(r.ok, false);
});

test('normalisePhone rejects empty input', () => {
  const r = normalisePhone('');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no number/);
});

test('normalisePhone treats bare 10 digits as national', () => {
  // Someone might paste a number without the leading 0.
  const r = normalisePhone('7123456789');
  assert.equal(r.ok, true);
  assert.equal(r.e164, '+447123456789');
});

/* --------------------------------------------------------- whatsappLink */

test('whatsappLink builds a wa.me URL with encoded text', () => {
  const r = whatsappLink({ phone: '07123 456789', text: 'Hi & bye — free quote?' });
  assert.equal(r.ok, true);
  assert.match(r.url, /^https:\/\/wa\.me\/447123456789\?text=/);
  // Ampersand must be percent-encoded so WhatsApp does not truncate at it.
  assert.match(r.url, /%26/);
  // Em-dash likewise.
  assert.match(r.url, /%E2%80%94/);
});

test('whatsappLink returns ok:false for a bad number', () => {
  const r = whatsappLink({ phone: 'nonsense', text: 'x' });
  assert.equal(r.ok, false);
});

test('whatsappLink omits the ?text= when text is empty', () => {
  const r = whatsappLink({ phone: '07123456789', text: '' });
  assert.equal(r.url, 'https://wa.me/447123456789');
});

/* ---------------------------------------------------------- smsLink */

test('smsLink uses E.164 with plus and body=', () => {
  const r = smsLink({ phone: '07123456789', text: 'Hi' });
  assert.equal(r.url, 'sms:+447123456789?body=Hi');
});

test('smsLink encodes spaces and specials in the body', () => {
  const r = smsLink({ phone: '07123456789', text: 'a b & c' });
  assert.equal(r.url, 'sms:+447123456789?body=a%20b%20%26%20c');
});

/* ---------------------------------------------------------- telLink */

test('telLink returns tel:E164', () => {
  const r = telLink({ phone: '0113 200 2000' });
  assert.equal(r.url, 'tel:+441132002000');
});

/* ---------------------------------------------------------- handoff */

test('handoff dispatches to the right builder', () => {
  assert.equal(handoff({ channel: 'call', phone: '07123456789' }).url, 'tel:+447123456789');
  assert.match(handoff({ channel: 'whatsapp', phone: '07123456789', text: 'hi' }).url, /^https:\/\/wa\.me\//);
  assert.match(handoff({ channel: 'sms', phone: '07123456789', text: 'hi' }).url, /^sms:/);
});

test('handoff refuses unknown channel', () => {
  const r = handoff({ channel: 'carrier-pigeon', phone: '07123456789' });
  assert.equal(r.ok, false);
});
