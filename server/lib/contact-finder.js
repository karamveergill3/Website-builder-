/**
 * Contact finder: free discovery of a lead's email and phone.
 *
 * The tool's target is businesses WITH NO WEBSITE. That single fact rules
 * out most of what a general email-finder does — you cannot scrape a
 * website that does not exist, and email addresses genuinely rarely exist
 * for these businesses either. They are phone-first.
 *
 * What the finder actually does, in priority order:
 *
 *   1. Phone from Google Places. Already captured by the daily hunt when
 *      Google's listing carries a nationalPhoneNumber. Filed as a signal
 *      here so the trail is visible on the lead.
 *   2. Web-search-driven directory scrape. DuckDuckGo's HTML endpoint (no
 *      key, no cost) points us at Yell / Facebook / Checkatrade pages that
 *      often carry the phone, sometimes an email, and occasionally a
 *      WhatsApp deep-link the business publishes for enquiries.
 *   3. Website scrape. ONLY when the lead has a website (has_website === 1
 *      on the row, or the caller has told us a URL). For a no-website lead
 *      this path is skipped — there is nothing to fetch.
 *
 * Failure is normal here — DuckDuckGo rate-limits, Facebook demands logins,
 * some sites 403 Node's fetch. Every source is best-effort: one failing
 * does not stop the others, and the finish row records what contributed.
 *
 * Rate discipline:
 *   - 3s minimum between HTTP calls total (shared gate)
 *   - 15s minimum between calls to the same host
 *   - honest User-Agent identifying the tool, not a fake browser
 *   - hard 12s timeout per request
 *
 * The last two matter both ethically and practically: sites that see honest
 * traffic block us less; sites that see fake-browser traffic block harder.
 */

import { db } from '../db.js';
import { normalisePhone } from './handoff.js';
import { FREE_MAIL_DOMAINS } from './pecr.js';
import { configured as placesConfigured, textSearch, normalise as normalisePlace } from './places.js';
import { normaliseName } from './companies-house.js';

const USER_AGENT = 'ProspectBook/1.0 (+contact discovery for personal outreach)';
const HTTP_TIMEOUT_MS = 12_000;
const MIN_GAP_MS = 3_000;
const MIN_HOST_GAP_MS = 15_000;
const MAX_HTML_BYTES = 512 * 1024;

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- fetch gate */

let globalGate = Promise.resolve();
const hostLast = new Map();

async function politeFetch(url) {
  const mine = globalGate.then(() => sleep(MIN_GAP_MS));
  globalGate = mine;
  await mine;

  const host = safeHost(url);
  const last = hostLast.get(host) ?? 0;
  const wait = Math.max(0, last + MIN_HOST_GAP_MS - Date.now());
  if (wait) await sleep(wait);
  hostLast.set(host, Date.now());

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-GB,en;q=0.7',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, url: res.url, body: '' };
    }
    // Only accept text; we don't want to buffer PDFs or images.
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/^(text|application\/xhtml|application\/xml|application\/json)/.test(ctype)) {
      return { ok: false, status: res.status, url: res.url, body: '', skipped: 'non-text' };
    }
    // Cap the read so a hostile page can't fill memory.
    const reader = res.body.getReader();
    let received = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_HTML_BYTES) {
        chunks.push(value.slice(0, MAX_HTML_BYTES - (received - value.length)));
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { ok: true, status: res.status, url: res.url, body };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/* ----------------------------------------------------------- extractors */

// A permissive email regex. False positives (framework variables, TypeScript
// generics) are dropped by later filters; we would rather see too much here
// than miss a real address.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;

// UK phones in the messy shapes real websites use. Anything the normaliser
// then rejects (US numbers, premium ranges) is discarded.
const PHONE_RE = /(?:(?:\+44|0044|0)\s*(?:\d\s*){9,11})/g;

// wa.me links carry the number in the path.
const WA_RE = /(?:https?:\/\/)?(?:api\.whatsapp\.com\/send\?phone=|wa\.me\/)(\+?\d{7,15})/gi;

// mailto: is the strongest signal — the site owner literally wrote "email me here".
const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;

// tel: same.
const TEL_RE = /tel:([^"'?\s>]+)/gi;

// Facebook page URLs.
const FB_RE = /(?:https?:)?\/\/(?:www\.|m\.|business\.)?facebook\.com\/([A-Za-z0-9.\-_/]+)/gi;

/**
 * Text extractor — treat the raw HTML as text plus explicit anchor hrefs.
 * Returns { emails, phones, whatsapps, facebooks }, each an array.
 */
export function extract(html) {
  const emails = new Set();
  const phones = new Set();
  const whatsapps = new Set();
  const facebooks = new Set();
  if (!html) return { emails: [], phones: [], whatsapps: [], facebooks: [] };

  for (const m of html.matchAll(MAILTO_RE)) emails.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of html.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  for (const m of html.matchAll(TEL_RE))    phones.add(decodeURIComponent(m[1]));
  for (const m of html.matchAll(PHONE_RE))  phones.add(m[0].replace(/\s+/g, ' ').trim());
  for (const m of html.matchAll(WA_RE))     whatsapps.add(m[1]);
  for (const m of html.matchAll(FB_RE)) {
    const path = m[1].split('?')[0].split('#')[0];
    if (path && !/^(sharer|tr|dialog|plugins)/.test(path)) {
      facebooks.add(`https://facebook.com/${path.replace(/\/+$/, '')}`);
    }
  }

  return {
    emails: [...emails].filter(cleanEmail),
    phones: [...new Set([...phones].map(cleanPhone).filter(Boolean))],
    whatsapps: [...new Set([...whatsapps].map(cleanPhone).filter(Boolean))],
    facebooks: [...facebooks],
  };
}

function cleanEmail(e) {
  if (e.length < 6 || e.length > 254) return false;
  // Filter obviously junk: entity encoded, or ending in a common asset ext.
  if (/@\d+x/.test(e)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|css|js|ico)$/.test(e)) return false;
  if (/sentry|wixpress|example\.|no-reply|noreply/.test(e)) return false;
  return true;
}

function cleanPhone(p) {
  const n = normalisePhone(p);
  return n.ok ? n.e164 : null;
}

/* --------------------------------------------------------- classifiers */

// Emails on free-mail domains are individuals, not the business. Still worth
// filing (a sole trader IS the business) but at lower confidence and the
// PECR gate will refuse to email them.
export function emailConfidence(email, ctx) {
  const domain = email.split('@')[1] ?? '';
  if (FREE_MAIL_DOMAINS.has(domain)) return 30;
  const site = ctx?.website ?? '';
  if (site && domain && site.toLowerCase().includes(domain.split('.').slice(-2).join('.'))) {
    return 95; // domain matches the source website
  }
  if (/^(info|hello|contact|enquiries|admin|office|sales)@/.test(email)) return 75;
  return 60;
}

/* ------------------------------------------------------- source: Places */

/**
 * Look a business up on Google Places by its own name and town, and read the
 * phone (and website) straight off the listing.
 *
 * This is the finder's most reliable source. Most no-website tradespeople DO
 * have a Google Business Profile — a phone, opening hours, reviews, but no
 * site — and Places answers over a paid API that a server IP can actually
 * reach, unlike DuckDuckGo/Yell scraping which datacenter IPs get blocked or
 * challenged on. It needs a Places key; with none set it is skipped.
 *
 * A listing is only accepted when its name matches the company we asked for,
 * so we never attach a random neighbour's number. Returns a normalised place
 * row ({ phone, website_uri, ... }) or null.
 */
export async function placesLookup(lead, { signal } = {}) {
  const name = lead.registered_name || lead.business_name;
  if (!name) return null;
  const q = [name, lead.location].filter(Boolean).join(' ');
  const { places } = await textSearch(q, { pageSize: 5, signal });
  const key = normaliseName(name);
  if (!key) return null;
  for (const place of places) {
    const row = normalisePlace(place);
    const rk = normaliseName(row.display_name ?? '');
    // Exact, or one name is the other with a suffix ("… Ltd") dropped.
    if (rk && (rk === key || rk.startsWith(key) || key.startsWith(rk))) return row;
  }
  return null; // no confident match — better nothing than the wrong business
}

/* --------------------------------------------------------- source: DDG */

/**
 * DuckDuckGo HTML endpoint. No API key. It may 202 with a challenge under
 * heavy use — treated as a soft failure that other sources can still work
 * around.
 *
 * Returns { urls, error }.
 */
export async function duckSearch(query, { limit = 6 } = {}) {
  const q = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${q}&kl=uk-en`;
  const r = await politeFetch(url);
  if (!r.ok) return { urls: [], error: r.error ?? `duck:${r.status}` };

  // DDG's HTML results wrap each link in <a class="result__a" href="…">.
  // Some responses use their redirect wrapper /l/?uddg=<encoded>&… — undo it.
  const raw = [...r.body.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1]));

  const urls = raw.map((u) => {
    if (u.startsWith('//duckduckgo.com/l/?')) {
      const inner = new URL('https:' + u).searchParams.get('uddg');
      return inner ? decodeURIComponent(inner) : null;
    }
    if (u.startsWith('/l/?')) {
      const inner = new URL('https://duckduckgo.com' + u).searchParams.get('uddg');
      return inner ? decodeURIComponent(inner) : null;
    }
    return u.startsWith('http') ? u : null;
  }).filter(Boolean);

  return { urls: [...new Set(urls)].slice(0, limit), error: null };
}

/**
 * True if a URL looks like a good place to find contact info: directories,
 * Facebook, the company's own site. Filters out news, forums, marketplaces.
 */
export function looksLikeContactSource(url) {
  const host = safeHost(url);
  if (!host) return false;
  const good = [
    'facebook.com', 'yell.com', 'thomsonlocal.com', 'checkatrade.com',
    'trustpilot.com', 'trustatrader.com', 'bark.com', 'mybuilder.com',
    'ratedpeople.com', 'freeindex.co.uk', 'yelp.co.uk', 'yelp.com',
    'scoot.co.uk', 'cylex-uk.co.uk', 'hotfrog.co.uk', '192.com',
    'linkedin.com', 'instagram.com',
  ];
  return good.some((g) => host === g || host.endsWith('.' + g));
}

/* --------------------------------------------------------- source: website */

/**
 * Read a company's own site. Tries the home page, then any /contact/, /about/
 * page linked from it.
 */
export async function fromWebsite(url, { maxPages = 3 } = {}) {
  const seen = new Set();
  const found = { emails: [], phones: [], whatsapps: [], facebooks: [], visited: [] };

  async function visit(u) {
    if (seen.has(u) || seen.size >= maxPages) return;
    seen.add(u);
    const r = await politeFetch(u);
    if (!r.ok) return;
    found.visited.push(u);
    const ex = extract(r.body);
    for (const k of ['emails', 'phones', 'whatsapps', 'facebooks']) {
      for (const v of ex[k]) if (!found[k].includes(v)) found[k].push(v);
    }
    // Follow /contact and /about links.
    const links = [...r.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of links) {
      if (!/contact|about|reach|find[-_]us/i.test(href)) continue;
      try {
        const next = new URL(href, u).toString();
        if (safeHost(next) === safeHost(u)) await visit(next);
      } catch { /* bad URL */ }
    }
  }

  try { await visit(url); } catch { /* ignore */ }
  return found;
}

/* --------------------------------------------------------- source: any URL */

/**
 * Read one directory-style page (Yell, Facebook, Checkatrade). Same extractor
 * — the point of the "looksLikeContactSource" filter is to avoid wasting
 * requests on pages that won't have contact info.
 */
export async function fromDirectory(url) {
  const r = await politeFetch(url);
  if (!r.ok) return { emails: [], phones: [], whatsapps: [], facebooks: [], visited: [] };
  return { ...extract(r.body), visited: [url] };
}

/* --------------------------------------------------------- orchestrator */

/**
 * Discover contact signals for one lead. Every source is best-effort;
 * failures are logged onto the contact_finds row.
 *
 * The lead's `has_website` column decides whether the website path runs at
 * all. A hunt-found lead has has_website=0 — we know they have no site, so
 * there is nothing to scrape. The web-search path still runs and looks for
 * their Yell/Facebook listings.
 *
 * Options:
 *   web:      true            — search the web via DuckDuckGo
 *   websiteUrl: string|null   — a URL the caller wants scraped. Only used
 *                                when the lead is known to have a website
 *                                (has_website === 1) OR the caller supplies
 *                                one explicitly.
 *   maxUrls:  6               — cap on DDG-derived URLs to visit
 */
export async function discover(lead, opts = {}) {
  const {
    web = true, websiteUrl = null, maxUrls = 6,
  } = opts;

  const info = db.prepare(
    'INSERT INTO contact_finds (lead_id, started_at, sources) VALUES (?, ?, ?)'
  ).run(lead.id, nowIso(), '');
  const findId = info.lastInsertRowid;

  const sources = [];
  const signals = [];
  const errors = [];

  const push = (kind, value, source, confidence, note = null) => {
    if (!value) return;
    signals.push({ kind, value, source, confidence, note });
  };

  // 1. Already-known signals on the lead itself.
  if (lead.phone) {
    const n = normalisePhone(lead.phone);
    if (n.ok) push('phone', n.e164, 'lead:existing', 100);
  }
  if (lead.email) push('email', lead.email.toLowerCase(), 'lead:existing', 100);

  // 2. Google Places — the finder's primary source. Reliable from a server IP
  //    (a paid API, not a scrape), and the one place a no-website tradesman
  //    usually still appears: a Google Business Profile with a phone. Gets the
  //    phone directly, and hands the website scrape a URL if Google has one.
  let placesWebsite = null;
  if (placesConfigured() && (lead.registered_name || lead.business_name)) {
    sources.push('places');
    try {
      const p = await placesLookup(lead);
      if (p?.phone) {
        const n = normalisePhone(p.phone);
        if (n.ok) push('phone', n.e164, 'places', 88);
      }
      if (p?.website_uri) {
        push('website', p.website_uri, 'places', 90);
        placesWebsite = p.website_uri;
      }
    } catch (e) { errors.push(`places: ${e.message}`); }
  }

  // 3. Any URL we already know for this lead — from Places just now, passed in
  //    by the caller, or previously filed as a website signal.
  const priorWebsite = db.prepare(
    `SELECT value FROM contact_signals
      WHERE lead_id = ? AND kind = 'website'
      ORDER BY confidence DESC, first_seen_at ASC LIMIT 1`
  ).get(lead.id)?.value ?? null;

  const scrapeUrl = websiteUrl
    || placesWebsite
    || (lead.has_website === 1 ? priorWebsite : null)
    || (lead.has_website !== 0 ? priorWebsite : null);

  if (scrapeUrl) {
    sources.push('website');
    try {
      const w = await fromWebsite(scrapeUrl);
      for (const e of w.emails)     push('email', e, 'website', emailConfidence(e, { website: scrapeUrl }));
      for (const p of w.phones)     push('phone', p, 'website', 80);
      for (const p of w.whatsapps)  push('whatsapp', p, 'website:wa', 90);
      for (const f of w.facebooks)  push('facebook', f, 'website:fb', 70);
    } catch (e) { errors.push(`website: ${e.message}`); }
  } else if (lead.has_website === 0) {
    errors.push('no-website: skipped web scrape (this business has no site)');
  }

  // 4. Web search — top results filtered to directories/social. A useful
  //    extra for no-website leads, but unreliable: DuckDuckGo rate-limits and
  //    challenges datacenter IPs, so this is best-effort behind Places. A
  //    search that 202s or 403s is recorded and the sweep moves on.
  if (web && (lead.business_name || lead.registered_name)) {
    sources.push('web');
    const q = [lead.registered_name ?? lead.business_name, lead.location]
      .filter(Boolean).join(' ');
    let visited = 0;
    try {
      const s = await duckSearch(q);
      if (s.error) errors.push(`duck: ${s.error}`);
      for (const url of s.urls) {
        if (visited >= maxUrls) break;
        if (!looksLikeContactSource(url)) continue;
        visited++;
        const d = await fromDirectory(url);
        const host = safeHost(url);
        const src = `web:${host}`;
        for (const e of d.emails)    push('email', e, src, emailConfidence(e, {}));
        for (const p of d.phones)    push('phone', p, src, 70);
        for (const p of d.whatsapps) push('whatsapp', p, src, 85);
        for (const f of d.facebooks) push('facebook', f, src, 60);
      }
    } catch (e) { errors.push(`web: ${e.message}`); }
  }

  // Persist deduped by (lead, kind, value); UNIQUE index handles it.
  const upsert = db.prepare(
    `INSERT INTO contact_signals
       (lead_id, kind, value, source, confidence, note, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id, kind, value) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       confidence   = MAX(confidence, excluded.confidence),
       source       = CASE WHEN excluded.confidence > contact_signals.confidence
                           THEN excluded.source ELSE contact_signals.source END`
  );

  let saved = 0;
  for (const s of signals) {
    upsert.run(lead.id, s.kind, s.value, s.source, s.confidence, s.note, nowIso(), nowIso());
    saved++;
  }

  db.prepare(
    `UPDATE contact_finds
        SET finished_at = ?, signals = ?, sources = ?, error = ?
      WHERE id = ?`
  ).run(nowIso(), saved, sources.join(','), errors.join(' | ') || null, findId);

  return { findId, signals: signalsForLead(lead.id), errors, sources };
}

/* --------------------------------------------------------- repo helpers */

export function signalsForLead(leadId) {
  return db.prepare(
    `SELECT id, kind, value, source, confidence, note, first_seen_at, last_seen_at, promoted_at
       FROM contact_signals
      WHERE lead_id = ?
      ORDER BY (kind = 'email') DESC, confidence DESC, first_seen_at ASC`
  ).all(leadId);
}

const isMobileValue = (v) => normalisePhone(v).mobile === true;

/**
 * After a sweep files a lead's signals, copy the best ones onto the lead
 * itself, so the number shows on the row and the filters work — without the
 * owner opening every lead to promote by hand.
 *
 * Only a blank field is filled; anything already on the lead is left alone.
 * For the phone a MOBILE beats a landline (WhatsApp and SMS reach 07s and
 * nothing else), then higher confidence wins. An email is only auto-filled
 * when it is a real find (confidence >= 50), so a low-confidence personal
 * address does not quietly attach itself.
 *
 * Returns what it set: { phone?, phoneMobile?, email? }.
 */
export function autoPromote(leadId) {
  const lead = db.prepare('SELECT phone, email FROM leads WHERE id = ?').get(leadId);
  if (!lead) return {};
  const sigs = signalsForLead(leadId);
  const out = {};
  const blank = (v) => !v || !String(v).trim();

  if (blank(lead.phone)) {
    const phones = sigs.filter((s) => s.kind === 'phone').sort((a, b) =>
      (Number(isMobileValue(b.value)) - Number(isMobileValue(a.value)))
      || (b.confidence - a.confidence));
    if (phones[0]) {
      db.prepare('UPDATE leads SET phone = ? WHERE id = ?').run(phones[0].value, leadId);
      db.prepare('UPDATE contact_signals SET promoted_at = ? WHERE id = ?').run(nowIso(), phones[0].id);
      out.phone = phones[0].value;
      out.phoneMobile = isMobileValue(phones[0].value);
    }
  }
  if (blank(lead.email)) {
    const email = sigs.filter((s) => s.kind === 'email' && s.confidence >= 50)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (email) {
      db.prepare('UPDATE leads SET email = ? WHERE id = ?').run(email.value, leadId);
      db.prepare('UPDATE contact_signals SET promoted_at = ? WHERE id = ?').run(nowIso(), email.id);
      out.email = email.value;
    }
  }
  return out;
}

export function promoteSignal(leadId, signalId) {
  const sig = db.prepare(
    'SELECT * FROM contact_signals WHERE id = ? AND lead_id = ?'
  ).get(signalId, leadId);
  if (!sig) return null;

  if (sig.kind === 'email') {
    db.prepare('UPDATE leads SET email = ? WHERE id = ?').run(sig.value, leadId);
  } else if (sig.kind === 'phone') {
    db.prepare('UPDATE leads SET phone = ? WHERE id = ?').run(sig.value, leadId);
  }
  db.prepare('UPDATE contact_signals SET promoted_at = ? WHERE id = ?').run(nowIso(), signalId);
  return { promoted: sig };
}

export function recentFinds(leadId, limit = 5) {
  return db.prepare(
    `SELECT id, started_at, finished_at, signals, error, sources
       FROM contact_finds
      WHERE lead_id = ?
      ORDER BY started_at DESC
      LIMIT ?`
  ).all(leadId, limit);
}
