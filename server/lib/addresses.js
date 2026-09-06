/**
 * Checking an address before anything is sent to it.
 *
 * At 10-25 messages a day, percentage thresholds are brutal: one hard bounce
 * is a 4% daily bounce rate, and providers start throttling around 2-5%. A
 * single dead address does more damage than any amount of copy-editing, so
 * this runs before every send.
 *
 * Everything here is local: syntax, a typo check, a disposable-domain list,
 * and a DNS MX lookup. It deliberately does NOT probe the recipient's mail
 * server with RCPT TO -- that is unreliable against catch-all and greylisting
 * servers, is widely treated as abusive, and can get the probing IP listed.
 */
import { promises as dns } from 'node:dns';

/** Throwaway-mailbox providers. A lead using one is not a real prospect. */
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com',
  'sharklasers.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'mytemp.email',
  'spamgourmet.com', 'mohmal.com', 'emailondeck.com', 'burnermail.io',
  'moakt.com', 'tempr.email', 'inboxkitten.com', 'harakirimail.com',
]);

/** Near-misses for domains people mistype often. */
const TYPOS = new Map(Object.entries({
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmaill.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmail.co': 'hotmail.co.uk', 'hotmali.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outook.com': 'outlook.com', 'outlook.co': 'outlook.com',
  'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.co': 'yahoo.co.uk',
  'btinternet.co': 'btinternet.com', 'icloud.co': 'icloud.com',
  'live.co': 'live.co.uk', 'sky.co': 'sky.com',
}));

/**
 * Deliberately permissive. The goal is to catch mistakes, not to adjudicate
 * RFC 5321 -- real addresses in the wild break most "correct" regexes.
 */
const SHAPE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[a-z]{2,}$/i;

export const domainOf = (email) =>
  String(email ?? '').trim().toLowerCase().split('@')[1] ?? '';

/** Cache MX answers for the life of the process; DNS is slow and repetitive. */
const mxCache = new Map();

export async function hasMx(domain, { timeoutMs = 4000 } = {}) {
  const d = String(domain ?? '').toLowerCase();
  if (!d) return { ok: false, reason: 'no domain' };
  if (mxCache.has(d)) return mxCache.get(d);

  const answer = await Promise.race([
    dns.resolveMx(d).then(
      (records) => (records?.length
        ? { ok: true, hosts: records.map((r) => r.exchange) }
        : { ok: false, reason: 'the domain publishes no mail server' }),
      async (err) => {
        // A domain with an A record but no MX can still legally receive mail,
        // so fall back rather than calling it dead.
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
          try {
            await dns.resolve(d);
            return { ok: true, hosts: [], note: 'no MX record — mail would fall back to the A record' };
          } catch {
            return { ok: false, reason: err.code === 'ENOTFOUND' ? 'the domain does not resolve' : 'the domain publishes no mail server' };
          }
        }
        return { ok: null, reason: `DNS lookup failed (${err.code ?? 'unknown'})` };
      }
    ),
    new Promise((r) => setTimeout(() => r({ ok: null, reason: 'DNS lookup timed out' }), timeoutMs)),
  ]);

  // Only cache a definite answer; a timeout should be retried later.
  if (answer.ok !== null) mxCache.set(d, answer);
  return answer;
}

/**
 * Check one address. `level` is 'ok' | 'warn' | 'bad'; only 'bad' blocks a
 * send. Pass { dns: false } to skip the network lookup.
 */
export async function checkAddress(email, { dns: useDns = true } = {}) {
  const raw = String(email ?? '').trim();
  const notes = [];

  if (!raw) return { level: 'bad', email: raw, reason: 'No address', notes };
  if (!SHAPE.test(raw)) {
    return { level: 'bad', email: raw, reason: 'That is not a valid address', notes };
  }

  const domain = domainOf(raw);

  const suggestion = TYPOS.get(domain);
  if (suggestion) {
    return {
      level: 'bad', email: raw, domain,
      reason: `Looks like a typo — did you mean ${raw.split('@')[0]}@${suggestion}?`,
      suggestion: `${raw.split('@')[0]}@${suggestion}`, notes,
    };
  }

  if (DISPOSABLE.has(domain)) {
    return { level: 'bad', email: raw, domain, reason: 'A throwaway mailbox provider', notes };
  }

  if (!useDns) return { level: 'ok', email: raw, domain, notes };

  const mx = await hasMx(domain);
  if (mx.ok === false) {
    return { level: 'bad', email: raw, domain, reason: mx.reason, notes };
  }
  if (mx.ok === null) {
    notes.push(mx.reason);
    return { level: 'warn', email: raw, domain, reason: mx.reason, notes };
  }
  if (mx.note) notes.push(mx.note);

  return { level: 'ok', email: raw, domain, notes, mx: mx.hosts };
}

/** Check several addresses concurrently, in small batches. */
export async function checkMany(emails, opts = {}) {
  const out = [];
  const list = [...emails];
  while (list.length) {
    const batch = list.splice(0, 8);
    out.push(...await Promise.all(batch.map((e) => checkAddress(e, opts))));
  }
  return out;
}
