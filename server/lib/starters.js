/**
 * The messages the tool ships with.
 *
 * A first approach is the one piece of writing that decides whether any of
 * the rest of this matters, and staring at an empty box is how a tool with a
 * hundred leads in it goes unused. So the wording is here, ready, and every
 * one of these is meant to be edited into the owner's own voice — they are a
 * starting point, not a house style.
 *
 * Three things they all do, and none of them are decoration:
 *
 *   They name the business.  A message that opens "Hi there" is a circular
 *     and reads as one. {{business}} and {{location}} come off the lead row,
 *     so the message on screen is always about the company in front of you.
 *
 *   They name the sender.  PECR reg 23 says a marketing message must not
 *     conceal who sent it and must give a way to opt out. An email gets that
 *     appended automatically (lib/compliance.js); a WhatsApp or SMS is a deep
 *     link the user taps and nothing can be appended to it afterwards, so the
 *     WhatsApp and SMS bodies carry the identification and the opt-out line
 *     themselves. Removing those lines from a cold message is not a style
 *     choice.
 *
 *   They offer the mock-up.  It is the only thing this tool does that a
 *     competitor's cold email does not, and it is free to give away.
 *
 * The sender tokens read from Settings rather than being typed in, so nothing
 * personal lives in this file and one edit in Settings fixes every template.
 */

export const STARTERS = [
  {
    name: 'First message — email',
    channel: 'email',
    subject: 'A website for {{business}}?',
    body: `Hi,

I was looking for {{category}} around {{location}} and came across {{business}} — but I couldn't find a website for you anywhere.

I build simple one-page sites for local trades: what you do, the areas you cover, a few photos, and a button that dials you straight from a phone. Nothing complicated, and nothing you have to maintain.

If it's any use I'll put together a mock-up of yours first, free and with no obligation, so you can look at a real page rather than take my word for it.

Worth a look?

{{my_name}}
{{my_phone}}`,
  },

  {
    name: 'Follow-up — email',
    channel: 'email',
    subject: 'Following up — {{business}}',
    body: `Hi,

I wrote last week about a website for {{business}}. Just a short nudge in case it landed at a busy moment.

The offer of a free mock-up stands — I'll build the page, you look at it, and if it's not for you that is the end of it.

And if you'd rather I didn't write again, reply and say so and I won't.

{{my_name}}
{{my_phone}}`,
  },

  {
    name: 'First message — WhatsApp',
    channel: 'whatsapp',
    subject: '',
    body: `Hi, is this {{business}}?

I'm {{my_name}} from {{my_business}}. I was looking for {{category}} around {{location}} and couldn't find a website for you, so I thought I'd ask whether one would be any use.

I make simple one-page sites for local trades — what you do, your areas, a few photos and a tap-to-call button. I'm happy to mock yours up for free so you can see it before deciding anything.

If you'd rather I didn't message again, just say and I won't.`,
  },

  {
    name: 'First message — SMS',
    channel: 'sms',
    subject: '',
    // Over one 160-character segment once the business name is filled in, and
    // that is the right trade: a text that does not say who sent it or how to
    // stop it is not one that may lawfully be sent. Phones stitch the parts
    // back together; the recipient sees one message.
    body: `Hi, is this {{business}}? {{my_name}} here from {{my_business}} — I couldn't find a website for you. I build one-page sites for {{category}} around {{location}} and I'll mock yours up free so you can see it. Reply STOP and I won't text again.`,
  },
];

/** The starters not already present, matched on name. */
export function missingStarters(existingNames = []) {
  const have = new Set(existingNames.map((n) => String(n).trim().toLowerCase()));
  return STARTERS.filter((s) => !have.has(s.name.toLowerCase()));
}
