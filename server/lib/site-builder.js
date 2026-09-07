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
  // Light: the ground is warm white, the type is soft black, the accent is
  // a silver-taupe. Hair and beauty sites live in cream and black — a dark
  // plum with hot pink reads as a nightclub, not a salon.
  beauty:   { mode: 'light', ink: '#1a1613', accent: '#8c7f72', glow: '#cbb9a6',
              wash: '#f4efe7', ground: '#faf7f1', line: '#e6ded1', muted: '#6f665c' },
  food:     { ink: '#17100a', accent: '#fb923c', glow: '#f43f5e', wash: '#fcf8f2', line: '#ebe1d1', muted: '#6b5b48' },
  retail:   { ink: '#12141f', accent: '#818cf8', glow: '#22d3ee', wash: '#f7f7fa', line: '#e2e2ea', muted: '#5c6070' },
  clean:    { ink: '#07171f', accent: '#22d3ee', glow: '#38bdf8', wash: '#f3f8fa', line: '#d8e6ea', muted: '#4f6672' },
  pro:      { ink: '#0b1120', accent: '#60a5fa', glow: '#a78bfa', wash: '#f6f8fc', line: '#dfe5ef', muted: '#556074' },
};

/**
 * The theme per trade family.
 *
 * Colour is the weakest differentiator. What makes a salon site read as a
 * salon and a roofer's read as a roofer is TYPE, SHAPE and MOTION:
 *
 *   - a salon wants a high-contrast display serif, wide letter-spacing,
 *     sharp editorial edges and slow fades
 *   - a roofer wants a heavy grotesque, tight tracking, blunt corners and
 *     motion that arrives fast
 *   - a garage wants something technical and angular that sweeps sideways
 *   - a landscaper wants organic curves and things that grow upward
 *
 * Swapping only the accent colour produces eight versions of one template,
 * which is exactly what a prospect recognises as generic.
 *
 * `font` is the Google Fonts family; `display` always ends in a system
 * fallback that is genuinely on the device, so a blocked or slow font load
 * leaves a page that still looks deliberate rather than broken.
 */
const THEMES = {
  building: {
    font: 'Archivo:wght@600;800',
    display: "'Archivo', 'Helvetica Neue', Arial, sans-serif",
    weight: 800, tracking: '-.04em', transform: 'none',
    size: 'clamp(2.4rem,4.9vw,4.1rem)',
    eyebrowTracking: '.16em',
    radius: '6px', btnRadius: '6px',
    motion: 'drive', ornament: 'stripes',
    sections: ['areas', 'trust'],
  },
  motor: {
    font: 'Chakra+Petch:wght@600;700',
    display: "'Chakra Petch', 'Helvetica Neue', Arial, sans-serif",
    weight: 700, tracking: '-.02em', transform: 'uppercase',
    size: 'clamp(2.1rem,4.2vw,3.5rem)',
    eyebrowTracking: '.22em',
    radius: '2px', btnRadius: '2px',
    motion: 'sweep', ornament: 'grid',
    sections: ['prices', 'hours'],
  },
  green: {
    font: 'Fraunces:opsz,wght@9..144,500;9..144,700',
    display: "'Fraunces', Georgia, 'Times New Roman', serif",
    weight: 700, tracking: '-.025em', transform: 'none',
    size: 'clamp(2.4rem,4.8vw,4rem)',
    eyebrowTracking: '.18em',
    radius: '22px', btnRadius: '100px',
    motion: 'grow', ornament: 'organic',
    sections: ['areas', 'trust'],
  },
  beauty: {
    font: 'Cormorant+Garamond:wght@300;400;600',
    display: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
    weight: 300, tracking: '-.005em', transform: 'none',
    size: 'clamp(2.7rem,5.6vw,4.8rem)',
    eyebrowTracking: '.34em',
    radius: '2px', btnRadius: '2px',
    motion: 'unveil', ornament: 'orbs',
    sections: ['prices', 'hours'],
  },
  food: {
    font: 'Playfair+Display:wght@500;700',
    display: "'Playfair Display', Georgia, 'Times New Roman', serif",
    weight: 700, tracking: '-.025em', transform: 'none',
    size: 'clamp(2.4rem,4.8vw,4.1rem)',
    eyebrowTracking: '.2em',
    radius: '14px', btnRadius: '100px',
    motion: 'rise', ornament: 'warm',
    sections: ['prices', 'hours'],
  },
  retail: {
    font: 'DM+Serif+Display:ital@0;1',
    display: "'DM Serif Display', Georgia, 'Times New Roman', serif",
    weight: 400, tracking: '-.02em', transform: 'none',
    size: 'clamp(2.5rem,5vw,4.2rem)',
    eyebrowTracking: '.24em',
    radius: '3px', btnRadius: '3px',
    motion: 'stagger', ornament: 'rules',
    sections: ['hours'],
  },
  clean: {
    font: 'Outfit:wght@500;700',
    display: "'Outfit', 'Helvetica Neue', Arial, sans-serif",
    weight: 700, tracking: '-.035em', transform: 'none',
    size: 'clamp(2.3rem,4.6vw,3.9rem)',
    eyebrowTracking: '.18em',
    radius: '18px', btnRadius: '100px',
    motion: 'shimmer', ornament: 'bubbles',
    sections: ['areas', 'prices'],
  },
  pro: {
    font: 'Inter:wght@600;800',
    display: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    weight: 800, tracking: '-.045em', transform: 'none',
    size: 'clamp(2.3rem,4.5vw,3.9rem)',
    eyebrowTracking: '.16em',
    radius: '10px', btnRadius: '8px',
    motion: 'settle', ornament: 'dots',
    sections: ['trust'],
  },
};

export function themeFor(trade) {
  const family = tradeFamily(trade);
  return { ...(THEMES[family] ?? THEMES.pro), family };
}

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
  base.mode ??= 'dark';
  base.ground ??= base.ink;
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

/**
 * How a section arrives. Each is a keyframe pair used by `.reveal` — the
 * character of the movement is doing as much sector work as the palette.
 */
const MOTION = {
  // Heavy trades: it arrives, it does not float. Short, from the side.
  drive:   { from: 'opacity:0;transform:translate3d(-26px,0,0)', dur: '.55s',
             ease: 'cubic-bezier(.2,.8,.2,1)' },
  // Garage: a horizontal pass, slightly skewed, like something going by.
  sweep:   { from: 'opacity:0;transform:translate3d(-40px,0,0) skewX(-3deg)', dur: '.6s',
             ease: 'cubic-bezier(.16,1,.3,1)' },
  // Landscaping: grows up out of the ground.
  grow:    { from: 'opacity:0;transform:translate3d(0,30px,0) scaleY(.94)', dur: '.8s',
             ease: 'cubic-bezier(.22,1,.36,1)' },
  // Salon: slow, weightless, a touch of scale. Nothing hurried.
  unveil:  { from: 'opacity:0;transform:translate3d(0,14px,0) scale(.985)', dur: '1.15s',
             ease: 'cubic-bezier(.16,1,.3,1)' },
  rise:    { from: 'opacity:0;transform:translate3d(0,26px,0)', dur: '.85s',
             ease: 'cubic-bezier(.22,1,.36,1)' },
  stagger: { from: 'opacity:0;transform:translate3d(0,22px,0)', dur: '.75s',
             ease: 'cubic-bezier(.22,1,.36,1)' },
  shimmer: { from: 'opacity:0;transform:translate3d(0,18px,0)', dur: '.7s',
             ease: 'cubic-bezier(.22,1,.36,1)' },
  settle:  { from: 'opacity:0;transform:translate3d(0,12px,0)', dur: '.5s',
             ease: 'cubic-bezier(.3,.9,.3,1)' },
};

/**
 * The hero backdrop, beyond the drifting mesh every theme shares. These are
 * pure CSS — repeating gradients and masks, no images to load.
 */
function ornamentCss(kind) {
  switch (kind) {
    case 'stripes':  // hazard diagonals, very low contrast
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.055;
        background:repeating-linear-gradient(135deg,#fff 0 2px,transparent 2px 22px)}`;
    case 'grid':     // technical measuring grid
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.09;
        background-image:linear-gradient(#fff 1px,transparent 1px),
          linear-gradient(90deg,#fff 1px,transparent 1px);
        background-size:64px 64px;
        -webkit-mask-image:radial-gradient(ellipse at 30% 40%,#000,transparent 72%);
        mask-image:radial-gradient(ellipse at 30% 40%,#000,transparent 72%)}`;
    case 'organic':  // soft overlapping leaf-ish curves
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.1;
        background:
          radial-gradient(60% 80% at 88% 12%,#fff,transparent 60%),
          radial-gradient(50% 70% at 8% 92%,#fff,transparent 62%)}`;
    case 'orbs':     // fine editorial rule plus a soft bloom
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.14;
        background:radial-gradient(40% 55% at 78% 30%,#fff,transparent 70%)}
      .hero .wrap::before{content:"";position:absolute;left:-28px;top:6px;bottom:6px;
        width:1px;background:linear-gradient(180deg,transparent,var(--accent),transparent);
        opacity:.6}`;
    case 'warm':
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.16;
        background:radial-gradient(70% 60% at 50% 105%,var(--accent),transparent 68%)}`;
    case 'rules':    // editorial column rules
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.07;
        background-image:linear-gradient(90deg,#fff 1px,transparent 1px);
        background-size:calc(100%/6) 100%}`;
    case 'bubbles':
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.13;
        background:
          radial-gradient(circle 8px at 12% 74%,#fff,transparent 60%),
          radial-gradient(circle 14px at 84% 22%,#fff,transparent 60%),
          radial-gradient(circle 5px at 66% 82%,#fff,transparent 60%),
          radial-gradient(circle 10px at 32% 18%,#fff,transparent 60%),
          radial-gradient(circle 6px at 92% 66%,#fff,transparent 60%)}`;
    case 'dots':
    default:
      return `.orn{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.16;
        background-image:radial-gradient(#fff 1px,transparent 1px);
        background-size:26px 26px;
        -webkit-mask-image:radial-gradient(ellipse at 26% 34%,#000,transparent 68%);
        mask-image:radial-gradient(ellipse at 26% 34%,#000,transparent 68%)}`;
  }
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

/**
 * The trade word a customer would use, not the one the register uses.
 *
 * Companies House calls a garage "Vehicle maintenance and repair" and a
 * salon "Hairdressing and beauty". Set as an H1 those read as a database
 * dump, and at display size they run to four lines and push the phone
 * number off the screen. Nobody searches for them either.
 */
const SHORT_TRADE = {
  'Electrical installation': 'Electricians',
  'Plumbing, heating and air conditioning': 'Plumbing & heating',
  'Joinery installation': 'Joinery',
  'Floor and wall covering': 'Flooring & tiling',
  'Painting': 'Painting & decorating',
  'Glazing': 'Windows & glazing',
  'Building completion and finishing': 'Kitchens & bathrooms',
  'Site preparation': 'Groundworks',
  'Scaffold erection': 'Scaffolding',
  'Other specialised construction': 'Specialist building',
  'Building contractors': 'Builders',
  'Other construction installation': 'Installations',
  'Solar installation': 'Solar & EV charging',
  'Renewable heating': 'Heat pumps',
  'Fencing and paving': 'Fencing & paving',
  'Turf and grass': 'Lawns & turf',
  'Garden buildings': 'Garden rooms',
  'Cleaning of buildings': 'Cleaning',
  'Other cleaning': 'Specialist cleaning',
  'Locksmith and security': 'Locksmiths',
  'Appliance and equipment repair': 'Appliance repair',
  'Electronics repair': 'Device repair',
  'Shoe and leather repair': 'Shoe repair',
  'Upholstery repair': 'Upholstery',
  'Handyman services': 'Handyman',
  'Vehicle maintenance and repair': 'Servicing & MOT',
  'Vehicle parts and accessories': 'Parts & tyres',
  'Valeting and cleaning': 'Valeting',
  'Driving instruction': 'Driving lessons',
  'Hairdressing and beauty': 'Hair & beauty',
  'Nail and beauty': 'Nails & beauty',
  'Personal care': 'Tattoo & piercing',
  'Wellbeing': 'Massage & wellbeing',
  'Complementary therapy': 'Therapy',
  'Pet services': 'Dog grooming',
  'Restaurants and cafes (licensed)': 'Restaurant',
  'Cafes and unlicensed restaurants': 'Coffee & food',
  'Takeaways': 'Takeaway',
  'Catering and food services': 'Catering',
  'Bakeries': 'Bakery',
  'Delis and food shops': 'Deli',
  'Florists': 'Florist',
  'Bookshops': 'Bookshop',
  'Sports and cycle shops': 'Bikes & sport',
  'Health and beauty shops': 'Health & beauty',
  'Independent retail': 'Independent shop',
  'Clothing shops': 'Clothing',
  'Furniture and homeware': 'Furniture',
  'Market stalls': 'Street food',
  'Event services': 'Weddings & events',
  'Entertainment': 'DJs & entertainment',
  'Sports coaching': 'Coaching',
  'Design': 'Interior design',
  'Machinery repair': 'Fabrication & welding',
  'Bespoke joinery and carpentry': 'Bespoke joinery',
  'Bespoke furniture': 'Furniture making',
  'Road freight': 'Haulage',
  'Taxi and private hire': 'Taxi & private hire',
  'Freight forwarding': 'Logistics',
  'Print and signs': 'Print & signage',
  'Small manufacturing': 'Bespoke making',
};

/**
 * Shorten any trade to something that fits a headline. Mapped values win;
 * anything unmapped is trimmed generically — cut at a comma or bracket,
 * then drop a trailing "and X" clause if that still leaves it too long.
 */
export function shortTrade(trade) {
  const raw = String(trade ?? '').trim();
  if (!raw) return null;
  if (SHORT_TRADE[raw]) return SHORT_TRADE[raw];

  let out = raw.split(/[,(]/)[0].trim();
  if (out.split(/\s+/).length > 3) {
    out = out.replace(/\s+and\s+.*$/i, '').trim();
  }
  if (out.split(/\s+/).length > 4) {
    out = out.split(/\s+/).slice(0, 3).join(' ');
  }
  return out || raw;
}

/** The hero line. Trade plus town is what a local search actually wants. */
function headline(b) {
  const where = b.areas?.[0];
  const trade = shortTrade(b.trade) ?? b.services?.[0] ?? 'Local specialists';
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


/* ------------------------------------------------------------- hero art */

/**
 * A piece of line art per sector, animated on load.
 *
 * Inline SVG with CSS animation: no request, no JavaScript (the preview CSP
 * forbids one anyway), and it scales to any size without going fuzzy. Line
 * art rather than illustration because a stroke drawing reads as considered
 * where a cartoon reads as clip art — and it inherits the palette, so a
 * salon's scissors are pink and a garage's wheel is red without a second
 * asset existing.
 *
 * Each returns markup for a 320x320 viewBox that sits in the hero's right
 * half. On a phone the hero is text-only: the art is decorative and the
 * screen is better spent on the phone number.
 */
function heroArt(family) {
  const svg = (inner) =>
    `<svg class="art" viewBox="0 0 320 320" fill="none" aria-hidden="true" focusable="false">${inner}</svg>`;

  switch (family) {
    case 'beauty':
      // Scissors: each half is a tapered blade above the pivot and a
      // handle curving down to a finger loop below it, crossing at the
      // screw. Blades are filled shapes — a stroke of even width reads as
      // a line, not a blade, however you arrange it.
      return svg(`
        <g class="a-scissors">
          <g class="blade-a" fill="currentColor" stroke="currentColor"
             stroke-width="2" stroke-linejoin="round">
            <!-- blade: 16px at the pivot, tapering to a point -->
            <path d="M150 156 L238 40 Q244 34 246 42 L164 168 Z"/>
            <!-- handle and finger loop -->
            <path d="M154 164 C142 190 130 206 120 218" fill="none" stroke-width="7"
                  stroke-linecap="round"/>
            <ellipse cx="104" cy="242" rx="25" ry="29" fill="none" stroke-width="7"
                     transform="rotate(-24 104 242)"/>
          </g>
          <g class="blade-b" fill="currentColor" stroke="currentColor"
             stroke-width="2" stroke-linejoin="round">
            <path d="M170 156 L82 40 Q76 34 74 42 L156 168 Z"/>
            <path d="M166 164 C178 190 190 206 200 218" fill="none" stroke-width="7"
                  stroke-linecap="round"/>
            <ellipse cx="216" cy="242" rx="25" ry="29" fill="none" stroke-width="7"
                     transform="rotate(24 216 242)"/>
          </g>
          <!-- the screw sits on top of both halves -->
          <circle cx="160" cy="160" r="9" fill="currentColor"/>
          <circle cx="160" cy="160" r="3.5" fill="var(--ink)"/>
        </g>
        <g class="a-comb" stroke="currentColor" stroke-width="6" stroke-linecap="round">
          <path d="M52 296 H268"/>
          ${Array.from({ length: 17 }, (_, i) =>
            `<path class="tooth" style="--i:${i}" stroke-width="4" d="M${58 + i * 13} 300 V318"/>`).join('')}
        </g>`);

    case 'motor':
      // An alloy wheel: a tyre with real tread blocks, a rim, five tapered
      // spokes with the gaps between them showing, a centre cap and lug
      // bolts. Thin concentric circles read as a gear; the tread and the
      // spoke shape are what make it a wheel.
      return svg(`
        <g class="a-wheel">
          <!-- tyre -->
          <circle cx="160" cy="160" r="140" fill="none" stroke="currentColor"
                  stroke-width="26" opacity=".85"/>
          <!-- tread blocks, cut into the tyre -->
          <circle cx="160" cy="160" r="140" fill="none" stroke="var(--ink)"
                  stroke-width="26" stroke-dasharray="9 20" opacity=".55"/>
          <!-- sidewall and rim lip -->
          <circle cx="160" cy="160" r="127" fill="none" stroke="currentColor"
                  stroke-width="2" opacity=".5"/>
          <circle cx="160" cy="160" r="112" fill="none" stroke="currentColor"
                  stroke-width="5"/>
          ${Array.from({ length: 5 }, (_, i) => {
            // Each spoke is a wedge: narrow at the hub, wider at the rim.
            const mid = (i * 72 - 90) * Math.PI / 180;
            const pt = (r, a) => `${(160 + Math.cos(a) * r).toFixed(1)} ${(160 + Math.sin(a) * r).toFixed(1)}`;
            const hubHalf = 0.20, rimHalf = 0.42;
            return `<path fill="currentColor" opacity=".9" d="`
              + `M${pt(38, mid - hubHalf)} `
              + `L${pt(104, mid - rimHalf)} `
              + `A104 104 0 0 1 ${pt(104, mid + rimHalf)} `
              + `L${pt(38, mid + hubHalf)} `
              + `A38 38 0 0 0 ${pt(38, mid - hubHalf)} Z"/>`;
          }).join('')}
          <!-- centre cap and lug bolts -->
          <circle cx="160" cy="160" r="40" fill="var(--ink)" stroke="currentColor" stroke-width="4"/>
          ${Array.from({ length: 5 }, (_, i) => {
            const a = (i * 72 - 90) * Math.PI / 180;
            return `<circle cx="${(160 + Math.cos(a) * 24).toFixed(1)}" `
                 + `cy="${(160 + Math.sin(a) * 24).toFixed(1)}" r="5" fill="currentColor"/>`;
          }).join('')}
          <circle cx="160" cy="160" r="8" fill="none" stroke="currentColor" stroke-width="3"/>
        </g>
        <g class="a-motion" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity=".6">
          <path class="dash" style="--i:0" d="M4 108 H56"/>
          <path class="dash" style="--i:1" d="M-10 160 H34"/>
          <path class="dash" style="--i:2" d="M4 212 H56"/>
        </g>`);

    case 'building':
      // Roof tiles: filled and overlapping with a curved top edge, laid in
      // courses. Outlined rectangles read as a brick diagram; the overlap
      // and the curve are what make them tiles.
      return svg(`
        <g class="a-roof">
          ${[0, 1, 2, 3].map((row) => {
            const y = 226 - row * 30;
            const inset = row * 26;
            const count = 5 - row;
            const w = (250 - inset * 2) / count;
            return Array.from({ length: count }, (_, i) => {
              const x = 35 + inset + i * w;
              const tw = w - 3;
              return `<path class="tile" style="--i:${(3 - row) * 5 + i}" `
                + `fill="currentColor" stroke="var(--ink)" stroke-width="2" `
                + `d="M${x.toFixed(1)} ${y + 34} V${y + 10} `
                + `Q${x.toFixed(1)} ${y} ${(x + tw / 2).toFixed(1)} ${y} `
                + `Q${(x + tw).toFixed(1)} ${y} ${(x + tw).toFixed(1)} ${y + 10} `
                + `V${y + 34} Z"/>`;
            }).join('');
          }).join('')}
        </g>`);

    case 'green':
      // Stems with real leaf shapes — two arcs meeting at a point. A bare
      // curve reads as a wire; the leaf shape is what makes it a plant.
      return svg(`
        <g class="a-garden">
          <path d="M34 286 H286" stroke="currentColor" stroke-width="5"
                stroke-linecap="round" opacity=".45"/>
          ${[
            { x: 92,  h: 132, i: 0 },
            { x: 160, h: 186, i: 1 },
            { x: 228, h: 148, i: 2 },
          ].map(({ x, h, i }) => {
            const top = 284 - h;
            // A leaf: out and back, the two arcs meeting at the tip.
            const leaf = (y, dir, len) => {
              const tipX = x + dir * len, tipY = y - len * 0.5;
              return `<path fill="currentColor" opacity=".9" d="`
                + `M${x} ${y} Q${x + dir * len * 0.35} ${y - len * 0.62} ${tipX} ${tipY} `
                + `Q${x + dir * len * 0.62} ${y - len * 0.08} ${x} ${y} Z"/>`;
            };
            return `<g class="stem" style="--i:${i}">
              <path d="M${x} 284 V${top}" stroke="currentColor" stroke-width="6"
                    stroke-linecap="round" fill="none"/>
              ${leaf(284 - h * 0.34, -1, 40)}
              ${leaf(284 - h * 0.56, 1, 44)}
              ${leaf(284 - h * 0.78, -1, 34)}
              <circle cx="${x}" cy="${top - 10}" r="13" fill="currentColor"/>
            </g>`;
          }).join('')}
        </g>`);

    case 'food':
      // Steam rising off a cup.
      return svg(`
        <g class="a-cup" stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round">
          <path fill="currentColor" fill-opacity=".22" stroke-width="5"
                d="M92 190 H212 V236 A32 32 0 0 1 180 268 H124 A32 32 0 0 1 92 236 Z"/>
          <path d="M212 200 H236 A22 22 0 0 1 236 244 H212" opacity=".7"/>
          <path d="M74 284 H238" opacity=".4"/>
        </g>
        <g class="a-steam" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          ${[0, 1, 2].map((i) => {
            const x = 124 + i * 28;
            return `<path class="wisp" style="--i:${i}" `
                 + `d="M${x} 168 q-13 -22 0 -42 q13 -20 0 -40"/>`;
          }).join('')}
        </g>`);

    case 'clean':
      // Bubbles drifting up past a highlight.
      return svg(`
        <g class="a-bubbles" stroke="currentColor" stroke-width="2.2">
          ${[
            { x: 108, r: 26, i: 0 }, { x: 176, r: 17, i: 1 }, { x: 226, r: 32, i: 2 },
            { x: 138, r: 12, i: 3 }, { x: 200, r: 22, i: 4 }, { x: 88,  r: 15, i: 5 },
          ].map(({ x, r, i }) => `
            <g class="bub" style="--i:${i}">
              <circle cx="${x}" cy="272" r="${r}" fill="currentColor" fill-opacity=".16"/>
              <path d="M${x - r * 0.42} ${272 - r * 0.42} a${r * 0.5} ${r * 0.5} 0 0 1 ${r * 0.34} ${-r * 0.2}"
                    stroke-width="1.8" opacity=".8" stroke-linecap="round"/>
            </g>`).join('')}
        </g>`);

    case 'retail':
      // A price tag: a pentagon that comes to a point at the top with an
      // eyelet through it, hanging on a hook. Drawn upright — rotating a
      // pointed shape by 45 degrees just moves the point out of frame and
      // leaves a rounded square.
      return svg(`
        <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M160 22 V52" stroke-width="4" opacity=".55" fill="none"/>
          <path d="M160 52 A18 18 0 0 0 160 88" stroke-width="4" opacity=".55" fill="none"/>
          <g class="a-tag">
            <path fill="currentColor" stroke-width="3"
                  d="M160 62 L226 128 A10 10 0 0 1 229 135 V250
                     A12 12 0 0 1 217 262 H103 A12 12 0 0 1 91 250
                     V135 A10 10 0 0 1 94 128 Z"/>
            <circle cx="160" cy="112" r="15" fill="var(--ink)" stroke-width="3"/>
            <path d="M116 196 H204" stroke-width="4" opacity=".45" stroke="var(--ink)"/>
            <path d="M116 222 H176" stroke-width="4" opacity=".3" stroke="var(--ink)"/>
          </g>
        </g>`);

    default:
      // Professional: a mark that draws itself, then holds.
      return svg(`
        <g class="a-draw" stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round">
          <rect class="ln" style="--i:0" x="60" y="60" width="200" height="200" rx="18"/>
          <path class="ln" style="--i:1" d="M60 160 H260"/>
          <path class="ln" style="--i:2" d="M160 60 V260"/>
          <circle class="ln" style="--i:3" cx="160" cy="160" r="58"/>
        </g>`);
  }
}

/** The keyframes each piece of art needs. Only the active sector's are emitted. */
function heroArtCss(family) {
  const base = `
  .art{width:min(46vw,460px);aspect-ratio:1;color:var(--accent);
    opacity:.9;overflow:visible}
  @media (max-width:900px){.art{display:none}}`;

  // The entrance is only emitted for the pieces that move as a whole. The
  // ones whose parts animate individually — tiles, stems, bubbles, strokes
  // — never reference it, and an unused keyframe is dead weight.
  const entrance = `
  @keyframes art-in{
    from{opacity:0;transform:translateY(16px) scale(.97)}
    to{opacity:.9;transform:none}}`;
  const shared = base + entrance;

  switch (family) {
    case 'beauty': return `${shared}
  .blade-a,.blade-b{transform-box:view-box;transform-origin:160px 160px}
  .blade-a{animation:snip-a 2.6s ease-in-out .6s infinite}
  .blade-b{animation:snip-b 2.6s ease-in-out .6s infinite}
  @keyframes snip-a{0%,55%,100%{transform:rotate(0deg)}28%{transform:rotate(-13deg)}}
  @keyframes snip-b{0%,55%,100%{transform:rotate(0deg)}28%{transform:rotate(13deg)}}
  .a-comb .tooth{opacity:0;animation:tooth .5s ease-out forwards;
    animation-delay:calc(.9s + var(--i) * .045s)}
  @keyframes tooth{to{opacity:.75}}
  .a-scissors{opacity:0;animation:art-in 1s cubic-bezier(.16,1,.3,1) .25s forwards}`;

    case 'motor': return `${shared}
  .a-wheel{transform-box:fill-box;transform-origin:50% 50%;
    animation:art-in .9s cubic-bezier(.16,1,.3,1) .2s backwards,
              spin 6s linear .2s infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .a-motion .dash{opacity:0;animation:whoosh 2.4s ease-out infinite;
    animation-delay:calc(1s + var(--i) * .14s)}
  @keyframes whoosh{
    0%{opacity:0;transform:translateX(26px)}
    35%{opacity:.6}
    100%{opacity:0;transform:translateX(-14px)}}`;

    case 'building': return `${base}
  .tile{opacity:0;transform-box:fill-box;transform-origin:50% 50%;
    animation:lay .6s cubic-bezier(.2,.8,.2,1) forwards;
    animation-delay:calc(.3s + var(--i) * .05s)}
  @keyframes lay{
    from{opacity:0;transform:translateY(-26px) scale(.94)}
    to{opacity:.92;transform:none}}`;

    case 'green': return `${base}
  .stem{transform-box:fill-box;transform-origin:50% 100%;
    animation:sprout 1.1s cubic-bezier(.22,1,.36,1) backwards,
              sway 5.5s ease-in-out infinite;
    animation-delay:calc(.4s + var(--i) * .22s),
                    calc(1.6s + var(--i) * .35s)}
  @keyframes sprout{from{transform:scaleY(0)}to{transform:scaleY(1)}}
  @keyframes sway{0%,100%{transform:rotate(-1.6deg)}50%{transform:rotate(1.6deg)}}`;

    case 'food': return `${shared}
  .a-cup{opacity:0;animation:art-in .8s cubic-bezier(.16,1,.3,1) .25s forwards}
  .wisp{opacity:0;stroke-dasharray:120;
    animation:steam 3.6s ease-in-out infinite;
    animation-delay:calc(.9s + var(--i) * .5s)}
  @keyframes steam{
    0%{opacity:0;transform:translateY(14px) scaleX(.9)}
    30%{opacity:.65}
    100%{opacity:0;transform:translateY(-34px) scaleX(1.1)}}`;

    case 'clean': return `${base}
  .bub{opacity:0;transform-box:fill-box;transform-origin:50% 50%;
    animation:float 6s ease-in-out infinite;
    animation-delay:calc(var(--i) * .8s)}
  @keyframes float{
    0%{opacity:0;transform:translateY(0) scale(.7)}
    18%{opacity:.85}
    75%{opacity:.5}
    100%{opacity:0;transform:translateY(-220px) scale(1.05)}}`;

    case 'retail': return `${shared}
  .a-tag{transform-box:view-box;transform-origin:160px 70px;
    animation:art-in .8s cubic-bezier(.16,1,.3,1) .2s backwards,
              swing 4.5s ease-in-out 1s infinite}
  @keyframes swing{
    0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}`;

    default: return `${base}
  .a-draw .ln{stroke-dasharray:900;stroke-dashoffset:900;
    animation:draw 1.6s cubic-bezier(.22,1,.36,1) forwards;
    animation-delay:calc(.3s + var(--i) * .18s)}
  @keyframes draw{to{stroke-dashoffset:0}}`;
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
 * Single-page nav, built from what the page actually contains — a salon
 * links to its price list, a roofer to the towns it covers. Capped at five
 * so the bar never wraps into a second row on a laptop.
 *
 * A one-pager is what closes small-trade work: everything a caller needs is
 * above the fold or one flick away, and there is no navigation to get lost
 * in on a phone.
 */
const SECTION_LABELS = {
  prices: 'Prices',
  hours:  'Opening hours',
  areas:  'Areas',
  trust:  'Why us',
};

function anchorsFor(sections = []) {
  const extra = sections.map((k) => [`#${k}`, SECTION_LABELS[k]]).filter(([, l]) => l);
  return [
    ['#services', 'Services'],
    ...extra,
    ['#work', 'Our work'],
    ['#about', 'About'],
    ['#contact', 'Contact'],
  ].slice(0, 6);
}

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
function css(p, t) {
  const m = MOTION[t.motion] ?? MOTION.rise;
  // A light-ground theme is not the dark one with colours swapped: the
  // contrast, the button fills, the mesh opacity and the grain blend mode
  // all have to change or it reads as a washed-out version of the dark.
  const light = p.mode === 'light';
  return `
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --ink:${p.ink}; --accent:${p.accent}; --glow:${p.glow ?? p.accent};
    --wash:${p.wash}; --line:${p.line}; --muted:${p.muted};
    --ground:${p.ground ?? p.ink};
    --radius:${t.radius};
    --btn-radius:${t.btnRadius};
    --display:${t.display};
    --shadow-1:0 1px 2px rgba(15,23,42,.04), 0 4px 12px rgba(15,23,42,.05);
    --shadow-2:0 2px 4px rgba(15,23,42,.05), 0 12px 32px rgba(15,23,42,.09);
    --ease:cubic-bezier(.22,1,.36,1);
  }
  html{scroll-behavior:smooth}
  body{margin:0;background:#fff;color:var(--ink);
    font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}

  /* Type scale — premium sites are not shy with headline size. */
  h1,h2{font-family:var(--display);line-height:1.04;margin:0 0 .4em;
    font-weight:${t.weight};letter-spacing:${t.tracking};
    text-transform:${t.transform}}
  h3{line-height:1.2;margin:0 0 .4em;font-weight:700;letter-spacing:-.015em}
  h1{font-size:${t.size}}
  h2{font-size:clamp(1.9rem,4.2vw,3.1rem)}
  h3{font-size:1.14rem}
  p{margin:0 0 1.1em}
  a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
  .wrap{max-width:1140px;margin:0 auto;padding:0 28px}
  .eyebrow{text-transform:uppercase;letter-spacing:${t.eyebrowTracking};
    font-size:.72rem;font-weight:700;color:var(--accent);margin:0 0 20px}

  /* ---------- the animated backdrop ----------
     Three radial gradients on one layer, drifting on long offset cycles so
     the pattern never visibly repeats. GPU-composited transforms only. */
  .mesh{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .mesh::before,.mesh::after{content:"";position:absolute;border-radius:50%;
    filter:blur(70px);opacity:${light ? '.32' : '.55'};will-change:transform}
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
  .grain{position:absolute;inset:0;pointer-events:none;z-index:1;
    opacity:${light ? '.2' : '.42'};
    mix-blend-mode:${light ? 'multiply' : 'overlay'};
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")}

  ${ornamentCss(t.ornament)}
  ${heroArtCss(t.family)}

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
    header{background-color:var(--ground);border-bottom-color:transparent;
      animation:header-solid 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    @keyframes header-solid{
      from{background-color:var(--ground);border-bottom-color:rgba(0,0,0,0)}
      to  {background-color:rgba(255,255,255,.92);border-bottom-color:var(--line)}}

    header .brand{animation:brand-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    header nav a{animation:nav-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    header .tel{animation:tel-on-dark 1s linear both;
      animation-timeline:scroll();animation-range:0 200px}
    @keyframes brand-on-dark{from{color:${light ? 'var(--ink)' : '#fff'}}to{color:var(--ink)}}
    @keyframes nav-on-dark{
      from{color:${light ? 'var(--muted)' : 'rgba(255,255,255,.75)'}}to{color:var(--muted)}}
    @keyframes tel-on-dark{
      from{background-color:${light ? 'var(--ink)' : 'rgba(255,255,255,.16)'}}
      to  {background-color:var(--ink)}}
  }
  .bar{display:flex;align-items:center;gap:26px;min-height:74px;flex-wrap:wrap}
  .brand{font-family:var(--display);font-weight:${t.weight};font-size:1.28rem;
    letter-spacing:${t.tracking};text-decoration:none;color:var(--ink);
    text-transform:${t.transform}}
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
  .tel{background:var(--ink);color:#fff;padding:11px 20px;border-radius:var(--btn-radius);
    text-decoration:none;font-weight:700;white-space:nowrap;font-size:.92rem;
    transition:transform .25s var(--ease),box-shadow .25s var(--ease)}
  .tel:hover{transform:translateY(-2px);box-shadow:var(--shadow-2)}

  /* ---------- hero ---------- */
  .hero{position:relative;isolation:isolate;overflow:hidden;
    background:var(--ground);color:${light ? 'var(--ink)' : '#fff'};
    padding:120px 0 118px;margin-top:-1px}
  .hero .wrap{position:relative;z-index:2}
  .hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,auto);
    gap:48px;align-items:center}
  .hero-art{display:flex;justify-content:center;align-items:center}
  @media (max-width:900px){
    .hero-grid{grid-template-columns:1fr}
    .hero-art{display:none}
    .hero h1{max-width:18ch}
  }

  .hero h1{max-width:14ch;overflow-wrap:break-word;
    background:${light
      ? 'linear-gradient(170deg,var(--ink) 40%,rgba(26,22,19,.72))'
      : 'linear-gradient(170deg,#fff 30%,rgba(255,255,255,.80))'};
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p.lede{font-size:clamp(1.05rem,2vw,1.3rem);
    color:${light ? 'var(--muted)' : 'rgba(255,255,255,.72)'};
    max-width:52ch;margin:26px 0 38px;font-weight:400}
  .hero .eyebrow{color:var(--accent)}

  .cta{display:inline-flex;align-items:center;gap:10px;
    background:${light ? 'var(--ink)' : 'var(--accent)'};
    color:${light ? 'var(--ground)' : '#0b0b0b'};
    padding:17px 32px;border-radius:var(--btn-radius);
    text-decoration:none;font-weight:700;font-size:1.02rem;letter-spacing:-.01em;
    transition:transform .25s var(--ease),box-shadow .25s var(--ease);
    box-shadow:${light ? '0 8px 26px -10px rgba(26,22,19,.5)' : '0 8px 30px -8px var(--accent)'}}
  .cta:hover{transform:translateY(-3px);
    box-shadow:${light ? '0 16px 40px -12px rgba(26,22,19,.55)' : '0 16px 44px -10px var(--accent)'}}
  .cta.ghost{background:transparent;box-shadow:none;margin-left:12px;
    color:${light ? 'var(--ink)' : '#fff'};
    border:1px solid ${light ? 'var(--line)' : 'rgba(255,255,255,.28)'}}
  .cta.ghost:hover{background:${light ? 'rgba(26,22,19,.04)' : 'rgba(255,255,255,.08)'};
    border-color:${light ? 'var(--muted)' : 'rgba(255,255,255,.5)'}}

  /* Service ticker under the hero — motion that carries information. */
  .ticker{position:relative;z-index:2;margin-top:60px;
    border-top:1px solid ${light ? 'var(--line)' : 'rgba(255,255,255,.12)'};
    padding-top:26px;
    -webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
    mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
    overflow:hidden}
  .ticker-track{display:flex;gap:44px;width:max-content;
    animation:slide 32s linear infinite}
  .ticker span{color:${light ? 'var(--muted)' : 'rgba(255,255,255,.5)'};
    font-weight:600;white-space:nowrap;
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
    .reveal{${m.from};
      animation:reveal ${m.dur} ${m.ease} forwards;
      animation-timeline:view();animation-range:entry 4% cover 24%}
  }
  @keyframes reveal{to{opacity:1;transform:none}}

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

  /* Price list — a dotted leader row, the way a real menu or salon list
     is set. A plain two-column table reads as a spreadsheet. */
  .price-list{margin-top:36px;max-width:640px}
  .price-row{display:flex;align-items:baseline;gap:14px;padding:15px 0;
    border-bottom:1px solid var(--line)}
  .price-row:last-child{border-bottom:0}
  .price-name{font-weight:600}
  .price-dots{flex:1;border-bottom:1px dotted var(--line);transform:translateY(-4px)}
  .price-val{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}

  /* Areas covered */
  .chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
  .chip{border:1px solid var(--line);border-radius:100px;padding:9px 20px;
    font-weight:600;font-size:.94rem;background:#fff;
    transition:border-color .25s,transform .25s var(--ease)}
  .chip:hover{border-color:var(--accent);transform:translateY(-2px)}
  .chip-add{border-style:dashed;color:var(--muted);font-weight:500}

  /* A phone-first call bar. On a trade site opened on a phone this is worth
     more than anything else on the page, so it is always in reach. */
  .call-bar{display:none}
  @media (max-width:720px){
    .call-bar{display:flex;position:fixed;left:12px;right:12px;bottom:12px;z-index:80;
      align-items:center;justify-content:center;gap:10px;
      background:${light ? 'var(--ink)' : 'var(--accent)'};
      color:${light ? 'var(--ground)' : '#0b0b0b'};
      padding:17px 22px;border-radius:100px;text-decoration:none;
      font-weight:700;font-size:1.05rem;
      box-shadow:0 10px 30px -8px rgba(0,0,0,.45)}
    .call-bar::before{content:"";width:9px;height:9px;border-radius:50%;
      background:currentColor;opacity:.55;
      animation:pulse 2s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:.9;transform:scale(1.15)}}
    /* Keep the footer clear of the bar. */
    footer{padding-bottom:96px}
  }

  footer{border-top:1px solid var(--line);padding:44px 0;color:var(--muted);
    font-size:.92rem;background:#fff}
  footer .bar{min-height:0;gap:18px}
  footer a{color:var(--muted)}
  footer a:hover{color:var(--accent)}

  .draft{background:${light ? 'var(--ink)' : 'var(--accent)'};
    color:${light ? 'var(--ground)' : '#0b0b0b'};font-weight:600;
    font-size:.8rem;padding:9px 18px;text-align:center;letter-spacing:.03em;
    position:relative;z-index:60;line-height:1.4}

  @media (max-width:720px){
    body{font-size:16px}
    /* Six links wrap to two rows on a phone and push the hero down. Keep
       them on one line and let it scroll sideways instead — the scrollbar
       is hidden, and the fade on the right is the affordance. */
    nav{width:100%;margin-left:0;order:3;gap:20px;
      flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;
      padding-bottom:2px;
      -webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);
      mask-image:linear-gradient(90deg,#000 88%,transparent)}
    nav::-webkit-scrollbar{display:none}
    nav a{font-size:.9rem;white-space:nowrap}
    /* The sticky call bar already carries the number, so the header's
       copy of it is just taking room. */
    .tel{display:none}
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

function page({ title, brief, palette, theme, current, body, draftNote, single = false }) {
  const b = brief;
  const t = theme;
  const tel = telHref(b.phone);
  const mail = mailtoHref(b.email);
  const links = single ? anchorsFor(t.sections) : NAV;
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${t.font}&family=Inter:wght@400;500;600;700&display=swap">
<style>${css(palette, t)}</style>
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

/**
 * The extra blocks a particular trade's site actually needs.
 *
 * Every sector was getting the same four sections, which is the fastest way
 * to look like a template. A salon's most-visited page is its price list. A
 * garage lives and dies on opening hours. A roofer who works across six
 * towns needs those towns on the page, both for the reader and because it
 * is what people search. So the theme declares what it gets.
 *
 * All of it is placeholder content the prospect edits — the point of the
 * mockup is to show them the shape, and an obviously-blank price row asks
 * a better question than an invented price does.
 */
function extraSections(b, wanted = []) {
  const out = [];

  if (wanted.includes('prices')) {
    const rows = (b.services ?? []).slice(0, 6);
    out.push(`
<section id="prices" class="alt">
  <div class="wrap">
    <div class="reveal">
      <p class="eyebrow">Price list</p>
      <h2>What it costs</h2>
      <p style="max-width:52ch;color:var(--muted)">Prices are the page people
        come for. These are blanks for you to fill in — real numbers here save
        you answering the same question all week.</p>
    </div>
    <div class="price-list reveal">
      ${(rows.length ? rows : ['Your service']).map((sv) => `
      <div class="price-row">
        <span class="price-name">${esc(sv)}</span>
        <span class="price-dots"></span>
        <span class="price-val">from £—</span>
      </div>`).join('')}
    </div>
  </div>
</section>`);
  }

  if (wanted.includes('hours')) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    out.push(`
<section id="hours">
  <div class="wrap split reveal">
    <div>
      <p class="eyebrow">Opening hours</p>
      <h2>When we're open</h2>
      <p style="color:var(--muted)">The other thing everyone checks. Fill these
        in and it stops being a phone call you have to answer.</p>
      ${b.phone ? `<p><strong>Or just ring:</strong> ${esc(b.phone)}</p>` : ''}
    </div>
    <ul class="facts">
      ${days.map((d, i) => `
      <li><b>${d}</b> <span>${i === 6 ? 'Closed' : '—'}</span></li>`).join('')}
    </ul>
  </div>
</section>`);
  }

  if (wanted.includes('areas')) {
    const areas = b.areas?.length ? b.areas : ['Your area'];
    out.push(`
<section id="areas" class="alt">
  <div class="wrap">
    <div class="reveal">
      <p class="eyebrow">Where we work</p>
      <h2>Areas we cover</h2>
      <p style="max-width:52ch;color:var(--muted)">Naming the towns matters
        twice over: it answers the first question a caller has, and it is what
        people actually type into a search.</p>
    </div>
    <div class="chips reveal">
      ${areas.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}
      <span class="chip chip-add">+ add the rest</span>
    </div>
  </div>
</section>`);
  }

  if (wanted.includes('trust')) {
    // Deliberately unfilled. Inventing a trade body or an insurance figure
    // for someone would be a lie printed on their own website.
    out.push(`
<section id="trust">
  <div class="wrap">
    <div class="reveal">
      <p class="eyebrow">Why us</p>
      <h2>Reasons to pick up the phone</h2>
    </div>
    <div class="grid reveal" data-n="3" style="margin-top:36px">
      <div class="card"><h3>Years on the tools</h3>
        <p>How long you have been going. Blank for you to fill in — it is not
           our claim to make.</p></div>
      <div class="card"><h3>Insured and accredited</h3>
        <p>Your trade body, your cover, your registration number. Only what is
           genuinely yours goes here.</p></div>
      <div class="card"><h3>What people say</h3>
        <p>One real review beats a page of marketing copy. Send a couple over
           and they go here.</p></div>
    </div>
  </div>
</section>`);
  }

  return out.join('\n');
}

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
function singleBody(b, family = 'pro', sections = []) {
  const action = primaryAction(b, { single: true });
  const services = b.services ?? [];
  const where = b.areas?.length ? b.areas.join(', ') : 'the local area';
  const tel = telHref(b.phone);
  const mail = mailtoHref(b.email);
  const eyebrow = b.areas?.length
    ? `${shortTrade(b.trade) ?? 'Local trade'} · ${b.areas[0]}`
    : (shortTrade(b.trade) ?? 'Local trade');

  // The ticker needs its items twice: the track translates by -50%, so the
  // second copy is what is on screen as the first scrolls away.
  const tickerItems = (services.length ? services : [b.trade ?? 'Quality work'])
    .concat(b.areas ?? []);
  const ticker = [...tickerItems, ...tickerItems]
    .map((t) => `<span>${esc(t)}</span>`).join('');

  return `
<div class="hero">
  <div class="mesh"></div>
  <div class="orn"></div>
  <div class="grain"></div>
  <div class="wrap">
    <div class="hero-grid">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${esc(headline(b))}</h1>
        <p class="lede">${esc(subhead(b))}</p>
        <a class="cta" href="${action.href}">${esc(action.label)}</a>
        ${b.primary_cta !== 'call' && tel
          ? `<a class="cta ghost" href="${tel}">Or call ${esc(b.phone)}</a>` : ''}
      </div>
      <div class="hero-art">${heroArt(family)}</div>
    </div>
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

${extraSections(b, sections)}

<section id="work">
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
  <div class="orn"></div>
  <div class="grain"></div>
  <div class="wrap">
    <h2>${esc(bandHeading(b))}</h2>
    <p>${esc(bandCopy(b))}</p>
    ${tel ? `<a class="cta" href="${tel}">Call ${esc(b.phone)}</a>` : ''}
    ${mail ? `<a class="cta ghost" href="${mail}">Email us</a>` : ''}
  </div>
</div>

${tel ? `
<a class="call-bar" href="${tel}">
  <span>Call ${esc(b.phone)}</span>
</a>` : ''}

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
  const trade = brief.trade ?? (brief.services ?? [])[0];
  const palette = resolvePalette(trade, brief.brand_colours ?? []);
  const theme = themeFor(trade);
  const common = { brief, palette, theme, draftNote };

  if (pages === 'single') {
    return {
      'index.html': page({
        ...common, title: 'Home', current: '#services', single: true,
        body: singleBody(brief, theme.family, theme.sections ?? []),
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
