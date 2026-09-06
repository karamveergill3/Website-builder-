/**
 * Every email this tool produces -- whether it leaves via mailto:, the
 * clipboard, or the Gmail API -- carries an identity block and an opt-out
 * line. Under PECR reg. 23 the sender of a marketing email must not conceal
 * their identity and must provide a valid address for opt-out requests, so
 * this is not decoration: `buildFooter` refuses to produce a footer when the
 * legally required details are missing, and the send paths refuse to send
 * without one.
 *
 * The exact required/optional split is documented in docs/COMPLIANCE.md.
 */
import { getSettings } from '../db.js';

/** Fields without which we will not let an email out of the door. */
export const REQUIRED_IDENTITY_FIELDS = [
  { key: 'biz_contact_name', label: 'Your name' },
  { key: 'biz_name',         label: 'Trading name' },
  { key: 'biz_address',      label: 'Postal address' },
  { key: 'biz_email',        label: 'Contact email address' },
];

/** Included when set; some are legally required only for certain entity types. */
export const OPTIONAL_IDENTITY_FIELDS = [
  { key: 'biz_phone',          label: 'Phone' },
  { key: 'biz_website',        label: 'Website' },
  { key: 'biz_company_number', label: 'Company registration number' },
  { key: 'biz_vat_number',     label: 'VAT number' },
];

export const DEFAULT_OPTOUT_LINE =
  'If you would rather not hear from me again, just reply with "STOP" and I will remove you from my list.';

const val = (settings, key) => {
  const v = settings[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

/** Which required identity fields are still blank. */
export function missingIdentityFields(settings = getSettings()) {
  return REQUIRED_IDENTITY_FIELDS.filter((f) => val(settings, f.key) === null);
}

export function identityComplete(settings = getSettings()) {
  return missingIdentityFields(settings).length === 0;
}

/**
 * Build the plain-text footer appended to every outgoing email.
 * Returns { text, optOutLine, complete, missing }.
 */
export function buildFooter(settings = getSettings()) {
  const missing = missingIdentityFields(settings);
  const optOutLine = val(settings, 'optout_line') ?? DEFAULT_OPTOUT_LINE;

  if (missing.length) {
    return { text: null, optOutLine, complete: false, missing };
  }

  const name    = val(settings, 'biz_contact_name');
  const trading = val(settings, 'biz_name');
  const lines = [`${name} — ${trading}`, val(settings, 'biz_address')];

  const contact = [
    val(settings, 'biz_email'),
    val(settings, 'biz_phone'),
    val(settings, 'biz_website'),
  ].filter(Boolean);
  if (contact.length) lines.push(contact.join(' · '));

  const registration = [];
  const co  = val(settings, 'biz_company_number');
  const vat = val(settings, 'biz_vat_number');
  if (co)  registration.push(`Registered in England & Wales, company no. ${co}`);
  if (vat) registration.push(`VAT no. ${vat}`);
  if (registration.length) lines.push(registration.join(' · '));

  lines.push('');
  lines.push(optOutLine);

  return {
    text: `-- \n${lines.join('\n')}`,
    optOutLine,
    complete: true,
    missing: [],
  };
}

/**
 * Append the footer to a rendered body, unless it is somehow already there.
 * Throws if identity details are incomplete -- callers must check first.
 */
export function withFooter(body, settings = getSettings()) {
  const footer = buildFooter(settings);
  if (!footer.complete) {
    const err = new Error(
      'Cannot build a compliant email: missing ' +
      footer.missing.map((f) => f.label).join(', ') +
      '. Fill these in on the Settings screen.'
    );
    err.status = 422;
    err.details = { missing: footer.missing };
    throw err;
  }
  const trimmed = String(body ?? '').replace(/\s+$/, '');
  if (trimmed.includes(footer.text)) return trimmed;
  return `${trimmed}\n\n${footer.text}\n`;
}

/**
 * The mailto: address used for List-Unsubscribe headers and the opt-out line.
 * Falls back to the sender's own contact address.
 */
export function optOutMailto(settings = getSettings()) {
  return val(settings, 'optout_email') ?? val(settings, 'biz_email');
}
