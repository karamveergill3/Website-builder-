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
  building: { ink: '#0d1520', accent: '#f97316', glow: '#eab308', wash: '#f6f4f1', line: '#e2ddd6', muted: '#5b6673' },
  motor:    { ink: '#0a0d14', accent: '#ef4444', glow: '#f59e0b', wash: '#f5f6f7', line: '#e0e3e7', muted: '#565e6b' },
  green:    { ink: '#0a1811', accent: '#34d399', glow: '#84cc16', wash: '#f4f7f3', line: '#dbe4d9', muted: '#54655a' },
  beauty:   { ink: '#1c1219', accent: '#f472b6', glow: '#a78bfa', wash: '#fbf7f8', line: '#eedde2', muted: '#6b5560' },
  food:     { ink: '#17100a', accent: '#fb923c', glow: '#f43f5e', wash: '#fcf8f2', line: '#ebe1d1', muted: '#6b5b48' },
  retail:   { ink: '#12141f', accent: '#818cf8', glow: '#22d3ee', wash: '#f7f7fa', line: '#e2e2ea', muted: '#5c6070' },
  clean:    { ink: '#07171f', accent: '#22d3ee', glow: '#38bdf8', wash: '#f3f8fa', line: '#d8e6ea', muted: '#4f6672' },
  pro:      { ink: '#0b1120', accent: '#60a5fa', glow: '#a78bfa', wash: '#f6f8fc', line: '#dfe5ef', muted: '#556074' },
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
    const hit = /^#[0-9a-f]{3,8}$/i.test(c) ? c : NAMED_COLOURS[c];
    if (!hit) continue;
    base.accent = hit;
    // The mesh sits on a dark ink, so its second hue has to be LIGHTER than
    // the brand colour or the gradient reads as one lit corner and a flat
    // rest. Lightening keeps the two obviously related.
    base.glow = shade(hit, 0.42);
    return base;
  }
  return base;
}

/**
 * Lighten (amount > 0) or darken (< 0) a hex colour. Used to derive the
 * mesh's second hue from a brand colour so the two always belong together.
 */
export function shade(hex, amount) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  const mix = (channel) => {
    const target = amount < 0 ? 0 : 255;
    const t = Math.abs(amount);
    return Math.round(channel + (target - channel) * t);
  };
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
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

/**
 * The visual layer.
 *
 * Everything here is CSS. The preview is served under `default-src 'none'`
 * because these pages carry text a stranger emailed us, so there is no
 * JavaScript available — and none is needed. Scroll-driven reveals use
 * `animation-timeline`, which is native CSS; where a browser lacks it the
 * content is simply visible, which is the correct fallback.
 *
 * What makes a page read as expensive is not effects, it is restraint:
 * a big type scale, generous space, one confident accent, and motion that
 * responds to the reader rather than looping at them. The mesh drifts
 * slowly enough to notice only if you look.
 */
function css(p) {
  return `
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --ink:${p.ink}; --accent:${p.accent}; --glow:${p.glow ?? p.accent};
    --wash:${p.wash}; --line:${p.line}; --muted:${p.muted};
    --radius:14px;
    --shadow-1:0 1px 2px rgba(15,23,42,.04), 0 4px 12px rgba(15,23,42,.05);
    --shadow-2:0 2px 4px rgba(15,23,42,.05), 0 12px 32px rgba(15,23,42,.09);
    --ease:cubic-bezier(.22,1,.36,1);
  }
  html{scroll-behavior:smooth}
  body{margin:0;background:#fff;color:var(--ink);
    font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}

  /* Type scale — premium sites are not shy with headline size. */
  h1,h2,h3{line-height:1.05;margin:0 0 .4em;font-weight:800;letter-spacing:-.035em}
  h1{font-size:clamp(2.6rem,7vw,5rem)}
  h2{font-size:clamp(1.9rem,4vw,3rem);letter-spacing:-.03em}
  h3{font-size:1.15rem;letter-spacing:-.015em;font-weight:700}
  p{margin:0 0 1.1em}
  a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
  .wrap{max-width:1140px;margin:0 auto;padding:0 28px}
  .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.74rem;
    font-weight:700;color:var(--accent);margin:0 0 18px}

  /* ---------- the animated backdrop ----------
     Three radial gradients on one layer, drifting on long offset cycles so
     the pattern never visibly repeats. GPU-composited transforms only. */
  .mesh{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .mesh::before,.mesh::after{content:"";position:absolute;border-radius:50%;
    filter:blur(70px);opacity:.55;will-change:transform}
  .mesh::before{width:70vw;height:70vw;left:-15vw;top:-25vw;
    background:radial-gradient(circle at 50% 50%,var(--accent),transparent 68%);
    animation:drift-a 26s var(--ease) infinite alternate}
  .mesh::after{width:60vw;height:60vw;right:-12vw;top:-8vw;
    background:radial-gradient(circle at 50% 50%,var(--glow),transparent 66%);
    animation:drift-b 34s var(--ease) infinite alternate}
  @keyframes drift-a{
    from{transform:translate3d(0,0,0) scale(1)}
    to  {transform:translate3d(14vw,10vw,0) scale(1.18)}}
  @keyframes drift-b{
    from{transform:translate3d(0,0,0) scale(1.05)}
    to  {transform:translate3d(-12vw,14vw,0) scale(.9)}}

  /* Film grain. An inline SVG turbulence — no request, no dependency —
     which is what stops a big flat gradient looking like a cheap CSS demo. */
  .grain{position:absolute;inset:0;pointer-events:none;z-index:1;opacity:.42;
    mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")}

  /* ---------- header ---------- */
  header{position:sticky;top:0;z-index:50;
    background:rgba(255,255,255,.78);backdrop-filter:saturate(180%) blur(14px);
    -webkit-backdrop-filter:saturate(180%) blur(14px);
    border-bottom:1px solid var(--line)}

  /* Over the dark hero the header should be part of it, not a grey band
     laid across it. It starts transparent with light text and resolves to
     solid as the hero scrolls away. animation-timeline: scroll() is
     native CSS; without support the header is simply always solid, which
     is the safe state. */
  @supports (animation-timeline: scroll()) {
    /* The header is sticky, so it sits ABOVE the hero in flow rather than
       over it — a transparent header shows the white page behind, not the
       hero. So it starts the same colour as the hero and the two read as
       one block, then resolves to white as the hero scrolls away.
       background-COLOR, not the shorthand: the shorthand does not
       interpolate reliably here. */
    header{background-color:var(--ink);border-bottom-color:transparent;
      animation:header-solid 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    @keyframes header-solid{
      from{background-color:var(--ink);border-bottom-color:rgba(0,0,0,0)}
      to  {background-color:rgba(255,255,255,.92);border-bottom-color:var(--line)}}

    header .brand{animation:brand-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    header nav a{animation:nav-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    header .tel{animation:tel-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    @keyframes brand-on-dark{from{color:#fff}to{color:var(--ink)}}
    @keyframes nav-on-dark{from{color:rgba(255,255,255,.75)}to{color:var(--muted)}}
    @keyframes tel-on-dark{
      from{background-color:rgba(255,255,255,.16)}
      to  {background-color:var(--ink)}}
  }
  .bar{display:flex;align-items:center;gap:26px;min-height:74px;flex-wrap:wrap}
  .brand{font-weight:800;font-size:1.2rem;letter-spacing:-.03em;
    text-decoration:none;color:var(--ink)}
  .brand span{background:linear-gradient(100deg,var(--accent),var(--glow));
    -webkit-background-clip:text;background-clip:text;color:transparent}
  nav{margin-left:auto;display:flex;gap:26px;flex-wrap:wrap}
  nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:.94rem;
    position:relative;transition:color .2s}
  nav a::after{content:"";position:absolute;left:0;right:0;bottom:-6px;height:2px;
    background:var(--accent);transform:scaleX(0);transform-origin:left;
    transition:transform .28s var(--ease)}
  nav a:hover{color:var(--ink)}
  nav a:hover::after,nav a[aria-current]::after{transform:scaleX(1)}
  nav a[aria-current]{color:var(--ink)}
  .tel{background:var(--ink);color:#fff;padding:11px 20px;border-radius:100px;
    text-decoration:none;font-weight:700;white-space:nowrap;font-size:.92rem;
    transition:transform .25s var(--ease),box-shadow .25s var(--ease)}
  .tel:hover{transform:translateY(-2px);box-shadow:var(--shadow-2)}

  /* ---------- hero ---------- */
  .hero{position:relative;isolation:isolate;overflow:hidden;
    background:var(--ink);color:#fff;padding:120px 0 118px;margin-top:-1px}
  .hero .wrap{position:relative;z-index:2}
  .hero h1{max-width:15ch;
    background:linear-gradient(170deg,#fff 30%,rgba(255,255,255,.80));
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p.lede{font-size:clamp(1.05rem,2vw,1.3rem);color:rgba(255,255,255,.72);
    max-width:52ch;margin:26px 0 38px;font-weight:400}
  .hero .eyebrow{color:var(--accent)}

  .cta{display:inline-flex;align-items:center;gap:10px;
    background:var(--accent);color:#0b0b0b;padding:17px 32px;border-radius:100px;
    text-decoration:none;font-weight:700;font-size:1.02rem;letter-spacing:-.01em;
    transition:transform .25s var(--ease),box-shadow .25s var(--ease);
    box-shadow:0 8px 30px -8px var(--accent)}
  .cta:hover{transform:translateY(-3px);box-shadow:0 16px 44px -10px var(--accent)}
  .cta.ghost{background:transparent;color:#fff;box-shadow:none;
    border:1px solid rgba(255,255,255,.28);margin-left:12px}
  .cta.ghost:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.5)}

  /* Service ticker under the hero — motion that carries information. */
  .ticker{position:relative;z-index:2;margin-top:60px;
    border-top:1px solid rgba(255,255,255,.12);padding-top:26px;
    -webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
    mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
    overflow:hidden}
  .ticker-track{display:flex;gap:44px;width:max-content;
    animation:slide 32s linear infinite}
  .ticker span{color:rgba(255,255,255,.5);font-weight:600;white-space:nowrap;
    font-size:.95rem;letter-spacing:.02em}
  .ticker span::before{content:"◆";color:var(--accent);margin-right:14px;font-size:.6em;
    vertical-align:middle}
  @keyframes slide{to{transform:translateX(-50%)}}

  /* ---------- sections ---------- */
  section{padding:112px 0;position:relative}
  section.alt{background:var(--wash)}

  /* Reveal on scroll. Native CSS scroll-driven animation: no JS, and where
     it is unsupported the element is simply already visible. */
  @supports (animation-timeline: view()) {
    .reveal{opacity:0;transform:translateY(26px);
      animation:rise .8s var(--ease) forwards;
      animation-timeline:view();animation-range:entry 5% cover 26%}
  }
  @keyframes rise{to{opacity:1;transform:none}}

  .grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(268px,1fr))}
  /* Four cards on a three-column grid leaves one stranded on its own row.
     Pinning the count for the small cases makes the layout look chosen. */
  .grid[data-n="1"]{grid-template-columns:minmax(0,520px)}
  .grid[data-n="2"],.grid[data-n="4"]{grid-template-columns:repeat(2,minmax(0,1fr))}
  @media (max-width:820px){
    .grid[data-n="2"],.grid[data-n="4"]{grid-template-columns:1fr}
  }
  .card{border:1px solid var(--line);border-radius:var(--radius);padding:30px;
    background:#fff;box-shadow:var(--shadow-1);position:relative;overflow:hidden;
    transition:transform .35s var(--ease),box-shadow .35s var(--ease),border-color .35s}
  .card::before{content:"";position:absolute;inset:0 0 auto;height:2px;
    background:linear-gradient(90deg,var(--accent),var(--glow));
    transform:scaleX(0);transform-origin:left;transition:transform .45s var(--ease)}
  .card:hover{transform:translateY(-5px);box-shadow:var(--shadow-2);border-color:transparent}
  .card:hover::before{transform:scaleX(1)}
  .card h3{margin-bottom:.5em}
  .card p{color:var(--muted);margin:0;font-size:.97rem}

  .shot{border:1px dashed var(--line);border-radius:var(--radius);
    background:
      linear-gradient(135deg,rgba(0,0,0,.02),transparent),
      var(--wash);
    min-height:230px;display:flex;align-items:center;justify-content:center;
    color:var(--muted);font-size:.9rem;text-align:center;padding:24px;
    transition:border-color .3s,transform .35s var(--ease)}
  .shot:hover{border-color:var(--accent);transform:scale(1.01)}

  .split{display:grid;gap:56px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
    align-items:start}
  .facts{list-style:none;padding:0;margin:0}
  .facts li{padding:16px 0;border-bottom:1px solid var(--line);display:flex;gap:18px}
  .facts li:last-child{border-bottom:0}
  .facts b{min-width:96px;color:var(--muted);font-weight:600;font-size:.9rem;
    text-transform:uppercase;letter-spacing:.06em}

  /* ---------- closing band ---------- */
  .band{position:relative;isolation:isolate;overflow:hidden;
    background:var(--ink);color:#fff;padding:110px 0;text-align:center}
  .band .wrap{position:relative;z-index:2}
  .band h2{color:#fff;max-width:18ch;margin-inline:auto}
  .band p{color:rgba(255,255,255,.68);max-width:46ch;margin:0 auto 34px;font-size:1.08rem}
  .band .cta{background:#fff;color:var(--ink);box-shadow:0 8px 30px -10px rgba(0,0,0,.5)}
  .band .cta:hover{box-shadow:0 16px 44px -12px rgba(0,0,0,.6)}
  .band .cta.ghost{background:transparent;color:#fff;
    border:1px solid rgba(255,255,255,.3)}

  footer{border-top:1px solid var(--line);padding:44px 0;color:var(--muted);
    font-size:.92rem;background:#fff}
  footer .bar{min-height:0;gap:18px}
  footer a{color:var(--muted)}
  footer a:hover{color:var(--accent)}

  .draft{background:var(--accent);color:#0b0b0b;font-weight:600;
    font-size:.8rem;padding:9px 18px;text-align:center;letter-spacing:.03em;
    position:relative;z-index:60;line-height:1.4}

  @media (max-width:720px){
    body{font-size:16px}
    nav{width:100%;margin-left:0;order:3;gap:18px}
    nav a{font-size:.88rem}
    section{padding:72px 0}
    .hero{padding:88px 0 76px}
    .split{gap:36px}
    .cta.ghost{margin-left:0;margin-top:12px}
  }

  /* A reader who has asked for less motion gets a still page. Every
     animation here is decorative, so all of them stop — the layout and
     the content are identical either way. */
  @media (prefers-reduced-motion: reduce){
    html{scroll-behavior:auto}
    *,*::before,*::after{
      animation-duration:.001ms !important;animation-iteration-count:1 !important;
      transition-duration:.001ms !important}
    .reveal{opacity:1 !important;transform:none !important}
  }

  @media print{
    .mesh,.grain,.ticker{display:none}
    .hero,.band{background:#fff;color:#000}
    .hero h1,.band h2{color:#000;-webkit-text-fill-color:#000}
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
  const eyebrow = b.areas?.length
    ? `${b.trade ?? 'Local trade'} · ${b.areas[0]}`
    : (b.trade ?? 'Local trade');

  // The ticker needs its items twice: the track translates by -50%, so the
  // second copy is what is on screen as the first scrolls away.
  const tickerItems = (services.length ? services : [b.trade ?? 'Quality work'])
    .concat(b.areas ?? []);
  const ticker = [...tickerItems, ...tickerItems]
    .map((t) => `<span>${esc(t)}</span>`).join('');

  return `
<div class="hero">
  <div class="mesh"></div>
  <div class="grain"></div>
  <div class="wrap">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(headline(b))}</h1>
    <p class="lede">${esc(subhead(b))}</p>
    <a class="cta" href="${action.href}">${esc(action.label)}</a>
    ${b.primary_cta !== 'call' && tel
      ? `<a class="cta ghost" href="${tel}">Or call ${esc(b.phone)}</a>` : ''}
    ${tickerItems.length > 1 ? `
    <div class="ticker"><div class="ticker-track">${ticker}</div></div>` : ''}
  </div>
</div>

<section id="services">
  <div class="wrap">
    <div class="reveal">
      <p class="eyebrow">Services</p>
      <h2>What we do</h2>
    </div>
    <div class="grid reveal" data-n="${Math.min(services.length, 6)}" style="margin-top:44px">
      ${services.slice(0, 6).map((sv) => `<div class="card">
        <h3>${esc(sv)}</h3>
        <p>${esc(serviceBlurb(sv, b))}</p>
      </div>`).join('\n      ')}
    </div>
  </div>
</section>

<section id="work" class="alt">
  <div class="wrap">
    <div class="reveal">
      <p class="eyebrow">Portfolio</p>
      <h2>Recent work</h2>
      <p style="max-width:56ch;color:var(--muted)">${
        b.has_photos
          ? 'Photos of your recent jobs go here — send them over and I will drop them in.'
          : 'A few photos of finished jobs go here. Phone photos are fine — real work sells '
            + 'far better than stock images.'}</p>
    </div>
    <div class="grid reveal" data-n="3" style="margin-top:36px">
      ${[1, 2, 3].map((n) => `<div class="shot">Job photo ${n}<br>(placeholder)</div>`).join('\n      ')}
    </div>
  </div>
</section>

<section id="about">
  <div class="wrap split reveal">
    <div>
      <p class="eyebrow">About</p>
      <h2>${esc(b.business_name)}</h2>
      <p>Your own words go here — how long you have been going, what you are
         known for locally, who you usually work for. A short honest paragraph
         beats a page of marketing copy.</p>
      <p>${esc(`We cover ${where}.`)}</p>
      ${b.notes ? `<p>${esc(b.notes)}</p>` : ''}
    </div>
    <div>
      <p class="eyebrow">At a glance</p>
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
  <div class="mesh"></div>
  <div class="grain"></div>
  <div class="wrap">
    <h2>${esc(bandHeading(b))}</h2>
    <p>${esc(bandCopy(b))}</p>
    ${tel ? `<a class="cta" href="${tel}">Call ${esc(b.phone)}</a>` : ''}
    ${mail ? `<a class="cta ghost" href="${mail}">Email us</a>` : ''}
  </div>
</div>

<section>
  <div class="wrap split reveal">
    <div>
      <p class="eyebrow">Contact</p>
      <h2>Get in touch</h2>
      <ul class="facts">
        ${tel ? `<li><b>Phone</b> <span><a href="${tel}">${esc(b.phone)}</a></span></li>` : ''}
        ${mail ? `<li><b>Email</b> <span><a href="${mail}">${esc(b.email)}</a></span></li>` : ''}
        <li><b>Area</b> <span>${esc(where)}</span></li>
        <li><b>Hours</b> <span>Your opening hours go here</span></li>
      </ul>
    </div>
    <div>
      <p class="eyebrow">Enquiries</p>
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
