/**
 * The mockup generator. Everything it renders comes out of a prospect's
 * email, so the escaping tests here matter more than the layout ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSite, resolvePalette, tradeFamily, esc, telHref, mailtoHref, newToken, PAGES, shade,
  themeFor, shortTrade,
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

test('one page by default, carrying every section', () => {
  const files = renderSite(brief);
  assert.deepEqual(Object.keys(files), ['index.html']);
  const html = files['index.html'];
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  // Every section must be present and anchored, since the nav links to them.
  for (const id of ['services', 'work', 'about', 'contact']) {
    assert.ok(html.includes(`id="${id}"`), `missing section #${id}`);
    assert.ok(html.includes(`href="#${id}"`), `nav does not link to #${id}`);
  }
});

test('the four-page build is still available on request', () => {
  const files = renderSite(brief, { pages: 'multi' });
  assert.deepEqual(Object.keys(files).sort(), [...PAGES].sort());
  for (const [name, html] of Object.entries(files)) {
    assert.match(html, /^<!doctype html>/i, name);
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
  assert.ok(quote.includes('href="#contact"'), 'a non-call CTA should jump to contact');
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

test('a brief with almost nothing in it still builds a usable page', () => {
  const thin = {
    business_name: 'Some Trade Ltd',
    services: [], areas: [], primary_cta: null, phone: null, email: null,
  };
  for (const pages of ['single', 'multi']) {
    const files = renderSite(thin, { pages });
    assert.equal(Object.keys(files).length, pages === 'single' ? 1 : 4);
    for (const [name, html] of Object.entries(files)) {
      assert.ok(html.includes('Some Trade Ltd'), `${pages}/${name}`);
      assert.ok(!html.includes('undefined'), `${pages}/${name} leaked undefined`);
      assert.ok(!html.includes('null'), `${pages}/${name} leaked null`);
    }
  }
});

test('the trading name is what appears, with the legal name in the footer', () => {
  const html = renderSite({
    ...brief,
    business_name: 'Hillside Roofing',
    registered_name: 'HILLSIDE ROOFING LIMITED',
  })['index.html'];
  assert.ok(html.includes('Hillside Roofing'), 'trading name should be the masthead');
  // Companies Act 2006 s.1202: a limited company trading under another name
  // must disclose the registered one.
  assert.match(html, /A trading name of HILLSIDE ROOFING LIMITED/);
});

test('no legal-name line when the names are the same', () => {
  const html = renderSite({ ...brief, registered_name: brief.business_name })['index.html'];
  assert.ok(!html.includes('A trading name of'));
});

/* ------------------------------------------------------- the visual layer */

test('the page carries no script — the preview CSP forbids one', () => {
  // Served under default-src 'none'. A <script> would silently not run, so
  // anything relying on one is a bug that only shows up in production.
  const html = renderSite(brief)['index.html'];
  assert.ok(!/<script/i.test(html), 'a script tag would be dead on arrival');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handlers are equally dead');
});

test('animation is decorative only — reduced motion still gets the content', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/,
    'a reader who asked for less motion must be honoured');
  // The reveal must not leave content invisible when animation is disabled.
  assert.match(html, /\.reveal\{opacity:1 !important/);
});

test('scroll-driven effects are feature-gated, so an old browser still reads', () => {
  const html = renderSite(brief)['index.html'];
  for (const feature of ['animation-timeline: view()', 'animation-timeline: scroll()']) {
    assert.ok(html.includes(`@supports (${feature})`), `${feature} must be gated`);
  }
});

test('the mesh gets a second hue, so it is not one lit corner', () => {
  for (const t of ['Roofing', 'Bakeries', 'Landscaping', 'Architecture']) {
    const p = resolvePalette(t, []);
    assert.ok(p.glow, `${t} has no glow`);
    assert.notEqual(p.glow, p.accent, `${t} glow must differ from accent`);
  }
});

test('a brand colour derives a lighter companion, not a darker one', () => {
  // The mesh sits on a dark ink. A darker second hue disappears into it.
  const p = resolvePalette('Roofing', ['#1e3a5f']);
  assert.equal(p.accent, '#1e3a5f');
  const lum = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
  };
  assert.ok(lum(p.glow) > lum(p.accent), 'glow should be lighter than the brand colour');
});

test('shade lightens and darkens without producing invalid colours', () => {
  assert.match(shade('#f97316', 0.4), /^#[0-9a-f]{6}$/);
  assert.match(shade('#f97316', -0.4), /^#[0-9a-f]{6}$/);
  assert.equal(shade('#000000', 1), '#ffffff');
  assert.equal(shade('#ffffff', -1), '#000000');
  assert.equal(shade('not-a-colour', 0.5), 'not-a-colour', 'bad input passes through');
});

test('four services lay out as 2x2 rather than orphaning the last card', () => {
  const html = renderSite({ ...brief, services: ['A', 'B', 'C', 'D'] })['index.html'];
  assert.ok(html.includes('data-n="4"'), 'the grid must declare its count');
  assert.match(html, /\.grid\[data-n="2"\],\.grid\[data-n="4"\]\{grid-template-columns:repeat\(2/);
});

test('the ticker repeats its items so the loop has no gap', () => {
  // The track translates by -50%; without a second copy the second half of
  // each cycle is empty.
  const html = renderSite({ ...brief, services: ['Roofing', 'Guttering'] })['index.html'];
  const track = html.match(/<div class="ticker-track">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const roofing = (track.match(/>Roofing</g) ?? []).length;
  assert.equal(roofing, 2, 'each item must appear exactly twice');
});

test('the print stylesheet drops the decoration', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /@media print\{[\s\S]*?\.mesh,\.grain,\.ticker\{display:none\}/);
});

/* ----------------------------------------------------------- sector themes */

test('each sector gets its own type, shape and motion — not just a colour', () => {
  const trades = ['Roofing', 'Vehicle maintenance and repair', 'Landscaping',
                  'Hairdressing and beauty', 'Bakeries', 'Florists',
                  'Cleaning of buildings', 'Architecture'];
  const themes = trades.map((t) => themeFor(t));

  // If these collapse, every generated site is one template recoloured —
  // which is exactly what a prospect recognises as generic.
  assert.equal(new Set(themes.map((t) => t.display)).size, trades.length,
    'every sector needs a distinct display face');
  assert.ok(new Set(themes.map((t) => t.motion)).size >= 6,
    'sectors should not all move the same way');
  assert.ok(new Set(themes.map((t) => t.ornament)).size >= 6,
    'sectors should not all share one backdrop');
  assert.ok(new Set(themes.map((t) => t.radius)).size >= 4,
    'shape language should vary');
});

test('every display stack ends in a font that is actually on the device', () => {
  // The font load can be blocked or slow. The fallback is what a real
  // viewer may well see, so it has to be a deliberate choice rather than
  // whatever the browser defaults to.
  for (const trade of ['Roofing', 'Hairdressing and beauty', 'Bakeries', 'Architecture']) {
    const { display } = themeFor(trade);
    assert.match(display, /(serif|sans-serif)$/, `${trade}: ${display}`);
    assert.ok(/Georgia|Helvetica|Arial|-apple-system/.test(display),
      `${trade} needs a real system fallback, got: ${display}`);
  }
});

test('the headline uses the word a customer would say, not the register\'s', () => {
  assert.equal(shortTrade('Vehicle maintenance and repair'), 'Servicing & MOT');
  assert.equal(shortTrade('Hairdressing and beauty'), 'Hair & beauty');
  assert.equal(shortTrade('Plumbing, heating and air conditioning'), 'Plumbing & heating');
  // Already short ones are left alone.
  assert.equal(shortTrade('Roofing'), 'Roofing');
  assert.equal(shortTrade('Landscaping'), 'Landscaping');
});

test('an unmapped trade is still shortened enough to fit a headline', () => {
  const out = shortTrade('Some Extremely Long Unmapped Trade Description Here');
  assert.ok(out.split(/\s+/).length <= 4, `too long for an H1: "${out}"`);
  assert.equal(shortTrade(''), null);
  assert.equal(shortTrade(null), null);
});

test('a long register label does not run the headline past two lines', () => {
  const html = renderSite({
    ...brief,
    trade: 'Vehicle maintenance and repair',
    areas: ['Dudley'],
  })['index.html'];
  const h1 = html.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '';
  assert.equal(h1, 'Servicing &amp; MOT in Dudley');
  assert.ok(!html.includes('<h1>Vehicle maintenance and repair'),
    'the raw register label must not reach the headline');
});

test('the font stylesheet is requested from the origin the CSP allows', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2/);
  assert.match(html, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/);
});

test('two different sectors produce visibly different markup, not just CSS vars', () => {
  const salon  = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  const garage = renderSite({ ...brief, trade: 'Vehicle maintenance and repair' })['index.html'];
  assert.notEqual(salon, garage);
  assert.ok(salon.includes('Cormorant'), 'salon should ask for its serif');
  assert.ok(garage.includes('Chakra'), 'garage should ask for its technical face');
  // Check the HEADING rule, not the page: .eyebrow is uppercase in every
  // theme, so a bare substring search says nothing.
  const headingCase = (html) =>
    html.match(/h1,h2\{[^}]*text-transform:([a-z]+)/)?.[1] ?? null;
  assert.equal(headingCase(garage), 'uppercase', 'garage headlines are set uppercase');
  assert.equal(headingCase(salon), 'none', 'a salon headline is not shouted');
});

/* --------------------------------------------------------- hero artwork */

test('every sector gets its own piece of hero art', () => {
  const trades = ['Roofing', 'Vehicle maintenance and repair', 'Landscaping',
                  'Hairdressing and beauty', 'Bakeries', 'Florists',
                  'Cleaning of buildings', 'Architecture'];
  const marks = trades.map((t) => {
    const html = renderSite({ ...brief, trade: t })['index.html'];
    return html.match(/<svg class="art"[\s\S]*?<\/svg>/)?.[0] ?? null;
  });
  assert.ok(marks.every(Boolean), 'every sector needs art');
  assert.equal(new Set(marks).size, trades.length, 'no two sectors share a drawing');
});

test('the art is inline SVG — no request, and nothing to block', () => {
  const html = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  assert.match(html, /<svg class="art"/);
  // An <img> would need img-src and could fail; the point of inline is that
  // it cannot.
  assert.ok(!/<img/i.test(html), 'art must not be an external image');
  assert.ok(!/<script/i.test(html), 'and must not need a script to animate');
});

test('the art is hidden from assistive tech — it carries no information', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /<svg class="art"[^>]*aria-hidden="true"/);
  assert.match(html, /<svg class="art"[^>]*focusable="false"/);
});

test('the art is dropped on a phone, where the screen is worth more', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /@media \(max-width:900px\)\{[\s\S]*?\.hero-art\{display:none\}/);
});

test('the art inherits the palette rather than shipping a second asset', () => {
  const html = renderSite({ ...brief, trade: 'Vehicle maintenance and repair' })['index.html'];
  const art = html.match(/<svg class="art"[\s\S]*?<\/svg>/)[0];
  assert.match(art, /stroke="currentColor"/, 'strokes must inherit');
  assert.match(html, /\.art\{[^}]*color:var\(--accent\)/);
});

test('a long headline still fits beside the art', () => {
  // The art column halves the space the headline has. Sizes calibrated for
  // a full-width hero overflow instead of wrapping.
  const html = renderSite({
    ...brief, trade: 'Hairdressing and beauty', areas: ['Wolverhampton'],
  })['index.html'];
  assert.match(html, /\.hero h1\{max-width:14ch;overflow-wrap:break-word/);
  const size = html.match(/h1\{font-size:clamp\([^,]+,([\d.]+)vw/)?.[1];
  assert.ok(Number(size) <= 6, `headline scales too fast for a half column: ${size}vw`);
});

test('the artwork is drawn as objects, not as bare strokes', () => {
  // Line art of even width reads as a diagram. A blade, a tyre and a leaf
  // only look like themselves when they have a filled body.
  for (const trade of ['Hairdressing and beauty', 'Vehicle maintenance and repair',
                       'Roofing', 'Landscaping', 'Florists']) {
    const html = renderSite({ ...brief, trade })['index.html'];
    const art = html.match(/<svg class="art"[\s\S]*?<\/svg>/)[0];
    assert.match(art, /fill="currentColor"/, `${trade} art has no filled body`);
  }
});

test('the wheel has tread and shaped spokes, not concentric circles', () => {
  const art = renderSite({ ...brief, trade: 'Vehicle maintenance and repair' })['index.html']
    .match(/<svg class="art"[\s\S]*?<\/svg>/)[0];
  assert.match(art, /stroke-dasharray="9 20"/, 'the tyre needs tread blocks');
  // Five spokes drawn as wedges, each an arc-capped path rather than a line.
  assert.equal((art.match(/A104 104 0 0 1/g) ?? []).length, 5, 'five shaped spokes');
});

test('the scissors have two blades crossing at a screw', () => {
  const art = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html']
    .match(/<svg class="art"[\s\S]*?<\/svg>/)[0];
  assert.ok(art.includes('class="blade-a"') && art.includes('class="blade-b"'));
  // Finger loops below the pivot; blades above. If the loops end up on top
  // the whole thing reads as a slingshot.
  const loops = [...art.matchAll(/<ellipse cx="\d+" cy="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(loops.length, 2, 'two finger loops');
  assert.ok(loops.every((y) => y > 160), `loops must sit below the pivot, got ${loops}`);
});

test('nothing animated is left with a zero-length or paused animation', () => {
  // A keyframe set with no animation referencing it is dead decoration.
  for (const trade of ['Hairdressing and beauty', 'Vehicle maintenance and repair',
                       'Roofing', 'Landscaping', 'Bakeries', 'Cleaning of buildings',
                       'Florists', 'Architecture']) {
    const html = renderSite({ ...brief, trade })['index.html'];
    const names = [...html.matchAll(/@keyframes ([a-z-]+)\{/g)].map((m) => m[1]);
    for (const n of names) {
      assert.ok(new RegExp(`animation:[^;]*\\b${n}\\b`).test(html)
             || new RegExp(`animation-name:[^;]*\\b${n}\\b`).test(html),
        `${trade}: @keyframes ${n} is never used`);
    }
  }
});

/* ------------------------------------------------------------ light mode */

test('a salon renders on a light ground, not a dark one', () => {
  // Hair and beauty sites live in warm white, cream and soft black. A dark
  // ground with a hot accent reads as a bar, not a salon.
  const p = resolvePalette('Hairdressing and beauty', []);
  assert.equal(p.mode, 'light');
  const lum = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3;
  };
  assert.ok(lum(p.ground) > 220, `ground should be near-white, got ${p.ground}`);
  assert.ok(lum(p.ink) < 60, `type should be near-black, got ${p.ink}`);
});

test('light mode changes the treatment, not just the colours', () => {
  const salon = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  const roofer = renderSite({ ...brief, trade: 'Roofing' })['index.html'];

  // Text on cream must be ink, not white-on-white.
  assert.match(salon, /\.hero\{[^}]*color:var\(--ink\)/);
  assert.match(roofer, /\.hero\{[^}]*color:#fff/);
  // The mesh and grain have to be quieter on a light ground or they stain it.
  assert.match(salon, /filter:blur\(70px\);opacity:\.32/);
  assert.match(roofer, /filter:blur\(70px\);opacity:\.55/);
  assert.match(salon, /mix-blend-mode:multiply/);
  assert.match(roofer, /mix-blend-mode:overlay/);
});

test('every theme still declares a mode, so none renders undefined', () => {
  for (const trade of ['Roofing', 'Vehicle maintenance and repair', 'Landscaping',
                       'Hairdressing and beauty', 'Bakeries', 'Florists',
                       'Cleaning of buildings', 'Architecture']) {
    const p = resolvePalette(trade, []);
    assert.ok(['light', 'dark'].includes(p.mode), `${trade}: ${p.mode}`);
    assert.match(p.ground, /^#[0-9a-f]{6}$/i, `${trade} ground: ${p.ground}`);
    const html = renderSite({ ...brief, trade })['index.html'];
    assert.ok(!html.includes('undefined'), `${trade} leaked undefined`);
  }
});

/* ------------------------------------------------- what each trade needs */

test('a salon gets a price list, a roofer gets areas covered', () => {
  // Identical sections for every sector is the fastest way to look like a
  // template. A salon's most-visited page is its prices; a mobile trade
  // lives on which towns it covers.
  const salon = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  assert.ok(salon.includes('id="prices"'), 'a salon needs a price list');
  assert.ok(salon.includes('id="hours"'), 'and opening hours');

  const roofer = renderSite({ ...brief, trade: 'Roofing' })['index.html'];
  assert.ok(roofer.includes('id="areas"'), 'a roofer needs its areas');
  assert.ok(!roofer.includes('id="prices"'), 'a roofer does not publish a price list');
});

test('the price list is set in their own service names', () => {
  const html = renderSite({
    ...brief, trade: 'Hairdressing and beauty',
    services: ['Cut and blow dry', 'Balayage'],
  })['index.html'];
  assert.ok(html.includes('>Cut and blow dry<'));
  assert.ok(html.includes('>Balayage<'));
  // Blank, not invented — a made-up price on someone's own site is a lie.
  assert.match(html, /from £—/);
});

test('trust markers stay unfilled rather than inventing credentials', () => {
  const html = renderSite({ ...brief, trade: 'Roofing' })['index.html'];
  assert.ok(html.includes('id="trust"'));
  // Nothing that asserts a body, a number of years, or cover we cannot know.
  assert.ok(!/Gas Safe|NICEIC|Checkatrade|\d+ years/i.test(html),
    'must not fabricate an accreditation or a track record');
});

test('the nav is built from what the page actually contains', () => {
  const salon = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  assert.ok(salon.includes('href="#prices"'), 'nav must link to the price list');
  const roofer = renderSite({ ...brief, trade: 'Roofing' })['index.html'];
  assert.ok(roofer.includes('href="#areas"'));
  assert.ok(!roofer.includes('href="#prices"'), 'no link to a section that is not there');
});

test('the nav never grows past six items', () => {
  for (const trade of ['Hairdressing and beauty', 'Roofing', 'Bakeries', 'Architecture']) {
    const html = renderSite({ ...brief, trade })['index.html'];
    const nav = html.match(/<nav>([\s\S]*?)<\/nav>/)[1];
    const count = (nav.match(/<a /g) ?? []).length;
    assert.ok(count <= 6, `${trade} nav has ${count} items`);
  }
});

test('every anchored nav link points at a section that exists', () => {
  for (const trade of ['Hairdressing and beauty', 'Vehicle maintenance and repair',
                       'Roofing', 'Landscaping', 'Bakeries', 'Florists',
                       'Cleaning of buildings', 'Architecture']) {
    const html = renderSite({ ...brief, trade })['index.html'];
    const nav = html.match(/<nav>([\s\S]*?)<\/nav>/)[1];
    for (const m of nav.matchAll(/href="#([a-z]+)"/g)) {
      assert.ok(html.includes(`id="${m[1]}"`), `${trade}: nav links to missing #${m[1]}`);
    }
  }
});

test('a phone lead gets a call bar always within reach', () => {
  const html = renderSite(brief)['index.html'];
  assert.match(html, /<a class="call-bar" href="tel:07123456789"/);
  assert.match(html, /@media \(max-width:720px\)\{[\s\S]*?\.call-bar\{display:flex;position:fixed/);
  // And the footer has to clear it, or the last line sits under the bar.
  assert.match(html, /footer\{padding-bottom:96px\}/);
});

test('no call bar when there is no dialable number', () => {
  const html = renderSite({ ...brief, phone: null })['index.html'];
  assert.ok(!html.includes('class="call-bar"'));
});

test('the mobile nav stays on one line instead of stacking', () => {
  // Six links wrap to two rows on a 390px screen and push the hero down.
  const html = renderSite({ ...brief, trade: 'Hairdressing and beauty' })['index.html'];
  assert.match(html, /nav\{width:100%;margin-left:0;order:3;gap:20px;\s*flex-wrap:nowrap;overflow-x:auto/);
});
