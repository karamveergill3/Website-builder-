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
export const ALL_PLACEHOLDERS = [
  ...CANONICAL_PLACEHOLDERS,
  'phone',
  'email',
  'first_name',
  ...SENDER_PLACEHOLDERS,
];

const TOKEN = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

/** Build the substitution map for a lead row. */
export function leadContext(lead = {}) {
  const business = lead.business_name ?? '';
  return {
    business,
    category: lead.category ?? '',
    location: lead.location ?? '',
    phone: lead.phone ?? '',
    email: lead.email ?? '',
    // Best-effort friendly name: first word of the business name.
    first_name: String(business).trim().split(/\s+/)[0] ?? '',
  };
}

/**
 * The sender half of the substitution map.
 *
 * The BUSINESS identity — name, email, website — comes from Settings, which
 * is one shared Keylo record. The PERSON, though, is whoever is signed in:
 * on a team hub the same message is sent by different reps, and it has to say
 * "I'm Sam" when Sam sends it and "I'm Karam" when Karam does. So a signed-in
 * user's own name and phone overlay the shared values; the rest stays Keylo.
 * With no user (a background render, or a test) it falls back to Settings
 * throughout, which is the old single-user behaviour.
 */
export function senderContext(settings = getSettings(), user = null) {
  const v = (k) => (typeof settings[k] === 'string' ? settings[k].trim() : '');
  const own = (val) => (typeof val === 'string' && val.trim() ? val.trim() : null);
  return {
    my_name:     own(user?.name)  ?? v('biz_contact_name'),
    my_business: v('biz_name'),
    my_phone:    own(user?.phone) ?? v('biz_phone'),
    my_email:    v('biz_email'),
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

/** Render a whole template against a lead. */
export function renderTemplate(template, lead, settings, user) {
  const ctx = { ...leadContext(lead), ...senderContext(settings, user) };
  return {
    subject: render(template.subject, ctx),
    body: render(template.body, ctx),
  };
}

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
    (k) => ALL_PLACEHOLDERS.includes(k) && String(ctx[k] ?? '').trim() === ''
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
