/**
 * Checking the leads already on file for a website Google doesn't show.
 *
 * Leads filed before the hunt learned to look on the web were judged on
 * Google's listing alone. This sweep runs the same check over them and marks
 * the ones with a site of their own, so they stop being pitched a website
 * they already have. Nothing reaches the real internet: the web is a map of
 * pages, and every other address fails like an unregistered domain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SITE_SEARCH_GAP_MS = '0';

const { get, post, teardown, nextCompanyNumber } = await import('./helpers.js');

test.after(teardown);

const realFetch = globalThis.fetch;
let sites = {};
let asked = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opts);
  asked.push(u);
  // Some businesses' addresses take a while to fail, so a check is still
  // running when the next request arrives.
  if (u.includes('slow-check') || u.includes('slowcheck')) await new Promise((r) => setTimeout(r, 150));
  if (Object.hasOwn(sites, u)) {
    return new Response(sites[u], { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ENOTFOUND' };
  throw err;
};

async function lead(over) {
  const r = await post('/api/leads', {
    category: 'haulage', entity_type: 'corporate', company_number: nextCompanyNumber(), ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}

async function finish() {
  for (let i = 0; i < 200; i++) {
    const { run } = (await get('/api/leads/site-check/status')).body;
    if (run && !run.running) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('site check did not finish');
}

test('Coseley Services is found to have a website, and marked so', async () => {
  const coseley = await lead({
    business_name: 'COSELEY SERVICES LIMITED', location: 'Wolverhampton', phone: '07732 170498',
    notes: 'Address: Unit F3, Hilton Trading Estate, Lanesfield, Wolverhampton WV4 6DW',
  });
  const without = await lead({ business_name: 'Nosite Haulage Ltd', location: 'Wolverhampton', phone: '07700 930001' });
  sites = {
    'https://coseleyservices.co.uk/': `<title>Home | Coseley Services Ltd</title>
      <p>Coseley Services: road haulage. Call 07732 170498. Wolverhampton WV4 6DW</p>`,
  };

  const start = await post('/api/leads/site-check', { lead_ids: [coseley.id, without.id] });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const run = await finish();
  assert.equal(run.with_site, 1);
  assert.equal(run.without, 1);
  assert.deepEqual(run.found.map((f) => f.url), ['https://coseleyservices.co.uk/']);

  const c = (await get(`/api/leads/${coseley.id}`)).body.lead;
  assert.equal(c.has_website, 1);
  assert.equal(c.website, 'https://coseleyservices.co.uk/');
  assert.equal(c.website_evidence, 'site-check:name-domain');
  const signals = (await get(`/api/leads/${coseley.id}/signals`)).body.signals;
  assert.ok(signals.some((s) => s.kind === 'website' && s.value === 'https://coseleyservices.co.uk/'),
    'the site is filed as a signal too, so Find contacts can read it');

  const n = (await get(`/api/leads/${without.id}`)).body.lead;
  assert.equal(n.has_website, 0);
  assert.match(n.website_evidence, /web/, 'the lead records that the web was looked at');
});

test('a lead already known to have a site is not checked again', async () => {
  const known = (await get('/api/leads')).body.leads.find((l) => l.has_website === 1);
  const res = await post('/api/leads/site-check', { lead_ids: [known.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.started, false);
});

test('only one check runs at a time, and it can be stopped', async () => {
  const many = [];
  for (let i = 0; i < 3; i++) many.push((await lead({ business_name: `Slow Check ${i} Ltd`, location: 'Leeds' })).id);
  const first = await post('/api/leads/site-check', { lead_ids: many });
  assert.equal(first.status, 202);
  const second = await post('/api/leads/site-check', { lead_ids: many });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already running/);
  await post('/api/leads/site-check/stop', {});
  const run = await finish();
  assert.equal(run.running, false);
});

test('the status path is not mistaken for a lead id', async () => {
  const r = await get('/api/leads/site-check/status');
  assert.equal(r.status, 200);
  assert.ok('run' in r.body);
});

test('only the business’s own guessed addresses and a web search are ever fetched', () => {
  for (const u of asked) {
    assert.match(u,
      /^https?:\/\/(www\.)?((coseley-?services|nosite-?haulage|slow-?check-?\d)\.(co\.uk|com|uk)\/|html\.duckduckgo\.com\/)/,
      `unexpected request ${u}`);
  }
});
