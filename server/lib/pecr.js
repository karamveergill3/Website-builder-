/**
 * The rules that decide whether a given lead may lawfully be cold-emailed.
 *
 * Under PECR regulation 22 the test is the recipient's LEGAL FORM, not whether
 * the address looks like a business one:
 *
 *   Corporate subscriber — limited companies, PLCs, LLPs, Scottish
 *   partnerships, CICs, chartered bodies, public bodies. Regulation 22 does
 *   not apply, so unsolicited marketing email is permitted without consent.
 *
 *   Individual subscriber — sole traders, ordinary (non-LLP) partnerships in
 *   England, Wales and NI, and private individuals. Regulation 22 applies in
 *   full: consent or a soft opt-in is required, and neither exists for a lead
 *   that came out of a map listing.
 *
 * A great many small trades are sole traders, so most of what a Google Places
 * sweep returns will land in the blocked bucket. That is the correct outcome,
 * not a bug in the filter.
 *
 * Regulation 23 applies to BOTH kinds and to every marketing email: the sender
 * must not conceal their identity and must give a valid address for opt-out
 * requests. That part is handled in lib/compliance.js.
 *
 * Sources and caveats: docs/COMPLIANCE.md. This is not legal advice.
 */

export const ENTITY_TYPES = ['unknown', 'corporate', 'individual'];

export const ENTITY_LABELS = {
  unknown:    'Not checked yet',
  corporate:  'Limited company / LLP',
  individual: 'Sole trader / individual',
};

/**
 * Free webmail domains. Even where the business is a limited company, the
 * subscriber of a personal mailbox is the individual, so these are always
 * treated as individual subscribers.
 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.co.uk', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'aol.com', 'aol.co.uk', 'icloud.com', 'me.com', 'mac.com',
  'btinternet.com', 'btopenworld.com', 'sky.com', 'virginmedia.com',
  'talktalk.net', 'blueyonder.co.uk', 'ntlworld.com', 'tiscali.co.uk',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.co.uk', 'zoho.com',
  'mail.com', 'yandex.com', 'fastmail.com', 'hushmail.com',
]);

export const emailDomain = (email) =>
  String(email ?? '').trim().toLowerCase().split('@')[1] ?? '';

export const isFreeMail = (email) => FREE_MAIL_DOMAINS.has(emailDomain(email));

/**
 * Names that strongly suggest a corporate subscriber. Only ever used to
 * pre-select a suggestion in the UI — never to classify a lead on its own,
 * because a trading name is not proof of incorporation.
 */
const CORPORATE_NAME = /(\b|\s)(ltd|ltd\.|limited|plc|p\.l\.c|llp|l\.l\.p|cic|c\.i\.c|cyf|cyfyngedig|incorporated|inc)\b/i;

export const looksCorporate = (businessName) => CORPORATE_NAME.test(String(businessName ?? ''));

/**
 * The single gate every send path calls.
 * Returns { allowed, code, reason } — never throws.
 *
 * Channel matters. The regulation covers different acts:
 *
 *   email    — PECR reg 22, corporate-only, applies to unsolicited marketing
 *   sms      — PECR reg 22, same test as email (electronic mail includes SMS)
 *   whatsapp — PECR reg 22, treated the same as SMS for marketing purposes
 *   call     — PECR reg 21, and TPS/CTPS registration takes precedence
 *
 * The corporate-vs-individual gate is the same across all four. The email-
 * specific "must have an email" / "free-mail" tests only run for the email
 * channel; the others need a phone number instead. TPS/CTPS lookups are
 * NOT automated here — there is no free bulk-check API — but the response
 * carries a reminder for the caller to check before making calls at scale.
 */
export function sendability(lead, arg = {}) {
  const opts = typeof arg === 'string' ? { channel: arg } : arg;
  const { channel = 'email', suppressed = false } = opts;
  const no = (code, reason) => ({ allowed: false, code, reason, channel });

  if (!lead) return no('NO_LEAD', 'That lead no longer exists.');

  if (lead.opted_out === 1 || lead.opted_out === true) {
    return no('OPTED_OUT',
      `${lead.business_name} has opted out. Opted-out leads are excluded from every send.`);
  }

  // A live phone call is PECR regulation 21, NOT regulation 22: it is lawful
  // to any business number — a limited company or a sole trader alike — that
  // is not registered with TPS/CTPS. We cannot bulk-check those registers for
  // free, so the call is allowed and the response carries the reminder to
  // screen the number first. This is the lawful way to reach a sole trader.
  if (channel === 'call') {
    if (!lead.phone) return no('NO_PHONE', `${lead.business_name} has no phone number.`);
    return {
      allowed: true, code: 'OK', reason: null, channel,
      advice: 'Before calling, check the number is not on TPS (tpsonline.org.uk), or CTPS '
        + '(ctpsonline.org.uk) for a limited company. A registered number must not be cold-called.',
    };
  }

  // Everything else — email, SMS, WhatsApp — is "electronic mail" under PECR
  // regulation 22. Consent recorded against the lead is exactly what reg 22
  // asks for, so a business that agreed to be messaged (typically on a call)
  // may be messaged whatever its legal form. Opt-out and suppression still win.
  const consented = Boolean(lead.messaging_consent_at);

  if (channel === 'email') {
    if (suppressed) {
      return no('SUPPRESSED',
        `${lead.email} is on your suppression list from a previous opt-out and cannot be emailed.`);
    }
    if (!lead.email) {
      return no('NO_EMAIL', `${lead.business_name} has no email address.`);
    }
    if (!consented && isFreeMail(lead.email)) {
      return no('FREE_MAIL',
        `${lead.email} is a personal mailbox (${emailDomain(lead.email)}). The subscriber is the ` +
        'individual, not the business, so PECR regulation 22 applies and cold email is not permitted ' +
        'without consent. Phone them instead, or find a company address.');
    }
  } else if (channel === 'sms' || channel === 'whatsapp') {
    if (!lead.phone) {
      return no('NO_PHONE', `${lead.business_name} has no phone number.`);
    }
  } else {
    return no('BAD_CHANNEL', `Unknown channel: ${channel}`);
  }

  // Recorded consent clears the reg 22 gate for any legal form.
  if (consented) {
    return { allowed: true, code: 'OK', reason: null, channel };
  }

  if (lead.entity_type === 'individual') {
    const noun = channel === 'email' ? 'unsolicited marketing email' : 'unsolicited marketing message';
    return no('INDIVIDUAL_SUBSCRIBER',
      `${lead.business_name} is marked as a sole trader or ordinary partnership. Under PECR ` +
      `regulation 22 these are individual subscribers, so ${noun} needs their prior consent — ` +
      'call them first, and record their agreement on the Reach screen.');
  }
  if (lead.entity_type !== 'corporate') {
    return no('UNCLASSIFIED',
      `${lead.business_name} has not been checked yet. Confirm whether it is a limited company ` +
      'or LLP (which may be messaged) or a sole trader (call first, then record consent) before ' +
      'sending. Search the name on the Companies House register if you are unsure.');
  }
  return { allowed: true, code: 'OK', reason: null, channel };
}
