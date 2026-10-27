// build.js — CSV log -> validated bags.json + facts.json
// Usage: node build.js <input.csv> [--out data/build] [--lenient]
//   default: any error aborts and writes nothing (last good build stays live)
//   --lenient: rows with errors are dropped, everything else is written

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import {
  COLUMNS, REQUIRED_COLUMNS, IGNORED_COLUMNS, DOSE_G, MIN_DATE, RANGES,
  ROAST_LEVELS, ROAST_ORDER, processGroup, PROCESS_GROUPS, HOME_ROAST, canonicalVariety, varietyGroup,
} from './schema.js';
import claims from './claims.js';

// ---------- args ----------
const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--')) ?? 'data/raw/bags.csv';
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'data/build';
const lenient = args.includes('--lenient');

// ---------- issue log ----------
const issues = [];
const report = (level, line, bag, field, msg) => issues.push({ level, line, bag, field, msg });

// ---------- parsers ----------
const clean = v => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' || /^#(DIV\/0!|N\/A|VALUE!|REF!)$/.test(s) ? null : s;
};

const TODAY = new Date().toISOString().slice(0, 10);

function parseDate(s) {
  if (!s) return { value: null };
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d+)$/);
  if (!m) return { error: `unrecognized date format "${s}" (expected M/D/YYYY)` };
  const mo = +m[1], d = +m[2];
  let y = +m[3];
  if (m[3].length === 2) y += 2000;
  else if (m[3].length !== 4) return { error: `year "${m[3]}" in "${s}" is not 2 or 4 digits` };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return { error: `"${s}" is not a real calendar date` };
  const iso = dt.toISOString().slice(0, 10);
  if (iso < MIN_DATE || iso > TODAY) return { error: `"${s}" is outside ${MIN_DATE}..${TODAY}` };
  return { value: iso };
}

function parseNum(s) {
  if (!s) return { value: null };
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? { value: n } : { error: `"${s}" is not a number` };
}

const slug = s => (s ?? '').toLowerCase().normalize('NFKD')
  .replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 40);

const splitList = (s, sep) => s ? s.split(sep).map(x => x.trim()).filter(Boolean) : [];

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const quarter = iso => iso ? `${iso.slice(0, 4)}-Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1}` : null;

// ---------- read & check header ----------
const raw = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const records = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, info: true });

const header = Object.keys(records[0]?.record ?? {});
const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
const unknown = header.filter(c => !(c in COLUMNS) && !IGNORED_COLUMNS.includes(c));
missing.forEach(c => report('error', 1, null, c, 'required column missing from sheet'));
unknown.forEach(c => report('error', 1, null, c, 'unknown column — add it to schema.js COLUMNS or IGNORED_COLUMNS'));

// ---------- rows ----------
const bags = [];
const badLines = new Set();
const seenIds = new Map();
let blankRows = 0;

for (const { record, info } of records) {
  const line = info.lines;
  const r = {};
  for (const [col, key] of Object.entries(COLUMNS)) r[key] = clean(record[col]);

  // Template/blank rows: nothing identifying filled in.
  if (!r.roaster && !r.name && !r.rating && !r.roast_date) { blankRows++; continue; }

  const label = r.name ?? `${r.roaster ?? '?'} (unnamed)`;
  const err = (field, msg) => { report('error', line, label, field, msg); badLines.add(line); };
  const warn = (field, msg) => report('warn', line, label, field, msg);
  const note = (field, msg) => report('info', line, label, field, msg);

  // Dates
  const rd = parseDate(r.roast_date), od = parseDate(r.opened_date);
  if (rd.error) err('roast_date', rd.error);
  if (od.error) err('opened_date', od.error);
  if (!rd.error && !rd.value) err('roast_date', 'missing');
  let rest_days = null;
  if (rd.value && od.value) {
    rest_days = daysBetween(rd.value, od.value);
    if (rest_days < 0) err('opened_date', `opened ${-rest_days} days before roast date`);
    else if (rest_days > RANGES.rest_days_warn) warn('opened_date', `rest of ${rest_days} days — typo?`);
  }

  // Numerics
  const nums = {};
  for (const f of ['rating', 'funk', 'development', 'altitude_m', 'weight_g', 'price_usd']) {
    const p = parseNum(r[f]);
    if (p.error) err(f, p.error);
    nums[f] = p.value ?? null;
  }
  for (const f of ['rating', 'funk', 'development']) {
    const [lo, hi] = RANGES[f];
    if (nums[f] != null && (nums[f] < lo || nums[f] > hi)) err(f, `${nums[f]} outside ${lo}–${hi}`);
  }
  if (nums.rating == null) note('rating', 'unrated — kept, excluded from rating stats');
  if (nums.altitude_m != null) {
    const [lo, hi] = RANGES.altitude_m;
    if (nums.altitude_m < lo || nums.altitude_m > hi) warn('altitude_m', `${nums.altitude_m} m looks implausible`);
  }
  if (nums.weight_g == null) warn('weight_g', 'missing — price per gram/cup unavailable');
  else if (nums.weight_g < RANGES.weight_g[0] || nums.weight_g > RANGES.weight_g[1])
    err('weight_g', `${nums.weight_g} g outside ${RANGES.weight_g.join('–')}`);

  // Price: $0 means gift/unknown, not free coffee — don't let it pull averages down.
  const price_known = nums.price_usd != null && nums.price_usd > 0;
  if (nums.price_usd === 0) note('price_usd', '$0 — treated as gift/unknown, excluded from price stats');
  const price_per_g = price_known && nums.weight_g ? nums.price_usd / nums.weight_g : null;

  // Categories
  let roast_level = null;
  if (r.roast_level) {
    roast_level = ROAST_LEVELS[r.roast_level.toLowerCase().replace(/[\s-]+/g, ' ')];
    if (!roast_level) { warn('roast_level', `"${r.roast_level}" not in vocabulary — add to schema.js`); roast_level = r.roast_level; }
  }
  const process_group = processGroup(r.process);
  if (r.process && process_group === undefined) warn('process', `"${r.process}" doesn't map to a process group`);
  if (!r.name) warn('name', 'missing bag name');

  const home_roast = HOME_ROAST.test(r.roaster ?? '');
  const countries = splitList(r.country, /\s+-\s+|\s*\/\s*/);

  // Harvest is free text; extract a year where one exists, keep the raw text.
  const years = (r.harvest ?? '').match(/(?:19|20)\d{2}/g)
    ?? (r.harvest?.match(/\/(\d{2})$/) ? ['20' + r.harvest.match(/\/(\d{2})$/)[1]] : null);
  const harvest_year = years ? Math.max(...years.map(Number)) : null;

  // ID: use the sheet's Bag ID if present; otherwise derive one (fragile if you edit these fields).
  const bag_id = r.bag_id ?? `${rd.value ?? 'nodate'}-${slug(r.roaster)}-${slug(r.name)}`;
  if (seenIds.has(bag_id)) err('bag_id', `duplicate id "${bag_id}" (also line ${seenIds.get(bag_id)})`);
  seenIds.set(bag_id, line);

  const varieties = [...new Set(splitList(r.variety, /\s*[,&]\s*/).map(canonicalVariety).filter(Boolean))];
  bags.push({
    _line: line,
    bag_id,
    roaster: home_roast ? 'Home roast' : r.roaster,
    roaster_raw: r.roaster,
    home_roast,
    name: r.name,
    countries,
    country_primary: countries.length === 1 ? countries[0] : countries.length ? 'Blend' : null,
    region: r.region, producer: r.producer, farm: r.farm,
    harvest_raw: r.harvest, harvest_year,
    variety_raw: r.variety,
    varieties,
    variety_group: varietyGroup(varieties),

    altitude_m: nums.altitude_m,
    process: r.process, process_group: process_group ?? null,
    roast_level, roast_rank: roast_level ? ROAST_ORDER.indexOf(roast_level) : null,
    funk: nums.funk, development: nums.development,
    rating: nums.rating,
    roast_date: rd.value ?? null, opened_date: od.value ?? null,
    opened_quarter: quarter(od.value), rest_days,
    weight_g: nums.weight_g,
    price_usd: price_known ? nums.price_usd : null, price_known,
    price_per_g: price_per_g && +price_per_g.toFixed(4),
    price_per_cup: price_per_g && +(price_per_g * DOSE_G).toFixed(2),
    roaster_notes: r.roaster_notes, my_notes: r.my_notes,
  });
}

// ---------- stats helpers ----------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function quantile(a, p) { // linear interpolation (R type 7 / pandas default)
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), h = (s.length - 1) * p, lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
}
function ranks(a) { // average ranks for ties
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
}
function spearman(rows, fx, fy) {
  const p = rows.filter(b => b[fx] != null && b[fy] != null);
  return { rho: p.length > 2 ? round(pearson(ranks(p.map(b => b[fx])), ranks(p.map(b => b[fy]))), 3) : null, n: p.length };
}
const round = (x, d = 2) => x == null ? null : +x.toFixed(d);
function summarize(rows) {
  const v = rows.map(b => b.rating).filter(x => x != null);
  return { n: v.length, mean: round(mean(v)), median: round(quantile(v, 0.5)) };
}
function groupBy(rows, key) {
  const g = {};
  for (const b of rows) { const k = b[key]; if (k == null) continue; (g[k] ??= []).push(b); }
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)]));
}

// ---------- assemble ----------
const errors = issues.filter(i => i.level === 'error');
const kept = lenient ? bags.filter(b => !badLines.has(b._line)) : bags;
kept.forEach(b => delete b._line);

// Producer, farm and region are typed by hand, so the same name shows up as "Juan Diego De La Cerda" and
// "Juan Diego de la Cerda", or "Quindio" and "Quindío". Group spellings that differ only in case, spacing
// or accents, and use the most common one (ties: the one with accents, then more capitals).
const nameKey = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const marks = s => (s.normalize('NFD').match(/[\u0300-\u036f]/g) ?? []).length;
const caps = s => (s.match(/[A-Z]/g) ?? []).length;
for (const field of ['producer', 'farm', 'region']) {
  const variants = new Map();
  for (const b of kept) if (b[field]) {
    const k = nameKey(b[field]), v = variants.get(k) ?? new Map();
    v.set(b[field], (v.get(b[field]) ?? 0) + 1); variants.set(k, v);
  }
  for (const b of kept) if (b[field]) {
    const v = variants.get(nameKey(b[field]));
    if (v.size > 1) b[field] = [...v].sort((x, y) => y[1] - x[1] || marks(y[0]) - marks(x[0]) || caps(y[0]) - caps(x[0]))[0][0];
  }
}

const rated = kept.filter(b => b.rating != null);
const ratings = rated.map(b => b.rating);
const funkLow = rated.filter(b => b.funk != null && b.funk <= 6);
const funkHigh = rated.filter(b => b.funk != null && b.funk >= 8);
const opened = kept.map(b => b.opened_date).filter(Boolean).sort();

const facts = {
  generated_at: new Date().toISOString(),
  source: input,
  dose_g: DOSE_G,
  n_bags: kept.length,
  n_rated: rated.length,
  n_roasters: new Set(kept.filter(b => !b.home_roast).map(b => b.roaster)).size,
  n_home_roasts: kept.filter(b => b.home_roast).length,
  n_countries: new Set(kept.flatMap(b => b.countries)).size,
  n_varieties: new Set(kept.flatMap(b => b.varieties)).size,
  first_opened: opened[0] ?? null,
  last_opened: opened.at(-1) ?? null,
  rating: {
    mean: round(mean(ratings)), median: round(quantile(ratings, 0.5)),
    q1: round(quantile(ratings, 0.25)), q3: round(quantile(ratings, 0.75)),
    min: Math.min(...ratings), max: Math.max(...ratings),
  },
  rest_days: { median: quantile(kept.map(b => b.rest_days).filter(x => x != null), 0.5) },
  price_per_cup: { median: round(quantile(kept.map(b => b.price_per_cup).filter(x => x != null), 0.5)) },
  by_process: groupBy(rated, 'process_group'),
  by_country: groupBy(rated, 'country_primary'),
  by_roaster: groupBy(rated, 'roaster'),
  // A bag that lists several varieties can't be credited to any one of them (see varietyGroup in schema.js).
  by_variety: groupBy(rated, 'variety_group'),
  n_repeat_roasters: Object.entries(Object.groupBy(kept.filter(b => !b.home_roast), b => b.roaster)).filter(([, v]) => v.length >= 2).length,
  by_quarter: groupBy(rated, 'opened_quarter'),
  funk_cliff: { low: summarize(funkLow), high: summarize(funkHigh) },
  correlations: {
    price_per_g_vs_rating: spearman(rated, 'price_per_g', 'rating'),
    rest_days_vs_rating: spearman(rated, 'rest_days', 'rating'),
    funk_vs_rating: spearman(rated, 'funk', 'rating'),
    development_vs_rating: spearman(rated, 'development', 'rating'),
    altitude_vs_rating: spearman(rated, 'altitude_m', 'rating'),
  },
};
facts.claims = claims.map(c => {
  let holds; try { holds = !!c.test(facts); } catch { holds = false; }
  return { id: c.id, text: c.text, holds };
});

// ---------- report ----------
const fmt = i => `  line ${String(i.line).padStart(3)}  ${(i.bag ?? '').slice(0, 38).padEnd(38)}  ${i.field}: ${i.msg}`;
const byLevel = l => issues.filter(i => i.level === l);
console.log(`\nRead ${records.length} rows: ${bags.length} bags, ${blankRows} blank template rows skipped`);
if (byLevel('error').length) console.log(`\nERRORS (${byLevel('error').length})\n` + byLevel('error').map(fmt).join('\n'));
if (byLevel('warn').length) console.log(`\nWARNINGS (${byLevel('warn').length})\n` + byLevel('warn').map(fmt).join('\n'));
if (byLevel('info').length) console.log(`\nNOTES (${byLevel('info').length})\n` + byLevel('info').map(fmt).join('\n'));
const broken = facts.claims.filter(c => !c.holds);
console.log(`\nCLAIMS: ${facts.claims.length - broken.length}/${facts.claims.length} hold` +
  (broken.length ? '\n' + broken.map(c => `  ✗ ${c.id}: "${c.text}" — rewrite this section`).join('\n') : ''));

if (errors.length && !lenient) {
  console.log(`\nBuild aborted: fix ${errors.length} error(s) in the sheet, or run with --lenient to drop those rows.\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'bags.json'), JSON.stringify(kept, null, 1));
writeFileSync(join(outDir, 'facts.json'), JSON.stringify(facts, null, 2));
console.log(`\nWrote ${kept.length} bags${lenient && errors.length ? ` (${bags.length - kept.length} dropped)` : ''} -> ${outDir}/bags.json, facts.json\n`);
