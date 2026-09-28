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
  assert.ok(j.evidence.includes('phone'));
  assert.ok(j.evidence.includes('postcode'));
});

test('name and town together confirm it, with no phone on the page', () => {
  const html = '<title>Coseley Services</title><p>Haulage from our Wolverhampton yard.</p>';
  assert.equal(judgePage({ html, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'confirmed');
});

test('their full name on their name-domain is enough, unless it places them elsewhere', () => {
  const plain = '<title>Coseley Services Ltd</title><p>Haulage you can rely on.</p>';
  assert.equal(judgePage({ html: plain, url: 'https://coseleyservices.co.uk/' }, COSELEY).match, 'likely');

  const bristol = '<title>Coseley Services Ltd</title><p>Haulage. 4 Quay St, Bristol BS1 4XX.</p>';
  const j = judgePage({ html: bristol, url: 'https://coseleyservices.co.uk/' }, COSELEY);
  assert.equal(j.match, null, 'a same-named firm in another district is not them');
  assert.ok(j.evidence.includes('elsewhere'));
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
    Online booking coming soon. Based in Wolverhampton.</p>`;
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
