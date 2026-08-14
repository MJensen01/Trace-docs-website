#!/usr/bin/env node
/**
 * check.js — validate listings.json / routes.json / gallery folders.
 *
 *   npm run check
 *
 * Errors (exit 1) are contract violations an agent must fix before committing;
 * warnings are worth a look but don't block.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "src", "_data");

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const listings = JSON.parse(fs.readFileSync(path.join(DATA, "listings.json"), "utf8"));
const routes = JSON.parse(fs.readFileSync(path.join(DATA, "routes.json"), "utf8"));
const budget = listings.budget || {};

const ID_RE = /^(apa|tow)-[a-z0-9-]+$/;
const BANDS = ["in-budget", "stretch", "over", "unknown"];
const KINDS = ["apartment", "townhouse"];

function expectedBand(rent) {
  if (rent === null || rent === undefined) return "unknown";
  if (rent <= budget.max) return "in-budget";
  if (rent <= budget.stretch_max) return "stretch";
  return "over";
}

function normUrl(value) {
  if (!value || typeof value !== "string") return null;
  return (
    value.trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("#")[0].split("?")[0].replace(/\/+$/, "") || null
  );
}

const ids = new Set();
const urls = new Map();

for (const l of listings.listings) {
  const tag = l.id || "(no id)";

  if (!l.id || !ID_RE.test(l.id)) err(`${tag}: id must match ${ID_RE}`);
  if (ids.has(l.id)) err(`${tag}: duplicate id`);
  ids.add(l.id);

  if (!KINDS.includes(l.kind)) err(`${tag}: kind must be one of ${KINDS.join("/")}`);
  if (!l.town || !l.state) err(`${tag}: town and state are required`);
  if (!l.name && !l.address) err(`${tag}: needs a name or an address`);

  if (l.rent !== null && typeof l.rent !== "number") err(`${tag}: rent must be a number or null`);
  if (!BANDS.includes(l.band)) err(`${tag}: band must be one of ${BANDS.join("/")}`);
  else if (l.band !== expectedBand(l.rent)) {
    err(`${tag}: band "${l.band}" doesn't match rent ${l.rent} (expected "${expectedBand(l.rent)}")`);
  }

  if (!Array.isArray(l.coords) || l.coords.length !== 2) {
    err(`${tag}: coords must be [lon, lat]`);
  } else {
    const [lon, lat] = l.coords;
    if (lon < -76.5 || lon > -73 || lat < 39 || lat > 41.5) {
      err(`${tag}: coords [${lon}, ${lat}] are outside the NJ/PA search area — lon/lat swapped?`);
    }
  }

  for (const leg of ["commute_work", "commute_home"]) {
    const c = l[leg];
    if (!c || typeof c.min !== "number") warn(`${tag}: ${leg}.min missing`);
  }

  const key = normUrl(l.url);
  if (key) {
    if (urls.has(key)) warn(`${tag}: same url as ${urls.get(key)}`);
    urls.set(key, l.id);
  }

  const route = routes[l.id];
  if (!route) warn(`${tag}: no routes.json entry (listing map will be missing)`);
  else {
    for (const leg of ["work", "home"]) {
      const g = route[leg] && route[leg].geometry;
      if (!Array.isArray(g) || g.length < 2) { warn(`${tag}: routes.${leg}.geometry missing/short`); continue; }
      const [lat, lon] = g[0];
      if (lat < 39 || lat > 41.5 || lon < -76.5 || lon > -73) {
        err(`${tag}: routes.${leg}.geometry looks like [lon, lat] — must be [lat, lon]`);
      }
    }
  }
}

for (const key of Object.keys(routes)) {
  if (!ids.has(key)) warn(`routes.json: orphan entry "${key}" (no such listing)`);
}

// Photos live in R2; photos.json is the manifest the build trusts.
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "photos.json"), "utf8"));
for (const [key, entry] of Object.entries(manifest)) {
  if (!ids.has(key)) { warn(`photos.json: entry "${key}" has no listing`); continue; }
  if (entry.gallery !== undefined) {
    if (!Array.isArray(entry.gallery) || entry.gallery.some((f) => typeof f !== "string" || !/^[a-z0-9_-]+\.(jpe?g|png|webp)$/i.test(f))) {
      err(`photos.json: "${key}".gallery must be an array of plain image filenames`);
    } else if (!entry.gallery.length) {
      warn(`photos.json: "${key}".gallery is empty`);
    }
  }
  if (entry.gallery && entry.gallery.length && !entry.thumb) {
    warn(`photos.json: "${key}" has a gallery but no thumb`);
  }
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(listings.updated || "")) err(`updated "${listings.updated}" must be YYYY-MM-DD`);

for (const w of warnings) console.log(`warn: ${w}`);
for (const e of errors) console.log(`ERROR: ${e}`);
console.log(`\n${listings.listings.length} listings — ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
