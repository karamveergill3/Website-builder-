/**
 * Turn a prospect's reply into a brief the site generator can build from.
 *
 * Two passes, in this order:
 *
 *   1. RULES. The follow-up template asks three numbered questions, so most
 *      replies come back as "1. … 2. … 3. …" and can be split deterministically.
 *      Keyword matching then pins down the one field that decides the whole
 *      layout — what the visitor should be able to DO — because that answer
 *      space is small and closed.
 *
 *   2. LOCAL MODEL. Whatever the rules could not fill is asked of Ollama,
 *      running on this machine. If Ollama is absent the brief simply carries
 *      the gaps and the UI asks the user to fill them — the tool never blocks
 *      on a model being installed.
 *
 * The rules pass always runs and always wins where it is confident: a
 * deterministic answer beats a generated one, and it costs nothing.
 */

import { available, extractJson, asList, asText, asBool, asOneOf } from './ollama.js';
import { resolveTrade } from './sic.js';

/**
 * What the visitor should be able to do first. This single field decides the
 * hero, the header, and what the whole site is arranged around, so it is
 * worth pinning precisely.
 */
export const CTAS = ['call', 'quote', 'book', 'prices', 'gallery', 'enquire'];

export const CTA_LABEL = {
  call:    'Call now',
  quote:   'Get a quote',
  book:    'Book a visit',
  prices:  'See prices',
  gallery: 'See our work',
  enquire: 'Get in touch',
};

/**
 * Ordered most- to least-specific: the first hit wins.
 *
 * Inflections matter more than they look. "ringing us" is the single most
 * common way a UK tradesperson describes wanting phone calls, and `\bring\b`
 * does not match it — the pattern falls through and something else further
 * down the reply wins instead.
 */
const CTA_PATTERNS = [
  [/\b(book(?:ing|ings|ed)?|appointments?|schedul\w*|diary|slots?)\b/i,     'book'],
  [/\b(quotes?|quoting|quotations?|estimates?|pricing up|price up|surveys?)\b/i, 'quote'],
  [/\b(price list|prices|pricing|how much|costs?|rates|tariff)\b/i,         'prices'],
  [/\b(galler\w+|portfolios?|previous work|past work|photos of|see our work|examples)\b/i, 'gallery'],
  [/\b(ring(?:ing|s)?|call(?:ing|s)?|phone(?:d|s|ing)?|telephone|speak to|get me on|bell)\b/i, 'call'],
  [/\b(enquir\w*|inquir\w*|contact form|message us|get in touch)\b/i,       'enquire'],
];

const YES = /\b(yes|yeah|yep|aye|got|have|i do|we do|sure|can do|will send|i'?ll send|attached)\b/i;
const NO  = /\b(no|nope|none|haven'?t|dont|don'?t have|not got|nothing|n\/a)\b/i;

/**
 * How people tell you the name they trade under. Companies House holds the
 * registered name ("HILLSIDE ROOFING LTD"); the van, the invoices and the
 * site should carry what they actually call themselves.
 */
const TRADING_NAME_PATTERNS = [
  /\b(?:we (?:trade|go) (?:as|by)|trading as|t\/a)\s+["'“]?([^\n."'”]{2,60})/i,
  /\b(?:the (?:business|company|firm) name is|business name is|company name is)\s+["'“]?([^\n."'”]{2,60})/i,
  /\b(?:(?:put|use|call it|call us|it'?s|its|name'?s)\s+)["'“]([^\n"'”]{2,60})["'”]/i,
  /\b(?:we'?re called|we are called|known as)\s+["'“]?([^\n."'”]{2,60})/i,
];

const HEX = /#[0-9a-f]{3,8}\b/gi;
const COLOUR_WORDS = new RegExp(
  '\\b(red|blue|navy|green|dark green|black|white|grey|gray|silver|gold|yellow|orange|' +
  'purple|teal|turquoise|maroon|burgundy|cream|beige|brown|pink)\\b', 'gi'
);

/* ------------------------------------------------------- reply cleanup */

/**
 * Strip the quoted original from a reply. Without this the extractor reads
 * our own outbound email — which contains all three questions and the word
 * "quote" — and confidently returns nonsense.
 */
export function stripQuoted(body) {
  let text = String(body ?? '').replace(/\r\n/g, '\n');

  const cutPoints = [
    /^\s*On .+ wrote:\s*$/im,               // Gmail / Apple Mail
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,
    /^\s*From:\s.+$/im,                     // Outlook block
    /^\s*_{5,}\s*$/m,                       // Outlook divider
    /^\s*Sent from my /im,
    /^>{1,}\s?/m,                           // quoted lines
  ];
  for (const re of cutPoints) {
    const m = text.match(re);
    if (m && m.index != null && m.index > 0) text = text.slice(0, m.index);
  }

  // Drop our own compliance footer if it got quoted back.
  text = text.replace(/\n--\s*\n[\s\S]*$/, '');

  return text.trim();
}

/* ------------------------------------------------- numbered answer split */

/**
 * Pull "1. … 2. … 3. …" out of a reply. Accepts 1. 1) (1) and bare 1 followed
 * by whitespace, and tolerates the answers running across several lines.
 * Returns a map of number -> answer text.
 */
export function numberedAnswers(text) {
  const out = new Map();
  const re = /(?:^|\n)\s*\(?([1-9])[.):\]]?\s+([\s\S]*?)(?=(?:\n\s*\(?[1-9][.):\]]?\s+)|$)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const n = Number(m[1]);
    const body = m[2].trim();
    if (body && !out.has(n)) out.set(n, body);
  }
  return out;
}

/* ------------------------------------------------------------ the rules */

/**
 * Deterministic extraction. Returns the brief plus a list of the fields it
 * could NOT settle, so the caller knows what to ask the model about.
 */
export function extractByRules(replyBody, lead = {}) {
  const text = stripQuoted(replyBody);
  const answers = numberedAnswers(text);
  const missing = [];

  // --- which question is which ----------------------------------------
  // The template asks four questions: name, services, assets, action. An
  // older three-question reply (no name) still has to parse, so the slot
  // map is worked out from the answers rather than assumed: if answer 1
  // reads as a business name, everything after it shifts by one.
  const named = answers.has(1) && looksLikeAName(answers.get(1));
  const slot = named
    ? { name: 1, services: 2, assets: 3, cta: 4 }
    : { name: 0, services: 1, assets: 2, cta: 3 };

  // --- trading name ---------------------------------------------------
  // An explicit "we trade as X" anywhere in the reply beats the slot, since
  // people often answer out of order or in prose.
  let tradingName = null;
  for (const re of TRADING_NAME_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) { tradingName = cleanName(m[1]); break; }
  }
  if (!tradingName && slot.name) tradingName = cleanName(answers.get(slot.name));
  if (!tradingName) missing.push('trading_name');

  // --- services -------------------------------------------------------
  let services = [];
  const servicesAnswer = answers.get(slot.services);
  if (servicesAnswer) services = splitServices(servicesAnswer);
  if (!services.length) {
    // Adverbs sit between the pronoun and the verb far more often than not:
    // "we mostly do roofs", "we mainly cover". Allow for them.
    const m = text.match(
      /\b(?:we|i)\s+(?:mostly\s+|mainly\s+|generally\s+|only\s+|just\s+|usually\s+)?(?:do|offer|provide|specialise in|specialize in|cover)\s+([^\n.]{3,200})/i
    ) ?? text.match(/\bservices?(?:\s+are|\s+include)?:?\s*([^\n.]{3,200})/i);
    if (m) services = splitServices(m[1]);
  }
  if (!services.length && lead.category) services = [titleCase(lead.category)];
  if (!services.length) missing.push('services');

  // --- brand assets ---------------------------------------------------
  const assetText = answers.get(slot.assets) ?? text;
  const hasLogo   = ternary(assetText, /\blogo\b/i);
  const hasPhotos = ternary(assetText, /\b(photo|photos|pictures|pics|images|gallery)\b/i);
  if (hasLogo === null || hasPhotos === null) missing.push('assets');

  // --- colours --------------------------------------------------------
  const colours = [
    ...(assetText.match(HEX) ?? []),
    ...(assetText.match(COLOUR_WORDS) ?? []).map((c) => c.toLowerCase()),
  ];
  const brandColours = [...new Set(colours)].slice(0, 4);

  // --- primary call to action ----------------------------------------
  // This is the field that shapes the whole site, so its own answer is
  // checked in isolation before falling back to scanning the whole reply.
  let cta = null;
  for (const source of [answers.get(slot.cta), text]) {
    if (!source) continue;
    for (const [re, value] of CTA_PATTERNS) {
      if (re.test(source)) { cta = value; break; }
    }
    if (cta) break;
  }
  if (!cta) missing.push('primary_cta');

  // --- areas covered --------------------------------------------------
  let areas = [];
  const areaMatch = text.match(
    /\b(?:cover(?:ing|s)?|serv(?:e|ing|es)|work(?:ing)?\s+(?:in|around|round)|based\s+(?:in|around|round)|round|around|within)\s+([^\n.]{3,120})/i
  );
  if (areaMatch) areas = splitServices(areaMatch[1]).slice(0, 8);
  // Merge the lead's own town in — a reply naming other towns rarely repeats
  // the one we already knew about.
  if (lead.location && !areas.some((a) => a.toLowerCase() === String(lead.location).toLowerCase())) {
    areas.unshift(titleCase(lead.location));
  }

  return {
    trading_name: tradingName,
    services,
    primary_cta: cta,
    areas,
    has_logo: hasLogo === true,
    has_photos: hasPhotos === true,
    brand_colours: brandColours,
    tone: null,
    notes: null,
    source: 'rules',
    // Confidence tracks how much of the reply actually parsed. A brief the
    // rules filled entirely from numbered answers is worth trusting; one
    // assembled from scraps is not.
    confidence: scoreRules({ services, cta, answers, hasLogo, hasPhotos }),
    missing,
    clean_text: text,
  };
}

function scoreRules({ services, cta, answers, hasLogo, hasPhotos }) {
  let score = 20;
  if (answers.size >= 3) score += 30;
  else if (answers.size > 0) score += 15;
  if (services.length) score += 20;
  if (cta) score += 20;
  if (hasLogo !== null || hasPhotos !== null) score += 10;
  return Math.min(100, score);
}

/**
 * "We do roofing, guttering and flat roofs. Mainly want domestic work."
 *   -> ['Roofing', 'Guttering', 'Flat roofs']
 *
 * Three things have to happen: drop the leading verb phrase, cut at the
 * first sentence end (what follows is commentary, not a service), and split
 * the remainder on the usual list separators.
 */
const LEAD_IN = /^\s*(?:we\s+(?:mostly\s+|mainly\s+|generally\s+|only\s+)?(?:do|offer|provide|specialise in|specialize in|cover)|i\s+(?:do|offer)|services?(?:\s+are|\s+include)?|mainly|mostly)\b[:\s]*/i;

/**
 * Words that stop a services list because what follows is where they work,
 * not what they do: "roofs and guttering round Wolverhampton". Deliberately
 * narrow — "in" is excluded because "specialists in roofing" is common and
 * cutting there would lose the service itself.
 */
const COVERAGE_STOP = /\b(?:round|around|near|within|throughout|across|covering|based)\b/i;

export function splitServices(s) {
  let text = String(s ?? '').replace(LEAD_IN, '');

  // Everything after the first sentence break is commentary about the work,
  // not another item of it.
  const stop = text.search(/[.!?](?:\s|$)/);
  if (stop > 0) text = text.slice(0, stop);

  const coverage = text.search(COVERAGE_STOP);
  if (coverage > 0) text = text.slice(0, coverage);

  return [...new Set(
    text
      .split(/\n|,|;|·|•|\band\b|\&|\/|\+/i)
      .map((x) => x
        .replace(/^[\s\-*\d.):\]]+/, '')
        .replace(LEAD_IN, '')
        .replace(/[.\s]+$/, '')
        .trim())
      .filter((x) => x.length > 2 && x.length <= 60)
      .map(titleCase)
  )].slice(0, 12);
}

/**
 * A business name is short, has few words, and is not a sentence. This is
 * what stops "we do roofing, guttering and flat roofs" being taken as the
 * name when someone answers the questions out of order.
 */
export function looksLikeAName(s) {
  const t = String(s ?? '').trim();
  if (!t || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  if (/[.!?]\s/.test(t)) return false;                     // more than one sentence
  if (/\b(we|our|us|they|i)\b/i.test(t)) return false;      // prose, not a name
  if (/,/.test(t) && words.length > 3) return false;        // a list
  return true;
}

/** Strip stray quotes and trailing punctuation from a name. */
const cleanName = (s) =>
  String(s ?? '').trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim() || null;

const titleCase = (s) =>
  String(s).replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/**
 * true / false / null (not mentioned) for a yes-no question about `topic`.
 *
 * The case that matters: "No logo yet but I've got loads of photos". One
 * sentence, one negative and one positive, and they apply to different
 * things. Splitting on the sentence alone gets photos wrong. So this splits
 * on contrastive conjunctions too, and reads only the clause the topic word
 * actually appears in.
 */
function ternary(text, topic) {
  const clauses = String(text ?? '')
    .split(/(?<=[.!?\n])|\b(?:but|however|though|although|whereas)\b/i)
    .map((s) => (s ?? '').trim())
    .filter(Boolean);

  const hit = clauses.find((c) => topic.test(c));
  if (!hit) return null;

  // Within the clause, a negation only counts if it comes before the topic
  // word — "no logo" is a denial, "logo, no problem" is not.
  const at = hit.search(topic);
  const before = hit.slice(0, at);
  if (NO.test(before)) return false;
  if (YES.test(hit)) return true;
  if (NO.test(hit)) return false;
  return null;
}

/* ------------------------------------------------------ the local model */

const SYSTEM = `You extract structured facts from a reply sent by a UK tradesperson or small business owner to a web designer who offered to build them a website.

Return ONLY a JSON object with these keys:
  "trading_name":  string or null — the name they want ON THE WEBSITE. This is
                   often shorter than the registered company name: "Hillside
                   Roofing" rather than "HILLSIDE ROOFING LIMITED". Null if
                   they did not say.
  "services":      array of strings — the specific work this business does
  "primary_cta":   one of "call", "quote", "book", "prices", "gallery", "enquire" — what the business wants a visitor to do first
  "areas":         array of strings — towns or regions they cover
  "has_logo":      boolean — do they already have a logo
  "has_photos":    boolean — do they have photos of their own work
  "brand_colours": array of strings — any colours they mention wanting
  "tone":          one short phrase describing how they write (e.g. "plain and direct", "friendly", "formal")
  "notes":         one or two sentences on anything else that would change the design

Rules:
- Use only what the reply actually says. Do not invent services or areas.
- If something is not mentioned, use an empty array, false, or null.
- Never include the web designer's own questions in your answer.`;

/** Ask the local model to fill what the rules could not. */
export async function extractByModel(cleanText, lead = {}) {
  const probe = await available();
  if (!probe.ok) return { ok: false, error: probe.detail, unavailable: true };

  const context = [
    lead.business_name ? `Business name: ${lead.business_name}` : null,
    lead.category ? `Trade (from the companies register): ${lead.category}` : null,
    lead.location ? `Town: ${lead.location}` : null,
  ].filter(Boolean).join('\n');

  const result = await extractJson({
    system: SYSTEM,
    prompt: `${context ? `${context}\n\n` : ''}The reply:\n\n"""\n${cleanText}\n"""\n\nExtract the JSON object.`,
    coerce: (raw) => ({
      trading_name:  asText(raw.trading_name),
      services:      asList(raw.services, { max: 12 }),
      primary_cta:   asOneOf(raw.primary_cta, CTAS, null),
      areas:         asList(raw.areas, { max: 8 }),
      has_logo:      asBool(raw.has_logo, false),
      has_photos:    asBool(raw.has_photos, false),
      brand_colours: asList(raw.brand_colours, { max: 4 }),
      tone:          asText(raw.tone),
      notes:         asText(raw.notes),
    }),
  });

  return result;
}

/* ------------------------------------------------------------- combined */

/**
 * The entry point. Rules first; the model fills the gaps if it is there.
 *
 * Merge policy: a rules answer is never overwritten by the model. The rules
 * only produce an answer when they matched something explicit, so where they
 * spoke they are the better source — and it keeps the output stable across
 * runs, which a generated answer would not be.
 */
export async function buildBrief(replyBody, lead = {}, { useModel = true } = {}) {
  const rules = extractByRules(replyBody, lead);

  if (!useModel || !rules.missing.length) {
    return { ...rules, model_error: null };
  }

  const model = await extractByModel(rules.clean_text, lead);
  if (!model.ok) {
    return { ...rules, model_error: model.error, model_unavailable: Boolean(model.unavailable) };
  }

  const m = model.data;
  const merged = {
    ...rules,
    trading_name:  rules.trading_name         ?? m.trading_name,
    services:      rules.services.length      ? rules.services      : m.services,
    primary_cta:   rules.primary_cta          ?? m.primary_cta,
    areas:         rules.areas.length         ? rules.areas         : m.areas,
    brand_colours: rules.brand_colours.length ? rules.brand_colours : m.brand_colours,
    // The rules can only ever say "mentioned positively"; the model reads
    // the sentence properly, so it is allowed to turn a false into a true.
    has_logo:   rules.has_logo   || m.has_logo,
    has_photos: rules.has_photos || m.has_photos,
    tone:  m.tone,
    notes: m.notes,
    source: 'rules+model',
    confidence: Math.min(100, rules.confidence + 25),
    model_error: null,
  };
  merged.missing = remainingGaps(merged);
  return merged;
}

function remainingGaps(b) {
  const gaps = [];
  if (!b.services?.length) gaps.push('services');
  if (!b.primary_cta) gaps.push('primary_cta');
  return gaps;
}

/**
 * Coerce a list field to a real array of non-empty strings.
 *
 * The generator joins and maps these, so a string where an array belongs
 * throws — and it throws inside "Build mockup", which is the one button in
 * the tool that must not fail. The columns are JSON, written by a model, by
 * the rules pass, and by a PATCH from the review screen, so "it is always an
 * array upstream" is three assumptions rather than a guarantee. A bare string
 * is the plausible mistake, and it is silent: `"a, b".length` is truthy, so
 * every emptiness check upstream passes it straight through.
 *
 * Splitting a stray string on commas is the reading the user meant.
 */
function asStrings(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof v === 'string') {
    return v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  }
  return [];
}

/**
 * Everything the generator needs, with sane defaults filled in. A brief with
 * gaps still produces a site — it just produces a more generic one — so the
 * user is never blocked from sending something.
 */
export function briefForBuild(brief, lead = {}) {
  const trade = resolveTrade(lead.category ?? '')?.label ?? lead.category ?? null;
  const services = asStrings(brief.services);
  const areas    = asStrings(brief.areas);
  return {
    // What they asked to be called wins over the register's version. The
    // registered name is kept alongside for the footer, where the legal
    // name is the correct one to show.
    business_name: brief.trading_name || tidyRegisteredName(lead.business_name),
    registered_name: lead.business_name ?? null,
    trade,
    services: services.length ? services : defaultServices(trade, lead),
    primary_cta: CTAS.includes(brief.primary_cta) ? brief.primary_cta : 'call',
    areas: areas.length ? areas : (lead.location ? [String(lead.location)] : []),
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    has_logo: Boolean(brief.has_logo),
    has_photos: Boolean(brief.has_photos),
    brand_colours: asStrings(brief.brand_colours),
    tone: brief.tone ?? null,
    notes: brief.notes ?? null,
  };
}

/**
 * Companies House stores names in capitals. Rendered raw as a site's
 * masthead that reads as SHOUTING, so it is title-cased when we have
 * nothing better — but only when it IS all-caps, so a name someone
 * deliberately styled is left alone.
 */
export function tidyRegisteredName(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'Your Business';
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Ltd|Llp|Plc|Cic)\b/gi, (m) => m.toUpperCase());
}

function defaultServices(trade, lead) {
  const base = trade ?? lead.category ?? 'Our services';
  return [titleCase(base)];
}
