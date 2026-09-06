import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_MAPS_API_KEY = 'test-key-not-real';

const { get, post, del, teardown } = await import('./helpers.js');

test.after(teardown);

/* ---- A stubbed Places API, so the suite never spends money or needs a key ---- */

const realFetch = globalThis.fetch;
let calls = [];
let nextResponses = [];

function stubPlaces() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('places.googleapis.com')) return realFetch(url, opts);
    calls.push({
      url: u,
      mask: opts.headers?.['X-Goog-FieldMask'],
      key: opts.headers?.['X-Goog-Api-Key'],
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    const next = nextResponses.shift() ?? { status: 200, body: { places: [] } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

const place = (id, name, { website, phone = '01234 567890', address = '1 High St, Leeds' } = {}) => ({
  id,
  displayName: { text: name },
  formattedAddress: address,
  nationalPhoneNumber: phone,
  ...(website ? { websiteUri: website } : {}),  // absent when there is no website
});

/** Poll until the sweep finishes, or fail. */
async function waitForRun(id) {
  for (let i = 0; i < 100; i++) {
    const r = await get(`/api/places/runs/${id}`);
    if (r.body.run.finished_at) return r.body;
    await new Promise((res) => setTimeout(res, 60));
  }
  throw new Error('sweep did not finish');
}

/* ------------------------------------------------------------------ tests */

test('field masks request only what is needed and never photos or reviews', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [place('p1', 'A Co', {})] } }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  assert.equal(start.status, 202);
  await waitForRun(start.body.run.id);

  assert.equal(calls.length, 1);
  const mask = calls[0].mask;
  assert.match(mask, /places\.websiteUri/, 'website is what the whole tool hinges on');
  assert.match(mask, /places\.id/);
  assert.match(mask, /places\.nationalPhoneNumber/);
  assert.doesNotMatch(mask, /photo/i, 'photos are billed and never used');
  assert.doesNotMatch(mask, /review|rating/i, 'atmosphere data is billed and never used');
  assert.equal(calls[0].body.regionCode, 'GB');
  assert.equal(calls[0].key, 'test-key-not-real');
});

test('only places with no website become candidates', async () => {
  stubPlaces();
  nextResponses = [{
    status: 200,
    body: {
      places: [
        place('has-site-1', 'Has Website Ltd', { website: 'https://example.com' }),
        place('no-site-1', 'No Website Roofing', {}),
        place('no-site-2', 'Also No Website', {}),
        place('empty-site', 'Empty String Site', { website: '   ' }),
      ],
    },
  }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Bradford' });
  const data = await waitForRun(start.body.run.id);

  const names = data.candidates.map((c) => c.display_name).sort();
  assert.deepEqual(names, ['Also No Website', 'Empty String Site', 'No Website Roofing']);
  assert.equal(data.run.places_returned, 4);
  assert.equal(data.summary.candidates, 3);
});

test('nothing is imported until it is explicitly asked for', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [place('auto-1', 'Never Auto Imported', {})] } }];
  const start = await post('/api/places/search', { category: 'plumbers', areas: 'Otley' });
  await waitForRun(start.body.run.id);

  const leads = (await get('/api/leads?q=Never Auto Imported')).body.leads;
  assert.equal(leads.length, 0, 'a candidate must never become a lead on its own');
});

test('importing ticked candidates creates leads with the place id and area', async () => {
  stubPlaces();
  nextResponses = [{
    status: 200,
    body: { places: [place('imp-1', 'Import Me Roofing', { phone: '01943 111222', address: '9 Kirkgate, Otley' })] },
  }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Otley' });
  const runId = start.body.run.id;
  await waitForRun(runId);

  const res = await post('/api/places/import', { run_id: runId, place_ids: ['imp-1'] });
  assert.equal(res.status, 201);
  assert.equal(res.body.imported, 1);

  const lead = res.body.leads[0];
  assert.equal(lead.business_name, 'Import Me Roofing');
  assert.equal(lead.google_place_id, 'imp-1');
  assert.equal(lead.category, 'roofers');
  assert.equal(lead.location, 'Otley');
  assert.equal(lead.phone, '01943 111222');
  assert.equal(lead.source, 'Google Places');
  assert.equal(lead.status, 'new');
  assert.match(lead.notes, /9 Kirkgate, Otley/);
});

test('a place already in the tracker is never imported twice', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [place('dupe-1', 'Dupe Co', {})] } }];
  const first = await post('/api/places/search', { category: 'joiners', areas: 'Skipton' });
  await waitForRun(first.body.run.id);
  await post('/api/places/import', { run_id: first.body.run.id, place_ids: ['dupe-1'] });

  // Same place turns up in a later sweep.
  nextResponses = [{ status: 200, body: { places: [place('dupe-1', 'Dupe Co', {})] } }];
  const second = await post('/api/places/search', { category: 'joiners', areas: 'Skipton' });
  const data = await waitForRun(second.body.run.id);

  const dupe = data.candidates.find((c) => c.place_id === 'dupe-1');
  assert.ok(dupe, 'it still shows, so you can see it was already handled');
  assert.equal(dupe.is_lead, true, 'but it is flagged as already in the tracker');

  const again = await post('/api/places/import', { run_id: second.body.run.id, place_ids: ['dupe-1'] });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped[0].reason, 'already a lead');

  const leads = (await get('/api/leads?q=Dupe Co')).body.leads;
  assert.equal(leads.length, 1, 'exactly one lead, no duplicate');
});

test('a place with a website cannot be imported even if asked for', async () => {
  stubPlaces();
  nextResponses = [{
    status: 200,
    body: { places: [place('sited-1', 'Has A Site', { website: 'https://hasasite.example' })] },
  }];
  const start = await post('/api/places/search', { category: 'tilers', areas: 'Ilkley' });
  await waitForRun(start.body.run.id);

  const res = await post('/api/places/import', { run_id: start.body.run.id, place_ids: ['sited-1'] });
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.skipped[0].reason, 'has a website');
});

test('pagination follows nextPageToken and stops at the requested depth', async () => {
  stubPlaces();
  nextResponses = [
    { status: 200, body: { places: [place('pg-1', 'Page One Co', {})], nextPageToken: 'TOKEN-2' } },
    { status: 200, body: { places: [place('pg-2', 'Page Two Co', {})], nextPageToken: 'TOKEN-3' } },
  ];
  const start = await post('/api/places/search', {
    category: 'electricians', areas: 'Keighley', pages_per_area: 2,
  });
  const data = await waitForRun(start.body.run.id);

  assert.equal(calls.length, 2, 'two pages requested, two calls made');
  assert.equal(calls[0].body.pageToken, undefined);
  assert.equal(calls[1].body.pageToken, 'TOKEN-2', 'the token is passed through');
  assert.equal(data.candidates.length, 2);
});

test('a multi-area sweep queries each area separately', async () => {
  stubPlaces();
  nextResponses = [
    { status: 200, body: { places: [place('ml-1', 'Leeds Co', {})] } },
    { status: 200, body: { places: [place('ml-2', 'York Co', {})] } },
    { status: 200, body: { places: [place('ml-3', 'Hull Co', {})] } },
  ];
  const start = await post('/api/places/search', {
    category: 'landscapers', areas: 'Leeds\nYork, Hull',
  });
  const data = await waitForRun(start.body.run.id);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.body.textQuery), [
    'landscapers in Leeds', 'landscapers in York', 'landscapers in Hull',
  ]);
  assert.deepEqual(data.candidates.map((c) => c.area).sort(), ['Hull', 'Leeds', 'York']);
});

test('an API error is recorded on the run rather than lost', async () => {
  stubPlaces();
  nextResponses = [{
    status: 403,
    body: { error: { message: 'Places API (New) has not been used in project 123 before or it is disabled.' } },
  }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  const data = await waitForRun(start.body.run.id);
  assert.match(data.run.error, /API_NOT_ENABLED/);
  assert.match(data.run.error, /not enabled/i);
});

test('search input is validated before any request is made', async () => {
  stubPlaces();
  assert.equal((await post('/api/places/search', { areas: 'Leeds' })).status, 400);
  assert.equal((await post('/api/places/search', { category: 'roofers', areas: '' })).status, 400);
  assert.equal((await post('/api/places/search', { category: 'roofers', areas: '  ,  ,  ' })).status, 400);
  assert.equal(calls.length, 0, 'no billed calls for invalid input');
});

test('the cost estimate counts requests, not places', async () => {
  const e = (await get('/api/places/estimate?areas=Leeds%0ABradford%0AYork&pages_per_area=2')).body;
  assert.equal(e.requests, 6, '3 areas x 2 pages');
  assert.ok(e.approx_usd > 0);
  assert.ok(e.pricing_source.startsWith('https://developers.google.com'));
});

test('duplicate area names in one paste are only searched once', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [] } }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds\nleeds\nLeeds' });
  await waitForRun(start.body.run.id);
  // "leeds" differs in case so it is a separate query; exact repeats are dropped.
  assert.equal(calls.length, 2);
});
