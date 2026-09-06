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

/**
 * Included when set. Some become legally required depending on how the sender
 * trades -- a limited company must disclose its number, place of registration
 * and registered office; a VAT number is not required in marketing email at
 * all. See docs/COMPLIANCE.md.
 */
export const OPTIONAL_IDENTITY_FIELDS = [
  { key: 'biz_phone',                 label: 'Phone' },
  { key: 'biz_website',               label: 'Website' },
  { key: 'biz_company_number',        label: 'Company registration number' },
  { key: 'biz_place_of_registration', label: 'Place of registration' },
  { key: 'biz_vat_number',            label: 'VAT number' },
];

export const DEFAULT_OPTOUT_LINE =
  'If you would rather not hear from me again, just reply with "STOP" and I will add you to my '
  + 'do-not-contact list and not write again.';

/**
 * PECR reg 23(c) pulls in reg 7 of the E-Commerce Regulations 2002: a
 * commercial communication must be clearly identifiable as one. A single
 * plain line does that.
 */
export const DEFAULT_MARKETING_LINE = 'This is a marketing email from {{trading_name}}.';

/**
 * UK GDPR Article 14: where contact details were obtained from a third party
 * rather than from the person, they must be told -- and where the data is used
 * to contact them, the deadline is that first contact. Saying it inline is the
 * cheapest way to discharge it.
 */
export const DEFAULT_SOURCE_LINE =
  'I found your business details on publicly available listings such as Google Maps. '
  + 'I use them only to introduce my own services, and you can object at any time.';

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

  const marketingLine = (val(settings, 'marketing_line') ?? DEFAULT_MARKETING_LINE)
    .replace(/\{\{\s*trading_name\s*\}\}/gi, trading);
  const sourceLine = val(settings, 'source_line') ?? DEFAULT_SOURCE_LINE;

  const lines = [marketingLine, ''];

  // Trading disclosure. A sole trader using a name that is not their own
  // surname must give their full name and a UK address for service
  // (Companies Act 2006 s.1202); a company must give its registered name,
  // number, place of registration and registered office.
  const co = val(settings, 'biz_company_number');
  if (co) {
    lines.push(
      `${trading}${/\b(ltd|limited|plc|llp|cic)\b/i.test(trading) ? '' : ' Ltd'}, ` +
      `registered in ${val(settings, 'biz_place_of_registration') ?? 'England and Wales'}, ` +
      `company no. ${co}.`
    );
    lines.push(`Registered office: ${val(settings, 'biz_address')}`);
    lines.push(`Contact: ${name}`);
  } else {
    lines.push(`${name}, trading as ${trading}.`);
    lines.push(val(settings, 'biz_address'));
  }

  const contact = [
    val(settings, 'biz_email'),
    val(settings, 'biz_phone'),
    val(settings, 'biz_website'),
  ].filter(Boolean);
  if (contact.length) lines.push(contact.join(' · '));

  const vat = val(settings, 'biz_vat_number');
  if (vat) lines.push(`VAT no. ${vat}`);

  lines.push('');
  lines.push(sourceLine);
  lines.push('');
  lines.push(optOutLine);

  return {
    text: `-- \n${lines.join('\n')}`,
    optOutLine,
    marketingLine,
    sourceLine,
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
