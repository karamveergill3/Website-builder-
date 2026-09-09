import test from 'node:test';
import assert from 'node:assert/strict';

process.env.COMPANIES_HOUSE_API_KEY = 'test-key';
process.env.GOOGLE_MAPS_API_KEY = 'test-places-key';

const { get, post, patch, put, del, teardown } = await import('./helpers.js');
const { db } = await import('../server/db.js');
const { judge, spreadByTrade, sameTown, huntConfig, isMobileNumber } = await import('../server/lib/hunter.js');
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
      const body = next.body ?? next;
      // The register returns companies whose ADDRESS matched the location
      // filter, so anything it hands back is in that town unless the address
      // merely mentions it. Fill the locality from the query the way the real
      // thing would; a fixture that sets its own is testing the mismatch and
      // is left alone.
      const asked = new URL(u).searchParams.get('location');
      if (asked && Array.isArray(body.items)) {
        for (const item of body.items) {
          const addr = item.registered_office_address;
          if (addr && !addr.locality) addr.locality = asked;
        }
      }
      return reply(body, next.status ?? 200);
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
  // No locality by default: the stub fills it from the town being searched,
  // which is what the register does. A test that needs a mismatch sets one.
  registered_office_address: { address_line_1: '1 High St', postal_code: 'LS21 1AA' },
  ...over,
});

const place = (name, { website, phone = '01943 000000' } = {}) => ({
  id: `place-${name.replace(/\W/g, '').toLowerCase()}`,
  displayName: { text: name },
  formattedAddress: '1 High St, Otley',
  ...(phone ? { nationalPhoneNumber: phone } : {}),
  ...(website ? { websiteUri: website } : {}),
});

/**
 * Settings persist across tests in this file, so every hunt setting a test
 * depends on is restated here rather than inherited. A budget left at 2 by an
 * earlier test is invisible from inside a later one and looks exactly like a
 * bug in the loop under test.
 */
const configure = (over = {}) => put('/api/settings', {
  hunt_trades: 'roofers',
  hunt_areas: 'Otley',
  hunt_daily_target: '3',
  hunt_require_no_website: '1',
  hunt_include_unlisted: '1',
  hunt_max_register_pages: '80',
  hunt_max_places_requests: '80',
  hunt_max_per_trade: '3',
  hunt_require_phone: '0',
  hunt_require_mobile: '0',
  // These tests exercise the Companies House path; the Google-direct source
  // has its own tests. Off here so the register behaviour is what's measured.
  hunt_include_places: '0',
  // Off here so each individual filter is what's under test. "Messageable
  // only" (default on in production) would override the three require_* flags
  // and disable the Google-direct source; it has its own tests below.
  hunt_messageable_only: '0',
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

test('the Google-direct source files no-website Google businesses, with a phone', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_include_places: '1', hunt_daily_target: '5', hunt_require_no_website: '1' });

  // The register returns one company so the trade/town target is processed;
  // the point is the Google listings — two with no website (kept, with their
  // phone) and one with a website (skipped).
  register = [{ body: { hits: 1, items: [company('SOME ROOFING LIMITED', '10000010')] } }];
  places = [{ places: [
    place('Otley Roofing', { phone: '07700 900001' }),                 // no website, mobile
    place('Chevin Roofing', { phone: '01943 555123' }),                // no website, landline
    place('Big Brand Roofing', { website: 'https://bigbrand.co.uk' }), // has a website -> skipped
  ] }];

  await runAndWait();
  const leads = (await get('/api/leads')).body.leads;
  const google = leads.filter((l) => l.source === 'Daily hunt (Google)');
  assert.deepEqual(google.map((l) => l.business_name).sort(), ['Chevin Roofing', 'Otley Roofing']);
  for (const l of google) {
    assert.ok(l.phone, `${l.business_name} arrived with a phone`);
    assert.ok(l.google_place_id, 'and a Google place id, so it dedupes');
    assert.equal(l.has_website, 0);
  }
});

test('the Google-direct source is off when the box is unticked', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_include_places: '0', hunt_daily_target: '5' });
  register = [{ body: { hits: 1, items: [company('SOME ROOFING LIMITED', '10000011')] } }];
  places = [{ places: [place('Some Other Roofing', { phone: '07700 900002' })] }];

  await runAndWait();
  const leads = (await get('/api/leads')).body.leads;
  assert.equal(leads.filter((l) => l.source === 'Daily hunt (Google)').length, 0);
});

test('messageable-only files corporates with a mobile, and nothing you cannot message', async () => {
  stub();
  await clearLeads();
  // The production default. It overrides the individual require_* flags and
  // turns the Google-direct source off, whatever those are set to.
  await configure({
    hunt_messageable_only: '1', hunt_include_places: '1', hunt_daily_target: '5',
    hunt_require_mobile: '0', hunt_require_no_website: '0',
  });

  register = [{ body: { hits: 3, items: [
    company('OTLEY ROOFING LIMITED', '70000001'),      // Google: no website + mobile -> filed
    company('CHEVIN ROOFING LIMITED', '70000002'),     // Google: no website + landline -> skipped
    company('WHARFEDALE ROOFING LIMITED', '70000003'), // not on Google -> no number -> skipped
  ] } }];
  places = [{ places: [
    place('Otley Roofing', { phone: '07700 900123' }),   // mobile, no website
    place('Chevin Roofing', { phone: '01943 555123' }),  // landline, no website
    place('Wolverhampton Cafe', { phone: '07700 111222' }), // unrelated Google listing
  ] }];

  const run = await runAndWait();
  assert.equal(run.error, null, run.error ?? '');

  const leads = (await get('/api/leads')).body.leads;
  // Only the confirmed limited company that has a mobile is filed.
  assert.deepEqual(leads.map((l) => l.business_name), ['OTLEY ROOFING LIMITED']);
  assert.equal(leads[0].entity_type, 'corporate', 'a confirmed limited company');
  assert.equal(leads[0].source, 'Daily hunt');
  assert.ok(isMobileNumber(leads[0].phone), 'with a mobile you can WhatsApp');
  // The unrelated Google business is NOT filed as an unconfirmed lead.
  assert.equal(leads.filter((l) => l.source === 'Daily hunt (Google)').length, 0,
    'the Google-direct source is off — it can only produce unconfirmed leads');
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
        assert.match(err.message, /turn those options off/i, 'and says what to do instead');
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

/* --------------------------------------------------------- trade variety */

test('targets are dealt one trade at a time, not all of one trade first', () => {
  // syncTargets builds them trade-major — every town for roofers, then every
  // town for electricians — so straight id order puts 44 roofing targets
  // before the first electrician, and a 20-lead day is 20 roofers.
  const rows = [];
  for (const trade of ['roofer', 'electrician', 'plumber']) {
    for (const area of ['Stafford', 'Walsall', 'Cannock']) {
      rows.push({ trade, area, last_run_at: null });
    }
  }
  const spread = spreadByTrade(rows);
  assert.equal(spread.length, rows.length, 'nothing is lost');
  assert.deepEqual(
    spread.slice(0, 3).map((t) => t.trade),
    ['roofer', 'electrician', 'plumber'],
    'the first three targets are three different trades'
  );
  // Order within a trade is preserved, so the least-recently-run ordering
  // the query established still holds inside each group.
  assert.deepEqual(
    spread.filter((t) => t.trade === 'roofer').map((t) => t.area),
    ['Stafford', 'Walsall', 'Cannock']
  );
});

test('the trade that has waited longest is dealt first', () => {
  // Round-robin alone is not fair over time: the target is met by the first
  // few trades, and if the order never changes those are the only trades ever
  // contacted. Yesterday's trades go to the back.
  const spread = spreadByTrade([
    { trade: 'roofer', area: 'A', last_run_at: '2026-09-06T10:00:00.000Z' },
    { trade: 'hairdresser', area: 'A', last_run_at: null },
    { trade: 'garage', area: 'A', last_run_at: '2026-09-01T10:00:00.000Z' },
  ]);
  assert.deepEqual(spread.map((t) => t.trade), ['hairdresser', 'garage', 'roofer'],
    'never run, then longest ago, then most recent');
});

test('each trade starts at a different town', () => {
  // Taking index 0 from every trade's queue looks like a spread and is not:
  // index 0 of every queue is the SAME town, because within a trade the towns
  // are in list order. The first real run filed twenty leads across seven
  // trades and every single one in Stoke-on-Trent.
  const TOWNS = ['Stoke-on-Trent', 'Tamworth', 'Stafford', 'Lichfield'];
  const rows = [];
  for (const trade of ['roofer', 'electrician', 'plumber', 'plasterer']) {
    for (const area of TOWNS) rows.push({ trade, area, last_run_at: null });
  }

  const spread = spreadByTrade(rows);
  assert.equal(spread.length, rows.length, 'nothing is lost or repeated');

  // The opening round — one target per trade — must not be one town.
  const firstRound = spread.slice(0, 4);
  assert.equal(new Set(firstRound.map((t) => t.trade)).size, 4, 'four trades');
  assert.equal(new Set(firstRound.map((t) => t.area)).size, 4,
    `four towns, got ${JSON.stringify(firstRound.map((t) => t.area))}`);

  // And every trade/town pair is still dealt exactly once.
  const keys = spread.map((t) => `${t.trade}|${t.area}`);
  assert.equal(new Set(keys).size, rows.length, 'no target dealt twice');
});

test('the town spread survives uneven town lists', () => {
  // A trade whose towns have mostly been worked has a shorter queue. The
  // offset is taken modulo that length, so it still lands on a real target.
  const rows = [
    { trade: 'roofer', area: 'A', last_run_at: null },
    { trade: 'roofer', area: 'B', last_run_at: null },
    { trade: 'roofer', area: 'C', last_run_at: null },
    { trade: 'electrician', area: 'A', last_run_at: null },
    { trade: 'plumber', area: 'A', last_run_at: null },
    { trade: 'plumber', area: 'B', last_run_at: null },
  ];
  const spread = spreadByTrade(rows);
  assert.equal(spread.length, rows.length);
  const keys = spread.map((t) => `${t.trade}|${t.area}`);
  assert.equal(new Set(keys).size, rows.length, 'every target exactly once');
  for (const t of spread) assert.ok(t.area, 'no undefined slot');
});

test('spreadByTrade copes with one trade and with nothing', () => {
  assert.deepEqual(spreadByTrade([]), []);
  const one = [{ trade: 'roofer', area: 'A', last_run_at: null },
               { trade: 'roofer', area: 'B', last_run_at: null }];
  assert.deepEqual(spreadByTrade(one).map((t) => t.area), ['A', 'B']);
});

test('no single trade fills the day', async () => {
  // One register page is 100 companies, so without a cap the first target
  // supplies the whole target on its own however well the list is ordered.
  stub();
  await clearLeads();
  await configure({
    hunt_trades: 'roofer\nelectrician\nplumber\nplasterer',
    hunt_areas: 'Stafford',
    hunt_daily_target: '8',
    hunt_max_per_trade: '2',
    hunt_require_no_website: '0',
  });

  let n = 0;
  const page = () => ({ body: { hits: 100, items: Array.from({ length: 100 }, () => {
    n += 1;
    return company(`MIXED ${n} LIMITED`, String(40000000 + n));
  }) } });
  register = [page(), page(), page(), page(), page(), page()];

  const run = await runAndWait();
  assert.equal(run.found, 8);

  const leads = (await get('/api/leads')).body.leads;
  const perTrade = {};
  for (const l of leads) perTrade[l.category] = (perTrade[l.category] ?? 0) + 1;
  for (const [trade, count] of Object.entries(perTrade)) {
    assert.ok(count <= 2, `${trade} contributed ${count}, over the cap of 2`);
  }
  assert.ok(Object.keys(perTrade).length >= 4,
    `wanted a mix, got ${JSON.stringify(perTrade)}`);
});

test('the cap lifts rather than starving a short trade list', async () => {
  // Two trades and a cap of 3 would stop at 6 of a target of 10. The point of
  // the cap is a mix, not a smaller day.
  stub();
  await clearLeads();
  await configure({
    hunt_trades: 'roofer\nelectrician',
    hunt_areas: 'Stafford',
    hunt_daily_target: '10',
    hunt_max_per_trade: '3',
    hunt_require_no_website: '0',
  });
  let n = 0;
  register = Array.from({ length: 4 }, () => ({ body: { hits: 100,
    items: Array.from({ length: 100 }, () => {
      n += 1;
      return company(`SHORT ${n} LIMITED`, String(50000000 + n));
    }) } }));

  const run = await runAndWait();
  assert.equal(run.found, 10, 'the target is still met');
});

/* ------------------------------------------------------- contactability */

/*
 * Company numbers must be unique across this whole file, not just within a
 * test. clearLeads() empties the leads table but deliberately NOT
 * company_ledger — that table exists to outlive a deleted lead — so a number
 * an earlier test filed is rejected as already-seen, and the run under test
 * quietly finds nothing.
 */

test('require-phone files only companies Google holds a number for', async () => {
  // The whole point: a lead with no phone and no email cannot be contacted by
  // any means this tool offers.
  stub();
  await clearLeads();
  await configure({
    hunt_daily_target: '10',
    hunt_require_phone: '1',
    hunt_require_no_website: '0',
  });

  register = [{ body: { hits: 3, items: [
    company('REACHABLE ROOFING LIMITED', '61000001'),
    company('SILENT ROOFING LIMITED', '61000002'),
    company('ALSO REACHABLE LIMITED', '61000003'),
  ] } }];
  places = [{ places: [
    place('Reachable Roofing'),          // the stub gives every place a phone
    place('Also Reachable'),
  ] }];                                   // Silent Roofing is not listed

  const run = await runAndWait();
  assert.equal(run.error ?? null, null);
  assert.equal(run.found, 2, 'only the two Google knows a number for');
  assert.equal(run.no_contact, 1, 'and it says why the third was skipped');

  const names = (await get('/api/leads')).body.leads.map((l) => l.business_name);
  assert.ok(!names.includes('SILENT ROOFING LIMITED'));
  for (const l of (await get('/api/leads')).body.leads) {
    assert.ok(l.phone, `${l.business_name} was filed without a phone`);
  }
});

test('require-phone asks Google even when the website filter is off', async () => {
  // Places used to be consulted only for the website check, so with that off
  // a lead arrived with no phone number at all — nothing to contact it by.
  stub();
  await clearLeads();
  await configure({
    hunt_daily_target: '2', hunt_require_phone: '1', hunt_require_no_website: '0',
  });
  register = [{ body: { hits: 1, items: [company('PHONE ONLY LIMITED', '61000101')] } }];
  places = [{ places: [place('Phone Only')] }];

  const run = await runAndWait();
  assert.equal(run.places_requests, 1, 'Google is asked for the number');
  assert.equal(run.found, 1);
  assert.ok((await get('/api/leads')).body.leads[0].phone);
});

test('require-phone does not reintroduce the website filter', async () => {
  // judge() answers both questions from one page. Wanting the phone must not
  // silently start discarding companies that have a website.
  stub();
  await clearLeads();
  await configure({
    hunt_daily_target: '5', hunt_require_phone: '1', hunt_require_no_website: '0',
  });
  register = [{ body: { hits: 1, items: [company('HAS A SITE LIMITED', '61000201')] } }];
  places = [{ places: [place('Has A Site', { website: 'https://hasasite.co.uk' })] }];

  const run = await runAndWait();
  assert.equal(run.found, 1, 'a website is irrelevant when only the phone was asked for');
  assert.equal(run.had_website, 0);
});

test('require-phone without a Google key is refused, and says so plainly', async () => {
  stub();
  await clearLeads();
  await configure({ hunt_require_phone: '1', hunt_require_no_website: '0' });
  await withoutPlacesKey(async () => {
    const res = await post('/api/hunt/run', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /GOOGLE_MAPS_API_KEY/);
    assert.equal(calls.register, 0, 'nothing spent finding out');
  });
});

test('require-mobile keeps 07 numbers and drops landlines', async () => {
  // WhatsApp and SMS reach 07 and nothing else, so when those are the plan an
  // 0121 number is not a lead — and the run has to say that is why, or a
  // short day looks like a broken hunt.
  stub();
  await clearLeads();
  await configure({
    hunt_daily_target: '10',
    hunt_require_mobile: '1',
    hunt_require_no_website: '0',
  });

  register = [{ body: { hits: 3, items: [
    company('MOBILE ROOFING LIMITED', '61000301'),
    company('LANDLINE ROOFING LIMITED', '61000302'),
    company('ALSO MOBILE LIMITED', '61000303'),
  ] } }];
  places = [{ places: [
    place('Mobile Roofing', { phone: '07700 900123' }),
    place('Landline Roofing', { phone: '0121 496 0000' }),
    place('Also Mobile', { phone: '07700 900456' }),
  ] }];

  const run = await runAndWait();
  assert.equal(run.error ?? null, null);
  assert.equal(run.found, 2, 'only the two on a mobile');
  assert.equal(run.not_mobile, 1, 'and it says the third was a landline');
  assert.equal(run.no_contact, 0, 'which is not the same as having no number');

  for (const l of (await get('/api/leads')).body.leads) {
    assert.match(l.phone, /^07/, `${l.business_name} was filed on a landline`);
  }
});

test('require-mobile asks Google even with the phone box unticked', async () => {
  // A mobile is a phone. Treating the two flags as independent meant the
  // Places lookup was skipped, every company arrived with no number, and the
  // mobile filter then rejected the lot — a filter that finds nobody for ever
  // and never says why.
  stub();
  await clearLeads();
  await configure({
    hunt_daily_target: '2',
    hunt_require_mobile: '1',
    hunt_require_phone: '0',
    hunt_require_no_website: '0',
  });
  register = [{ body: { hits: 1, items: [company('TEXTABLE LIMITED', '61000401')] } }];
  places = [{ places: [place('Textable', { phone: '07700 900789' })] }];

  const run = await runAndWait();
  assert.equal(run.places_requests, 1, 'Google is asked for the number');
  assert.equal(run.found, 1);
  assert.match((await get('/api/leads')).body.leads[0].phone, /^07/);
});

test('a company contacted by WhatsApp is never found again, even after its lead is deleted', async () => {
  // The owner's rule, end to end: reach out to a business once and it must not
  // reappear in a later run — not even after the lead row is deleted, because
  // the no-repeat memory is the ledger, which outlives the lead.
  stub();
  await clearLeads();
  await configure({
    hunt_trades: 'roofers', hunt_areas: 'Otley',
    hunt_require_no_website: '0', hunt_daily_target: '5',
  });

  register = [{ body: { hits: 1, items: [company('WHATSAPPED ROOFING LIMITED', '62000009')] } }];
  const run1 = await runAndWait();
  assert.equal(run1.found, 1, 'found the first time');
  const lead = (await get('/api/leads')).body.leads[0];

  // Reach out on WhatsApp: prepare the hand-off and confirm it was sent.
  await patch(`/api/leads/${lead.id}`, { phone: '07700 900123' });
  const prep = await post('/api/outreach/prepare',
    { lead_id: lead.id, channel: 'whatsapp', text: 'Hi from Keylo' });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await post(`/api/outreach/${prep.body.event_id}/sent`, {});

  // Delete the lead — "not interested in this row", which must NOT undo the
  // fact that the business was already approached.
  await del(`/api/leads/${lead.id}`);

  // The register would happily hand the same company back; the hunt must not.
  register = [{ body: { hits: 1, items: [company('WHATSAPPED ROOFING LIMITED', '62000009')] } }];
  const run2 = await runAndWait();
  assert.equal(run2.found, 0, 'a business already messaged must never resurface');
  assert.equal((await get('/api/leads')).body.leads.length, 0, 'and no fresh lead is filed for it');
});

test('require-mobile without a Google key is refused, naming the mobile filter', async () => {
  stub();
  await clearLeads();
  await configure({
    hunt_require_mobile: '1', hunt_require_phone: '0', hunt_require_no_website: '0',
  });
  await withoutPlacesKey(async () => {
    const res = await post('/api/hunt/run', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /mobile number/);
    assert.equal(calls.register, 0, 'nothing spent finding out');
  });
});

/* ------------------------------------------------------------ right town */

test('a company on a road named after another town is rejected', () => {
  // The register's location filter matches the WHOLE address, so a search
  // for "Stone" returns companies on Stone Road in Aylesbury. That happened
  // on the first real run: RAULNICOLAS LTD, Aylesbury, a hundred miles from
  // any town on the list.
  assert.equal(sameTown('Stone', 'Aylesbury'), false);
  assert.equal(sameTown('Stafford', 'London'), false);
  assert.equal(sameTown('Cannock', 'Manchester'), false);
});

test('a town is not a longer town that starts the same way', () => {
  // Substring matching would accept every one of these, which is why the
  // comparison is by token.
  assert.equal(sameTown('Stone', 'Stoneleigh'), false);
  assert.equal(sameTown('Stafford', 'Staffordshire Business Park'), false);
  assert.equal(sameTown('Wells', 'Wellsbourne'), false);
});

test('the same town spelled differently still matches', () => {
  for (const [a, b] of [
    ['Stoke-on-Trent', 'Stoke On Trent'],
    ['Stoke-on-Trent', 'STOKE-ON-TRENT'],
    ['Burton-on-Trent', 'Burton On Trent'],
    ['Burton on Trent', 'Burton upon Trent'],
    ['Newcastle-under-Lyme', 'Newcastle under Lyme'],
    ['Newcastle-under-Lyme', 'Newcastle'],
    ['  Telford ', 'Telford'],
  ]) {
    assert.equal(sameTown(a, b), true, `"${a}" should match "${b}"`);
  }
});

test('two Newcastles are not one Newcastle', () => {
  // Staffordshire and Tyneside. First words agree and everything else does
  // not, which is exactly what the tail check is for.
  assert.equal(sameTown('Newcastle-under-Lyme', 'Newcastle upon Tyne'), false);
  assert.equal(sameTown('Ashby-de-la-Zouch', 'Ashby cum Fenby'), false);
});

test('a missing town on either side is not treated as a mismatch', () => {
  // No area asked for means no filter. No locality on the company means
  // nothing to check — the register matched it on something, and dropping a
  // lead over a blank field costs more than the occasional stray.
  assert.equal(sameTown(null, 'Aylesbury'), true);
  assert.equal(sameTown('Stafford', null), true);
  assert.equal(sameTown('Stafford', ''), true);
  assert.equal(sameTown('', ''), true);
});

test('the hunt expands a region typed in the areas box into towns', async () => {
  // The "80 trades, 5 companies" bug: a whole region as one location line
  // matches almost nobody, because the town check bins everything whose
  // locality is not literally "West Midlands". huntConfig now expands it.
  await configure({ hunt_areas: 'West Midlands\nStafford' });
  const { areas } = huntConfig();
  assert.ok(areas.includes('Birmingham'), 'the region became real towns');
  assert.ok(areas.includes('Wolverhampton'));
  assert.ok(areas.includes('Stafford'), 'a genuine town is kept');
  assert.ok(!areas.includes('West Midlands'), 'the un-searchable region line is gone');
  await configure(); // restore the default single-town setup for later tests
});

test('the hunt files only companies actually in the town, and counts the rest', async () => {
  stub();
  await clearLeads();
  await configure({
    hunt_trades: 'roofers', hunt_areas: 'Stone',
    hunt_daily_target: '5', hunt_require_no_website: '0', hunt_require_phone: '0',
  });

  const at = (name, number, locality) => company(name, number, {
    registered_office_address: { address_line_1: '1 Stone Road', locality },
  });
  register = [{ body: { hits: 4, items: [
    at('REAL STONE ROOFING LIMITED', '62000001', 'Stone'),
    at('RAULNICOLAS LTD', '62000002', 'Aylesbury'),      // Stone Road, Aylesbury
    at('FAR AWAY ROOFING LIMITED', '62000003', 'London'),
    at('ALSO STONE LIMITED', '62000004', 'Stone'),
  ] } }];

  const run = await runAndWait();
  assert.equal(run.found, 2, 'only the two genuinely in Stone');
  assert.equal(run.wrong_town, 2, 'and it says how many were the wrong town');

  const names = (await get('/api/leads')).body.leads.map((l) => l.business_name);
  assert.ok(!names.includes('RAULNICOLAS LTD'));
  assert.ok(!names.includes('FAR AWAY ROOFING LIMITED'));
  assert.ok(names.includes('REAL STONE ROOFING LIMITED'));
});
