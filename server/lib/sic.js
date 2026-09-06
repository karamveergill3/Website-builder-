/**
 * A convenience map from the words you would actually type to SIC 2007 codes,
 * so "roofers" finds SIC 43910 without anyone memorising the register.
 *
 * This list is hand-curated and deliberately short — the trades most likely to
 * be running without a website. It is a shortcut, not the register: the full
 * official list is at
 * https://resources.companieshouse.gov.uk/sic/
 * and any code can be typed in directly.
 *
 * Codes are recorded as the five-digit UK condensed SIC used by Companies
 * House. If a search comes back empty or obviously wrong, check the code
 * against that page rather than trusting this file.
 */

export const TRADES = [
  { codes: ['43910'], label: 'Roofing', terms: ['roofer', 'roofers', 'roofing', 'roof repairs', 'flat roofing'] },
  { codes: ['43210'], label: 'Electrical installation', terms: ['electrician', 'electricians', 'electrical'] },
  { codes: ['43220'], label: 'Plumbing, heating and air conditioning', terms: ['plumber', 'plumbers', 'plumbing', 'heating engineer', 'boiler', 'gas engineer'] },
  { codes: ['43310'], label: 'Plastering', terms: ['plasterer', 'plasterers', 'plastering', 'rendering'] },
  { codes: ['43320'], label: 'Joinery installation', terms: ['joiner', 'joiners', 'joinery', 'carpenter', 'carpenters', 'carpentry'] },
  { codes: ['43330'], label: 'Floor and wall covering', terms: ['tiler', 'tilers', 'tiling', 'flooring', 'floor fitter', 'carpet fitter'] },
  { codes: ['43341'], label: 'Painting', terms: ['painter', 'painters', 'decorator', 'decorators', 'painting and decorating'] },
  { codes: ['43342'], label: 'Glazing', terms: ['glazier', 'glaziers', 'glazing', 'double glazing', 'window fitter'] },
  { codes: ['43390'], label: 'Building completion and finishing', terms: ['kitchen fitter', 'bathroom fitter', 'shopfitter', 'finishing'] },
  { codes: ['43110'], label: 'Demolition', terms: ['demolition'] },
  { codes: ['43120'], label: 'Site preparation', terms: ['groundworks', 'groundworker', 'groundworkers', 'excavation', 'site preparation'] },
  { codes: ['43991'], label: 'Scaffold erection', terms: ['scaffolder', 'scaffolders', 'scaffolding'] },
  { codes: ['43999'], label: 'Other specialised construction', terms: ['damp proofing', 'underpinning', 'steel erection', 'insulation', 'specialised construction'] },
  { codes: ['41202', '41201'], label: 'Building contractors', terms: ['builder', 'builders', 'building contractor', 'construction'] },
  { codes: ['43290'], label: 'Other construction installation', terms: ['alarm installer', 'security systems', 'ducting', 'lift installation'] },
  { codes: ['81300'], label: 'Landscaping', terms: ['landscaper', 'landscapers', 'landscaping', 'gardener', 'gardeners', 'grounds maintenance', 'tree surgeon'] },
  { codes: ['81210', '81229'], label: 'Cleaning of buildings', terms: ['cleaner', 'cleaners', 'cleaning', 'commercial cleaning', 'end of tenancy'] },
  { codes: ['81221'], label: 'Window cleaning', terms: ['window cleaner', 'window cleaners', 'window cleaning'] },
  { codes: ['81299'], label: 'Other cleaning', terms: ['chimney sweep', 'chimney sweeps', 'oven cleaning', 'carpet cleaning', 'pressure washing'] },
  { codes: ['45200'], label: 'Vehicle maintenance and repair', terms: ['garage', 'mechanic', 'mechanics', 'mot', 'car repair', 'bodyshop'] },
  { codes: ['95220'], label: 'Appliance and equipment repair', terms: ['appliance repair', 'washing machine repair', 'mower repair'] },
  { codes: ['96020'], label: 'Hairdressing and beauty', terms: ['hairdresser', 'hairdressers', 'barber', 'barbers', 'salon', 'beautician', 'nail bar'] },
  { codes: ['96090'], label: 'Other personal services', terms: ['dog groomer', 'dog grooming', 'pet services'] },
  { codes: ['49410'], label: 'Road freight', terms: ['haulage', 'courier', 'man and van', 'removals'] },
  { codes: ['56102'], label: 'Cafes and unlicensed restaurants', terms: ['cafe', 'coffee shop', 'sandwich shop', 'takeaway'] },
  { codes: ['93130'], label: 'Fitness', terms: ['gym', 'personal trainer', 'fitness'] },
  { codes: ['74209'], label: 'Photography', terms: ['photographer', 'photographers', 'photography'] },
  { codes: ['71111'], label: 'Architecture', terms: ['architect', 'architects'] },
  { codes: ['80200'], label: 'Security systems', terms: ['locksmith', 'locksmiths', 'cctv', 'security'] },
  { codes: ['33120'], label: 'Machinery repair', terms: ['machinery repair', 'plant repair', 'welding', 'fabrication'] },
];

const SIC_RE = /^\d{4,5}$/;

/**
 * Turn what someone typed into SIC codes.
 * Returns { codes, label, exact } — `exact` when they typed codes directly.
 */
export function resolveTrade(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { codes: [], label: null, exact: false };

  // Straight codes, comma or space separated.
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((p) => SIC_RE.test(p))) {
    return { codes: parts, label: null, exact: true };
  }

  const singular = raw.replace(/s$/, '');
  let best = null;

  for (const t of TRADES) {
    for (const term of t.terms) {
      if (term === raw || term === singular) return { codes: t.codes, label: t.label, exact: false, term };
      if (raw.includes(term) || term.includes(raw)) {
        const score = Math.min(term.length, raw.length) / Math.max(term.length, raw.length);
        if (!best || score > best.score) best = { codes: t.codes, label: t.label, exact: false, term, score };
      }
    }
  }
  return best ?? { codes: [], label: null, exact: false };
}

/** For the UI's trade picker. */
export const tradeList = () =>
  TRADES.map((t) => ({ label: t.label, codes: t.codes, example: t.terms[0] }));
