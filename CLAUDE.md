# Matt & Evelyn's Home Finder

Private (noindex) rental-search site. Eleventy 3 + Tailwind 4 static build with a
PIN-gated Cloudflare Worker API on top, deployed to https://trace-docs.com on
push to `main`. Despite the repo name, this has nothing to do with "Trace Docs".

## Commands

```
npm install
npm run build      # tailwind css -> eleventy -> _site/
npm run dev        # watch + serve on :8080
npm run check      # validate listings.json / routes.json / galleries — run before committing data
npm run ingest -- <candidates.json> [--dry]   # add listings the right way (see below)
npm run ingest -- --pending [--pin XXXX]      # ingest the live pending queue
```

## Search criteria (as of 2026-08-13)

- Anchors live in `listings.json` → `anchors`: home = East Brunswick NJ, work = Fairless Hills PA.
- Keep: **drive to home < 30 min** AND **drive to work < 56 min** (the current home→work baseline).
- Budget: **$1,600 max, $1,900 stretch** (`listings.json` → `budget`; bands derive from it).

## Adding listings — use the ingest script, don't hand-edit

`src/_data/listings.json` and `routes.json` are pipeline-owned. To add finds,
write a **candidate JSON** array and run `npm run ingest -- file.json`. Minimum
per candidate: `town`, `state`, `name` or `address`, and `coords` `[lon, lat]`
(or a geocodable address). Optional: `rent`, `beds`, `baths`, `sqft`, `url`,
`photos` (array of image URLs — downloaded into the gallery), `pros`, `cons`,
`notes`, `kind` (`apartment`|`townhouse`), `tier`. The script derives the band,
fetches OSRM commutes + route geometry, downloads photos, writes the gallery
folder and dashboard thumbnail, and stamps dates. It skips ids/urls that already
exist. Full field docs are in the header of `scripts/ingest.js`.

After ingest: `npm run check && npm run build`, eyeball a listing page, then
commit. Push deploys to production.

## Images

- Dashboard thumbnail: `src/assets/listings/<id>.jpg`
- Gallery: `src/assets/listings/<id>/01.jpg`, `02.jpg`, ... (listing pages show
  a thumbnail strip automatically; first file is the hero, so order matters)
- Keep photos ~768px wide; 8 per listing is the norm.

## Running a sweep

The full operating procedure for finding and ingesting new listings lives in
the **`rental-sweep` skill** (`.claude/skills/rental-sweep/SKILL.md`) — invoke
it when asked to run a sweep, refresh listings, or triage the pending queue.
Source-specific mechanics that outlive any one sweep:

- **Apartments.com**: `article[data-listingid]` cards; first render takes ~5 s.
- **Facebook Marketplace**: needs the user logged in; cards are
  `a[href*="/marketplace/item/"]`; set the location filter first.
- **OSRM public API**: `/table/v1/driving` for bulk drive-time filtering,
  `/route/v1/driving` for per-listing geometry (ingest.js does the latter).

## The live layer

`worker/index.js` (KV: pending/hidden/favorite keys; PIN in the `HF_PIN`
secret). Site pages call it via `src/assets/js/hf.js`, failing quietly offline.
The `/add/` page + `/api/pending` queue feeds `npm run ingest -- --pending`.
