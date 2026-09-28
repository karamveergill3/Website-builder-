/**
 * Does this business already have a website?
 *
 * The whole tool is for businesses WITHOUT one, and that question used to be
 * answered by Google alone: no website on the Google listing meant no website.
 * But plenty of firms never link their site from their Google profile.
 * COSELEY SERVICES LIMITED in Wolverhampton was filed and messaged as having
 * no website, and it has one at its own name, dot co dot uk.
 *
 * So before a business is filed, this looks for itself, the way a person would:
 *
 *   1. The domain their email is on, when it is their own and not Gmail.
 *   2. Their name as a domain: "Coseley Services" -> coseleyservices.co.uk,
 *      coseley-services.co.uk, .com, .uk. Most small firms use exactly that.
 *   3. A web search for their name and town, when the caller allows one.
 *
 * Getting this wrong the other way is just as bad: a genuine prospect dropped
 * because somebody ELSE's page looked like theirs is a lead lost for months.
 * Names and towns are shared ("Premier Roofing", "Dudley Groundworks", a
 * firm that lists the towns around it), so neither is ever proof. A page is
 * only theirs on:
 *
 *   confirmed  their phone number (as Google or the lead holds it), or their
 *              full name together with one of their exact postcodes.
 *   possible   their name on a domain tied to them (their name's or their
 *              email's), or that domain refusing to let us read it. Never
 *              used to drop a prospect: the lead is filed with the site
 *              shown, for a person to look at.
 *
 * A parked page, a domain that forwards to a Facebook page, or a page about
 * someone else counts for nothing.
 *
 * No database here, and every network call goes through `fetchImpl`, so the
 * logic can be tested without the internet and without a data file.
 */
import { normalisePhone } from './handoff.js';
import { FREE_MAIL_DOMAINS } from './pecr.js';

// A "compatible" agent: honest about what we are, and not turned away by the
// hosts that refuse anything that doesn't start "Mozilla".
const USER_AGENT = 'Mozilla/5.0 (compatible; ProspectBook/1.0; +checking whether a business already has a website)';
const TLDS = ['co.uk', 'com', 'uk'];
const MAX_SLUGS = 6;
const MAX_BYTES = 400 * 1024;
const TIMEOUT_MS = 8_000;
const BUDGET_MS = 30_000;
const CONCURRENCY = 6;
const SEARCH_RESULTS_TO_READ = 3;

const LEGAL_SUFFIX = /\b(limited|ltd|plc|llp|l\.l\.p|cic|c\.i\.c|cyfyngedig|cyf)\b\.?/gi;

/** Words that say nothing about WHICH business this is. */
const GENERIC = new Set([
  'the', 'and', 'of', 'a', 'co', 'company', 'uk', 'group', 'holdings', 'services', 'service',
  'trading', 'contractors', 'contracting', 'solutions', 'enterprises', 'ltd', 'limited',
]);

/** What a business does. Half the firms in a town share these. */
const TRADE = new Set([
  'roofing', 'roofers', 'roofer', 'plumbing', 'plumber', 'plumbers', 'heating', 'gas',
  'electrical', 'electrician', 'electricians', 'electrics', 'building', 'builders', 'builder',
  'construction', 'joinery', 'joiners', 'joiner', 'carpentry', 'carpenters', 'decorating',
  'decorators', 'decorator', 'painting', 'painters', 'plastering', 'plasterers', 'plasterer',
  'landscaping', 'landscapes', 'landscape', 'gardening', 'gardens', 'garden', 'gardeners',
  'cleaning', 'cleaners', 'cleaner', 'window', 'windows', 'glazing', 'glass', 'doors',
  'flooring', 'floors', 'carpets', 'tiling', 'tiles', 'kitchens', 'kitchen', 'bathrooms',
  'bathroom', 'scaffolding', 'haulage', 'transport', 'removals', 'logistics', 'couriers',
  'motors', 'motor', 'garage', 'autos', 'auto', 'cars', 'car', 'tyres', 'mechanics', 'repairs',
  'repair', 'maintenance', 'salon', 'hair', 'hairdressing', 'beauty', 'barbers', 'barber',
  'nails', 'spa', 'aesthetics', 'cafe', 'coffee', 'restaurant', 'takeaway', 'kitchen',
  'bakery', 'catering', 'fitness', 'gym', 'dental', 'care', 'security', 'fencing', 'paving',
  'driveways', 'drainage', 'locksmiths', 'locksmith', 'installations', 'installation',
  'engineering', 'fabrication', 'welding', 'property', 'properties', 'lettings', 'homes',
  'interiors', 'design', 'print', 'printing', 'signs', 'photography', 'studio', 'studios',
]);

/** Stock words in trading names that identify nobody. */
const STOCK = new Set([
  'premier', 'elite', 'quality', 'pro', 'pros', 'express', 'royal', 'star', 'prime', 'first',
  'best', 'top', 'a1', 'ace', 'city', 'county', 'local', 'national', 'united', 'general',
  'modern', 'classic', 'superior', 'total', 'complete', 'perfect', 'professional',
  'advanced', 'smart', 'super', 'golden', 'gold', 'silver', 'diamond', 'crown', 'regal',
  'supreme', 'ultimate', 'alpha', 'apex', 'summit', 'pinnacle', 'precision', 'reliable',
  'affordable', 'budget', 'value', 'direct', 'central', 'north', 'south', 'east', 'west',
  'northern', 'southern', 'eastern', 'western', 'new', 'little', 'big', 'great', 'global',
  'bespoke', 'expert', 'experts', 'master', 'masters', 'trusted', 'dependable', 'swift',
  'rapid', 'quick', 'fast', 'green', 'eco', 'blue', 'red', 'bright', 'clean', 'pure',
]);

/**
 * Where a domain can end up that is not a website of the business's own: a
 * directory, social or messaging page (the domain just forwards there).
 */
const NOT_A_SITE_HOSTS = [
  'facebook.com', 'fb.com', 'm.me', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'tiktok.com', 'youtube.com', 'linktr.ee', 'wa.me', 'whatsapp.com', 'g.page', 'goo.gl',
  'yell.com', 'checkatrade.com', 'trustatrader.com', 'ratedpeople.com', 'mybuilder.com',
  'bark.com', 'thomsonlocal.com', 'scoot.co.uk', 'freeindex.co.uk', 'yelp.co.uk', 'yelp.com',
  'cylex-uk.co.uk', 'hotfrog.co.uk', '192.com', 'google.com', 'maps.google.com',
  'business.google.com', 'companieshouse.gov.uk',
  'find-and-update.company-information.service.gov.uk', 'gov.uk', 'endole.co.uk',
  'opencorporates.com', 'companycheck.co.uk', 'wikipedia.org', 'tripadvisor.co.uk',
  'tripadvisor.com', 'treatwell.co.uk', 'fresha.com', 'booksy.com', 'just-eat.co.uk',
  'deliveroo.co.uk', 'ubereats.com', 'houzz.co.uk', 'nextdoor.co.uk', 'nextdoor.com',
];
/** Domain marketplaces and parking services. */
const PARKING_HOSTS = [
  'sedoparking.com', 'sedo.com', 'parkingcrew.net', 'bodis.com', 'dan.com', 'afternic.com',
  'hugedomains.com', 'sav.com', 'undeveloped.com', 'domainmarket.com', 'above.com',
  'parklogic.com', 'buydomains.com', 'uniregistry.com', 'squadhelp.com', 'atom.com',
  'brandbucket.com', 'efty.com', 'perfectdomain.com', 'epik.com', 'namebright.com',
  'domainnamesales.com',
];
const hostIs = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Text that means the page is not a working website, whoever owns the domain.
 * Only on a short page, and never over their own phone number: a real site
 * can say "our gift card is available to buy online".
 */
const PARKED_RE = new RegExp([
  'domain (name )?(is |may be )?for sale', 'buy this domain', 'make an offer on this domain',
  'this domain (name )?(has|may have)? ?(just |recently )?been registered',
  'this domain (name )?is (registered|parked|for sale)', 'domain parking',
  'parked (for free|free|domain|by|courtesy)', 'this domain is available for purchase',
  'domain has expired', 'this domain has expired', 'renew (this|your) domain',
  'website is currently unavailable', 'account (has been )?suspended',
  'domain default page', 'default web ?(site )?page', 'welcome to nginx',
  'apache2? (ubuntu |debian )?default page', 'index of /',
].join('|'), 'i');
const SOON_RE = /coming soon|under construction|launching soon|future home of|site is being built/i;
/** A title of just "It works!" is a web server's placeholder. */
const PLACEHOLDER_TITLE_RE = /^\s*(it works!?|test page|site not found|domain default page)\s*$/i;
/** Bot challenges: a live site we were not allowed to read. */
const CHALLENGE_RE = /just a moment|checking your browser|attention required|sgcaptcha|cf-chl|enable javascript and cookies to continue|verify you are human/i;
const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

/* ------------------------------------------------------------------ names */

/** A name as plain lower-case words: legal suffix, brackets and apostrophes gone. */
export function nameWords(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The domain names a business would register for itself, most likely first.
 * "COSELEY SERVICES LIMITED" -> coseleyservices, coseley-services.
 * "Smith & Sons Joinery Ltd" -> smithandsonsjoinery, smith-and-sons-joinery,
 * smithsonsjoinery, smith-sons-joinery.
 *
 * Generic words are kept: dropping "services" from "Coseley Services" leaves
 * coseley.co.uk, which is somebody's page about the town.
 */
export function nameSlugs(names) {
  const perName = [];
  for (const name of [names].flat()) {
    const words = nameWords(name);
    if (!words.length) continue;
    const variants = [words];
    const drop = (list, w) => list.filter((x) => x !== w);
    if (words.includes('and')) variants.push(drop(words, 'and'));
    if (words[0] === 'the' && words.length > 1) variants.push(words.slice(1));
    if (words.at(-1) === 'uk' && words.length > 1) variants.push(words.slice(0, -1));
    const out = [];
    for (const v of variants) {
      out.push(v.join(''));
      if (v.length > 1) out.push(v.join('-'));
    }
    perName.push(out);
  }
  // Round-robin across the names given (trading name, registered name), so a
  // cap keeps the best guess from each rather than every variant of the first.
  const merged = [];
  for (let i = 0; perName.some((l) => i < l.length); i++) {
    for (const l of perName) if (i < l.length) merged.push(l[i]);
  }
  return [...new Set(merged)]
    .filter((s) => s.length >= 3 && s.length <= 63 && !/^-|-$/.test(s))
    .slice(0, MAX_SLUGS);
}

/**
 * Every domain worth trying, each with how it was arrived at. An email on the
 * business's own domain is the strongest lead there is, so it goes first.
 */
export function candidateDomains({ names = [], email = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (domain, how) => {
    const d = String(domain ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!d || !d.includes('.') || seen.has(d)) return;
    seen.add(d);
    out.push({ domain: d, how });
  };
  const emailDomain = String(email ?? '').trim().toLowerCase().split('@')[1];
  if (emailDomain && !FREE_MAIL_DOMAINS.has(emailDomain)) add(emailDomain, 'email-domain');
  for (const slug of nameSlugs(names)) {
    for (const tld of TLDS) add(`${slug}.${tld}`, 'name-domain');
  }
  return out;
}

/**
 * The forms their name is looked for in, as whole phrases: the full name,
 * and the name with trailing filler dropped ("Barlows Window Cleaning
 * Services" -> "barlows window cleaning") as long as something is left that
 * is more than filler.
 */
function namePhrases(names) {
  const out = new Map();
  const add = (words) => {
    if (words.length) out.set(words.join(' '), words);
  };
  for (const name of [names].flat()) {
    const words = nameWords(name);
    add(words);
    const trimmed = [...words];
    while (trimmed.length > 1 && GENERIC.has(trimmed.at(-1))) trimmed.pop();
    add(trimmed);
    if (words.includes('and')) add(words.filter((w) => w !== 'and'));
  }
  return [...out.values()];
}

/**
 * Does this name pick out one business? It needs a word that is not filler,
 * not a trade, not a stock word like "premier", not an initial, and not the
 * town: "Wolverhampton Roofing Services" describes half of Wolverhampton.
 */
function distinctive(words, townWords) {
  return words.some((w) => w.length >= 3 && !/^\d+$/.test(w)
    && !GENERIC.has(w) && !TRADE.has(w) && !STOCK.has(w) && !townWords.has(w));
}

/* ------------------------------------------------------------------- pages */

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: "'", lsquo: "'", ndash: '-', mdash: '-', pound: '£' };
/** A character reference as its character; anything out of range as a space. */
const fromCode = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
const decode = (s) => String(s ?? '')
  .replace(/&#x([0-9a-f]{1,8});/gi, (_, h) => fromCode(parseInt(h, 16)))
  .replace(/&#(\d{1,10});/g, (_, d) => fromCode(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/**
 * Lower-case words with single spaces, the form every comparison is made in.
 * Apostrophes go (so "Dave's" is "daves", as in the name) and "&" becomes
 * "and", both exactly as nameWords() does them.
 */
const flat = (s) => ` ${String(s ?? '').toLowerCase()
  .replace(/['’`]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Web addresses and email domains: on a holding page, the only "name" there is. */
const HOST_RE = /\b(?:[a-z0-9-]+\.)+(?:co\.uk|org\.uk|me\.uk|ltd\.uk|com|uk|net|org|biz|info|co)\b/gi;

/** What a reader sees: the title, the description, and the body text. */
export function pageText(html) {
  const raw = String(html ?? '');
  const title = decode(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const metas = [];
  for (const tag of raw.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!key || !/^(description|og:title|og:site_name|og:description|twitter:title)$/.test(key)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) metas.push(decode(content));
  }
  const body = decode(raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const text = [title, ...metas, body].join(' ').replace(/\s+/g, ' ').trim();
  return { title, text, body, words: text ? text.split(' ').length : 0 };
}

const PHONE_RE = /(?:\+44\s*\(?0?\)?|0044|\b0)[\s\-().]*(?:\d[\s\-().]*){9,10}/g;
const POSTCODE_RE = /\b([a-z]{1,2}\d[a-z\d]?)\s*(\d[a-z]{2})\b/gi;

/** Every UK number on the page, as +44… — from tel: links and from the text. */
export function pagePhones(html, text) {
  const found = new Set();
  const add = (v) => {
    // "+44 (0) 7732 170498": the bracketed trunk zero is not part of the number.
    const n = normalisePhone(String(v).replace(/\(\s*0\s*\)/g, ' '));
    if (n.ok) found.add(n.e164);
  };
  for (const m of String(html ?? '').matchAll(/tel:([^"'\s>]+)/gi)) {
    try { add(decodeURIComponent(m[1])); } catch { add(m[1]); }
  }
  for (const m of String(text ?? '').matchAll(PHONE_RE)) add(m[0]);
  return found;
}

/** The first UK postcode in a piece of text, as "WV4 6DW", or null. */
export function postcodeIn(text) {
  POSTCODE_RE.lastIndex = 0;
  const m = POSTCODE_RE.exec(String(text ?? ''));
  POSTCODE_RE.lastIndex = 0;
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null;
}

const compact = (postcode) => String(postcode ?? '').toUpperCase().replace(/\s+/g, '');
/** "WV4 6DW" or "WV46DW" -> "WV4": the inward part is always digit, letter, letter. */
const district = (postcode) => compact(postcode).replace(/\d[A-Z]{2}$/, '');

/**
 * Is this page the business's own website?
 *
 * `biz` is { names, phones, postcode, towns }. `how` is how the page was
 * reached: 'name-domain' (their name as a domain), 'email-domain' (the domain
 * their email is on), 'known-url' (a URL already tied to them), or 'search'.
 * A search result is anyone's page, so it must carry their phone or their
 * exact postcode; the other three are already tied to them by the domain.
 *
 * Returns { match: 'confirmed' | 'possible' | 'blocked' | null, parked, evidence }.
 */
export function judgePage({ html, url }, biz, { how = 'name-domain' } = {}) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (host && hostIs(host, PARKING_HOSTS)) return { match: null, parked: true, evidence: ['parking-host'] };
  if (host && hostIs(host, NOT_A_SITE_HOSTS)) return { match: null, parked: false, evidence: ['forwards-elsewhere'] };

  const { title, text, words } = pageText(html);

  // A parked, for-sale or "coming soon" page is no website, even their own
  // holding page with their number on it: that is the warmest lead there is.
  if (PLACEHOLDER_TITLE_RE.test(title) || PARKED_RE.test(title)
      || (words < 300 && PARKED_RE.test(text))
      || SOON_RE.test(title) || (words < 80 && SOON_RE.test(text))) {
    return { match: null, parked: true, evidence: ['parked'] };
  }

  // Their own number, as Google or the lead holds it, is proof.
  const theirPhones = new Set((biz.phones ?? [])
    .map((p) => normalisePhone(p)).filter((n) => n.ok).map((n) => n.e164));
  if (theirPhones.size && [...pagePhones(html, text)].some((p) => theirPhones.has(p))) {
    return { match: 'confirmed', parked: false, evidence: ['phone'] };
  }
  if (words < 200 && CHALLENGE_RE.test(`${title} ${String(html ?? '').slice(0, 20_000)}`)) {
    return { match: how === 'search' ? null : 'blocked', parked: false, evidence: ['challenge'] };
  }

  // Web addresses out first: a holding page that only shows
  // "coseley-services.co.uk" does not name Coseley Services.
  const page = flat(text.replace(HOST_RE, ' '));
  const has = (phrase) => page.includes(` ${phrase} `);

  const townWords = new Set([biz.towns ?? []].flat().flatMap((t) => flat(t).trim().split(' ')).filter(Boolean));
  const phrases = namePhrases(biz.names ?? []);
  const named = phrases.find((p) => has(p.join(' ')));
  const identifying = Boolean(named) && phrases.some((p) => has(p.join(' ')) && distinctive(p, townWords));

  // Every postcode we hold for them: the registered office is often the
  // accountant's, so the trading address counts just the same.
  const codes = [biz.postcodes ?? [], biz.postcode ?? []].flat().map(compact).filter(Boolean);
  const pageCodes = [...text.matchAll(POSTCODE_RE)].map((m) => `${m[1]}${m[2]}`.toUpperCase());
  const exactPostcode = codes.some((c) => pageCodes.includes(c));
  const sameDistrict = codes.some((c) => pageCodes.some((p) => district(p) === district(c)));
  // Somewhere else: the page gives postcodes, and none is in their districts.
  const elsewhere = codes.length > 0 && pageCodes.length > 0 && !sameDistrict;

  const evidence = [];
  if (named) evidence.push('name');
  if (exactPostcode) evidence.push('postcode');
  else if (sameDistrict) evidence.push('district');
  if (elsewhere) evidence.push('elsewhere');

  // Their full name AND one of their exact postcodes: proof.
  if (named && exactPostcode) return { match: 'confirmed', parked: false, evidence };

  // Anything less is never proof. Names and towns are shared: firms hide
  // their address, list the towns around them, and "Dudley Groundworks" is
  // a place and a trade. On a domain tied to them, a page carrying their
  // name is worth a person's look; that is all.
  if (how !== 'search' && named) {
    return { match: 'possible', parked: false, evidence: identifying ? evidence : [...evidence, 'common-name'] };
  }
  return { match: null, parked: false, evidence };
}

/* ----------------------------------------------------------------- network */

const isDnsFailure = (err) => /ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA|ENODATA|ESERVFAIL/
  .test(String(err?.cause?.code ?? err?.code ?? err?.cause?.message ?? ''));

/** One GET, capped in time and size. Never throws. */
async function getPage(url, { fetchImpl, timeoutMs, signal }) {
  // An abort listener added after the fact never fires, so a spent budget
  // has to be checked before starting, not just listened for.
  if (signal?.aborted) return { ok: false, error: 'aborted' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const stop = () => ac.abort();
  signal?.addEventListener('abort', stop);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-GB,en;q=0.8',
      },
    });
    const finalUrl = res.url || url;
    if (!res.ok) return { ok: false, status: res.status, url: finalUrl };
    const type = (res.headers?.get?.('content-type') ?? '').toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain/.test(type)) {
      return { ok: false, status: res.status, url: finalUrl, nonHtml: true };
    }
    let html = '';
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size >= MAX_BYTES) { reader.cancel().catch(() => {}); break; }
      }
      html = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, MAX_BYTES).toString('utf8');
    } else {
      html = String(await res.text()).slice(0, MAX_BYTES);
    }
    return { ok: true, status: res.status, url: finalUrl, html };
  } catch (err) {
    return { ok: false, dns: isDnsFailure(err), error: err?.cause?.code ?? err?.name ?? 'error' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * One host's home page, the way a browser gets there: https, and plain http
 * when the secure connection itself fails (small old sites still exist). A
 * host that answers "not allowed" (403, a bot challenge) is reported as
 * blocked, because that is a live site we could not read.
 */
async function fetchHost(host, opts) {
  const secure = await getPage(`https://${host}/`, opts);
  if (secure.ok) return { page: secure };
  let blocked = BLOCK_STATUSES.has(secure.status) ? { url: secure.url ?? `https://${host}/` } : null;
  if (!secure.status && !secure.dns && !opts.signal?.aborted) {
    const plain = await getPage(`http://${host}/`, opts);
    if (plain.ok) return { page: plain };
    if (BLOCK_STATUSES.has(plain.status)) blocked ??= { url: plain.url ?? `http://${host}/` };
  }
  return { page: null, blocked };
}

/* ------------------------------------------------------------------ search */

let nextSearchAt = 0;

/**
 * One DuckDuckGo search (the HTML endpoint: no key, no cost). Spaced out
 * across the whole process so a hunt cannot hammer it. `blocked` is set when
 * DuckDuckGo answers with a challenge instead of results, which it does to
 * busy datacentre addresses; the caller should stop searching for a while.
 */
export async function searchWeb(query, {
  fetchImpl = (...a) => globalThis.fetch(...a), gapMs = 4_000, timeoutMs = TIMEOUT_MS, signal,
} = {}) {
  const wait = Math.max(0, nextSearchAt - Date.now());
  nextSearchAt = Date.now() + wait + gapMs;
  if (wait) await new Promise((r) => setTimeout(r, wait));

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=uk-en`;
  const r = await getPage(url, { fetchImpl, timeoutMs, signal });
  if (!r.ok || r.status !== 200) return { urls: [], blocked: true };
  const links = [...r.html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'));
  if (!links.length && /anomaly|captcha|bots use duckduckgo/i.test(r.html)) {
    return { urls: [], blocked: true };
  }
  const urls = links.map((u) => {
    try {
      const abs = u.startsWith('//') ? `https:${u}` : u.startsWith('/') ? `https://duckduckgo.com${u}` : u;
      const parsed = new URL(abs);
      const inner = parsed.searchParams.get('uddg');
      return inner ? decodeURIComponent(inner) : (abs.startsWith('http') ? abs : null);
    } catch { return null; }
  }).filter(Boolean);
  return { urls: [...new Set(urls)], blocked: false };
}

/* -------------------------------------------------------------------- main */

/**
 * Look for the business's own website.
 *
 *   biz:  { names: [...], phones: [...], postcode, towns: [...], email,
 *           knownUrls: [...] }  — any of them may be missing
 *   opts: { fetchImpl, search: false | { gapMs }, budgetMs, timeoutMs }
 *
 * Returns { found, url, domain, confidence, how, evidence, possible, tried,
 * searched, searchBlocked }. `found` is only ever set on hard evidence.
 * `possible` ({ url, why }) is a site that may be theirs but was not proved:
 * shown to a person, never used to drop a prospect. `searchBlocked` means
 * "none that we could see", not a firm no.
 */
export async function findWebsite(biz, {
  fetchImpl = (...a) => globalThis.fetch(...a),
  search = false,
  budgetMs = BUDGET_MS,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), budgetMs);
  const opts = { fetchImpl, timeoutMs, signal: budget.signal };
  const result = { found: false, possible: null, tried: 0, searched: false, searchBlocked: false };

  /** Judge one fetched page (or a refusal) into an outcome for settle(). */
  const outcome = (fetched, how, domain) => {
    const { page, blocked } = fetched;
    if (!page?.ok) {
      return blocked && how !== 'search' ? { possible: { url: blocked.url, why: 'would not let us read it' } } : null;
    }
    const j = judgePage(page, biz, { how });
    if (j.match === 'confirmed') {
      return { hit: { url: page.url, domain: domain ?? hostOf(page.url), confidence: 'confirmed', how, evidence: j.evidence } };
    }
    if (j.match === 'possible') return { possible: { url: page.url, why: 'carries their name' } };
    if (j.match === 'blocked') return { possible: { url: page.url, why: 'would not let us read it' } };
    return null;
  };

  const verdictFor = async ({ domain, how, url }) => {
    result.tried++;
    if (url) {
      const page = await getPage(url, opts);
      return outcome({
        page, blocked: !page.ok && BLOCK_STATUSES.has(page.status) ? { url: page.url ?? url } : null,
      }, how, domain);
    }
    // The bare domain and the www host can be different things entirely: a
    // registrar's parking page on one and the real site on the other, or one
    // that hangs. Both are asked unless the first is already proof.
    const www = `www.${domain}`;
    const first = outcome(await fetchHost(domain, opts), how, domain);
    if (first?.hit || opts.signal?.aborted) return first;
    const second = outcome(await fetchHost(www, opts), how, domain);
    return second?.hit ? second : (first ?? second);
  };

  const settle = (outcomes) => {
    const got = outcomes.filter(Boolean);
    const hit = got.find((o) => o.hit)?.hit;
    if (hit) Object.assign(result, { found: true, ...hit });
    result.possible ??= got.find((o) => o.possible)?.possible ?? null;
    return Boolean(hit);
  };

  try {
    // URLs we already hold for them (say, one Google listed) come first.
    const known = [biz.knownUrls ?? []].flat().filter(Boolean)
      .map((url) => ({ url, domain: hostOf(url), how: 'known-url' }))
      .filter((k) => k.domain && isOwnSiteUrl(k.url));
    const guesses = candidateDomains(biz);
    const queue = [...known, ...guesses];

    for (let i = 0; i < queue.length && !budget.signal.aborted; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      if (settle(await Promise.all(batch.map(verdictFor)))) return result;
    }

    if (search && !budget.signal.aborted) {
      const name = [biz.names ?? []].flat().find(Boolean);
      const town = [biz.towns ?? []].flat().find(Boolean) ?? '';
      if (name) {
        result.searched = true;
        const s = await searchWeb(`${nameWords(name).join(' ')} ${town}`.trim(), {
          fetchImpl, gapMs: search.gapMs ?? 4_000, timeoutMs, signal: budget.signal,
        });
        result.searchBlocked = s.blocked;
        // Only results whose address carries a word that identifies them:
        // a directory's host never does, the business's own site usually does.
        const townWords = new Set([biz.towns ?? []].flat().flatMap((t) => flat(t).trim().split(' ')).filter(Boolean));
        const tokens = [...new Set([biz.names ?? []].flat().flatMap(nameWords)
          .filter((w) => distinctive([w], townWords) && w.length >= 4))];
        const tried = new Set(queue.map((q) => q.domain));
        const picks = s.urls.filter((u) => {
          const host = hostOf(u);
          return host && !tried.has(host) && isOwnSiteUrl(u) && tokens.some((t) => host.includes(t));
        }).slice(0, SEARCH_RESULTS_TO_READ);
        if (settle(await Promise.all(picks.map((url) => verdictFor({ url, domain: hostOf(url), how: 'search' }))))) {
          return result;
        }
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Is this a website of the business's own, rather than a listing, social or
 * messaging page? A Google profile's "website" is often just their Facebook
 * page, and that is a business still without a site.
 */
export function isOwnSiteUrl(url) {
  const host = hostOf(url);
  return Boolean(host) && !hostIs(host, NOT_A_SITE_HOSTS) && !hostIs(host, PARKING_HOSTS);
}
