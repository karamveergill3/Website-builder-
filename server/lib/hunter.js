/**
 * The daily hunt: find qualified prospects without anyone driving it.
 *
 * Companies House gives us active limited companies by trade and town — every
 * one lawful to email. What it cannot say is which of them have a website,
 * and that is the whole point of the list.
 *
 * The cheap way to answer that: one Places text search for "roofers in Otley"
 * returns twenty businesses WITH their website status for a single billed
 * request. Matching that page against the register list costs one or two
 * requests per town rather than one per company — roughly twenty times less
 * than checking each company individually.
 *
 * A company falls into one of three buckets:
 *   - on Google with a website   -> not a prospect
 *   - on Google with no website  -> a prospect
 *   - not on Google at all       -> a prospect, and often the best kind,
 *                                   though a registered office can be an
 *                                   accountant's address rather than a yard
 *
 * Nothing here sends anything. It finds and files; sending stays behind the
 * confirmation in the Outbox.
 */
import { db, getSetting } from '../db.js';
import { nowIso } from './http.js';
import {
  advancedSearch, searchByName, isBodyCorporate, isTrading, normaliseName, CompaniesHouseError,
  matchScore, AUTO_MATCH,
} from './companies-house.js';
import { resolveTrade, TRADES } from './sic.js';
import {
  textSearch, normalise as normalisePlace, PlacesError,
  configured as placesConfigured, LOOKUP_MASK,
} from './places.js';
import { normalisePhone } from './handoff.js';
import { recordFound, knownCompanyNumbers, ledgerFor } from './recontact.js';
import { nextAssignee } from './assign.js';
import { expandAreas } from './towns.js';
import { findWebsite, postcodeIn } from './site-check.js';

const PAGE = 100;
/** Re-open an exhausted trade/town after this long; new companies incorporate. */
const REOPEN_AFTER_DAYS = 30;
/** Re-ask the register about a Google listing it said was not a company. */
const RECHECK_AFTER_DAYS = 30;
/** Per-company Google lookups one trade/town may spend before the next gets a turn. */
const LOOKUPS_PER_TARGET = 8;
/**
 * How long a website verdict is trusted. A firm found WITH a site keeps it;
 * one found without may get one, so that answer is re-checked monthly.
 */
const SITE_KEEP_DAYS = { site: 180, none: 30 };
/** Web searches one run may make; DuckDuckGo is free but not unlimited. */
const SITE_SEARCHES_PER_RUN = 40;
/** The pause between web searches (tests set SITE_SEARCH_GAP_MS=0). */
export const searchGapMs = () => {
  const n = Number(process.env.SITE_SEARCH_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 4_000;
};

const lines = (v) => String(v ?? '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);

export function huntConfig() {
  const num = (k, d) => {
    const n = Number(getSetting(k, String(d)));
    return Number.isFinite(n) ? n : d;
  };

  // The headline choice. On, the hunt files ONLY businesses you can lawfully
  // WhatsApp today: a confirmed limited company (the register guarantees the
  // legal form), with no website, carrying a real 07 mobile. Everything else —
  // sole traders, companies with no number, and Google listings whose legal
  // form is unknown — never reaches the list, so nothing lands blocked.
  const messageableOnly = getSetting('hunt_messageable_only', '1') === '1';
  const includePlaces = getSetting('hunt_include_places', '1') === '1';

  const cfg = {
    enabled: getSetting('hunt_enabled', '0') === '1',
    trades: lines(getSetting('hunt_trades', '')),
    // A region typed by hand ('West Midlands') becomes its towns, so the
    // register and town checks — which work on towns, not counties — actually
    // match. Without this, a whole-region line finds almost nobody.
    areas: expandAreas(lines(getSetting('hunt_areas', getSetting('default_areas', '')))),
    target: num('hunt_daily_target', 15),
    hour: num('hunt_hour', 8),
    // Google trade searches ("roofers in Otley"), a page each.
    maxPlacesRequests: num('hunt_max_places_requests', 30),
    // Google lookups of one register company by name — a separate budget
    // because they bill on a separate SKU with its own free allowance. Only
    // spent when a phone number is required.
    maxCompanyLookups: num('hunt_max_company_lookups', 30),
    maxRegisterPages: num('hunt_max_register_pages', 200),
    maxPerTrade: num('hunt_max_per_trade', 3),
    requireNoWebsite: getSetting('hunt_require_no_website', '1') === '1',
    // Google's listing is not the last word on "no website": plenty of firms
    // never link their site from it. On, every business about to be filed is
    // looked for on the web first (its name as a domain, then a search).
    checkWebsites: getSetting('hunt_check_websites', '1') === '1',
    // A mobile is a phone, so asking for one asks for the other. Left as two
    // independent flags, ticking "must be a mobile" while "must have a phone"
    // was off would skip the Places lookup entirely and then reject every
    // company for having no number — a filter that finds nobody, for ever,
    // and says nothing about why.
    requirePhone: getSetting('hunt_require_phone', '0') === '1'
      || getSetting('hunt_require_mobile', '0') === '1',
    requireMobile: getSetting('hunt_require_mobile', '0') === '1',
    includeUnlisted: getSetting('hunt_include_unlisted', '1') === '1',
    includePlaces,
    messageableOnly,
    // Also keep the Google businesses the register CAN'T confirm as a limited
    // company (sole traders, mostly). Filed call-only — lawful to phone, and
    // messaging opens once they agree on that call. Off by default: it widens
    // who you're contacting, so it's a deliberate choice.
    includeSoleTraders: getSetting('hunt_include_sole_traders', '0') === '1',
    // Whether to file businesses found straight on Google. They arrive with an
    // unconfirmed legal form (entity_type 'unknown'), which the PECR gate never
    // lets you cold-message — so in "messageable only" mode they are not filed;
    // Google is still read for website status and phone numbers to qualify the
    // register companies.
    fileGoogleDirect: includePlaces && !messageableOnly,
  };

  if (messageableOnly) {
    cfg.requireNoWebsite = true;
    cfg.requirePhone = true;
    cfg.requireMobile = true;
  }
  return cfg;
}

/**
 * Is this a number the free channels can actually reach?
 *
 * WhatsApp and SMS go to 07 mobiles and nowhere else. A landline is a phone
 * call in office hours and nothing more, which is the one channel that costs
 * the owner an hour of his day per twenty prospects.
 */
export function isMobileNumber(phone) {
  const n = normalisePhone(phone);
  return n.ok && n.mobile === true;
}

/**
 * A collision-proof key for a trade/town pair.
 *
 * This used to interpolate a literal NUL between the two — correct, since a
 * NUL cannot appear in either value, but invisible in the source and enough
 * to make `grep` and `file` treat this whole module as a binary. JSON does
 * the same job and can be read.
 */
const targetKey = (trade, area) => JSON.stringify([trade ?? '', area ?? '']);

/** Create a target row per trade x town, and drop ones no longer configured. */
export function syncTargets({ trades, areas }) {
  const wanted = [];
  for (const trade of trades) {
    const sic = resolveTrade(trade);
    if (!sic.codes.length) continue;
    for (const area of areas.length ? areas : [null]) {
      wanted.push({ trade, area, sic_codes: sic.codes.join(',') });
    }
  }

  const insert = db.prepare(
    `INSERT INTO hunt_targets (trade, sic_codes, area, created_at)
     VALUES (@trade, @sic_codes, @area, @now)
     ON CONFLICT (trade, area) DO UPDATE SET sic_codes = excluded.sic_codes`
  );
  db.transaction(() => {
    for (const w of wanted) insert.run({ ...w, now: nowIso() });
  })();

  // Forget combinations that are no longer in the config.
  const keep = new Set(wanted.map((w) => targetKey(w.trade, w.area)));
  for (const row of db.prepare('SELECT id, trade, area FROM hunt_targets').all()) {
    if (!keep.has(targetKey(row.trade, row.area))) {
      db.prepare('DELETE FROM hunt_targets WHERE id = ?').run(row.id);
    }
  }
  return wanted.length;
}

/** Targets with ground left to cover, least recently used first. */
function nextTargets({ byYield = false } = {}) {
  const reopen = new Date(Date.now() - REOPEN_AFTER_DAYS * 86_400_000).toISOString();
  return spreadByTrade(db.prepare(
    `SELECT * FROM hunt_targets
      WHERE exhausted_at IS NULL OR exhausted_at < ?
      ORDER BY COALESCE(last_run_at, '') ASC, id ASC`
  ).all(reopen), { byYield });
}

const SIC_ONLY = /^[\d\s,]+$/;

/**
 * The phrasings to ask Google with for one trade, in the order they are used.
 *
 * Google answers the same query with the same listings, so a second visit to
 * "roofers in Otley" pays again for businesses already seen and finds no one
 * new. Each visit to a trade and town takes the next phrasing instead —
 * "roofing", "roof repairs", "flat roofing" — and each ranks businesses the
 * plain trade name does not. Singular and plural are one search, not two.
 */
export function queryVariants(trade) {
  const typed = String(trade ?? '').trim();
  const resolved = resolveTrade(typed);
  const row = TRADES.find((r) => resolved.label && r.label === resolved.label)
    ?? (resolved.exact ? TRADES.find((r) => r.codes.some((c) => resolved.codes.includes(c))) : null);
  const out = [];
  const seen = new Set();
  // A bare SIC code is a register filter, not something to type into Google.
  for (const phrase of [SIC_ONLY.test(typed) ? '' : typed, ...(row?.terms ?? [])]) {
    const p = String(phrase ?? '').trim();
    const key = p.toLowerCase().replace(/s$/, '');
    if (!p || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.length ? out : [typed];
}

/**
 * How reliably a trade has turned into leads, smoothed so an untried trade
 * starts in the middle (1/2) rather than at zero. A trade that is mostly sole
 * traders — hairdressers, window cleaners — keeps coming back with nothing a
 * messageable-only hunt can file, and sinks; one that is mostly limited
 * companies rises. found_total counts confirmed companies only.
 */
function tradeYield(rows) {
  let found = 0;
  let visits = 0;
  for (const r of rows) {
    found += Number(r.found_total ?? 0);
    visits += Number(r.visits ?? 0);
  }
  return (found + 1) / (visits + 2);
}

/**
 * Deal the targets out one trade at a time, like dealing cards.
 *
 * syncTargets builds them trade-major — every town for roofers, then every
 * town for electricians — so straight id order puts forty-four roofing
 * targets before the first electrician. The run then fills its whole daily
 * target from the front of that list, and the day's twenty leads are twenty
 * roofers in one county. Tomorrow, twenty electricians.
 *
 * Round-robin instead: roofer/Stoke, electrician/Stoke, plumber/Stoke, and so
 * on. The relative order within each trade is preserved, so the
 * least-recently-run ordering the query established still holds inside each
 * group.
 */
export function spreadByTrade(targets, { byYield = false } = {}) {
  const byTrade = new Map();
  for (const t of targets) {
    if (!byTrade.has(t.trade)) byTrade.set(t.trade, []);
    byTrade.get(t.trade).push(t);
  }

  // Deal from the trade that has waited longest.
  //
  // Round-robin alone is not fair over time. The daily target is met by the
  // first handful of trades in the rotation, and if that rotation is always
  // in the same order it is always the same handful — a different mix within
  // a day, and the trades at the back of the list never contacted at all.
  // Ordering the queues by when each trade was last drawn from puts
  // yesterday's trades behind today's, so the whole list comes round.
  const lastUsed = (rows) => rows.reduce(
    (latest, r) => (r.last_run_at && r.last_run_at > latest ? r.last_run_at : latest),
    ''
  );
  // In messageable-only mode the budget is better spent where messageable
  // leads actually turn up, so the trades that have produced them go first.
  // Ties — and every other mode — fall back to longest-waiting first.
  const queues = [...byTrade.values()]
    .sort((a, b) => (byYield ? tradeYield(b) - tradeYield(a) : 0)
      || lastUsed(a).localeCompare(lastUsed(b)));

  // Each trade starts at a different town.
  //
  // Taking q[i] from every queue looks like a spread and is not: index 0 of
  // every trade's queue is the SAME town, because within a trade the towns
  // are in list order. So the first pass is "every trade in Stoke-on-Trent",
  // the day's twenty leads all come from one town, and — since those targets
  // are then stamped and sink to the back of their queues — tomorrow is
  // twenty from Tamworth. Trade variety with none of the geography.
  //
  // Offsetting each trade's start by its position deals roofers from town 1,
  // electricians from town 2, plumbers from town 3. Modulo the queue length,
  // so every target is still dealt exactly once.
  const out = [];
  for (let i = 0; out.length < targets.length; i += 1) {
    queues.forEach((q, trade) => {
      if (i < q.length) out.push(q[(i + trade) % q.length]);
    });
  }
  return out;
}

/**
 * One or two Places pages for a trade/town. Returns both a map from normalised
 * business name to Google's website/phone verdict (used to check the register
 * companies), and the raw normalised rows (used by the Google-direct source to
 * file no-website businesses straight as leads). Only the derived website flag
 * is stored in place_cache — never the listing content, per Google's terms.
 */
async function websiteMap(phrase, area, counters) {
  const query = area ? `${phrase} in ${area}` : phrase;
  const byName = new Map();
  const rows = [];
  let pageToken;

  const remember = db.prepare(
    `INSERT INTO place_cache (place_id, has_website, imported, first_seen_at, refreshed_at, query_text)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(place_id) DO UPDATE SET
       has_website = excluded.has_website, refreshed_at = excluded.refreshed_at`
  );

  let searched = 0;
  for (let page = 0; page < 2; page++) {
    if (tradeSearches(counters) >= counters.maxPlacesRequests) break;

    const { places, nextPageToken } = await textSearch(query, {
      regionCode: getSetting('default_region_code', 'GB'), pageToken,
    });
    counters.places_requests++;
    searched++;

    for (const place of places) {
      const row = normalisePlace(place);
      if (!row.place_id || !row.display_name) continue;
      // Held in memory for this run only, to match register companies against.
      // The name and address are what place a listing: judge() needs them to
      // tell "Coseley Services" from any other listing starting "Coseley".
      byName.set(normaliseName(row.display_name), {
        place_id: row.place_id,
        has_website: row.has_website === 1,
        phone: row.phone,
        editorial_summary: row.editorial_summary,
        primary_type: row.primary_type,
        display_name: row.display_name,
        address: row.address ?? null,
      });
      rows.push(row);
      remember.run(row.place_id, row.has_website, nowIso(), nowIso(), area ?? phrase);
    }

    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return { byName, rows, searched };
}

/** Google trade searches spent so far — every Places request that was not a by-name lookup. */
const tradeSearches = (counters) => counters.places_requests - counters.company_lookups;

/* ------------------------------------------------- the register's verdict */

/**
 * What the register said about a Google listing last time: 'not_ltd' when it
 * could not confirm a limited company. Most no-website businesses on Google
 * are sole traders, and without this every run asked the register about the
 * same ones again. Answers go stale — a sole trader can incorporate — so an
 * old one is ignored and the question asked afresh.
 */
function registerVerdict(placeId) {
  const r = db.prepare(
    'SELECT register_verdict, register_checked_at FROM place_cache WHERE place_id = ?'
  ).get(placeId);
  if (!r?.register_verdict || !r.register_checked_at) return null;
  const cutoff = new Date(Date.now() - RECHECK_AFTER_DAYS * 86_400_000).toISOString();
  return r.register_checked_at >= cutoff ? r.register_verdict : null;
}

function recordRegisterVerdict(placeId, verdict) {
  db.prepare(
    'UPDATE place_cache SET register_verdict = ?, register_checked_at = ? WHERE place_id = ?'
  ).run(verdict, nowIso(), placeId);
}

/* --------------------------------------------- one company, by its name */

const LEGAL_SUFFIX = /\b(limited|ltd|plc|llp|l\.l\.p|cic|c\.i\.c|cyfyngedig|cyf)\b\.?/gi;

/** "HILLSIDE ROOFING LIMITED" -> "HILLSIDE ROOFING": what a person would type. */
const searchableName = (name) => String(name ?? '').replace(LEGAL_SUFFIX, ' ')
  .replace(/\s+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const outwardCode = (postcode) => String(postcode ?? '').trim().split(/\s+/)[0] || '';

/**
 * Does this address name this place as a whole word? "Otley" is in "1 High
 * St, Otley LS21 1AA" but "LS2" is not in "LS21", and "Stone" is not in
 * "Stoneleigh". An empty place is named by nothing.
 */
function mentions(address, place) {
  const p = String(place ?? '').trim().toLowerCase();
  if (!p) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(p)}([^a-z0-9]|$)`).test(String(address ?? '').toLowerCase());
}

/**
 * Is a Google listing in the town being hunted? Google answers "roofers in
 * Otley" with firms from the towns around it too, and a lead is filed under
 * the hunted town — so the listing's own address has to say so.
 */
export const inArea = (area, address) => !area || mentions(address, area);

/**
 * Is this Google listing the same firm as this register entry?
 *
 * Same name is not enough: two firms can share a trading name a county apart,
 * and taking the wrong one's number means messaging a business the register
 * never vouched for. So the name must match to the auto-accept standard AND
 * the listing's address must name the company's town, the town being hunted,
 * or the company's postcode district, as a whole word. A listing with no
 * address cannot be placed and is refused.
 *
 * A one-word name only matches exactly: "Roofing" is not "Hillside Roofing".
 */
export function sameFirm(company, row, area) {
  const addr = String(row.address ?? '').toLowerCase();
  if (!addr || !row.display_name) return false;

  const a = normaliseName(company.company_name);
  const b = normaliseName(row.display_name);
  if (!a || !b) return false;
  if (a.split(' ').length === 1 || b.split(' ').length === 1) {
    if (a !== b) return false;
  } else if (matchScore(company.company_name, { company_name: row.display_name }) < AUTO_MATCH) {
    return false;
  }

  return [company.locality, area, outwardCode(company.postal_code)].some((p) => mentions(addr, p));
}

/**
 * Look one register company up on Google by its name.
 *
 * The trade search returns the forty-odd listings Google ranks highest for
 * "roofers in Otley". A limited company that ranks below them came back with
 * no phone and was dropped — though it is exactly the business the register
 * says may lawfully be messaged. Asking for it by name finds it.
 *
 * Returns a judge()-shaped verdict, or null when Google has no listing that is
 * unmistakably this firm.
 */
async function lookupCompany(company, area, counters) {
  const name = searchableName(company.company_name);
  const town = company.locality ?? area ?? '';
  const { places } = await textSearch(town ? `${name} ${town}` : name, {
    regionCode: getSetting('default_region_code', 'GB'), pageSize: 5, mask: LOOKUP_MASK,
  });
  counters.places_requests++;
  counters.company_lookups++;

  const match = places.map(normalisePlace)
    .find((row) => row.place_id && sameFirm(company, row, area));
  if (!match) return null;

  db.prepare(
    `INSERT INTO place_cache (place_id, has_website, imported, first_seen_at, refreshed_at, query_text)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(place_id) DO UPDATE SET
       has_website = excluded.has_website, refreshed_at = excluded.refreshed_at`
  ).run(match.place_id, match.has_website, nowIso(), nowIso(), area ?? town ?? null);

  return match.has_website === 1
    ? { prospect: false, reason: 'has a website', phone: match.phone }
    : {
        prospect: true, has_website: 0, evidence: 'places-name-lookup', phone: match.phone,
        place_id: match.place_id, display_name: match.display_name, address: match.address ?? null,
      };
}

/* ------------------------------------------- a website Google doesn't show */

/** Our own answer on whether this business has a website, while still fresh. */
function siteVerdict(subjects) {
  for (const subject of subjects.filter(Boolean)) {
    const r = db.prepare(
      'SELECT verdict, url, how, checked_at FROM site_checks WHERE subject = ?'
    ).get(subject);
    if (!r) continue;
    const cutoff = new Date(Date.now() - SITE_KEEP_DAYS[r.verdict] * 86_400_000).toISOString();
    if (r.checked_at >= cutoff) return r;
  }
  return null;
}

/** Remember an answer under every name the business goes by here. */
export function recordSiteVerdict(subjects, verdict, { url = null, how = null } = {}) {
  const put = db.prepare(
    `INSERT INTO site_checks (subject, verdict, url, how, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subject) DO UPDATE SET
       verdict = excluded.verdict, url = excluded.url, how = excluded.how,
       checked_at = excluded.checked_at`
  );
  for (const subject of subjects.filter(Boolean)) put.run(subject, verdict, url, how, nowIso());
}

/**
 * Before a business is filed as having no website: does it have one anyway?
 *
 * Google's listing is where the "no website" came from, and many firms never
 * link their site there. So look the way a person would (their name as a
 * domain, then a search). Returns { has: true, url, how } only on hard proof
 * the site is theirs, and the business is then turned away. Anything short
 * of proof comes back as { has: false, possible: { url, why } }: the lead is
 * still filed, with the site noted for the rep to look at, because dropping a
 * real prospect over somebody else's same-named site is its own mistake.
 *
 * A "none" is only remembered when the whole check ran, search included: a
 * search that was blocked or over budget leaves the question open, so the
 * next run asks again rather than trusting a half-answer for a month. A check
 * that fails outright is "don't know", and never stops the run.
 */
async function ownWebsite(biz, subjects, cfg, counters) {
  if (!cfg.checkWebsites) return { has: false };
  const prior = siteVerdict(subjects);
  if (prior) return prior.verdict === 'site' ? { has: true, url: prior.url, how: prior.how } : { has: false };

  const canSearch = !counters.site_search_blocked
    && counters.site_searches < SITE_SEARCHES_PER_RUN;
  const name = [biz.names ?? []].flat().find(Boolean) ?? 'a business';
  if (active) active.doing = `Checking whether ${name} has a website`;
  let r;
  try {
    r = await findWebsite(biz, { search: canSearch ? { gapMs: searchGapMs() } : false });
  } catch {
    return { has: false };
  } finally {
    if (active) active.doing = null;
  }
  counters.site_checks++;
  if (r.searched) counters.site_searches++;
  if (r.searchBlocked) counters.site_search_blocked = true;

  if (r.found) {
    recordSiteVerdict(subjects, 'site', r);
    return { has: true, url: r.url, how: r.how };
  }
  if (canSearch && r.searched && !r.searchBlocked && !r.possible) recordSiteVerdict(subjects, 'none');
  return { has: false, possible: r.possible ?? null };
}

/**
 * A site that may be theirs but was not proved: kept on the lead, and filed
 * as a website signal, so Leads and Reach can say "check this first".
 */
export function notePossibleSite(leadId, possible) {
  if (!leadId || !possible?.url) return;
  const now = nowIso();
  db.prepare('UPDATE leads SET website = ? WHERE id = ? AND website IS NULL').run(possible.url, leadId);
  db.prepare(
    `INSERT INTO contact_signals
       (lead_id, kind, value, source, confidence, note, first_seen_at, last_seen_at)
     VALUES (?, 'website', ?, 'site-check', 40, ?, ?, ?)
     ON CONFLICT(lead_id, kind, value) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(leadId, possible.url, `possible website (${possible.why}): check before messaging`, now, now);
}

/**
 * File a business found straight on Google (no register lookup) as a lead —
 * the Google-direct source. It arrives with a phone, which is the whole point:
 * these are the ones you can WhatsApp. Started unclassified (entity_type
 * unknown), exactly like a manual Places import, so it never auto-unblocks a
 * cold email — that still needs a Companies House match.
 */
/**
 * How we know a lead has no website: Google's word, and — with "+web" — our
 * own look on the web as well.
 */
const evidenceOf = (base, webChecked) => (webChecked ? `${base}+web` : base);

/** What the website check needs to know about a business found on Google. */
const placeBiz = (row, area) => ({
  names: [row.display_name],
  phones: [row.phone],
  postcode: postcodeIn(row.address),
  towns: [area],
});

function importPlaceLead(place, trade, area, { webChecked = false } = {}) {
  const info = db.prepare(
    `INSERT INTO leads
       (business_name, category, location, phone, google_place_id, status,
        notes, source, opted_out, entity_type, has_website, website_checked_at, website_evidence,
        editorial_summary, primary_type,
        details_source, details_imported_at, assigned_to, created_at)
     VALUES (@name, @trade, @town, @phone, @place_id, 'new', @notes, 'Daily hunt (Google)', 0,
             'unknown', 0, @now, @evidence,
             @summary, @primary_type,
             'google_places', @now, @assigned, @now)`
  ).run({
    name: place.display_name ?? '(unnamed business)',
    trade,
    town: area ?? null,
    phone: place.phone ?? null,
    place_id: place.place_id,
    evidence: evidenceOf('places-no-website', webChecked),
    notes: place.address ? `Address: ${place.address}` : null,
    summary: place.editorial_summary ?? null,
    primary_type: place.primary_type ?? null,
    assigned: nextAssignee(),
    now: nowIso(),
  });
  recordFound({ business_name: place.display_name ?? null, location: area ?? null, company_number: null });
  db.prepare('UPDATE place_cache SET imported = 1 WHERE place_id = ?').run(place.place_id);
  return Number(info.lastInsertRowid);
}

/**
 * File a Google business that the register CONFIRMS is a limited company.
 *
 * The Google listing gives the phone you can WhatsApp; the register entry
 * gives the legal form that makes it lawful to. Filed as 'corporate' with the
 * company's register details, so it lands ready to message rather than blocked
 * and waiting on a check. `company` is the auto-match from findCompany.
 */
function importConfirmedPlaceLead(row, company, trade, area, { webChecked = false } = {}) {
  const info = db.prepare(
    `INSERT INTO leads
       (business_name, category, location, phone, google_place_id, status, source, opted_out,
        entity_type, company_number, registered_name, registered_address, company_status,
        company_type, incorporated_on, sic_codes, entity_note, checked_at,
        has_website, website_checked_at, website_evidence,
        editorial_summary, primary_type,
        details_source, details_imported_at,
        assigned_to, created_at)
     VALUES (@name, @trade, @town, @phone, @place_id, 'new', 'Daily hunt', 0,
             'corporate', @number, @regname, @address, @status,
             @type, @inc, @sic, @note, @now,
             0, @now, @evidence,
             @summary, @primary_type,
             'google_places', @now,
             @assigned, @now)`
  ).run({
    evidence: evidenceOf('places-no-website', webChecked),
    name: row.display_name ?? company.company_name,
    trade,
    town: company.locality ?? area ?? null,
    phone: row.phone ?? null,
    place_id: row.place_id,
    number: company.company_number,
    regname: company.company_name,
    address: company.address_snippet ?? null,
    status: company.company_status ?? null,
    type: company.company_type ?? null,
    inc: company.date_of_creation ?? null,
    sic: (company.sic_codes ?? []).join(',') || null,
    note: `Companies House ${company.company_number} — found on Google, confirmed on the register`,
    summary: row.editorial_summary ?? null,
    primary_type: row.primary_type ?? null,
    assigned: nextAssignee(),
    now: nowIso(),
  });
  const leadId = Number(info.lastInsertRowid);

  if (row.phone) {
    try {
      const n = normalisePhone(row.phone);
      if (n.ok) {
        db.prepare(
          `INSERT INTO contact_signals
             (lead_id, kind, value, source, confidence, first_seen_at, last_seen_at)
           VALUES (?, 'phone', ?, 'places', 90, ?, ?)
           ON CONFLICT(lead_id, kind, value) DO NOTHING`
        ).run(leadId, n.e164, nowIso(), nowIso());
      }
    } catch { /* not fatal */ }
  }
  db.prepare('UPDATE place_cache SET imported = 1 WHERE place_id = ?').run(row.place_id);
  return leadId;
}

/** How far a match must lead the next one to be taken without a human — findCompany's bar. */
const CLEAR_MARGIN = 0.15;

/**
 * Look a Google business up on the register and, only if it is unambiguously
 * an active limited company in the town being hunted, file it as a confirmed
 * corporate lead. Returns { filed, reason }: 'known' if already held,
 * 'elsewhere' if the only matching company is registered in another town (or
 * the listing is), 'unconfirmed' if the register could not clearly match it
 * (a sole trader, or too fuzzy a name to be sure). Anything not filed is left
 * off rather than guessed at, because guessing wrong means messaging someone
 * you may not.
 *
 * A name match alone used to be enough, so a same-named company registered
 * anywhere in the UK passed: the lead showed that company's town, and a local
 * sole trader could be filed as somebody else's limited company. Now the
 * company must be registered in the hunted town, lead any other candidate
 * there by a clear margin, and Google's address for the listing must agree
 * (sameFirm), which also turns away listings Google pulled in from nearby.
 */
async function confirmAndImportPlaceLead(row, trade, area, seen, { checkSite = null } = {}) {
  const ranked = (await searchByName(row.display_name, { limit: 50 }))
    .map((c) => ({ ...c, score: matchScore(row.display_name, c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  // Every candidate in town counts toward the margin, dissolved or not: a
  // live "Hillside Roofing (Yorkshire) Ltd" next to a dissolved "Hillside
  // Roofing Ltd" is not a clear answer for a listing called "Hillside Roofing".
  const here = ranked.filter((c) => sameTown(area, c.locality));
  const [best, runnerUp] = here;
  const auto = best
    && best.score >= AUTO_MATCH
    && isTrading(best)
    && isBodyCorporate(best.company_type)
    && (!runnerUp || best.score - runnerUp.score >= CLEAR_MARGIN)
    ? best : null;

  if (!auto) {
    const elsewhere = !here.some((c) => c.score >= AUTO_MATCH)
      && ranked.some((c) => c.score >= AUTO_MATCH && isBodyCorporate(c.company_type));
    return { filed: false, reason: elsewhere ? 'elsewhere' : 'unconfirmed' };
  }
  if (!sameFirm(auto, row, area)) return { filed: false, reason: 'elsewhere' };

  const number = String(auto.company_number ?? '').trim().toUpperCase();
  if (!number) return { filed: false, reason: 'unconfirmed' };
  if (seen.has(number)) return { filed: false, reason: 'known' };
  if (db.prepare('SELECT 1 FROM leads WHERE company_number = ?').get(auto.company_number)) {
    return { filed: false, reason: 'known' };
  }
  if (db.prepare('SELECT 1 FROM company_ledger WHERE company_number = ?').get(auto.company_number)) {
    return { filed: false, reason: 'known' };
  }

  // Last, because it is the slow one: Google shows no website, but does the
  // firm have one Google doesn't link? Asked only of a company about to be filed.
  let site = null;
  if (checkSite) {
    site = await checkSite({
      names: [row.display_name, auto.company_name],
      phones: [row.phone],
      postcode: auto.postal_code ?? postcodeIn(row.address),
      towns: [auto.locality, area],
    }, [`ch:${number}`, `pl:${row.place_id}`]);
    if (site.has) return { filed: false, reason: 'has_website', site };
  }

  try {
    const leadId = importConfirmedPlaceLead(row, auto, trade, area, { webChecked: Boolean(checkSite) });
    notePossibleSite(leadId, site?.possible);
  } catch (err) {
    if (String(err.message).includes('leads.company_number')) return { filed: false, reason: 'known' };
    throw err;
  }
  recordFound({
    company_number: auto.company_number,
    business_name: auto.company_name,
    location: auto.locality ?? area ?? null,
  });
  seen.add(number);
  return { filed: true, reason: 'filed' };
}

/**
 * Is this company actually in the town we asked for?
 *
 * The register's `location` filter partial-matches the WHOLE registered
 * office address, not the town — so a search for "Stone" returns companies
 * on Stone Road in Aylesbury, a hundred miles from Staffordshire. That is a
 * lead you would ring, apologise to, and delete.
 *
 * Compared by token rather than by substring, because substring matching
 * trades one wrong answer for another: "stoneleigh".includes("stone") is
 * true, and Stoneleigh is not Stone.
 *
 *   Stone            vs Aylesbury          -> no, different first word
 *   Stone            vs Stoneleigh         -> no, ditto
 *   Burton on Trent  vs Burton upon Trent  -> yes, first and last agree
 *   Newcastle under Lyme vs Newcastle upon Tyne -> no, the tails differ,
 *       which is the whole difference between Staffordshire and Tyneside
 *   Newcastle under Lyme vs Newcastle      -> yes, one is just shorter
 *
 * A company with no locality at all is kept: the register matched it on
 * something, and throwing away a lead over a missing field would cost more
 * than the occasional stray.
 */
export function sameTown(area, locality) {
  const norm = (v) => String(v ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(area);
  const l = norm(locality);
  if (!a || !l) return true;
  if (a === l) return true;

  const at = a.split(' ');
  const lt = l.split(' ');
  if (at[0] !== lt[0]) return false;
  // Both multi-word: the tail has to agree too.
  if (at.length > 1 && lt.length > 1) return at.at(-1) === lt.at(-1);
  return true;
}

/**
 * Website evidence for one company, read off the Places page for its town.
 *
 * An exact name match is taken as it is. A looser one ("HILLSIDE ROOFING LTD"
 * against a listing "Hillside Roofing & Guttering") must also be the same
 * firm by address: normalising drops "Services", so COSELEY SERVICES LIMITED
 * is just "coseley", and without that check any listing starting "Coseley"
 * lent it a phone number and a "no website" it had no claim to.
 */
export function judge(company, byName, { includeUnlisted = true, area = null } = {}) {
  const key = normaliseName(company.company_name);
  if (!key) return { prospect: false, reason: 'no usable name' };

  // The phone is reported either way. It is a fact about the business, not a
  // reward for lacking a website — and withholding it when a site exists made
  // "only businesses with a phone number" silently reintroduce the website
  // filter, because a listed company with a site arrived with no number and
  // was dropped for having no way to reach it.
  const found = (info) => (info.has_website
    ? { prospect: false, reason: 'has a website', phone: info.phone }
    : {
        prospect: true, has_website: 0, evidence: 'places-no-website', phone: info.phone,
        place_id: info.place_id ?? null,
        editorial_summary: info.editorial_summary ?? null,
        primary_type: info.primary_type ?? null,
        display_name: info.display_name ?? null,
        address: info.address ?? null,
      });

  const exact = byName.get(key);
  if (exact) return found(exact);

  // Registered names carry words a trading name drops, and the other way
  // round: "HILLSIDE ROOFING LTD" against a listing for "Hillside Roofing".
  // Only between names of two words or more (a one-word name prefixes half
  // the listings in town), and only for a listing whose address is where the
  // company is.
  const placed = (addr) => Boolean(addr)
    && [company.locality, area, outwardCode(company.postal_code)].some((p) => mentions(addr, p));
  for (const [name, info] of byName) {
    if (!name || !(name.startsWith(key) || key.startsWith(name))) continue;
    if (key.split(' ').length < 2 || name.split(' ').length < 2) continue;
    if (placed(info.address)) return found(info);
  }

  // `unlisted` says the trade search simply did not return it — not that
  // Google has never heard of it. The hunt may still look it up by name.
  if (!includeUnlisted) return { prospect: false, reason: 'not on Google', unlisted: true };
  return { prospect: true, has_website: 0, evidence: 'places-absent', unlisted: true };
}

function importLead(company, verdict, trade) {
  // Carry the Google listing's id when we matched one, so the Google-first
  // source recognises this business next time instead of filing it twice. A
  // listing already on another lead is left off rather than tripping the
  // UNIQUE index — that lead has the number already.
  const placeId = verdict.place_id
    && !db.prepare('SELECT 1 FROM leads WHERE google_place_id = ?').get(verdict.place_id)
    ? verdict.place_id : null;
  const fromGoogle = Boolean(verdict.phone || verdict.editorial_summary || placeId);
  const info = db.prepare(
    `INSERT INTO leads
       (business_name, category, location, phone, google_place_id, status, source, opted_out,
        entity_type, company_number, registered_name, registered_address, company_status,
        company_type, incorporated_on, sic_codes, entity_note, checked_at,
        has_website, website_checked_at, website_evidence,
        editorial_summary, primary_type, details_source, details_imported_at,
        assigned_to, created_at)
     VALUES (@name, @trade, @town, @phone, @place_id, 'new', 'Daily hunt', 0,
             'corporate', @number, @name, @address, @status,
             @type, @inc, @sic, @note, @now,
             @has_website, @checked, @evidence,
             @summary, @primary_type, @details_source, @details_at,
             @assigned, @now)`
  ).run({
    name: company.company_name,
    trade,
    town: company.locality ?? null,
    phone: verdict.phone ?? null,
    place_id: placeId,
    summary: verdict.editorial_summary ?? null,
    primary_type: verdict.primary_type ?? null,
    details_source: fromGoogle ? 'google_places' : null,
    details_at: fromGoogle ? nowIso() : null,
    // Share the day's finds out across the active team (5 each of 15, say).
    assigned: nextAssignee(),
    number: company.company_number,
    address: company.address_snippet ?? null,
    status: company.company_status ?? null,
    type: company.company_type ?? null,
    inc: company.date_of_creation ?? null,
    sic: (company.sic_codes ?? []).join(',') || null,
    note: `Companies House ${company.company_number}`,
    has_website: verdict.has_website ?? null,
    checked: verdict.evidence ? nowIso() : null,
    evidence: verdict.evidence ?? null,
    now: nowIso(),
  });
  const leadId = Number(info.lastInsertRowid);

  // File the Places-derived phone as a signal too, so the trail is visible
  // on the reach modal alongside anything the finder later turns up. Stored
  // as normalised E.164 so a later web-search signal dedupes cleanly.
  if (verdict.phone) {
    try {
      const n = normalisePhone(verdict.phone);
      if (n.ok) {
        db.prepare(
          `INSERT INTO contact_signals
             (lead_id, kind, value, source, confidence, first_seen_at, last_seen_at)
           VALUES (?, 'phone', ?, 'places', 90, ?, ?)
           ON CONFLICT(lead_id, kind, value) DO NOTHING`
        ).run(leadId, n.e164, nowIso(), nowIso());
      }
    } catch { /* not fatal */ }
  }

  return leadId;
}

/* -------------------------------------------------------------------- run */

let active = null;
export const activeHunt = () => active;

/**
 * Work through trades and towns until `target` new prospects are filed, or a
 * request budget runs out. Resolves with the finished run row; it records
 * errors on the run rather than throwing, so a scheduled hunt cannot take the
 * server down with it.
 */
export async function hunt({ trigger = 'manual', target, config } = {}) {
  if (active) throw new Error('A hunt is already running.');

  const cfg = config ?? huntConfig();
  const want = Math.max(1, target ?? cfg.target);

  if (!cfg.trades.length) {
    throw new Error('No trades configured — set them under Settings before the hunt can run.');
  }

  // Refuse before spending anything. "Only businesses with no website" is the
  // whole filter, and it is answered by Google, so with no key the run reads
  // one register page, asks Places, and dies with NO_API_KEY — after paying
  // for the page and with nothing on screen to say why it found nobody.
  if ((cfg.requireNoWebsite || cfg.requirePhone) && !placesConfigured()) {
    const wanted = [
      cfg.requireNoWebsite && 'only businesses with no website',
      cfg.requireMobile
        ? 'only businesses with a mobile number'
        : cfg.requirePhone && 'only businesses with a phone number',
    ].filter(Boolean).join(' and ');
    throw new Error(
      `The hunt is set to find ${wanted}, and Google is the only source for `
      + 'either — but GOOGLE_MAPS_API_KEY is not set. Add the key, or '
      + (cfg.messageableOnly
        ? 'untick “Only find businesses I can message right now” '
        : 'turn those options off ')
      + 'and the hunt will file every company it finds for you to check yourself.'
    );
  }
  syncTargets(cfg);

  const runId = Number(db.prepare(
    'INSERT INTO hunt_runs (started_at, trigger, target) VALUES (?, ?, ?)'
  ).run(nowIso(), trigger, want).lastInsertRowid);

  const counters = {
    found: 0, companies_seen: 0, already_known: 0, had_website: 0,
    no_contact: 0,
    not_mobile: 0,
    not_confirmed: 0,
    wrong_town: 0,
    places_requests: 0, register_requests: 0,
    // Of places_requests, how many looked one company up by name.
    company_lookups: 0,
    maxPlacesRequests: cfg.maxPlacesRequests,
    // Our own look for a website Google doesn't show (in memory only; a hit
    // is counted in had_website like any other business with a site).
    site_checks: 0,
    site_searches: 0,
    site_search_blocked: false,
  };
  const checkSite = cfg.checkWebsites && cfg.requireNoWebsite
    ? (biz, subjects) => ownWebsite(biz, subjects, cfg, counters)
    : null;
  const covered = new Set();
  active = { id: runId, trigger, target: want, running: true, started_at: nowIso(), ...counters };

  const save = (extra = {}) => {
    Object.assign(active, counters, extra);
    db.prepare(
      `UPDATE hunt_runs SET found=@found, companies_seen=@companies_seen,
         already_known=@already_known, had_website=@had_website,
         no_contact=@no_contact, not_mobile=@not_mobile, not_confirmed=@not_confirmed,
         wrong_town=@wrong_town,
         places_requests=@places_requests, register_requests=@register_requests,
         company_lookups=@company_lookups,
         areas_covered=@areas, finished_at=@finished, error=@error
       WHERE id=@id`
    ).run({
      company_lookups: counters.company_lookups,
      found: counters.found,
      companies_seen: counters.companies_seen,
      already_known: counters.already_known,
      had_website: counters.had_website,
      no_contact: counters.no_contact,
      not_mobile: counters.not_mobile,
      not_confirmed: counters.not_confirmed,
      wrong_town: counters.wrong_town,
      places_requests: counters.places_requests,
      register_requests: counters.register_requests,
      id: runId,
      areas: [...covered].join(', ') || null,
      finished: extra.finished_at ?? null,
      error: extra.error ?? null,
    });
  };

  try {
    // One read for the whole run. A page is up to 100 companies across every
    // trade and town, so this cannot be a query per company.
    const seen = knownCompanyNumbers();

    const targets = nextTargets({ byYield: cfg.messageableOnly });

    /**
     * The most leads any one trade may contribute to this run.
     *
     * Interleaving alone is not enough: one register page holds a hundred
     * companies, so the first target can still supply the whole day on its
     * own. A cap forces the run to move on and come back with a mixed list —
     * a roofer, a salon, a garage — which is a better day's calling than
     * twenty roofers, and spreads the risk if one trade turns out deaf to
     * cold contact.
     *
     * Raised when there are too few trades configured for the cap to be
     * satisfiable, so a two-trade setup still reaches its target instead of
     * quietly stopping at six.
     */
    const tradeCount = new Set(targets.map((t) => t.trade)).size || 1;
    const maxPerTrade = Math.max(
      Math.max(1, cfg.maxPerTrade),
      Math.ceil(want / tradeCount)
    );
    const takenPerTrade = new Map();
    const taken = (trade) => takenPerTrade.get(trade) ?? 0;

    if (!targets.length) {
      throw new Error('Every trade and town has been worked through. Add more towns, or wait — exhausted ones re-open after a month.');
    }

    for (const t of targets) {
      if (counters.found >= want) break;
      if (counters.register_requests >= cfg.maxRegisterPages) break;
      // Before the register call, not after: a trade that has had its share
      // must not cost a request to discover that.
      if (taken(t.trade) >= maxPerTrade) continue;
      if ((cfg.requireNoWebsite || cfg.includePlaces)
          && tradeSearches(counters) >= cfg.maxPlacesRequests) break;

      let page;
      try {
        page = await advancedSearch({
          sicCodes: t.sic_codes, location: t.area, size: PAGE, startIndex: t.cursor,
        });
        counters.register_requests++;
      } catch (err) {
        // Both of these mean "this filter has no more to give" rather than
        // "stop everything": 416 is paging past the end, and 500 is the
        // register refusing a query that has gone too deep. Retire the target
        // and carry on with the next town.
        if (err instanceof CompaniesHouseError
            && (err.code === 'PAGE_TOO_DEEP' || err.code === 'TOO_BROAD')) {
          db.prepare('UPDATE hunt_targets SET exhausted_at = ? WHERE id = ?').run(nowIso(), t.id);
          continue;
        }
        throw err;
      }

      db.prepare(
        'UPDATE hunt_targets SET last_run_at = ?, cursor = ?, visits = visits + 1 WHERE id = ?'
      ).run(nowIso(), t.cursor + page.items.length, t.id);

      if (!page.items.length) {
        db.prepare('UPDATE hunt_targets SET exhausted_at = ? WHERE id = ?').run(nowIso(), t.id);
        continue;
      }
      covered.add(t.area ? `${t.trade} · ${t.area}` : t.trade);

      // Each visit to this trade and town asks Google a different way, so a
      // return visit finds businesses the last phrasing did not rank.
      const variants = queryVariants(t.trade);
      const phrase = variants[Number(t.query_variant ?? 0) % variants.length];
      const askGoogle = async () => {
        const pl = await websiteMap(phrase, t.area, counters);
        // Only a phrasing actually searched is used up.
        if (pl.searched) {
          db.prepare('UPDATE hunt_targets SET query_variant = query_variant + 1 WHERE id = ?')
            .run(t.id);
        }
        return pl;
      };

      // Google source. Fetch Google's own listings for this trade/town once.
      // The no-website ones come WITH a phone — the businesses you can actually
      // WhatsApp, which the register alone never surfaces. What happens to them
      // depends on the mode:
      //   messageable only → confirm each against the register and file only
      //     the ones it proves are limited companies (corporate, ready to
      //     message). Google finds them; the register makes them lawful.
      //   plain Google-direct → file the no-website ones as unconfirmed leads.
      // Either way the same fetch feeds the register website-check below, so
      // Google is only called once per town.
      let placesByName = null;
      if ((cfg.includePlaces || cfg.messageableOnly) && placesConfigured()
          && tradeSearches(counters) < cfg.maxPlacesRequests) {
        const pl = await askGoogle();
        placesByName = pl.byName;
        if (cfg.fileGoogleDirect || cfg.messageableOnly) {
          for (const row of pl.rows) {
            if (counters.found >= want) break;
            if (taken(t.trade) >= maxPerTrade) break;
            if (row.has_website !== 0) continue;         // no-website businesses only
            counters.companies_seen++;
            if (!row.phone) { counters.no_contact++; continue; }
            if (cfg.requireMobile && !isMobileNumber(row.phone)) { counters.not_mobile++; continue; }
            if (db.prepare('SELECT 1 FROM leads WHERE google_place_id = ?').get(row.place_id)) {
              counters.already_known++; continue;
            }

            if (cfg.messageableOnly) {
              let outcome;
              const prior = registerVerdict(row.place_id);
              if (prior === 'not_ltd' || prior === 'elsewhere') {
                // The register already said no about this listing recently.
                outcome = {
                  filed: false, reason: prior === 'elsewhere' ? 'elsewhere' : 'unconfirmed',
                  remembered: true,
                };
              } else {
                // One register search per business. Count it against the register
                // budget so a town of no-hopers cannot run the API dry, and stop
                // if that budget is spent.
                if (counters.register_requests >= cfg.maxRegisterPages) break;
                counters.register_requests++;
                try {
                  outcome = await confirmAndImportPlaceLead(row, t.trade, t.area, seen, { checkSite });
                } catch (err) {
                  if (err instanceof CompaniesHouseError && err.retryable) throw err;
                  counters.not_confirmed++;
                  continue;
                }
                if (!outcome.filed && outcome.reason === 'unconfirmed') {
                  recordRegisterVerdict(row.place_id, 'not_ltd');
                } else if (!outcome.filed && outcome.reason === 'elsewhere') {
                  recordRegisterVerdict(row.place_id, 'elsewhere');
                }
              }
              if (!outcome.filed) {
                if (outcome.reason === 'known') { counters.already_known++; continue; }
                // A confirmed company with a site of its own, just not on its
                // Google listing. Not a sole trader, so never filed call-only.
                if (outcome.reason === 'has_website') { counters.had_website++; continue; }
                // The register can't confirm it's a limited company in this
                // town — a sole trader, most likely. File it call-only when
                // that's switched on; otherwise leave it off the list.
                if (!cfg.includeSoleTraders) {
                  if (outcome.remembered) counters.already_known++;
                  else if (outcome.reason === 'elsewhere') counters.wrong_town++;
                  else counters.not_confirmed++;
                  continue;
                }
                // Filed under the hunted town, so it has to actually be there.
                if (!inArea(t.area, row.address)) { counters.wrong_town++; continue; }
                if (ledgerFor({ business_name: row.display_name, location: t.area })) {
                  counters.already_known++; continue;
                }
                const site = checkSite ? await checkSite(placeBiz(row, t.area), [`pl:${row.place_id}`]) : null;
                if (site?.has) { counters.had_website++; continue; }
                notePossibleSite(
                  importPlaceLead(row, t.trade, t.area, { webChecked: Boolean(checkSite) }), site?.possible);
              } else {
                // A confirmed company is what a messageable-only hunt is for,
                // so it counts toward this trade's yield.
                db.prepare('UPDATE hunt_targets SET found_total = found_total + 1 WHERE id = ?')
                  .run(t.id);
              }
            } else {
              if (!inArea(t.area, row.address)) { counters.wrong_town++; continue; }
              if (ledgerFor({ business_name: row.display_name, location: t.area })) {
                counters.already_known++; continue;
              }
              const site = checkSite ? await checkSite(placeBiz(row, t.area), [`pl:${row.place_id}`]) : null;
              if (site?.has) { counters.had_website++; continue; }
              notePossibleSite(
                importPlaceLead(row, t.trade, t.area, { webChecked: Boolean(checkSite) }), site?.possible);
            }
            counters.found++;
            takenPerTrade.set(t.trade, taken(t.trade) + 1);
          }
        }
        save();
      }

      // Only spend a Places request on companies we do not already hold.
      //
      // The leads table alone is not a sufficient memory: DELETE FROM leads
      // is a hard delete, so a company the owner looked at and discarded is
      // indistinguishable from one never seen, and tomorrow's hunt files it
      // again. The ledger is checked as well, and it outlives the lead.
      const fresh = [];
      for (const c of page.items) {
        counters.companies_seen++;
        if (!isBodyCorporate(c.company_type)) continue;
        const number = String(c.company_number ?? '').trim().toUpperCase();
        if (number && seen.has(number)) {
          counters.already_known++;
          continue;
        }
        if (db.prepare('SELECT 1 FROM leads WHERE company_number = ?').get(c.company_number)) {
          counters.already_known++;
          continue;
        }
        // A LIVE ledger probe, not just the `seen` snapshot taken at the top
        // of the run. A company contacted (or filed) by another rep WHILE this
        // hunt is grinding through its HTTP calls, whose lead is then deleted,
        // would pass both checks above — the snapshot predates the contact and
        // the leads row is gone — and be re-presented as a fresh prospect. The
        // ledger row survives the delete, so reading it live closes that race
        // and keeps "already contacted, never again" true even mid-run.
        if (c.company_number
            && db.prepare('SELECT 1 FROM company_ledger WHERE company_number = ?').get(c.company_number)) {
          counters.already_known++;
          continue;
        }
        // The register matched the address, not the town. Check the town.
        if (!sameTown(t.area, c.locality)) {
          counters.wrong_town++;
          continue;
        }
        fresh.push(c);
      }
      if (!fresh.length) { save(); continue; }

      // Google is asked whenever we need something only it holds. That used
      // to be the website check alone, so with that off a lead arrived with
      // no phone number and no email — nothing to contact it by at all,
      // short of posting a letter to a registered office that is often the
      // accountant's.
      const needPlaces = cfg.requireNoWebsite || cfg.requirePhone;
      // Reuse the Google fetch from the direct source above when there was one,
      // so a town is only looked up on Google once.
      const byName = placesByName
        ?? (needPlaces ? (await askGoogle()).byName : new Map());

      let lookupsHere = 0;
      for (const company of fresh) {
        if (counters.found >= want) break;
        if (taken(t.trade) >= maxPerTrade) break;
        // judge() answers both questions from the one page: whether Google
        // shows a website, and what phone number it holds. When only the
        // phone is wanted, its website verdict is ignored.
        let verdict = needPlaces
          ? judge(company, byName, { includeUnlisted: cfg.includeUnlisted, area: t.area })
          : { prospect: true };

        // The trade search did not return it, but a number is required: ask
        // Google for this company by name. The register has already confirmed
        // it is a limited company, so a mobile found here is one you may
        // lawfully message. Capped per town and per run, inside the budget.
        if (verdict.unlisted && cfg.requirePhone && placesConfigured()
            && lookupsHere < LOOKUPS_PER_TARGET
            && counters.company_lookups < cfg.maxCompanyLookups) {
          lookupsHere++;
          const hit = await lookupCompany(company, t.area, counters);
          if (hit) verdict = hit;
        }
        if (cfg.requireNoWebsite && !verdict.prospect) { counters.had_website++; continue; }

        // A lead with no way to reach it is not a lead. Counted separately
        // so the run can say "found 6, skipped 40 with no phone" rather than
        // just coming up short and looking broken.
        if (cfg.requirePhone && !verdict.phone) { counters.no_contact++; continue; }

        // A landline is a phone call and nothing else. WhatsApp and SMS —
        // the two channels that cost nothing and get read — only reach 07
        // numbers, so when those are the plan, an 0121 number is not a lead.
        if (cfg.requireMobile && !isMobileNumber(verdict.phone)) {
          counters.not_mobile++;
          continue;
        }

        // Last and slowest: Google shows no site (or no listing at all), so
        // look for one on the web before calling it a business without.
        let site = null;
        if (checkSite) {
          const number = String(company.company_number ?? '').trim().toUpperCase();
          site = await checkSite({
            names: [verdict.display_name, company.company_name],
            phones: [verdict.phone],
            postcode: company.postal_code ?? postcodeIn(verdict.address),
            towns: [company.locality, t.area],
          }, [number && `ch:${number}`, verdict.place_id && `pl:${verdict.place_id}`]);
          if (site.has) { counters.had_website++; continue; }
        }

        try {
          notePossibleSite(importLead(company, checkSite
            ? { ...verdict, evidence: evidenceOf(verdict.evidence ?? 'no-website', true) }
            : verdict, t.trade), site?.possible);
        } catch (err) {
          // The partial UNIQUE index from migration 016. Two hunt processes
          // can pass the SELECT above before either INSERTs — `active` is a
          // module-level variable, so it locks one Node process and the cron
          // entry point is a second one. Losing that race means the company
          // is already filed, which is the outcome we wanted; it must not
          // abort the whole run.
          if (String(err.message).includes('leads.company_number')
              || String(err.message).includes('leads.google_place_id')) {
            counters.already_known++;
            continue;
          }
          throw err;
        }
        recordFound({
          company_number: company.company_number,
          business_name: company.company_name,
          location: company.locality ?? null,
        });
        // Within one run the same company can appear under two trades that
        // share a SIC code, so the set has to grow as we go.
        const filed = String(company.company_number ?? '').trim().toUpperCase();
        if (filed) seen.add(filed);
        takenPerTrade.set(t.trade, taken(t.trade) + 1);
        counters.found++;
        db.prepare('UPDATE hunt_targets SET found_total = found_total + 1 WHERE id = ?').run(t.id);
      }
      save();
    }

    save({ finished_at: nowIso() });
  } catch (err) {
    const message = (err instanceof PlacesError || err instanceof CompaniesHouseError)
      ? `${err.code}: ${err.message}`
      : err.message;
    save({ finished_at: nowIso(), error: message });
  } finally {
    active = null;
  }

  return db.prepare('SELECT * FROM hunt_runs WHERE id = ?').get(runId);
}

export const recentRuns = (limit = 20) =>
  db.prepare('SELECT * FROM hunt_runs ORDER BY id DESC LIMIT ?').all(limit);

export const targetProgress = () =>
  db.prepare("SELECT * FROM hunt_targets ORDER BY COALESCE(last_run_at, '') DESC, id").all();

/** Prospects the hunt filed today. */
export function foundToday(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return db.prepare(
    "SELECT COUNT(*) n FROM leads WHERE source = 'Daily hunt' AND created_at >= ?"
  ).get(start.toISOString()).n;
}

/** Whether a scheduled hunt has already run today. */
export function ranToday(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Boolean(db.prepare(
    "SELECT 1 FROM hunt_runs WHERE trigger != 'manual' AND started_at >= ?"
  ).get(start.toISOString()));
}
