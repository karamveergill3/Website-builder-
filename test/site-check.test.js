/**
 * The website check: is a business we are about to file really without a site?
 *
 * The case that started it: COSELEY SERVICES LIMITED, Wolverhampton, was
 * filed as having no website because Google's listing does not link one. It
 * has one, at its own name dot co dot uk. No network and no database here:
 * every fetch is a fake that answers for the hosts a test names and fails like
 * an unregistered domain for everything else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  nameSlugs, candidateDomains, judgePage, findWebsite, searchWeb, pagePhones, postcodeIn,
} = await import('../server/lib/site-check.js');

/** A fetch that knows a handful of URLs. Anything else "does not resolve". */
function fakeWeb(pages) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const p = pages[String(url)];
    if (!p) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ENOTFOUND' };
      throw err;
    }
    return {
      ok: (p.status ?? 200) < 400,
      status: p.status ?? 200,
      url: p.finalUrl ?? String(url),
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (p.type ?? 'text/html; charset=utf-8') : null) },
      text: async () => p.html ?? '',
    };
  };
  return { fetchImpl, asked };
}

const COSELEY = {
  names: ['Coseley Services', 'COSELEY SERVICES LIMITED'],
  phones: ['07732 170498'],
  postcode: 'WV4 6DW',
  towns: ['Wolverhampton'],
};

// What their home page actually carries (title and wording from the live site).
const COSELEY_HOME = `<!doctype html><html><head><title>Home | Coseley Services Ltd</title>
  <meta name="description" content="Road haulage in Wolverhampton"></head><body>
  <h1>Coseley Services Ltd</h1>
  <p>With over 24 years experience in the road haulage industry, Coseley Services will help you deliver.
  Apart from general haulage we also deal with contract work, with nationwide, local, same or next day deliveries.</p>
  <p>Call <a href="tel:07732170498">07732 170498</a> for all quotes on local and national haulage.</p>
  <footer>Unit F3, Hilton Trading Estate, Hilton Road, Lanesfield, Wolverhampton WV4 6DW</footer>
</body></html>`;

/* ------------------------------------------------------------- guessing */

test('a company name becomes the domains it would register', () => {
  assert.deepEqual(nameSlugs('COSELEY SERVICES LIMITED'), ['coseleyservices', 'coseley-services']);
  const smith = nameSlugs('Smith & Sons Joinery Ltd');
  assert.ok(smith.includes('smithandsonsjoinery'));
  assert.ok(smith.includes('smithsonsjoinery'), 'with and without the "and"');
  assert.ok(nameSlugs('The Little Cafe').includes('littlecafe'), 'without a leading "The"');
  assert.ok(nameSlugs('Woodpecker Joinery UK Ltd').includes('woodpeckerjoinery'), 'without a trailing UK');
  assert.ok(nameSlugs("Barlow's (Holdings) Ltd").includes('barlows'), 'apostrophes and brackets dropped');
});

test('the generic word stays in: coseley.co.uk is a page about the town', () => {
  assert.ok(!nameSlugs('COSELEY SERVICES LIMITED').includes('coseley'));
});

test('both names are tried, best guess of each first', () => {
  const slugs = nameSlugs(['Barlows Window Services', 'BARLOWS WINDOW CLEANING SERVICES LIMITED']);
  assert.deepEqual(slugs.slice(0, 2), ['barlowswindowservices', 'barlowswindowcleaningservices']);
});

test('their own email domain is tried first; a Gmail address is not a domain of theirs', () => {
  const own = candidateDomains({ names: ['Coseley Services'], email: 'info@coseley-haulage.co.uk' });
  assert.deepEqual(own[0], { domain: 'coseley-haulage.co.uk', how: 'email-domain' });
  const gmail = candidateDomains({ names: ['Coseley Services'], email: 'coseley@gmail.com' });
  assert.ok(!gmail.some((c) => c.domain === 'gmail.com'));
  assert.ok(gmail.some((c) => c.domain === 'coseleyservices.co.uk'));
});

/* -------------------------------------------------------- whose page is it */

test('the Coseley page is theirs: their number is on it', () => {
  const j = judgePage({ html: COSELEY_HOME, url: 'https://coseleyservices.co.uk/' }, COSELEY);
  assert.equal(j.match, 'confirmed');
  assert.deepEqual(j.evidence, ['phone']);
});

test('name and exact postcode confirm it; name and town are only "possible"', () => {
  const withPostcode = '<title>Coseley Services</title><p>Our yard: Lanesfield, Wolverhampton WV4 6DW.</p>';
  assert.equal(judgePage({ html: withPostcode, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'confirmed');
  const townOnly = '<title>Coseley Services</title><p>Haulage from our Wolverhampton yard.</p>';
  assert.equal(judgePage({ html: townOnly, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'possible',
    'a town is shared by every firm in it');
});

test('their name alone on their name-domain is only "possible", and not if it places them elsewhere', () => {
  const plain = '<title>Coseley Services Ltd</title><p>Haulage you can rely on.</p>';
  assert.equal(judgePage({ html: plain, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'possible');

  const bristol = '<title>Coseley Services Ltd</title><p>Haulage. 4 Quay St, Bristol BS1 4XX.</p>';
  const j = judgePage({ html: bristol, url: 'https://coseleyservices.co.uk/' }, COSELEY);
  assert.equal(j.match, 'possible', 'shown for a look, never proof');
  assert.ok(j.evidence.includes('elsewhere'), 'and marked as probably someone else');
});

test('a search result needs proof, not just the name', () => {
  const plain = '<title>Coseley Services Ltd</title><p>Haulage you can rely on.</p>';
  assert.equal(judgePage({ html: plain, url: 'https://coseley.example/' }, COSELEY, { how: 'search' }).match, null);
});

test('a parked, for-sale or holding page is not a website', () => {
  const forSale = '<title>coseleyservices.co.uk is for sale</title><p>Buy this domain today.</p>';
  assert.equal(judgePage({ html: forSale, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, null);
  assert.equal(judgePage({ html: forSale, url: 'https://coseleyservices.co.uk/' }, COSELEY).parked, true);

  const soon = '<title>Coseley Services</title><h1>Website coming soon</h1><p>Wolverhampton</p>';
  assert.equal(judgePage({ html: soon, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, null,
    'their own "coming soon" page means they still need a website');

  const sedo = judgePage({ html: '<p>x</p>', url: 'https://sedoparking.com/coseleyservices.co.uk' }, COSELEY);
  assert.equal(sedo.parked, true);
});

test('a real short site that mentions "coming soon" in passing still counts', () => {
  const html = `<title>Coseley Services</title><p>${'Reliable haulage across the region. '.repeat(20)}
    Online booking coming soon. Call 07732 170498.</p>`;
  assert.equal(judgePage({ html, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'confirmed');
});

test('a domain that just forwards to their Facebook page is not a website', () => {
  const j = judgePage({ html: COSELEY_HOME, url: 'https://www.facebook.com/CoseleyServicesLtd/' }, COSELEY);
  assert.equal(j.match, null);
});

test('phone numbers are read in the shapes sites write them', () => {
  const phones = pagePhones('<a href="tel:+447732170498">x</a>',
    'Ring +44 (0) 1902 123456 or 07732-170-498, or (01902) 654321');
  assert.ok(phones.has('+447732170498'));
  assert.ok(phones.has('+441902123456'));
  assert.ok(phones.has('+441902654321'));
  assert.equal(postcodeIn('Unit F3, Lanesfield, Wolverhampton WV4 6DW'), 'WV4 6DW');
});

/* ------------------------------------------------------------- the check */

test('Coseley Services is found at its own name, dot co dot uk', async () => {
  const web = fakeWeb({ 'https://coseleyservices.co.uk/': { html: COSELEY_HOME } });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://coseleyservices.co.uk/');
  assert.equal(r.how, 'name-domain');
  assert.equal(r.confidence, 'confirmed');
});

test('a site only on the www host is still found', async () => {
  const web = fakeWeb({ 'https://www.coseley-services.co.uk/': { html: COSELEY_HOME } });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://www.coseley-services.co.uk/');
});

test('a business with no domain at all comes back with no website', async () => {
  const web = fakeWeb({});
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, false);
  assert.ok(r.tried >= 6, 'every guess was tried');
  assert.ok(web.asked.every((u) => /^https?:\/\/(www\.)?coseley-?services\.(co\.uk|com|uk)\/$/.test(u)),
    `only their own guessed domains were asked: ${web.asked.join(', ')}`);
});

test('a parked name-domain does not count, and the search can still find the real one', async () => {
  const results = `<a class="result__a" href="https://www.yell.com/biz/coseley-services-ltd-wolverhampton-6409645/">Yell</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://coseleyhaulage.co.uk/')}&amp;rut=x">Coseley Haulage</a>`;
  const web = fakeWeb({
    'https://coseleyservices.co.uk/': { html: '<title>Domain for sale</title><p>Buy this domain</p>' },
    'https://html.duckduckgo.com/html/?q=coseley%20services%20Wolverhampton&kl=uk-en': { html: results },
    'https://coseleyhaulage.co.uk/': { html: COSELEY_HOME },
  });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl, search: { gapMs: 0 } });
  assert.equal(r.found, true);
  assert.equal(r.how, 'search');
  assert.equal(r.url, 'https://coseleyhaulage.co.uk/');
  assert.ok(!web.asked.some((u) => u.includes('yell.com')), 'a directory listing is never read as their site');
});

test('a blocked search is reported, so "none found" is not taken as a firm no', async () => {
  const web = fakeWeb({
    'https://html.duckduckgo.com/html/?q=coseley%20services%20Wolverhampton&kl=uk-en':
      { status: 202, html: '<div class="anomaly-modal">bots use DuckDuckGo too</div>' },
  });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl, search: { gapMs: 0 } });
  assert.equal(r.found, false);
  assert.equal(r.searchBlocked, true);

  const direct = await searchWeb('anything', { fetchImpl: fakeWeb({}).fetchImpl, gapMs: 0 });
  assert.equal(direct.blocked, true);
});

test('a URL already on file for them is checked first', async () => {
  const web = fakeWeb({ 'https://coseley.example/home': { html: COSELEY_HOME } });
  const r = await findWebsite({ ...COSELEY, knownUrls: ['https://coseley.example/home'] }, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, true);
  assert.equal(r.how, 'known-url');
  assert.equal(web.asked[0], 'https://coseley.example/home');
});

test('the whole check stops at its time budget', async () => {
  const slow = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const r = await findWebsite(COSELEY, { fetchImpl: slow, budgetMs: 150, timeoutMs: 5_000 });
  assert.equal(r.found, false);
  assert.ok(Date.now() - started < 2_000, 'did not wait for every request to time out');
});

/* ------------------------------------- someone else's site is not theirs */

// Dropping a real prospect because another firm's page looked like theirs is
// as bad as messaging one that has a site. Each of these was a real mistake
// in an earlier version.

const WOLVES = (names, extra = {}) => ({
  names, phones: ['07700 900111'], postcode: 'WV10 9AA', towns: ['Wolverhampton'], ...extra,
});

test('a search result for a place-named firm is not taken for them', async () => {
  // "Coseley" is a place: Coseley Medical Centre is not Coseley Services.
  const results = `<a class="result__a" href="https://www.coseleymedicalcentre.co.uk/">x</a>`;
  const web = fakeWeb({
    'https://html.duckduckgo.com/html/?q=coseley%20services%20Wolverhampton&kl=uk-en': { html: results },
    'https://www.coseleymedicalcentre.co.uk/': {
      html: '<title>Coseley Medical Centre</title><p>GP surgery. Coseley, Wolverhampton WV14 9AA</p>',
    },
  });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl, search: { gapMs: 0 } });
  assert.equal(r.found, false);
});

test('a competitor’s page is not the site of a name made of a town and a trade', () => {
  const biz = WOLVES(['Wolverhampton Roofing Services']);
  const html = '<title>JB Roofing Contractors</title><p>Wolverhampton Roofing Services you can trust, across Wolverhampton.</p>';
  assert.equal(judgePage({ html, url: 'https://roofing-wolverhampton.co.uk/' }, biz, { how: 'search' }).match, null);
  const onDomain = judgePage({ html, url: 'https://wolverhamptonroofingservices.co.uk/' }, biz);
  assert.equal(onDomain.match, 'possible', 'at most a look');
  assert.ok(onDomain.evidence.includes('common-name'));
});

test('initials do not match the letters left by "we’d" and "it’s"', () => {
  const biz = WOLVES(['D S Electrical']);
  const html = "<title>Sparks</title><p>We'd love to help. It's simple: electrical work across Wolverhampton.</p>";
  assert.equal(judgePage({ html, url: 'https://dselectrical.co.uk/' }, biz).match, null);
});

test('a one-word or stock name on its .com is at most "possible", never proof', async () => {
  const glamour = WOLVES(['Glamour']);
  const j = judgePage({ html: '<title>Glamour UK | Fashion, Beauty, Celebrity</title><p>Glamour magazine</p>',
    url: 'https://www.glamour.com/' }, glamour);
  assert.equal(j.match, 'possible');
  const web = fakeWeb({ 'https://glamour.com/': { html: '<title>Glamour UK</title><p>Glamour magazine</p>' } });
  const r = await findWebsite(glamour, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, false, 'a prospect is never dropped on that');
  assert.equal(r.possible.url, 'https://glamour.com/');

  const premier = WOLVES(['Premier Roofing']);
  const kent = judgePage({ html: '<title>Premier Roofing</title><p>Quality roofing across Kent. Call 01622 000000.</p>',
    url: 'https://premierroofing.co.uk/' }, premier);
  assert.equal(kent.match, 'possible', 'a look, never proof');
  assert.ok(kent.evidence.includes('common-name'));
});

test('a same-named firm elsewhere that "covers" their town is not them', () => {
  const biz = WOLVES(['Harrowby Roofing']);
  const html = `<title>Harrowby Roofing</title><p>12 High St, Erdington, Birmingham B23 6RH. Call 0121 555 0000.
    Areas covered: Birmingham, Solihull, Walsall, Wolverhampton, Dudley.</p>`;
  const j = judgePage({ html, url: 'https://harrowbyroofing.co.uk/' }, biz);
  assert.notEqual(j.match, 'confirmed');
  assert.ok(j.evidence.includes('elsewhere'));
});

test('possessive names match however the page writes the apostrophe', () => {
  const biz = WOLVES(["Dave's Plumbing"], { phones: [] });
  for (const written of ["Dave's", 'Dave&#39;s', 'Dave&rsquo;s', 'Dave’s']) {
    const html = `<title>${written} Plumbing</title><p>${written} Plumbing, 3 Mill Lane, Wolverhampton WV10 9AA</p>`;
    assert.equal(judgePage({ html, url: 'https://davesplumbing.co.uk/' }, biz).match, 'confirmed', written);
  }
});

test('"How it works!" on their own page with their number is still their site', () => {
  const html = '<title>Coseley Services</title><h2>How it works!</h2><p>Call 07732 170498.</p>';
  assert.equal(judgePage({ html, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'confirmed');
});

test('holding and parking pages that only show the domain do not name them', () => {
  const lander = '<title>coseley-services.co.uk</title><script src="/lander"></script><div id="root"></div>';
  assert.equal(judgePage({ html: lander, url: 'https://coseley-services.co.uk/' }, COSELEY).match, null);
  const godaddy = '<title>coseleyservices.co.uk</title><p>This Web page is parked for FREE, courtesy of GoDaddy.com.</p>';
  assert.equal(judgePage({ html: godaddy, url: 'https://coseleyservices.co.uk/' }, COSELEY).parked, true);
  const plesk = '<title>Domain Default page</title><p>coseleyservices.co.uk</p>';
  assert.equal(judgePage({ html: plesk, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, null);
});

test('motorways, CO2 and towns that are ordinary words are not a place', () => {
  const prestwich = { names: ['Harrowby Motors'], phones: [], postcode: 'M25 1AB', towns: ['Prestwich'] };
  assert.equal(judgePage({ html: '<title>Harrowby Motors</title><p>Garages within the M25.</p>',
    url: 'https://harrowbymotors.co.uk/' }, prestwich).match, 'possible', 'M25 is not their postcode');
  const reading = { names: ['Harrowby Roofing'], phones: [], postcode: '', towns: ['Reading'] };
  assert.equal(judgePage({ html: '<title>Harrowby Roofing</title><p>Continue reading our news.</p>',
    url: 'https://harrowbyroofing.co.uk/' }, reading).match, 'possible', '"reading" places nobody');
});

test('a site that will not let us read it is "possible", on either host', async () => {
  const blocked = fakeWeb({
    'https://coseleyservices.co.uk/': { status: 403, html: 'Just a moment...' },
    'https://www.coseleyservices.co.uk/': { status: 403, html: 'Just a moment...' },
  });
  const r = await findWebsite(COSELEY, { fetchImpl: blocked.fetchImpl });
  assert.equal(r.found, false);
  assert.match(r.possible.url, /coseleyservices\.co\.uk/);

  // The bare domain answers 404; the site lives on www.
  const www = fakeWeb({
    'https://coseleyservices.co.uk/': { status: 404, html: 'Not found' },
    'https://www.coseleyservices.co.uk/': { html: COSELEY_HOME },
  });
  const r2 = await findWebsite(COSELEY, { fetchImpl: www.fetchImpl });
  assert.equal(r2.found, true);
  assert.equal(r2.url, 'https://www.coseleyservices.co.uk/');
});

test('a page with a nonsense character reference cannot crash the check', () => {
  const html = '<title>Coseley Services &#99999999; &#x110000;</title><p>Wolverhampton</p>';
  assert.doesNotThrow(() => judgePage({ html, url: 'https://coseleyservices.co.uk/' }, COSELEY));
});

test('their own "coming soon" page is no website, even with their number on it', () => {
  const html = '<title>Coseley Services - Coming Soon</title><p>New website coming soon. Call 07732 170498.</p>';
  const j = judgePage({ html, url: 'https://coseleyservices.co.uk/' }, COSELEY);
  assert.equal(j.match, null);
  assert.equal(j.parked, true);
});

test('a registered office at the accountant\u2019s does not hide their own site', () => {
  // Companies House has the accountant's WV1 postcode; the site shows the yard's.
  const biz = { ...COSELEY, phones: [], postcodes: ['WV1 1HB', 'WV4 6DW'], postcode: undefined };
  assert.equal(judgePage({ html: COSELEY_HOME.replace(/tel:[^"]+|07732 170498/g, ''),
    url: 'https://coseleyservices.co.uk/' }, biz).match, 'confirmed');
});

test('a parked bare domain does not hide the real site on www', async () => {
  const web = fakeWeb({
    'https://coseleyservices.co.uk/': { html: '<p>This Web page is parked for FREE, courtesy of GoDaddy.com.</p>' },
    'https://www.coseleyservices.co.uk/': { html: COSELEY_HOME },
  });
  const r = await findWebsite(COSELEY, { fetchImpl: web.fetchImpl });
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://www.coseleyservices.co.uk/');
});

test('a bare domain that hangs does not stop www being asked', async () => {
  const hanging = async (url, { signal }) => {
    if (String(url) === 'https://coseleyservices.co.uk/' || String(url) === 'http://coseleyservices.co.uk/') {
      return new Promise((_r, reject) => signal.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return fakeWeb({ 'https://www.coseleyservices.co.uk/': { html: COSELEY_HOME } }).fetchImpl(url);
  };
  const r = await findWebsite(COSELEY, { fetchImpl: hanging, timeoutMs: 100, budgetMs: 5_000 });
  assert.equal(r.found, true);
});
