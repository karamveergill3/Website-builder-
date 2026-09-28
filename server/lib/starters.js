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
 *   They name the sender and leave the door open.  A WhatsApp ends on "No
 *     pressure at all." and nothing more: Keylo's call, because the longer
 *     "just say and I won't message again" read as a form letter. The way out
 *     is still there, because a WhatsApp is answered on the number it came
 *     from, and a "no" or "stop" pasted into the tool opts them out on the
 *     spot (lib/reply-draft.js). An SMS keeps its explicit line: a text is
 *     easy to take as automated. An EMAIL carries none in the body at all:
 *     lib/compliance.js appends the identity block and opt-out to every one.
 *
 * No dashes: they read as machine-written. The sender tokens come from
 * Settings, so nothing personal lives in this file and one edit fixes every
 * template.
 */

/** The stat every WhatsApp opener carries, between what we build and the mock-up offer. */
export const SALES_LINE = 'Having a website is proven to boost sales by 40%.';

/**
 * Put SALES_LINE into an opener just before its free mock-up offer, once.
 * Leaves the rest of the wording alone, so an opener someone edited on the
 * Templates screen keeps their edits; one with no mock-up offer to anchor on
 * is returned unchanged rather than guessed at.
 */
export function withSalesLine(body) {
  const text = String(body ?? '');
  if (/boost sales/i.test(text)) return text;
  const at = text.search(/\n\n[^\n]*free mock ?-?up/i);
  if (at < 0) return text;
  return `${text.slice(0, at)}\n\n${SALES_LINE}${text.slice(at)}`;
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
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.

Most people look a business up online before they get in touch, and that's where a good website wins you the job. That's exactly what we build: a clean, professional site showing what you do, photos of your work, and a button so new customers can call or message you straight from their phone.

${SALES_LINE}

I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and have a great day.
{{my_name}}, {{my_business}}`,
  },

  // Salon & beauty: the framing that lands is "this is where new clients look".
  {
    name: 'First message — WhatsApp · Salons & beauty',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet. For a salon that's so often the first place a new client looks before they book, so I wanted to reach out.

New clients want to see your work, your treatments and your prices, and book without having to ring. That's exactly what we build: a beautiful site with your treatments, lovely photos of your work, and a button so they can book or call you straight from their phone.

${SALES_LINE}

I'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and have a lovely day.
{{my_name}}, {{my_business}}`,
  },

  // Trades: they want to be seen doing the work and reached in one tap.
  {
    name: 'First message — WhatsApp · Trades',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.

For a trade, most people just want to see a few jobs you've done and be able to tap to call. That's exactly what we build: a clean one page site with photos of your work, the areas you cover, and a call button, so new customers can find you and get straight through.

${SALES_LINE}

I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Cheers, and all the best with the work.
{{my_name}}, {{my_business}}`,
  },

  // Food & drink: menu, hours and how to order are what people look for.
  {
    name: 'First message — WhatsApp · Food & drink',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I wanted to say hello.

For a place like yours, people want to check the menu, your opening hours and how to order before they come in. That's exactly what we build: a site with your menu, great photos of your food, and a button to call or order straight from their phone.

${SALES_LINE}

I'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and hope you're keeping busy.
{{my_name}}, {{my_business}}`,
  },

  // Motor: what you do and booking in, with a call button.
  {
    name: 'First message — WhatsApp · Motor',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd reach out.

For a garage, people want to see what you do, check your hours and book their car in. That's exactly what we build: a clear site with your services, your opening hours and a call button, so new customers can find you and get booked in easily.

${SALES_LINE}

I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Cheers, and all the best.
{{my_name}}, {{my_business}}`,
  },

  // Health & fitness: what's on offer and booking, before someone commits.
  {
    name: 'First message — WhatsApp · Health & fitness',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I wanted to introduce myself.

For somewhere like yours, people want to see what you offer and your prices or timetable before they commit. That's exactly what we build: a welcoming site with your classes or treatments, your prices, and a button to book or call straight from their phone.

${SALES_LINE}

I'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and have a great day.
{{my_name}}, {{my_business}}`,
  },

  // Shops: what you stock, where you are, when you're open.
  {
    name: 'First message — WhatsApp · Shops',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd say hello.

For a shop, people want to see what you stock, where you are and when you're open. That's exactly what we build: a site with photos of what you sell, your opening hours and where to find you, so new customers come straight to your door.

${SALES_LINE}

I'd love to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and have a lovely day.
{{my_name}}, {{my_business}}`,
  },

  // Pets: owners want to see who they're trusting with their pet, and book.
  {
    name: 'First message — WhatsApp · Pets & animals',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, my name is {{my_name}} and I'm from {{my_business}}. I came across {{business}} in {{location}} and noticed you don't have a website yet, so I thought I'd get in touch.

Pet owners want to see the pets you've looked after, your prices and how to book before they trust you with theirs. That's exactly what we build: a friendly site with photos of your happy customers, your services and prices, and a button to book or call straight from their phone.

${SALES_LINE}

I'd be happy to put together a free mock up for {{business}} so you can see how it could look, with no cost and no obligation.

Would you like me to do that for you? No pressure at all.

Thanks so much, and have a great day.
{{my_name}}, {{my_business}}`,
  },

  {
    name: 'First message — SMS',
    channel: 'sms',
    subject: '',
    // A text that doesn't say who sent it or how to stop it is not one that
    // may lawfully be sent, so both live in the body. Warm, not robotic: no
    // "reply STOP". Phones stitch multi-part texts back into one message.
    body: `Hi, I'm {{my_name}} from {{my_business}}. I came across {{business}} and noticed you don't have a website yet, and I'd be happy to build you a free one page mock up to look at, with no obligation. Would you like me to put one together? If it's not for you, just say and I won't message again.`,
  },
];

/** The starters not already present, matched on name. */
export function missingStarters(existingNames = []) {
  const have = new Set(existingNames.map((n) => String(n).trim().toLowerCase()));
  return STARTERS.filter((s) => !have.has(s.name.toLowerCase()));
}
