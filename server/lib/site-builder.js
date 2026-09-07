/**
 * Generate a mockup site from a brief.
 *
 * ONE PAGE by default — hero, services, work, about, contact, as anchored
 * sections down a single scroll. That is the shape that closes small-trade
 * work: a caller wants the number, proof the work is decent, and the area
 * covered. More pages give them more chances to get lost on a phone.
 *
 * `pages: 'multi'` still produces the four-file version for a job that
 * genuinely warrants it.
 *
 * Design intent: this has to look like a real small-business site a local
 * designer made, not a template with the name swapped. The things that do
 * that cheaply are a trade-appropriate palette, real copy about the actual
 * services, the phone number treated as the most important element on the
 * page, and honest placeholders where their photos will go — an obviously
 * empty photo slot reads better than a stock image of someone else's van.
 *
 * Everything is inlined: one CSS block per page, no build step, no external
 * fonts or scripts. The result opens straight from disk.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CTA_LABEL } from './brief.js';

/* -------------------------------------------------------------- palettes */

/**
 * Palette per trade family. Trades carry real colour conventions — roofers
 * and builders read as slate and high-vis; beauty reads as soft and warm;
 * food reads as appetite-warm. Picking by trade is what stops every
 * generated site looking like the same template.
 */
const PALETTES = {
  building: { ink: '#16202b', accent: '#c2410c', wash: '#f4f2ef', line: '#dcd6cd', muted: '#5b6673' },
  motor:    { ink: '#111827', accent: '#b91c1c', wash: '#f3f4f6', line: '#d8dbe0', muted: '#565e6b' },
  green:    { ink: '#14281d', accent: '#2f7a45', wash: '#f2f5f0', line: '#d5ded3', muted: '#54655a' },
  beauty:   { ink: '#2b1f26', accent: '#a8567a', wash: '#faf5f6', line: '#e8d9de', muted: '#6b5560' },
  food:     { ink: '#241a12', accent: '#9a3412', wash: '#fbf6ef', line: '#e6dbc9', muted: '#6b5b48' },
  retail:   { ink: '#1c1f2b', accent: '#4f46e5', wash: '#f5f5f8', line: '#dcdce4', muted: '#5c6070' },
  clean:    { ink: '#0f2430', accent: '#0e7490', wash: '#f1f6f8', line: '#d2e0e5', muted: '#4f6672' },
  pro:      { ink: '#141c2b', accent: '#1d4ed8', wash: '#f4f6fa', line: '#d9dfea', muted: '#556074' },
};

/**
 * Which family a trade belongs to. First match wins, so the order is the
 * rule: the narrow patterns must come before the broad ones. "Cleaning of
 * buildings" contains "build" and would otherwise be filed as a builder.
 */
const FAMILY_PATTERNS = [
  // Narrow first — these contain words the broader patterns also match.
  [/clean|chimney|pest|drain|waste|removal|laundr|launder/i, 'clean'],
  [/landscap|garden|tree surg|arbor|fenc|paving|driveway|grass|turf|shed|lawn/i, 'green'],
  [/hair|barber|beauty|nail|salon|tattoo|massage|spa\b|lash|brow|aesthet|osteo|chiro|physio|therap|wellbeing|holistic|acupunc|reflexo/i, 'beauty'],
  [/cafe|restaurant|takeaway|caterin|baker|butcher|fishmonger|deli|food|coffee|chip shop/i, 'food'],
  [/garage|mechanic|\bmot\b|vehicle|motorcycle|tyre|valet|driving|bodyshop/i, 'motor'],
  [/florist|jewel|bookshop|boutique|gift shop|furniture shop|market stall|retail|clothing/i, 'retail'],
  [/architect|interior design|photograph|translat|tutor|coach|wedding planner|event/i, 'pro'],
  // Broad last.
  [/roof|build|plaster|joiner|carpent|brick|stone|scaffold|glaz|window|kitchen|bathroom|tile|floor|paint|decorat|electric|plumb|heating|gas|damp|dryline|ground|demolit|solar|heat pump|handyman|construc/i, 'building'],
];

export function tradeFamily(trade) {
  const s = String(trade ?? '');
  for (const [re, family] of FAMILY_PATTERNS) if (re.test(s)) return family;
  return 'pro';
}

/**
 * Resolve the palette. A brand colour the prospect actually named always
 * wins over the trade default — they told us what they wanted, and ignoring
 * that is the fastest way to have the mockup rejected.
 */
const NAMED_COLOURS = {
  red: '#b91c1c', blue: '#1d4ed8', navy: '#1e3a5f', green: '#2f7a45',
  'dark green': '#1f5130', black: '#111827', grey: '#4b5563', gray: '#4b5563',
  silver: '#6b7280', gold: '#a16207', yellow: '#ca8a04', orange: '#c2410c',
  purple: '#6d28d9', teal: '#0f766e', turquoise: '#0e7490', maroon: '#7f1d1d',
  burgundy: '#7f1d1d', brown: '#78350f', pink: '#be185d', cream: '#a16207',
  beige: '#8a7355', white: '#374151',
};

export function resolvePalette(trade, brandColours = []) {
  const base = { ...PALETTES[tradeFamily(trade)] };
  for (const raw of brandColours) {
    const c = String(raw).trim().toLowerCase();
    if (/^#[0-9a-f]{3,8}$/i.test(c)) { base.accent = c; return base; }
    if (NAMED_COLOURS[c]) { base.accent = NAMED_COLOURS[c]; return base; }
  }
  return base;
}

/* ------------------------------------------------------------ escaping */

/**
 * Everything written into the page comes from a prospect's email, so it is
 * untrusted: escaped on the way in, always. A reply containing a <script>
 * tag must render as text, not run.
 */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** For a value going into an href/attribute where only safe schemes are ok. */
export function safeUrl(v) {
  const s = String(v ?? '').trim();
  return /^(https?:|mailto:|tel:)/i.test(s) ? esc(s) : '#';
}

/**
 * A `tel:` href built from a phone number of unknown provenance.
 *
 * Phone numbers reach this module from Google Places and from pages the
 * contact-finder scraped, so they are attacker-influenced. Interpolating one
 * straight into an attribute lets a value like `" onmouseover="alert(1)`
 * close the href and open an event handler. Everything but digits and a
 * leading + is dropped, which no legitimate number needs anyway.
 *
 * Returns null when nothing dialable is left, so callers omit the link
 * rather than emitting an empty one.
 */
export function telHref(phone) {
  const raw = String(phone ?? '').trim();
  const plus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${plus ? '+' : ''}${digits}`;
}

/** A `mailto:` href, or null. Same reasoning as telHref. */
export function mailtoHref(email) {
  const s = String(email ?? '').trim();
  if (!/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/.test(s)) return null;
  return `mailto:${esc(s)}`;
}

/* --------------------------------------------------------------- copy */

/** The hero line. Trade plus town is what a local search actually wants. */
function headline(b) {
  const where = b.areas?.[0];
  const trade = b.trade ?? b.services?.[0] ?? 'Local specialists';
  return where ? `${trade} in ${where}` : String(trade);
}

function subhead(b) {
  const list = (b.services ?? []).slice(0, 3).join(' · ');
  const where = b.areas?.length
    ? (b.areas.length > 1
        ? `Covering ${b.areas.slice(0, -1).join(', ')} and ${b.areas.at(-1)}.`
        : `Covering ${b.areas[0]} and the surrounding area.`)
    : '';
  return [list, where].filter(Boolean).join(' — ');
}

/** The primary action, rendered as a real link where we can. */
function primaryAction(b, { single = false } = {}) {
  const label = CTA_LABEL[b.primary_cta] ?? 'Get in touch';
  const to = (anchor, page) => (single ? anchor : page);
  switch (b.primary_cta) {
    case 'call': {
      const href = telHref(b.phone);
      return href
        ? { label: `Call ${b.phone}`, href }
        : { label, href: to('#contact', 'contact.html') };
    }
    case 'prices':   return { label, href: to('#services', 'services.html') };
    case 'gallery':  return { label, href: to('#work', 'about.html') };
    default:         return { label, href: to('#contact', 'contact.html') };
  }
}

/* --------------------------------------------------------------- chrome */

/** Multi-page nav (kept for the four-file build). */
const NAV = [
  ['index.html', 'Home'],
  ['services.html', 'Services'],
  ['about.html', 'About'],
  ['contact.html', 'Contact'],
];

/**
 * Single-page nav. The whole site is one scroll, so these are anchors.
 * A one-pager is what actually closes small-trade work: everything a
 * caller needs is above the fold or one flick away, and there is no
 * navigation for someone to get lost in on a phone.
 */
const ANCHORS = [
  ['#services', 'Services'],
  ['#work', 'Our work'],
  ['#about', 'About'],
  ['#contact', 'Contact'],
];

function css(p) {
  return `
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --ink:${p.ink}; --accent:${p.accent}; --wash:${p.wash};
    --line:${p.line}; --muted:${p.muted};
  }
  body{margin:0;background:#fff;color:var(--ink);
    font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  h1,h2,h3{line-height:1.15;margin:0 0 .5em;font-weight:700;letter-spacing:-.02em}
  h1{font-size:clamp(2rem,5vw,3.2rem)}
  h2{font-size:clamp(1.4rem,3vw,2rem)}
  h3{font-size:1.1rem}
  p{margin:0 0 1em}
  a{color:var(--accent)}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}

  header{border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:10}
  .bar{display:flex;align-items:center;gap:24px;min-height:72px;flex-wrap:wrap}
  .brand{font-weight:800;font-size:1.15rem;letter-spacing:-.02em;text-decoration:none;color:var(--ink)}
  .brand span{color:var(--accent)}
  nav{margin-left:auto;display:flex;gap:22px;flex-wrap:wrap}
  nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:.95rem}
  nav a:hover,nav a[aria-current]{color:var(--accent)}
  .tel{background:var(--accent);color:#fff;padding:10px 18px;border-radius:6px;
    text-decoration:none;font-weight:700;white-space:nowrap}

  .hero{background:var(--wash);border-bottom:1px solid var(--line);padding:72px 0 64px}
  .hero p.lede{font-size:1.15rem;color:var(--muted);max-width:56ch;margin-bottom:28px}
  .cta{display:inline-block;background:var(--accent);color:#fff;padding:15px 28px;
    border-radius:6px;text-decoration:none;font-weight:700;font-size:1.05rem}
  .cta.ghost{background:transparent;color:var(--accent);
    box-shadow:inset 0 0 0 2px var(--accent);margin-left:10px}

  section{padding:64px 0}
  section.alt{background:var(--wash);border-block:1px solid var(--line)}
  .grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
  .card{border:1px solid var(--line);border-radius:8px;padding:24px;background:#fff}
  .card h3{margin-bottom:.35em}
  .card p{color:var(--muted);margin:0;font-size:.95rem}

  .shot{border:2px dashed var(--line);border-radius:8px;background:var(--wash);
    min-height:200px;display:flex;align-items:center;justify-content:center;
    color:var(--muted);font-size:.9rem;text-align:center;padding:20px}

  .split{display:grid;gap:40px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-items:start}
  .facts{list-style:none;padding:0;margin:0}
  .facts li{padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:14px}
  .facts li:last-child{border-bottom:0}
  .facts b{min-width:88px;color:var(--muted);font-weight:600}

  .band{background:var(--ink);color:#fff;padding:52px 0;text-align:center}
  .band h2{color:#fff}
  .band p{color:rgba(255,255,255,.75);max-width:50ch;margin:0 auto 24px}
  .band .cta{background:#fff;color:var(--ink)}
  .band .cta.ghost{background:transparent;color:#fff;
    box-shadow:inset 0 0 0 2px rgba(255,255,255,.55)}

  footer{border-top:1px solid var(--line);padding:32px 0;color:var(--muted);font-size:.9rem}
  footer .bar{min-height:0;gap:16px}

  .draft{background:#fffbe6;border-bottom:1px solid #f0e2a8;color:#6b5a12;
    font-size:.85rem;padding:8px 0;text-align:center}
  @media (max-width:640px){
    nav{width:100%;margin-left:0;order:3}
    section{padding:44px 0}
    .hero{padding:48px 0 44px}
  }`;
}

function page({ title, brief, palette, current, body, draftNote, single = false }) {
  const b = brief;
  const tel = telHref(b.phone);
  const mail = mailtoHref(b.email);
  const links = single ? ANCHORS : NAV;
  const home = single ? '#top' : 'index.html';
  const brandParts = String(b.business_name).trim().split(/\s+/);
  const brandHtml = brandParts.length > 1
    ? `${esc(brandParts.slice(0, -1).join(' '))} <span>${esc(brandParts.at(-1))}</span>`
    : esc(b.business_name);

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${single ? esc(b.business_name) : `${esc(title)} — ${esc(b.business_name)}`}</title>
<meta name="description" content="${esc(subhead(b)).slice(0, 155)}">
<meta name="robots" content="noindex,nofollow">
<style>${css(palette)}</style>
</head>
<body id="top">
${draftNote ? `<div class="draft">${esc(draftNote)}</div>` : ''}
<header>
  <div class="wrap bar">
    <a class="brand" href="${home}">${brandHtml}</a>
    <nav>
      ${links.map(([href, label]) =>
        `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ')}
    </nav>
    ${tel ? `<a class="tel" href="${tel}">${esc(b.phone)}</a>` : ''}
  </div>
</header>
${body}
<footer>
  <div class="wrap bar">
    <div><strong>${esc(b.business_name)}</strong>${b.areas?.length ? ` — ${esc(b.areas.join(', '))}` : ''}
      ${b.registered_name && b.registered_name !== b.business_name
        ? `<div style="font-size:.85em;opacity:.75">A trading name of ${esc(b.registered_name)}</div>` : ''}
    </div>
    <div style="margin-left:auto">
      ${tel ? `<a href="${tel}">${esc(b.phone)}</a>` : esc(b.phone ?? '')}
      ${mail ? ` · <a href="${mail}">${esc(b.email)}</a>` : ''}
    </div>
  </div>
</footer>
</body>
</html>`;
}

/* ---------------------------------------------------------------- pages */

function homeBody(b) {
  const action = primaryAction(b);
  const services = (b.services ?? []).slice(0, 6);
  return `
<div class="hero">
  <div class="wrap">
    <h1>${esc(headline(b))}</h1>
    <p class="lede">${esc(subhead(b))}</p>
    <a class="cta" href="${safeUrl(action.href) === '#' ? esc(action.href) : safeUrl(action.href)}">${esc(action.label)}</a>
    ${b.primary_cta !== 'call' && telHref(b.phone)
      ? `<a class="cta ghost" href="${telHref(b.phone)}">Or call ${esc(b.phone)}</a>` : ''}
  </div>
</div>

<section>
  <div class="wrap">
    <h2>What we do</h2>
    <div class="grid">
      ${services.map((s) => `<div class="card">
        <h3>${esc(s)}</h3>
        <p>${esc(serviceBlurb(s, b))}</p>
      </div>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap split">
    <div>
      <h2>Recent work</h2>
      <p>${b.has_photos
        ? 'Photos of your recent jobs go here — send them over and I will drop them in.'
        : 'A few photos of finished jobs go here. Phone photos are fine — real work sells better than stock images.'}</p>
    </div>
    <div class="shot">Photo of your work<br>(placeholder)</div>
  </div>
</section>

<div class="band">
  <div class="wrap">
    <h2>${esc(bandHeading(b))}</h2>
    <p>${esc(bandCopy(b))}</p>
    <a class="cta" href="${(b.primary_cta === 'call' && telHref(b.phone)) || 'contact.html'}">${esc(action.label)}</a>
  </div>
</div>`;
}

function servicesBody(b) {
  const services = b.services ?? [];
  return `
<div class="hero">
  <div class="wrap">
    <h1>Services</h1>
    <p class="lede">${esc(subhead(b))}</p>
  </div>
</div>

<section>
  <div class="wrap">
    ${services.map((s, i) => `
    <div class="split" style="${i ? 'margin-top:48px;padding-top:48px;border-top:1px solid var(--line)' : ''}">
      <div>
        <h2>${esc(s)}</h2>
        <p>${esc(serviceBlurb(s, b))}</p>
        <p><a href="contact.html">Ask about ${esc(s.toLowerCase())}</a></p>
      </div>
      <div class="shot">Photo — ${esc(s)}<br>(placeholder)</div>
    </div>`).join('\n')}
  </div>
</section>

<div class="band">
  <div class="wrap">
    <h2>Not sure which you need?</h2>
    <p>Tell us what the job is and we will tell you straight.</p>
    <a class="cta" href="contact.html">Get in touch</a>
  </div>
</div>`;
}

function aboutBody(b) {
  const where = b.areas?.length ? b.areas.join(', ') : 'the local area';
  return `
<div class="hero">
  <div class="wrap">
    <h1>About ${esc(b.business_name)}</h1>
    <p class="lede">${esc(`${b.trade ?? 'Local trade'} serving ${where}.`)}</p>
  </div>
</div>

<section>
  <div class="wrap split">
    <div>
      <h2>Who we are</h2>
      <p>This is where your own words go — how long you have been going, what
         you are known for locally, who you usually work for. A short honest
         paragraph beats a page of marketing copy.</p>
      <p>${esc(`We cover ${where}.`)}</p>
      ${b.notes ? `<p>${esc(b.notes)}</p>` : ''}
    </div>
    <div>
      <h2>At a glance</h2>
      <ul class="facts">
        <li><b>Trade</b> <span>${esc(b.trade ?? (b.services ?? [])[0] ?? '—')}</span></li>
        <li><b>Area</b> <span>${esc(where)}</span></li>
        ${b.phone ? `<li><b>Phone</b> <span>${esc(b.phone)}</span></li>` : ''}
        ${b.email ? `<li><b>Email</b> <span>${esc(b.email)}</span></li>` : ''}
      </ul>
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <h2>Our work</h2>
    <div class="grid">
      ${[1, 2, 3].map((n) => `<div class="shot">Job photo ${n}<br>(placeholder)</div>`).join('\n      ')}
    </div>
  </div>
</section>`;
}

function contactBody(b) {
  const tel = telHref(b.phone);
  const mail = mailtoHref(b.email);
  return `
<div class="hero">
  <div class="wrap">
    <h1>Get in touch</h1>
    <p class="lede">${tel
      ? `The quickest way to reach us is a call on ${esc(b.phone)}.`
      : 'Send us a message and we will come back to you.'}</p>
    ${tel ? `<a class="cta" href="${tel}">Call ${esc(b.phone)}</a>` : ''}
  </div>
</div>

<section>
  <div class="wrap split">
    <div>
      <h2>Details</h2>
      <ul class="facts">
        ${tel ? `<li><b>Phone</b> <span><a href="${tel}">${esc(b.phone)}</a></span></li>` : ''}
        ${mail ? `<li><b>Email</b> <span><a href="${mail}">${esc(b.email)}</a></span></li>` : ''}
        ${b.areas?.length ? `<li><b>Area</b> <span>${esc(b.areas.join(', '))}</span></li>` : ''}
        <li><b>Hours</b> <span>Your opening hours go here</span></li>
      </ul>
    </div>
    <div>
      <h2>Send a message</h2>
      <p style="color:var(--muted);font-size:.95rem">
        A working enquiry form goes here on the real site — it emails straight
        to you, no logins, no dashboard to check.
      </p>
      <div class="shot" style="min-height:240px">Enquiry form<br>(placeholder)</div>
    </div>
  </div>
</section>`;
}

/* -------------------------------------------------------- copy helpers */

function serviceBlurb(service, b) {
  const where = b.areas?.[0];
  const s = String(service).toLowerCase();
  return where
    ? `${service} across ${where} and nearby. A line or two here about how you approach ${s} — this is your copy to change.`
    : `${service}. A line or two here about how you approach ${s} — this is your copy to change.`;
}

const BAND = {
  call:    ['Need it looking at?', 'Give us a ring and we will tell you what is involved.'],
  quote:   ['Want a price?', 'Tell us about the job and we will get a quote back to you.'],
  book:    ['Ready to book?', 'Pick a time that suits and we will confirm it.'],
  prices:  ['Want to know what it costs?', 'Our prices are straightforward — no surprises at the end.'],
  gallery: ['Seen something you like?', 'Have a look at what we have done and get in touch.'],
  enquire: ['Got a question?', 'Send it over and we will come back to you.'],
};
const bandHeading = (b) => (BAND[b.primary_cta] ?? BAND.enquire)[0];
const bandCopy    = (b) => (BAND[b.primary_cta] ?? BAND.enquire)[1];

/* --------------------------------------------------------------- build */

export const PAGES = ['index.html', 'services.html', 'about.html', 'contact.html'];
export const SINGLE_PAGE = ['index.html'];

/** A 32-character token. This is the only thing protecting the preview URL. */
export const newToken = () => randomBytes(16).toString('hex');

/**
 * The whole site as one scrolling page.
 *
 * This is the default, and for small-trade work it is the right shape: a
 * caller wants the number, proof the work is decent, and the area covered.
 * Four pages gives them three chances to get lost on a phone and adds
 * nothing they asked for. It also reviews faster — one screenshot and the
 * prospect has seen everything.
 */
function singleBody(b) {
  const action = primaryAction(b, { single: true });
  const services = b.services ?? [];
  const where = b.areas?.length ? b.areas.join(', ') : 'the local area';
  const tel = telHref(b.phone);
  const mail = mailtoHref(b.email);

  return `
<div class="hero">
  <div class="wrap">
    <h1>${esc(headline(b))}</h1>
    <p class="lede">${esc(subhead(b))}</p>
    <a class="cta" href="${action.href}">${esc(action.label)}</a>
    ${b.primary_cta !== 'call' && tel
      ? `<a class="cta ghost" href="${tel}">Or call ${esc(b.phone)}</a>` : ''}
  </div>
</div>

<section id="services">
  <div class="wrap">
    <h2>What we do</h2>
    <div class="grid">
      ${services.slice(0, 6).map((sv) => `<div class="card">
        <h3>${esc(sv)}</h3>
        <p>${esc(serviceBlurb(sv, b))}</p>
      </div>`).join('\n      ')}
    </div>
  </div>
</section>

<section id="work" class="alt">
  <div class="wrap">
    <h2>Recent work</h2>
    <p style="max-width:60ch;color:var(--muted)">${
      b.has_photos
        ? 'Photos of your recent jobs go here — send them over and I will drop them in.'
        : 'A few photos of finished jobs go here. Phone photos are fine — real work sells '
          + 'far better than stock images.'}</p>
    <div class="grid" style="margin-top:20px">
      ${[1, 2, 3].map((n) => `<div class="shot">Job photo ${n}<br>(placeholder)</div>`).join('\n      ')}
    </div>
  </div>
</section>

<section id="about">
  <div class="wrap split">
    <div>
      <h2>About ${esc(b.business_name)}</h2>
      <p>Your own words go here — how long you have been going, what you are
         known for locally, who you usually work for. A short honest paragraph
         beats a page of marketing copy.</p>
      <p>${esc(`We cover ${where}.`)}</p>
      ${b.notes ? `<p>${esc(b.notes)}</p>` : ''}
    </div>
    <div>
      <h2>At a glance</h2>
      <ul class="facts">
        <li><b>Trade</b> <span>${esc(b.trade ?? services[0] ?? '—')}</span></li>
        <li><b>Area</b> <span>${esc(where)}</span></li>
        ${tel ? `<li><b>Phone</b> <span>${esc(b.phone)}</span></li>` : ''}
        ${mail ? `<li><b>Email</b> <span>${esc(b.email)}</span></li>` : ''}
      </ul>
    </div>
  </div>
</section>

<div class="band" id="contact">
  <div class="wrap">
    <h2>${esc(bandHeading(b))}</h2>
    <p>${esc(bandCopy(b))}</p>
    ${tel ? `<a class="cta" href="${tel}">Call ${esc(b.phone)}</a>` : ''}
    ${mail ? `<a class="cta ghost" href="${mail}">Email us</a>` : ''}
  </div>
</div>

<section>
  <div class="wrap split">
    <div>
      <h2>Get in touch</h2>
      <ul class="facts">
        ${tel ? `<li><b>Phone</b> <span><a href="${tel}">${esc(b.phone)}</a></span></li>` : ''}
        ${mail ? `<li><b>Email</b> <span><a href="${mail}">${esc(b.email)}</a></span></li>` : ''}
        <li><b>Area</b> <span>${esc(where)}</span></li>
        <li><b>Hours</b> <span>Your opening hours go here</span></li>
      </ul>
    </div>
    <div>
      <h2>Send a message</h2>
      <p style="color:var(--muted);font-size:.95rem">
        A working enquiry form goes here on the real site — it emails straight
        to you, no logins, no dashboard to check.
      </p>
      <div class="shot" style="min-height:200px">Enquiry form<br>(placeholder)</div>
    </div>
  </div>
</section>`;
}

/**
 * Render the site. Pure — returns a map of filename to HTML and writes
 * nothing, so tests can assert on output without a filesystem.
 *
 * `pages: 'single'` (the default) produces one index.html carrying every
 * section. `pages: 'multi'` produces the four-file version.
 */
export function renderSite(brief, { draftNote = null, pages = 'single' } = {}) {
  const palette = resolvePalette(brief.trade ?? (brief.services ?? [])[0], brief.brand_colours ?? []);
  const common = { brief, palette, draftNote };

  if (pages === 'single') {
    return {
      'index.html': page({
        ...common, title: 'Home', current: '#services', single: true, body: singleBody(brief),
      }),
    };
  }

  return {
    'index.html':    page({ ...common, title: 'Home',     current: 'index.html',    body: homeBody(brief) }),
    'services.html': page({ ...common, title: 'Services', current: 'services.html', body: servicesBody(brief) }),
    'about.html':    page({ ...common, title: 'About',    current: 'about.html',    body: aboutBody(brief) }),
    'contact.html':  page({ ...common, title: 'Contact',  current: 'contact.html',  body: contactBody(brief) }),
  };
}

/**
 * Write a rendered site into `<root>/<token>/`. Returns the token and the
 * files written. Overwrites cleanly so a regenerate does not leave orphans.
 */
export function writeSite(root, token, files) {
  const dir = join(root, token);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(files)) {
    writeFileSync(join(dir, name), html, 'utf8');
  }
  return { dir, files: Object.keys(files) };
}
