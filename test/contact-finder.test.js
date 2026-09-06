import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extract, emailConfidence, looksLikeContactSource,
} from '../server/lib/contact-finder.js';

/* ---------------------------------------------------------- extract */

test('extract finds mailto: emails', () => {
  const html = '<a href="mailto:info@acme.co.uk">Contact</a>';
  const r = extract(html);
  assert.deepEqual(r.emails, ['info@acme.co.uk']);
});

test('extract finds plain-text emails alongside mailto:', () => {
  const html = 'Or write to info@acme.co.uk directly';
  const r = extract(html);
  assert.deepEqual(r.emails, ['info@acme.co.uk']);
});

test('extract drops asset-URL false positives', () => {
  const html = '<img src="something@2x.png"> <script>logo@2x.jpg</script>';
  const r = extract(html);
  assert.deepEqual(r.emails, []);
});

test('extract drops noreply-style addresses', () => {
  const html = 'From noreply@wixpress.com and no-reply@example.com';
  const r = extract(html);
  assert.deepEqual(r.emails, []);
});

test('extract normalises phone numbers to E.164 and dedupes', () => {
  const html = `
    <a href="tel:+441132002000">Call</a>
    <p>Or call us on 0113 200 2000 today</p>
  `;
  const r = extract(html);
  assert.deepEqual(r.phones, ['+441132002000']);
});

test('extract picks up wa.me links and returns the number', () => {
  const html = '<a href="https://wa.me/447987654321">WhatsApp</a>';
  const r = extract(html);
  assert.deepEqual(r.whatsapps, ['+447987654321']);
});

test('extract finds Facebook page URLs and strips tracking params', () => {
  const html = '<a href="https://facebook.com/acme.roofing.leeds?ref=share">FB</a>';
  const r = extract(html);
  assert.deepEqual(r.facebooks, ['https://facebook.com/acme.roofing.leeds']);
});

test('extract skips Facebook plugin/dialog URLs', () => {
  const html = '<iframe src="https://www.facebook.com/plugins/like.php?..."></iframe>';
  const r = extract(html);
  assert.deepEqual(r.facebooks, []);
});

test('extract handles empty input', () => {
  const r = extract('');
  assert.deepEqual(r, { emails: [], phones: [], whatsapps: [], facebooks: [] });
});

/* ------------------------------------------------------ confidence */

test('emailConfidence: role addresses score higher than personal', () => {
  const info = emailConfidence('info@acme.co.uk', {});
  const random = emailConfidence('sarah@acme.co.uk', {});
  assert.ok(info > random, `info (${info}) should beat random (${random})`);
});

test('emailConfidence: free mail is downgraded', () => {
  const c = emailConfidence('somebody@gmail.com', {});
  assert.ok(c <= 40, `gmail address should be low confidence, got ${c}`);
});

test('emailConfidence: matching the lead website domain is near-certain', () => {
  const c = emailConfidence('info@acme.co.uk', { website: 'https://www.acme.co.uk' });
  assert.ok(c >= 90, `matched-domain should be high confidence, got ${c}`);
});

/* --------------------------------------------------- source filter */

test('looksLikeContactSource accepts directories', () => {
  assert.equal(looksLikeContactSource('https://www.yell.com/biz/acme'), true);
  assert.equal(looksLikeContactSource('https://checkatrade.com/acme'), true);
  assert.equal(looksLikeContactSource('https://facebook.com/acme.roofing'), true);
});

test('looksLikeContactSource rejects random news/forum results', () => {
  assert.equal(looksLikeContactSource('https://reddit.com/r/plumbing'), false);
  assert.equal(looksLikeContactSource('https://bbc.co.uk/news/leeds-123'), false);
});
