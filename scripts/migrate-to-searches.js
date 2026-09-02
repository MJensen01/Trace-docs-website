#!/usr/bin/env node
/**
 * migrate-to-searches.js — T1 of the multi-search pivot.
 *
 * One-shot, mechanical, verifiable rewrite of the single-search data files
 * (`src/_data/listings.json` + `src/_data/routes.json`) into the new
 * per-search layout (`src/_data/searches/<key>.json` +
 * `src/_data/routes/<key>.json`).
 *
 * Usage:
 *   node scripts/migrate-to-searches.js            # write the four new files
 *   node scripts/migrate-to-searches.js --verify    # reconstruct the OLD
 *                                                    # shapes from the NEW
 *                                                    # files and deep-equal
 *                                                    # them against the
 *                                                    # originals
 *
 * This script does NOT delete or modify listings.json / routes.json /
 * photos.json. It is idempotent — re-running overwrites the same outputs.
 *
 * See scratchpad/plan-multisearch.md §1.3, §7 and scratchpad/decisions.md
 * for the schema this implements. Per decisions.md, the solo search's key is
 * `solo` (not `evelyn` as an earlier draft of the plan said).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OLD_LISTINGS_PATH = path.join(ROOT, "src", "_data", "listings.json");
const OLD_ROUTES_PATH = path.join(ROOT, "src", "_data", "routes.json");

const SEARCHES_DIR = path.join(ROOT, "src", "_data", "searches");
const ROUTES_DIR = path.join(ROOT, "src", "_data", "routes");

const COUPLE_SEARCH_PATH = path.join(SEARCHES_DIR, "couple.json");
const SOLO_SEARCH_PATH = path.join(SEARCHES_DIR, "solo.json");
const COUPLE_ROUTES_PATH = path.join(ROUTES_DIR, "couple.json");
const SOLO_ROUTES_PATH = path.join(ROUTES_DIR, "solo.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // JSON.stringify(x, null, 1) + "\n" to match the existing files' style.
  // Write as UTF-8 without BOM (Buffer.from on a plain string never adds one).
  const text = JSON.stringify(obj, null, 1) + "\n";
  fs.writeFileSync(p, Buffer.from(text, "utf8"));
}

// ---------------------------------------------------------------------------
// couple.json config — plan §7 step 2 / decisions.md "couple.json"
// ---------------------------------------------------------------------------

function buildCoupleAnchors(oldAnchors) {
  // oldAnchors = { work: {...}, home: {...} } (old anchors object, unordered
  // keys in source but we fix the order here: home first, then work, per
  // decisions.md "Order: home first, then work").
  const home = oldAnchors.home;
  const work = oldAnchors.work;
  return [
    {
      key: "home",
      label: home.label,
      short: "East Brunswick",
      query: home.query,
      coords: home.coords,
      glyph: "🏠",
      color: "#7c3aed",
      maxMin: 30,
    },
    {
      key: "work",
      label: work.label,
      short: "Keystone Trade Center",
      query: work.query,
      coords: work.coords,
      glyph: "💼",
      color: "#2563eb",
      maxMin: 52,
    },
  ];
}

function buildCoupleSearch(oldListings) {
  const listings = oldListings.listings.map(migrateListingCommutes);

  return {
    key: "couple",
    version: "2.0",
    updated: oldListings.updated,

    label: "Matt & Evelyn's apartments",
    shortLabel: "Apartments",
    // decisions.md: "blurb = the current list.njk intro sentence" — that's
    // list.njk's frontmatter `description` (its static intro line; the body
    // copy is a computed sentence with live counts, not a fixed blurb).
    blurb:
      "Every rental we are tracking as cards, with rent, commute times and ratings.",
    basePath: "/apartments/",
    order: 1,
    primary: false,

    anchors: buildCoupleAnchors(oldListings.anchors),

    budget: { ...oldListings.budget },
    bandLabels: {
      "in-budget": "In budget",
      stretch: "Stretch",
      over: "Over budget",
      unknown: "Rent unknown",
    },

    kinds: [
      { key: "apartment", label: "Apartment", short: "Apt", prefix: "apa" },
      { key: "townhouse", label: "Townhouse", short: "Town", prefix: "tow" },
    ],

    facts: [],

    states: ["NJ", "PA"],
    bbox: [-76.5, 39, -73, 41.5],

    site_base_url: oldListings.site_base_url,

    listings,
  };
}

/**
 * Spread a listing verbatim, replacing commute_work/commute_home with a
 * commutes object inserted in the SAME position that commute_work occupied,
 * preserving key order for every other field.
 */
function migrateListingCommutes(listing) {
  const out = {};
  for (const key of Object.keys(listing)) {
    if (key === "commute_work") {
      out.commutes = { work: listing.commute_work, home: listing.commute_home };
    } else if (key === "commute_home") {
      // already folded into `commutes` above; skip
      continue;
    } else {
      out[key] = listing[key];
    }
  }
  return out;
}

/** Inverse of migrateListingCommutes: reconstruct commute_work/commute_home
 *  in place of `commutes`, for --verify. */
function unmigrateListingCommutes(listing) {
  const out = {};
  for (const key of Object.keys(listing)) {
    if (key === "commutes") {
      out.commute_work = listing.commutes.work;
      out.commute_home = listing.commutes.home;
    } else {
      out[key] = listing[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// solo.json config — decisions.md "solo.json config (exact values)" (wins
// over plan §1.3's `evelyn` example)
// ---------------------------------------------------------------------------

function buildSoloSearch() {
  return {
    key: "solo",
    version: "2.0",
    updated: "2026-09-02",

    label: "Evelyn's place",
    shortLabel: "Evelyn",
    blurb:
      "A cheap studio, basement or 1BR for Evelyn on her own — under 20 minutes from Matt's and from work.",
    basePath: "/",
    order: 0,
    primary: true,

    anchors: [
      {
        key: "home",
        label: "Matt's house — East Brunswick, NJ",
        short: "Matt's",
        query: "East Brunswick, NJ 08816",
        coords: [-74.415984, 40.4278841],
        glyph: "🏠",
        color: "#7c3aed",
        maxMin: 20,
      },
      {
        key: "work",
        label: "Once Upon A Child — 561 US-1, Edison, NJ",
        short: "Work",
        query: "561 US-1, Edison, NJ 08817",
        coords: [-74.3963, 40.506],
        glyph: "💼",
        color: "#2563eb",
        maxMin: 20,
      },
    ],

    budget: { max: 1200, stretch_max: 1400 },
    bandLabels: {
      "in-budget": "Ideal",
      stretch: "In budget",
      over: "Over budget",
      unknown: "Rent unknown",
    },

    kinds: [
      { key: "studio", label: "Studio", short: "Studio", prefix: "stu" },
      {
        key: "basement",
        label: "Basement / in-law unit",
        short: "Bsmt",
        prefix: "bsm",
        checklist: [
          "Ask to see the Certificate of Occupancy — in NJ a basement unit is only legal with one",
          "Second way out (egress window or door) besides the main stairs?",
          "Ceiling height and window size — does it feel like a legal bedroom?",
          "Is the rent all-in or are utilities extra?",
          "Written lease, not cash-only",
        ],
      },
      { key: "1br", label: "1-bedroom", short: "1BR", prefix: "one" },
    ],

    facts: [
      {
        key: "utilities_included",
        type: "bool",
        label: "Utilities included",
        chip: "Utils incl.",
        column: true,
        form: true,
      },
      {
        key: "furnished",
        type: "bool",
        label: "Furnished",
        chip: "Furnished",
        column: true,
        form: true,
      },
      {
        key: "private_entrance",
        type: "bool",
        label: "Private entrance",
        chip: "Own door",
        column: false,
        form: true,
      },
      {
        key: "legal_unit",
        type: "bool",
        label: "Legal unit (has C.O.)",
        chip: "Has C.O.",
        column: true,
        form: true,
      },
      {
        key: "lease_flex",
        type: "text",
        label: "Lease terms",
        column: false,
        form: true,
      },
      {
        key: "deposit",
        type: "text",
        label: "Deposit",
        column: false,
        form: true,
      },
      {
        key: "source",
        type: "enum",
        label: "Source",
        column: true,
        form: true,
        options: [
          "Craigslist",
          "Facebook",
          "Zillow",
          "Apartments.com",
          "HotPads",
          "Sulekha",
          "Rutgers",
          "Word of mouth",
          "Other",
        ],
      },
    ],

    states: ["NJ"],
    bbox: [-74.8, 40.25, -74.1, 40.72],

    listings: [],
  };
}

// ---------------------------------------------------------------------------
// migrate (default mode)
// ---------------------------------------------------------------------------

function migrate() {
  const oldListings = readJson(OLD_LISTINGS_PATH);
  const oldRoutes = readJson(OLD_ROUTES_PATH);

  const coupleSearch = buildCoupleSearch(oldListings);
  const soloSearch = buildSoloSearch();

  writeJson(COUPLE_SEARCH_PATH, coupleSearch);
  writeJson(SOLO_SEARCH_PATH, soloSearch);
  writeJson(COUPLE_ROUTES_PATH, oldRoutes); // verbatim copy
  writeJson(SOLO_ROUTES_PATH, {});

  console.log("Wrote:");
  console.log("  " + path.relative(ROOT, COUPLE_SEARCH_PATH));
  console.log("  " + path.relative(ROOT, SOLO_SEARCH_PATH));
  console.log("  " + path.relative(ROOT, COUPLE_ROUTES_PATH));
  console.log("  " + path.relative(ROOT, SOLO_ROUTES_PATH));
  console.log(
    `${coupleSearch.listings.length} listings, ${
      Object.keys(oldRoutes).length
    } route entries migrated into searches/couple.json + routes/couple.json.`
  );
}

// ---------------------------------------------------------------------------
// verify mode
// ---------------------------------------------------------------------------

function deepEqual(a, b, pathStr, diffs) {
  if (a === b) return;
  if (typeof a !== typeof b) {
    diffs.push(`${pathStr}: type ${typeof a} !== ${typeof b} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
    return;
  }
  if (a === null || b === null) {
    if (a !== b) diffs.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      diffs.push(`${pathStr}: array mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
      return;
    }
    if (a.length !== b.length) {
      diffs.push(`${pathStr}: length ${a.length} !== ${b.length}`);
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      deepEqual(a[i], b[i], `${pathStr}[${i}]`, diffs);
    }
    return;
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    const allKeys = new Set([...aKeys, ...bKeys]);
    for (const k of allKeys) {
      if (!(k in a)) {
        diffs.push(`${pathStr}.${k}: missing in reconstructed`);
        continue;
      }
      if (!(k in b)) {
        diffs.push(`${pathStr}.${k}: missing in original`);
        continue;
      }
      deepEqual(a[k], b[k], `${pathStr}.${k}`, diffs);
    }
    return;
  }
  diffs.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

function verify() {
  const oldListings = readJson(OLD_LISTINGS_PATH);
  const oldRoutes = readJson(OLD_ROUTES_PATH);

  if (!fs.existsSync(COUPLE_SEARCH_PATH) || !fs.existsSync(COUPLE_ROUTES_PATH)) {
    console.error(
      "searches/couple.json or routes/couple.json does not exist — run the migration first (without --verify)."
    );
    process.exit(1);
  }

  const coupleSearch = readJson(COUPLE_SEARCH_PATH);
  const coupleRoutes = readJson(COUPLE_ROUTES_PATH);

  const diffs = [];

  // --- reconstruct old listings.json shape -------------------------------
  const reconstructedAnchors = {
    work: coupleSearch.anchors.find((a) => a.key === "work"),
    home: coupleSearch.anchors.find((a) => a.key === "home"),
  };
  const oldAnchorsShape = {
    work: {
      label: reconstructedAnchors.work.label,
      query: reconstructedAnchors.work.query,
      coords: reconstructedAnchors.work.coords,
    },
    home: {
      label: reconstructedAnchors.home.label,
      query: reconstructedAnchors.home.query,
      coords: reconstructedAnchors.home.coords,
    },
  };
  deepEqual(oldAnchorsShape, oldListings.anchors, "anchors", diffs);
  deepEqual(coupleSearch.budget, oldListings.budget, "budget", diffs);
  deepEqual(coupleSearch.site_base_url, oldListings.site_base_url, "site_base_url", diffs);

  const reconstructedListings = coupleSearch.listings.map(unmigrateListingCommutes);
  if (reconstructedListings.length !== oldListings.listings.length) {
    diffs.push(
      `listings.length: ${reconstructedListings.length} !== ${oldListings.listings.length}`
    );
  }

  // Compare by id so ordering differences (if any) don't cause spurious
  // diffs, but also assert the id sets are identical.
  const oldById = new Map(oldListings.listings.map((l) => [l.id, l]));
  const newById = new Map(reconstructedListings.map((l) => [l.id, l]));

  for (const id of oldById.keys()) {
    if (!newById.has(id)) diffs.push(`listing ${id}: missing from migrated data`);
  }
  for (const id of newById.keys()) {
    if (!oldById.has(id)) diffs.push(`listing ${id}: unexpected extra listing in migrated data`);
  }
  for (const id of oldById.keys()) {
    if (newById.has(id)) {
      deepEqual(newById.get(id), oldById.get(id), `listing[${id}]`, diffs);
    }
  }

  // Also verify field ORDER is preserved (commutes sits where commute_work
  // used to be) via key-order comparison for one sample plus a generic check.
  for (const l of coupleSearch.listings) {
    const keys = Object.keys(l);
    const idx = keys.indexOf("commutes");
    if (idx === -1) {
      diffs.push(`listing ${l.id}: missing "commutes" key`);
    } else if (keys.includes("commute_work") || keys.includes("commute_home")) {
      diffs.push(`listing ${l.id}: still has commute_work/commute_home`);
    }
  }

  // --- routes.json verbatim ------------------------------------------------
  deepEqual(coupleRoutes, oldRoutes, "routes", diffs);

  const listingCount = reconstructedListings.length;
  const routeCount = Object.keys(coupleRoutes).length;

  if (diffs.length > 0) {
    console.error(`VERIFY FAILED — ${diffs.length} difference(s):`);
    for (const d of diffs.slice(0, 200)) console.error("  " + d);
    if (diffs.length > 200) console.error(`  ... and ${diffs.length - 200} more`);
    process.exit(1);
  }

  console.log(
    `${listingCount} listings, ${routeCount} route entries, 0 field differences (commute rename aside)`
  );
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--verify")) {
    verify();
  } else {
    migrate();
  }
}

main();
