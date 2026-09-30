/**
 * Every kind of business gets its own opener.
 *
 * One WhatsApp template, with its middle paragraph and sign-off written per
 * business (lib/pitches.js). These hold every pitch to the style Keylo signed
 * off, and make sure no trade the hunt searches for falls through to the
 * general wording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { PITCHES, SECTOR_PITCHES, GENERAL_PITCH } = await import('../server/lib/pitches.js');
const { pitchFor } = await import('../server/lib/pitch-match.js');
const { TRADES } = await import('../server/lib/sic.js');

const ALL = [...PITCHES, ...Object.values(SECTOR_PITCHES), GENERAL_PITCH];

test('every pitch keeps the house style', () => {
  for (const p of ALL) {
    const where = `${p.business}: ${p.pitch}`;
    assert.ok(!/[—–]/.test(p.pitch) && !/\s-\s/.test(p.pitch), `no dashes. ${where}`);
    assert.ok(!/\bsimple\b/i.test(p.pitch), `never "simple". ${where}`);
    assert.ok(!/[!]/.test(p.pitch), `no exclamation marks. ${where}`);
    assert.match(p.pitch, /That's exactly what we build: /, where);
    const words = p.pitch.split(/\s+/).length;
    assert.ok(words >= 25 && words <= 70, `${words} words. ${where}`);
    assert.ok(p.close && !/[—–]/.test(p.close), `a closing line with no dashes. ${p.business}`);
    assert.ok(p.close.split(/\s+/).length <= 12, `a short close. ${p.business}: ${p.close}`);
  }
});

test('the written pitches are specific: sentence one is about that business', () => {
  for (const p of PITCHES) {
    assert.match(p.pitch, /^For an? /, `${p.business}: ${p.pitch}`);
    assert.ok(!/\bone page\b/i.test(p.pitch), `no "one page": ${p.business}`);
    assert.ok(p.terms.length > 0, p.business);
  }
});

test('every search term the hunt uses has a pitch of its own', () => {
  const owner = new Map();
  for (const p of PITCHES) {
    for (const t of p.terms) {
      assert.ok(!owner.has(t), `"${t}" is claimed by both ${owner.get(t)} and ${p.business}`);
      owner.set(t, p.business);
    }
  }
  const missing = [...new Set(TRADES.flatMap((t) => t.terms))].filter((t) => !owner.has(t));
  assert.deepEqual(missing, [], 'these fall through to the general wording');
});

test('no two kinds of business share a pitch', () => {
  const seen = new Map();
  for (const p of PITCHES) {
    assert.ok(!seen.has(p.pitch), `${p.business} repeats ${seen.get(p.pitch)}`);
    seen.set(p.pitch, p.business);
  }
});

test('the closing line never assumes the day, the time or the season', () => {
  for (const p of ALL) {
    assert.ok(!/\b(weekend|tonight|this morning|this afternoon|summer|winter|again)\b/i.test(p.close),
      `${p.business}: ${p.close}`);
  }
});

test('a lead is matched to its own business, however the trade is written', () => {
  const is = (category, business) => assert.equal(pitchFor(category).business, business, category);
  is('roofers', 'roofer');
  is('Roofer', 'roofer');
  is('Roofing contractor', 'roofer');
  is('dog groomers', 'dog groomer');
  is('Mobile dog groomer', 'dog groomer');
  is('Barbers', 'barber');
  is('barbershop', 'barber');
  is('window cleaner', 'window cleaner');
  is('chinese takeaway', 'Chinese takeaway');
  is('Nail salon', 'nail tech');
  is('hair salon', 'hairdresser');
  is('carpet cleaning', 'carpet cleaner');
  is('carpet fitter', 'carpet fitter');
  is('security systems', 'security installer');
  is('cctv drain', 'CCTV drain survey company');
  is('Plumbing, heating and air conditioning', 'plumber');
  // Neighbours that must not borrow each other's wording.
  assert.notEqual(pitchFor('window cleaner'), pitchFor('glazier'));
  assert.notEqual(pitchFor('dog walker'), pitchFor('dog groomer'));
  assert.notEqual(pitchFor('wedding photographer'), pitchFor('photographer'));
});

test('a business outside the list falls back to its sector, then to the general wording', () => {
  assert.equal(pitchFor('pet shop'), SECTOR_PITCHES.pets);
  assert.equal(pitchFor('nightclub'), GENERAL_PITCH);
});

test('an unknown business still reads naturally', () => {
  assert.equal(pitchFor('accountant'), GENERAL_PITCH);
  assert.equal(pitchFor(''), GENERAL_PITCH);
  assert.equal(pitchFor(null), GENERAL_PITCH);
});
