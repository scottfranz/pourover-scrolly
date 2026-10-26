# Coffee bag log — scrollytelling article

Scrollytelling data-viz article built from a personal log of filter-coffee bags
(roaster, origin, process, funk/development scores, rating, price). The log grows
weekly/monthly, so everything must rebuild from the sheet without hand edits.

## Data pipeline (done)

- Source: Google Sheet, pulled to `data/raw/bags.csv` by `npm run fetch` (`fetch.js`)
  - Sheet link lives in `sheet.config.json` (`url`, optional `gid` for the tab), or `$SHEET_URL`
  - Sheet must be "Anyone with the link: Viewer" or Published to web as CSV;
    for a private sheet set `GOOGLE_ACCESS_TOKEN` (e.g. `gcloud auth print-access-token`)
  - Fetch fails safe: HTML sign-in page, wrong tab, or network error keeps the old CSV
- `npm run update` / `npm run update:lenient` — fetch then build in one step
- `npm run build:data` — strict: any error aborts and writes nothing
- `npm run build:data:lenient` — drops rows with errors, writes the rest
- Outputs: `data/build/bags.json` (one tidy record per bag), `data/build/facts.json` (summary stats)
- `schema.js` — column mapping, vocabularies, normalization, ranges. Edit here, not in build.js.
- `claims.js` — directional claims the article makes; build warns if new data breaks one.

## Rules for the article

- Numbers in prose come from `facts.json`, never hardcoded.
- Every directional/shape claim in prose has a test in `claims.js`.
- Chart domains are computed from data; categories with n < 3 lump into "Other".
- Show n alongside group means; many groups are small.

## Known data issues in the current sheet

- Roos Roast bag has no name (warning only).
- Six bags at $0 → treated as gift/unknown price, excluded from price stats.
- Three 40 g bags are sample bags (weight floor set to 20 g).
- Two newest bags (Ginimao S-795, Gachatha) not yet rated.

## Open decisions (confirm with Scott)

- "Light Medium" and "Medium Light" are merged into "Medium-Light".
- Dose for price-per-cup is 15 g (implied by the sheet's old formula).
- No `Bag ID` column yet; IDs are derived from roast date + roaster + name and
  change if those are edited. Adding a Bag ID column to the sheet is recommended.

## Current findings (122 bags, 120 rated, strict build, fetched 2026-10-26)

- Washed 7.71 (n=77) vs Experimental 6.98 (n=21) vs Natural 7.18 (n=17) vs Honey 7.58 (n=5)
- Funk cliff: flat ~7.66 for clean/funk ≤ 6 (n=108), ~4.6 for ≥ 8 (n=6) — threshold, not linear
- Price per gram vs rating: Spearman ρ ≈ 0.34 (n=114) — weak
- Rest days vs rating: ρ ≈ −0.12 — negligible; median rest 14 days
- Ratings compressed: IQR 7.3–8.1; quarterly means rose from ~7.0 (2024-Q3) to ~7.7
  (selection, skill, or rating drift — cannot be separated from these data)

## Article (in progress)

- `index.html` + `story.js` at the project root; D3 7.9.0 from CDN. Scroll progress is computed
  from step positions each frame (Scrollama dropped: its events arrive out of order on fast jumps).
  Reads `data/build/bags.json` and `facts.json`, so serve the folder (`npm run dev`), don't open the file.
- Opening: scroll-scrubbed top view of a gooseneck kettle pouring over a V60
  (approach → bloom → spiral main pour → drawdown) with a brew timer (`facts.dose_g` g coffee, 250 g water).
  The wet bed then morphs into the radar's "average bag" shape.
- Radar: five spokes (rating, clean→funk, development, altitude, price/cup), each from 0 at
  the center to the top of its scale; altitude and price maxima are computed from the data.
  Roast was dropped as a spoke (nearly all Light; nothing past Medium) and lives in the explorer table.
  Max 3 colored series + dashed average (palette validated for 3 overlapping series only).
- Steps: average bag → top 3 complete bags → Washed/Natural/Experimental → funk cliff (≤6 vs ≥8).
- Prose numbers use `data-fact="path.in.facts"`; sentences with `data-claim="<id>"` get flagged
  on the page if that claim stops holding.
- Ends with a "compare any three bags" explorer: origin chips (n < 3 → Other) pick that origin's
  top 3 and swap the dashed reference to the origin's average; table below.
- Bags are labelled "Name (Roaster)", never with a dash between them.
- Explorer bag cards: roaster's notes as chips, plus origin, variety, process, producer and altitude.
  Notes are grouped into flavor families (`FAMILIES` in story.js); chips whose family appears in
  another selected bag are highlighted, and "In common" lists the shared families.
- Pour step labels (e.g. "2:00–3:00 · Drawdown") come from `PHASES`, the same timings as the brew timer.

## Next step

Later scroll steps from the plan: timeline, by country, price vs rating, which could use one dot per bag keyed by `bag_id`.

## Preview and monthly refresh

- Preview artifact: https://claude.ai/artifact/4jvYHi5xbahVVoBZ4qPDLU (private). It serves the page,
  `data/build/*.json`, and a copy of the pipeline under `pipeline/`.
- Routine "Monthly coffee log refresh" (trig_01Q6wz3q6GrNqNJoKwUznwAg) runs on the 1st of each month at 08:37 UTC:
  reads `pipeline/` from the artifact, fetches the sheet, runs the strict build, and republishes the two JSON files.
  It does not republish when the build fails, and it reports any claims that no longer hold.
- If you change build.js, fetch.js, schema.js, claims.js or package files, republish them under `pipeline/` too,
  or the monthly run will keep using the old copies.

## Live site (GitHub Pages)

- `.github/workflows/deploy.yml` runs on the 1st of each month (08:37 UTC), on every push to main,
  and from the Actions tab ("Run workflow"): fetch sheet → strict build → commit `data/` → deploy.
- A failed build deploys nothing; the last good site stays live and GitHub emails the repo owner.
- Sheet link comes from the `SHEET_URL` repository secret; `sheet.config.json` is gitignored.
- The repo is public (Pages on a free plan), so `data/raw/bags.csv` and `bags.json` (including My Notes) are public.
