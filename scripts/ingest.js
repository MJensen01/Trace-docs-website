#!/usr/bin/env node
/**
 * ingest.js — turn candidate listings into full search entries in one command.
 *
 *   node scripts/ingest.js --search <key> candidates.json          # ingest a candidate file
 *   node scripts/ingest.js --search <key> candidates.json --dry    # validate + plan, write nothing
 *   node scripts/ingest.js --search <key> --pending                # pull that search's live pending queue
 *   node scripts/ingest.js --search <key> --pending --dry          # list the queue, write/delete nothing
 *   node scripts/ingest.js --search <key> --pending --via-api --pin 1234   # fallback path, see below
 *
 * `--search <key>` is REQUIRED — it selects which `src/_data/searches/<key>.json`
 * (anchors, budget, kinds, extra `facts`) and `src/_data/routes/<key>.json` the
 * candidates are ingested into. Missing or unknown ⇒ exit 2, listing the keys
 * found under `src/_data/searches/`. There is no default: writing a room into
 * the wrong search's file is annoying to undo.
 *
 * A candidate is a plain object; only `town`, `state`, and one of
 * `name`/`address` are required, plus either `coords` ([lon, lat]) or a
 * geocodable address. Everything else is optional:
 *
 *   {
 *     "id":      "stu-my-place",            // derived from name/address if omitted
 *     "kind":    "studio",                  // must be one of the search's `kinds`;
 *                                            // default = kinds[0].key; unknown kind = skipped
 *     "name":    "My Place",
 *     "address": "1 Main St",
 *     "town":    "Milltown", "state": "NJ",
 *     "rent":    1500, "beds": 1, "baths": 1, "sqft": 700,
 *     "coords":  [-74.44, 40.45],           // [lon, lat]
 *     "url":     "https://...",
 *     "photos":  ["https://...jpg", ...],   // downloaded into the gallery (max 8)
 *     "pros":    "...", "cons": "...", "notes": "...",
 *     "tier":    2, "available": "Now", "lease": null, "move_in_cost": null,
 *
 *     // plus any key declared in the search's `facts[]` (see searches/<key>.json).
 *     // bool facts are tri-state: true/false/explicit null all set the field;
 *     // omitting the key entirely also reads as "unknown". enum facts must
 *     // match one of the fact's `options` or the value is dropped with a
 *     // warning (the listing still ingests, just without that field).
 *     "utilities_included": true, "furnished": false, "source": "Craigslist"
 *   }
 *
 * The script fills in the rest: budget band from rent (per the search's
 * `budget`), OSRM drive times + route geometry for every one of the search's
 * `anchors`, photo uploads to R2 (+ the global photos.json manifest and
 * thumbnail), the search's own listings/routes file appends, and its own
 * `updated` stamp (never another search's). Candidates whose url is already
 * tracked *in this search* are skipped; candidates whose id is already used
 * *by any search* are skipped — listing ids are global (see CLAUDE.md /
 * plan-multisearch.md §1.2). Photo uploads use wrangler when this machine is
 * authed; otherwise pass --pin to fall back to the site's /api/photo endpoint.
 *
 * --- Reading the pending queue --------------------------------------------
 * The whole site is behind Cloudflare Access, so a plain `fetch()` from Node
 * against /api/pending gets a login redirect instead of JSON. The default
 * (and only real) path is therefore to read Workers KV directly with
 * wrangler, which this machine is already OAuth-authed for:
 *
 *   npx wrangler kv key list   --namespace-id <id> --prefix "pending:" --remote
 *   npx wrangler kv key get    "pending:<id>" --namespace-id <id> --remote
 *   npx wrangler kv key delete "pending:<id>" --namespace-id <id> --remote
 *
 * The namespace id is read from wrangler.json at runtime, never hardcoded.
 * Items are filtered by their stored `search` field (missing ⇒ "couple", the
 * pre-multi-search default). Items also carry `kind` and `extras: { <factKey>:
 * value }` (both optional — `fromPending` falls back to the search's first
 * kind and skips `extras` entirely for items queued before the Worker started
 * sending them). After a successful *non-dry* ingest, resolved items are
 * deleted from KV the same way (replaces POST /api/resolve).
 *
 * `--via-api` switches to the old HTTP path (`GET /api/pending` to read,
 * `POST /api/resolve` with `--pin` to resolve) for a machine that isn't
 * wrangler-authed. It will NOT work while the site sits behind Cloudflare
 * Access unless a service token is configured for that machine — it exists
 * only as a fallback, not the default.
 *
 * --- Env ---------------------------------------------------------------
 * HF_DATA_DIR — override the `src/_data` root (default:
 * `<repo>/src/_data`). Points the whole script (searches/, routes/,
 * photos.json) at a different directory, e.g. a scratch copy for a dry run
 * against a throwaway dataset without touching the real files.
 *
 * --- Flags ---------------------------------------------------------------
 *   --search <key>   required; selects the search to ingest into / read the
 *                    pending queue for.
 *   --dry            plan only — no writes, no KV deletes, no uploads.
 *   --pending        ingest from the live pending queue instead of a file.
 *   --via-api        use the PIN-gated HTTP fallback instead of wrangler
 *                    (pending read/resolve only — see above).
 *   --pin <pin>      required by --via-api, and by photo uploads when the
 *                    wrangler r2 upload fails and a machine isn't authed.
 *   --push-live      after a successful non-dry ingest, build this search's
 *                    feed via homes.js and push it to KV `data:live:<key>`
 *                    (same 7-day TTL as POST /api/data). If homes.js throws
 *                    (e.g. a sibling task is mid-rewrite on it), this prints
 *                    a warning and the ingest itself still counts as a
 *                    success — it's a nice-to-have, not load-bearing.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DATA = process.env.HF_DATA_DIR ? path.resolve(process.env.HF_DATA_DIR) : path.join(ROOT, "src", "_data");
const BUCKET = "homefinder-photos";
const SITE = "https://trace-docs.com";
const OSRM = "https://router.project-osrm.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_PHOTOS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  return new Date().toISOString().slice(0, 10);
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normUrl(value) {
  if (!value || typeof value !== "string") return null;
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("#")[0]
      .split("?")[0]
      .replace(/\/+$/, "") || null
  );
}

function band(rent, budget) {
  if (rent === null || rent === undefined) return "unknown";
  if (rent <= budget.max) return "in-budget";
  if (rent <= budget.stretch_max) return "stretch";
  return "over";
}

async function osrmRoute(from, to) {
  const url = `${OSRM}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=simplified&geometries=geojson`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  const json = await res.json();
  if (!json.routes || !json.routes[0]) throw new Error(`OSRM: ${json.code || res.status}`);
  const route = json.routes[0];
  let coords = route.geometry.coordinates; // [lon, lat]
  if (coords.length > 32) {
    const step = (coords.length - 1) / 31;
    coords = Array.from({ length: 32 }, (_, i) => coords[Math.round(i * step)]);
  }
  return {
    min: Math.round(route.duration / 60),
    miles: Math.round((route.distance / 1609.34) * 10) / 10,
    geometry: coords.map(([lon, lat]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
    ]),
  };
}

/**
 * Resolve one anchor's leg for a candidate. Reuses a cached leg when the
 * candidate already carries one (typically a pending item that /add/ already
 * ran through OSRM): a `routes[anchorKey]` with geometry is reused whole
 * (no OSRM call at all); a `commutes[anchorKey]` with just min/miles (but no
 * cached geometry) has its numbers trusted while OSRM is still called once
 * to fill in the geometry the routes file needs. Otherwise both min/miles
 * and geometry come from a fresh OSRM call.
 */
async function resolveLeg(candidate, anchor, coords) {
  const cachedRoute = candidate.routes && candidate.routes[anchor.key];
  if (cachedRoute && Array.isArray(cachedRoute.geometry) && cachedRoute.geometry.length) {
    return {
      min: Math.round(cachedRoute.min),
      miles: cachedRoute.miles,
      geometry: cachedRoute.geometry,
    };
  }
  const fetched = await osrmRoute(coords, anchor.coords);
  await sleep(1200);
  const cachedCommute = candidate.commutes && candidate.commutes[anchor.key];
  if (cachedCommute && typeof cachedCommute.min === "number" && typeof cachedCommute.miles === "number") {
    return { min: Math.round(cachedCommute.min), miles: cachedCommute.miles, geometry: fetched.geometry };
  }
  return fetched;
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "user-agent": "home-finder-ingest/1.0" } });
  const json = await res.json();
  if (!json[0]) return null;
  return [Number(json[0].lon), Number(json[0].lat)];
}

/**
 * Photos live in R2 under photos/<id>/<file>, recorded in the global
 * src/_data/photos.json. Upload path: wrangler when the machine is authed
 * (npx wrangler r2 object put), else the PIN-gated /api/photo endpoint.
 */
function putR2(key, buf, pin) {
  const tmp = path.join(os.tmpdir(), `hf-ingest-${process.pid}.jpg`);
  try {
    fs.writeFileSync(tmp, buf);
    execSync(
      `npx wrangler r2 object put "${BUCKET}/${key}" --file "${tmp}" --content-type image/jpeg --remote`,
      { cwd: ROOT, stdio: "pipe" }
    );
    return "wrangler";
  } catch (err) {
    if (!pin) throw new Error("wrangler upload failed and no --pin for /api/photo");
    return fetch(`${SITE}/api/photo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin, key, data: buf.toString("base64") }),
    }).then((res) => {
      if (!res.ok) throw new Error(`/api/photo ${res.status}`);
      return "api";
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

async function uploadPhotos(id, urls, manifest, dry, pin) {
  if (!urls || !urls.length) return 0;
  const files = [];
  let firstBuf = null;
  for (const [i, url] of urls.slice(0, MAX_PHOTOS).entries()) {
    const name = `${String(i + 1).padStart(2, "0")}.jpg`;
    if (dry) { files.push(name); continue; }
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, referer: "https://" + new URL(url).host + "/" },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.length < 2000) throw new Error(`status ${res.status}, ${buf.length}B`);
      await putR2(`photos/${id}/${name}`, buf, pin);
      files.push(name);
      if (!firstBuf) firstBuf = buf;
    } catch (err) {
      console.warn(`  photo ${i + 1} failed: ${err.message}`);
    }
    await sleep(700);
  }
  if (files.length && !dry) {
    // Dashboard thumbnail = the first gallery image under its own key.
    try { await putR2(`photos/${id}/thumb.jpg`, firstBuf, pin); } catch (err) {
      console.warn(`  thumb failed: ${err.message}`);
    }
    manifest[id] = { thumb: true, gallery: files };
  }
  return files.length;
}

/**
 * Map a pending-queue item (worker/index.js's cleanSubmission shape) onto the
 * candidate shape. Handles both the current multi-search shape
 * (`kind`, `commutes`/`routes` keyed by anchor key, `coords` as [lat, lon],
 * `extras: { <factKey>: value }`) and the legacy pre-multi-search shape
 * (no `kind`/`extras`; `commute_work`/`commute_home`, `route_work`/
 * `route_home` hardcoded to the work/home anchor keys) for items that were
 * already sitting in the queue when the pivot landed. `kind` falls back to
 * the search's first kind (via the same `c.kind || defaultKindKey` the main
 * loop already does for file-based candidates) when the item predates the
 * Worker carrying it; `extras` is spread onto the candidate so the normal
 * declared-`facts` copy-through (`copyFact`) picks each field up exactly as
 * it would for a hand-written candidate file.
 */
function fromPending(item) {
  const coords = Array.isArray(item.coords) && item.coords.length === 2
    ? [item.coords[1], item.coords[0]] // pending stores [lat, lon] -> candidate wants [lon, lat]
    : null;

  const commutes = { ...(item.commutes || {}) };
  if (item.commute_work && !commutes.work) commutes.work = item.commute_work;
  if (item.commute_home && !commutes.home) commutes.home = item.commute_home;

  const routes = { ...(item.routes || {}) };
  if (item.route_work && !routes.work) routes.work = item.route_work;
  if (item.route_home && !routes.home) routes.home = item.route_home;

  return {
    pendingId: item.id,
    kind: item.kind, // undefined on legacy items -> main loop's default-kind fallback applies
    name: item.name,
    address: item.address,
    town: item.town,
    state: item.state,
    rent: item.rent,
    beds: item.beds,
    notes: item.notes,
    url: item.url,
    coords,
    commutes,
    routes,
    ...(item.extras || {}), // per-search fact fields; absent on legacy items
  };
}

/** Coerce a raw candidate value for a `bool` fact. null stays null (explicit
 * "unknown"); undefined is handled by the caller (omit entirely = unknown
 * too). Anything else that can't be read as a boolean returns undefined so
 * the caller can warn + drop it. */
function coerceBool(raw) {
  if (raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (["true", "yes", "1"].includes(v)) return true;
    if (["false", "no", "0"].includes(v)) return false;
  }
  return undefined;
}

/** Copy one declared `facts[]` field from a candidate onto the listing entry,
 * type-coercing per `factDef.type` and dropping (with a warning) anything
 * that doesn't fit — an enum value not in `options`, a bool that isn't
 * true/false/null-ish, a non-numeric `number`. */
function copyFact(entry, factDef, raw, label) {
  if (raw === undefined) return; // not provided at all -> field omitted (reads as "unknown")
  switch (factDef.type) {
    case "bool": {
      const b = coerceBool(raw);
      if (b === undefined) {
        console.warn(`  fact "${factDef.key}": ${JSON.stringify(raw)} isn't a bool, dropping (${label})`);
        return;
      }
      entry[factDef.key] = b;
      return;
    }
    case "enum": {
      if (raw === null) { entry[factDef.key] = null; return; }
      if (typeof raw === "string" && Array.isArray(factDef.options) && factDef.options.includes(raw)) {
        entry[factDef.key] = raw;
        return;
      }
      console.warn(`  fact "${factDef.key}": ${JSON.stringify(raw)} not in ${JSON.stringify(factDef.options)}, dropping (${label})`);
      return;
    }
    case "number": {
      if (raw === null) { entry[factDef.key] = null; return; }
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        console.warn(`  fact "${factDef.key}": ${JSON.stringify(raw)} isn't a number, dropping (${label})`);
        return;
      }
      entry[factDef.key] = n;
      return;
    }
    case "text":
    default: {
      entry[factDef.key] = raw === null ? null : String(raw);
      return;
    }
  }
}

/** Read wrangler.json (or .jsonc) at the repo root — never hardcode the KV
 * namespace id. */
function readWranglerConfig() {
  for (const name of ["wrangler.json", "wrangler.jsonc"]) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    let text = fs.readFileSync(p, "utf8");
    if (name.endsWith(".jsonc")) {
      text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    }
    return JSON.parse(text);
  }
  throw new Error("no wrangler.json/wrangler.jsonc found at repo root");
}

function namespaceId() {
  const cfg = readWranglerConfig();
  const ns = (cfg.kv_namespaces || [])[0];
  if (!ns || !ns.id) throw new Error("wrangler config: kv_namespaces[0].id not found");
  return ns.id;
}

function wranglerKvList(nsId, prefix) {
  const out = execSync(
    `npx wrangler kv key list --namespace-id ${nsId} --prefix "${prefix}" --remote`,
    { cwd: ROOT, encoding: "utf8" }
  );
  return JSON.parse(out);
}

function wranglerKvGet(nsId, key) {
  return execSync(
    `npx wrangler kv key get "${key}" --namespace-id ${nsId} --remote`,
    { cwd: ROOT, encoding: "utf8" }
  );
}

function wranglerKvDelete(nsId, key) {
  execSync(
    `npx wrangler kv key delete "${key}" --namespace-id ${nsId} --remote`,
    { cwd: ROOT, stdio: "pipe" }
  );
}

function wranglerKvPutFile(nsId, key, filePath, ttlSeconds) {
  execSync(
    `npx wrangler kv key put "${key}" --path "${filePath}" --namespace-id ${nsId} --ttl ${ttlSeconds} --remote`,
    { cwd: ROOT, stdio: "pipe" }
  );
}

async function resolvePendingViaApi(pid, pin) {
  if (!pin) throw new Error("--via-api resolve requires --pin");
  const res = await fetch(`${SITE}/api/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pid, pin }),
  });
  if (!res.ok) throw new Error(`/api/resolve ${res.status}`);
}

/** Load the pending queue for `searchKey`. Returns `{ items, resolve(pid) }`
 * — `resolve` deletes/resolves one item and may be async. Default path reads
 * KV directly via wrangler; `--via-api` hits the PIN-gated HTTP endpoints
 * instead (see the header comment for why that needs a service token while
 * Cloudflare Access is on). */
async function loadPending(searchKey, { viaApi, pin }) {
  if (viaApi) {
    const res = await fetch(`${SITE}/api/pending?search=${encodeURIComponent(searchKey)}`);
    if (!res.ok) {
      throw new Error(
        `/api/pending ${res.status} — Cloudflare Access is probably blocking this request; ` +
        `drop --via-api to read via wrangler instead (the default)`
      );
    }
    const items = await res.json();
    return { items, resolve: (pid) => resolvePendingViaApi(pid, pin) };
  }
  const nsId = namespaceId();
  const keys = wranglerKvList(nsId, "pending:");
  const items = [];
  for (const k of keys) {
    try {
      items.push(JSON.parse(wranglerKvGet(nsId, k.name)));
    } catch (err) {
      console.warn(`pending ${k.name}: could not read/parse (${err.message}), skipping`);
    }
  }
  return { items, resolve: (pid) => wranglerKvDelete(nsId, `pending:${pid}`) };
}

function parseArgs(argv) {
  const flagsWithValue = ["--pin", "--search"];
  const consumedIdx = new Set();
  for (const flag of flagsWithValue) {
    const i = argv.indexOf(flag);
    if (i !== -1) { consumedIdx.add(i); consumedIdx.add(i + 1); }
  }
  const file = argv.find((a, i) => !a.startsWith("--") && !consumedIdx.has(i));
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : null;
  };
  return {
    dry: argv.includes("--dry"),
    usePending: argv.includes("--pending"),
    viaApi: argv.includes("--via-api"),
    pushLive: argv.includes("--push-live"),
    pin: valueOf("--pin"),
    searchKey: valueOf("--search"),
    file,
  };
}

async function main() {
  const { dry, usePending, viaApi, pushLive, pin, searchKey, file } = parseArgs(process.argv.slice(2));

  const searchesDir = path.join(DATA, "searches");
  let availableKeys = [];
  try {
    availableKeys = fs.readdirSync(searchesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch { /* directory missing -> empty list, error message below still fires */ }

  if (!searchKey || !availableKeys.includes(searchKey)) {
    console.error(
      `${!searchKey ? "--search <key> is required" : `Unknown --search "${searchKey}"`}. ` +
      `Keys found under ${path.relative(ROOT, searchesDir)}: ${availableKeys.join(", ") || "(none)"}`
    );
    process.exit(2);
  }

  let candidates;
  let resolvePendingItem = null;
  if (usePending) {
    const { items, resolve } = await loadPending(searchKey, { viaApi, pin });
    resolvePendingItem = resolve;
    const filtered = items.filter((it) => (it.search || "couple") === searchKey);
    console.log(`pending queue: ${items.length} item(s) total, ${filtered.length} for search "${searchKey}"`);
    candidates = filtered.map(fromPending);
  } else if (file) {
    candidates = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(candidates)) candidates = [candidates];
  } else {
    console.error("Usage: node scripts/ingest.js --search <key> <candidates.json> | --pending [--dry] [--via-api --pin XXXX] [--push-live]");
    process.exit(2);
  }

  const searchPath = path.join(searchesDir, `${searchKey}.json`);
  const search = JSON.parse(fs.readFileSync(searchPath, "utf8"));

  const routesPath = path.join(DATA, "routes", `${searchKey}.json`);
  let routes = {};
  try { routes = JSON.parse(fs.readFileSync(routesPath, "utf8")); } catch { /* no routes file yet -> {} */ }

  const manifestPath = path.join(DATA, "photos.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const budget = search.budget || { max: Infinity, stretch_max: Infinity };
  const kindByKey = new Map((search.kinds || []).map((k) => [k.key, k]));
  const defaultKindKey = search.kinds && search.kinds[0] && search.kinds[0].key;

  // Id dedupe is GLOBAL across every search file (ids share one namespace —
  // see plan-multisearch.md §1.2). Url dedupe is per search only.
  const haveIds = new Set();
  for (const f of fs.readdirSync(searchesDir).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(searchesDir, f), "utf8"));
    for (const l of data.listings || []) haveIds.add(l.id);
  }
  const haveUrls = new Set();
  for (const l of search.listings) {
    for (const u of [l.url, l.v1_url, ...(l.v1_urls || [])]) {
      const k = normUrl(u);
      if (k) haveUrls.add(k);
    }
  }

  let added = 0;
  const resolved = [];

  for (const c of candidates) {
    const label = c.name || c.address || c.id || "?";
    if (!c.town || !c.state || !(c.name || c.address)) {
      console.warn(`skip (missing town/state/name+address): ${label}`);
      continue;
    }

    const kindKey = c.kind || defaultKindKey;
    const kindDef = kindByKey.get(kindKey);
    if (!kindDef) {
      console.warn(`skip (unknown kind "${kindKey}" for search "${searchKey}"; valid: ${[...kindByKey.keys()].join(", ")}): ${label}`);
      continue;
    }

    const urlKey = normUrl(c.url);
    if (urlKey && haveUrls.has(urlKey)) {
      console.log(`skip (url already tracked in "${searchKey}"): ${label}`);
      if (c.pendingId) resolved.push(c.pendingId);
      continue;
    }
    const id = c.id || `${kindDef.prefix}-${slug(c.name || c.address)}`;
    if (haveIds.has(id)) {
      console.log(`skip (id exists): ${id}`);
      continue;
    }

    let coords = Array.isArray(c.coords) && c.coords.length === 2 ? c.coords : null;
    if (!coords) {
      coords = await geocode([c.address, c.town, c.state].filter(Boolean).join(", "));
      await sleep(1100); // Nominatim politeness
      if (!coords) {
        console.warn(`skip (no coords and geocode failed): ${label}`);
        continue;
      }
    }

    const commutes = {};
    const legs = {};
    let osrmFailed = false;
    for (const anchor of search.anchors) {
      try {
        const leg = await resolveLeg(c, anchor, coords);
        legs[anchor.key] = leg;
        commutes[anchor.key] = { min: leg.min, miles: leg.miles, method: "osrm-freeflow" };
      } catch (err) {
        console.warn(`skip (OSRM "${anchor.key}" failed: ${err.message}): ${label}`);
        osrmFailed = true;
        break;
      }
    }
    if (osrmFailed) continue;

    const photos = await uploadPhotos(id, c.photos, manifest, dry, pin);

    const entry = {
      id,
      kind: kindKey,
      name: c.name || null,
      address: c.address || null,
      town: c.town,
      state: c.state,
      tier: c.tier || 2,
      rent: typeof c.rent === "number" ? c.rent : null,
      band: band(typeof c.rent === "number" ? c.rent : null, budget),
      beds: typeof c.beds === "number" ? c.beds : null,
      baths: typeof c.baths === "number" ? c.baths : null,
      sqft: typeof c.sqft === "number" ? c.sqft : null,
      commutes,
      lease: c.lease || null,
      move_in_cost: c.move_in_cost || null,
      available: c.available || "Now",
      rating: null,
      pros: c.pros || null,
      cons: c.cons || null,
      url: c.url || null,
      url_status: c.url ? "direct" : "none",
      verification: "unverified",
      screenshot: null,
      coords,
      date_added: today(),
      v1_status: "New",
      notes: c.notes || null,
      geocode_method: Array.isArray(c.coords) ? "provided" : "nominatim",
      v1_url: null,
      last_checked: today(),
    };
    for (const factDef of search.facts || []) copyFact(entry, factDef, c[factDef.key], label);

    if (!dry) {
      search.listings.push(entry);
      routes[id] = legs;
    }
    haveIds.add(id);
    if (urlKey) haveUrls.add(urlKey);
    if (c.pendingId) resolved.push(c.pendingId);
    added++;
    const minsStr = search.anchors.map((a) => `${a.short || a.key} ${legs[a.key].min}m`).join(" / ");
    console.log(`${dry ? "would add" : "added"}: ${id} — ${entry.band}, ${minsStr}, ${photos} photo(s)`);
  }

  if (added && !dry) {
    search.updated = today();
    fs.writeFileSync(searchPath, JSON.stringify(search, null, 1) + "\n");
    fs.writeFileSync(routesPath, JSON.stringify(routes, null, 1) + "\n");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
    console.log(
      `\nwrote ${path.relative(ROOT, searchPath)} (${search.listings.length} listings), ` +
      `${path.relative(ROOT, routesPath)}, ${path.relative(ROOT, manifestPath)}`
    );
    console.log("next: npm run check && npm run build");
  }

  if (resolved.length && !dry) {
    for (const pid of resolved) {
      try {
        await resolvePendingItem(pid);
        console.log(`resolved pending:${pid}`);
      } catch (err) {
        console.warn(`resolve ${pid} failed: ${err.message}`);
      }
    }
  } else if (resolved.length && dry) {
    console.log(`\n${resolved.length} pending item(s) would be resolved (dry run — nothing deleted): ${resolved.join(", ")}`);
  }

  if (pushLive && added && !dry) {
    try {
      const homesPath = path.join(ROOT, "src", "_data", "homes.js");
      delete require.cache[require.resolve(homesPath)];
      const homes = require(homesPath);
      const feed = homes.byKey[searchKey].feed;
      const tmp = path.join(os.tmpdir(), `hf-feed-${searchKey}-${process.pid}.json`);
      fs.writeFileSync(tmp, JSON.stringify(feed));
      try {
        wranglerKvPutFile(namespaceId(), `data:live:${searchKey}`, tmp, 604800);
        console.log(`pushed live feed -> data:live:${searchKey}`);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      }
    } catch (err) {
      console.warn(`--push-live: could not build/push the feed (${err.message}) — skipping (homes.js may be mid-rewrite)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
