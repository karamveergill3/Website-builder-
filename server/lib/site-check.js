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
 *   3. A web search for their name and town, when the caller supplies one.
 *
 * A domain that answers is not proof on its own: it may be parked, for sale,
 * "coming soon", or a different firm with the same name in another town. So
 * the page has to be THEIRS before it counts:
 *
 *   confirmed  the page carries their phone number, or their name together
 *              with their town or postcode;
 *   likely     their full name as a domain, the page names them, and nothing
 *              on it places them somewhere else (a different postcode).
 *
 * Either one means "has a website". A parked page, a domain that forwards to
 * a Facebook page, or a page about someone else does not.
 *
 * No database here, and every network call goes through `fetchImpl`, so the
 * logic can be tested without the internet and without a data file.
 */
import { normalisePhone } from './handoff.js';
import { FREE_MAIL_DOMAINS } from './pecr.js';

const USER_AGENT = 'ProspectBook/1.0 (+checking whether a business already has a website)';
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

/**
 * Where a domain can end up that is not a website of the business's own: a
 * directory or social page (the domain just forwards to their Facebook), or a
 * domain marketplace (it is parked and for sale).
 */
const NOT_A_SITE_HOSTS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'linktr.ee', 'yell.com', 'checkatrade.com', 'trustatrader.com',
  'ratedpeople.com', 'mybuilder.com', 'bark.com', 'thomsonlocal.com', 'scoot.co.uk',
  'freeindex.co.uk', 'yelp.co.uk', 'yelp.com', 'cylex-uk.co.uk', 'hotfrog.co.uk', '192.com',
  'google.com', 'maps.google.com', 'business.google.com', 'companieshouse.gov.uk',
  'find-and-update.company-information.service.gov.uk', 'gov.uk', 'endole.co.uk',
  'opencorporates.com', 'companycheck.co.uk', 'wikipedia.org', 'tripadvisor.co.uk',
  'tripadvisor.com', 'treatwell.co.uk', 'fresha.com', 'booksy.com', 'just-eat.co.uk',
  'deliveroo.co.uk', 'ubereats.com',
];
const PARKING_HOSTS = [
  'sedoparking.com', 'sedo.com', 'parkingcrew.net', 'bodis.com', 'dan.com', 'afternic.com',
  'hugedomains.com', 'sav.com', 'undeveloped.com', 'domainmarket.com', 'above.com',
  'parklogic.com', 'buydomains.com', 'uniregistry.com', 'squadhelp.com', 'atom.com',
  'brandbucket.com', 'efty.com', 'perfectdomain.com', 'epik.com', 'namebright.com',
  'domainnamesales.com', 'godaddysites.com',
];
const hostIs = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Text that means the page is not a working website, whoever owns the domain.
 * PARKED is decisive on any short page. SOON only on a near-empty one: a real
 * one-page site can say "online booking coming soon" in passing.
 */
const PARKED_RE = new RegExp([
  'domain (name )?(is |may be )?for sale', 'buy this domain', 'make an offer on this domain',
  'this domain (name )?(has been|is) (registered|parked|for sale)', 'domain parking',
  'parked (free|domain|by|courtesy)', 'is available for purchase', 'domain has expired',
  'this domain has expired', 'renew (this|your) domain', 'website is currently unavailable',
  'account (has been )?suspended', 'default web ?(site )?page', 'welcome to nginx',
  'apache2? (ubuntu |debian )?default page', 'it works!', 'index of /',
].join('|'), 'i');
const SOON_RE = /coming soon|under construction|launching soon|future home of|site is being built/i;

/* ------------------------------------------------------------------ names */

/** A name as plain lower-case words, legal suffix and brackets gone. */
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

/* ------------------------------------------------------------------- pages */

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: "'", lsquo: "'", ndash: '-', mdash: '-', pound: '£' };
const decode = (s) => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/** Lower-case, punctuation to spaces: the form every comparison is made in. */
const flat = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9£]+/g, ' ').trim()} `;

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
    .replace(/<[^>]+>/g, ' '));
  const text = [title, ...metas, body].join(' ').replace(/\s+/g, ' ').trim();
  return { title, text, words: text ? text.split(' ').length : 0 };
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

const outward = (postcode) => String(postcode ?? '').trim().toUpperCase().split(/\s+/)[0] || '';

/**
 * Is this page the business's own website?
 *
 * `biz` is { names, phones, postcode, towns }. `how` is how the domain was
 * found: a guessed name-domain may be judged 'likely' on the name alone, as
 * long as nothing contradicts it; a search result or an email domain must be
 * confirmed by phone or by name and place.
 *
 * Returns { match: 'confirmed' | 'likely' | null, parked, evidence: [...] }.
 */
export function judgePage({ html, url }, biz, { how = 'name-domain' } = {}) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (host && hostIs(host, PARKING_HOSTS)) return { match: null, parked: true, evidence: ['parking-host'] };
  if (host && hostIs(host, NOT_A_SITE_HOSTS)) return { match: null, parked: false, evidence: ['forwards-to-directory'] };

  const { title, text, words } = pageText(html);
  const page = flat(text);

  if (PARKED_RE.test(title) || (words < 300 && PARKED_RE.test(text))
      || SOON_RE.test(title) || (words < 80 && SOON_RE.test(text))) {
    return { match: null, parked: true, evidence: ['parked'] };
  }

  const evidence = [];
  const has = (w) => page.includes(` ${w} `);

  const theirPhones = new Set((biz.phones ?? [])
    .map((p) => normalisePhone(p)).filter((n) => n.ok).map((n) => n.e164));
  const phoneHit = theirPhones.size > 0
    && [...pagePhones(html, text)].some((p) => theirPhones.has(p));
  if (phoneHit) evidence.push('phone');

  // Name: every distinctive word of one of their names, as whole words. The
  // strict form also needs the generic words ("services"), for 'likely'.
  const nameSets = [biz.names ?? []].flat().map(nameWords).filter((w) => w.length);
  const distinctive = (w) => w.filter((x) => !GENERIC.has(x));
  const nameWeak = nameSets.some((w) => distinctive(w).length > 0 && distinctive(w).every(has));
  const nameStrong = nameSets.some((w) => w.filter((x) => !['the', 'and', 'of', 'a'].includes(x)).every(has))
    && nameWeak;
  if (nameWeak) evidence.push('name');

  const code = String(biz.postcode ?? '').toUpperCase();
  const pageCodes = [...text.matchAll(POSTCODE_RE)].map((m) => `${m[1]} ${m[2]}`.toUpperCase());
  const postcodeHit = Boolean(code)
    && (pageCodes.some((p) => p.replace(/\s/g, '') === code.replace(/\s/g, ''))
      || has(outward(code).toLowerCase()));
  if (postcodeHit) evidence.push('postcode');

  const townHit = [biz.towns ?? []].flat().some((t) => {
    const f = flat(t).trim();
    return f && page.includes(` ${f} `);
  });
  if (townHit) evidence.push('town');

  // Somewhere else: the page gives postcodes, and none is in their district.
  const elsewhere = Boolean(code) && pageCodes.length > 0
    && !pageCodes.some((p) => outward(p) === outward(code));

  if (phoneHit || (nameWeak && (postcodeHit || townHit))) {
    return { match: 'confirmed', parked: false, evidence };
  }
  // On the name alone: a guessed domain must carry their full name; one we
  // already tie to them (their email's domain, a URL on file) just has to
  // name them. Neither counts if the page puts them in another district.
  const onName = how === 'name-domain' ? nameStrong
    : (how === 'email-domain' || how === 'known-url') ? nameWeak : false;
  if (onName && !elsewhere) {
    return { match: 'likely', parked: false, evidence };
  }
  return { match: null, parked: false, evidence: elsewhere ? [...evidence, 'elsewhere'] : evidence };
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
 * Fetch a domain's home page the ways a browser would get there: https on the
 * bare domain, then the www host if the bare one has no address, then plain
 * http if the secure connection fails (small old sites still exist).
 */
async function fetchDomain(domain, opts) {
  const tries = [];
  const secure = await getPage(`https://${domain}/`, opts);
  tries.push(secure);
  if (secure.ok) return { page: secure, tries };
  if (secure.dns) {
    const host = `www.${domain}`;
    const www = await getPage(`https://${host}/`, opts);
    tries.push(www);
    if (www.ok || www.dns) return { page: www.ok ? www : null, tries };
  } else if (!secure.status) {
    const plain = await getPage(`http://${domain}/`, opts);
    tries.push(plain);
    if (plain.ok) return { page: plain, tries };
  }
  return { page: null, tries };
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
 * Returns { found, url, domain, confidence, how, evidence, tried, searched,
 * searchBlocked }. `found` false with `searchBlocked` true means the answer
 * is "none that we could see", not a firm no.
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
  const result = { found: false, tried: 0, searched: false, searchBlocked: false };

  const verdictFor = async ({ domain, how, url }) => {
    const { page } = url
      ? { page: await getPage(url, opts) }
      : await fetchDomain(domain, opts);
    result.tried++;
    if (!page?.ok) return null;
    const j = judgePage(page, biz, { how });
    return j.match ? { url: page.url, domain: domain ?? hostOf(page.url), confidence: j.match, how, evidence: j.evidence } : null;
  };

  const settle = (hits) => {
    const best = hits.filter(Boolean)
      .sort((a, b) => (a.confidence === 'confirmed' ? 0 : 1) - (b.confidence === 'confirmed' ? 0 : 1))[0];
    if (best) Object.assign(result, { found: true, ...best });
    return Boolean(best);
  };

  try {
    // URLs we already hold for them (say, one Google listed) come first.
    const known = [biz.knownUrls ?? []].flat().filter(Boolean)
      .map((url) => ({ url, domain: hostOf(url), how: 'known-url' }))
      .filter((k) => k.domain && !hostIs(k.domain, NOT_A_SITE_HOSTS));
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
        // Only results whose address carries a distinctive word of the name:
        // a directory's host never does, the business's own site usually does.
        const tokens = [...new Set([biz.names ?? []].flat().flatMap(nameWords)
          .filter((w) => w.length >= 4 && !GENERIC.has(w)))];
        const tried = new Set(queue.map((q) => q.domain));
        const picks = s.urls.filter((u) => {
          const host = hostOf(u);
          return host && !tried.has(host) && !hostIs(host, NOT_A_SITE_HOSTS)
            && !hostIs(host, PARKING_HOSTS) && tokens.some((t) => host.includes(t));
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
 * Is this a website of the business's own, rather than a listing or social
 * page? A Google profile's "website" is often just their Facebook page, and
 * that is a business still without a site.
 */
export function isOwnSiteUrl(url) {
  const host = hostOf(url);
  return Boolean(host) && !hostIs(host, NOT_A_SITE_HOSTS) && !hostIs(host, PARKING_HOSTS);
}
