#!/usr/bin/env node
/**
 * ingest.js — turn candidate listings into full site entries in one command.
 *
 *   node scripts/ingest.js candidates.json          # ingest a candidate file
 *   node scripts/ingest.js --pending                # pull the live pending queue
 *   node scripts/ingest.js --pending --pin 1234     # ...and resolve items after ingest
 *   node scripts/ingest.js candidates.json --dry    # validate + plan, write nothing
 *
 * A candidate is a plain object; only `town`, `state`, and one of
 * `name`/`address` are required, plus either `coords` ([lon, lat]) or a
 * geocodable address. Everything else is optional:
 *
 *   {
 *     "id":      "apa-my-place",            // derived from name/address if omitted
 *     "kind":    "apartment",               // or "townhouse"; default apartment
 *     "name":    "My Place Apartments",
 *     "address": "1 Main St",
 *     "town":    "Milltown", "state": "NJ",
 *     "rent":    1500, "beds": 1, "baths": 1, "sqft": 700,
 *     "coords":  [-74.44, 40.45],           // [lon, lat]
 *     "url":     "https://...",
 *     "photos":  ["https://...jpg", ...],   // downloaded into the gallery (max 8)
 *     "pros":    "...", "cons": "...", "notes": "...",
 *     "tier":    2, "available": "Now", "lease": null, "move_in_cost": null
 *   }
 *
 * The script fills in the rest: budget band from rent, OSRM drive times and
 * route geometry for both anchors, photo uploads to R2 (+ photos.json
 * manifest + thumbnail), listings.json / routes.json appends, and the
 * `updated` stamp. Candidates whose URL or id already exist are skipped, not
 * overwritten. Photo uploads use wrangler when this machine is authed;
 * otherwise pass --pin to fall back to the site's /api/photo endpoint.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "src", "_data");
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

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "user-agent": "home-finder-ingest/1.0" } });
  const json = await res.json();
  if (!json[0]) return null;
  return [Number(json[0].lon), Number(json[0].lat)];
}

/**
 * Photos live in R2 under photos/<id>/<file>, recorded in
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

/** Map a pending-queue item (worker/index.js shape) onto the candidate shape. */
function fromPending(item) {
  return {
    pendingId: item.id,
    name: item.name,
    address: item.address,
    town: item.town,
    state: item.state,
    rent: item.rent,
    beds: item.beds,
    notes: item.notes,
    url: item.url,
    coords: Array.isArray(item.coords) ? [item.coords[1], item.coords[0]] : null, // pending stores [lat, lon]
    commute_work: item.commute_work,
    commute_home: item.commute_home,
    route_work: item.route_work,
    route_home: item.route_home,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const usePending = args.includes("--pending");
  const pinAt = args.indexOf("--pin");
  const pin = pinAt !== -1 ? args[pinAt + 1] : null;
  const file = args.find((a) => !a.startsWith("--") && a !== pin);

  let candidates;
  if (usePending) {
    const res = await fetch(`${SITE}/api/pending`);
    candidates = (await res.json()).map(fromPending);
    console.log(`pending queue: ${candidates.length} item(s)`);
  } else if (file) {
    candidates = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(candidates)) candidates = [candidates];
  } else {
    console.error("Usage: node scripts/ingest.js <candidates.json> | --pending [--pin XXXX] [--dry]");
    process.exit(2);
  }

  const listings = JSON.parse(fs.readFileSync(path.join(DATA, "listings.json"), "utf8"));
  const routes = JSON.parse(fs.readFileSync(path.join(DATA, "routes.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "photos.json"), "utf8"));
  const budget = listings.budget || { max: 1600, stretch_max: 1900 };
  const haveIds = new Set(listings.listings.map((l) => l.id));
  const haveUrls = new Set();
  for (const l of listings.listings) {
    for (const u of [l.url, l.v1_url, ...(l.v1_urls || [])]) {
      const k = normUrl(u);
      if (k) haveUrls.add(k);
    }
  }

  const work = listings.anchors.work.coords; // [lon, lat]
  const home = listings.anchors.home.coords;
  let added = 0;
  const resolved = [];

  for (const c of candidates) {
    const label = c.name || c.address || c.id || "?";
    if (!c.town || !c.state || !(c.name || c.address)) {
      console.warn(`skip (missing town/state/name+address): ${label}`);
      continue;
    }
    const urlKey = normUrl(c.url);
    if (urlKey && haveUrls.has(urlKey)) {
      console.log(`skip (url already tracked): ${label}`);
      if (c.pendingId) resolved.push(c.pendingId);
      continue;
    }
    const id = c.id || `${c.kind === "townhouse" ? "tow" : "apa"}-${slug(c.name || c.address)}`;
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

    // Reuse commutes/routes the /add/ page already computed; fill gaps via OSRM.
    let workLeg = c.route_work && c.route_work.geometry
      ? { min: Math.round(c.route_work.min), miles: c.route_work.miles, geometry: c.route_work.geometry }
      : null;
    let homeLeg = c.route_home && c.route_home.geometry
      ? { min: Math.round(c.route_home.min), miles: c.route_home.miles, geometry: c.route_home.geometry }
      : null;
    try {
      if (!workLeg) { workLeg = await osrmRoute(coords, work); await sleep(1200); }
      if (!homeLeg) { homeLeg = await osrmRoute(coords, home); await sleep(1200); }
    } catch (err) {
      console.warn(`skip (OSRM failed: ${err.message}): ${label}`);
      continue;
    }

    const photos = await uploadPhotos(id, c.photos, manifest, dry, pin);

    const entry = {
      id,
      kind: c.kind === "townhouse" ? "townhouse" : "apartment",
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
      commute_work: { min: workLeg.min, miles: workLeg.miles, method: "osrm-freeflow" },
      commute_home: { min: homeLeg.min, miles: homeLeg.miles, method: "osrm-freeflow" },
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

    if (!dry) {
      listings.listings.push(entry);
      routes[id] = { work: workLeg, home: homeLeg };
    }
    haveIds.add(id);
    if (urlKey) haveUrls.add(urlKey);
    if (c.pendingId) resolved.push(c.pendingId);
    added++;
    console.log(`${dry ? "would add" : "added"}: ${id} — ${entry.band}, home ${homeLeg.min}m / work ${workLeg.min}m, ${photos} photo(s)`);
  }

  if (added && !dry) {
    listings.updated = today();
    fs.writeFileSync(path.join(DATA, "listings.json"), JSON.stringify(listings, null, 1) + "\n");
    fs.writeFileSync(path.join(DATA, "routes.json"), JSON.stringify(routes, null, 1) + "\n");
    fs.writeFileSync(path.join(DATA, "photos.json"), JSON.stringify(manifest, null, 1) + "\n");
    console.log(`\nwrote listings.json (${listings.listings.length} listings), routes.json, photos.json`);
    console.log("next: npm run check && npm run build");
  }

  if (resolved.length && pin && !dry) {
    for (const pid of resolved) {
      const res = await fetch(`${SITE}/api/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: pid, pin }),
      });
      console.log(`resolve ${pid}: ${res.status}`);
      await sleep(400);
    }
  } else if (resolved.length && !pin) {
    console.log(`\n${resolved.length} pending item(s) can be resolved — rerun with --pin XXXX, ids: ${resolved.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
