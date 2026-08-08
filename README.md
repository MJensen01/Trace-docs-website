# Matt &amp; Evelyn's Home Finder

A private (noindex) rental-search site for our move. Eleventy 3 + Tailwind CSS 4,
deployed to https://trace-docs.com by a Cloudflare Worker on push.

## Pages

| Route | Source | What it is |
| --- | --- | --- |
| `/` | `src/index.njk` | Dashboard: filter chips, sort, card grid |
| `/listing/<id>/` | `src/listing.njk` | One page per listing (Eleventy pagination), with a Leaflet map of both drives |
| `/map/` | `src/map.njk` | Every listing plotted, coloured by budget band |
| `/all/` | `src/all.njk` | The whole database in one sortable table |
| `/add/` | `src/add.njk` | Form for dropping a new find into the queue |

## The live layer

`worker/index.js` puts a small PIN-gated API in front of the static build
(`/api/health`, `/api/pending`, `/api/hidden` to read; `/api/submit`,
`/api/resolve`, `/api/archive`, `/api/unarchive` to write). `src/assets/js/hf.js`
is the browser client, loaded on every page; every call fails quietly, so the
site reads exactly the same when the API is unreachable.

* `/add/` geocodes with Nominatim and times both drives with OSRM in the
  browser, then posts the listing plus its routes.
* Pending submissions appear on the dashboard and the map until the pipeline
  triages them; ones whose URL already exists in `listings.json` are skipped.
* Archiving hides a listing from the dashboard and map and dims its row in the
  database; the listing page carries the banner and the archive/unarchive form.

The PIN lives in the `HF_PIN` secret (`wrangler secret put HF_PIN`). For local
work put `HF_PIN=...` in a `.dev.vars` file (git-ignored) and run
`npm run build && npx wrangler dev`.

## Data

`src/_data/listings.json` and `src/_data/routes.json` are the source of truth and
are written by the listing-search pipeline — don't hand-edit them here.
`src/_data/homes.js` reads both, derives everything the templates need
(display titles, money and commute labels, pros/cons bullets, screenshot paths,
prev/next links, counts) and exposes it as the `homes` global.

Screenshots live in `src/assets/listings/<listing-id>.jpg`. A listing gets a
thumbnail automatically when a file with its id is present; otherwise the detail
page shows a placeholder. The `screenshot` field in `listings.json` is not used
for pathing.

Leaflet 1.9.4 is vendored in `src/assets/vendor/leaflet/` — no CDN at runtime.
Map tiles come from OpenStreetMap.

## Commands

```
npm install
npm run build   # tailwind -> src/css/output.css, then eleventy -> _site/
npm run dev     # watch both, serve on :8080
```
