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

export async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

export const get   = (p)    => req('GET', p);
export const post  = (p, b) => req('POST', p, b ?? {});
export const patch = (p, b) => req('PATCH', p, b ?? {});
export const put   = (p, b) => req('PUT', p, b ?? {});
export const del   = (p)    => req('DELETE', p);

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
