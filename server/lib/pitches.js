/**
 * What each kind of business hears in its first WhatsApp.
 *
 * Two sentences, in the shape of the Trades opener Keylo signed off: what
 * THAT business's customers want to see before they choose, then "That's
 * exactly what we build:" and the three things its site would carry. And a
 * closing line to suit. lib/pitch-match.js picks the one for a lead.
 *
 * Rules every pitch keeps (test/pitches.test.js holds them to it): two
 * sentences, no "simple", no "one page", no dashes, UK English, plain and
 * warm. Edit freely; the test will say if a line breaks one.
 */

/** Kinds of business, each owning the search terms (lib/sic.js) it covers. */
export const PITCHES = [];

/** A business matched to a broad sector (lib/sectors.js) but no pitch of its own. */
export const SECTOR_PITCHES = {
  "salon": {
    "business": "salon",
    "pitch": "New clients want to see your work, your treatments and your prices, and book without having to ring. That's exactly what we build: a beautiful site with your treatments, lovely photos of your work, and a button so they can book or call you straight from their phone.",
    "close": "Thanks so much, and have a lovely day."
  },
  "trades": {
    "business": "trade",
    "pitch": "For a trade, most people just want to see a few jobs you've done and be able to tap to call. That's exactly what we build: a clean one page site with photos of your work, the areas you cover, and a call button, so new customers can find you and get straight through.",
    "close": "Cheers, and all the best with the work."
  },
  "food": {
    "business": "food business",
    "pitch": "For a place like yours, people want to check the menu, your opening hours and how to order before they come in. That's exactly what we build: a site with your menu, great photos of your food, and a button to call or order straight from their phone.",
    "close": "Thanks so much, and hope you're keeping busy."
  },
  "motor": {
    "business": "garage",
    "pitch": "For a garage, people want to see what you do, check your hours and book their car in. That's exactly what we build: a clear site with your services, your opening hours and a call button, so new customers can find you and get booked in easily.",
    "close": "Cheers, and all the best."
  },
  "fitness": {
    "business": "health or fitness business",
    "pitch": "For somewhere like yours, people want to see what you offer and your prices or timetable before they commit. That's exactly what we build: a welcoming site with your classes or treatments, your prices, and a button to book or call straight from their phone.",
    "close": "Thanks so much, and have a great day."
  },
  "shop": {
    "business": "shop",
    "pitch": "For a shop, people want to see what you stock, where you are and when you're open. That's exactly what we build: a site with photos of what you sell, your opening hours and where to find you, so new customers come straight to your door.",
    "close": "Thanks so much, and have a lovely day."
  },
  "pets": {
    "business": "pet business",
    "pitch": "Pet owners want to see the pets you've looked after, your prices and how to book before they trust you with theirs. That's exactly what we build: a friendly site with photos of your happy customers, your services and prices, and a button to book or call straight from their phone.",
    "close": "Thanks so much, and have a great day."
  }
};

/** Any business at all. */
export const GENERAL_PITCH = {
  "business": "local business",
  "pitch": "Most people look a business up online before they get in touch, and that's where a good website wins you the job. That's exactly what we build: a clean, professional site showing what you do, photos of your work, and a button so new customers can call or message you straight from their phone.",
  "close": "Thanks so much, and have a great day."
};
