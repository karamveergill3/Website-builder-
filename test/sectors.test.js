/**
 * Which opener a trade gets.
 *
 * The point of the sectors is that the right message picks itself: a salon
 * gets the salon opener, a roofer the trades one, everything else the generic
 * one. The mapping is what decides that, so it is what gets tested — including
 * the trades the owner most cares about, which are the ones the old wording
 * read worst for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorFor, sectorLabel } from '../server/lib/sectors.js';

test('beauty trades map to the salon opener', () => {
  for (const c of ['hairdresser', 'barber', 'nail bar', 'nails', 'beauty salon',
                   'lash tech', 'brow bar', 'aesthetics clinic', 'tanning', 'spa']) {
    assert.equal(sectorFor(c), 'salon', `"${c}" should be a salon`);
  }
  assert.equal(sectorLabel('salon'), 'Salons & beauty');
});

test('building trades map to the trades opener', () => {
  for (const c of ['roofers', 'plumber', 'electrician', 'plasterer', 'builder',
                   'joiner', 'landscaper', 'fencing', 'block paving', 'scaffolder',
                   'bricklayer', 'groundworks', 'bathroom fitter']) {
    assert.equal(sectorFor(c), 'trades', `"${c}" should be a trade`);
  }
  assert.equal(sectorLabel('trades'), 'Trades');
});

test('everything else falls back to the generic opener', () => {
  for (const c of ['cafe', 'takeaway', 'restaurant', 'garage', 'boutique',
                   'driving instructor', 'accountant', '']) {
    assert.equal(sectorFor(c), null, `"${c}" has no dedicated opener`);
  }
  assert.equal(sectorLabel(null), null);
  assert.equal(sectorLabel('nope'), null);
});

test('matching is case-insensitive and tolerant of extra words', () => {
  assert.equal(sectorFor('Mobile Hairdresser & Barber'), 'salon');
  assert.equal(sectorFor('ROOFING CONTRACTOR'), 'trades');
});
