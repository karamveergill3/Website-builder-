import test from 'node:test';
import assert from 'node:assert/strict';

process.env.COMPANIES_HOUSE_API_KEY = 'test-key';

const { get, post, del, teardown } = await import('./helpers.js');
const ch = await import('../server/lib/companies-house.js');
const { resolveTrade } = await import('../server/lib/sic.js');

test.after(teardown);

/* ---- Stub the register so tests never call it or need a key ---- */

const realFetch = globalThis.fetch;
let calls = [];
let replies = [];

function stub() {
  calls = [];
  replies = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('company-information.service.gov.uk')) return realFetch(url, opts);
    calls.push({ url: u, auth: opts.headers?.Authorization });
    const next = replies.shift() ?? { status: 200, body: { items: [] } };
    return new Response(JSON.stringify(next.body), {
      status: next.status, headers: { 'Content-Type': 'application/json' },
    });
  };
}

const found = (name, over = {}) => ({
  title: name, company_name: name,
  company_number: over.company_number ?? '01234567',
  company_status: 'active', company_type: 'ltd',
  date_of_creation: '2011-04-02',
  address_snippet: '1 High Street, Otley, LS21 1AA',
  address: { locality: 'Otley', postal_code: 'LS21 1AA' },
  registered_office_address: { locality: 'Otley', postal_code: 'LS21 1AA', address_line_1: '1 High Street' },
  sic_codes: ['43910'],
  ...over,
});

/* ------------------------------------------------------------ unit pieces */

test('auth is Basic with the key as username and an empty password', async () => {
  stub();
  replies = [{ status: 200, body: found('ACME LTD') }];
  await ch.profile('01234567');
  // The trailing colon is part of what gets encoded; without it auth fails.
  assert.equal(calls[0].auth, `Basic ${Buffer.from('test-key:').toString('base64')}`);
});

test('only bodies corporate count as sendable', () => {
  for (const t of ['ltd', 'plc', 'llp', 'private-unlimited', 'royal-charter',
                   'charitable-incorporated-organisation', 'industrial-and-provident-society']) {
    assert.equal(ch.isBodyCorporate(t), true, `${t} is a body corporate`);
  }
  for (const t of ['limited-partnership', 'scottish-partnership', 'uk-establishment',
                   'oversea-company', 'registered-overseas-entity', 'other', 'made-up-new-type']) {
    assert.equal(ch.isBodyCorporate(t), false, `${t} is not`);
  }
});

test('a company being struck off is not trading', () => {
  assert.equal(ch.isTrading({ company_status: 'active' }), true);
  assert.equal(ch.isTrading({ company_status: 'dissolved' }), false);
  assert.equal(ch.isTrading({ company_status: 'liquidation' }), false);
  assert.equal(ch.isTrading({
    company_status: 'active', company_status_detail: 'active-proposal-to-strike-off',
  }), false);
});

test('name matching ignores legal suffixes and filler', () => {
  assert.equal(ch.normaliseName('Hillside Roofing & Leadwork Ltd'), 'hillside roofing leadwork');
  assert.equal(ch.normaliseName('THE CROWN JOINERY COMPANY LIMITED'), 'crown joinery');
  assert.ok(ch.matchScore('Hillside Roofing', { company_name: 'HILLSIDE ROOFING LTD' }) === 1);
  assert.ok(ch.matchScore('Hillside Roofing', { company_name: 'VALE PLASTERING LTD' }) === 0);
});

test('a location hint raises confidence but cannot create it', () => {
  const wrongName = { company_name: 'TOTALLY DIFFERENT LTD', locality: 'Otley' };
  assert.equal(ch.matchScore('Hillside Roofing', wrongName, { location: 'Otley' }), 0);

  const right = { company_name: 'HILLSIDE ROOFING AND LEADWORK LTD', locality: 'Otley' };
  assert.ok(ch.matchScore('Hillside Roofing', right, { location: 'Otley' })
          > ch.matchScore('Hillside Roofing', { ...right, locality: 'Truro' }, { location: 'Otley' }));
});

test('trade words resolve to SIC codes, and raw codes pass through', () => {
  assert.deepEqual(resolveTrade('roofers').codes, ['43910']);
  assert.deepEqual(resolveTrade('electricians').codes, ['43210']);
  assert.deepEqual(resolveTrade('43910').codes, ['43910']);
  assert.deepEqual(resolveTrade('43910, 43210').codes, ['43910', '43210']);
  assert.equal(resolveTrade('43910').exact, true);
  assert.deepEqual(resolveTrade('unmappable nonsense').codes, []);
});

/* ------------------------------------------------------------ the routes */

test('looking a lead up returns ranked candidates without changing anything', async () => {
  stub();
  const lead = (await post('/api/leads', {
    business_name: 'Hillside Roofing', location: 'Otley', email: 'a@hillsideroofing.co.uk',
  })).body.lead;
  assert.equal(lead.entity_type, 'unknown');

  replies = [{ status: 200, body: { items: [
    found('HILLSIDE ROOFING AND LEADWORK LIMITED', { company_number: '09876543' }),
    found('HILLSIDE CATERING LIMITED', { company_number: '11111111' }),
  ] } }];

  const res = await get(`/api/companies/lookup/${lead.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.candidates[0].company_number, '09876543', 'best match ranks first');
  assert.equal(res.body.candidates[0].sendable, true);

  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(after.entity_type, 'unknown', 'a lookup must not classify on its own');
  await del(`/api/leads/${lead.id}`);
});

test('attaching a company classifies the lead and unblocks sending', async () => {
  stub();
  const lead = (await post('/api/leads', {
    business_name: 'Vale Plastering', location: 'Ilkley', email: 'office@valeplastering.co.uk',
  })).body.lead;
  assert.equal(lead.can_email, false);

  replies = [{ status: 200, body: {
    company_name: 'VALE PLASTERING LIMITED', company_number: '07654321',
    company_status: 'active', type: 'llp', date_of_creation: '2011-04-02',
    sic_codes: ['43310'],
    registered_office_address: { address_line_1: '2 Brook Street', locality: 'Ilkley', postal_code: 'LS29 8AA' },
  } }];

  const res = await post('/api/companies/attach', { lead_id: lead.id, company_number: '07654321' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sendable, true);

  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(after.entity_type, 'corporate');
  assert.equal(after.company_number, '07654321');
  assert.equal(after.registered_name, 'VALE PLASTERING LIMITED');
  assert.match(after.registered_address, /Ilkley/);
  assert.equal(after.can_email, true, 'a matched company may now be emailed');
  await del(`/api/leads/${lead.id}`);
});

test('attaching a partnership marks the lead unsendable, not sendable', async () => {
  stub();
  const lead = (await post('/api/leads', {
    business_name: 'Smith and Sons', email: 'a@smithandsons.co.uk',
  })).body.lead;

  replies = [{ status: 200, body: {
    company_name: 'SMITH AND SONS LP', company_number: 'LP012345',
    company_status: 'active', type: 'limited-partnership', date_of_creation: '2009-01-01',
    registered_office_address: { locality: 'Leeds' },
  } }];

  const res = await post('/api/companies/attach', { lead_id: lead.id, company_number: 'LP012345' });
  assert.equal(res.body.sendable, false);

  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(after.entity_type, 'individual', 'an LP is not a body corporate');
  assert.equal(after.can_email, false);
  assert.equal(after.block_code, 'INDIVIDUAL_SUBSCRIBER');
  await del(`/api/leads/${lead.id}`);
});

test('discovery returns only active companies, and imports them already qualified', async () => {
  stub();
  replies = [{ status: 200, body: { hits: 2, items: [
    found('OTLEY ROOFING LIMITED', { company_number: '10000001' }),
    found('WHARFEDALE ROOFING LIMITED', { company_number: '10000002' }),
  ] } }];

  const res = await post('/api/companies/discover', { trade: 'roofers', location: 'Otley' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.trade.codes, ['43910']);
  assert.equal(res.body.companies.length, 2);
  assert.equal(res.body.companies[0].body_corporate, true);

  // The request must ask the register for active companies of that trade.
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/advanced-search/companies');
  assert.equal(url.searchParams.get('sic_codes'), '43910');
  assert.equal(url.searchParams.get('location'), 'Otley');
  assert.equal(url.searchParams.get('company_status'), 'active');

  const imported = await post('/api/companies/discover/import', {
    company_numbers: ['10000001', '10000002'],
    companies: res.body.companies,
    category: 'roofers',
  });
  assert.equal(imported.body.imported, 2);
  const lead = imported.body.leads[0];
  assert.equal(lead.entity_type, 'corporate', 'discovered companies arrive already qualified');
  assert.equal(lead.source, 'Companies House');
  assert.ok(lead.company_number);

  // And they cannot be imported twice.
  const again = await post('/api/companies/discover/import', {
    company_numbers: ['10000001'], companies: res.body.companies,
  });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped[0].reason, 'already a lead');

  for (const l of imported.body.leads) await del(`/api/leads/${l.id}`);
});

test('discovery refuses a query the register would reject', async () => {
  stub();
  const res = await post('/api/companies/discover', { trade: 'unmappable nonsense' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0, 'no request is made for an unusable query');
});

test('a rejected key is reported as a setup problem, not a crash', async () => {
  stub();
  replies = [{ status: 401, body: {} }];
  const res = await post('/api/companies/discover', { trade: 'roofers', location: 'Leeds' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /rejected the API key/i);
});

test('marking a lead a sole trader records that it was checked', async () => {
  const lead = (await post('/api/leads', { business_name: 'Dave the Roofer', email: 'd@dave.co.uk' })).body.lead;
  await post('/api/companies/mark-sole-trader', { lead_id: lead.id });
  const after = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.equal(after.entity_type, 'individual');
  assert.ok(after.checked_at);
  assert.match(after.entity_note, /sole trader/i);
  await del(`/api/leads/${lead.id}`);
});
