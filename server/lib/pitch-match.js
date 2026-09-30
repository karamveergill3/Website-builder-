/**
 * Which pitch a lead's opener carries.
 *
 * Every kind of business the hunt looks for has its own two sentences
 * (lib/pitches.js): what THEIR customers want to see, and what we build for
 * it. A dog groomer hears about before and after photos and booking; a
 * locksmith about a number people can ring fast. The lead's category is the
 * trade the hunt searched for ("dog groomers") or whatever was typed in, and
 * it is matched in order of confidence:
 *
 *   1. exactly one of a pitch's search terms ("dog groomer", "dog groomers")
 *   2. the longest term found inside it, as whole words ("mobile dog groomer")
 *   3. the trade the register search resolves it to (lib/sic.js)
 *   4. its broad sector (lib/sectors.js): salon, trades, food...
 *   5. the general pitch, which reads for any business
 */
import { PITCHES, SECTOR_PITCHES, GENERAL_PITCH } from './pitches.js';
import { resolveTrade, TRADES } from './sic.js';
import { sectorFor } from './sectors.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// term -> pitch, built once.
const BY_TERM = new Map();
for (const p of PITCHES) for (const t of p.terms) BY_TERM.set(norm(t), p);
const TERMS_LONGEST_FIRST = [...BY_TERM.keys()].sort((a, b) => b.length - a.length);

/** { pitch, close, business } for a lead's category. */
export function pitchFor(category) {
  const c = norm(category);
  if (!c) return GENERAL_PITCH;

  const exact = BY_TERM.get(c) ?? BY_TERM.get(c.replace(/s$/, ''));
  if (exact) return exact;

  const padded = ` ${c} `;
  const inside = TERMS_LONGEST_FIRST.find((t) => padded.includes(` ${t} `)
    || padded.includes(` ${t}s `));
  if (inside) return BY_TERM.get(inside);

  const trade = resolveTrade(category);
  if (trade.label) {
    const row = TRADES.find((t) => t.label === trade.label);
    const hit = row?.terms.map((t) => BY_TERM.get(norm(t))).find(Boolean);
    if (hit) return hit;
  }

  return SECTOR_PITCHES[sectorFor(category)] ?? GENERAL_PITCH;
}
