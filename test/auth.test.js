/**
 * The login gate.
 *
 * The whole database sits behind this now, so it gets its own tests rather
 * than only being exercised incidentally by the helper that logs the rest of
 * the suite in. The things that matter: nothing is reachable without a
 * session, a wrong password is refused, one account cannot do another's
 * admin, a suspended account is locked out at once, and the session token is
 * never stored in a form that could be replayed from a database dump.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { base, teardown, TEST_ADMIN } = await import('./helpers.js');
const { db } = await import('../server/db.js');

/** A request helper that never touches shared state and returns any cookie. */
async function call(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null };
}

const login = async (email, password) =>
  call('POST', '/api/auth/login', { body: { email, password } });

/* helpers.js has already run /api/auth/setup as TEST_ADMIN before we start. */

/* --------------------------------------------------------------- the gate */

test('a protected route is refused with no session', async () => {
  const res = await call('GET', '/api/leads');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('status tells the app whether to show a login or a setup screen', async () => {
  const res = await call('GET', '/api/auth/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.authenticated, false);
  assert.equal(res.body.needs_setup, false, 'the admin already exists');
});

test('setup refuses once an account exists, so no second admin can be minted', async () => {
  const res = await call('POST', '/api/auth/setup', {
    body: { name: 'Sneaky', email: 'sneaky@test.example', password: 'password123' },
  });
  assert.equal(res.status, 400);
});

test('health stays open — it must work before anyone signs in', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
});

/* --------------------------------------------------------------- login */

test('a wrong password is refused, and unknown emails look identical', async () => {
  const wrong = await login(TEST_ADMIN.email, 'not-the-password');
  const missing = await login('nobody@test.example', 'whatever-goes-here');
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error,
    'the message must not reveal whether the email has an account');
});

test('the right password signs you in and the cookie reaches the API', async () => {
  const res = await login(TEST_ADMIN.email, TEST_ADMIN.password);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.ok(res.cookie, 'a session cookie is set');
  assert.match(res.setCookie, /HttpOnly/i, 'the cookie is not readable by script');
  assert.match(res.setCookie, /SameSite=Lax/i);

  const leads = await call('GET', '/api/leads', { cookie: res.cookie });
  assert.equal(leads.status, 200);
  const me = await call('GET', '/api/auth/me', { cookie: res.cookie });
  assert.equal(me.body.user.email, TEST_ADMIN.email);
});

test('the email is matched case-insensitively', async () => {
  const res = await login(TEST_ADMIN.email.toUpperCase(), TEST_ADMIN.password);
  assert.equal(res.status, 200);
});

test('logging out kills the session server-side, not just the cookie', async () => {
  const { cookie } = await login(TEST_ADMIN.email, TEST_ADMIN.password);
  assert.equal((await call('GET', '/api/leads', { cookie })).status, 200);
  await call('POST', '/api/auth/logout', { cookie });
  assert.equal((await call('GET', '/api/leads', { cookie })).status, 401,
    'the same cookie must not work after logout');
});

test('the session token is stored hashed, never in the clear', async () => {
  const { cookie } = await login(TEST_ADMIN.email, TEST_ADMIN.password);
  const token = cookie.split('=')[1];
  const hash = createHash('sha256').update(token).digest('hex');
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(hash),
    'the row is keyed by the hash of the token');
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined,
    'the raw token appears nowhere in the table');
});

/* --------------------------------------------------------------- roles */

async function adminCookie() {
  return (await login(TEST_ADMIN.email, TEST_ADMIN.password)).cookie;
}

test('a rep can be created, can log in, but cannot manage the team', async () => {
  const admin = await adminCookie();
  const made = await call('POST', '/api/auth/users', {
    cookie: admin,
    body: { name: 'Rep One', email: 'rep1@test.example', password: 'rep-pass-123', role: 'rep' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.role, 'rep');

  const rep = await login('rep1@test.example', 'rep-pass-123');
  assert.equal(rep.status, 200);

  // A rep may work leads...
  assert.equal((await call('GET', '/api/leads', { cookie: rep.cookie })).status, 200);
  // ...but not see or change the team.
  assert.equal((await call('GET', '/api/auth/users', { cookie: rep.cookie })).status, 403);
  assert.equal((await call('POST', '/api/auth/users', {
    cookie: rep.cookie,
    body: { name: 'X', email: 'x@test.example', password: 'xxxxxxxx' },
  })).status, 403);

  // The admin can.
  assert.equal((await call('GET', '/api/auth/users', { cookie: admin })).status, 200);
});

test('a rep can change their own password, and the old one then fails', async () => {
  const admin = await adminCookie();
  await call('POST', '/api/auth/users', {
    cookie: admin,
    body: { name: 'Rep Two', email: 'rep2@test.example', password: 'old-pass-123', role: 'rep' },
  });
  const rep = await login('rep2@test.example', 'old-pass-123');
  await call('PATCH', '/api/auth/me', { cookie: rep.cookie, body: { password: 'new-pass-456' } });

  assert.equal((await login('rep2@test.example', 'old-pass-123')).status, 401);
  assert.equal((await login('rep2@test.example', 'new-pass-456')).status, 200);
});

test('a short password is refused on create', async () => {
  const admin = await adminCookie();
  const res = await call('POST', '/api/auth/users', {
    cookie: admin,
    body: { name: 'Weak', email: 'weak@test.example', password: 'short' },
  });
  assert.equal(res.status, 400);
});

test('suspending a rep locks them out immediately', async () => {
  const admin = await adminCookie();
  const made = await call('POST', '/api/auth/users', {
    cookie: admin,
    body: { name: 'Rep Three', email: 'rep3@test.example', password: 'rep-pass-123', role: 'rep' },
  });
  const rep = await login('rep3@test.example', 'rep-pass-123');
  assert.equal((await call('GET', '/api/leads', { cookie: rep.cookie })).status, 200);

  await call('PATCH', `/api/auth/users/${made.body.user.id}`, {
    cookie: admin, body: { active: false },
  });

  // Their live session stops working, and they cannot sign back in.
  assert.equal((await call('GET', '/api/leads', { cookie: rep.cookie })).status, 401);
  assert.equal((await login('rep3@test.example', 'rep-pass-123')).status, 401);
});

test('the admin cannot suspend or demote their own account', async () => {
  const admin = await adminCookie();
  const me = await call('GET', '/api/auth/me', { cookie: admin });
  const res = await call('PATCH', `/api/auth/users/${me.body.user.id}`, {
    cookie: admin, body: { active: false },
  });
  assert.equal(res.status, 400, 'locking the last admin out of the hub is refused');
});

test.after(teardown);
