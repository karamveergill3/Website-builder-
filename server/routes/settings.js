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
  'warmup_enabled', 'window_enabled', 'window_start_hour', 'window_end_hour',
  'window_weekdays_only', 'domain_cooldown_days', 'list_unsubscribe_enabled',
  'verify_addresses', 'spam_check_enabled',
  // Daily hunt
  'hunt_enabled', 'hunt_trades', 'hunt_areas', 'hunt_daily_target', 'hunt_hour',
  'hunt_max_places_requests', 'hunt_max_register_pages', 'hunt_max_per_trade',
  'hunt_require_no_website', 'hunt_include_unlisted', 'hunt_require_phone',
  'hunt_require_mobile',
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
  warmup_enabled: '1',
  window_enabled: '1',
  window_start_hour: '9',
  window_end_hour: '17',
  window_weekdays_only: '1',
  domain_cooldown_days: '14',
  // Google scopes the one-click unsubscribe requirement to senders of 5,000+
  // a day. Below that the header buys nothing and costs something: Gmail
  // draws an "Unsubscribe" chip beside the sender, which files the message
  // as bulk in the reader's mind. The opt-out line in the body does the same
  // job and produces a reply, which is the strongest positive signal there is.
  list_unsubscribe_enabled: '0',
  verify_addresses: '1',
  spam_check_enabled: '1',
  hunt_enabled: '0',
  hunt_trades: '',
  hunt_areas: '',
  hunt_daily_target: '10',
  hunt_hour: '8',
  // The register is free, so read plenty of it: most high-street trades are
  // sole traders the register does not hold, so it takes a lot of pages to
  // turn up enough limited companies to hit the target. Google lookups do
  // cost against the free 5,000/SKU/month, but only for towns that actually
  // held a fresh company — 120 a run is ~3,600 a month, well inside the free
  // allowance even run daily.
  hunt_max_places_requests: '120',
  hunt_max_register_pages: '200',
  // A day of twenty roofers is a worse day's calling than a mixed list,
  // and it puts all the risk on one trade answering cold contact.
  hunt_max_per_trade: '3',
  hunt_require_no_website: '1',
  // Off by default: it needs the Google key, and turning it on without one
  // would make a fresh install refuse to run.
  hunt_require_phone: '0',
  // Tighter still: only 07 numbers, the ones WhatsApp and SMS reach. Off by
  // default for the same reason as the line above, and because a landline is
  // still a business you can ring.
  hunt_require_mobile: '0',
  hunt_include_unlisted: '1',
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
    ['window_start_hour', 0, 23],
    ['window_end_hour', 1, 24],
    ['domain_cooldown_days', 0, 365],
    ['hunt_daily_target', 1, 200],
    ['hunt_hour', 0, 23],
    ['hunt_max_places_requests', 1, 500],
    ['hunt_max_register_pages', 1, 200],
    ['hunt_max_per_trade', 1, 50],
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
