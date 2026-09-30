/* How old a company is, by its date of incorporation.
 *
 * The one home of the line between a newly registered company and an
 * established one. The server reads it (the hunt, and the one-off register
 * search) and so does the browser (the Leads row), which is why it lives
 * under public/js: the browser can only load what is served, and this file
 * has no imports, so Node loads it just the same. One rule, drawn once, so
 * the Hunt and the Leads screen can never disagree about which is which.
 */

/** Under this many months since incorporation is a new company; this or more is established. */
export const NEW_COMPANY_MONTHS = 24;

/** The choices the hunt offers, 'any' first because it is the default. */
export const COMPANY_AGES = ['any', 'new', 'established'];

/** A stored or posted choice, read safely: anything unrecognised is 'any', today's behaviour. */
export const companyAgeChoice = (value) => {
  const v = String(value ?? '').trim();
  return COMPANY_AGES.includes(v) ? v : 'any';
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The register's date_of_creation as a plain 'YYYY-MM-DD', or null when it is
 * missing or not a real day. Strings in that shape sort as dates, so the
 * comparisons below are plain string comparisons with no time zone in them.
 */
function dayOf(value) {
  const m = DATE.exec(String(value ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Date.UTC rolls 2024-02-30 over into March; a rolled-over day was not a date.
  return d.getUTCMonth() === Number(m[2]) - 1 ? d.toISOString().slice(0, 10) : null;
}

/**
 * The latest incorporation day that is already two years old today, in UTC.
 * Counted in calendar months rather than days, so a leap year moves nothing:
 * on 29 September 2026 it is 29 September 2024. A company formed on that day
 * turns two today, so it is established; one formed the day after is new.
 *
 * A day the earlier month does not have (29 February, two years before a
 * leap day) becomes that month's last day. Rolling it on into 1 March would
 * call a company formed on 1 March established a day before its birthday.
 */
export function establishedCutoff(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - NEW_COMPANY_MONTHS;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), lastDay)))
    .toISOString().slice(0, 10);
}

/** 'new', 'established', or null when there is no usable date to judge by. */
export function companyAgeBand(dateOfCreation, now = new Date()) {
  const day = dayOf(dateOfCreation);
  if (!day) return null;
  return day > establishedCutoff(now) ? 'new' : 'established';
}

/**
 * Does this company belong in the chosen age? 'any' takes everyone, dated or
 * not. 'new' or 'established' needs a date that says so: a company with no
 * date cannot be shown to be either, so it is left out rather than guessed at.
 */
export function fitsCompanyAge(dateOfCreation, choice, now = new Date()) {
  const want = companyAgeChoice(choice);
  if (want === 'any') return true;
  return companyAgeBand(dateOfCreation, now) === want;
}

/**
 * The same choice as a register search filter: Companies House takes
 * incorporated_from and incorporated_to as inclusive 'YYYY-MM-DD' days.
 * Nothing for 'any', so the search is exactly what it was before.
 */
export function incorporatedRange(choice, now = new Date()) {
  const cutoff = establishedCutoff(now);
  if (companyAgeChoice(choice) === 'established') return { to: cutoff };
  if (companyAgeChoice(choice) === 'new') {
    const [y, m, d] = cutoff.split('-').map(Number);
    return { from: new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) };
  }
  return {};
}
