/**
 * Deep-link generators for the free-tier channels.
 *
 *   WhatsApp — https://wa.me/{E164}?text=…
 *   SMS      — sms:{E164}?body=…
 *   Call     — tel:{E164}
 *
 * The point: no API, no fee. The user's phone opens the app with the message
 * pre-filled, and they tap once to send. Every free "WhatsApp automation"
 * ends here in the end; we just prepare the tap.
 *
 * Phone numbers are normalised to E.164 UK format. Anything the tool cannot
 * make sense of is refused rather than passed through, because a bad number
 * in a wa.me link opens WhatsApp with an error message and looks broken.
 */

/**
 * Extract digits, resolve any leading +, and collapse UK national formats to
 * E.164. Returns { ok, e164, national, reason }.
 *
 * We accept: +44…, 0044…, 44… (with 10 following digits), 0… (national),
 *   and bare 10-digit mobile/landlines without a leading 0.
 *
 * We reject: fewer than 10 or more than 15 digits, non-UK country codes we
 *   can't sanity-check, and premium ranges (09, 118) which are illegal to
 *   spam under PECR anyway.
 */
export function normalisePhone(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'no number' };

  // Keep +, digits and spaces/dashes for a moment so we can tell "+44 …"
  // apart from just digits.
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return { ok: false, reason: 'wrong length for a UK phone number' };
  }

  let e164;
  if (hasPlus || digits.startsWith('00')) {
    // International form.
    const cc = digits.startsWith('00') ? digits.slice(2) : digits;
    if (!cc.startsWith('44')) {
      return { ok: false, reason: 'only UK numbers are handled' };
    }
    e164 = '+' + cc;
  } else if (digits.startsWith('44') && digits.length >= 12) {
    e164 = '+' + digits;
  } else if (digits.startsWith('0')) {
    e164 = '+44' + digits.slice(1);
  } else if (digits.length === 10) {
    // A trimmed mobile without the leading 0.
    e164 = '+44' + digits;
  } else {
    return { ok: false, reason: 'unrecognised UK phone format' };
  }

  // A UK E.164 is +44 followed by 10 digits (mobile and most landlines).
  // A few 9-digit numbers exist (some 3-digit-area landlines with a very
  // short local part) but for outreach we can safely require 10.
  const body = e164.slice(3);
  if (body.length !== 10) {
    return { ok: false, reason: 'a UK phone number has ten digits after the 0' };
  }
  if (/^(9|118)/.test(body)) {
    return { ok: false, reason: 'premium-rate numbers are not for outreach' };
  }

  // Only 07 mobiles are guaranteed on WhatsApp / SMS; the tool still returns
  // the number for tel: but flags it.
  const mobile = body.startsWith('7');
  return {
    ok: true,
    e164,
    national: '0' + body,
    mobile,
    reason: null,
  };
}

/**
 * WhatsApp click-to-chat link. Body encoding is percent-encoding on the whole
 * text, not form-encoding, so encodeURIComponent is correct (space -> %20).
 * See https://faq.whatsapp.com/5913398998672934/ .
 */
export function whatsappLink({ phone, text }) {
  const p = normalisePhone(phone);
  if (!p.ok) return { ok: false, reason: p.reason };
  const url = `https://wa.me/${p.e164.replace('+', '')}`
    + (text ? `?text=${encodeURIComponent(text)}` : '');
  return { ok: true, url, e164: p.e164, mobile: p.mobile };
}

/**
 * SMS: link. Every mobile OS accepts sms:<number>?body=<text>; iOS also
 * accepts sms:&body=... The single-? form works everywhere.
 */
export function smsLink({ phone, text }) {
  const p = normalisePhone(phone);
  if (!p.ok) return { ok: false, reason: p.reason };
  const url = `sms:${p.e164}`
    + (text ? `?body=${encodeURIComponent(text)}` : '');
  return { ok: true, url, e164: p.e164, mobile: p.mobile };
}

export function telLink({ phone }) {
  const p = normalisePhone(phone);
  if (!p.ok) return { ok: false, reason: p.reason };
  return { ok: true, url: `tel:${p.e164}`, e164: p.e164, mobile: p.mobile };
}

/**
 * The single entry point views use: pick a channel and get a link back.
 */
export function handoff({ channel, phone, text }) {
  switch (channel) {
    case 'whatsapp': return whatsappLink({ phone, text });
    case 'sms':      return smsLink({ phone, text });
    case 'call':     return telLink({ phone });
    default:
      return { ok: false, reason: `unknown channel: ${channel}` };
  }
}
