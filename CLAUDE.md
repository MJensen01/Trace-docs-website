# Matt & Evelyn's Home Finder

Private rental-search site. Eleventy 3 + Tailwind 4 static build with a Cloudflare
Worker API on top, deployed to https://trace-docs.com on push to `main`. Despite the
repo name, this has nothing to do with "Trace Docs".

The site holds **N independent searches** sharing one codebase, one Worker, one photo
bucket and one pipeline. Today N = 2:

| key | who | owns | status |
|---|---|---|---|
| `solo` | Evelyn's place — a studio/basement/1BR for her on her own | `/`, `/list/`, `/all/`, `/add/` | **primary, active** |
| `couple` | the joint apartment hunt (107 listings) | `/apartments/…` | paused, still editable |

`/listing/<id>/` is one flat namespace across searches — ids are globally unique, so
no listing URL ever moves. Adding a third search is a new `searches/<key>.json` with a
new `basePath` and new kind prefixes; no code change.

## Access control

The whole `trace-docs.com` hostname is behind **Cloudflare Access** (Zero Trust org
`mjensen1.cloudflareaccess.com`, email one-time-PIN login, allow-list of Matt + Evelyn
only, 30-day sessions). Anything unauthenticated — `/api/*` and `/photos/*` included —
gets a 302 to the login page before reaching the Worker. `scripts/access-setup.js`
re-applies the config idempotently; it needs a `CF_API_TOKEN` with the *Access: Apps
and Policies* and *Access: Organizations, IdPs & Groups* edit scopes (the wrangler
login does not have them). **Consequence for tooling: a plain Node `fetch()` against
the live API gets a login redirect, not JSON** — scripts go through wrangler instead.

## Commands

```
npm install
npm run build                                     # tailwind css -> eleventy -> _site/
npm run dev                                       # watch + serve on :8080
npm run check [-- --search <key>]                 # validate searches/routes/galleries — run before committing data
npm run ingest -- --search <key> <file.json> [--dry]   # add listings the right way (see below)
npm run ingest -- --search <key> --pending [--dry]     # ingest that search's live pending queue (via wrangler KV)
npm run ingest -- --search <key> <file.json> --push-live  # also push the new feed to KV, live without a rebuild
```

`--search <key>` is **required** on ingest — no default. `npm run check` with no flags
validates every search; `--search` scopes the per-listing checks, but the cross-search
invariants (global id uniqueness, prefix disjointness, photo/route mapping) always run.
Both honour `HF_DATA_DIR` (and check.js `--data <dir>`) for a scratch data copy.

## The search files

```
src/_data/
  searches/<key>.json   config + that search's listings   (pipeline-owned)
  routes/<key>.json     { "<listing-id>": { "<anchorKey>": { min, miles, geometry } } }
  photos.json           GLOBAL manifest, keyed by listing id
  homes.js              derives { searches, byKey, primary, listingPages } for the templates
```

A search file carries: `key` (== filename stem), `label`/`shortLabel`/`blurb`,
`basePath`, `order`, `primary` (exactly one site-wide), ordered `anchors` (`key`,
`label`, `short`, `query`, `coords`, `glyph`, `color`, `maxMin`), `budget` (`max`,
`stretch_max`), `bandLabels`, ordered `kinds` (`key`, `label`, `short`, `prefix`,
optional `checklist`), `facts` (extra per-listing fields — `bool`/`text`/`enum`/
`number` with `chip`/`column`/`form` flags), `states`, `bbox`, `listings`. Band **keys**
are fixed site-wide (`in-budget`/`stretch`/`over`/`unknown`) so the CSS and marker
colours keep working; only thresholds and labels are per search, and banding is on
**rent only**. `bool` facts are tri-state — `true`/`false`/absent = unknown; a filter
chip matches only `true`.

**Listing ids are globally unique**, prefixed by kind — this is what keeps one flat
`/listing/<id>/` space, one un-namespaced R2 prefix, and un-namespaced `hidden:`/`fav:`
KV keys:

| search | kind | prefix |
|---|---|---|
| `solo` | studio / basement / 1br | `stu` / `bsm` / `one` |
| `couple` | apartment / townhouse | `apa` / `tow` |

**Three coordinate conventions coexist and all three are load-bearing** — do not
"tidy" any of them: listing and anchor `coords` are **[lon, lat]**; route `geometry`
is **[lat, lon]**; a pending KV record's `coords` is **[lat, lon]** (written by the
browser geocode in `add.njk`, flipped back by ingest.js's `fromPending`). `check.js`
has a swap detector; keep it happy. A listing's `commutes` is keyed by anchor key
(`commutes.home.min`/`.miles`/`.method`) with every anchor of its search present;
`routes/<key>.json` uses the same leg keys.

`scripts/migrate-to-searches.js` is a one-shot from the 2026-09-02 migration off the
old flat `listings.json`/`routes.json` — kept for review only; don't run it again.

## Current criteria

**`solo` — Evelyn's place** (as of 2026-09-02, `searches/solo.json`)
- Anchors: home = Matt's house, East Brunswick NJ; work = Once Upon A Child, 561 US-1,
  Edison NJ.
- Keep: **≤ 20 min free-flow drive to *each* anchor** (`anchors[].maxMin`).
- Budget: **$1,200 "Ideal", $1,400 cap**, rent only — utilities are a separate fact.
- Kinds: studio, basement/in-law, 1BR. **Self-contained places only** — no rooms in a
  shared house, no shared-room listings.

**`couple` — the apartment hunt** (paused, unchanged, `searches/couple.json`)
- home = East Brunswick NJ (≤ 30 min); work = Keystone Trade Center, Fairless Hills PA
  (≤ 52 min, the home→work baseline — recompute via OSRM if you resume it).
- Budget: $1,600 max, $1,900 stretch. Kinds: apartment, townhouse.

Always read these from the search file at run time — never hardcode them in code, a
template, or a sweep.

## Adding listings — use the ingest script, don't hand-edit

`src/_data/searches/*.json` and `routes/*.json` are pipeline-owned. Write a
**candidate JSON** array and run `npm run ingest -- --search <key> file.json`. Minimum
per candidate: `town`, `state`, `name` or `address`, and `coords` `[lon, lat]` (or a
geocodable address). Also worth setting: `kind` (one of the search's kinds; defaults to
`kinds[0]`, unknown kind = skipped), `rent`, `beds`, `baths`, `sqft`, `url`, `photos`
(image URLs — downloaded into the gallery), `pros`, `cons`, `notes`, `tier`, plus any
key declared in that search's `facts[]`. The script derives the id prefix and band,
fetches OSRM commutes + geometry per anchor, downloads photos, writes the gallery and
thumbnail, and stamps that search's `updated` (never another's). It skips ids already
used by *any* search and urls already tracked in *this* search. Full field docs are in
the header of `scripts/ingest.js`.

After ingest: `npm run check && npm run build`, eyeball a listing page, then commit.
Push deploys to production.

## Images

Photos live in the `homefinder-photos` R2 bucket, NOT in git, and are **not**
namespaced by search. Keys: `photos/<id>/01.jpg`..`NN.jpg` (gallery, hero first) and
`photos/<id>/thumb.jpg` (thumbnail); the Worker serves them from `/photos/*`. The build
trusts `src/_data/photos.json` (global manifest, maintained by ingest.js — never list a
file there that isn't in R2). Keep photos ~768px wide; 8 per listing is the norm.
Uploads go via wrangler (this machine is authed) or PIN-gated `POST /api/photo`.

## Running a sweep

The operating procedure lives in the **`rental-sweep` skill**
(`.claude/skills/rental-sweep/SKILL.md`) — invoke it when asked to run a sweep, refresh
listings, or triage the pending queue. It picks a search first and reads that search's
config. Source-specific mechanics that outlive any one sweep:

- **Zillow**: parse the `__NEXT_DATA__` script tag; town rentals at
  `/<town-slug>/rentals/`, studios at `/<town-slug>/studio-apartments/`. Never
  hand-build `searchQueryState` filter URLs.
- **Sulekha** (best basement source for the Edison/Iselin area, no login, plain HTML):
  `indianroommates.sulekha.com/rentals_basement-apartment_in_<town>-nj` and
  `.../rentals_apartment_in_<town>-nj`. Sort-only pricing — filter locally.
- **Craigslist**: `craigslist.org/search/city/<town>-nj?cat=apa&sort=date`, studios via
  `hub=studio-apartment`; `max_price` does not reliably compose with `hub` — verify or
  filter locally. Basements are text-only ("basement" in the title/body).
- **Apartments.com**: `article[data-listingid]` cards; first render takes ~5 s. Path
  segments `/<town>-nj/studios/`, `/cheap/`, `/under-1500/`.
- **Facebook Marketplace**: needs the user logged in; cards are
  `a[href*="/marketplace/item/"]`; filters are SPA state, not URL params.
- **OSRM public API**: `/table/v1/driving` for bulk drive-time filtering,
  `/route/v1/driving` for per-listing geometry (ingest.js does the latter).

## The live layer

`worker/index.js` — KV `HOMEFINDER_QUEUE` (`pending:<id>`, `hidden:<listing-id>`,
`fav:<listing-id>:<who>`, `data:live:<search>`), R2 photos, PIN in the `HF_PIN` secret.
Site pages call it via `src/assets/js/hf.js`, failing quietly offline. Every
search-aware endpoint takes `?search=<key>`; missing/invalid falls back to `couple`
(the pre-multi-search default), so old clients keep working.

- `GET /api/data?search=<key>` — the canonical feed: KV `data:live:<key>` if one has
  been pushed (PIN-gated `POST /api/data`, 7-day TTL, or ingest's `--push-live`), else
  the baked `/assets/data/<key>.json` from the last deploy. A sweep can go live on the
  map without a rebuild; the next deploy supersedes it.
- `GET /api/pending?search=<key>` — the `/add/` queue. Items carry `search`, `kind` and
  `extras` (declared fact values); legacy items with no `search` read as `couple`.
- Access blocks Node `fetch`, so `ingest --pending` reads and deletes KV through
  `npx wrangler kv key list|get|delete --namespace-id <id from wrangler.json> --remote`.
  `--via-api --pin` is the fallback for an unauthed machine, and only works where
  Access isn't in the way.
