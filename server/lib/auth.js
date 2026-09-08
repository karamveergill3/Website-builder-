/**
 * Accounts and sessions for the shared Keylo hub.
 *
 * The tool started life single-user on one laptop, so it had no login at all.
 * The moment it is reachable by a team over the internet, a login is the only
 * thing standing between a stranger with the URL and every lead, every
 * connected Gmail, and the register/Places keys. So this is deliberately
 * plain and careful rather than clever:
 *
 *   - Passwords are scrypt-hashed with a per-user random salt. The plaintext
 *     is never stored and never logged. Verification is constant-time.
 *   - A session is a 256-bit random token given to the browser in an
 *     HttpOnly cookie. The database stores only the SHA-256 of it, so a leak
 *     of the table does not hand anyone a live session — the token itself is
 *     never written down anywhere we keep.
 *   - Everything here uses Node's own crypto. This project ships three
 *     runtime dependencies and a test enforces it; an auth library would be a
 *     fourth, and the built-ins are enough.
 *
 * Roles are just 'admin' and 'rep'. Admin (the owner) can create and suspend
 * rep accounts; a rep can do outreach and manage only themselves.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from '../db.js';
import { nowIso } from './http.js';

export const SESSION_COOKIE = 'keylo_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD = 8;

/* --------------------------------------------------------------- passwords */

/** scrypt hash as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verify. Returns false on any malformed stored value. */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(String(password), salt, expected.length);
  // timingSafeEqual throws on a length mismatch, which itself leaks nothing
  // useful, but guard it so a bad row cannot crash a login.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ----------------------------------------------------------------- users */

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const own = (v) => { const t = String(v ?? '').trim(); return t || null; };

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail(email)) ?? null;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function listUsers() {
  return db.prepare(
    `SELECT id, email, name, phone, role, active, created_at, last_login_at
       FROM users ORDER BY role = 'admin' DESC, name COLLATE NOCASE`
  ).all();
}

/**
 * Create an account. Throws with a `.status` a route can pass straight to the
 * client for the two things a human gets wrong: a weak password and a
 * duplicate email.
 */
export function createUser({ email, name, password, role = 'rep', phone = null }) {
  const e = normEmail(email);
  const n = String(name ?? '').trim();
  if (!e || !e.includes('@')) throw badReq('A valid email address is required.');
  if (!n) throw badReq('A name is required.');
  if (String(password ?? '').length < MIN_PASSWORD) {
    throw badReq(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (!['admin', 'rep'].includes(role)) throw badReq('Unknown role.');
  if (getUserByEmail(e)) throw badReq('An account with that email already exists.');

  const info = db.prepare(
    `INSERT INTO users (email, name, password_hash, role, active, created_at, phone)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(e, n, hashPassword(password), role, nowIso(), own(phone));
  return getUserById(Number(info.lastInsertRowid));
}

export function setUserActive(id, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // sign them out
  return getUserById(id);
}

export function setUserPhone(id, phone) {
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(own(phone), id);
  return getUserById(id);
}

export function setUserPassword(id, password) {
  if (String(password ?? '').length < MIN_PASSWORD) {
    throw badReq(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  // A password change invalidates other sessions — the point of changing it.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}

/** The public shape of a user: never the hash. */
export const publicUser = (u) => u && {
  id: u.id, email: u.email, name: u.name, role: u.role,
  phone: u.phone ?? '', active: u.active === 1,
};

/* --------------------------------------------------------------- sessions */

const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/** Start a session, returning the raw token to put in the cookie. */
export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenHash(token), userId, now.toISOString(), expires.toISOString(), now.toISOString());
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), userId);
  return { token, expires };
}

/**
 * The active, non-suspended user for a session token, or null. Expired rows
 * are cleared as they are met, so the table self-cleans without a cron.
 */
export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash(token));
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  const user = getUserById(row.user_id);
  if (!user || user.active !== 1) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(nowIso(), row.token_hash);
  return user;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

/* ----------------------------------------------------------------- cookies */

/** Parse one cookie out of a Cookie header without pulling in a parser. */
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * The Set-Cookie value for a session. `Secure` only when the request actually
 * arrived over HTTPS — behind the Cloudflare tunnel it does, but on a plain
 * http://localhost a Secure cookie would be silently dropped and lock the
 * owner out of their own machine.
 */
export function sessionCookie(token, { expires, secure } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
  ];
  if (expires) bits.push(`Expires=${expires.toUTCString()}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie({ secure } = {}) {
  const bits = [
    `${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** True when the request reached us over HTTPS, directly or via a proxy. */
export const isSecure = (req) =>
  req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

function badReq(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
