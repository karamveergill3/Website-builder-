/**
 * The brief extractor's rules pass. No model is involved in any of these —
 * every case here must resolve deterministically, because the rules are what
 * runs on a machine with no Ollama installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractByRules, stripQuoted, numberedAnswers, splitServices, briefForBuild, CTAS,
} from '../server/lib/brief.js';

const lead = {
  business_name: 'Hillside Roofing Ltd',
  category: 'roofer',
  location: 'Wolverhampton',
  phone: '07123456789',
};

/* --------------------------------------------------------- quote stripping */

test('the quoted original is stripped so we do not read our own questions', () => {
  const body = `Thanks, sounds good.

On Mon, 6 Sep 2026 at 09:12, A Sender <sender@example.com> wrote:
> 1. What are the main things you do?
> 2. Do you have a logo?
> 3. What should someone be able to do first — call, quote, book?`;

  const clean = stripQuoted(body);
  assert.equal(/What are the main things/.test(clean), false);
  assert.equal(clean.trim(), 'Thanks, sounds good.');
});

test('an Outlook-style quoted block is stripped', () => {
  const clean = stripQuoted('My answer here.\n\nFrom: A Sender\nSent: Monday\nTo: Dave');
  assert.equal(clean, 'My answer here.');
});

/* ------------------------------------------------------- numbered answers */

test('numbered answers are split on any of the common markers', () => {
  for (const body of [
    '1. Roofing\n2. No logo\n3. Call us',
    '1) Roofing\n2) No logo\n3) Call us',
    '(1) Roofing\n(2) No logo\n(3) Call us',
  ]) {
    const a = numberedAnswers(body);
    assert.equal(a.size, 3, body);
    assert.equal(a.get(1), 'Roofing');
    assert.equal(a.get(3), 'Call us');
  }
});

test('a numbered answer can run over several lines', () => {
  const a = numberedAnswers('1. Roofing\nand guttering\n2. No logo');
  assert.equal(a.get(1), 'Roofing\nand guttering');
});

/* -------------------------------------------------------- service parsing */

test('splitServices drops the leading verb phrase', () => {
  assert.deepEqual(splitServices('We do roofing, guttering and flat roofs'),
    ['Roofing', 'Guttering', 'Flat roofs']);
  assert.deepEqual(splitServices('we mostly do roofs and guttering'),
    ['Roofs', 'Guttering']);
});

test('splitServices cuts at the first sentence end — the rest is commentary', () => {
  assert.deepEqual(
    splitServices('Roofing and guttering. Mainly want more domestic work.'),
    ['Roofing', 'Guttering']
  );
});

test('splitServices cuts where the coverage area starts', () => {
  assert.deepEqual(
    splitServices('roofs and guttering round wolverhampton and dudley'),
    ['Roofs', 'Guttering']
  );
});

test('splitServices does not cut "specialists in X" at the in', () => {
  const out = splitServices('We specialise in leadwork and chimney repairs');
  assert.ok(out.includes('Leadwork'), JSON.stringify(out));
  assert.ok(out.includes('Chimney repairs'), JSON.stringify(out));
});

/* --------------------------------------------------- the full rules pass */

test('a fully structured reply parses with no gaps', () => {
  const r = extractByRules(`
1. We do roofing, guttering and flat roofs. Mainly want more domestic work.
2. No logo yet but I've got loads of photos of past jobs I can send over.
3. Mainly people ringing us, that's how we get most work.
`, lead);

  assert.deepEqual(r.services, ['Roofing', 'Guttering', 'Flat roofs']);
  assert.equal(r.primary_cta, 'call');
  assert.equal(r.has_logo, false);
  assert.equal(r.has_photos, true, 'photos are a yes even though the same sentence denies a logo');
  assert.deepEqual(r.missing, []);
  assert.equal(r.confidence, 100);
});

test('"ringing us" is read as wanting phone calls', () => {
  // \bring\b does not match "ringing"; if the inflection is missed the
  // extractor falls through to whatever else the reply mentions.
  const r = extractByRules('1. Roofing\n2. Got photos\n3. People ringing us', lead);
  assert.equal(r.primary_cta, 'call');
});

test('a negation binds only to the thing it precedes', () => {
  const r = extractByRules("2. No logo but I've got photos", lead);
  assert.equal(r.has_logo, false);
  assert.equal(r.has_photos, true);
});

test('loose prose still yields services, area and a CTA', () => {
  const r = extractByRules(
    'yeah sounds good mate. we mostly do roofs and guttering round wolverhampton '
    + 'and dudley. main thing is people giving us a bell. no logo or anything.',
    lead
  );
  assert.deepEqual(r.services, ['Roofs', 'Guttering']);
  assert.equal(r.primary_cta, 'call');
  assert.ok(r.areas.includes('Dudley'), JSON.stringify(r.areas));
  assert.ok(r.confidence < 100, 'prose should not score as high as a numbered reply');
});

test('brand colours are picked up as words and as hex', () => {
  const r = extractByRules("2. Got a logo, it's navy and gold", lead);
  assert.deepEqual(r.brand_colours, ['navy', 'gold']);

  const hex = extractByRules('2. Brand colour is #1a3d5c', lead);
  assert.deepEqual(hex.brand_colours, ['#1a3d5c']);
});

test('every CTA keyword maps to a valid option', () => {
  const cases = {
    'book me in':                  'book',
    'request a quote':             'quote',
    'see prices':                  'prices',
    'look at previous work':       'gallery',
    'give us a ring':              'call',
    'fill in an enquiry form':     'enquire',
  };
  for (const [phrase, expected] of Object.entries(cases)) {
    const r = extractByRules(`3. ${phrase}`, lead);
    assert.equal(r.primary_cta, expected, phrase);
    assert.ok(CTAS.includes(r.primary_cta));
  }
});

test('the lead town is always present in areas', () => {
  const r = extractByRules('1. Roofing', lead);
  assert.deepEqual(r.areas, ['Wolverhampton']);
});

test('an unparseable reply reports its gaps rather than inventing answers', () => {
  const r = extractByRules('Sounds interesting, tell me more.', { business_name: 'X' });
  assert.deepEqual(r.services, []);
  assert.equal(r.primary_cta, null);
  assert.ok(r.missing.includes('services'));
  assert.ok(r.missing.includes('primary_cta'));
});

/* ----------------------------------------------------------- build shape */

test('briefForBuild fills defaults so a thin brief still builds a site', () => {
  const thin = extractByRules('Sounds interesting.', lead);
  const b = briefForBuild(thin, lead);
  assert.equal(b.business_name, 'Hillside Roofing Ltd');
  assert.ok(b.services.length, 'must fall back to something buildable');
  assert.equal(b.primary_cta, 'call', 'call is the safe default for a trade');
  assert.equal(b.phone, '07123456789');
});
