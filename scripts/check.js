#!/usr/bin/env node
/**
 * check.js — validate the per-search data layout under src/_data/:
 *
 *   src/_data/searches/<key>.json   search config (anchors/budget/kinds/facts) + its listings
 *   src/_data/routes/<key>.json     route geometry, keyed by listing id, one file per search
 *   src/_data/photos.json           GLOBAL manifest, keyed by listing id (shared across searches)
 *
 * Usage:
 *   npm run check                        # validate everything
 *   npm run check -- --search <key>      # scope the per-search / per-listing checks to one
 *                                         # search. The cross-search checks — global listing-id
 *                                         # uniqueness, kind-prefix disjointness, and the
 *                                         # photos.json / routes/<k>.json <-> listing mappings —
 *                                         # ALWAYS run over every search, scoped or not, because
 *                                         # they're the entire point of splitting the data this
 *                                         # way (a sweep on one search must never silently break
 *                                         # another's ids).
 *
 * Alternate data directory (used by mutation/regression tests so the real data
 * files are never touched): pass
 *
 *   npm run check -- --data <dir>        # <dir> must be shaped like src/_data/
 *                                         # (searches/, routes/, photos.json)
 *
 * or set the HF_DATA_DIR env var to the same effect. --data wins if both are
 * given; with neither, it defaults to src/_data/ in this repo.
 *
 * Errors (exit 1) are contract violations an agent must fix before committing;
 * warnings are worth a look but don't block.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const out = { search: null, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--search") out.search = argv[++i];
    else if (a.startsWith("--search=")) out.search = a.slice("--search=".length);
    else if (a === "--data") out.dataDir = argv[++i];
    else if (a.startsWith("--data=")) out.dataDir = a.slice("--data=".length);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const DATA = path.resolve(
  args.dataDir || process.env.HF_DATA_DIR || path.join(ROOT, "src", "_data")
);

// Every finding is { searchKey, level, msg }. searchKey is null for cross-search
// findings that don't belong to one file (duplicate ids, colliding prefixes, a
// second "primary", ...).
const issues = [];
const err = (searchKey, msg) => issues.push({ searchKey, level: "error", msg });
const warn = (searchKey, msg) => issues.push({ searchKey, level: "warn", msg });

const KEY_RE = /^[a-z][a-z0-9-]{0,20}$/;
const PREFIX_RE = /^[a-z]{3,4}$/;
const BANDS = ["in-budget", "stretch", "over", "unknown"];
const FACT_TYPES = ["bool", "text", "enum", "number"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Reserved top-level listing fields — a search's facts[].key may never collide
// with these (plan §1.4).
const RESERVED_FIELDS = new Set([
  "id", "kind", "name", "address", "town", "state", "tier", "rent", "band",
  "beds", "baths", "sqft", "commutes", "lease", "move_in_cost", "available",
  "rating", "pros", "cons", "url", "url_status", "verification", "screenshot",
  "coords", "date_added", "last_checked", "v1_status", "v1_url", "v1_urls",
  "notes", "geocode_method",
]);

function normUrl(value) {
  if (!value || typeof value !== "string") return null;
  return (
    value.trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("#")[0].split("?")[0].replace(/\/+$/, "") || null
  );
}

function inBBox([lon, lat], bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function expectedBand(rent, budget) {
  if (rent === null || rent === undefined) return "unknown";
  if (rent <= budget.max) return "in-budget";
  if (rent <= budget.stretch_max) return "stretch";
  return "over";
}

// ---------------------------------------------------------------------------
// Load every search file — always, even when --search is given, because the
// cross-search checks below need the full picture.
// ---------------------------------------------------------------------------

const searchesDir = path.join(DATA, "searches");
if (!fs.existsSync(searchesDir)) {
  console.log(`ERROR: no searches/ directory found at ${searchesDir}`);
  process.exit(1);
}

const searchFiles = fs.readdirSync(searchesDir).filter((f) => f.endsWith(".json")).sort();
const searches = [];

for (const file of searchFiles) {
  const stem = file.slice(0, -".json".length);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(searchesDir, file), "utf8"));
  } catch (e) {
    err(stem, `searches/${file}: invalid JSON — ${e.message}`);
    continue;
  }
  searches.push({ key: stem, file, data });
}

if (args.search && !searches.some((s) => s.key === args.search)) {
  console.log(`ERROR: no search named "${args.search}" (have: ${searches.map((s) => s.key).join(", ")})`);
  process.exit(1);
}
const included = args.search ? searches.filter((s) => s.key === args.search) : searches;

// ---------------------------------------------------------------------------
// Search-level structural checks — run for every search file always (cheap,
// and things like "basePath unique" / "exactly one primary" only make sense
// computed over the whole set regardless of what --search scopes below).
// ---------------------------------------------------------------------------

let primaryCount = 0;
const basePathOwner = new Map();

for (const { key, file, data: s } of searches) {
  if (s.key !== key) err(key, `searches/${file}: "key" field "${s.key}" must match the filename stem "${key}"`);
  if (!KEY_RE.test(key)) err(key, `searches/${file}: filename stem "${key}" must match ${KEY_RE}`);
  if (!DATE_RE.test(s.updated || "")) err(key, `updated "${s.updated}" must be YYYY-MM-DD`);
  if (typeof s.order !== "number") err(key, `order must be numeric`);

  if (typeof s.basePath !== "string" || !s.basePath.startsWith("/") || !s.basePath.endsWith("/")) {
    err(key, `basePath "${s.basePath}" must start and end with "/"`);
  } else {
    if (basePathOwner.has(s.basePath)) {
      err(key, `basePath "${s.basePath}" is also used by "${basePathOwner.get(s.basePath)}"`);
    }
    basePathOwner.set(s.basePath, key);
  }

  if (s.primary === true) primaryCount++;

  if (!Array.isArray(s.bbox) || s.bbox.length !== 4 || s.bbox.some((n) => typeof n !== "number")) {
    err(key, `bbox must be [minLon, minLat, maxLon, maxLat]`);
  }

  if (!Array.isArray(s.anchors) || !s.anchors.length) {
    err(key, `anchors must be a non-empty array`);
  } else {
    const seen = new Set();
    for (const a of s.anchors) {
      if (seen.has(a.key)) err(key, `duplicate anchor key "${a.key}"`);
      seen.add(a.key);
      if (!Array.isArray(a.coords) || a.coords.length !== 2) {
        err(key, `anchor "${a.key}": coords must be [lon, lat]`);
      } else if (Array.isArray(s.bbox) && s.bbox.length === 4 && !inBBox(a.coords, s.bbox)) {
        err(key, `anchor "${a.key}": coords [${a.coords}] are outside "${key}"'s bbox`);
      }
      if (typeof a.maxMin !== "number") err(key, `anchor "${a.key}": maxMin must be numeric`);
      if (a.hard !== undefined && typeof a.hard !== "boolean") {
        err(key, `anchor "${a.key}": hard must be boolean if present`);
      }
    }
  }

  if (!Array.isArray(s.kinds) || !s.kinds.length) {
    err(key, `kinds must be a non-empty array`);
  } else {
    const seen = new Set();
    for (const k of s.kinds) {
      if (seen.has(k.key)) err(key, `duplicate kind key "${k.key}"`);
      seen.add(k.key);
      if (!PREFIX_RE.test(k.prefix || "")) {
        err(key, `kind "${k.key}": prefix "${k.prefix}" must match ${PREFIX_RE}`);
      }
      if (k.checklist !== undefined) {
        const bad = !Array.isArray(k.checklist) ||
          k.checklist.some((c) => typeof c !== "string" || !c.trim());
        if (bad) err(key, `kind "${k.key}": checklist must be an array of non-empty strings`);
      }
    }
  }

  for (const f of s.facts || []) {
    if (RESERVED_FIELDS.has(f.key)) err(key, `fact "${f.key}" collides with a reserved listing field`);
    if (!FACT_TYPES.includes(f.type)) err(key, `fact "${f.key}": type must be one of ${FACT_TYPES.join("/")}`);
    if (f.type === "enum" && (!Array.isArray(f.options) || !f.options.length)) {
      err(key, `fact "${f.key}": enum facts need a non-empty options array`);
    }
  }

  if (!s.budget || typeof s.budget.max !== "number" || typeof s.budget.stretch_max !== "number") {
    err(key, `budget.max and budget.stretch_max must be numbers`);
  }

  if (!Array.isArray(s.listings)) err(key, `listings must be an array`);
}

if (primaryCount !== 1) {
  err(null, `exactly one search must set "primary": true (found ${primaryCount})`);
}

// ---------------------------------------------------------------------------
// Per-listing + per-search routes-content checks — scoped to --search when given.
// ---------------------------------------------------------------------------

for (const { key, data: s } of included) {
  if (!Array.isArray(s.listings)) continue;

  const kindPrefixes = (s.kinds || []).map((k) => k.prefix).filter(Boolean);
  const idRe = new RegExp(`^(${kindPrefixes.join("|")})-[a-z0-9-]+$`);
  const kindKeys = new Set((s.kinds || []).map((k) => k.key));
  const anchorKeys = (s.anchors || []).map((a) => a.key);
  const anchorKeySet = new Set(anchorKeys);
  const factsByKey = new Map((s.facts || []).map((f) => [f.key, f]));
  const bbox = Array.isArray(s.bbox) && s.bbox.length === 4 ? s.bbox : null;
  const urls = new Map();

  for (const l of s.listings) {
    const tag = l.id || "(no id)";

    if (!l.id || (kindPrefixes.length > 0 && !idRe.test(l.id))) {
      err(key, `${tag}: id must match ${idRe}`);
    }
    if (!kindKeys.has(l.kind)) err(key, `${tag}: kind must be one of ${[...kindKeys].join("/")}`);
    if (!l.town || !l.state) err(key, `${tag}: town and state are required`);
    if (!l.name && !l.address) err(key, `${tag}: needs a name or an address`);

    if (l.rent !== null && l.rent !== undefined && typeof l.rent !== "number") {
      err(key, `${tag}: rent must be a number or null`);
    }
    if (!BANDS.includes(l.band)) {
      err(key, `${tag}: band must be one of ${BANDS.join("/")}`);
    } else {
      const exp = expectedBand(l.rent, s.budget || {});
      if (l.band !== exp) {
        err(key, `${tag}: band "${l.band}" doesn't match rent ${l.rent} (expected "${exp}")`);
      }
    }

    if (!Array.isArray(l.coords) || l.coords.length !== 2) {
      err(key, `${tag}: coords must be [lon, lat]`);
    } else if (bbox && !inBBox(l.coords, bbox)) {
      err(key, `${tag}: coords [${l.coords}] are outside "${key}"'s search area — lon/lat swapped?`);
    }

    if (!l.commutes || typeof l.commutes !== "object") {
      err(key, `${tag}: commutes is required`);
    } else {
      for (const leg of Object.keys(l.commutes)) {
        if (!anchorKeySet.has(leg)) {
          err(key, `${tag}: commutes has key "${leg}" which is not an anchor of "${key}" (${anchorKeys.join("/")})`);
        }
      }
      for (const leg of anchorKeys) {
        if (!(leg in l.commutes)) {
          err(key, `${tag}: commutes is missing anchor "${leg}"`);
        } else if (typeof l.commutes[leg].min !== "number") {
          warn(key, `${tag}: commutes.${leg}.min missing`);
        }
      }
    }

    // Declared facts are tri-state for bool (true/false/null/absent = unknown).
    for (const [fk, f] of factsByKey) {
      if (!(fk in l)) continue;
      const v = l[fk];
      if (f.type === "bool" && !(v === true || v === false || v === null)) {
        err(key, `${tag}: fact "${fk}" must be true, false or null (got ${JSON.stringify(v)})`);
      } else if (f.type === "enum" && v !== null && !(f.options || []).includes(v)) {
        err(key, `${tag}: fact "${fk}" value ${JSON.stringify(v)} is not one of ${JSON.stringify(f.options)}`);
      } else if (f.type === "number" && v !== null && typeof v !== "number") {
        err(key, `${tag}: fact "${fk}" must be a number or null (got ${JSON.stringify(v)})`);
      } else if (f.type === "text" && v !== null && typeof v !== "string") {
        err(key, `${tag}: fact "${fk}" must be a string or null (got ${JSON.stringify(v)})`);
      }
    }

    const known = new Set([...RESERVED_FIELDS, ...factsByKey.keys()]);
    for (const k of Object.keys(l)) {
      if (!known.has(k)) warn(key, `${tag}: unexpected field "${k}" (not a core field or a declared fact of "${key}")`);
    }

    const uk = normUrl(l.url);
    if (uk) {
      if (urls.has(uk)) warn(key, `${tag}: same url as ${urls.get(uk)}`);
      urls.set(uk, l.id);
    }
  }

  // routes/<key>.json content checks (leg keys, geometry shape, [lat,lon] order).
  const routesPath = path.join(DATA, "routes", `${key}.json`);
  let routesData = {};
  if (fs.existsSync(routesPath)) {
    try {
      routesData = JSON.parse(fs.readFileSync(routesPath, "utf8"));
    } catch (e) {
      err(key, `routes/${key}.json: invalid JSON — ${e.message}`);
      routesData = {};
    }
  } else {
    warn(key, `routes/${key}.json not found`);
  }

  for (const l of s.listings) {
    const tag = l.id || "(no id)";
    const route = routesData[l.id];
    if (!route) {
      warn(key, `${tag}: no routes/${key}.json entry (listing map will be missing)`);
      continue;
    }
    for (const leg of Object.keys(route)) {
      if (!anchorKeySet.has(leg)) warn(key, `${tag}: routes.${leg} is not an anchor of "${key}"`);
    }
    for (const leg of anchorKeys) {
      const g = route[leg] && route[leg].geometry;
      if (!Array.isArray(g) || g.length < 2) {
        warn(key, `${tag}: routes.${leg}.geometry missing/short`);
        continue;
      }
      if (bbox) {
        const [gLat, gLon] = g[0];
        const [minLon, minLat, maxLon, maxLat] = bbox;
        if (gLat < minLat || gLat > maxLat || gLon < minLon || gLon > maxLon) {
          err(key, `${tag}: routes.${leg}.geometry looks like [lon, lat] — must be [lat, lon]`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-search checks — ALWAYS run over every search, regardless of --search.
// ---------------------------------------------------------------------------

const idOwner = new Map();
const prefixOwner = new Map();
const allIds = new Set();

for (const { key, data: s } of searches) {
  for (const k of s.kinds || []) {
    if (!k.prefix) continue;
    if (prefixOwner.has(k.prefix)) {
      const other = prefixOwner.get(k.prefix);
      if (other.key !== key || other.kind !== k.key) {
        err(null, `kind prefix "${k.prefix}" is used by both "${other.key}/${other.kind}" and "${key}/${k.key}" — prefixes must be disjoint across searches`);
      }
    } else {
      prefixOwner.set(k.prefix, { key, kind: k.key });
    }
  }
  for (const l of s.listings || []) {
    if (!l.id) continue;
    allIds.add(l.id);
    if (idOwner.has(l.id) && idOwner.get(l.id) !== key) {
      err(null, `id "${l.id}" is used by both "${idOwner.get(l.id)}" and "${key}" — listing ids must be globally unique`);
    } else if (!idOwner.has(l.id)) {
      idOwner.set(l.id, key);
    }
  }
}

// photos.json -> every key must map to a listing in SOME search.
const photosPath = path.join(DATA, "photos.json");
if (fs.existsSync(photosPath)) {
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(photosPath, "utf8"));
  } catch (e) {
    err(null, `photos.json: invalid JSON — ${e.message}`);
  }
  for (const [pid, entry] of Object.entries(manifest)) {
    if (!allIds.has(pid)) {
      warn(null, `photos.json: entry "${pid}" has no listing in any search`);
      continue;
    }
    if (entry.gallery !== undefined) {
      const bad = !Array.isArray(entry.gallery) ||
        entry.gallery.some((f) => typeof f !== "string" || !/^[a-z0-9_-]+\.(jpe?g|png|webp)$/i.test(f));
      if (bad) {
        err(null, `photos.json: "${pid}".gallery must be an array of plain image filenames`);
      } else if (!entry.gallery.length) {
        warn(null, `photos.json: "${pid}".gallery is empty`);
      }
    }
    if (entry.gallery && entry.gallery.length && !entry.thumb) {
      warn(null, `photos.json: "${pid}" has a gallery but no thumb`);
    }
  }
} else {
  warn(null, `photos.json not found at ${photosPath}`);
}

// routes/<k>.json -> every key must map to a listing that actually exists in search k.
const routesDir = path.join(DATA, "routes");
if (fs.existsSync(routesDir)) {
  const idsBySearch = new Map(
    searches.map((s) => [s.key, new Set((s.data.listings || []).map((l) => l.id))])
  );
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith(".json"))) {
    const stem = file.slice(0, -".json".length);
    const idSet = idsBySearch.get(stem);
    if (!idSet) {
      warn(null, `routes/${file}: no search named "${stem}"`);
      continue;
    }
    let routesData = {};
    try {
      routesData = JSON.parse(fs.readFileSync(path.join(routesDir, file), "utf8"));
    } catch (e) {
      err(null, `routes/${file}: invalid JSON — ${e.message}`);
      continue;
    }
    for (const id of Object.keys(routesData)) {
      if (!idSet.has(id)) warn(null, `routes/${file}: orphan entry "${id}" (no such listing in "${stem}")`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const i of issues) {
  if (i.level !== "warn") continue;
  console.log(`warn: ${i.searchKey ? `[${i.searchKey}] ` : ""}${i.msg}`);
}
for (const i of issues) {
  if (i.level !== "error") continue;
  console.log(`ERROR: ${i.searchKey ? `[${i.searchKey}] ` : ""}${i.msg}`);
}

console.log("");
let totalListings = 0;
let totalErrors = 0;
let totalWarnings = 0;
for (const { key, data: s } of included) {
  const n = Array.isArray(s.listings) ? s.listings.length : 0;
  const eCount = issues.filter((i) => i.searchKey === key && i.level === "error").length;
  const wCount = issues.filter((i) => i.searchKey === key && i.level === "warn").length;
  console.log(`${key}: ${n} listings — ${eCount} error(s), ${wCount} warning(s)`);
  totalListings += n;
  totalErrors += eCount;
  totalWarnings += wCount;
}
totalErrors += issues.filter((i) => i.searchKey === null && i.level === "error").length;
totalWarnings += issues.filter((i) => i.searchKey === null && i.level === "warn").length;
console.log(`total: ${totalListings} listings, ${totalErrors} error(s), ${totalWarnings} warning(s)`);

process.exit(issues.some((i) => i.level === "error") ? 1 : 0);
