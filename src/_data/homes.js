/**
 * homes.js — prepares the raw listing/route data for the templates.
 *
 * listings.json and routes.json stay untouched (they are written by the
 * listing-search pipeline). Everything derived for display happens here so the
 * Nunjucks templates stay simple.
 */

const raw = require("./listings.json");
const routes = require("./routes.json");

/**
 * Listing images live in R2 (served from /photos/ by the Worker), not in git.
 * photos.json is the manifest — per listing id: `thumb` (dashboard thumbnail
 * exists) and `gallery` (ordered filenames, hero first). It is maintained by
 * scripts/ingest.js.
 */
const photos = require("./photos.json");

function thumbUrl(id) {
  const entry = photos[id];
  if (!entry) return null;
  if (entry.thumb) return `/photos/${id}/thumb.jpg`;
  if (entry.gallery && entry.gallery.length)
    return `/photos/${id}/${entry.gallery[0]}`;
  return null;
}

function galleryUrls(id) {
  const entry = photos[id];
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

// `rank` is the order the /all/ table sorts bands in — best fit first.
const BANDS = {
  "in-budget": { label: "In budget", key: "in-budget", rank: 0 },
  stretch: { label: "Stretch", key: "stretch", rank: 1 },
  over: { label: "Over budget", key: "over", rank: 2 },
  unknown: { label: "Rent unknown", key: "unknown", rank: 3 },
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

const SLOW_COMMUTE_MIN = 30;

/** "New" badge window: listings added within this many days of the data date. */
const NEW_WINDOW_DAYS = 3;

const budget = raw.budget || {};

const updatedMs = Date.parse(`${raw.updated}T12:00:00Z`);
function isNew(dateAdded) {
  if (!dateAdded || Number.isNaN(updatedMs)) return false;
  const added = Date.parse(`${dateAdded}T12:00:00Z`);
  if (Number.isNaN(added)) return false;
  return (updatedMs - added) / 86400000 <= NEW_WINDOW_DAYS;
}

const listings = raw.listings.map((listing, index) => {
  const band = BANDS[listing.band] || BANDS.unknown;
  const verification = VERIFICATION[listing.verification] || {
    label: listing.verification || "Unknown",
    tone: "warn",
  };
  const work = listing.commute_work || {};
  const home = listing.commute_home || {};
  const route = routes[listing.id] || null;
  const hasRoute = Boolean(
    route &&
      ((route.work && route.work.geometry && route.work.geometry.length) ||
        (route.home && route.home.geometry && route.home.geometry.length))
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

  return {
    ...listing,
    index,
    title: listing.name || listing.address || `${listing.town}, ${listing.state}`,
    subtitle: listing.name ? listing.address : null,
    place: `${listing.town}, ${listing.state}`,
    img: thumbUrl(listing.id),
    gallery: galleryUrls(listing.id),
    galleryCount: galleryUrls(listing.id).length,
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
    workLabel: commuteLabel(work),
    homeLabel: commuteLabel(home),
    workMin: work.min ?? null,
    homeMin: home.min ?? null,
    workMins: minutes(work),
    homeMins: minutes(home),
    // Short forms for the /all/ table, where every column has to stay narrow.
    kindShort: listing.kind === "townhouse" ? "Town" : "Apt",
    bedsBathsLabel:
      listing.beds === null || listing.beds === undefined
        ? null
        : `${listing.beds}/${bathLabel(listing.baths) || "?"}`,
    searchText: [listing.name, listing.address, listing.town, listing.state]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    workSlow: typeof work.min === "number" && work.min > SLOW_COMMUTE_MIN,
    homeSlow: typeof home.min === "number" && home.min > SLOW_COMMUTE_MIN,
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

// Prev / next in source order, so the detail pages chain together.
listings.forEach((listing, i) => {
  listing.prev = i > 0 ? listings[i - 1] : listings[listings.length - 1];
  listing.next = i < listings.length - 1 ? listings[i + 1] : listings[0];
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
    workMins: l.workMins,
    homeMins: l.homeMins,
    isGone: l.isGone,
  }));

const count = (predicate) => listings.filter(predicate).length;

const counts = {
  total: listings.length,
  inBudget: count((l) => l.band.key === "in-budget"),
  stretch: count((l) => l.band.key === "stretch"),
  over: count((l) => l.band.key === "over"),
  unknown: count((l) => l.band.key === "unknown"),
  apartments: count((l) => l.kind === "apartment"),
  townhouses: count((l) => l.kind === "townhouse"),
  pa: count((l) => l.state === "PA"),
  nj: count((l) => l.state === "NJ"),
  topRated: count((l) => (l.rating || 0) >= 4),
  gone: count((l) => l.isGone),
  withPhoto: count((l) => Boolean(l.img)),
  fresh: count((l) => l.isNew && !l.isGone),
};

/** Slim payload for the /map/ page — keeps the inline JSON small. */
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
    rent: l.rentLabel,
    beds: l.bedsLabel,
    baths: l.bathsLabel,
    work: l.workLabel,
    home: l.homeLabel,
    workSlow: l.workSlow,
    rating: l.rating || 0,
    gone: l.isGone,
  }));

/**
 * Machine-readable feed of the dataset, baked to /assets/data/listings.json
 * and served through GET /api/data (where a pushed-live payload can override
 * it between deploys). Slim on purpose: no route geometry, no prev/next.
 */
function buildFeed(anchors) {
  return {
  version: raw.version,
  updated: raw.updated,
  budget,
  anchors,
  counts,
  points: mapPoints,
  listings: listings.map((l) => ({
    id: l.id,
    title: l.title,
    subtitle: l.subtitle,
    place: l.place,
    town: l.town,
    state: l.state,
    kind: l.kind,
    band: l.bandKey,
    tier: l.tier,
    rent: l.rent ?? null,
    beds: l.beds ?? null,
    baths: l.baths ?? null,
    sqft: l.sqft ?? null,
    rating: l.rating || 0,
    workMins: l.workMins,
    homeMins: l.homeMins,
    lat: l.lat,
    lon: l.lon,
    url: l.url,
    img: l.img,
    gallery: l.gallery,
    isNew: l.isNew,
    isGone: l.isGone,
    verification: l.verification,
    date_added: l.date_added || null,
  })),
  };
}

/**
 * Comparable form of a listing URL — no scheme, no www, no query, no trailing
 * slash. Mirrors HF.normUrl() in assets/js/hf.js: the pending strip compares
 * these to hide a submission that is already published here.
 */
function urlKey(value) {
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

const knownUrls = [];
for (const listing of raw.listings) {
  const candidates = [listing.url, listing.v1_url].concat(
    Array.isArray(listing.v1_urls) ? listing.v1_urls : []
  );
  for (const candidate of candidates) {
    const key = urlKey(candidate);
    if (key && !knownUrls.includes(key)) knownUrls.push(key);
  }
}

const anchors = {
  work: {
    label: raw.anchors?.work?.label || "Work",
    short: "Fairless Hills",
    lat: raw.anchors?.work?.coords?.[1] ?? null,
    lon: raw.anchors?.work?.coords?.[0] ?? null,
  },
  home: {
    label: raw.anchors?.home?.label || "Home",
    short: "East Brunswick",
    lat: raw.anchors?.home?.coords?.[1] ?? null,
    lon: raw.anchors?.home?.coords?.[0] ?? null,
  },
};

module.exports = {
  version: raw.version,
  updated: raw.updated,
  updatedLabel: longDate(raw.updated),
  updatedShortLabel: shortDate(raw.updated),
  budget,
  budgetMaxLabel: money(budget.max),
  budgetStretchLabel: money(budget.stretch_max),
  anchors,
  counts,
  listings,
  browse,
  mapPoints,
  knownUrls,
  feed: buildFeed(anchors),
};
