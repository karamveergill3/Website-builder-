import test from 'node:test';
import assert from 'node:assert/strict';

const {
  NEW_COMPANY_MONTHS, COMPANY_AGES, companyAgeChoice, establishedCutoff,
  companyAgeBand, fitsCompanyAge, incorporatedRange,
} = await import('../public/js/company-age.js');

// A fixed "today", so the boundary is exact whatever day the suite runs.
const TODAY = new Date('2026-09-29T12:00:00Z');

test('the line is two years, drawn once', () => {
  assert.equal(NEW_COMPANY_MONTHS, 24);
  assert.deepEqual(COMPANY_AGES, ['any', 'new', 'established']);
});

test('a company turns established on its second birthday, not a day before', () => {
  assert.equal(establishedCutoff(TODAY), '2024-09-29');
  assert.equal(companyAgeBand('2024-09-29', TODAY), 'established', 'two years old today');
  assert.equal(companyAgeBand('2024-09-30', TODAY), 'new', 'two years old tomorrow');
  assert.equal(companyAgeBand('2024-09-28', TODAY), 'established');
  assert.equal(companyAgeBand('2026-09-29', TODAY), 'new', 'formed today');
});

test('the day is counted in UTC, whatever the hour', () => {
  assert.equal(establishedCutoff(new Date('2026-09-29T23:59:59Z')), '2024-09-29');
  assert.equal(establishedCutoff(new Date('2026-09-30T00:00:00Z')), '2024-09-30');
});

test('a leap day two years on is the end of February, not the first of March', () => {
  const leapDay = new Date('2028-02-29T12:00:00Z');
  assert.equal(establishedCutoff(leapDay), '2026-02-28');
  assert.equal(companyAgeBand('2026-02-28', leapDay), 'established');
  assert.equal(companyAgeBand('2026-03-01', leapDay), 'new', 'a day short of two');
});

test('no usable date is no band at all', () => {
  for (const d of [null, undefined, '', 'yesterday', '2024-02-30', '2024-13-01', '24-09-29']) {
    assert.equal(companyAgeBand(d, TODAY), null, JSON.stringify(d));
  }
  assert.equal(companyAgeBand('2014-06-01T00:00:00Z', TODAY), 'established',
    'a timestamp is read by its day');
});

test('any takes everyone; new or established needs a date that says so', () => {
  assert.equal(fitsCompanyAge(null, 'any', TODAY), true);
  assert.equal(fitsCompanyAge('2025-06-01', 'any', TODAY), true);
  assert.equal(fitsCompanyAge('2025-06-01', 'new', TODAY), true);
  assert.equal(fitsCompanyAge('2025-06-01', 'established', TODAY), false);
  assert.equal(fitsCompanyAge('2014-06-01', 'new', TODAY), false);
  assert.equal(fitsCompanyAge('2014-06-01', 'established', TODAY), true);
  assert.equal(fitsCompanyAge(null, 'new', TODAY), false);
  assert.equal(fitsCompanyAge(undefined, 'established', TODAY), false);
});

test('an unrecognised choice is read as any', () => {
  assert.equal(companyAgeChoice('new'), 'new');
  assert.equal(companyAgeChoice(' established '), 'established');
  for (const v of [undefined, null, '', 'bogus', 'NEW']) assert.equal(companyAgeChoice(v), 'any');
  assert.equal(fitsCompanyAge(null, 'bogus', TODAY), true);
});

test('the register search gets the same line as inclusive dates', () => {
  assert.deepEqual(incorporatedRange('new', TODAY), { from: '2024-09-30' });
  assert.deepEqual(incorporatedRange('established', TODAY), { to: '2024-09-29' });
  assert.deepEqual(incorporatedRange('any', TODAY), {});
  // Month and year ends roll over properly.
  assert.deepEqual(incorporatedRange('new', new Date('2026-12-31T12:00:00Z')), { from: '2025-01-01' });
});
