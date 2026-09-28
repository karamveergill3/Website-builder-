/**
 * Reading WhatsApp messages copied out of WhatsApp.
 *
 * WhatsApp keeps its chats to itself, and the only free way in that breaks no
 * rule of theirs is the clipboard: select their messages on WhatsApp Desktop
 * (or Web) and copy, and each one comes with a header saying when it was sent
 * and who by, "+44 7700 900123" for anyone not saved in the phone. That
 * number is how a paste finds its lead without anybody picking one. An
 * exported chat carries the same headers, in the phone's own layout.
 *
 *   [17:05, 28/09/2026] +44 7700 900123: Yes please     WhatsApp Desktop, Web
 *   [28/09/2026, 17:05:12] +44 7700 900123: Yes please  iPhone export
 *   28/09/2026, 17:05 - +44 7700 900123: Yes please     Android export
 *
 * A single message copied on its own has no header at all; then the text is
 * all there is, and the screen asks whose it is.
 *
 * Pure functions, no database: routes/mockups.js does the filing.
 */
import { createHash } from 'node:crypto';
import { normalisePhone } from './handoff.js';

/** Spaces WhatsApp uses that are not a plain space (before am/pm, in numbers). */
const ODD_SPACES = /[   ]/g;
/**
 * Direction marks and other invisible characters exports are sprinkled with.
 * Not the zero-width joiners (U+200C, U+200D): those hold emoji like 🤷‍♂️ together.
 */
const INVISIBLE = /[​‎‏‪-‮⁠⁦-⁩﻿]/g;

const DATE = String.raw`(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?\s?m\.?)?`;
const WHO = String.raw`([^:\n]{1,80}?):(?:\s|$)(.*)$`;

// [17:05, 28/09/2026] Name: text
const TIME_FIRST = new RegExp(String.raw`^\[${TIME},\s*${DATE}\]\s*${WHO}`, 'i');
// [28/09/2026, 17:05:12] Name: text      (iPhone export)
const DATE_BRACKET = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s*${WHO}`, 'i');
// 28/09/2026, 17:05 - Name: text          (Android export)
const DATE_DASH = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+-\s+${WHO}`, 'i');
// A dated line with no sender: WhatsApp's own notices, in an Android export
// only (anywhere else a line like "30/09/26 10.00 - 12.00" is part of a message).
const NOTICE = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+-\s+[^:]*$`, 'i');
/** WhatsApp's own notices, which an iPhone export files under the chat's name. */
const SYSTEM = /^(?:messages and calls are end-to-end encrypted|messages to this chat and calls are now secured|this business uses a secure service|this chat is with a business account|your security code with .* changed|missed (?:voice|video) call|.* is a contact\.?$)/i;

/** What an export writes in place of a photo, voice note and the like. */
const MEDIA = [
  [/^<media omitted>$/i, '[a photo or file]'],
  [/^(?:image|photo) omitted$/i, '[a photo]'],
  [/^video omitted$/i, '[a video]'],
  [/^(?:audio|voice message) omitted$/i, '[a voice note]'],
  [/^sticker omitted$/i, '[a sticker]'],
  [/^gif omitted$/i, '[a GIF]'],
  [/^document omitted$/i, '[a document]'],
  [/^<attached: [^>]*>$/i, '[a photo or file]'],
];
const EDITED = /\s*<this message was edited>\s*$/i;
const DELETED = /^(?:this message was deleted|you deleted this message)\.?$/i;

/**
 * The UK local time WhatsApp printed, as an ISO instant. A day/month order is
 * assumed (these are UK phones) unless the numbers say otherwise, and a time
 * that reads as the future is not trusted.
 */
function toIso(dd, mm, yy, hh, min, ss, ampm, now) {
  let d = Number(dd); let m = Number(mm);
  if (m > 12 && d <= 12) [d, m] = [m, d];
  let y = Number(yy);
  if (y < 100) y += 2000;
  let h = Number(hh);
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || Number(min) > 59) return null;
  const guess = Date.UTC(y, m - 1, d, h, Number(min), Number(ss ?? 0));
  if (Number.isNaN(guess)) return null;
  // Europe/London is UTC in winter and an hour ahead in summer: read the
  // offset for that moment rather than assume one.
  const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  const at = new Date(guess - (shown - asUtc));
  if (Number.isNaN(at.getTime()) || at.getTime() > now + 10 * 60_000) return null;
  return at.toISOString();
}

function cleanText(text) {
  return String(text ?? '').split('\n').map((line) => {
    const t = line.replace(EDITED, '').trim();
    for (const [re, as] of MEDIA) if (re.test(t)) return as;
    return t;
  }).join('\n').trim();
}

/** "+44 7700 900123" -> "+447700900123"; a name -> null. */
export function senderPhone(sender) {
  const s = String(sender ?? '').trim();
  if (!/^\+?[\d\s()-]{9,}$/.test(s)) return null;
  const n = normalisePhone(s);
  if (n.ok) return n.e164;
  // Somewhere other than the UK: still a number, so keep it for matching.
  const digits = s.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/**
 * Every message in a paste, in order: who sent it, when, and what it said.
 * `headed` is false when nothing in it carried a WhatsApp header, and the
 * whole paste is then one message from an unknown sender.
 */
export function parseWhatsApp(input, { now = Date.now() } = {}) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n').replace(ODD_SPACES, ' ').replace(INVISIBLE, '');
  const messages = [];
  const lines = text.split('\n');
  const android = lines.some((line) => DATE_DASH.test(line));

  for (const line of lines) {
    let m = TIME_FIRST.exec(line);
    let head = null;
    if (m) {
      const [, hh, min, ss, ampm, dd, mm, yy, who, body] = m;
      head = { at: toIso(dd, mm, yy, hh, min, ss, ampm, now), who, body };
    } else if ((m = DATE_BRACKET.exec(line) ?? (android ? DATE_DASH.exec(line) : null))) {
      const [, dd, mm, yy, hh, min, ss, ampm, who, body] = m;
      head = { at: toIso(dd, mm, yy, hh, min, ss, ampm, now), who, body };
    }
    if (head) {
      const sender = head.who.replace(/^~\s*/, '').trim();
      messages.push({ sender, phone: senderPhone(sender), at: head.at, text: head.body });
    } else if (android && NOTICE.test(line.trim())) {
      messages.push(null);   // ends the message above; not one of theirs
    } else if (messages.length && messages[messages.length - 1]) {
      // A line with no header carries on the message above it.
      messages[messages.length - 1].text += `\n${line}`;
    }
  }

  const found = messages.filter(Boolean);
  if (!found.length) {
    const body = cleanText(text);
    return { headed: false, messages: body ? [{ sender: null, phone: null, at: null, text: body }] : [] };
  }
  return {
    headed: true,
    messages: found
      .map((x) => ({ ...x, text: cleanText(x.text) }))
      .filter((x) => x.text && !DELETED.test(x.text) && !SYSTEM.test(x.text)),
  };
}

/** The key two lines of a paste share when they come from the same person. */
export const senderKey = (m) => m.phone ?? String(m.sender ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Split a parsed paste into what the prospect said and what we did.
 * `isUs(message)` says whether a line came from our side. A paste that holds
 * the whole conversation keeps only their messages since our last one, which
 * is what the answer is to; if we had the last word, their last run of
 * messages before it.
 *
 * Returns { senders: [{key, sender, phone}], latest: {key: [messages]} }, one
 * entry per person on their side (normally one; more is a group chat).
 */
export function theirSide(messages, isUs) {
  const ours = messages.map((m) => Boolean(isUs(m)));
  const senders = [];
  const latest = {};
  for (let i = 0; i < messages.length; i += 1) {
    if (ours[i]) continue;
    const key = senderKey(messages[i]);
    if (!latest[key]) {
      latest[key] = [];
      senders.push({ key, sender: messages[i].sender, phone: messages[i].phone });
    }
  }
  const lastOurs = ours.lastIndexOf(true);
  for (const { key } of senders) {
    const mine = (i) => !ours[i] && senderKey(messages[i]) === key;
    let run = messages.map((_, i) => i).filter((i) => i > lastOurs && mine(i));
    if (!run.length) {
      // We answered already: take their last unbroken run of messages.
      const lastTheirs = messages.map((_, i) => i).filter(mine).pop();
      let start = lastTheirs;
      while (start > 0 && !ours[start - 1]) start -= 1;
      run = messages.map((_, i) => i).filter((i) => i >= start && i <= lastTheirs && mine(i));
    }
    latest[key] = run.map((i) => messages[i]);
  }
  return { senders, latest };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * A fingerprint for one message, so pasting the same thing twice (or a longer
 * stretch of the chat that includes it) files nothing twice. A message with
 * no header has no time to tell a repeat from a new "Yes", so each paste of
 * one gets its own; routes/mockups.js decides whether it is a repeat.
 */
export function fingerprint(leadId, m, { now = Date.now() } = {}) {
  return m.at
    ? hash(`${leadId}|${m.at.slice(0, 16)}|${norm(m.text)}`)
    : hash(`${leadId}|undated|${norm(m.text)}|${now}`);
}

/** The words of a message alone, to match it across the two ways of copying. */
export const textKey = (leadId, text) => hash(`${leadId}|text|${norm(text)}`);

/** Words that say nothing about which business it is. */
const FILLER = new Set([
  'ltd', 'limited', 'the', 'and', 'co', 'company', 'uk', 'llp', 'plc', 'services', 'service',
  'group', 'of', 'a', 'mr', 'mrs', 'ms', 'miss',
]);
export const nameWords = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w));

/**
 * How well a saved contact name ("Dave Perfect Paws") fits a business name
 * ("Perfect Paws Burton Ltd"): the share of the business's own words the
 * contact name carries. 0 is no fit.
 */
export function nameFit(contact, business) {
  const have = new Set(nameWords(contact));
  const want = nameWords(business);
  if (!have.size || !want.length) return 0;
  const hits = want.filter((w) => have.has(w)).length;
  return hits / want.length;
}
