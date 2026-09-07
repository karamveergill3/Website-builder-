/**
 * Every control on a settings form must actually reach the server.
 *
 * Three separate bugs in this project have been the same shape: a field was
 * added to a view and one of the places that has to know about it was missed.
 * The symptom is always the same and always baffling — the control looks
 * saved and silently is not, or it unticks itself the moment you press Save.
 *
 *   hunt_max_per_trade   missing from ALLOWED_KEYS, so the PUT was rejected
 *                        and nothing on the form saved at all
 *   hunt_require_phone   missing from the view's checkbox list, so it was
 *                        sent as the string "on", which is not "1", so it
 *                        read back as off
 *
 * These read the view source rather than a rendered page, so they run in the
 * suite with no browser and catch the omission at the point it is made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = resolve(ROOT, 'public', 'js', 'views');

const { ALLOWED_KEYS, DEFAULTS } = await import('../server/routes/settings.js');

/** Every name="..." on an input, select or textarea across the views. */
function namedFields(file) {
  const src = readFileSync(resolve(VIEWS, file), 'utf8');
  return [...src.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)]
    .map((m) => m[1]);
}

const viewFiles = readdirSync(VIEWS).filter((f) => f.endsWith('.js'));

test('every settings field on a form is a key the server will accept', () => {
  // A key the PUT rejects does not just fail on its own — the whole request
  // is refused, so every other field on that form silently fails to save too.
  for (const file of viewFiles) {
    for (const name of namedFields(file)) {
      // Only the settings namespaces; forms post plenty of other things.
      if (!/^(hunt|biz|gmail|window|warmup|daily|send|spam|verify|domain|list|default|optout|marketing|source)_/.test(name)) continue;
      assert.ok(ALLOWED_KEYS.has(name),
        `${file}: "${name}" is on a form but not in ALLOWED_KEYS — the PUT `
        + 'carrying it will be rejected, taking every other field with it');
    }
  }
});

test('every hunt setting the form posts has a default', () => {
  // Without one, the first read before anything is saved falls through to
  // whatever the caller guessed, and the form and the hunt can disagree.
  for (const file of viewFiles) {
    for (const name of namedFields(file)) {
      if (!name.startsWith('hunt_')) continue;
      assert.ok(name in DEFAULTS, `${file}: "${name}" has no entry in DEFAULTS`);
    }
  }
});

test('no view normalises checkboxes from a hardcoded list of names', () => {
  // The list goes stale the moment a checkbox is added, and FormData omits
  // an unchecked box entirely — so a name that is missing gets saved as the
  // literal "on", reads back as off, and appears to untick itself on save.
  // Deriving the list from the form cannot go stale.
  for (const file of viewFiles) {
    const src = readFileSync(resolve(VIEWS, file), 'utf8');
    assert.doesNotMatch(src, /===\s*'on'\s*\?/,
      `${file}: normalise checkboxes by querying the form for `
      + 'input[type="checkbox"], not from a list of names');
  }
});

test('the hunt form covers the options the hunt actually reads', () => {
  // A setting the hunt honours but the screen cannot reach is only editable
  // by hand-editing the database.
  const names = new Set(namedFields('hunt.js'));
  for (const key of [
    'hunt_trades', 'hunt_areas', 'hunt_daily_target', 'hunt_hour',
    'hunt_max_per_trade', 'hunt_require_no_website', 'hunt_require_phone',
    'hunt_require_mobile', 'hunt_include_unlisted', 'hunt_enabled',
  ]) {
    assert.ok(names.has(key), `the Hunt screen has no control for ${key}`);
  }
});

test('the hunt budget ships high enough to actually reach a target', () => {
  // It shipped at 25 register pages / 40 lookups. Because most high-street
  // trades are sole traders the register does not hold, that burned out after
  // a handful of limited companies and stopped — looking like it had run out
  // of towns. If someone lowers these again, a fresh install goes back to
  // finding single figures and no test would have said why.
  assert.ok(Number(DEFAULTS.hunt_max_register_pages) >= 150,
    'register pages default is too low to plough past the sole traders');
  assert.ok(Number(DEFAULTS.hunt_max_places_requests) >= 100,
    'Google-lookup default is too low to reach a 20 target');
  // ...but the lookups must stay inside the free 5,000/SKU/month even run
  // daily: value x 30 days must not exceed 5,000.
  assert.ok(Number(DEFAULTS.hunt_max_places_requests) * 30 <= 5000,
    'a daily run at this budget would blow the free Google allowance');
});
