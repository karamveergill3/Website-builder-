import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_MAPS_API_KEY = 'test-key-not-real';

const { get, post, patch, teardown } = await import('./helpers.js');

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

/** Google's real error envelope: the machine-readable reason is an ErrorInfo. */
const googleError = (code, status, message, reason) => ({
  status: code,
  body: {
    error: {
      code, status, message,
      ...(reason ? {
        details: [
          { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message },
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason, domain: 'googleapis.com', metadata: { service: 'places.googleapis.com' } },
        ],
      } : {}),
    },
  },
});

test('an API error is recorded on the run rather than lost', async () => {
  stubPlaces();
  nextResponses = [googleError(403, 'PERMISSION_DENIED',
    'Places API (New) has not been used in project 123 before or it is disabled.',
    'SERVICE_DISABLED')];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  const data = await waitForRun(start.body.run.id);
  assert.match(data.run.error, /API_NOT_ENABLED/);
  assert.match(data.run.error, /not enabled/i);
});

test('each Google error reason maps to advice you can act on', async () => {
  const cases = [
    [googleError(400, 'INVALID_ARGUMENT', 'API key not valid.', 'API_KEY_INVALID'),
     /KEY_INVALID/],
    [googleError(403, 'PERMISSION_DENIED', 'Billing is disabled.', 'BILLING_DISABLED'),
     /BILLING_DISABLED.*billing/is],
    [googleError(403, 'PERMISSION_DENIED', 'Blocked.', 'API_KEY_SERVICE_BLOCKED'),
     /API restrictions/i],
    [googleError(403, 'PERMISSION_DENIED', 'Referer blocked.', 'API_KEY_HTTP_REFERRER_BLOCKED'),
     /referrer restriction/i],
    // A 403 with no ErrorInfo at all is specifically "no key was sent".
    [{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED',
        message: "Method doesn't allow unregistered callers" } } },
     /NO_API_KEY/],
  ];

  for (const [response, expected] of cases) {
    stubPlaces();
    nextResponses = [response];
    const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
    const data = await waitForRun(start.body.run.id);
    assert.match(data.run.error, expected);
  }
});

test('a rate limit is retried, an exhausted quota is not', async () => {
  stubPlaces();
  // Three 429s in a row: the client retries twice, then gives up.
  nextResponses = [
    googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'RATE_LIMIT_EXCEEDED'),
    googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'RATE_LIMIT_EXCEEDED'),
    googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'RATE_LIMIT_EXCEEDED'),
  ];
  let start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  let data = await waitForRun(start.body.run.id);
  assert.match(data.run.error, /RATE_LIMITED/);
  assert.equal(calls.length, 3, 'retried with backoff');

  stubPlaces();
  nextResponses = [googleError(429, 'RESOURCE_EXHAUSTED', 'Allocation spent.', 'RESOURCE_QUOTA_EXCEEDED')];
  start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  data = await waitForRun(start.body.run.id);
  assert.match(data.run.error, /QUOTA_EXHAUSTED/);
  assert.equal(calls.length, 1, 'backing off cannot refill an exhausted allocation');
});

test('a category is required; a location is not', async () => {
  stubPlaces();
  assert.equal((await post('/api/places/search', { areas: 'Leeds' })).status, 400,
    'a category is the one thing you must give');
  assert.equal((await post('/api/places/search', { category: '   ' })).status, 400);
  assert.equal(calls.length, 0, 'no billed calls for invalid input');
});

test('with no location, the category is searched on its own', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [place('noloc-1', 'Nationwide Co', {})] } }];
  const start = await post('/api/places/search', { category: 'thatchers' });
  assert.equal(start.status, 202);
  const data = await waitForRun(start.body.run.id);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.textQuery, 'thatchers', 'no " in <area>" suffix');
  assert.equal(calls[0].body.regionCode, 'GB', 'still constrained to the UK');
  assert.deepEqual(data.areas, []);
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].area, null);
});

test('a whitespace-only area list behaves as no location', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [] } }];
  const start = await post('/api/places/search', { category: 'roofers', areas: '  ,  ,  ' });
  assert.equal(start.status, 202);
  await waitForRun(start.body.run.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.textQuery, 'roofers');
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

/* ------- Google Maps Platform terms: what may and may not be persisted ------ */

test('listing content is never written to the database — only the place ID', async () => {
  stubPlaces();
  nextResponses = [{
    status: 200,
    body: { places: [place('tos-1', 'Very Distinctive Name Ltd', {
      phone: '01111 222333', address: '99 Unmistakable Road, Leeds',
    })] },
  }];
  const start = await post('/api/places/search', { category: 'roofers', areas: 'Leeds' });
  await waitForRun(start.body.run.id);

  const { db } = await import('../server/db.js');

  // The cache keeps the ID and the derived flag, and nothing from the listing.
  const columns = db.prepare('PRAGMA table_info(place_cache)').all().map((c) => c.name);
  for (const forbidden of ['display_name', 'address', 'phone', 'website_uri']) {
    assert.equal(columns.includes(forbidden), false,
      `place_cache must not have a ${forbidden} column`);
  }

  const row = db.prepare('SELECT * FROM place_cache WHERE place_id = ?').get('tos-1');
  assert.equal(row.has_website, 0);
  assert.equal(JSON.stringify(row).includes('Very Distinctive Name'), false);
  assert.equal(JSON.stringify(row).includes('Unmistakable Road'), false);
  assert.equal(JSON.stringify(row).includes('01111 222333'), false);

  // But the review list can still show it, from the in-memory session.
  const data = await get(`/api/places/runs/${start.body.run.id}`);
  assert.equal(data.body.content_available, true);
  assert.equal(data.body.candidates[0].display_name, 'Very Distinctive Name Ltd');
  assert.equal(data.body.candidates[0].phone, '01111 222333');
});

test('the status endpoint states plainly that listing content is not stored', async () => {
  const s = (await get('/api/places/status')).body;
  assert.equal(s.stores_listing_content, false);
});

test('an imported lead is tagged as Places-derived so retention can find it', async () => {
  stubPlaces();
  nextResponses = [{ status: 200, body: { places: [place('tag-1', 'Tagged Co', {})] } }];
  const start = await post('/api/places/search', { category: 'joiners', areas: 'Otley' });
  await waitForRun(start.body.run.id);
  const res = await post('/api/places/import', { run_id: start.body.run.id, place_ids: ['tag-1'] });

  const { db } = await import('../server/db.js');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(res.body.leads[0].id);
  assert.equal(lead.details_source, 'google_places');
  assert.ok(lead.details_imported_at);
});

test('imported leads are never auto-classified, whatever the name says', async () => {
  stubPlaces();
  nextResponses = [{
    status: 200,
    body: { places: [place('ltd-1', 'Definitely A Company Ltd', {})] },
  }];
  const start = await post('/api/places/search', { category: 'tilers', areas: 'Ilkley' });
  await waitForRun(start.body.run.id);
  const res = await post('/api/places/import', { run_id: start.body.run.id, place_ids: ['ltd-1'] });

  const lead = res.body.leads[0];
  assert.equal(lead.entity_type, 'unknown',
    'a trading name ending in Ltd is a hint, never evidence of incorporation');

  // Places never returns an email address, so that is the first thing missing.
  let full = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(full.can_email, false);
  assert.equal(full.block_code, 'NO_EMAIL');

  // Once an address is found by hand, the classification gate is what remains.
  await patch(`/api/leads/${lead.id}`, { email: 'info@definitelyacompany.co.uk' });
  full = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(full.can_email, false);
  assert.equal(full.block_code, 'UNCLASSIFIED');
  assert.equal(full.looks_corporate, true, 'the UI may still suggest checking Companies House');

  // And it cannot be cleared by asserting it — evidence is required.
  const noEvidence = await patch(`/api/leads/${lead.id}`, { entity_type: 'corporate' });
  assert.equal(noEvidence.status, 400);
  assert.match(noEvidence.body.error, /company number/i);

  const withEvidence = await patch(`/api/leads/${lead.id}`, {
    entity_type: 'corporate', company_number: '01234567',
  });
  assert.equal(withEvidence.status, 200);
  assert.equal(withEvidence.body.lead.can_email, true);
});
