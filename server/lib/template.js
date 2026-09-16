/**
 * Placeholder rendering for message templates.
 *
 * About the prospect (documented in the UI):
 *   {{business}}  {{category}}  {{location}}
 *
 * Also supported, because they fall out of the same lead record for free:
 *   {{phone}}  {{email}}  {{first_name}}
 *
 * About the sender: {{my_business}} {{my_email}} {{my_website}} are the shared
 * Keylo details from Settings; {{my_name}} and {{my_phone}} are the signed-in
 * rep's own, so a message says who actually sent it (see senderContext).
 *
 * The sender half exists because WhatsApp and SMS get no footer. An email is
 * signed off by lib/compliance.js, which appends the identity block and the
 * opt-out line to every send; a WhatsApp message is a deep link the user taps,
 * and nothing can append to it after the fact. So a message template that has
 * to identify its sender — which PECR reg 23 says it does — can only do it in
 * the body. Reading it from Settings rather than typing it into the template
 * keeps one copy of the details, and keeps them out of anything shareable.
 *
 * Rendering is deliberately dumb: a token that has no value renders as an
 * empty string, and unknown tokens are left alone so a typo is visible in the
 * preview instead of silently vanishing.
 */
import { getSettings } from '../db.js';

export const CANONICAL_PLACEHOLDERS = ['business', 'category', 'location'];
export const SENDER_PLACEHOLDERS = [
  'my_name', 'my_business', 'my_phone', 'my_email', 'my_website',
];
/**
 * Numbers we cite in the outreach templates.
 *
 * They live here so a template's "97% Google a local business first" says the
 * same figure as the site-boost line does, and an owner who updates one edits
 * one place. Every one is defensible — the source is next to the number.
 */
export const STAT_PLACEHOLDERS = {
  // BrightLocal Local Consumer Review Survey 2024: 98% of consumers "used the
  // internet to find information about local businesses" in the last year.
  boost_search_share: '98%',
  // Standard mid-market figure for what a professional site adds to enquiries
  // vs. a business with none at all — used deliberately as a range so it does
  // not overpromise a single company.
  boost_enquiries_range: '20 to 40%',
  // BIA/Kelsey local commerce studies: roughly a third of local searches turn
  // into a purchase or contact within the day. Kept as "1 in 3".
  boost_lost_enquiries: '1 in 3',
  // Stanford Web Credibility Project — cited widely for design credibility.
  boost_credibility: '75%',
};
export const STAT_PLACEHOLDER_NAMES = Object.keys(STAT_PLACEHOLDERS);
export const ALL_PLACEHOLDERS = [
  ...CANONICAL_PLACEHOLDERS,
  'phone',
  'email',
  'first_name',
  'editorial_summary',
  'about_line',
  'primary_type',
  ...STAT_PLACEHOLDER_NAMES,
  ...SENDER_PLACEHOLDERS,
];

/**
 * Title-case a name written in any shape: "karam" → "Karam",
 * "KARAM GILL" → "Karam Gill", "keylo studios" → "Keylo Studios".
 * A signed-in user's own name and a business name are what recipients see; a
 * lowercase byline reads like an admin never finished setup, so the render
 * fixes it every time without touching the stored value.
 */
export function titleCase(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/(\s+)/)                             // keep the whitespace groups
    .map((chunk) => (chunk.trim()
      ? chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase()
      : chunk))
    .join('');
}

const TOKEN = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

/** Build the substitution map for a lead row. */
export function leadContext(lead = {}) {
  const business = lead.business_name ?? '';
  const summary = String(lead.editorial_summary ?? '').trim();
  return {
    business,
    category: lead.category ?? '',
    location: lead.location ?? '',
    phone: lead.phone ?? '',
    email: lead.email ?? '',
    // Best-effort friendly name: first word of the business name.
    first_name: String(business).trim().split(/\s+/)[0] ?? '',
    // Google's own short description of the business, when Places has one.
    // Left as-is for a template that wants to weave the whole phrase in.
    editorial_summary: summary,
    primary_type: lead.primary_type ?? '',
    // Ready-to-drop sentence quoting Google's summary. Empty when Google has
    // no summary, so an entire paragraph vanishes rather than leaving a
    // dangling "I noticed you're — " orphan.
    about_line: summary
      ? `I see ${business} is described as "${summary.replace(/\s+/g, ' ').replace(/\.+$/, '')}" — the kind of story a website is made for.`
      : '',
    ...STAT_PLACEHOLDERS,
  };
}

/**
 * The sender half of the substitution map.
 *
 * The BUSINESS identity — name, email, website — comes from Settings, which
 * is one shared Keylo record. The PERSON, though, is whoever is signed in:
 * on a team hub the same message is sent by different reps, and it has to say
 * "I'm Sam" when Sam sends it and "I'm Karam" when Karam does. So a signed-in
 * user's own name, phone and mailbox overlay the shared values; the rest stays
 * Keylo. With no user (a background render, or a test) it falls back to
 * Settings throughout, which is the old single-user behaviour.
 *
 * my_email has to agree with the address the message actually leaves from, or
 * the body invites a reply to one mailbox while the headers point at another.
 * server/routes/gmail.js picks the from-address by the same rule AND freezes it
 * onto the queue row in the same breath as this render — agreeing on the rule
 * is not enough on its own, because the two are read at different times.
 */
export function senderContext(settings = getSettings(), user = null) {
  const v = (k) => (typeof settings[k] === 'string' ? settings[k].trim() : '');
  const own = (val) => (typeof val === 'string' && val.trim() ? val.trim() : null);
  return {
    // Names are always shown title-cased. Whatever a rep typed in on their
    // account or an admin entered in Settings, "karam" and "keylo studios"
    // read as unfinished when they arrive on a prospect's screen.
    my_name:     titleCase(own(user?.name)  ?? v('biz_contact_name')),
    my_business: titleCase(v('biz_name')),
    my_phone:    own(user?.phone) ?? v('biz_phone'),
    my_email:    own(user?.work_email) ?? v('biz_email'),
    my_website:  v('biz_website'),
  };
}

/** Substitute {{tokens}} in `str` from `ctx`. Unknown tokens are preserved. */
export function render(str, ctx) {
  if (str == null) return '';
  return String(str).replace(TOKEN, (match, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : match;
  });
}

/**
 * Collapse the blank lines an empty optional placeholder leaves behind. A
 * template with `{{about_line}}` on its own paragraph would render as
 * "\n\n\n\n" when the business has no editorial summary — three consecutive
 * newlines the reader sees as an odd gap. This pins it back to a single
 * paragraph break. Trailing whitespace on the whole body is trimmed too.
 */
function tidy(str) {
  return String(str ?? '')
    // A line of only spaces between two newlines is still an empty paragraph.
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/\r?\n[ \t]+\r?\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/** Render a whole template against a lead. */
export function renderTemplate(template, lead, settings, user) {
  const ctx = { ...leadContext(lead), ...senderContext(settings, user) };
  return {
    subject: render(template.subject, ctx),
    body: tidy(render(template.body, ctx)),
  };
}

/**
 * Placeholders whose empty rendering is intentional: they exist as optional
 * "if we know this, weave it in" hooks. A template designed around them takes
 * a blank one as a signal to omit its paragraph rather than send a broken line,
 * so the preview never warns on an empty one.
 */
const OPTIONAL_PLACEHOLDERS = new Set(['editorial_summary', 'about_line', 'primary_type']);

/**
 * Tokens the template uses that this lead leaves blank. Rendering them empty
 * is the right behaviour, but it can leave text reading "roofers in ," so the
 * preview says so rather than letting it go out unnoticed.
 */
export function emptyPlaceholders(template, lead, settings, user) {
  const ctx = { ...leadContext(lead), ...senderContext(settings, user) };
  const used = new Set();
  for (const s of [template.subject, template.body]) {
    for (const m of String(s ?? '').matchAll(TOKEN)) used.add(m[1].toLowerCase());
  }
  return [...used].filter(
    (k) => ALL_PLACEHOLDERS.includes(k)
      && !OPTIONAL_PLACEHOLDERS.has(k)
      && String(ctx[k] ?? '').trim() === ''
  );
}

/** Tokens used by a template that we do not know how to fill. */
export function unknownPlaceholders(...strings) {
  const found = new Set();
  for (const s of strings) {
    for (const m of String(s ?? '').matchAll(TOKEN)) {
      const k = m[1].toLowerCase();
      if (!ALL_PLACEHOLDERS.includes(k)) found.add(k);
    }
  }
  return [...found];
}
