/**
 * Draft the message back to a prospect who replied.
 *
 * WhatsApp keeps its chats to itself, so a reply arrives here by copy and
 * paste. What the rep needs next is the answer, ready to copy back: this reads
 * what kind of reply it is and writes that answer in the same voice as the
 * openers (short, friendly, no dashes), signed by the rep who owns the lead.
 *
 *   stop         "stop messaging me"      nothing to send; they are opted out
 *   has_site     "we've got a website"    a gracious close
 *   answers      answered the questions   what we've got, anything missing,
 *                                         and when the mock up will arrive
 *   no           "no thanks"              a polite close, never message again
 *   later        "not right now"          no pressure, the offer stands
 *   price        "how much?"              the mock up is free, and from £X
 *   yes          "yes please"             thanks, and the five questions
 *   other        anything else            a friendly nudge, flagged to check
 *
 * Plain rules, no model: every draft is predictable, and the rep reads it
 * before it goes anywhere. Nothing here touches the database.
 */
import { stripQuoted, numberedAnswers } from './brief.js';
import { fieldOf } from './ask.js';

import {
  tidy, isStop, isElsewhere, hasSite, isNo, leansNo, isLater, isPrice, isYes, accepts, asksWho,
} from './reply-intent.js';

// The drafts below still ask these two questions of a reply's wording.
const PRICE = { test: (t) => isPrice(tidy(t)) };
const YES = { test: (t) => isYes(tidy(t)) };

const CTA_WORDS = {
  call: 'call you', quote: 'ask for a quote', book: 'book in', prices: 'see your prices',
  gallery: 'see your work', enquire: 'get in touch',
};

/** "a, b and c" */
const listOf = (items) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The name the reply is signed with: the lead owner's, as the openers are. */
const signOff = (name) => String(name ?? '').trim();

/**
 * What kind of reply is it? The order matters: "stop" beats everything; a
 * reply that answers the questions ("2. No logo") is not a "no".
 */
export function classifyReply(body, brief = {}, lead = {}) {
  const text = tidy(stripQuoted(body));
  if (isStop(text)) return 'stop';
  // Someone else making it, or a site they already have: said politely or not,
  // these are answered differently from a plain no.
  if (isElsewhere(text) && !accepts(text)) return 'elsewhere';
  if (hasSite(text) && !accepts(text)) return 'has_site';
  if (answered(text, brief, lead).count >= 2) return 'answers';
  if (isNo(text)) return 'no';
  if (isLater(text)) return 'later';
  // "Who is this?", "wrong number": they need an answer, not a pitch.
  if (asksWho(text) && !accepts(text)) return 'other';
  if (isPrice(text)) return 'price';
  if (isYes(text)) return 'yes';
  // "All our work comes through word of mouth" with nothing else said.
  if (leansNo(text)) return 'no';
  return 'other';
}

/** Which of the Ask questions this reply answered, and how many. */
function answered(text, brief, lead, questions = null) {
  const numbered = numberedAnswers(text);
  const town = String(lead.location ?? '').toLowerCase();
  const found = {
    trading_name: Boolean(brief.trading_name),
    primary_cta: Boolean(brief.primary_cta) && !PRICE.test(text),
    areas: (brief.areas ?? []).some((a) => String(a).toLowerCase() !== town),
    assets: brief.has_logo === true || brief.has_photos === true
      || /\b(logo|photos?|pictures|pics)\b/i.test(text),
    brand_colours: (brief.brand_colours ?? []).length > 0,
    services: false,
  };
  // A numbered answer to a question counts as answering it, whatever it said.
  (questions ?? []).forEach((row, i) => {
    const f = fieldOf(row.q);
    if (f && numbered.has(i + 1)) found[f] = true;
  });
  const count = numbered.size >= 2 ? Math.max(numbered.size, 2)
    : Object.values(found).filter(Boolean).length;
  return { found, count };
}

/**
 * The drafted answer.
 *
 *   body        what they sent
 *   brief       what was read out of it (brief.js)
 *   lead        the lead row
 *   sender      the name to sign with (the lead's owner)
 *   ask         { intro, questions, outro } from the Ask screen
 *   prices      { from, monthly } in pounds, from the Prices screen
 *   mockupUrl   a built mock up's full link, if there is one
 *
 * Returns { intent, label, text, note, actions }. `text` is empty only when
 * nothing should be sent at all (they asked to stop).
 */
export function draftReply({
  body, brief = {}, lead = {}, sender = '', ask, prices = {}, mockupUrl = null, kind = null,
}) {
  const business = lead.business_name ?? 'your business';
  const name = signOff(sender);
  const sign = (t) => (name ? `${t}\n\n${name}` : t);
  const intent = kind === 'mockup' ? 'mockup' : classifyReply(body, brief, lead);
  const questions = ask?.questions ?? [];
  const questionBlock = () => [
    ask?.intro ?? '',
    '',
    ...questions.map((row, i) => `${i + 1}. ${row.q}`),
    ...(ask?.outro ? ['', ask.outro] : []),
  ].join('\n').trim();

  switch (intent) {
    case 'mockup':
      return {
        intent,
        label: 'Send them the mock up',
        text: sign(`Here's the mock up for ${business}: ${mockupUrl ?? '(build it first)'}\n\n`
          + 'Have a look and let me know what you think. Happy to change anything you\'d like.'),
        note: mockupUrl ? null : 'Build the mock up first, then draft this again for the link.',
        actions: [],
      };

    case 'stop':
      return {
        intent,
        label: 'They asked not to be contacted',
        text: '',
        note: 'They have been marked as opted out, so they won\'t be offered to anyone again. '
          + 'Best not to reply at all.',
        actions: [],
      };

    case 'has_site':
      return {
        intent,
        label: 'They already have a website',
        text: sign('Ah, fair enough! Sorry, I must have missed it. If you ever fancy a refresh '
          + 'or want anything added, just give me a shout.'),
        note: null,
        actions: [{ id: 'has-site', label: 'Mark: they have a website' }],
      };

    case 'no':
      return {
        intent,
        label: 'Not interested',
        text: sign(`No problem at all, thanks for letting me know. All the best with ${business}.`),
        note: null,
        actions: [{ id: 'optout', label: 'Mark not interested (never contact again)' }],
      };

    case 'elsewhere':
      return {
        intent,
        label: 'Using someone else',
        text: sign(`That's great to hear, it sounds like you're in good hands. Thanks for letting `
          + `me know, and if anything changes, or you'd ever like a second opinion, just give me `
          + `a shout. All the best with ${business}.`),
        note: null,
        actions: [{ id: 'optout', label: 'Mark lost (they’re using someone else)' }],
      };

    case 'later':
      return {
        intent,
        label: 'Maybe later',
        text: sign('No rush at all. I\'ll leave it with you, and if you\'d like the free mock up '
          + 'any time, just drop me a message.'),
        note: null,
        actions: [],
      };

    case 'price': {
      const saidYes = YES.test(stripQuoted(body));
      const from = prices.from ? `starts from £${prices.from}` : 'is very reasonably priced';
      const monthly = prices.monthly ? `, with hosting from £${prices.monthly} a month to keep it live` : '';
      const lines = [
        `Good question! The mock up is completely free, with no obligation. If you like it, a site like that ${from}${monthly}.`,
      ];
      if (saidYes && questions.length) lines.push('', questionBlock());
      else lines.push('', 'Want me to put the mock up together so you can see it first?');
      return { intent, label: 'Asked about price', text: sign(lines.join('\n')), note: null, actions: [] };
    }

    case 'answers': {
      const text = stripQuoted(body);
      const { found } = answered(text, brief, lead, questions);
      const got = [];
      if (brief.trading_name) got.push(`• Name on the site: ${brief.trading_name}`);
      if (brief.primary_cta && found.primary_cta) {
        got.push(`• Main thing visitors do: ${CTA_WORDS[brief.primary_cta] ?? brief.primary_cta}`);
      }
      const areas = (brief.areas ?? []).filter(Boolean);
      if (found.areas && areas.length) got.push(`• Areas: ${listOf(areas)}`);
      if (found.assets) {
        got.push(brief.has_logo ? '• Logo: great, send it over when you can'
          : '• Logo: no worries, I\'ll put a simple one together');
        got.push(brief.has_photos ? '• Photos: brilliant, send a few of your best over'
          : '• Photos: I\'ll use some good stock ones for now');
      }
      if ((brief.brand_colours ?? []).length) got.push(`• Colours: ${listOf(brief.brand_colours)}`);

      const missing = questions.filter((row) => {
        const f = fieldOf(row.q);
        return f && !found[f];
      }).map((row) => row.q);

      const lines = ['Thanks, that\'s perfect. Here\'s what I\'ve got:', '', ...got];
      if (missing.length === 1) lines.push('', `Just one more thing: ${missing[0]}`);
      else if (missing.length > 1) {
        lines.push('', 'Just a couple more things:', ...missing.map((q, i) => `${i + 1}. ${q}`));
      }
      lines.push('', 'I\'ll get the mock up over to you in the next day or two.');
      return {
        intent,
        label: 'They answered the questions',
        text: sign(lines.join('\n')),
        note: got.length ? null : 'Couldn\'t read their answers clearly: check the brief on Replies.',
        actions: [{ id: 'build', label: 'Build the mock up' }],
      };
    }

    case 'yes':
      return {
        intent,
        label: 'Said yes to a mock up',
        text: sign(`Brilliant, thanks for getting back to me!\n\n${questionBlock()}`),
        note: null,
        actions: [],
      };

    default:
      return {
        intent: 'other',
        label: 'Not sure what they\'re after',
        text: sign(`Thanks for getting back to me! Happy to answer anything. Would you like me to put `
          + `the free mock up together for ${business} so you can see how it could look?`),
        note: 'Read their message and edit this before sending: it couldn\'t tell what they meant.',
        actions: [],
      };
  }
}
