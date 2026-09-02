/**
 * homes.js — prepares the raw search/listing/route data for the templates.
 *
 * The site is N independent searches sharing one codebase. Each search is a
 * file in src/_data/searches/<key>.json (anchors, budget, kinds, facts,
 * listings) with its route geometry alongside in src/_data/routes/<key>.json.
 * Those files are written by the listing-search pipeline and stay untouched;
 * everything derived for display happens here so the Nunjucks templates stay
 * simple.
 *
 * Exports: { searches, byKey, primary, listingPages } — see the contract in
 * plan §3.1. Templates read `homes.*` only, never the raw `searches.*` /
 * `routes.*` globals that Eleventy's data cascade also exposes.
 */

const fs = require("fs");
const path = require("path");

const SEARCH_DIR = path.join(__dirname, "searches");
const ROUTE_DIR = path.join(__dirname, "routes");

/**
 * Listing images live in R2 (served from /photos/ by the Worker), not in git.
 * photos.json is the manifest — per listing id: `thumb` (dashboard thumbnail
 * exists) and `gallery` (ordered filenames, hero first). It is GLOBAL across
 * searches, because listing ids are globally unique. Maintained by
 * scripts/ingest.js.
 */
const photos = require("./photos.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function thumbUrl(photoManifest, id) {
  const entry = photoManifest[id];
  if (!entry) return null;
  if (entry.thumb) return `/photos/${id}/thumb.jpg`;
  if (entry.gallery && entry.gallery.length)
    return `/photos/${id}/${entry.gallery[0]}`;
  return null;
}

function galleryUrls(photoManifest, id) {
  const entry = photoManifest[id];
  if (!entry || !entry.gallery) return [];
  return entry.gallery.map((file) => `/photos/${id}/${file}`);
}

/** Abbreviations that end in "." but do not end a sentence. */
const ABBREVIATIONS = new Set([
  "approx", "incl", "est", "min", "max", "mo", "yr", "sq", "ft", "st", "rd",
  "ave", "dr", "blvd", "apt", "no", "vs", "etc", "e.g", "i.e", "ca", "w",
]);

/**
 * Turn a prose blob of pros/cons into discrete bullets.
 * Splits on "; " first, then on sentence boundaries.
 */
function toBullets(text) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces = [];
  for (const clause of trimmed.split(/;\s+/)) {
    let buffer = "";
    // Split after . ! ? when followed by whitespace + a new "sentence start".
    const parts = clause.split(/(?<=[.!?])\s+(?=[A-Z0-9$"'(])/);
    for (const part of parts) {
      const candidate = buffer ? `${buffer} ${part}` : part;
      const lastWord = (buffer ? part : candidate)
        .replace(/[)"']+$/, "")
        .split(/\s+/)
        .pop()
        .replace(/\.$/, "")
        .toLowerCase();
      // Keep abbreviations and single initials glued to the next fragment.
      if (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord)) {
        buffer = candidate;
        continue;
      }
      buffer = "";
      pieces.push(candidate);
    }
    if (buffer) pieces.push(buffer);
  }

  return pieces
    .map((piece) => piece.trim().replace(/[;,]$/, ""))
    .filter((piece) => piece.length > 1)
    // Read as bullets, not sentence fragments: drop the trailing full stop and
    // give each one a capital so the semicolon clauses line up with the rest.
    .map((piece) => piece.replace(/\.$/, ""))
    .map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1))
    .filter((piece) => piece.length > 1);
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function commuteLabel(commute) {
  if (!commute || commute.min === null || commute.min === undefined) return null;
  const mins = `${Math.round(commute.min)} min`;
  if (commute.miles === null || commute.miles === undefined) return mins;
  return `${mins} · ${Number(commute.miles).toFixed(1)} mi`;
}

function niceNumber(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toLocaleString("en-US");
}

/** "1.5" -> "1.5", "1" -> "1" */
function bathLabel(value) {
  if (value === null || value === undefined) return null;
  return String(Number(value));
}

/** Bare whole minutes, for the compact table + sidebar rows. */
function minutes(commute) {
  if (!commute || commute.min === null || commute.min === undefined) return null;
  return Math.round(commute.min);
}

function longDate(iso) {
  if (!iso) return null;
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortDate(iso) {
  if (!iso) return null;
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Comparable form of a listing URL — no scheme, no www, no query, no trailing
 * slash. Mirrors HF.normUrl() in assets/js/hf.js: the pending strip compares
 * these to hide a submission that is already published here.
 */
function urlKey(value) {
  if (!value || typeof value !== "string") return null;
  const stripped = value.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("#")[0];
  const key = stripped.split("?")[0].replace(/\/+$/, "") || null;
  // Facebook post URLs are otherwise indistinguishable without their query
  // (…/photo/?fbid=123 vs …/photo/?fbid=456), so keep the one identifying param.
  const host = stripped.split("/")[0];
  if (key && (host === "facebook.com" || host === "m.facebook.com")) {
    const query = stripped.includes("?") ? stripped.slice(stripped.indexOf("?") + 1) : "";
    for (const p of ["fbid", "story_fbid", "id", "set"]) {
      const m = query.match(new RegExp(`(?:^|&)${p}=([^&]*)`));
      if (m) return `${key}?${p}=${decodeURIComponent(m[1])}`;
    }
  }
  return key;
}

/**
 * Band keys and their sort order are fixed site-wide (the CSS tokens and the
 * marker colours key off them); only the thresholds and the LABELS are per
 * search, via the search file's `bandLabels`. `rank` is the order the /all/
 * table sorts bands in — best fit first.
 */
const BAND_ORDER = ["in-budget", "stretch", "over", "unknown"];
const BAND_LABEL_DEFAULTS = {
  "in-budget": "In budget",
  stretch: "Stretch",
  over: "Over budget",
  unknown: "Rent unknown",
};

const VERIFICATION = {
  verified: { label: "Verified", tone: "good" },
  unverified: { label: "Unverified", tone: "warn" },
  "needs-call": { label: "Needs a call", tone: "warn" },
  gone: { label: "No longer listed", tone: "bad" },
};

const TIERS = {
  1: "Tier 1 · best fit",
  2: "Tier 2 · good option",
  3: "Tier 3 · worth a look",
};

/** "New" badge window: listings added within this many days of the data date. */
const NEW_WINDOW_DAYS = 3;

/**
 * Everything one search needs for the templates.
 *
 * Declaration order matters here: `buildFeed` and the SearchRef close over
 * `counts` / `knownUrls` / `browse`, so those are computed before use rather
 * than hoisted into a temporal-dead-zone crash (plan §8.5).
 */
function deriveSearch(raw, routes, photoManifest) {
  const budget = raw.budget || {};
  const bandLabels = raw.bandLabels || {};

  const bands = {};
  BAND_ORDER.forEach((key, rank) => {
    bands[key] = {
      key,
      label: bandLabels[key] || BAND_LABEL_DEFAULTS[key],
      rank,
    };
  });
  const bandList = BAND_ORDER.map((key) => bands[key]);

  // ORDERED — the anchor order in the search file is the order every commute
  // row, column, chip and map legend renders in.
  const anchors = (raw.anchors || []).map((anchor) => ({
    key: anchor.key,
    label: anchor.label || anchor.key,
    short: anchor.short || anchor.label || anchor.key,
    color: anchor.color || "#64748b",
    glyph: anchor.glyph || "📍",
    lat: Array.isArray(anchor.coords) ? anchor.coords[1] : null,
    lon: Array.isArray(anchor.coords) ? anchor.coords[0] : null,
    maxMin: typeof anchor.maxMin === "number" ? anchor.maxMin : null,
    // "bonus" anchor: shown everywhere (drive time, route, red flag over
    // maxMin) but excluded from the sweep's keep rule. Defaults to true.
    hard: anchor.hard !== false,
  }));

  const kinds = (raw.kinds || []).map((kind) => ({
    key: kind.key,
    label: kind.label || kind.key,
    short: kind.short || kind.label || kind.key,
    chip: kind.chip || null,
    prefix: kind.prefix || null,
    // Optional "Before you tour" list, rendered on the listing page and in the
    // map detail panel for listings of this kind.
    checklist: Array.isArray(kind.checklist) ? kind.checklist.slice() : [],
  }));
  const kindByKey = Object.fromEntries(kinds.map((k) => [k.key, k]));

  const facts = (raw.facts || []).map((fact) => ({
    key: fact.key,
    label: fact.label || fact.key,
    type: fact.type || "text",
    chip: fact.chip || null,
    column: Boolean(fact.column),
    form: Boolean(fact.form),
    options: Array.isArray(fact.options) ? fact.options.slice() : null,
  }));

  const states = Array.isArray(raw.states) ? raw.states.slice() : [];

  const updatedMs = Date.parse(`${raw.updated}T12:00:00Z`);
  function isNew(dateAdded) {
    if (!dateAdded || Number.isNaN(updatedMs)) return false;
    const added = Date.parse(`${dateAdded}T12:00:00Z`);
    if (Number.isNaN(added)) return false;
    return (updatedMs - added) / 86400000 <= NEW_WINDOW_DAYS;
  }

  /** A fact value counts as "known" only when it is present and non-null. */
  function factValue(listing, fact) {
    const value = listing[fact.key];
    if (value === null || value === undefined) return null;
    return value;
  }

  function factValueLabel(fact, value) {
    if (value === null || value === undefined) return null;
    if (fact.type === "bool") return value ? "Yes" : "No";
    if (fact.type === "number") return niceNumber(value);
    return String(value);
  }

  const listings = (raw.listings || []).map((listing, index) => {
    const band = bands[listing.band] || bands.unknown;
    const verification = VERIFICATION[listing.verification] || {
      label: listing.verification || "Unknown",
      tone: "warn",
    };

    // Commutes: one entry per anchor, keyed by anchor key, plus an ordered
    // list for templates that just want to loop. `slow` comes from the
    // anchor's own maxMin — no module-wide commute constant any more.
    const rawCommutes = listing.commutes || {};
    const commutes = {};
    const commuteList = anchors.map((anchor) => {
      const leg = rawCommutes[anchor.key] || {};
      const min = leg.min === null || leg.min === undefined ? null : leg.min;
      const entry = {
        min,
        miles: leg.miles === null || leg.miles === undefined ? null : leg.miles,
        label: commuteLabel(leg),
        mins: minutes(leg),
        slow:
          typeof min === "number" &&
          typeof anchor.maxMin === "number" &&
          min > anchor.maxMin,
      };
      commutes[anchor.key] = entry;
      return { anchor, ...entry };
    });

    const route = routes[listing.id] || null;
    const hasRoute = Boolean(
      route &&
        anchors.some(
          (a) => route[a.key] && route[a.key].geometry && route[a.key].geometry.length
        )
    );

    const overBy =
      listing.rent && budget.max && listing.rent > budget.max
        ? listing.rent - budget.max
        : null;

    const specs = [];
    if (listing.beds !== null && listing.beds !== undefined) {
      specs.push(`${listing.beds} bd`);
    }
    if (listing.baths !== null && listing.baths !== undefined) {
      specs.push(`${bathLabel(listing.baths)} ba`);
    }
    if (listing.sqft) specs.push(`${niceNumber(listing.sqft)} sf`);

    // Declared extra fields only. A missing/null value means "unknown" — it is
    // left out of both, so templates can show "Not listed".
    const extras = {};
    const extraList = [];
    for (const fact of facts) {
      const value = factValue(listing, fact);
      if (value === null) continue;
      extras[fact.key] = value;
      extraList.push({
        key: fact.key,
        label: fact.label,
        type: fact.type,
        value,
        valueLabel: factValueLabel(fact, value),
      });
    }

    const kind = kindByKey[listing.kind] || null;
    const gallery = galleryUrls(photoManifest, listing.id);

    return {
      ...listing,
      index,
      title: listing.name || listing.address || `${listing.town}, ${listing.state}`,
      subtitle: listing.name ? listing.address : null,
      place: `${listing.town}, ${listing.state}`,
      img: thumbUrl(photoManifest, listing.id),
      gallery,
      galleryCount: gallery.length,
      isNew: isNew(listing.date_added),
      rentLabel: money(listing.rent),
      band,
      bandKey: band.key,
      bandRank: band.rank,
      verificationInfo: verification,
      isGone: listing.verification === "gone",
      tierLabel: TIERS[listing.tier] || `Tier ${listing.tier}`,
      overBy,
      overByLabel: money(overBy),
      specs,
      bedsLabel:
        listing.beds === null || listing.beds === undefined
          ? null
          : listing.beds === 0
            ? "Studio"
            : String(listing.beds),
      bathsLabel: bathLabel(listing.baths),
      sqftLabel: listing.sqft ? `${niceNumber(listing.sqft)} sf` : null,
      kindLabel: kind ? kind.label : listing.kind || null,
      // Short form for the /all/ table, where every column has to stay narrow.
      kindShort: kind ? kind.short : listing.kind || null,
      checklist: kind ? kind.checklist : [],
      commutes,
      commuteList,
      extras,
      extraList,
      bedsBathsLabel:
        listing.beds === null || listing.beds === undefined
          ? null
          : `${listing.beds}/${bathLabel(listing.baths) || "?"}`,
      searchText: [listing.name, listing.address, listing.town, listing.state]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
      prosList: toBullets(listing.pros),
      consList: toBullets(listing.cons),
      lastCheckedLabel: shortDate(listing.last_checked),
      addedLabel: shortDate(listing.date_added),
      lat: Array.isArray(listing.coords) ? listing.coords[1] : null,
      lon: Array.isArray(listing.coords) ? listing.coords[0] : null,
      route,
      hasRoute,
      url: listing.url_status === "dead" ? null : listing.url || null,
      stars: Array.from({ length: 5 }, (_, i) => i < (listing.rating || 0)),
    };
  });

  // Prev / next in source order, so the detail pages chain together. They stay
  // WITHIN this search, and they are slim {id, title} stubs so that
  // JSON.stringify(listing) never walks the whole chain (plan §8.6).
  const stub = (l) => ({ id: l.id, title: l.title });
  listings.forEach((listing, i) => {
    listing.prev = stub(i > 0 ? listings[i - 1] : listings[listings.length - 1]);
    listing.next = stub(i < listings.length - 1 ? listings[i + 1] : listings[0]);
  });

  /**
   * The listing browser (sidebar on desktop, drawer on mobile) shows every
   * listing in source order, so it reads the same way as the prev / next links.
   * The only exception is the handful that are gone: those sink to the bottom,
   * dimmed, exactly like the dashboard does.
   */
  const browse = listings
    .slice()
    .sort((a, b) =>
      a.isGone === b.isGone ? a.index - b.index : a.isGone ? 1 : -1
    )
    .map((l) => ({
      id: l.id,
      title: l.title,
      rentLabel: l.rentLabel,
      bandKey: l.bandKey,
      mins: Object.fromEntries(anchors.map((a) => [a.key, l.commutes[a.key].mins])),
      isGone: l.isGone,
    }));

  const count = (predicate) => listings.filter(predicate).length;

  const byKind = Object.fromEntries(kinds.map((k) => [k.key, 0]));
  const byState = Object.fromEntries(states.map((s) => [s, 0]));
  for (const l of listings) {
    if (l.kind) byKind[l.kind] = (byKind[l.kind] || 0) + 1;
    if (l.state) byState[l.state] = (byState[l.state] || 0) + 1;
  }

  const counts = {
    total: listings.length,
    inBudget: count((l) => l.bandKey === "in-budget"),
    stretch: count((l) => l.bandKey === "stretch"),
    over: count((l) => l.bandKey === "over"),
    unknown: count((l) => l.bandKey === "unknown"),
    gone: count((l) => l.isGone),
    topRated: count((l) => (l.rating || 0) >= 4),
    fresh: count((l) => l.isNew && !l.isGone),
    withPhoto: count((l) => Boolean(l.img)),
    byKind,
    byState,
  };

  /**
   * Filter chip definitions, generated once and consumed by the map page, the
   * card list and map-app.js. State chips only earn their place when the
   * search actually spans more than one state; bool facts become chips when
   * the search file gives them a short `chip` label.
   */
  const filters = [
    { group: "all", value: "", label: "All" },
    ...bandList.map((b) => ({
      group: "band",
      value: b.key,
      label: b.label,
      band: b.key,
    })),
    ...kinds.map((k) => ({ group: "kind", value: k.key, label: k.chip || k.label })),
    ...(states.length > 1
      ? states.map((s) => ({ group: "state", value: s, label: s }))
      : []),
    ...facts
      .filter((f) => f.type === "bool" && f.chip)
      .map((f) => ({ group: "fact", value: f.key, label: f.chip })),
    { group: "rating", value: "4", label: "★ 4+" },
    { group: "new", value: "1", label: "New" },
    { group: "fav", value: "1", label: "Favorites", heart: true },
  ];

  /** Slim payload for the map page — keeps the inline JSON small. */
  const mapPoints = listings
    .filter((l) => l.lat !== null && l.lon !== null)
    .map((l) => ({
      id: l.id,
      title: l.title,
      place: l.place,
      lat: l.lat,
      lon: l.lon,
      band: l.bandKey,
      bandLabel: l.band.label,
      kind: l.kind,
      rent: l.rentLabel,
      beds: l.bedsLabel,
      baths: l.bathsLabel,
      commutes: Object.fromEntries(
        anchors.map((a) => [a.key, { min: l.commutes[a.key].min, slow: l.commutes[a.key].slow }])
      ),
      rating: l.rating || 0,
      gone: l.isGone,
    }));

  const knownUrls = [];
  for (const listing of raw.listings || []) {
    const candidates = [listing.url, listing.v1_url].concat(
      Array.isArray(listing.v1_urls) ? listing.v1_urls : []
    );
    for (const candidate of candidates) {
      const key = urlKey(candidate);
      if (key && !knownUrls.includes(key)) knownUrls.push(key);
    }
  }

  const updatedLabel = longDate(raw.updated);
  const updatedShortLabel = shortDate(raw.updated);
  const budgetMaxLabel = money(budget.max);
  const budgetStretchLabel = money(budget.stretch_max);

  /**
   * The slim, JSON-safe backref hung off every listing. It deliberately has no
   * `listings` and no `feed`: those would make JSON.stringify(listing) throw
   * (and silently break jsonScript / | dump). `browse` is included so the
   * listing page's sidebar can render without reaching back into the full
   * Search (plan §4.6).
   */
  const ref = {
    key: raw.key,
    label: raw.label,
    shortLabel: raw.shortLabel,
    basePath: raw.basePath,
    updatedLabel,
    updatedShortLabel,
    anchors,
    kinds,
    facts,
    bands,
    states,
    budget,
    budgetMaxLabel,
    budgetStretchLabel,
    counts,
    browse,
  };

  for (const listing of listings) listing.search = ref;

  /**
   * Machine-readable feed of this search, baked to /assets/data/<key>.json and
   * served through GET /api/data?search=<key> (where a pushed-live payload can
   * override it between deploys). Slim on purpose: no route geometry, no
   * prev/next, no backrefs.
   */
  const feed = {
    key: raw.key,
    label: raw.label,
    basePath: raw.basePath,
    version: raw.version,
    updated: raw.updated,
    budget,
    bandLabels: Object.fromEntries(bandList.map((b) => [b.key, b.label])),
    anchors,
    kinds,
    facts,
    filters,
    counts,
    points: mapPoints,
    knownUrls,
    listings: listings.map((l) => ({
      id: l.id,
      title: l.title,
      subtitle: l.subtitle,
      place: l.place,
      town: l.town,
      state: l.state,
      kind: l.kind,
      kindLabel: l.kindLabel,
      kindShort: l.kindShort,
      checklist: l.checklist,
      band: l.bandKey,
      bandLabel: l.band.label,
      tier: l.tier,
      tierLabel: l.tierLabel,
      rent: l.rent ?? null,
      rentLabel: l.rentLabel,
      beds: l.beds ?? null,
      baths: l.baths ?? null,
      sqft: l.sqft ?? null,
      bedsLabel: l.bedsLabel,
      bathsLabel: l.bathsLabel,
      sqftLabel: l.sqftLabel,
      rating: l.rating || 0,
      commutes: l.commutes,
      extras: l.extras,
      lat: l.lat,
      lon: l.lon,
      url: l.url,
      img: l.img,
      gallery: l.gallery,
      isNew: l.isNew,
      isGone: l.isGone,
      verification: l.verification,
      verificationLabel: l.verificationInfo.label,
      verificationTone: l.verificationInfo.tone,
      pros: l.prosList,
      cons: l.consList,
      notes: l.notes || null,
      lease: l.lease || null,
      moveIn: l.move_in_cost || null,
      available: l.available || null,
      overByLabel: l.overByLabel,
      date_added: l.date_added || null,
      addedLabel: l.addedLabel,
    })),
  };

  return {
    key: raw.key,
    label: raw.label,
    shortLabel: raw.shortLabel,
    blurb: raw.blurb || null,
    basePath: raw.basePath,
    order: typeof raw.order === "number" ? raw.order : 99,
    isPrimary: Boolean(raw.primary),
    version: raw.version,
    updated: raw.updated,
    updatedLabel,
    updatedShortLabel,
    budget,
    budgetMaxLabel,
    budgetStretchLabel,
    anchors,
    kinds,
    kindByKey,
    facts,
    bands,
    states,
    counts,
    filters,
    listings,
    browse,
    mapPoints,
    knownUrls,
    feed,
    ref,
  };
}

// ---------------------------------------------------------------------------
// Load every search file (no hardcoded list — dropping a new JSON in
// src/_data/searches/ is all it takes to add a search) with its routes file.
// ---------------------------------------------------------------------------

const searches = fs
  .readdirSync(SEARCH_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const raw = readJson(path.join(SEARCH_DIR, file));
    const routeFile = path.join(ROUTE_DIR, `${raw.key}.json`);
    const routes = fs.existsSync(routeFile) ? readJson(routeFile) : {};
    return deriveSearch(raw, routes, photos);
  })
  .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

const byKey = Object.fromEntries(searches.map((s) => [s.key, s]));

const primaries = searches.filter((s) => s.isPrimary);
if (primaries.length !== 1) {
  throw new Error(
    `homes.js: exactly one search must set "primary": true (found ${primaries.length}` +
      `${primaries.length ? `: ${primaries.map((s) => s.key).join(", ")}` : ""}). ` +
      `Fix src/_data/searches/*.json.`
  );
}

/** Flat, every listing of every search — listing.njk paginates this. */
const listingPages = searches.flatMap((s) => s.listings);

module.exports = {
  searches,
  byKey,
  primary: primaries[0],
  listingPages,
};
