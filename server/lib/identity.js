/**
 * Copy business-identity values from .env into the settings table.
 *
 * These live in .env, which is gitignored — never in the repo, and never in
 * the database when it is copied about. Manual edits in Settings always win:
 * a row that already has a value is never overwritten.
 *
 * This sits in its own module because two entry points need it and only one
 * of them is the server. The doctor reads the settings TABLE to decide
 * whether the legally-required identity is present, so before this module
 * existed it would tell you to put the values in .env and then, on the very
 * next run, report them missing — because nothing had copied them across
 * yet. Importing index.js to reach the function was not an option: that
 * module calls app.listen() on import.
 */
import { getSetting, setSetting } from '../db.js';

/** Environment variable to settings key. */
export const ENV_SEEDS = {
  BIZ_TRADING_NAME:          'biz_name',
  BIZ_CONTACT_NAME:          'biz_contact_name',
  BIZ_ADDRESS:               'biz_address',
  BIZ_EMAIL:                 'biz_email',
  BIZ_PHONE:                 'biz_phone',
  BIZ_WEBSITE:               'biz_website',
  BIZ_COMPANY_NUMBER:        'biz_company_number',
  BIZ_VAT_NUMBER:            'biz_vat_number',
  BIZ_PLACE_OF_REGISTRATION: 'biz_place_of_registration',
};

/**
 * Seed anything the user has not already set by hand. Returns the settings
 * keys that were written, so a caller can say what it did rather than
 * changing the database silently.
 */
export function seedIdentityFromEnv() {
  const seeded = [];
  for (const [envKey, settingKey] of Object.entries(ENV_SEEDS)) {
    const v = process.env[envKey]?.trim();
    if (!v) continue;
    if (getSetting(settingKey, '')) continue; // manual edits win
    setSetting(settingKey, v);
    seeded.push(settingKey);
  }
  return seeded;
}

/**
 * Which BIZ_* variables are set in the environment right now.
 *
 * Lets a caller tell "you have not written these down anywhere" apart from
 * "they are in .env but nothing has read them yet" — two problems with very
 * different fixes, which looked identical before.
 */
export const envIdentityKeys = () =>
  Object.keys(ENV_SEEDS).filter((k) => process.env[k]?.trim());
