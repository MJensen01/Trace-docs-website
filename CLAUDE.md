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

- Anchors live in `listings.json` → `anchors`: home = East Brunswick NJ, work = Keystone Trade Center (Fairless Hills PA).
- Keep: **drive to home < 30 min** AND **drive to work < the home→work baseline** (~52 min as of 2026-08-14 — recompute it via OSRM each run).
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

Photos live in the `homefinder-photos` R2 bucket, NOT in git. Keys:
`photos/<id>/01.jpg`..`NN.jpg` (gallery, hero first) and
`photos/<id>/thumb.jpg` (dashboard thumbnail). The Worker serves them from
`/photos/*`. The build trusts `src/_data/photos.json` (the manifest —
maintained by ingest.js; never list a file there that isn't in R2). Keep
photos ~768px wide; 8 per listing is the norm. Uploads: ingest.js does it via
wrangler (this machine is authed) or the PIN-gated `POST /api/photo`.

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

`worker/index.js` (KV: pending/hidden/favorite keys + `data:live`; R2 photos;
PIN in the `HF_PIN` secret). Site pages call it via `src/assets/js/hf.js`,
failing quietly offline. The `/add/` page + `/api/pending` queue feeds
`npm run ingest -- --pending`.

`GET /api/data` is the canonical listings feed: it serves the KV `data:live`
payload if one has been pushed (PIN-gated `POST /api/data`, 7-day TTL), else
the baked `/assets/data/listings.json` from the last deploy. The map reads it —
so a sweep can go live on the map without a rebuild, and the next deploy
naturally supersedes the override.
