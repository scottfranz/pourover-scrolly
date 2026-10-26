// fetch.js — Google Sheet -> data/raw/bags.csv
// Usage: node fetch.js [sheet-url] [--out data/raw/bags.csv]
//   sheet-url defaults to $SHEET_URL, then sheet.config.json { "url": ... }.
//   Accepts the normal edit link (…/edit#gid=123), a "Publish to web" CSV link,
//   or a bare spreadsheet ID. Private sheets: set GOOGLE_ACCESS_TOKEN
//   (e.g. GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)).
// On any failure the existing CSV is left untouched.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { REQUIRED_COLUMNS } from './schema.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : 'data/raw/bags.csv';
const config = existsSync('sheet.config.json') ? JSON.parse(readFileSync('sheet.config.json', 'utf8')) : {};
const source = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1)) ?? process.env.SHEET_URL ?? config.url;

const fail = msg => { console.error(`\nfetch: ${msg}\nKept existing ${out}.\n`); process.exit(1); };
if (!source) fail('no sheet URL — pass one, set SHEET_URL, or add { "url": "…" } to sheet.config.json');

// Edit/share link or bare ID -> CSV export URL for one tab. Published links are already CSV.
function csvUrl(s, gid = config.gid) {
  if (/\/pub(html)?(\?|$)/.test(s)) {
    const u = new URL(s.replace('/pubhtml', '/pub'));
    u.searchParams.set('output', 'csv');
    return u.toString();
  }
  const id = s.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] ?? (/^[\w-]{25,}$/.test(s) ? s : null);
  if (!id) return null;
  const tab = s.match(/[#&?]gid=(\d+)/)?.[1] ?? gid;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${tab != null ? `&gid=${tab}` : ''}`;
}

const url = csvUrl(source);
if (!url) fail(`"${source}" doesn't look like a Google Sheets link or ID`);

const headers = process.env.GOOGLE_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}` } : {};
let res;
try { res = await fetch(url, { headers, redirect: 'follow' }); }
catch (e) { fail(`network error: ${e.cause?.message ?? e.message}`); }

const body = await res.text();
const type = res.headers.get('content-type') ?? '';
// A private sheet doesn't 403 — Google redirects to a sign-in page that returns HTML with 200.
if (!res.ok || type.includes('text/html') || /^\s*<(!doctype|html)/i.test(body))
  fail(`got ${res.status} ${type.split(';')[0] || 'no content-type'} instead of CSV.\n` +
    `  The sheet is probably private. Either share it as "Anyone with the link: Viewer",\n` +
    `  use File > Share > Publish to web > CSV, or set GOOGLE_ACCESS_TOKEN.`);
if (!body.trim()) fail('sheet returned no rows');

// Catch the wrong tab before it overwrites a good CSV. Full validation is build.js's job.
let rows;
try { rows = parse(body, { columns: true, skip_empty_lines: true, relax_column_count: true }); }
catch (e) { fail(`response isn't valid CSV: ${e.message}`); }
const header = Object.keys(rows[0] ?? {});
if (!REQUIRED_COLUMNS.some(c => header.includes(c)))
  fail(`none of the expected columns found — wrong tab? Add "#gid=…" to the URL or "gid" to sheet.config.json.\n  Got: ${header.slice(0, 6).join(', ')}`);

// Write to a temp file then rename, so a half-written CSV never reaches the build.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out + '.tmp', body);
renameSync(out + '.tmp', out);
console.log(`Fetched ${rows.length} rows from the sheet -> ${out}`);
