import { Router } from 'express';
import { db, getSettings, setSetting } from '../db.js';
import { wrap, badRequest, looksLikeEmail } from '../lib/http.js';
import {
  buildFooter, missingIdentityFields, REQUIRED_IDENTITY_FIELDS,
  OPTIONAL_IDENTITY_FIELDS, DEFAULT_OPTOUT_LINE,
  DEFAULT_MARKETING_LINE, DEFAULT_SOURCE_LINE,
} from '../lib/compliance.js';

const router = Router();

/** Only these keys are writable, so a typo cannot quietly create a dead setting. */
export const ALLOWED_KEYS = new Set([
  // Identity block that appears in every email
  'biz_contact_name', 'biz_name', 'biz_address', 'biz_email',
  'biz_phone', 'biz_website', 'biz_company_number', 'biz_vat_number',
  'optout_line', 'optout_email', 'marketing_line', 'source_line',
  'biz_place_of_registration',
  // Sending guard-rails (Phase 3)
  'daily_cap', 'send_delay_seconds', 'send_delay_min_seconds', 'send_delay_max_seconds',
  // Lead search defaults (Phase 2)
  'default_areas', 'default_region_code',
  // Places pricing, so Google's repricing does not need a code change
  'places_text_search_per_1000', 'places_details_per_1000',
  'places_free_calls_per_month', 'places_pricing_verified_on',
]);

export const DEFAULTS = {
  // 25/day is roughly 5% of Gmail's technical 500/day ceiling. The binding
  // constraint is not that ceiling but abuse detection, which has no volume
  // threshold at all -- see docs/PHASE3-GMAIL.md.
  daily_cap: '25',
  send_delay_min_seconds: '120',
  send_delay_max_seconds: '420',
  default_region_code: 'GB',
  optout_line: DEFAULT_OPTOUT_LINE,
  marketing_line: DEFAULT_MARKETING_LINE,
  source_line: DEFAULT_SOURCE_LINE,
};

/** Secrets live in the settings table but are never exposed through this API. */
const SECRET_KEYS = new Set([
  'gmail_refresh_token', 'gmail_access_token', 'gmail_token_expiry',
]);

const publicSettings = (stored) =>
  Object.fromEntries(Object.entries(stored).filter(([k]) => !SECRET_KEYS.has(k)));

router.get('/', wrap((_req, res) => {
  const stored = getSettings();
  const settings = { ...DEFAULTS, ...publicSettings(stored) };
  res.json({
    settings,
    schema: {
      required_identity: REQUIRED_IDENTITY_FIELDS,
      optional_identity: OPTIONAL_IDENTITY_FIELDS,
    },
    compliance: {
      complete: missingIdentityFields(stored).length === 0,
      missing: missingIdentityFields(stored),
      footer_preview: buildFooter(stored).text,
    },
    integrations: {
      places_api_key_configured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      gmail_client_configured: Boolean(
        process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET
      ),
      gmail_connected: Boolean(stored.gmail_refresh_token),
      gmail_email: stored.gmail_email ?? null,
    },
  });
}));

router.put('/', wrap((req, res) => {
  const body = req.body ?? {};
  const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length) throw badRequest(`Unknown setting(s): ${unknown.join(', ')}`);

  if (body.biz_email && !looksLikeEmail(body.biz_email)) {
    throw badRequest('Contact email address does not look valid');
  }
  if (body.optout_email && !looksLikeEmail(body.optout_email)) {
    throw badRequest('Opt-out email address does not look valid');
  }
  // A blank value here used to slip past the range check and be stored as '',
  // which Number() reads as 0 -- a daily cap of zero, or no delay at all.
  for (const [key, min, max] of [
    ['daily_cap', 1, 500],
    ['send_delay_seconds', 0, 3600],
    ['send_delay_min_seconds', 0, 3600],
    ['send_delay_max_seconds', 0, 3600],
  ]) {
    if (body[key] === undefined) continue;
    const raw = String(body[key]).trim();
    if (raw === '') {
      // Blank means "back to the default", so drop the override entirely.
      delete body[key];
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw badRequest(`${key} must be a number between ${min} and ${max}`);
    }
  }

  for (const [key, value] of Object.entries(body)) setSetting(key, String(value ?? '').trim());

  const stored = getSettings();
  res.json({
    settings: { ...DEFAULTS, ...publicSettings(stored) },
    compliance: {
      complete: missingIdentityFields(stored).length === 0,
      missing: missingIdentityFields(stored),
      footer_preview: buildFooter(stored).text,
    },
  });
}));

export default router;
