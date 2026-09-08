import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Each test file gets its own throwaway database. DB_PATH is read when
 * server/db.js is first imported, so it must be set before that import.
 */
const dir = mkdtempSync(join(tmpdir(), 'prospect-book-test-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.NODE_ENV = 'test';

const { app } = await import('../server/index.js');

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
export const base = `http://127.0.0.1:${server.address().port}`;

/**
 * The whole API now sits behind a login, so the suite signs in once as an
 * admin and carries the session cookie on every request. This keeps the
 * existing tests meaningful — they exercise the real gate rather than a
 * test-only bypass — and each test file, having its own throwaway database,
 * does its own one-time setup here.
 *
 * A test that wants to probe the unauthenticated side (auth.test.js) uses
 * `raw()` instead, which sends no cookie.
 */
let cookie = null;

export async function raw(method, path, body, { headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Remember any session cookie the server hands back (login/setup/logout).
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const [pair] = setCookie.split(';');
    cookie = pair.includes('=') && !pair.endsWith('=') ? pair : null;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

export const TEST_ADMIN = {
  name: 'Test Admin', email: 'admin@test.example', password: 'test-pass-123',
};

// One admin, created and signed in before any test runs.
await raw('POST', '/api/auth/setup', TEST_ADMIN);

export async function req(method, path, body) {
  return raw(method, path, body, { headers: cookie ? { Cookie: cookie } : {} });
}

/** For tests that build their own fetch() but still need to be signed in. */
export const authHeaders = () => (cookie ? { Cookie: cookie } : {});

export const get   = (p)    => req('GET', p);
export const post  = (p, b) => req('POST', p, b ?? {});
export const patch = (p, b) => req('PATCH', p, b ?? {});
export const put   = (p, b) => req('PUT', p, b ?? {});
export const del   = (p)    => req('DELETE', p);

/**
 * A company number no other fixture is using.
 *
 * Fixtures used to hand every corporate lead the same '01234567', which is a
 * shape reality never takes: a company number identifies exactly one company.
 * Since migration 016 made that a UNIQUE index, a fixture that reuses one is
 * asserting something false and fails at the INSERT.
 */
let companyCounter = 0;
export const nextCompanyNumber = () =>
  String(10_000_000 + (companyCounter += 1)).padStart(8, '0');

export const IDENTITY = {
  biz_contact_name: 'Test Sender',
  biz_name: 'Test Web Studio',
  biz_address: '1 Test Street, Leeds LS1 1AA',
  biz_email: 'sender@test.example',
};

export function teardown() {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
