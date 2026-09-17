/**
 * The shared Websites archive.
 *
 * A finished site's ZIP is uploaded as a raw body with its details in the
 * query string; the whole team can then list and download it. These prove the
 * round trip and the guards: a non-ZIP is refused, and the bytes come back
 * exactly as they went in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { get, base, authHeaders, teardown } = await import('./helpers.js');

// A valid (empty) ZIP: the End-Of-Central-Directory record. Starts "PK", which
// is all the upload guard checks, and it's tiny.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

const upload = (query, body = ZIP) => fetch(`${base}/api/websites?${query}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip', ...authHeaders() },
  body,
});

test('archiving a site stores the ZIP and its details', async () => {
  const res = await upload('business_name=Hillside%20Roofing&domain=hillside.co.uk&host=Netlify');
  assert.equal(res.status, 201);
  const { site } = await res.json();
  assert.equal(site.business_name, 'Hillside Roofing');
  assert.equal(site.domain, 'hillside.co.uk');
  assert.equal(site.host, 'Netlify');
  assert.equal(site.file_size, ZIP.length);
});

test('the archive lists it for the team, with disk used', async () => {
  const { sites, disk_used: disk } = (await get('/api/websites')).body;
  assert.ok(sites.some((s) => s.business_name === 'Hillside Roofing'));
  assert.ok(disk >= ZIP.length);
});

test('download returns the exact bytes as an attachment', async () => {
  const { sites } = (await get('/api/websites')).body;
  const id = sites[0].id;
  const res = await fetch(`${base}/api/websites/${id}/download`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  const back = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(back, ZIP, 'the file comes back byte-for-byte');
});

test('a business name is required', async () => {
  const res = await upload('domain=nowhere.co.uk');
  assert.equal(res.status, 400);
});

test('something that is not a ZIP is refused', async () => {
  const res = await upload('business_name=Bad', Buffer.from('this is not a zip at all'));
  assert.equal(res.status, 400);
});

test('a site can be removed from the archive', async () => {
  const before = (await get('/api/websites')).body.sites;
  const id = before[0].id;
  const res = await fetch(`${base}/api/websites/${id}`, { method: 'DELETE', headers: authHeaders() });
  assert.equal(res.status, 204);
  const after = (await get('/api/websites')).body.sites;
  assert.ok(!after.some((s) => s.id === id));
});

test.after(teardown);
