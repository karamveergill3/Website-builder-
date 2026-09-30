/**
 * The passcode on the front door.
 *
 * Two things matter more than the happy path, and both are here:
 *
 *   - a CLIENT must never meet it. Invoice links, Direct Debit returns and
 *     mockup previews go to prospects who have no code, and a gate in front of
 *     those does not read as "secure", it reads as "their link is broken".
 *   - six digits is a million guesses, so the rate limit is the only thing
 *     making the code worth anything. If that stops working the gate is
 *     decorative.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const PASSCODE = '050152';
process.env.SITE_PASSCODE = PASSCODE;

const { base, teardown } = await import('./helpers.js');
const gate = await import('../server/lib/site-gate.js');

test.after(teardown);

/** A request that carries no cookies and never follows a redirect. */
async function call(method, path, { body, cookie, address } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      // The app sits on loopback behind Caddy, so the rate limiter keys on the
      // LAST X-Forwarded-For entry. Giving each test its own address keeps one
      // test's failed attempts from locking another one out.
      ...(address ? { 'X-Forwarded-For': address } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    location: res.headers.get('location'),
    text: await res.text(),
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

const unlock = async (address) => (await call('POST', '/gate',
  { body: { code: PASSCODE, next: '/' }, address })).cookie;

/* ------------------------------------------------------------- the gate */

test('the app shell is behind the passcode', async () => {
  const res = await call('GET', '/', { address: '10.0.0.1' });
  assert.equal(res.status, 401);
  assert.match(res.text, /Enter your passcode/);
  assert.doesNotMatch(res.text, new RegExp(PASSCODE), 'the page must not contain the code');
});

test('the right passcode opens it and the cookie carries', async () => {
  const res = await call('POST', '/gate', { body: { code: PASSCODE, next: '/' }, address: '10.0.0.2' });
  assert.equal(res.status, 303);
  assert.equal(res.location, '/');
  assert.ok(res.cookie, 'a gate cookie is set');

  const shell = await call('GET', '/', { cookie: res.cookie, address: '10.0.0.2' });
  assert.equal(shell.status, 200);
  assert.doesNotMatch(shell.text, /Enter your passcode/);
});

test('the wrong passcode is refused', async () => {
  const res = await call('POST', '/gate', { body: { code: '999999', next: '/' }, address: '10.0.0.3' });
  assert.equal(res.status, 401);
  assert.match(res.text, /Not right/);
  assert.equal(res.cookie, null, 'no cookie on a failed attempt');
});

test('a forged cookie does not open it', async () => {
  for (const forged of [
    `${gate.GATE_COOKIE}=1`,
    `${gate.GATE_COOKIE}=${Date.now() + 99999}.deadbeef`,
    `${gate.GATE_COOKIE}=${Date.now() + 99999}.`,
    `${gate.GATE_COOKIE}=true`,
  ]) {
    const res = await call('GET', '/', { cookie: forged, address: '10.0.0.4' });
    assert.equal(res.status, 401, forged);
  }
});

test('an expired token is refused', () => {
  const past = Date.now() - 1000;
  const token = `${past}.${'0'.repeat(64)}`;
  assert.equal(gate.tokenValid(token), false);
});

test('changing the passcode invalidates tokens already issued', () => {
  const token = gate.issueToken();
  assert.equal(gate.tokenValid(token), true);
  process.env.SITE_PASSCODE = '111111';
  assert.equal(gate.tokenValid(token), false, 'the old cookie must stop working');
  process.env.SITE_PASSCODE = PASSCODE;
  assert.equal(gate.tokenValid(token), true);
});

/* ------------------------------------------------- what a client must reach */

test('client-facing links are never gated', async () => {
  // Real tokens are unguessable, so these 404 — but a 404 proves the request
  // reached the route rather than being stopped at the door, which is the
  // point. A 401 here would mean a prospect is being asked for our passcode.
  for (const path of ['/i/nope', '/dd/nope/return', '/m/nope/', '/api/health']) {
    const res = await call('GET', path, { address: '10.0.0.5' });
    assert.notEqual(res.status, 401, `${path} must not be gated`);
    assert.doesNotMatch(res.text, /Enter your passcode/, path);
  }
});

test('the Gmail OAuth callback is not stopped at the passcode', async () => {
  // Google sends the browser back here after a redirect we do not control.
  // It still needs a signed-in session — that gate is older than this one and
  // is left alone — so what matters is only that the PASSCODE is not what
  // turns it away.
  const res = await call('GET', '/api/gmail/callback?error=access_denied', { address: '10.0.0.6' });
  assert.doesNotMatch(res.text, /Enter your passcode/);
  const body = JSON.parse(res.text);
  assert.notEqual(body.code, 'GATE_LOCKED', 'the passcode must not be the blocker here');
});

/* --------------------------------------------------------------- behaviour */

test('a locked-out API call answers JSON, not a login page', async () => {
  // An open tab polling /api must get something it can parse, or the user sees
  // a JSON parse error instead of "your passcode session ended".
  const res = await call('GET', '/api/leads', { address: '10.0.0.7' });
  assert.equal(res.status, 401);
  const body = JSON.parse(res.text);
  assert.equal(body.code, 'GATE_LOCKED');
});

test('the gate cannot be turned into an open redirect', async () => {
  for (const evil of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
    const res = await call('POST', '/gate',
      { body: { code: PASSCODE, next: evil }, address: '10.0.0.8' });
    assert.equal(res.status, 303);
    assert.equal(res.location, '/', `${evil} must not be followed`);
  }
  // A genuine local path is kept, so a deep link survives the gate.
  const ok = await call('POST', '/gate',
    { body: { code: PASSCODE, next: '/#/leads' }, address: '10.0.0.8' });
  assert.equal(ok.location, '/#/leads');
});

test('guessing is rate limited', async () => {
  gate.resetAttempts();
  const address = '10.0.0.99';

  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const res = await call('POST', '/gate', { body: { code: '000000', next: '/' }, address });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'repeated wrong guesses must eventually be refused outright');

  // And the lockout holds even when the RIGHT code is then offered, or a
  // burst of wrong guesses could be ended by landing on the correct one.
  const right = await call('POST', '/gate', { body: { code: PASSCODE, next: '/' }, address });
  assert.equal(right.status, 429);
  assert.equal(right.cookie, null);

  // A different address is unaffected — one attacker must not lock out the team.
  const other = await call('POST', '/gate', { body: { code: PASSCODE, next: '/' }, address: '10.0.0.100' });
  assert.equal(other.status, 303);

  gate.resetAttempts();
});

test('the rate limiter reads the address Caddy saw, not one the client sent', async () => {
  // Caddy appends the real client to whatever X-Forwarded-For arrived, so the
  // LAST entry is the trustworthy one. Reading the first would let an attacker
  // rotate a fake leading address and never be limited at all.
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }, socket: {} };
  assert.equal(gate.clientAddress(req), '203.0.113.9');
});

/* ------------------------------------------------------------------- off */

test('with no SITE_PASSCODE the gate does nothing at all', async () => {
  const original = process.env.SITE_PASSCODE;
  delete process.env.SITE_PASSCODE;
  try {
    assert.equal(gate.enabled(), false);
    const res = await call('GET', '/', { address: '10.0.0.10' });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Enter your passcode/);
  } finally {
    process.env.SITE_PASSCODE = original;
  }
});
