/**
 * A convenience map from the words you would actually type to SIC 2007 codes,
 * so "roofers" finds SIC 43910 without anyone memorising the register.
 *
 * The list covers the trades most likely to be running without a website —
 * building trades, home services, motor, personal services, food — i.e. the
 * SERVICE businesses a one-page brochure site actually suits. Pure product
 * retailers (a jeweller, a boutique, a car-parts shop) are deliberately left
 * out: what they need is an online shop with a stock catalogue, not the
 * lead-generating site Keylo builds, so the hunt does not chase them.
 * Anything you type that does not resolve here is reported back as
 * "unrecognised" rather than silently dropped, and any five-digit code can
 * be typed in directly.
 *
 * Codes are the five-digit UK condensed SIC used by Companies House. The
 * full official list is at https://resources.companieshouse.gov.uk/sic/
 */

export const TRADES = [
  /* --------------- construction & building trades --------------------- */
  { codes: ['43910'], label: 'Roofing', terms: ['roofer', 'roofers', 'roofing', 'roof repairs', 'flat roofing'] },
  { codes: ['43210'], label: 'Electrical installation', terms: ['electrician', 'electricians', 'electrical', 'sparks'] },
  { codes: ['43220'], label: 'Plumbing, heating and air conditioning', terms: ['plumber', 'plumbers', 'plumbing', 'heating engineer', 'boiler', 'gas engineer', 'gas safe'] },
  { codes: ['43310'], label: 'Plastering', terms: ['plasterer', 'plasterers', 'plastering', 'rendering', 'render'] },
  { codes: ['43320'], label: 'Joinery installation', terms: ['joiner', 'joiners', 'joinery', 'carpenter', 'carpenters', 'carpentry'] },
  { codes: ['43330'], label: 'Floor and wall covering', terms: ['tiler', 'tilers', 'tiling', 'flooring', 'floor fitter', 'carpet fitter', 'wood flooring'] },
  { codes: ['43341'], label: 'Painting', terms: ['painter', 'painters', 'decorator', 'decorators', 'painting and decorating', 'painter decorator'] },
  { codes: ['43342'], label: 'Glazing', terms: ['glazier', 'glaziers', 'glazing', 'double glazing', 'window fitter', 'windows and doors'] },
  { codes: ['43390'], label: 'Building completion and finishing', terms: ['kitchen fitter', 'kitchen installation', 'bathroom fitter', 'bathroom installation', 'shopfitter', 'shopfitting', 'finishing'] },
  { codes: ['43110'], label: 'Demolition', terms: ['demolition'] },
  { codes: ['43120'], label: 'Site preparation', terms: ['groundworks', 'groundworker', 'groundworkers', 'excavation', 'site preparation', 'muckaway'] },
  { codes: ['43991'], label: 'Scaffold erection', terms: ['scaffolder', 'scaffolders', 'scaffolding'] },
  { codes: ['43999'], label: 'Other specialised construction', terms: ['damp proofing', 'underpinning', 'steel erection', 'insulation', 'specialised construction', 'loft insulation', 'cavity wall'] },
  { codes: ['41202', '41201'], label: 'Building contractors', terms: ['builder', 'builders', 'building contractor', 'construction', 'extension builder', 'loft conversion'] },
  { codes: ['43290'], label: 'Other construction installation', terms: ['alarm installer', 'security systems', 'ducting', 'lift installation', 'aerial fitter', 'satellite'] },
  { codes: ['43120'], label: 'Bricklaying', terms: ['bricklayer', 'bricklayers', 'bricklaying', 'bricks'] },
  { codes: ['43991'], label: 'Stonemasonry', terms: ['stonemason', 'stonemasons', 'stone masonry', 'stonework'] },
  { codes: ['43390'], label: 'Drylining', terms: ['dryliner', 'drylining', 'stud walls'] },
  { codes: ['43299'], label: 'Solar installation', terms: ['solar', 'solar panels', 'solar installer', 'pv panels', 'ev charger'] },
  { codes: ['43221'], label: 'Renewable heating', terms: ['heat pump', 'heat pumps', 'air source', 'ground source', 'renewables'] },

  /* --------------- landscaping and outdoor ---------------------------- */
  { codes: ['81300'], label: 'Landscaping', terms: ['landscaper', 'landscapers', 'landscaping', 'gardener', 'gardeners', 'grounds maintenance', 'tree surgeon', 'tree surgery', 'arborist'] },
  { codes: ['81300'], label: 'Fencing and paving', terms: ['fencer', 'fencing', 'fence installer', 'paving', 'paver', 'driveway', 'driveways', 'block paving', 'tarmac'] },
  { codes: ['01300'], label: 'Turf and grass', terms: ['artificial grass', 'astroturf', 'lawn care', 'lawn treatment', 'turfing'] },
  { codes: ['16290'], label: 'Garden buildings', terms: ['shed builder', 'sheds', 'garden rooms', 'summerhouse', 'log cabin'] },

  /* --------------- home services -------------------------------------- */
  { codes: ['81210', '81229'], label: 'Cleaning of buildings', terms: ['cleaner', 'cleaners', 'cleaning', 'commercial cleaning', 'end of tenancy', 'office cleaning', 'domestic cleaner'] },
  { codes: ['81221'], label: 'Window cleaning', terms: ['window cleaner', 'window cleaners', 'window cleaning'] },
  { codes: ['81299'], label: 'Other cleaning', terms: ['chimney sweep', 'chimney sweeps', 'oven cleaning', 'carpet cleaning', 'pressure washing', 'gutter cleaning', 'jet washing'] },
  { codes: ['81291'], label: 'Pest control', terms: ['pest control', 'exterminator', 'rat catcher', 'wasp nest'] },
  { codes: ['49420'], label: 'Removals', terms: ['removals', 'removals company', 'man and van', 'house clearance', 'house clearances'] },
  { codes: ['80200'], label: 'Locksmith and security', terms: ['locksmith', 'locksmiths', 'cctv', 'security', 'security installer', 'access control'] },
  { codes: ['95220'], label: 'Appliance and equipment repair', terms: ['appliance repair', 'washing machine repair', 'mower repair', 'white goods repair', 'domestic appliance'] },
  { codes: ['95210'], label: 'Electronics repair', terms: ['tv repair', 'phone repair', 'laptop repair', 'computer repair', 'iphone repair'] },
  { codes: ['95230'], label: 'Shoe and leather repair', terms: ['cobbler', 'shoe repair', 'key cutting'] },
  { codes: ['95240'], label: 'Upholstery repair', terms: ['upholsterer', 'upholstery', 're-upholstery', 'furniture repair'] },
  { codes: ['81290'], label: 'Handyman services', terms: ['handyman', 'handymen', 'odd jobs', 'property maintenance', 'jobbing builder'] },
  { codes: ['37000'], label: 'Drainage', terms: ['drain service', 'drainage', 'blocked drains', 'drain unblocking', 'cctv drain'] },

  /* --------------- motor trade ---------------------------------------- */
  { codes: ['45200'], label: 'Vehicle maintenance and repair', terms: ['garage', 'mechanic', 'mechanics', 'mot', 'mot centre', 'car repair', 'bodyshop', 'body shop', 'mobile mechanic'] },
  { codes: ['45400'], label: 'Motorcycles', terms: ['motorcycle repair', 'motorbike repair', 'bike shop'] },
  { codes: ['45201'], label: 'Valeting and cleaning', terms: ['car valeting', 'car detailing', 'mobile valet'] },
  { codes: ['85530'], label: 'Driving instruction', terms: ['driving instructor', 'driving school', 'driving lessons'] },

  /* --------------- health, beauty, personal care ---------------------- */
  { codes: ['96020'], label: 'Hairdressing and beauty', terms: ['hairdresser', 'hairdressers', 'barber', 'barbers', 'salon', 'beautician', 'beauty salon'] },
  { codes: ['96020'], label: 'Nail and beauty', terms: ['nail bar', 'nails', 'nail tech', 'lashes', 'lash tech', 'brow bar', 'eyelash'] },
  { codes: ['96090'], label: 'Personal care', terms: ['tattoo', 'tattoo artist', 'tattooist', 'piercer', 'piercing'] },
  { codes: ['96040'], label: 'Wellbeing', terms: ['massage', 'massage therapist', 'reflexology', 'acupuncture', 'holistic', 'reiki'] },
  { codes: ['86900'], label: 'Complementary therapy', terms: ['osteopath', 'chiropractor', 'physio', 'physiotherapist', 'sports therapist', 'sports massage'] },
  { codes: ['96090'], label: 'Pet services', terms: ['dog groomer', 'dog grooming', 'dog walker', 'pet services', 'dog daycare', 'pet sitter'] },

  /* --------------- food and drink ------------------------------------- */
  { codes: ['56101'], label: 'Restaurants and cafes (licensed)', terms: ['restaurant', 'bistro', 'gastropub', 'licensed cafe'] },
  { codes: ['56102'], label: 'Cafes and unlicensed restaurants', terms: ['cafe', 'coffee shop', 'sandwich shop', 'tea room'] },
  { codes: ['56103'], label: 'Takeaways', terms: ['takeaway', 'takeaways', 'chip shop', 'fish and chips', 'kebab', 'chinese takeaway', 'indian takeaway', 'pizza takeaway'] },
  { codes: ['56290'], label: 'Catering and food services', terms: ['catering', 'caterer', 'caterers', 'food truck', 'mobile catering', 'private chef', 'event catering'] },
  { codes: ['10710'], label: 'Bakeries', terms: ['bakery', 'baker', 'bakers', 'artisan bakery', 'cake maker'] },
  { codes: ['10130'], label: 'Butchers', terms: ['butcher', 'butchers', 'family butcher'] },
  { codes: ['47230'], label: 'Fishmongers', terms: ['fishmonger', 'fishmongers'] },
  { codes: ['47240'], label: 'Delis and food shops', terms: ['deli', 'delicatessen', 'farm shop', 'greengrocer'] },

  /* --------------- events, arts, personal services -------------------- */
  { codes: ['74209'], label: 'Photography', terms: ['photographer', 'photographers', 'photography', 'wedding photographer'] },
  { codes: ['74300'], label: 'Translation', terms: ['translator', 'translation', 'interpreting'] },
  { codes: ['82990'], label: 'Event services', terms: ['wedding planner', 'event planner', 'party planner', 'wedding stylist'] },
  { codes: ['90020'], label: 'Entertainment', terms: ['dj', 'wedding dj', 'entertainer', 'magician', 'wedding band', 'function band'] },
  { codes: ['77400'], label: 'Event hire', terms: ['bouncy castle', 'marquee hire', 'party hire', 'event hire', 'wedding hire'] },
  { codes: ['85590'], label: 'Tuition', terms: ['tutor', 'tuition', 'private tutor', 'music teacher', 'driving instructor'] },
  { codes: ['85510'], label: 'Sports coaching', terms: ['football coach', 'swim school', 'sports coach', 'martial arts', 'karate'] },
  { codes: ['71111'], label: 'Architecture', terms: ['architect', 'architects', 'architectural designer'] },
  { codes: ['74100'], label: 'Design', terms: ['interior designer', 'kitchen designer', 'garden designer'] },
  { codes: ['33120'], label: 'Machinery repair', terms: ['machinery repair', 'plant repair', 'welding', 'welder', 'fabrication', 'fabricator', 'metalwork'] },
  { codes: ['16230'], label: 'Bespoke joinery and carpentry', terms: ['bespoke joinery', 'custom furniture', 'wardrobes', 'bespoke wardrobes', 'staircase'] },
  { codes: ['31090'], label: 'Bespoke furniture', terms: ['furniture maker', 'bespoke furniture', 'cabinet maker'] },

  /* --------------- transport ------------------------------------------ */
  { codes: ['49410'], label: 'Road freight', terms: ['haulage', 'courier', 'sameday courier', 'palletised'] },
  { codes: ['49320'], label: 'Taxi and private hire', terms: ['taxi', 'private hire', 'chauffeur', 'airport transfer', 'minicab'] },
  { codes: ['52290'], label: 'Freight forwarding', terms: ['freight forwarder', 'logistics'] },

  /* --------------- signs, print, small manufacturing ------------------ */
  { codes: ['18129'], label: 'Print and signs', terms: ['printer', 'printers', 'sign maker', 'signwriter', 'vehicle wrapping', 'graphics'] },
  { codes: ['32990'], label: 'Small manufacturing', terms: ['bespoke manufacture', 'custom made', 'craft maker'] },
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

/**
 * Every distinct trade keyword the picker recognises, one per line, ready to
 * paste into the Hunt configuration. Used by the "add every trade" preset.
 * We return the FIRST term of each row — the most obvious keyword — because
 * one row can carry several synonyms and we want each trade listed once.
 */
export function allTradeKeywords() {
  const seen = new Set();
  const out = [];
  for (const t of TRADES) {
    const first = t.terms[0];
    if (first && !seen.has(first)) {
      seen.add(first);
      out.push(first);
    }
  }
  return out;
}
