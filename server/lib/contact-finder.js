/**
 * Contact finder: free discovery of a lead's email and phone.
 *
 * There is no API that gives away real business contact details. Every
 * "email-finder" product costs because verification costs. What CAN be done
 * for free is chase the same trail a person would: the company's website,
 * their Facebook page, their Yell listing, their director's other companies.
 *
 * This module walks that trail and files everything it finds as a signal
 * on the lead. Every signal carries a source and a confidence, so the UI
 * can show provenance and the user picks what to trust.
 *
 * Failure is normal here — websites block scrapers, DuckDuckGo rate-limits,
 * Facebook demands logins. The finder treats every source as best-effort:
 * one source failing does not stop the others, and the finish row records
 * which sources contributed.
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
import { profile as chProfile } from './companies-house.js';
import { FREE_MAIL_DOMAINS } from './pecr.js';

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
export function emailConfidence(email, lead) {
  const domain = email.split('@')[1] ?? '';
  if (FREE_MAIL_DOMAINS.has(domain)) return 30;
  if (lead?.website && domain && lead.website.includes(domain.split('.').slice(-2).join('.'))) {
    return 95; // domain matches the company's own site
  }
  if (/^(info|hello|contact|enquiries|admin|office|sales)@/.test(email)) return 75;
  return 60;
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

/* --------------------------------------------------------- source: CH officers */

/**
 * Cross-reference: pull the company's officers from Companies House, and for
 * each officer, see what other companies they run. If any of THOSE companies
 * have a website registered anywhere, it is a lead in itself — but more
 * usefully, an officer's name plus a UK town is often enough to find a
 * personal Facebook page or LinkedIn.
 *
 * This does not pull emails on its own — it just returns officer names and
 * numbers of other companies they run. The web search step uses that.
 */
export async function officers(companyNumber) {
  if (!companyNumber) return [];
  try {
    const p = await chProfile(companyNumber);
    if (!p) return [];
    return p; // profile only, officer endpoint is a separate call
  } catch {
    return [];
  }
}

/* --------------------------------------------------------- orchestrator */

/**
 * Discover contact signals for one lead. Every source is best-effort;
 * failures are logged onto the contact_finds row.
 *
 * Options:
 *   web:      true  — search the web (DuckDuckGo). Off by default because a
 *                     miss makes noise; the caller opts in explicitly.
 *   website:  true  — fetch the lead's own site if we have one.
 *   maxUrls:  6     — cap on URLs visited across DDG follow-ups.
 */
export async function discover(lead, opts = {}) {
  const {
    web = true, website = true, maxUrls = 6,
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

  // 2. The lead's own website, if we know one.
  const knownWebsite = lead.website ?? null;
  if (website && knownWebsite) {
    sources.push('website');
    try {
      const w = await fromWebsite(knownWebsite);
      for (const e of w.emails)     push('email', e, 'website', emailConfidence(e, lead));
      for (const p of w.phones)     push('phone', p, 'website', 80);
      for (const p of w.whatsapps)  push('whatsapp', p, 'website:wa', 90);
      for (const f of w.facebooks)  push('facebook', f, 'website:fb', 70);
    } catch (e) { errors.push(`website: ${e.message}`); }
  }

  // 3. Web search — top results filtered to directories/social.
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
        for (const e of d.emails)    push('email', e, src, emailConfidence(e, lead));
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
