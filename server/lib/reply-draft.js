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

// Acted on automatically (they are opted out), so only an unmistakable ask:
// "Stop" as the whole message, or "stop messaging", never "stop by any time".
const STOP = /(^\s*stop\s*(please|pls|now|thanks|thank you)?\s*[.!]*\s*$|\bplease stop\b|\bstop (messaging|texting|contacting|sending|it)\b|\bunsubscribe\b|\bremove (me|us|my (number|details))\b|\b(do not|don'?t|dont) (message|text|contact|msg|whatsapp) (me|us)\b|\bleave (me|us) alone\b|\btake (me|us) off\b)/i;
const NOT_A_SITE = /\b(don'?t|dont|do not|haven'?t|havent|have not|no|never had)\b[^.!?\n]{0,20}\b(web ?site|site)\b/i;
const HAS_SITE = /\b(already (have|got) (one|a (web ?)?site)|(we'?ve|we have|i'?ve|i have|we've got|i've got|we got|i got|already got) (got )?(a|our own|one|our) ?(web ?)?site|we (already )?have one|our (web ?)?site (is|at))\b/i;
const NO = /\b(not interested|no thanks|no thank you|no ta|not for (us|me)|we'?re (ok|okay|fine|good|sorted|all good)|i'?m (ok|okay|fine|good|sorted)|all good thanks|no need|not needed|not required|(don'?t|dont|do not) need (one|it|a (web ?)?site))\b/i;
const BARE_NO = /^\s*(no|nope|nah|no ta|no thanks)[\s.!]*$/i;
const LATER = /\b(not (right )?now|maybe later|later on|(too|very|really) busy|busy at the moment|next (week|month|year)|new year|get back to you|think about it|have a think|in a few (weeks|months)|not at the moment)\b/i;
const PRICE = /(\bhow much\b|\bprices?\b|\bpricing\b|\bcosts?\b|\bcharges?\b|\bfees?\b|£|\bwhat'?s the catch\b|\bexpensive\b)/i;
const YES = /(\b(yes|yeah|yea|yep|yup|sure|ok|okay|go on|go ahead|go for it|sounds (good|great)|please do|why not|interested|send (it|me one|one|it over)|love (to|one|that)|that would be (great|good|lovely|brilliant)|happy to|definitely|of course|alright|aye|let'?s do it|crack on)\b|👍)/i;

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
  const text = stripQuoted(body).replace(/[’`]/g, "'");
  if (STOP.test(text)) return 'stop';
  if (HAS_SITE.test(text) && !NOT_A_SITE.test(text)) return 'has_site';
  if (answered(text, brief, lead).count >= 2) return 'answers';
  if (NO.test(text) || BARE_NO.test(text)) return 'no';
  if (LATER.test(text)) return 'later';
  if (PRICE.test(text)) return 'price';
  if (YES.test(text)) return 'yes';
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
        text: sign(`No problem at all, thanks for letting me know. I won't message again. `
          + `All the best with ${business}.`),
        note: null,
        actions: [{ id: 'optout', label: 'Mark not interested (never contact again)' }],
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
