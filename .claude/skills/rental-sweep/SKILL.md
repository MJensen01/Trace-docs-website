---
name: rental-sweep
description: Run a rental-listing sweep for Matt & Evelyn's Home Finder — harvest Zillow (and optionally Apartments.com / Facebook Marketplace / the site's pending queue), filter by commute and budget, download photos, and ingest new finds into the site. Use when asked to run a sweep, find new rentals, refresh listings, or triage the pending queue.
---

# Rental sweep

Populate the Home Finder site with new rental listings. The repo contract
(commands, data rules) is in CLAUDE.md; this file is the operating procedure.
Read the criteria fresh each run — never hardcode them:

- **Anchors + budget**: `src/_data/listings.json` → `anchors` (home, work) and
  `budget` (`max`, `stretch_max`).
- **Keep rule (2026-08)**: drive to home **< 30 min** AND drive to work
  **< the current home→work baseline** (compute it via OSRM at the start of the
  run; it was ~56 min). Rent ≤ `budget.stretch_max` unless told otherwise.
- The user may override any of this in the kickoff message — their message wins.

## Phase 0 — Orient

1. `npm install` if `node_modules` is missing; `npm run check` must pass before
   you start (if it doesn't, stop and report).
2. Collect the known-URL set so you never re-add a listing: every `url`,
   `v1_url`, and `v1_urls[]` in `listings.json`, normalized (strip scheme,
   `www.`, query, trailing slash). Also collect existing ids.
3. Check the pending queue first: `npm run ingest -- --pending --dry`. If items
   are waiting, they are the highest-priority candidates.

## Phase 1 — Harvest (browser)

Zillow is the primary source. Per town, load
`https://www.zillow.com/<town-slug>/rentals/` in a browser tab, then from the
page context fetch each page (`2_p/`, `3_p/`, ... — 41 results/page) and parse
the `__NEXT_DATA__` script tag:
`props.pageProps.searchPageState.cat1.searchResults.listResults`
(`searchList.totalResultCount` for paging). Useful fields per result: `zpid` /
`buildingId`, `address`, `price`, `units[]` (`price`+`beds`), `latLong`,
`detailUrl`, `beds`, `baths`, `area`.

Hard-won rules:
- Do NOT hand-build `searchQueryState` filter URLs — they silently return 0
  results or flip to for-sale. Harvest unfiltered and filter locally.
- Prices like "$2,548+" contain commas — extract with a `\$[\d,]+` regex, never
  split on commas.
- Pace requests ~2 s apart; keep any single browser-JS call under ~30 s (longer
  calls can drop the extension). If a CAPTCHA appears, stop and ask the user to
  click it, then resume.
- Getting big data out of the page: tool output truncates — write it into the
  DOM (`document.body.innerHTML = '<pre>' + JSON.stringify(data) + '</pre>'`)
  and read it back with the page-text tool.

Secondary sources when asked (mechanics in CLAUDE.md): Apartments.com,
Facebook Marketplace (needs the user's login + location filter), Craigslist.

Town list: whatever the user asks for; default is the corridor between the two
anchors. Towns already swept on 2026-08-13 (Zillow): New Brunswick, North
Brunswick, Milltown, Monmouth Junction, Dayton, Kendall Park, Plainsboro,
Cranbury, East Windsor, Hightstown, Princeton Junction, Jamesburg, Spotswood —
re-sweeping those is fine (new inventory appears), the URL dedupe protects you.

## Phase 2 — Filter

1. Local price filter: cheapest advertised unit ≤ the cap.
2. Commute filter in bulk with one OSRM table call per anchor:
   `https://router.project-osrm.org/table/v1/driving/<anchorLon,anchorLat>;<lon1,lat1>;...?sources=0`
   (≤ ~90 points per call; every coord must be non-null or the whole call 400s).
3. Apply the keep rule. Drop anything whose normalized URL is already known.
4. Junk filter: skip $1-priced bait, single-room rentals, and for-sale items.

## Phase 3 — Photos

For each finalist, fetch its detail page (in-page fetch is fine) and regex out
`photos.zillowstatic.com/fp/<hash>-cc_ft_<width>.jpg`, dedupe by hash, keep the
widest variant per hash, take up to 8 URLs in page order (hero first). Pass them
as `photos` in the candidate JSON — ingest downloads them (768px variant) and
builds the gallery + thumbnail. Other sites: any direct image URLs work.

## Phase 4 — Ingest

Write one candidates file (array of objects, format documented in the header of
`scripts/ingest.js` — minimum: `town`, `state`, `name` or `address`, `coords`
`[lon, lat]`; include `rent`, `beds`, `baths`, `sqft`, `url`, `photos`, and a
short factual `pros`/`cons` whenever you have them). Then:

```
npm run ingest -- candidates.json --dry    # review the plan
npm run ingest -- candidates.json          # write data + download photos
npm run check                              # must exit 0
npm run build                              # must succeed
```

For pending-queue items use `npm run ingest -- --pending`; only pass
`--pin XXXX` (to auto-resolve queue items) if the user gives you the PIN in the
session — the PIN is a secret, never write it to a file or commit it.

## Phase 5 — Verify and report

1. Serve `_site/` locally and eyeball at least one new listing page: gallery
   renders, both commutes present, band chip sensible.
2. Report to the user: how many candidates scanned / kept / skipped-as-known,
   the standouts (cheapest, closest to home), and anything that needs a human
   (CAPTCHAs hit, listings that look like scams, geocode failures).
3. Commit only when the user says so, and remember: **push deploys to
   production** (trace-docs.com). Suggested message style:
   `Add <n> listings from <date> <area> sweep`.
