/**
 * Placeholder rendering for email templates.
 *
 * Canonical placeholders (documented in the UI):
 *   {{business}}  {{category}}  {{location}}
 *
 * Also supported, because they fall out of the same lead record for free:
 *   {{phone}}  {{email}}  {{first_name}}
 *
 * Rendering is deliberately dumb: a token that has no value renders as an
 * empty string, and unknown tokens are left alone so a typo is visible in the
 * preview instead of silently vanishing.
 */

export const CANONICAL_PLACEHOLDERS = ['business', 'category', 'location'];
export const ALL_PLACEHOLDERS = [
  ...CANONICAL_PLACEHOLDERS,
  'phone',
  'email',
  'first_name',
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

/** Substitute {{tokens}} in `str` from `ctx`. Unknown tokens are preserved. */
export function render(str, ctx) {
  if (str == null) return '';
  return String(str).replace(TOKEN, (match, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : match;
  });
}

/** Render a whole template against a lead. */
export function renderTemplate(template, lead) {
  const ctx = leadContext(lead);
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
export function emptyPlaceholders(template, lead) {
  const ctx = leadContext(lead);
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
