/**
 * Town presets.
 *
 * These strings are sent to Companies House as the `location` filter, which
 * partial-matches the locality line of a registered office address. A name
 * spelled the way a map spells it rather than the way an envelope does
 * produces a target that silently returns nothing for ever — no error, no
 * empty-result warning, just a trade/town pair that never finds anybody. So
 * the spellings are the thing worth testing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { REGIONS, regionList, townsFor, mergeTowns, regionTownsForName, expandAreas } =
  await import('../server/lib/towns.js');

test('every region has a key, a label and towns', () => {
  assert.ok(REGIONS.length >= 5, 'enough regions to be worth a button row');
  for (const r of REGIONS) {
    assert.match(r.key, /^[a-z-]+$/, `${r.label}: key is url-safe`);
    assert.ok(r.label && r.note, `${r.key}: labelled and explained`);
    assert.ok(r.towns.length >= 10, `${r.key}: ${r.towns.length} towns is too few to be a region`);
  }
});

test('region keys are unique', () => {
  const keys = REGIONS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('no town is listed twice within a region', () => {
  for (const r of REGIONS) {
    const norm = r.towns.map((t) => t.toLowerCase());
    assert.equal(new Set(norm).size, norm.length, `${r.key} repeats a town`);
  }
});

test('town names are written the way an address writes them', () => {
  for (const r of REGIONS) {
    for (const t of r.towns) {
      assert.equal(t, t.trim(), `"${t}" has stray whitespace`);
      assert.doesNotMatch(t, /\s{2,}/, `"${t}" has a double space`);
      // A comma or a postcode means someone pasted a whole address line.
      assert.doesNotMatch(t, /[,;]/, `"${t}" looks like an address, not a locality`);
      assert.doesNotMatch(t, /\b[A-Z]{1,2}\d/, `"${t}" contains a postcode`);
      // The county name is never the locality, and matching on it would drag
      // in every town in it.
      assert.notEqual(t.toLowerCase(), r.label.toLowerCase(),
        `${r.key} lists its own county as a town`);
    }
  }
});

test('the compound names keep their hyphens', () => {
  // 'Stoke on Trent' matches nothing: the register holds 'Stoke-on-Trent'.
  const all = REGIONS.flatMap((r) => r.towns);
  for (const [wrong, right] of [
    ['Stoke on Trent', 'Stoke-on-Trent'],
    ['Newcastle under Lyme', 'Newcastle-under-Lyme'],
  ]) {
    assert.ok(!all.includes(wrong), `"${wrong}" must be hyphenated`);
    assert.ok(all.includes(right), `"${right}" should be present`);
  }
});

test('suburbs addressed as their parent town are not listed separately', () => {
  // Post to Wellington says Telford; to Bloxwich says Walsall. Listing them
  // would add targets that never match anything. The parent covers them.
  const all = REGIONS.flatMap((r) => r.towns).map((t) => t.toLowerCase());
  for (const [suburb, parent] of [
    ['wellington', 'Telford'],
    ['bloxwich', 'Walsall'],
    ['aldridge', 'Walsall'],
    ['wednesfield', 'Wolverhampton'],
    ['hanley', 'Stoke-on-Trent'],
    ['burslem', 'Stoke-on-Trent'],
  ]) {
    assert.ok(!all.includes(suburb),
      `"${suburb}" is addressed as ${parent}, so it must not be its own entry`);
    assert.ok(all.includes(parent.toLowerCase()), `${parent} is listed`);
  }
});

test('the home county and the West Midlands are both covered', () => {
  // The two that matter for a Stafford business.
  const staffs = townsFor('staffordshire');
  assert.ok(staffs.includes('Stafford'));
  assert.ok(staffs.includes('Stoke-on-Trent'));
  assert.ok(staffs.includes('Cannock'));

  const wm = townsFor('west-midlands');
  for (const t of ['Birmingham', 'Wolverhampton', 'Walsall', 'Dudley', 'West Bromwich']) {
    assert.ok(wm.includes(t), `West Midlands should include ${t}`);
  }
});

test('townsFor returns a copy, so a caller cannot edit the preset', () => {
  const a = townsFor('staffordshire');
  a.push('Nowhere');
  assert.ok(!townsFor('staffordshire').includes('Nowhere'));
  assert.equal(townsFor('no-such-region'), null);
});

test('regionList carries counts but not the towns themselves', () => {
  const list = regionList();
  assert.equal(list.length, REGIONS.length);
  for (const r of list) {
    assert.equal(typeof r.count, 'number');
    assert.equal(r.towns, undefined, 'the button row does not need the lists');
  }
});

/* ------------------------------------------------------------- merging */

test('merging keeps what the user typed, in their order', () => {
  const mine = ['Stafford', 'Rugeley'];
  const merged = mergeTowns(mine, ['Birmingham', 'Dudley']);
  assert.deepEqual(merged.slice(0, 2), mine, 'their lines stay first');
  assert.deepEqual(merged, ['Stafford', 'Rugeley', 'Birmingham', 'Dudley']);
});

test('merging is case- and punctuation-insensitive', () => {
  // Otherwise clicking a region twice leaves 'stoke on trent' sitting next to
  // 'Stoke-on-Trent', and the hunt works both as separate towns.
  const merged = mergeTowns(
    ['stoke on trent', 'NEWCASTLE-UNDER-LYME', '  Stafford  '],
    ['Stoke-on-Trent', 'Newcastle-under-Lyme', 'Stafford', 'Cannock']
  );
  assert.equal(merged.length, 4, 'only Cannock is genuinely new');
  assert.ok(merged.includes('Cannock'));
});

test('merging a region twice adds nothing the second time', () => {
  const once = mergeTowns([], townsFor('west-midlands'));
  const twice = mergeTowns(once, townsFor('west-midlands'));
  assert.deepEqual(twice, once);
});

test('merging tolerates empty and missing input', () => {
  assert.deepEqual(mergeTowns(), []);
  assert.deepEqual(mergeTowns(['Stafford']), ['Stafford']);
  assert.deepEqual(mergeTowns([], ['', '   ']), [], 'blank lines are not towns');
});

/* ------------------------------------------- region names typed by hand */

test('a region name resolves to its towns', () => {
  assert.deepEqual(regionTownsForName('West Midlands'), townsFor('west-midlands'));
  assert.deepEqual(regionTownsForName('west midlands'), townsFor('west-midlands'), 'loosely matched');
  assert.deepEqual(regionTownsForName('Staffordshire'), townsFor('staffordshire'));
  assert.deepEqual(regionTownsForName('west-midlands'), townsFor('west-midlands'), 'the key works too');
  assert.equal(regionTownsForName('Stafford'), null, 'a town is not a region');
  assert.equal(regionTownsForName(''), null);
});

test('expandAreas turns a typed region into its towns', () => {
  // This is the bug behind "80 trades, 5 companies": a whole-region line was
  // sent to the register as one location and the town check then binned it.
  const out = expandAreas(['West Midlands', 'Stafford']);
  assert.ok(out.includes('Birmingham'), 'the region became its towns');
  assert.ok(out.includes('Wolverhampton'));
  assert.ok(out.includes('Stafford'), 'a genuine town is kept');
  assert.ok(!out.includes('West Midlands'), 'the region name itself is gone');
});

test('expandAreas leaves plain towns alone and de-dupes', () => {
  assert.deepEqual(expandAreas(['Stafford', 'Rugeley']), ['Stafford', 'Rugeley']);
  // Stafford is in the Staffordshire preset, so it must not appear twice.
  const out = expandAreas(['Stafford', 'Staffordshire']);
  assert.equal(out.filter((t) => t.toLowerCase() === 'stafford').length, 1);
});
