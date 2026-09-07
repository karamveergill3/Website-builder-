/**
 * The mockup generator. Everything it renders comes out of a prospect's
 * email, so the escaping tests here matter more than the layout ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSite, resolvePalette, tradeFamily, esc, telHref, mailtoHref, newToken, PAGES,
} from '../server/lib/site-builder.js';

const brief = {
  business_name: 'Hillside Roofing Ltd',
  trade: 'Roofing',
  services: ['Roofing', 'Guttering', 'Flat roofs'],
  primary_cta: 'call',
  areas: ['Wolverhampton', 'Dudley'],
  phone: '07123 456789',
  email: 'dave@hillsideroofing.co.uk',
  has_logo: false,
  has_photos: true,
  brand_colours: [],
};

/* ------------------------------------------------------------- output */

test('renders all four pages', () => {
  const files = renderSite(brief);
  assert.deepEqual(Object.keys(files).sort(), [...PAGES].sort());
  for (const [name, html] of Object.entries(files)) {
    assert.match(html, /^<!doctype html>/i, name);
    assert.match(html, /<\/html>\s*$/i, name);
    assert.ok(html.length > 1500, `${name} is suspiciously short`);
  }
});

test('the brief actually drives the content', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /Roofing in Wolverhampton/);
  for (const s of brief.services) assert.ok(html.includes(s), `missing service ${s}`);
  assert.ok(html.includes('Wolverhampton'));
  assert.ok(html.includes('07123 456789'));
});

test('the primary CTA changes the page, not just a label', () => {
  const call  = renderSite({ ...brief, primary_cta: 'call' })['index.html'];
  const quote = renderSite({ ...brief, primary_cta: 'quote' })['index.html'];
  assert.ok(call.includes('href="tel:07123456789"'), 'call CTA should dial');
  assert.ok(quote.includes('Get a quote'), 'quote CTA should say so');
  assert.notEqual(call, quote, 'the CTA must change the page');
});

test('every page carries noindex — a mockup is a private draft', () => {
  for (const [name, html] of Object.entries(renderSite(brief))) {
    assert.match(html, /name="robots"\s+content="noindex/i, name);
  }
});

test('the draft banner appears only when one is asked for', () => {
  assert.ok(!renderSite(brief)['index.html'].includes('class="draft"'));
  const noted = renderSite(brief, { draftNote: 'Draft for X' })['index.html'];
  assert.ok(noted.includes('Draft for X'));
});

/* ------------------------------------------------------------ escaping */

test('script tags in a reply render as text, never as markup', () => {
  const html = renderSite({
    ...brief,
    business_name: '<script>alert(1)</script>',
    services: ['<img src=x onerror=alert(1)>'],
    areas: ['"><script>bad()</script>'],
  })['index.html'];

  assert.ok(!/<script>alert/i.test(html), 'script executed');
  assert.ok(!/<img[^>]*onerror/i.test(html), 'img handler survived');
  assert.ok(!/"><script>/i.test(html), 'broke out of an attribute');
  assert.ok(html.includes('&lt;script&gt;'), 'should be escaped, not stripped');
});

test('esc covers every character that matters in an attribute', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

/* --------------------------------------------------------------- hrefs */

test('telHref keeps only digits, so an attribute cannot be escaped', () => {
  assert.equal(telHref('07123 456789'), 'tel:07123456789');
  assert.equal(telHref('(0113) 200-2000'), 'tel:01132002000');
  assert.equal(telHref('+44 7123 456789'), 'tel:+447123456789');
  // The values that matter: these must produce nothing at all.
  assert.equal(telHref('" onmouseover="alert(1)'), null);
  assert.equal(telHref('javascript:alert(1)'), null);
  assert.equal(telHref('123'), null);
  assert.equal(telHref(null), null);
});

test('a phone number that cannot be dialled produces no link at all', () => {
  const html = renderSite({ ...brief, phone: '" onmouseover="alert(1)' })['index.html'];
  assert.ok(!html.includes('href=""'), 'empty href emitted');
  assert.ok(!html.includes('href="null"'), 'the string null emitted');
  // The text may still appear (escaped); what must not exist is a live handler.
  assert.ok(!/["']\s*onmouseover\s*=/i.test(html.replace(/&quot;/g, '')),
    'an event handler attribute survived');
});

test('mailtoHref refuses anything that is not an address', () => {
  assert.equal(mailtoHref('dave@example.co.uk'), 'mailto:dave@example.co.uk');
  assert.equal(mailtoHref('"><script>x</script>@b.c'), null);
  assert.equal(mailtoHref('not-an-email'), null);
  assert.equal(mailtoHref(''), null);
});

/* ------------------------------------------------------------ palettes */

test('trades route to the family a designer would pick', () => {
  const expected = {
    'Roofing': 'building',
    'Building contractors': 'building',
    'Cleaning of buildings': 'clean',   // contains "build" — order matters
    'Window cleaning': 'clean',
    'Vehicle maintenance and repair': 'motor',
    'Landscaping': 'green',
    'Hairdressing and beauty': 'beauty',
    'Complementary therapy': 'beauty',
    'Bakeries': 'food',
    'Takeaways': 'food',
    'Florists': 'retail',
    'Architecture': 'pro',
  };
  for (const [trade, family] of Object.entries(expected)) {
    assert.equal(tradeFamily(trade), family, trade);
  }
});

test('different trades get visibly different sites', () => {
  const accents = new Set(
    ['Roofing', 'Hairdressing and beauty', 'Bakeries', 'Landscaping', 'Architecture']
      .map((t) => resolvePalette(t, []).accent)
  );
  assert.equal(accents.size, 5, 'every trade family should look different');
});

test('a colour the prospect named beats the trade default', () => {
  assert.equal(resolvePalette('Roofing', ['navy']).accent, '#1e3a5f');
  assert.equal(resolvePalette('Roofing', ['#ff0000']).accent, '#ff0000');
  // Unrecognised colour words fall back rather than producing broken CSS.
  assert.equal(resolvePalette('Roofing', ['puce']).accent,
    resolvePalette('Roofing', []).accent);
});

/* --------------------------------------------------------------- token */

test('tokens are long, random and hex', () => {
  const a = newToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  const many = new Set(Array.from({ length: 200 }, () => newToken()));
  assert.equal(many.size, 200, 'tokens must not collide');
});

/* ------------------------------------------------------- thin briefs */

test('a brief with almost nothing in it still builds four usable pages', () => {
  const files = renderSite({
    business_name: 'Some Trade Ltd',
    services: [], areas: [], primary_cta: null, phone: null, email: null,
  });
  assert.equal(Object.keys(files).length, 4);
  for (const [name, html] of Object.entries(files)) {
    assert.ok(html.includes('Some Trade Ltd'), name);
    assert.ok(!html.includes('undefined'), `${name} leaked undefined`);
    assert.ok(!html.includes('null'), `${name} leaked null`);
  }
});
