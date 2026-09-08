/**
 * Which broad sector a lead's trade falls into, so the right opening message
 * picks itself.
 *
 * A roofer and a nail bar want to hear different things: the roofer cares that
 * people can see his work and tap to call, the salon that new clients can find
 * them and book. One generic line works for neither as well as a line written
 * for them. So a lead's free-text category (the trade keyword the hunt or the
 * user typed — "roofers", "nail bar", "café") is mapped to a small set of
 * sectors, and the Reach screen opens the matching template.
 *
 * Deliberately few sectors: two that earn their own wording — the building
 * trades and the salon/beauty world — and everything else on a generic opener
 * that reads naturally for any trade. Matching is substring and
 * case-insensitive against a keyword list, first hit wins.
 */

export const SECTORS = [
  {
    key: 'salon',
    label: 'Salons & beauty',
    keywords: [
      'hair', 'barber', 'salon', 'nail', 'beauty', 'beautician', 'lash', 'brow',
      'aesthetic', 'spa', 'tan', 'wax', 'makeup', 'make-up', 'massage', 'facial',
    ],
  },
  {
    key: 'trades',
    label: 'Trades',
    keywords: [
      'roof', 'plumb', 'electric', 'spark', 'plaster', 'render', 'joiner', 'carpen',
      'build', 'construction', 'brick', 'tiler', 'tiling', 'floor', 'paint', 'decorat',
      'glaz', 'window', 'kitchen fitter', 'bathroom', 'landscap', 'garden', 'fenc',
      'pav', 'driveway', 'drive', 'tarmac', 'scaffold', 'ground', 'drain', 'guttering',
      'damp', 'insulation', 'heating', 'gas', 'boiler', 'handyman', 'mason', 'demolition',
    ],
  },
];

/**
 * The sector key for a category, or null for "use the generic opener".
 *
 * Matched as a word prefix, not a raw substring — otherwise "tan" fires on
 * "accountant" and "gas" on "gasket". A keyword hits only at the start of a
 * word ("hair" → "hairdresser", "roof" → "roofing"), which is what a trade
 * keyword actually is.
 */
export function sectorFor(category) {
  const c = String(category ?? '').toLowerCase().trim();
  if (!c) return null;
  for (const s of SECTORS) {
    if (s.keywords.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(c))) {
      return s.key;
    }
  }
  return null;
}

export const sectorLabel = (key) => SECTORS.find((s) => s.key === key)?.label ?? null;
