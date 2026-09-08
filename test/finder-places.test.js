/**
 * The contact finder's primary source: Google Places.
 *
 * A no-website business is filed with no phone and no email — but most
 * tradespeople still have a Google Business Profile with a phone. Scraping
 * DuckDuckGo/Yell for it fails from a datacenter IP (blocked/challenged), so
 * the finder reads the number straight off the Places listing over the paid
 * API, which a server can actually reach. These prove that path — and that a
 * listing whose name does not match is never attached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_MAPS_API_KEY = 'test-places-key';

const { get, post, teardown, nextCompanyNumber } = await import('./helpers.js');
const { discover, autoPromote } = await import('../server/lib/contact-finder.js');

const realFetch = globalThis.fetch;
let place = null; // the single Places listing the stub returns
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opts);
  if (u.includes('places.googleapis.com')) {
    return new Response(JSON.stringify({ places: place ? [place] : [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('blocked', { status: 403 }); // DDG etc., as on a real server
};

const makeLead = async (over = {}) => (await post('/api/leads', {
  business_name: 'Arlo Fire Safety Ltd',
  location: 'Leek',
  entity_type: 'corporate',
  company_number: nextCompanyNumber(),
  ...over,
})).body.lead;

test('the finder reads a phone off the Google listing for a no-website lead', async () => {
  place = {
    id: 'p1', displayName: { text: 'Arlo Fire Safety' },
    formattedAddress: '1 High St, Leek', nationalPhoneNumber: '01538 373737',
  };
  const lead = await makeLead();
  const out = await discover(lead, { web: false });
  const phone = out.signals.find((s) => s.kind === 'phone');
  assert.ok(phone, 'a phone signal was found via Places');
  assert.equal(phone.source, 'places');
  assert.ok(phone.value.startsWith('+44'), `normalised to E.164: ${phone.value}`);
});

test('a Google listing for a different business is not attached', async () => {
  place = {
    id: 'p2', displayName: { text: 'Completely Different Plumbing' },
    formattedAddress: 'Leek', nationalPhoneNumber: '01538 999999',
  };
  const lead = await makeLead({ business_name: 'Arlo Fire Safety Ltd' });
  const out = await discover(lead, { web: false });
  assert.equal(out.signals.find((s) => s.kind === 'phone'), undefined,
    'a mismatched name must not hand over its number');
});

test('with a Places website, it is filed and fed to the scrape path', async () => {
  place = {
    id: 'p3', displayName: { text: 'Arlo Fire Safety' },
    formattedAddress: 'Leek', websiteUri: 'https://arlofire.example',
  };
  const lead = await makeLead();
  const out = await discover(lead, { web: false });
  const site = out.signals.find((s) => s.kind === 'website');
  assert.ok(site && site.value === 'https://arlofire.example', 'the website is captured');
});

test('auto-promote copies a found mobile straight onto the lead', async () => {
  place = {
    id: 'p4', displayName: { text: 'Arlo Fire Safety' },
    formattedAddress: 'Leek', nationalPhoneNumber: '07700 900123',
  };
  const lead = await makeLead();
  await discover(lead, { web: false });
  const set = autoPromote(lead.id);
  assert.ok(set.phone, 'a phone was promoted');
  assert.equal(set.phoneMobile, true, 'and it is recognised as a mobile');

  const row = (await get(`/api/leads/${lead.id}`)).body.lead;
  assert.ok(row.phone && row.phone.startsWith('+447'), `lead.phone is the mobile: ${row.phone}`);
});

test('auto-promote still files a landline when that is all there is', async () => {
  place = {
    id: 'p5', displayName: { text: 'Arlo Fire Safety' },
    formattedAddress: 'Leek', nationalPhoneNumber: '01538 373737',
  };
  const lead = await makeLead();
  await discover(lead, { web: false });
  const set = autoPromote(lead.id);
  assert.ok(set.phone, 'the landline is still filed as the number');
  assert.notEqual(set.phoneMobile, true, 'but not flagged a mobile');
});

test.after(() => { globalThis.fetch = realFetch; teardown(); });
