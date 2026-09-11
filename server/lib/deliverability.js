/**
 * Scoring a draft for the things that actually move inbox placement.
 *
 * At 10-25 messages a day from one mailbox, the usual levers are gone:
 * authentication is Google's and already perfect, and there is no domain
 * reputation to build because you do not own gmail.com. What is left is the
 * shape of the message and whether you generate a complaint or a bounce --
 * and at this volume a single bounce is a 4% daily bounce rate, roughly
 * thirteen times the rate that gets a sender throttled.
 *
 * So the checks below weight links, message shape and credibility, and are
 * deliberately quiet about "spam trigger words", which modern ML filters
 * largely ignore. Rules that only matter at the long tail -- SpamAssassin
 * still runs on plenty of UK small-business mail servers -- are kept as
 * warnings because avoiding them costs nothing.
 *
 * Sources and the reasoning behind each weight: docs/DELIVERABILITY.md.
 */

/** Public URL shorteners and redirectors. Spamhaus lists these separately. */
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'is.gd', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in',
  't.ly', 'bl.ink', 'short.io', 'snip.ly', 's.id', 'qr.ae', 'trib.al',
]);

/**
 * Structural markers of bulk mail. These classify a message as a campaign
 * rather than a note from a person, which is the framing that earns replies.
 */
const BULK_MARKERS = [
  { re: /view (this |it |the email )?in (your |a )?browser/i, what: 'a “view in browser” line' },
  { re: /^\s*unsubscribe\s*\|/im, what: 'an unsubscribe bar' },
  { re: /you (are )?receiv(ing|ed) this (email|message) because/i, what: 'a mailing-list preamble' },
  { re: /\bclick here\b/i, what: '“click here”' },
  { re: /this email was sent to\b/i, what: 'a mailing-list footer' },
  { re: /©\s*\d{4}\b.{0,40}all rights reserved/i, what: 'a copyright footer' },
];

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const PLACEHOLDER_RE = /\{\{\s*[a-z_]+\s*\}\}/i;

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

function linksIn(body) {
  const found = [];
  for (const m of String(body ?? '').matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    let host = '';
    try { host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase(); }
    catch { host = raw.toLowerCase(); }
    found.push({ raw, host: host.replace(/^www\./, '') });
  }
  return found;
}

/**
 * Look for the wreckage of a placeholder that rendered empty: "roofers in ,"
 * or "Hi ," -- to a reader this is the clearest possible sign of a mail merge.
 */
function danglingGaps(text) {
  const t = String(text ?? '');
  const hits = [];
  // Each of these requires actual whitespace before the punctuation: "in ,"
  // is a placeholder that rendered empty, whereas "in," and a bare "Hi," on
  // its own line are ordinary, deliberate writing.
  if (/\b(in|at|for|from|to|with)[ \t]+[,.]/i.test(t)) hits.push('a preposition with nothing after it');
  if (/\b(hi|hello|dear)[ \t]+[,.]/i.test(t)) hits.push('a greeting with the name missing');
  if (/[ \t]{3,}/.test(t)) hits.push('a run of blank space');
  if (/\(\s*\)|\[\s*\]/.test(t)) hits.push('empty brackets');
  return hits;
}

/**
 * Score a draft. Returns a total (higher is worse), a level, and the checks
 * that fired. `block` means the send paths refuse it.
 */
export function scoreDraft({ subject = '', body = '' } = {}) {
  const checks = [];
  const add = (weight, level, title, detail) => checks.push({ weight, level, title, detail });

  const subjectWords = words(subject);
  const bodyWords = words(body);
  const links = linksIn(body);

  /* ---- links: the highest-signal element in the message ---- */

  const hosts = [...new Set(links.map((l) => l.host))];
  if (links.length >= 3) {
    add(5, 'block', `${links.length} links`,
      'Every domain in the body is checked against blocklists, so each link is another way to fail. One or none for a first contact.');
  } else if (links.length === 2) {
    add(2, 'warn', 'Two links',
      'Two or more links in a first-contact email is a recognised pattern. Consider cutting to one.');
  }

  const shorteners = hosts.filter((h) => SHORTENERS.has(h));
  if (shorteners.length) {
    add(6, 'block', `Link shortener: ${shorteners.join(', ')}`,
      'Spamhaus keeps a dedicated list for abused shorteners. Use the real URL.');
  }

  /* ---- shape: images, tracking, attachments ---- */

  if (/<img\b|\[image\]|cid:/i.test(body)) {
    add(4, 'block', 'Image in the body',
      'These emails go out as plain text. An image means a tracking pixel to a filter.');
  }
  if (/<\/?(table|div|span|font|style|a)\b/i.test(body)) {
    add(3, 'warn', 'HTML markup in the body',
      'It will be sent literally, as text. Write plain text.');
  }

  /* ---- shape: length ---- */

  if (bodyWords.length === 0) {
    add(8, 'block', 'Empty body', 'There is nothing to send.');
  } else if (bodyWords.length < 30) {
    add(3, 'warn', `Very short — ${bodyWords.length} words`,
      'A couple of lines and a link is the shape of a compromised-account blast. Aim for 50–125.');
  } else if (bodyWords.length > 200) {
    add(2, 'warn', `Long — ${bodyWords.length} words`,
      'Replies are the strongest positive signal you have, and they fall off sharply past 200 words. Aim for 50–125.');
  }

  /* ---- shape: subject ---- */

  if (subjectWords.length === 0) {
    add(8, 'block', 'No subject', 'A missing subject line is itself a filter signal.');
  } else if (subjectWords.length > 10) {
    add(1, 'warn', `Subject is ${subjectWords.length} words`, 'Four to seven reads best.');
  }
  if (/^\s*(re|fwd?)\s*:/i.test(subject) ) {
    add(4, 'block', 'Subject fakes a reply',
      '“Re:” or “Fwd:” on a first contact is deceptive, and recipients recognise it.');
  }
  if (EMOJI_RE.test(subject)) {
    add(2, 'warn', 'Emoji in the subject', 'It reads as a campaign rather than a note.');
  }

  /* ---- credibility: an unfinished mail merge ---- */

  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) {
    add(6, 'block', 'Unfilled placeholder',
      'A literal {{token}} is going out. Check the template against this lead.');
  }
  const gaps = [...new Set([...danglingGaps(subject), ...danglingGaps(body)])];
  if (gaps.length) {
    add(3, 'warn', 'Reads like an unfinished mail merge',
      `Found ${gaps.join(', ')}. Fill the missing lead details or reword.`);
  }

  /* ---- shouting: Gmail barely cares, SpamAssassin does ---- */

  // Longer than three letters, so ordinary UK business acronyms -- VAT, LLP,
  // CIC, PLC -- are not mistaken for shouting.
  const shouted = bodyWords.filter((w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (shouted.length > 2) {
    add(2, 'warn', `${shouted.length} words in capitals`,
      'Plenty of small-business mail servers still run SpamAssassin, which scores this.');
  }
  if (/[A-Z]{4,}/.test(subject) && subject === subject.toUpperCase()) {
    add(3, 'warn', 'Subject is all capitals', 'A classic SpamAssassin rule.');
  }
  const bangs = (body.match(/!/g) ?? []).length + (subject.match(/!/g) ?? []).length;
  if (bangs > 2) {
    add(2, 'warn', `${bangs} exclamation marks`, 'One at most, and none in the subject.');
  }

  /* ---- shape: does it look like a campaign? ---- */

  for (const m of BULK_MARKERS) {
    if (m.re.test(body)) {
      add(3, 'warn', `Contains ${m.what}`,
        'Bulk-mail furniture undercuts the one-to-one framing that gets replies.');
    }
  }

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const blocked = checks.some((c) => c.level === 'block');

  return {
    score: total,
    level: blocked ? 'block' : total >= 5 ? 'warn' : 'ok',
    blocked,
    checks: checks.sort((a, b) => b.weight - a.weight),
    stats: {
      subject_words: subjectWords.length,
      body_words: bodyWords.length,
      links: links.length,
      link_hosts: hosts,
    },
  };
}
