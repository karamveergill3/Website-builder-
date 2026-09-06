/**
 * Companies House public data API.
 *
 * This is the piece that makes the tool workable. PECR only lets you
 * cold-email bodies corporate, and nothing in a Google listing tells you
 * whether a business is one. Companies House does, for free, and its data is
 * published under the Open Government Licence — which, unlike Google's terms,
 * permits keeping the company name, number and registered office indefinitely.
 *
 * So it serves two jobs:
 *   1. Qualify — match an existing lead to a register entry and record the
 *      company number as evidence.
 *   2. Discover — enumerate active companies by trade (SIC code) and town.
 *      Every result is a body corporate by construction, which is a far
 *      better funnel than searching a map and hoping.
 *
 * Auth is HTTP Basic with the API key as the username and an EMPTY password.
 * The trailing colon matters: the header is base64("key:"), not base64("key").
 */

const BASE = 'https://api.company-information.service.gov.uk';

/**
 * 600 requests per 5 minutes is 2/second; run at well under that, because
 * Companies House reserve the right to ban applications that push the limit.
 *
 * Requests are serialised through one promise chain rather than each checking
 * a shared timestamp — two concurrent callers reading the same `lastCall`
 * would both decide they were clear to go.
 */
const MIN_GAP_MS = 700;
let gate = Promise.resolve();

function nextSlot() {
  const mine = gate.then(() => sleep(MIN_GAP_MS));
  gate = mine;
  return mine;
}

export class CompaniesHouseError extends Error {
  constructor(message, { status = 502, code, retryable = false } = {}) {
    super(message);
    this.name = 'CompaniesHouseError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const configured = () => Boolean(process.env.COMPANIES_HOUSE_API_KEY?.trim());

function authHeader() {
  const key = process.env.COMPANIES_HOUSE_API_KEY?.trim();
  if (!key) {
    throw new CompaniesHouseError(
      'COMPANIES_HOUSE_API_KEY is not set. A key is free — see docs/COMPANIES-HOUSE.md.',
      { status: 503, code: 'NOT_CONFIGURED' }
    );
  }
  // The empty password, and therefore the colon, is required.
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

async function call(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  await nextSlot();

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
  } catch (err) {
    throw new CompaniesHouseError(`Could not reach Companies House: ${err.message}`,
      { status: 502, code: 'NETWORK', retryable: true });
  }

  if (res.status === 401 || res.status === 403) {
    throw new CompaniesHouseError(
      'Companies House rejected the API key. Check it is a LIVE key, not a sandbox one.',
      { status: 503, code: 'KEY_REJECTED' });
  }
  // Advanced search answers a zero-result query with 404 and an EMPTY body,
  // not hits:0 — so null here means "nothing found", not "no such thing".
  if (res.status === 404) return null;
  if (res.status === 416) {
    throw new CompaniesHouseError('Paged past the end of the results.', { status: 400, code: 'PAGE_TOO_DEEP' });
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get('X-Ratelimit-Reset'));
    throw new CompaniesHouseError('Companies House rate limit reached — wait a few minutes.', {
      status: 429, code: 'RATE_LIMITED', retryable: true,
      resetAt: Number.isFinite(reset) ? reset * 1000 : null,
    });
  }
  if (res.status === 500) {
    throw new CompaniesHouseError(
      'Companies House refused the query — usually too broad. Narrow it by town or trade.',
      { status: 502, code: 'TOO_BROAD' });
  }
  if (!res.ok) {
    throw new CompaniesHouseError(`Companies House returned ${res.status}.`, { status: 502 });
  }
  return res.json();
}

/* ------------------------------------------------------------ entity types */

/**
 * company_type values that ARE bodies corporate — separate legal personality,
 * so outside PECR reg. 22 and lawful to cold-email.
 *
 * Deliberately an allow-list. Companies House adds enumeration values over
 * time, and a deny-list would silently admit each new one as sendable.
 *
 * Excluded on purpose: limited-partnership (an English LP is not a body
 * corporate), scottish-partnership (separate personality under Scots law but
 * not a body corporate), uk-establishment and eeig-establishment (branches,
 * not entities), oversea-company and registered-overseas-entity (not UK
 * incorporations), and `other` (unclassified — never assume).
 */
export const BODIES_CORPORATE = new Set([
  'ltd', 'plc', 'private-unlimited', 'private-unlimited-nsc', 'old-public-company',
  'private-limited-guarant-nsc', 'private-limited-guarant-nsc-limited-exemption',
  'private-limited-shares-section-30-exemption', 'llp',
  'protected-cell-company', 'assurance-company', 'royal-charter', 'unregistered-company',
  'investment-company-with-variable-capital', 'icvc-securities', 'icvc-warrant', 'icvc-umbrella',
  'european-public-limited-liability-company-se', 'united-kingdom-societas',
  'charitable-incorporated-organisation', 'scottish-charitable-incorporated-organisation',
  'further-education-or-sixth-form-college-corporation',
  'northern-ireland', 'northern-ireland-other',
  'registered-society-non-jurisdictional', 'industrial-and-provident-society',
  'eeig', 'ukeig',
]);

export const isBodyCorporate = (companyType) => BODIES_CORPORATE.has(String(companyType ?? ''));

/**
 * Trading now, and not on the way out. "active" alone is not enough: a company
 * with status_detail "active-proposal-to-strike-off" is being dissolved.
 */
export function isTrading(company) {
  if (company?.company_status !== 'active') return false;
  return company?.company_status_detail !== 'active-proposal-to-strike-off';
}

/* --------------------------------------------------------------- endpoints */

/** Free-text search. Matches company NAMES only — not trade. */
export async function searchByName(name, { limit = 20 } = {}) {
  const data = await call('/search/companies', {
    q: name, items_per_page: Math.min(limit, 100), start_index: 0,
  });
  return (data?.items ?? []).map((it) => ({
    company_number: it.company_number,
    company_name: it.title,
    company_status: it.company_status,
    company_type: it.company_type,
    date_of_creation: it.date_of_creation,
    address_snippet: it.address_snippet,
    address: it.address ?? null,
    postal_code: it.address?.postal_code ?? null,
    locality: it.address?.locality ?? null,
  }));
}

/**
 * The useful one: filter by trade and town, and get SIC codes and a full
 * registered office back inline with no follow-up call per company.
 */
export async function advancedSearch({
  sicCodes, location, nameIncludes, companyType, size = 100, startIndex = 0,
} = {}) {
  // Our own guard, not the register's: an unfiltered advanced search is
  // accepted but returns the whole register a page at a time, which is never
  // what anyone meant to ask for.
  if (!sicCodes && !location && !nameIncludes) {
    throw new CompaniesHouseError(
      'Give at least a trade or a town — an unfiltered search returns the entire register.',
      { status: 400, code: 'NEEDS_FILTER' });
  }
  const data = await call('/advanced-search/companies', {
    sic_codes: sicCodes,
    location,
    company_name_includes: nameIncludes,
    company_type: companyType,
    company_status: 'active',
    size: Math.min(size, 5000),
    start_index: startIndex,
  });
  return {
    total: data?.hits ?? 0,
    items: (data?.items ?? []).map((it) => ({
      company_number: it.company_number,
      company_name: it.company_name,
      company_status: it.company_status,
      company_type: it.company_type,
      date_of_creation: it.date_of_creation,
      sic_codes: it.sic_codes ?? [],
      address: it.registered_office_address ?? null,
      postal_code: it.registered_office_address?.postal_code ?? null,
      locality: it.registered_office_address?.locality ?? null,
      address_snippet: formatAddress(it.registered_office_address),
    })),
  };
}

/** Full profile. Note this endpoint calls the type field `type`, not `company_type`. */
export async function profile(companyNumber) {
  const data = await call(`/company/${encodeURIComponent(String(companyNumber).trim())}`);
  if (!data) return null;
  return {
    company_number: data.company_number,
    company_name: data.company_name,
    company_status: data.company_status,
    company_status_detail: data.company_status_detail ?? null,
    company_type: data.type,
    date_of_creation: data.date_of_creation,
    sic_codes: data.sic_codes ?? [],
    jurisdiction: data.jurisdiction,
    address: data.registered_office_address ?? null,
    address_snippet: formatAddress(data.registered_office_address),
    has_insolvency_history: Boolean(data.has_insolvency_history),
  };
}

export function formatAddress(a) {
  if (!a) return null;
  return [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code]
    .map((p) => (p ?? '').trim()).filter(Boolean).join(', ') || null;
}

/* ---------------------------------------------------------------- matching */

const NOISE = new Set([
  'ltd', 'limited', 'plc', 'llp', 'cic', 'co', 'company', 'the', 'and', 'group',
  'services', 'service', 'uk', 'holdings', 'trading', 'contractors', 'contracting',
]);

/** Strip punctuation, legal suffixes and filler so two names can be compared. */
export function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim();
}

const tokens = (name) => new Set(normaliseName(name).split(' ').filter(Boolean));

/**
 * How confident we are that a register entry is the business we were looking
 * at. 1 is an exact match of the distinctive words; 0 shares nothing.
 *
 * A location hint adds confidence but never creates it — a name that does not
 * match is not rescued by being in the right town.
 */
export function matchScore(businessName, candidate, { location } = {}) {
  const a = tokens(businessName);
  const b = tokens(candidate.company_name);
  if (!a.size || !b.size) return 0;

  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  // Jaccard-ish, but weighted toward covering the shorter name: "Hillside
  // Roofing" should match "HILLSIDE ROOFING AND LEADWORK LIMITED".
  let score = shared / Math.min(a.size, b.size);
  if (shared === 0) return 0;
  if (a.size !== b.size) score *= 0.9 + 0.1 * (Math.min(a.size, b.size) / Math.max(a.size, b.size));

  if (location) {
    const where = `${candidate.locality ?? ''} ${candidate.postal_code ?? ''} ${candidate.address_snippet ?? ''}`.toLowerCase();
    if (where.includes(String(location).toLowerCase())) score = Math.min(1, score + 0.15);
  }
  return Number(score.toFixed(3));
}

/** Auto-accept at this score; anything lower is offered for a human to pick. */
export const AUTO_MATCH = 0.9;

/**
 * Find the register entry for a business name. Returns the ranked candidates
 * and, only when one is clearly right and lawful to email, an auto pick.
 */
export async function findCompany(businessName, { location, limit = 20 } = {}) {
  const results = await searchByName(businessName, { limit });
  const ranked = results
    .map((c) => ({ ...c, score: matchScore(businessName, c, { location }) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const runnerUp = ranked[1];

  const auto = best
    && best.score >= AUTO_MATCH
    && isTrading(best)
    && isBodyCorporate(best.company_type)
    // Refuse to guess between two similarly-good matches.
    && (!runnerUp || best.score - runnerUp.score >= 0.15)
    ? best : null;

  return { candidates: ranked.slice(0, 10), auto };
}
