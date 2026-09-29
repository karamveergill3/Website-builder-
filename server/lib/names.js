/**
 * Business names and towns as a person would write them.
 *
 * Companies House keeps names and addresses in capitals: "HILLSIDE ROOFING
 * LTD", "STOKE-ON-TRENT". Dropped into "I came across HILLSIDE ROOFING LTD in
 * STOKE-ON-TRENT" that reads as copied off a register by a machine, which is
 * the one thing a first message can't afford. So a name that is all capitals
 * is written the way the owner would say it ("Hillside Roofing"), and a town
 * the way it is signposted ("Stoke-on-Trent").
 *
 * Only capitals are changed. A name someone typed or styled themselves
 * ("McKinnon Roofing Ltd", "Snapshot Co Ltd") is left exactly as it is: we
 * can't know better than they do. The stored lead is never changed either;
 * this is for what goes in front of people.
 */

const isShouting = (s) => /[A-Z]/.test(s) && s === s.toUpperCase();

// Small words that stay lower case inside a name or a town.
const SMALL = new Set(['and', 'of', 'the', 'on', 'upon', 'under', 'in', 'by', 'le', 'la', 'de', 'en', 'with', 'at', 'for', 'to', 'a']);
const LEGAL = /[\s,]+(limited|ltd\.?|llp|plc)\s*$/i;
// "CIC", "LLP" and "PLC" are said as letters; "Ltd" and "Limited" are words.
const LETTERS = new Set(['cic', 'llp', 'plc', 'uk', 'gb']);

/** One word, written as a word: "roofing" "Roofing", "mj" "MJ", "john's" "John's". */
function word(w, first) {
  const lower = w.toLowerCase();
  if (LETTERS.has(lower)) return lower.toUpperCase();
  if (lower === 'ltd' || lower === 'ltd.') return 'Ltd';
  // Initials: a short word with no vowel ("MJ", "JB", "DGS") is letters.
  if (/^[b-df-hj-np-tv-z]{2,3}$/.test(lower)) return lower.toUpperCase();
  if (!first && SMALL.has(lower)) return lower;
  // Capital after the start and after a hyphen, slash or bracket, never after
  // an apostrophe: "John's", not "John'S"; "O'Neill" stays as typed below.
  return lower.replace(/(^|[-/(&])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/^O'([a-z])/, (_m, c) => `O'${c.toUpperCase()}`);
}

function tidyWords(s) {
  return s.split(/(\s+)/).map((part, i) => (/^\s+$/.test(part) ? part : word(part, i === 0))).join('');
}

/**
 * The name to use in a message or on a site: "HILLSIDE ROOFING LTD" becomes
 * "Hillside Roofing". Legal suffixes go, since nobody says "Ltd" out loud; a
 * name that is nothing but a suffix keeps it.
 */
export function businessName(name) {
  const s = String(name ?? '').trim();
  if (!s || !isShouting(s)) return s;
  const bare = s.replace(LEGAL, '').trim();
  return tidyWords(bare || s);
}

/** The registered name in normal case, suffix kept: "Hillside Roofing Ltd". */
export function registeredName(name) {
  const s = String(name ?? '').trim();
  if (!s || !isShouting(s)) return s;
  return tidyWords(s);
}

/**
 * A town as it is signposted: "STOKE-ON-TRENT" "Stoke-on-Trent", "BURTON UPON
 * TRENT" "Burton upon Trent". The small joining words are lowered in a town
 * written in any case ("Stoke-On-Trent" from the register comes out right
 * too); otherwise a town already in normal case is left alone.
 */
export function placeName(town) {
  const s = String(town ?? '').trim();
  if (!s) return s;
  const base = isShouting(s) ? tidyWords(s) : s;
  // Joining words inside a town, between words or hyphens, never the first.
  return base.replace(/([-\s])(On|Upon|Under|Le|La|De|En|In|By|The)(?=[-\s])/g,
    (_m, sep, w) => sep + w.toLowerCase());
}
