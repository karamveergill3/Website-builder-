/**
 * The messages the tool ships with.
 *
 * A first approach is the one piece of writing that decides whether any of
 * the rest of this matters, and staring at an empty box is how a tool with a
 * hundred leads in it goes unused. So the wording is here, ready, and every
 * one of these is meant to be edited into the owner's own voice: they are a
 * starting point, not a house style.
 *
 * They are written to read like a real person sent them, not a template:
 *
 *   They introduce a person, confidently.  Each opens "Hi, I'm {{my_name}}
 *     from {{my_business}}" and names the business straight away, because we
 *     already know who they are (we found them) so there is no need to ask.
 *     PECR reg 23 also says a marketing message must not conceal who sent it.
 *
 *   They name the business and offer the mock-up.  {{business}} and
 *     {{location}} come off the lead row, so the message is always about the
 *     company in front of you, and the free mock-up is the one thing this tool
 *     does that a cold email doesn't.
 *
 *   They name the sender and leave the door open.  A WhatsApp or a text ends
 *     on "No pressure at all." and nothing more: Keylo's call, because "just
 *     say and I won't message again" read as a form letter, and Keylo wants
 *     it nowhere. The way out is still there, because both are answered on
 *     the number they came from, and a "no" or "stop" pasted into the tool
 *     opts them out on the spot (lib/reply-draft.js). An EMAIL carries none in
 *     the body at all: lib/compliance.js appends the identity block and
 *     opt-out to every one.
 *
 * No dashes: they read as machine-written. The sender tokens come from
 * Settings, so nothing personal lives in this file and one edit fixes every
 * template.
 */

/**
 * The sales line the WhatsApp openers carried until Keylo took it out: a
 * figure nobody could back up reads as spam and costs trust on a first
 * message.
 */
const SALES_LINE = /[ \t]*Having a website is proven to boost sales by 40%\.?[ \t]*(\n)?/;

/**
 * An opener with the sales line taken out. Only that sentence goes: on a
 * paragraph of its own the paragraph goes with it, and in a paragraph someone
 * wrote around it the rest of their words stay.
 */
export function withoutSalesLine(body) {
  const text = String(body ?? '');
  if (!SALES_LINE.test(text)) return text;
  return text.split('\n\n').flatMap((para) => {
    if (!SALES_LINE.test(para)) return [para];
    const rest = para.replace(SALES_LINE, (m, newline, at, str) => {
      const before = str[at - 1];
      if (before === undefined || before === '\n') return '';   // it started the line
      if (newline) return '\n';                                 // it ended the line
      return str[at + m.length] === undefined ? '' : ' ';        // mid-sentence
    }).replace(/\n+$/, '');
    return rest.trim() ? [rest] : [];
  }).join('\n\n');
}

/** The long close the WhatsApp openers used to end on. */
const OLD_CLOSE = /No pressure at all, and if it(?:'|\u2019)s not for you, just say and I won(?:'|\u2019)t message again\./;

/**
 * End an opener on "No pressure at all." as the shipped ones now do. Only
 * that sentence changes, so wording edited on the Templates screen stays.
 */
export function withShortClose(body) {
  return String(body ?? '').replace(OLD_CLOSE, 'No pressure at all.');
}


/**
 * The paragraphs the WhatsApp openers used to carry, and what replaces each.
 * "We build simple…" undersold the work; every opener now reads like the
 * Trades one: what customers want, then "That's exactly what we build".
 */
const OPENER_SWAPS = new Map([
  [
    "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} while looking around {{location}} and noticed you don't have a website yet, so I thought I'd reach out and say hello.",
    "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch."
  ],
  [
    "We build simple, great looking one page websites for local businesses. Just a clear page with what you do, a few photos, and a button so people can call or message you straight from their phone.",
    "Most people look a business up online before they get in touch, and that's where a good website wins you the job. That's exactly what we build: a clean, professional site showing what you do, photos of your work, and a button so new customers can call or message you straight from their phone."
  ],
  [
    "I'd be really happy to put together a free mock up for {{business}} so you can see exactly how it could look, with no cost and no obligation at all.",
    "I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation."
  ],
  [
    "Would that be something you'd like me to do for you? No pressure at all.",
    "Would you like me to do that for you? No pressure at all."
  ],
  [
    "We build simple, beautiful one page websites: your treatments, lovely photos of your work, and a button so someone can call or book you straight from their phone. They're really easy to keep updated too.",
    "New clients want to see your work, your treatments and your prices, and book without having to ring. That's exactly what we build: a beautiful site with your treatments, lovely photos of your work, and a button so they can book or call you straight from their phone."
  ],
  [
    "For a place like yours, a website is usually where people check the menu, your opening hours and how to order, so it can make a real difference. We build simple, tasty looking one page sites with your menu, a few photos and a tap to call button.",
    "For a place like yours, people want to check the menu, your opening hours and how to order before they come in. That's exactly what we build: a site with your menu, great photos of your food, and a button to call or order straight from their phone."
  ],
  [
    "For a garage, a website is where people check what you do and book their car in. We build simple, straightforward one page sites with your services, your opening hours and a tap to call button, so customers can find you and get booked in easily.",
    "For a garage, people want to see what you do, check your hours and book their car in. That's exactly what we build: a clear site with your services, your opening hours and a call button, so new customers can find you and get booked in easily."
  ],
  [
    "For somewhere like yours, a website is usually the first place people look before they commit to booking. We build simple, welcoming one page sites with what you offer, your prices or timetable, and a tap to book or call button.",
    "For somewhere like yours, people want to see what you offer and your prices or timetable before they commit. That's exactly what we build: a welcoming site with your classes or treatments, your prices, and a button to book or call straight from their phone."
  ],
  [
    "For a shop, a website is where people check what you stock, where you are and when you're open. We build simple, welcoming one page sites with photos, your location and a tap to call button, so new customers can find you easily.",
    "For a shop, people want to see what you stock, where you are and when you're open. That's exactly what we build: a site with photos of what you sell, your opening hours and where to find you, so new customers come straight to your door."
  ]
]);

/**
 * Bring a saved opener up to date one paragraph at a time. A paragraph is
 * only swapped if it is still exactly as shipped, so anything edited on the
 * Templates screen is left alone.
 */
export function withNewWording(body) {
  return String(body ?? '').split('\n\n').map((p) => OPENER_SWAPS.get(p) ?? p).join('\n\n');
}


/**
 * The sector openers there used to be, exactly as last shipped. There is one
 * WhatsApp opener now, written per business through {{trade_pitch}}; a saved
 * copy still exactly like this was never edited and can go (migration 058).
 */
export const RETIRED_OPENERS = {
  "First message — WhatsApp · Salons & beauty": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet. For a salon that's so often the first place a new client looks before they book, so I wanted to reach out.\n\nNew clients want to see your work, your treatments and your prices, and book without having to ring. That's exactly what we build: a beautiful site with your treatments, lovely photos of your work, and a button so they can book or call you straight from their phone.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nThanks so much, and have a lovely day.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Trades": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.\n\nFor a trade, most people just want to see a few jobs you've done and be able to tap to call. That's exactly what we build: a clean one page site with photos of your work, the areas you cover, and a call button, so new customers can find you and get straight through.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nCheers, and all the best with the work.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Food & drink": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I wanted to say hello.\n\nFor a place like yours, people want to check the menu, your opening hours and how to order before they come in. That's exactly what we build: a site with your menu, great photos of your food, and a button to call or order straight from their phone.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nThanks so much, and hope you're keeping busy.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Motor": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd reach out.\n\nFor a garage, people want to see what you do, check your hours and book their car in. That's exactly what we build: a clear site with your services, your opening hours and a call button, so new customers can find you and get booked in easily.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nCheers, and all the best.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Health & fitness": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I wanted to introduce myself.\n\nFor somewhere like yours, people want to see what you offer and your prices or timetable before they commit. That's exactly what we build: a welcoming site with your classes or treatments, your prices, and a button to book or call straight from their phone.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nThanks so much, and have a great day.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Shops": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd say hello.\n\nFor a shop, people want to see what you stock, where you are and when you're open. That's exactly what we build: a site with photos of what you sell, your opening hours and where to find you, so new customers come straight to your door.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nThanks so much, and have a lovely day.\n{{my_name}}, {{my_business}}",
  "First message — WhatsApp · Pets & animals": "Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.\n\nPet owners want to see the pets you've looked after, your prices and how to book before they trust you with theirs. That's exactly what we build: a friendly site with photos of your happy customers, your services and prices, and a button to book or call straight from their phone.\n\nHaving a website is proven to boost sales by 40%.\n\nI'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.\n\nWould you like me to do that for you? No pressure at all.\n\nThanks so much, and have a great day.\n{{my_name}}, {{my_business}}"
};

const SHIPPED_PITCHES = new Set([
  "For a garage, people want to see what you do, check your hours and book their car in. That's exactly what we build: a clear site with your services, your opening hours and a call button, so new customers can find you and get booked in easily.",
  "For a place like yours, people want to check the menu, your opening hours and how to order before they come in. That's exactly what we build: a site with your menu, great photos of your food, and a button to call or order straight from their phone.",
  "For a shop, people want to see what you stock, where you are and when you're open. That's exactly what we build: a site with photos of what you sell, your opening hours and where to find you, so new customers come straight to your door.",
  "For a trade, most people just want to see a few jobs you've done and be able to tap to call. That's exactly what we build: a clean one page site with photos of your work, the areas you cover, and a call button, so new customers can find you and get straight through.",
  "For somewhere like yours, people want to see what you offer and your prices or timetable before they commit. That's exactly what we build: a welcoming site with your classes or treatments, your prices, and a button to book or call straight from their phone.",
  "Most people look a business up online before they get in touch, and that's where a good website wins you the job. That's exactly what we build: a clean, professional site showing what you do, photos of your work, and a button so new customers can call or message you straight from their phone.",
  "New clients want to see your work, your treatments and your prices, and book without having to ring. That's exactly what we build: a beautiful site with your treatments, lovely photos of your work, and a button so they can book or call you straight from their phone.",
  "Pet owners want to see the pets you've looked after, your prices and how to book before they trust you with theirs. That's exactly what we build: a friendly site with photos of your happy customers, your services and prices, and a button to book or call straight from their phone."
]);
const SHIPPED_CLOSES = new Set([
  "Cheers, and all the best with the work.\n{{my_name}}, {{my_business}}",
  "Cheers, and all the best.\n{{my_name}}, {{my_business}}",
  "Thanks so much, and have a great day.\n{{my_name}}, {{my_business}}",
  "Thanks so much, and have a lovely day.\n{{my_name}}, {{my_business}}",
  "Thanks so much, and hope you're keeping busy.\n{{my_name}}, {{my_business}}"
]);

/**
 * Put the per-business pitch and sign-off into a saved opener: a paragraph
 * still exactly as shipped becomes {{trade_pitch}} or {{trade_close}}, and
 * anything edited on the Templates screen is left alone.
 */
export function withTradePitch(body) {
  return String(body ?? '').split('\n\n').map((para) => {
    if (SHIPPED_PITCHES.has(para)) return '{{trade_pitch}}';
    if (SHIPPED_CLOSES.has(para)) return '{{trade_close}}\n{{my_name}}, {{my_business}}';
    return para;
  }).join('\n\n');
}

/** The first text. */
const SMS_BODY = `Hi, I'm {{my_name}} from {{my_business}}. I came across {{business}} and noticed you don't have a website yet, and I'd be happy to build you a free one page mock up to look at, with no obligation. Would you like me to put one together? No pressure at all.`;

/** The first text as shipped until Keylo dropped "I won't message again" everywhere. */
const OLD_SMS_BODY = `Hi, I'm {{my_name}} from {{my_business}}. I came across {{business}} and noticed you don't have a website yet, and I'd be happy to build you a free one page mock up to look at, with no obligation. Would you like me to put one together? If it's not for you, just say and I won't message again.`;

/**
 * A message with every "I won't message again" taken out: Keylo's call, for
 * every channel. The shipped wordings go cleanly ("No pressure at all, and if
 * it's not for you, just say and I won't message again." becomes "No
 * pressure at all."); any other sentence saying it is dropped whole.
 */
export function withoutNoMessageAgain(body) {
  const text = String(body ?? '');
  if (text === OLD_SMS_BODY) return SMS_BODY;
  const q = "['’]";
  const out = text
    .replace(new RegExp(String.raw`\s*\(If now isn${q}t the right time or it${q}s not for you, no worries at all, just let me know and I won${q}t message again\.\)`, 'g'), '')
    .replace(new RegExp(String.raw`,? and if it${q}s not for you, just (say|let me know) and I won${q}t message again\.`, 'g'), '.')
    .replace(new RegExp(String.raw`[ \t]*If it${q}s not for you, just (say|let me know) and I won${q}t message again\.`, 'g'), '')
    .replace(new RegExp(String.raw`[ \t]*Reply STOP and I won${q}t text again\.`, 'g'), '')
    // Anything else that says it, as a whole sentence.
    .replace(new RegExp(String.raw`[ \t]*[^.!?\n]*\bwon${q}?t (message|text|contact|email|bother) (you )?again\b[^.!?\n]*[.!?]?\)?`, 'gi'), '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return out === text.trim() ? text : out;
}

export const STARTERS = [
  {
    name: 'First message — email',
    channel: 'email',
    subject: 'A website for {{business}}',
    body: `Hi,

I'm {{my_name}} from {{my_business}}. Came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd reach out.

{{about_line}}

Two quick reasons it matters:
• {{boost_search_share}} of people Google a local trade before ringing anyone.
• A proper site typically brings {{boost_enquiries_range}} more customers within six months.

We build websites for local businesses. A clean one-pager, a full multi-page site, booking systems, galleries, online payments, whatever your customers need.

Happy to put a free mock-up together for {{business}} so you can see it for yourself. No cost, no obligation.

Kind regards,
{{my_name}}`,
  },

  {
    name: 'Follow-up — email',
    channel: 'email',
    subject: 'Following up on {{business}}',
    body: `Hi,

{{my_name}} again from {{my_business}}, following up on the free website mock-up for {{business}} in case last week's note landed at a busy time.

Quick reminder:
• {{boost_search_share}} Google a local trade before ringing.
• A proper site adds {{boost_enquiries_range}} more customers within six months.

Offer still stands. I'll put it together, send it over, and if it is not for you, no worries.

Kind regards,
{{my_name}}`,
  },

  {
    name: 'First message — WhatsApp',
    channel: 'whatsapp',
    subject: '',
    // The middle and the sign-off are written for the lead's own kind of
    // business (lib/pitches.js), so a roofer, a dog groomer and a café each
    // get their own opener from this one template.
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.

{{trade_pitch}}

I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

{{trade_close}}
{{my_name}}, {{my_business}}`,
  },

  {
    name: 'First message — SMS',
    channel: 'sms',
    subject: '',
    // Says who sent it, from a number they can simply reply to. Warm, not
    // robotic: no "reply STOP". Phones stitch multi-part texts back into one.
    body: SMS_BODY,
  },
];

/** The starters not already present, matched on name. */
export function missingStarters(existingNames = []) {
  const have = new Set(existingNames.map((n) => String(n).trim().toLowerCase()));
  return STARTERS.filter((s) => !have.has(s.name.toLowerCase()));
}
