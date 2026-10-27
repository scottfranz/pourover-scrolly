// schema.js — everything about the shape of the spreadsheet lives here,
// so the sheet can evolve without touching build logic.

// Sheet header -> field name. Columns not listed here cause a build error
// (schema drift), unless they're in IGNORED_COLUMNS.
export const COLUMNS = {
  'Bag ID': 'bag_id', // optional; recommended — see README notes in chat
  'My Rating': 'rating',
  'Roast Date': 'roast_date',
  'Opened Bag Date': 'opened_date',
  'Roaster': 'roaster',
  'Name': 'name',
  'Country': 'country',
  'Region': 'region',
  'Producer': 'producer',
  'Farm/Washing Station': 'farm',
  'Harvest Date': 'harvest',
  'Variety': 'variety',
  'Altitude (masl)': 'altitude_m',
  'Process': 'process',
  'clean/funk': 'funk',
  'Roast Level': 'roast_level',
  'development': 'development',
  'Roaster Notes': 'roaster_notes',
  'My Notes': 'my_notes',
  'Weight (grams)': 'weight_g',
  'Price I Paid': 'price_usd',
};

export const REQUIRED_COLUMNS = Object.keys(COLUMNS).filter(c => c !== 'Bag ID');

// Spreadsheet-computed columns we recompute ourselves.
export const IGNORED_COLUMNS = ['Price per cup (~250ml)'];

// Dose for a ~250 ml cup. Your sheet's price-per-cup column implies 15 g.
export const DOSE_G = 15;

// Earliest plausible date in the log; anything before is a typo.
export const MIN_DATE = '2020-01-01';

export const RANGES = {
  rating: [0, 10],
  funk: [1, 10],
  development: [1, 10],
  altitude_m: [500, 3000], // outside -> warning, not error
  weight_g: [20, 2000], // sample bags can be ~40 g,
  rest_days_warn: 90,
};

// Roast level: lowercase/whitespace-normalized key -> canonical label.
// Decision to confirm: "Light Medium" and "Medium Light" are treated as the same level.
export const ROAST_LEVELS = {
  'light': 'Light',
  'light medium': 'Medium-Light',
  'medium light': 'Medium-Light',
  'medium': 'Medium',
  'medium dark': 'Medium-Dark',
  'dark': 'Dark',
};
export const ROAST_ORDER = ['Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'];

// Process: keep the raw label, but assign a coarse group for charts.
// Order matters — first match wins, so experimental markers beat base process.
const EXPERIMENTAL = /experimental|anaerobic|carbonic|thermal|ferment|coferment|co-ferment|leachate|tropical|infused|yeast|koji/i;
export function processGroup(raw) {
  if (!raw) return null;
  if (EXPERIMENTAL.test(raw)) return 'Experimental';
  if (/honey|pulped natural/i.test(raw)) return 'Honey';
  if (/natural|dry/i.test(raw)) return 'Natural';
  if (/washed|wet/i.test(raw)) return 'Washed';
  return undefined; // unrecognized -> warning
}
export const PROCESS_GROUPS = ['Washed', 'Natural', 'Honey', 'Experimental'];

// Roaster values beginning with "Me" are home roasts ("Me - Roastmasters").
export const HOME_ROAST = /^me\b/i;

// Variety spellings drift between roasters; map them to one name. Keys are lowercase.
export const VARIETY_ALIASES = {
  'ethiopian landrace': 'Ethiopian Landraces',
  'sl-28': 'SL28',
  'sl-34': 'SL34',
  'ruiru11': 'Ruiru 11',
  'and other heirloom varieties': 'Heirloom Varieties',
};
// Values that say "several/unknown" rather than naming a variety. Kept in variety_raw, left out of variety stats.
export const NOT_A_VARIETY = /^(various|blend|field blend|typica varietals)$/i;
export function canonicalVariety(v) {
  if (NOT_A_VARIETY.test(v)) return null;
  return VARIETY_ALIASES[v.toLowerCase()] ?? v;
}
