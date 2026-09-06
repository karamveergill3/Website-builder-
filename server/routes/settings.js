import { Router } from 'express';
import { getSettings, setSetting } from '../db.js';
import { wrap, badRequest, looksLikeEmail } from '../lib/http.js';
import {
  buildFooter, missingIdentityFields, REQUIRED_IDENTITY_FIELDS,
  OPTIONAL_IDENTITY_FIELDS, DEFAULT_OPTOUT_LINE,
} from '../lib/compliance.js';

const router = Router();

/** Only these keys are writable, so a typo cannot quietly create a dead setting. */
export const ALLOWED_KEYS = new Set([
  // Identity block that appears in every email
  'biz_contact_name', 'biz_name', 'biz_address', 'biz_email',
  'biz_phone', 'biz_website', 'biz_company_number', 'biz_vat_number',
  'optout_line', 'optout_email',
  // Sending guard-rails (Phase 3)
  'daily_cap', 'send_delay_seconds',
  // Lead search defaults (Phase 2)
  'default_areas', 'default_region_code',
]);

export const DEFAULTS = {
  daily_cap: '20',
  send_delay_seconds: '45',
  default_region_code: 'GB',
  optout_line: DEFAULT_OPTOUT_LINE,
};

router.get('/', wrap((_req, res) => {
  const stored = getSettings();
  const settings = { ...DEFAULTS, ...stored };
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
  for (const [key, min, max] of [['daily_cap', 1, 500], ['send_delay_seconds', 0, 3600]]) {
    if (body[key] === undefined || body[key] === '') continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw badRequest(`${key} must be a number between ${min} and ${max}`);
    }
  }

  for (const [key, value] of Object.entries(body)) setSetting(key, String(value ?? '').trim());

  const stored = getSettings();
  res.json({
    settings: { ...DEFAULTS, ...stored },
    compliance: {
      complete: missingIdentityFields(stored).length === 0,
      missing: missingIdentityFields(stored),
      footer_preview: buildFooter(stored).text,
    },
  });
}));

export default router;
