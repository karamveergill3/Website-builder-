/**
 * The suppression list. The ICO's guidance is to suppress rather than delete:
 * a deleted record is simply re-scraped and re-mailed later, which is itself a
 * compliance failure. So an opt-out writes an entry here keyed on the email
 * address, and that entry outlives the lead.
 */
import { db } from './../db.js';

/**
 * Normalise an address so that an opt-out cannot be defeated by a plus-tag or,
 * on Gmail-style hosts, by dots. dave.smith+leads@gmail.com and
 * davesmith@gmail.com are the same mailbox and must be suppressed together.
 */
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

export function norm(email) {
  const raw = String(email ?? '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1) return raw;

  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOT_INSENSITIVE.has(domain)) local = local.replace(/\./g, '');

  return `${local}@${domain}`;
}

export const domainOf = (email) => norm(email).split('@')[1] ?? '';

/**
 * True if this address, or the whole domain it belongs to, has been
 * suppressed. Domain entries are stored as "@example.co.uk".
 */
export function isSuppressed(email) {
  const e = norm(email);
  if (!e) return false;
  const hit = db.prepare('SELECT 1 FROM suppression_list WHERE email = ? OR email = ?')
    .get(e, `@${domainOf(email)}`);
  return Boolean(hit);
}

/** Suppress everyone at a domain — "stop contacting anyone here". */
export function suppressDomain(domain, { reason = 'domain opted out' } = {}) {
  const d = String(domain ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!d.includes('.')) return false;
  db.prepare(
    `INSERT INTO suppression_list (email, business_name, reason, added_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`
  ).run(`@${d}`, reason, new Date().toISOString());
  return true;
}

export function suppress(email, { businessName = null, reason = 'opted out' } = {}) {
  if (!norm(email)) return false;
  db.prepare(
    `INSERT INTO suppression_list (email, business_name, reason, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`
  ).run(norm(email), businessName, reason, new Date().toISOString());
  return true;
}

export function unsuppress(email) {
  return db.prepare('DELETE FROM suppression_list WHERE email = ?').run(norm(email)).changes > 0;
}

export const list = () =>
  db.prepare('SELECT * FROM suppression_list ORDER BY added_at DESC').all();

export const count = () =>
  db.prepare('SELECT COUNT(*) n FROM suppression_list').get().n;
