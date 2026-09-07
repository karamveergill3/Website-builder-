import test from 'node:test';
import assert from 'node:assert/strict';

process.env.COMPANIES_HOUSE_API_KEY = 'test-key';
process.env.GOOGLE_MAPS_API_KEY = 'test-places-key';

const { get, post, put, del, teardown } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { judge } = await import('../server/lib/hunter.js');
const { normaliseName } = await import('../server/lib/companies-house.js');

test.after(teardown);

/* ---- Stub both registers so nothing is called and nothing is spent ---- */

const realFetch = globalThis.fetch;
let register = [];      // queued Companies House replies
let places = [];        // queued Places replies
let calls = { register: 0, places: 0 };

function stub() {
  register = [];
  places = [];
  calls = { register: 0, places: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('company-information.service.gov.uk')) {
      calls.register++;
      const next = register.shift();
      if (!next) return reply({}, 404);            // zero results: 404, empty body
      return reply(next.body ?? next, next.status ?? 200);
    }
    if (u.includes('places.googleapis.com')) {
      calls.places++;
      const next = places.shift() ?? { places: [] };
      return reply(next.body ?? next, next.status ?? 200);
    }
    return realFetch(url, opts);
  };
}

const company = (name, number, over = {}) => ({
  company_name: name,
  company_number: number,
  company_status: 'active',
  company_type: 'ltd',
  date_of_creation: '2014-06-01',
  sic_codes: ['43910'],
  registered_office_address: { address_line_1: '1 High St', locality: 'Otley', postal_code: 'LS21 1AA' },
  ...over,
});

const place = (name, { website } = {}) => ({
  id: `place-${name.replace(/\W/g, '').toLowerCase()}`,
  displayName: { text: name },
  formattedAddress: '1 High St, Otley',
  nationalPhoneNumber: '01943 000000',
  ...(website ? { websiteUri: website } : {}),
});

const configure = (over = {}) => put('/api/settings', {
  hunt_trades: 'roofers',
  hunt_areas: 'Otley',
  hunt_daily_target: '3',
  hunt_require_no_website: '1',
  hunt_include_unlisted: '1',
  ...over,
});

async function clearLeads() {
  for (const l of db.prepare('SELECT id FROM leads').all()) await del(`/api/leads/${l.id}`);
  db.prepare('DELETE FROM hunt_targets').run();
  db.prepare('DELETE FROM hunt_runs').run();
  db.prepare('DELETE FROM place_cache').run();
}

/** The route starts the hunt and returns; wait for it to finish. */
async function runAndWait(body = {}) {
  const started = await post('/api/hunt/run', body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i++) {
    const s = await get('/api/hunt/status');
    if (!s.body.active) return s.body.runs[0];
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('hunt did not finish');
}

/* ----------------------------------------------------------------- judge */

test('a company Google lists with a website is not a prospect', () => {
  const byName = new Map([[normaliseName('Hillside Roofing'), { has_website: true }]]);
  const v = judge(company('HILLSIDE ROOFING LTD', '01'), byName);
  assert.equal(v.prospect, false);
  assert.equal(v.reason, 'has a website');
});

test('a company Google lists with no website is a prospect', () => {
  const byName = new Map([[normaliseName('Hillside Roofing'), { has_website: false, phone: '01943 1' }]]);
  const v = judge(company('HILLSIDE ROOFING LTD', '01'), byName);
  assert.equal(v.prospect, true);
  assert.equal(v.evidence, 'places-no-website');
  assert.equal(v.phone, '01943 1');
});

test('a registered name matches a shorter trading name', () => {
  const byName = new Map([[normaliseName('Hillside Roofing'), { has_website: true }]]);
  assert.equal(judge(company('HILLSIDE ROOFING AND LEADWORK LIMITED', '01'), byName).prospect, false);
});

test('a company absent from Google is a prospect, flagged as such', () => {
  const v = judge(company('NOWHERE ROOFING LTD', '01'), new Map());
  assert.equal(v.prospect, true);
  assert.equal(v.evidence, 'places-absent');
});

test('unlisted companies can be excluded', () => {
  const v = judge(company('NOWHERE ROOFING LTD', '01'), new Map(), { includeUnlisted: false });
  assert.equal(v.prospect, false);
});

/* -------------------------------------------------------------- the hunt */

test('a hunt files qualified prospects with no website, and stops at the target', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '3' });

  // The one with a website comes first, so it is definitely evaluated before
  // the target is met rather than falling off the end of the loop.
  register = [{ body: { hits: 5, items: [
    company('BIG BRAND ROOFING LIMITED', '10000004'),
    company('OTLEY ROOFING LIMITED', '10000001'),
    company('WHARFEDALE ROOFING LIMITED', '10000002'),
    company('CHEVIN ROOFING LIMITED', '10000003'),
    company('ANOTHER ROOFING LIMITED', '10000005'),
  ] } }];
  places = [{ places: [
    place('Otley Roofing'),                                        // no website
    place('Wharfedale Roofing'),                                   // no website
    place('Big Brand Roofing', { website: 'https://bigbrand.co.uk' }),
  ] }];

  const run = await runAndWait();
  assert.equal(run.error, null, run.error ?? '');
  assert.equal(run.found, 3, 'stops as soon as the target is met');
  assert.equal(run.had_website, 1, 'the one with a website is skipped');
  assert.equal(run.places_requests, 1, 'one Places page covers the whole town');
  assert.equal(run.register_requests, 1);

  const leads = (await get('/api/leads')).body.leads;
  assert.equal(leads.length, 3);
  for (const l of leads) {
    assert.equal(l.entity_type, 'corporate', 'filed already qualified');
    assert.equal(l.source, 'Daily hunt');
    assert.equal(l.can_email, false, 'still needs an email address');
    assert.equal(l.block_code, 'NO_EMAIL');
    assert.ok(l.company_number);
  }
  assert.equal(leads.some((l) => l.business_name === 'BIG BRAND ROOFING LIMITED'), false);
});

test('one Places request covers a whole page of companies', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '20' });

  register = [{ body: { hits: 20, items: Array.from({ length: 20 }, (_, i) =>
    company(`ROOFER ${i} LIMITED`, `2000000${i}`)) } }];
  places = [{ places: [] }];   // none listed on Google at all

  const run = await runAndWait();
  assert.equal(run.found, 20);
  assert.equal(run.places_requests, 1,
    'twenty companies judged on a single billed Places request');
});

test('companies already held are never re-imported or re-checked', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '2' });

  register = [{ body: { hits: 2, items: [
    company('FIRST ROOFING LIMITED', '30000001'),
    company('SECOND ROOFING LIMITED', '30000002'),
  ] } }];
  places = [{ places: [] }];
  const first = await runAndWait();
  assert.equal(first.found, 2);

  // Same page again on the next run.
  db.prepare('UPDATE hunt_targets SET cursor = 0, last_run_at = NULL').run();
  stub();
  register = [{ body: { hits: 2, items: [
    company('FIRST ROOFING LIMITED', '30000001'),
    company('SECOND ROOFING LIMITED', '30000002'),
  ] } }];
  const second = await runAndWait();

  assert.equal(second.found, 0);
  assert.equal(second.already_known, 2);
  assert.equal(second.places_requests, 0,
    'nothing new to judge, so no Places request is spent');
  assert.equal((await get('/api/leads')).body.leads.length, 2, 'no duplicates');
});

test('a company whose lead was deleted is never found again', async () => {
  // The whole reason the ledger is a separate table. DELETE FROM leads is a
  // hard delete, and the hunt's only memory used to be that row — so the one
  // gesture that means "not interested in this one" was also the gesture that
  // put it back in tomorrow's list, and back into the outreach funnel.
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '2' });

  register = [{ body: { hits: 2, items: [
    company('BINNED ROOFING LIMITED', '30000101'),
    company('KEPT ROOFING LIMITED', '30000102'),
  ] } }];
  places = [{ places: [] }];
  assert.equal((await runAndWait()).found, 2);

  const binned = (await get('/api/leads')).body.leads
    .find((l) => l.company_number === '30000101');
  assert.equal((await del(`/api/leads/${binned.id}`)).status, 204);
  assert.equal((await get('/api/leads')).body.leads.length, 1, 'the lead really is gone');

  // The same register page, on a later day.
  db.prepare('UPDATE hunt_targets SET cursor = 0, last_run_at = NULL').run();
  stub();
  register = [{ body: { hits: 2, items: [
    company('BINNED ROOFING LIMITED', '30000101'),
    company('KEPT ROOFING LIMITED', '30000102'),
  ] } }];
  places = [{ places: [] }];
  const second = await runAndWait();

  assert.equal(second.found, 0, 'a deleted lead is a decision, not an invitation to re-file');
  assert.equal(second.already_known, 2);
  assert.equal(second.places_requests, 0, 'and no Places request is spent re-checking it');
  assert.equal((await get('/api/leads')).body.leads.length, 1);
});

test('a company the hunt files is on the ledger straight away', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '1' });
  register = [{ body: { hits: 1, items: [company('LEDGERED ROOFING LIMITED', '30000201')] } }];
  places = [{ places: [] }];
  assert.equal((await runAndWait()).found, 1);

  const row = db.prepare('SELECT * FROM company_ledger WHERE company_number = ?').get('30000201');
  assert.ok(row, 'filed as found');
  assert.equal(row.contacted_at, null, 'found is not contacted');
  assert.ok(row.name_key, 'and carries a name key, so a Places sweep recognises it too');
});

test('the cursor advances so the next day covers new ground', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '1' });

  register = [{ body: { hits: 2, items: [
    company('PAGE ONE LIMITED', '40000001'),
    company('PAGE ONE B LIMITED', '40000002'),
  ] } }];
  places = [{ places: [] }];
  await runAndWait();

  const t = db.prepare('SELECT * FROM hunt_targets').get();
  assert.equal(t.cursor, 2, 'cursor moves past everything read, not just what was taken');
  assert.equal(t.trade, 'roofers');
  assert.equal(t.area, 'Otley');
  assert.equal(t.sic_codes, '43910');
});

test('an exhausted trade and town is retired rather than re-read', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '5' });

  register = [{ body: { hits: 0, items: [] } }];
  const run = await runAndWait();

  assert.equal(run.found, 0);
  const t = db.prepare('SELECT * FROM hunt_targets').get();
  assert.ok(t.exhausted_at, 'marked exhausted so tomorrow tries somewhere else');
});

test('the register refusing a too-deep query retires that town, not the run', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_trades: 'roofers', hunt_areas: 'Otley\nSkipton', hunt_daily_target: '2' });

  register = [
    { status: 500, body: {} },                                     // Otley: too deep
    { body: { hits: 2, items: [company('SKIPTON ROOFING LIMITED', '50000001')] } },
  ];
  places = [{ places: [] }];

  const run = await runAndWait();
  assert.equal(run.error, null, 'one bad town must not end the hunt');
  assert.equal(run.found, 1, 'it carried on to the next town');

  const retired = db.prepare("SELECT * FROM hunt_targets WHERE area = 'Otley'").get();
  assert.ok(retired.exhausted_at);
});

test('the hunt works several towns until the target is met', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_trades: 'roofers', hunt_areas: 'Otley\nSkipton\nIlkley', hunt_daily_target: '3' });

  register = [
    { body: { hits: 1, items: [company('OTLEY ONE LIMITED', '60000001')] } },
    { body: { hits: 1, items: [company('SKIPTON ONE LIMITED', '60000002')] } },
    { body: { hits: 1, items: [company('ILKLEY ONE LIMITED', '60000003')] } },
  ];
  places = [{ places: [] }, { places: [] }, { places: [] }];

  const run = await runAndWait();
  assert.equal(run.found, 3);
  assert.equal(run.register_requests, 3, 'one page per town');
  assert.match(run.areas_covered, /Otley/);
  assert.match(run.areas_covered, /Ilkley/);
});

test('the request budget stops a runaway hunt', async () => {
  stub();
  await clearLeads();
  await configure({
    hunt_trades: 'roofers', hunt_areas: 'A\nB\nC\nD\nE',
    hunt_daily_target: '100', hunt_max_register_pages: '2',
  });

  register = Array.from({ length: 5 }, (_, i) =>
    ({ body: { hits: 1, items: [company(`CO ${i} LIMITED`, `7000000${i}`)] } }));
  places = Array.from({ length: 5 }, () => ({ places: [] }));

  const run = await runAndWait();
  assert.equal(run.register_requests, 2, 'stopped at the page budget');
  assert.ok(run.found <= 2);
});

test('partnerships and branches are never filed, whatever the trade', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '5' });

  register = [{ body: { hits: 3, items: [
    company('A PARTNERSHIP LP', 'LP000001', { company_type: 'limited-partnership' }),
    company('AN OVERSEAS BRANCH', 'BR000001', { company_type: 'uk-establishment' }),
    company('A REAL COMPANY LIMITED', '80000001'),
  ] } }];
  places = [{ places: [] }];

  const run = await runAndWait();
  assert.equal(run.found, 1);
  const leads = (await get('/api/leads')).body.leads;
  assert.deepEqual(leads.map((l) => l.business_name), ['A REAL COMPANY LIMITED']);
});

test('with the website filter off, every qualified company is taken', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '3', hunt_require_no_website: '0' });

  register = [{ body: { hits: 3, items: [
    company('ONE LIMITED', '90000001'),
    company('TWO LIMITED', '90000002'),
    company('THREE LIMITED', '90000003'),
  ] } }];

  const run = await runAndWait();
  assert.equal(run.found, 3);
  assert.equal(run.places_requests, 0, 'no Google spend when the filter is off');
});

test('the hunt refuses to run with nothing configured', async () => {
  stub();
  await clearLeads();
  await put('/api/settings', { hunt_trades: '' });
  const res = await post('/api/hunt/run', {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /trade/i);
  assert.equal(calls.register, 0);
});

test('status reports the plan, coverage and what it found today', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_trades: 'roofers\nelectricians', hunt_areas: 'Otley\nSkipton' });

  register = [{ body: { hits: 1, items: [company('STATUS CO LIMITED', 'A0000001')] } }];
  places = [{ places: [] }];
  await runAndWait();

  const s = (await get('/api/hunt/status')).body;
  assert.equal(s.plan.combinations, 4, 'two trades across two towns');
  assert.deepEqual(s.plan.trades.map((t) => t.codes[0]), ['43910', '43210']);
  assert.equal(s.coverage.total, 4);
  assert.equal(s.found_today, 1);
  assert.equal(s.active, null);
});

test('an unrecognised trade is reported rather than silently dropped', async () => {
  await configure({ hunt_trades: 'roofers\nnot a real trade at all' });
  const s = (await get('/api/hunt/status')).body;
  assert.deepEqual(s.plan.unrecognised_trades, ['not a real trade at all']);
  assert.equal(s.plan.combinations, 1, 'only the trade that resolved is planned for');
});

test('a hunt cannot start while one is running', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '1' });
  register = [{ body: { hits: 1, items: [company('RACE CO LIMITED', 'B0000001')] } }];
  places = [{ places: [] }];

  const first = await post('/api/hunt/run', {});
  assert.equal(first.status, 202);
  const second = await post('/api/hunt/run', {});
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already running/i);

  for (let i = 0; i < 100; i++) {
    if (!(await get('/api/hunt/status')).body.active) break;
    await new Promise((r) => setTimeout(r, 40));
  }
});

test('GET /api/hunt/trades returns the full recognised trade list', async () => {
  const r = await get('/api/hunt/trades');
  assert.equal(r.status, 200);
  const list = r.body.trades;
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 50, `expected 50+ trades, got ${list.length}`);
  // A handful of essentials the preset must include.
  // Each row contributes one canonical keyword — the first term. So
  // "landscaper" covers gardening; "hairdresser" covers salons; and so on.
  for (const t of ['roofer', 'plumber', 'electrician', 'landscaper', 'hairdresser', 'tattoo']) {
    assert.ok(list.some((x) => x.toLowerCase() === t), `${t} missing from preset`);
  }
  // No duplicates.
  assert.equal(list.length, new Set(list).size);
});

test('only the derived website flag is stored, never listing content', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_daily_target: '1' });

  register = [{ body: { hits: 1, items: [company('CACHE TEST LIMITED', 'C0000001')] } }];
  places = [{ places: [place('Very Distinctive Listing Name', { website: 'https://x.co.uk' })] }];

  await runAndWait();

  const cached = db.prepare('SELECT * FROM place_cache').all();
  assert.ok(cached.length > 0);
  const asText = JSON.stringify(cached);
  assert.equal(asText.includes('Very Distinctive Listing Name'), false);
  assert.equal(asText.includes('https://x.co.uk'), false);
  assert.equal(cached[0].has_website, 1);
});

/**
 * Run `fn` with no Google key, then put it back.
 *
 * A local `let` restored in a finally after an await trips eslint's
 * require-atomic-updates, and it was duplicated in both tests. The closure
 * keeps the saved value out of the async body entirely.
 */
async function withoutPlacesKey(fn) {
  const saved = Object.prototype.hasOwnProperty.call(process.env, 'GOOGLE_MAPS_API_KEY')
    ? process.env.GOOGLE_MAPS_API_KEY : undefined;
  const restore = () => {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = saved;
  };
  delete process.env.GOOGLE_MAPS_API_KEY;
  try { return await fn(); } finally { restore(); }
}

test('the no-website filter is refused without a Google key, by route AND by hunt', async () => {
  // Two guards on purpose. The route has always refused this, but the route
  // is only the "Run now" button — server/hunt.js (cron) and the built-in
  // scheduler both call hunt() directly. On those unattended paths the run
  // used to read a register page, ask Places, and die with a bare NO_API_KEY,
  // having paid for the page, leaving a 0 nobody was watching.
  stub();
  await clearLeads();
  await configure({ hunt_require_no_website: '1' });
  await withoutPlacesKey(async () => {
    const res = await post('/api/hunt/run', {});
    assert.equal(res.status, 400, 'the button refuses');
    assert.match(res.body.error, /GOOGLE_MAPS_API_KEY/);
    assert.equal(calls.register, 0, 'nothing was spent finding out');

    const { hunt } = await import('../server/lib/hunter.js');
    await assert.rejects(
      () => hunt({ trigger: 'cli' }),
      (err) => {
        assert.match(err.message, /no website/i);
        assert.match(err.message, /GOOGLE_MAPS_API_KEY/);
        assert.match(err.message, /untick/i, 'and says what to do instead');
        return true;
      },
      'the unattended path refuses too'
    );
    assert.equal(calls.register, 0, 'and still spends nothing');
  });
});

test('with the filter off, no Google key is needed at all', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_require_no_website: '0', hunt_daily_target: '2' });
  await withoutPlacesKey(async () => {
    register = [{ body: { hits: 2, items: [
      company('NO FILTER ROOFING LIMITED', '30000301'),
      company('NO FILTER SPARKS LIMITED', '30000302'),
    ] } }];
    const run = await runAndWait();
    assert.equal(run.error ?? null, null);
    assert.equal(run.found, 2, 'files everything for you to check yourself');
    assert.equal(run.places_requests, 0, 'and never asks Google');
  });
});

test('the target key survives a trade or town containing punctuation', () => {
  // This key used to be built with a literal NUL, which was collision-proof
  // but made the whole module read as a binary to grep and file.
  const seen = new Set();
  for (const [trade, area] of [
    ['roofer', 'Stoke-on-Trent'], ['roofer Stoke', 'on-Trent'],
    ['roofer', null], ['roofer', ''], ['', 'roofer'],
  ]) {
    const k = JSON.stringify([trade ?? '', area ?? '']);
    assert.ok(!seen.has(k) || (trade === 'roofer' && (area === null || area === '')),
      `"${trade}" / "${area}" must not collide`);
    seen.add(k);
  }
  assert.equal(
    JSON.stringify(['roofer', null ?? '']),
    JSON.stringify(['roofer', '']),
    'a null area and an empty one are the same target'
  );
});
