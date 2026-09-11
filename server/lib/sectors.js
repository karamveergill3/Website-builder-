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
 * A handful of sectors earn their own wording; anything unrecognised falls to
 * a generic opener that reads naturally for any trade. Order matters — the
 * first sector whose keyword hits wins — so the most specific trade terms
 * (salon, building trades) come before the broader ones. Matching is a
 * case-insensitive WORD-PREFIX (see sectorFor), so "roof" hits "roofing" but
 * "tan" does not hit "accountant".
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
      'pav', 'driveway', 'tarmac', 'scaffold', 'ground', 'drain', 'guttering', 'shopfit',
      'damp', 'insulation', 'heating', 'gas', 'boiler', 'handyman', 'mason', 'demolition',
    ],
  },
  {
    key: 'motor',
    label: 'Motor',
    keywords: [
      'garage', 'mechanic', 'mot', 'tyre', 'tire', 'valet', 'bodyshop', 'body shop',
      'auto', 'motor', 'vehicle', 'car ', 'cars', 'car repair', 'recovery',
    ],
  },
  {
    key: 'food',
    label: 'Food & drink',
    keywords: [
      'cafe', 'coffee', 'takeaway', 'take away', 'restaurant', 'bakery', 'baker',
      'deli', 'catering', 'caterer', 'patisserie', 'bistro', 'diner', 'chippy',
      'fish and chip', 'pizzeria', 'sandwich', 'butcher',
    ],
  },
  {
    key: 'fitness',
    label: 'Health & fitness',
    keywords: [
      'gym', 'fitness', 'personal train', 'pilates', 'yoga', 'physio', 'dentist',
      'dental', 'chiropract', 'osteopath', 'sports therap', 'wellbeing',
    ],
  },
  {
    key: 'shop',
    label: 'Shops',
    keywords: [
      'shop', 'boutique', 'retail', 'florist', 'jeweller', 'grocer', 'newsagent',
      'off licence', 'gift shop', 'homeware', 'furniture',
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
