---
name: rental-sweep
description: Run a rental-listing sweep for Matt & Evelyn's Home Finder — pick a search, harvest its sources (Sulekha / Craigslist / Zillow / Apartments.com / HotPads / Facebook Marketplace / the site's pending queue), filter by commute and budget, download photos, and ingest new finds. Use when asked to run a sweep, find new rentals, refresh listings, or triage the pending queue.
---

# Rental sweep

The site holds several independent searches. Every criterion — anchors, budget, kinds,
bbox, the keep rule — lives in that search's config file. **Read it fresh each run;
never hardcode criteria here or in the candidates you write.** The repo contract
(commands, data rules, coordinate conventions) is in CLAUDE.md.

## Phase 0 — Pick the search, then orient

1. **Pick the search.** `--search solo` (Evelyn's place) unless the user says
   otherwise; `--search couple` is the paused apartment hunt. Everything downstream —
   the ingest flag, the check scope, the pending filter, the towns, the sources — is
   scoped to it.
2. Read `src/_data/searches/<key>.json` and note: `anchors[]` (each with `coords`
   `[lon, lat]` and `maxMin`), `budget.max` / `budget.stretch_max`, `kinds[]` (and any
   `kinds[].checklist`), `facts[]` (which extra fields you can fill and, for `enum`
   facts, the exact allowed `options`), `states`, `bbox`. State the keep rule back to
   the user in one line before harvesting.
3. `npm install` if `node_modules` is missing. `npm run check` must pass before you
   start — if it doesn't, stop and report.
4. Collect the known-URL set so you never re-add a listing: every `url`, `v1_url` and
   `v1_urls[]` in that search's file, normalized (strip scheme, `www.`, query, trailing
   slash). Collect existing ids too (ids are global — a collision with the *other*
   search's listing is also a skip).
5. Check the pending queue first: `npm run ingest -- --search <key> --pending --dry`.
   Waiting items are the highest-priority candidates. (It reads KV through wrangler;
   Cloudflare Access makes a plain `fetch` useless — see CLAUDE.md.)
6. The user's kickoff message overrides anything below. Their message wins.

## The `solo` keep rule (Evelyn's place)

- **≤ 20 min to the niece anchor (575 Allgair Ave, North Brunswick) AND ≤ 20 min to
  work** (Once Upon A Child, 561 US-1 Edison) — both hard, both required. Matt's house
  (East Brunswick, ≤ 30 min) is a **bonus** anchor (`hard: false`): shown on every
  listing like any other anchor, red-flagged when over its `maxMin`, but **not** part
  of the keep rule. Use `anchors[].maxMin` and `anchors[].hard` rather than literals.
- **Rent ≤ `budget.stretch_max`** ($1,400). `budget.max` ($1,200) is the "Ideal" band.
  Banding is rent-only; utilities-included is a separate fact, not a discount.
- **Self-contained places only.** A studio, a basement/in-law unit with its own
  entrance, or a small 1BR. **Skip**: rooms in a shared house, "room only" listings,
  roommate-board posts, anything where the kitchen or bathroom is shared with the
  owner's family.
- **Skip** for-sale listings and $1 / "contact for price" bait (see triage, below).
- Market reality (as of the 2026-09-02 sweep — 11 keepers out of ~2,000 rows scanned
  across all sources): **$1,400 is the studio floor** in this corridor; basements in
  the **$1,000–1,250** range are the sweet spot; **anything ≤ $900 here is scam-by-default**
  (see the Facebook lead-farm signature above). Expect thin results, and expect to
  re-sweep often rather than to find a big batch once.

For `--search couple`: same phases, criteria straight out of `searches/couple.json`
(home ≤ 30 min, work = Keystone Trade Center ≤ the home→work OSRM baseline, ~52 min —
recompute it at the start of the run; rent ≤ $1,900; kinds apartment/townhouse). Its
primary source is Zillow town `/rentals/` pages, per Phase 1.

## Phase 1 — Harvest (browser)

Towns for `solo` (verify by **drive time**, never by town name — the town list is a
starting point, the OSRM table call is the filter): North Brunswick, New Brunswick,
East Brunswick, Milltown, Highland Park, Edison (incl. Iselin), Piscataway,
Somerset/Franklin, South Brunswick, Metuchen, South Plainfield, Sayreville, South
River, Old Bridge.

Source playbook, ranked by yield for `solo`:

1. **Sulekha** — best basement source for this geography, no login, plain
   server-rendered HTML, no anti-bot seen. `.../rentals_basement-apartment_in_<town>-nj`
   and `.../rentals_apartment_in_<town>-nj` are the town paths, but **the basement
   category ignores the town slug — every town URL returns the same statewide set** —
   fetch it **once**, not per town (some slugs, e.g. `south-brunswick-nj`, 404 outright).
   Price is `.pri-money`; "Contact for price" is common — flag/skip, don't guess. Photo
   src is the `data-imgsrc` attribute, and the gallery only renders client-side, so
   photos need the browser. **Lat/lon lives in a hidden `hdnrentresppopup<id>` element,
   pipe-delimited** — parse it instead of geocoding the town. Listing URLs are
   `<slug>_rentals_<town>-nj_<numeric-id>` — the numeric id is the dedupe key.
2. **Craigslist** — highest raw volume, but **browser only** — a plain fetch returns an
   empty client-rendered shell. The legacy `cnj.craigslist.org/search/apa?...` 301s to
   `https://www.craigslist.org/search/city/<town>-nj?cat=apa&sort=date...` — hit that
   target directly. Cards are `div.cl-search-result`; inside, `a.posting-title`
   (title+link), `.priceinfo` (price), `.result-location` (neighborhood),
   `.housing-meta` (beds/sqft). **`hub=studio-apartment` and `min/max_bedrooms=0` are
   silently dropped** (same result count either way) — filter studios/1BR locally from
   `.housing-meta`. `query=basement` filters, but mostly pulls Newark/Jersey
   City/NYC-metro cross-posts here. `cat=sub` is dominated by NYC/Brooklyn noise.
   Highest scam density of any source — see the flags below.
3. **Zillow** — cleanest structured data. `zillow.com/<town-slug>/studio-apartments/`
   for studios, `/<town-slug>/rentals/` for everything. Parse `__NEXT_DATA__` →
   `props.pageProps.searchPageState.cat1.searchResults.listResults` (41/page, pages
   `2_p/`, `3_p/`…). Fields: `zpid`, `address`, `price`, `units[]`, `latLong`,
   `detailUrl`, `beds`, `baths`, `area`. No basement filter exists; never hand-build
   `searchQueryState` URLs (silently 0 results or flips to for-sale). **Traps**: 55+/62+
   senior buildings (e.g. AHEPA) clear every filter but Evelyn isn't eligible; buildings
   near Rutgers often price **per bed**, so a cheap studio-shaped card can be one bed of
   a shared suite — check `units[]` against the floorplan before trusting a low price.
4. **Apartments.com** — reliable studio/1BR inventory. Cards are
   `article[data-listingid]`; first render takes ~5 s. `/<town>-nj/studios/` and
   `/<town>-nj/under-1500/` work. **`/<town>-nj/basement/` is a dead end** — confirmed
   across 13 towns, it's an amenity filter, not basement-unit inventory (whole houses
   at $2,800+, zero relevant cards). Radius expands aggressively — re-check every
   card's coordinates, never trust the URL's town slug.
5. **HotPads** — `hotpads.com/<town>-nj/studio-apartments-for-rent`. Best lat/lon +
   photo source: the Zillow-family `__next_f` flight payload carries `geo.lat/lon` and
   a `photos` block with no detail-page fetch needed. Shares inventory with Zillow —
   dedupe by address across the two.
6. **Facebook** — real informal basement/studio volume, needs the user's logged-in
   browser, ~15–20 min per run. Two passes: **global post search**
   (`facebook.com/search/posts/?q=<type> for rent <town> NJ` — each query's *entire*
   result set is 5–7 posts, so more queries beats more scrolling) and **in-group
   search** (`facebook.com/groups/<id>/search/?q=<term>` on named public groups — works
   **without joining**). **Classify from the post body text only, never the title or
   bed count** — FB's auto-generated title/bed-count is routinely wrong (a shared-house
   room shows up titled "1 Bed 1 Bath - Apartment"). Keep-words: "private"/"separate
   entrance", "walkout basement", "own kitchen", "kitchenette". Kill-words: "cuarto",
   "habitación", "room for rent", "shared kitchen"/"shared bathroom", "take over the
   second bedroom". **Lead-farm signature** (one is a soft flag, three is a scam — skip,
   don't ingest): address with no house number ("Livingston Ave #1"); deposit far below
   the NJ norm ($300–400 on an $800–1,200 unit vs. the usual 1–1.5 months); rent 40–60%
   under market; "text me a screenshot of this post" / DM-only contact; phone area code
   outside NJ (legit: 732/848/908/609/201/862/973). Photo URLs (fbcdn) are **signed and
   expire within days** — ingest same-day. Post dates don't render in the search
   results (scrambled/empty anchor) — open `facebook.com/photo/?fbid=<first photo id>`
   for author + date. **URL dedupe**: the normalizer keeps `fbid`/`story_fbid`/`id`/
   `set` query params (fixed 2026-09-02) so distinct posts don't collapse together.
7. **Rutgers off-campus board** — `offcampushousing.rutgers.edu/listing` (public, no
   NetID; dismiss the disclaimer modal). Whole result set is a JS global,
   `window.listingData`, keyed by id — one navigate + one JS read gets every row with
   exact address and `[lon,lat]`. Low yield: most rows are per-bed/per-room
   (`rent_style: "person"`, or a `floorplans[].title` of "Room For Rent!" under
   `category_title: "House"`) — check those before trusting a low `min_rent`. ~30 s to
   check; keep it in the loop, don't expect hits.
8. **Facebook Marketplace** — manual, low yield. Auth-gated
   (`facebook.com/marketplace/<location-id>/propertyrentals/?maxPrice=...`); the whole
   category for this radius is ~24 listings and confirming self-containment means
   opening each one — a spot-check, not a scripted pass.

## Not yet swept — try next

- **NJ Housing Resource Center** (`myhousingsearch.com`) — free, state-run registry;
  attracts small landlords who skip Zillow/Apartments.com fees. Parameterized search
  exists (`SearchHousingSubmit.html`, price/radius/bedroom params) but isn't wired in.
- **newjerseyindian.com** classifieds (basement/roommate section) — same Edison/Iselin
  Desi-landlord audience as Sulekha, likely overlapping, unconfirmed.
- **Zumper** (`zumper.com/apartments-for-rent/<town>-nj`) — Zillow-adjacent inventory
  with its own alerts; not yet scraped for this project.
- **Alerts pipeline** — native saved-search alerts plus Google Alerts on boolean
  queries, landing in one Gmail label to feed the pending queue between sweeps.
  Sketched, not built — the only fix for Craigslist/Sulekha having no native alerts.

Hard-won browser rules (all sources):

- Prices like "$2,548+" contain commas — extract with a `\$[\d,]+` regex, never split
  on commas.
- Pace requests ~2 s apart; keep any single browser-JS call under ~30 s (longer calls
  can drop the extension). If a CAPTCHA appears, stop and ask the user to click it,
  then resume.
- Getting big data out of the page: tool output truncates — write it into the DOM
  (`document.body.innerHTML = '<pre>' + JSON.stringify(data) + '</pre>'`) and read it
  back with the page-text tool.

## Phase 2 — Filter

1. Local price filter: cheapest advertised unit ≤ `budget.stretch_max`.
2. Commute filter in bulk, one OSRM table call **per anchor**:
   `https://router.project-osrm.org/table/v1/driving/<anchorLon,anchorLat>;<lon1,lat1>;...?sources=0`
   (≤ ~90 points per call; every coord must be non-null or the whole call 400s).
   Remember `coords` are `[lon, lat]`.
3. Apply the keep rule — a listing must clear the `maxMin` of every anchor with
   `hard !== false` (for `solo`, that's niece and work; Matt's house is a bonus and is
   not part of the filter).
4. Drop anything whose normalized URL is already known, or whose id already exists in
   any search.
5. Junk filter: $1-priced bait, for-sale items, and — for `solo` — single-room and
   shared-house rentals.

## Phase 3 — Photos

For each finalist, fetch its detail page (in-page fetch is fine) and pull the image
URLs. Zillow: regex `photos.zillowstatic.com/fp/<hash>-cc_ft_<width>.jpg`, dedupe by
hash, keep the widest variant per hash, take up to 8 in page order (hero first). Other
sites: any direct image URLs work. Pass them as `photos` in the candidate JSON —
ingest downloads them, uploads to R2 (`photos/<id>/`) and updates the global
`src/_data/photos.json`. On a machine without wrangler auth, add `--pin XXXX` so
uploads go through `POST /api/photo`.

## Phase 4 — Candidates and ingest

One candidates file, an array of objects (full field docs in the header of
`scripts/ingest.js`). Ingest requires `name` **or** `address` — a candidate with no
street address (common on Facebook and some Sulekha/Craigslist posts) must still carry
a `name`, or it's rejected. When coords come from a town centroid rather than a real
address, say so in `notes` (e.g. "location approximate — no street address given").

A `solo` candidate:

```jsonc
{
  "kind": "basement",                 // studio | basement | 1br — sets the id prefix
  "name": "Finished basement w/ private entrance",
  "address": "12 Oak Tree Rd", "town": "Iselin", "state": "NJ",
  "rent": 1250, "beds": 1, "baths": 1, "sqft": 500,
  "coords": [-74.3245, 40.5748],      // [lon, lat] — NOT [lat, lon]
  "url": "https://indianroommates.sulekha.com/...",
  "photos": ["https://...jpg"],
  "pros": "Private entrance, near Metropark", "cons": "Utilities extra",
  "notes": "Posted 2 days ago; asked about C.O., waiting on reply",

  // facts declared in searches/solo.json — bools are tri-state, omit if unknown
  "utilities_included": false,
  "furnished": true,
  "private_entrance": true,
  "legal_unit": null,                 // null/omitted = "Unknown" — do NOT guess
  "lease_flex": "Month-to-month OK",
  "deposit": "1.5 months",
  "source": "Sulekha"                 // enum — exactly one of: Craigslist, Facebook,
                                      // Zillow, Apartments.com, HotPads, Sulekha,
                                      // Rutgers, Word of mouth, Other
}
```

Then:

```
npm run ingest -- --search solo candidates.json --dry    # review the plan
npm run ingest -- --search solo candidates.json          # write data + download photos
npm run check                                            # must exit 0
npm run build                                            # must succeed
```

Add `--push-live` to the real ingest to put the new feed on the live map immediately
(KV `data:live:solo`, 7-day TTL) without waiting for a deploy. For queue items use
`npm run ingest -- --search solo --pending`; it reads and resolves KV via wrangler. Only
pass `--via-api --pin XXXX` if the machine isn't wrangler-authed and the user gives you
the PIN in session — the PIN is a secret, never write it to a file or commit it.

## Triage before ingesting a basement lead

Basements are the highest-yield *and* highest-risk category for `solo`. Per lead:

- **Certificate of Occupancy** — in NJ a basement apartment is only a legal rental with
  a C.O. covering that use. No C.O. ⇒ the lease is unenforceable *for the landlord*, but
  Evelyn can still be evicted and has essentially no footing on habitability or deposit
  disputes. Set `legal_unit` only when it's actually stated; leave it null otherwise, and
  put the open question in `notes`.
- **Second egress** — a legal unit needs a second way out (egress window or door)
  besides the main stairs. Low ceilings, tiny windows and no second exit are the usual
  tells.
- **Private entrance** — advertised often, so record it; absent + no egress + no legal
  status mentioned = flag it for the user rather than quietly ingesting.
- **Cash only / no written lease** — red flag. Often means the landlord wants no paper
  trail on an unregistered unit.
- **"Contact for price"** — common Sulekha/Craigslist bait to force a call, then quote
  higher. Ingest with `rent: null` (it bands as "Rent unknown") only if the listing is
  otherwise strong; otherwise skip.
- NJ requires non-owner-occupied 1–2 unit rentals to be registered with the municipal
  clerk — a landlord who balks at any registration/inspection question is a soft flag.

`kinds[].checklist` in `searches/solo.json` is the same list rendered on the site for
Evelyn; keep the two in sync if you change either.

## Scam flags — skip or flag, never ingest silently

Payment (wire / Western Union / Zelle / Venmo / gift card / crypto) requested before an
in-person or live-video viewing; "landlord is overseas and can't show it"; pressure to
move off-platform; an upfront "registration" or "booking" fee; a near-exact text/photo
duplicate of a listing already in the dataset (or of a Zillow listing at a lower price);
staged photos that don't match the described unit. Report these to the user rather than
adding them.

## Phase 5 — Verify and report

1. Serve `_site/` locally and eyeball at least one new listing page: gallery renders,
   **every** anchor's commute is present, band chip sensible, extra facts show up.
   Check the right page — `solo` lives at `/`, `couple` at `/apartments/`.
2. Report: how many candidates scanned / kept / skipped-as-known, per source; the
   standouts (cheapest, closest); and anything needing a human (CAPTCHAs hit, likely
   scams, "contact for price" leads worth a phone call, geocode failures, basements
   with unknown legal status).
3. Commit only when Matt says so, and remember: **push deploys to production**
   (trace-docs.com). Message style: `Add <n> solo listings from <date> <area> sweep`.
