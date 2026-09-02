/**
 * Home Finder API — runs in front of the static site.
 *
 * Static assets are served automatically by the assets binding; only requests
 * that don't match a file (i.e. /api/*) reach this Worker.
 *
 * KV (HOMEFINDER_QUEUE) keys:
 *   pending:<id>  — a listing submitted through the site, awaiting triage.
 *     Value carries a `search` field (which search it was submitted against;
 *     missing ⇒ "couple") — the key itself stays a random id. Also carries
 *     `kind` (a short type key, e.g. "basement") and `extras` (an object of
 *     free-form per-kind facts, e.g. { utilities_included: true }) when the
 *     submission included them.
 *   hidden:<listing-id> — a published listing archived through the site
 *   fav:<listing-id>:<who> — a heart from matt or evelyn
 *   data:live:<search> — a fresher listings payload than the baked build for
 *     that search (see /api/data). `data:live` (no suffix) is the legacy,
 *     couple-only key from before multi-search — read as a fallback, never
 *     written anymore; drop after 2026-10.
 *
 * R2 (PHOTOS): listing images under photos/<listing-id>/<file>.jpg —
 * galleries as 01.jpg..NN.jpg, the dashboard thumbnail as thumb.jpg. Served
 * from /photos/*; uploaded by scripts/ingest.js (wrangler) or POST /api/photo.
 *
 * Secrets: HF_PIN — shared PIN required for every write endpoint.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const ok = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const err = (message, status = 400) => ok({ error: message }, status);

function pinOk(env, pin) {
  if (!env.HF_PIN) return "unconfigured";
  if (typeof pin !== "string" || pin.length === 0) return "missing";
  // Length-safe enough for a hobby PIN gate.
  return pin === env.HF_PIN ? "ok" : "wrong";
}

function requirePin(env, body) {
  const state = pinOk(env, body && body.pin);
  if (state === "unconfigured")
    return err("PIN not set up yet — run: wrangler secret put HF_PIN", 503);
  if (state !== "ok") return err("Wrong PIN", 403);
  return null;
}

async function listByPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.HOMEFINDER_QUEUE.list({ prefix, cursor });
    for (const key of page.keys) {
      const value = await env.HOMEFINDER_QUEUE.get(key.name, "json");
      if (value) out.push({ key: key.name, ...value });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

const MAX_PENDING = 100;
const STR_LIMIT = 2000;

// The Worker stays ignorant of the actual list of searches — it just needs a
// safe key to namespace KV/pending by. Unknown/missing/malformed ⇒ "couple"
// (the pre-multi-search default), which keeps every existing client working
// unchanged.
const SEARCH_RE = /^[a-z][a-z0-9-]{0,20}$/;
const searchOf = (v) => (typeof v === "string" && SEARCH_RE.test(v) ? v : "couple");

// Anchor/leg keys inside `commutes` / `routes` (e.g. "work", "home").
const LEG_KEY_RE = /^[a-z][a-z0-9_-]{0,20}$/;
const MAX_LEGS = 4;

// Listing "kind" (e.g. "basement", "room") — a per-search config concern,
// the Worker just needs a safe key. `extras` carries kind-specific facts.
const KIND_RE = /^[a-z][a-z0-9-]{0,30}$/;
const EXTRAS_KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_EXTRAS = 12;
const EXTRAS_STR_LIMIT = 200;

/** Keep only expected fields, truncate strings, no surprises into KV. */
function cleanSubmission(body) {
  const pick = (v) =>
    typeof v === "string" ? v.slice(0, STR_LIMIT).trim() || null : null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const pair = (v) =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number")
      ? v
      : null;
  const commute = (v) =>
    v && typeof v === "object"
      ? { min: num(v.min), miles: num(v.miles) }
      : null;
  const geometry = (v) =>
    Array.isArray(v) && v.length <= 1000 && v.every(pair) ? v : null;
  const routeLeg = (v) =>
    v && typeof v === "object"
      ? { min: num(v.min), miles: num(v.miles), geometry: geometry(v.geometry) }
      : null;
  // Clean an incoming `commutes`/`routes` object: valid leg keys only,
  // each value run through `leafCleaner`, capped at MAX_LEGS entries.
  const legMap = (v, leafCleaner) => {
    const out = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const key of Object.keys(v)) {
      if (!LEG_KEY_RE.test(key)) continue;
      const cleaned = leafCleaner(v[key]);
      if (cleaned) out[key] = cleaned;
      if (Object.keys(out).length >= MAX_LEGS) break;
    }
    return out;
  };

  // Legacy shape (pre-multi-search clients): commute_work/commute_home and
  // route_work/route_home. Fold these into commutes.work/.home and
  // routes.work/.home so ~30 days of already-queued items and any client
  // that hasn't been updated yet keep working.
  const legacyCommutes = {};
  const legacyCommuteWork = commute(body.commute_work);
  if (legacyCommuteWork) legacyCommutes.work = legacyCommuteWork;
  const legacyCommuteHome = commute(body.commute_home);
  if (legacyCommuteHome) legacyCommutes.home = legacyCommuteHome;

  const legacyRoutes = {};
  const legacyRouteWork = routeLeg(body.route_work);
  if (legacyRouteWork) legacyRoutes.work = legacyRouteWork;
  const legacyRouteHome = routeLeg(body.route_home);
  if (legacyRouteHome) legacyRoutes.home = legacyRouteHome;

  // New shape wins on key collision; legacy only fills in gaps. Re-cap at
  // MAX_LEGS after merging so a client can't combine both shapes to exceed it.
  const capLegs = (obj) => {
    const out = {};
    for (const key of Object.keys(obj).slice(0, MAX_LEGS)) out[key] = obj[key];
    return out;
  };
  const commutes = capLegs({ ...legacyCommutes, ...legMap(body.commutes, commute) });
  const routes = capLegs({ ...legacyRoutes, ...legMap(body.routes, routeLeg) });

  const kind = typeof body.kind === "string" && KIND_RE.test(body.kind) ? body.kind : null;

  const extrasValue = (v) => {
    if (typeof v === "boolean" || v === null) return { ok: true, value: v };
    if (typeof v === "number" && isFinite(v)) return { ok: true, value: v };
    if (typeof v === "string") {
      const trimmed = v.trim().slice(0, EXTRAS_STR_LIMIT);
      return trimmed ? { ok: true, value: trimmed } : { ok: false };
    }
    return { ok: false };
  };
  const extras = {};
  if (body.extras && typeof body.extras === "object" && !Array.isArray(body.extras)) {
    for (const key of Object.keys(body.extras)) {
      if (!EXTRAS_KEY_RE.test(key)) continue;
      const cleaned = extrasValue(body.extras[key]);
      if (!cleaned.ok) continue;
      extras[key] = cleaned.value;
      if (Object.keys(extras).length >= MAX_EXTRAS) break;
    }
  }

  return {
    url: pick(body.url),
    name: pick(body.name),
    address: pick(body.address),
    town: pick(body.town),
    // 2-letter state validation is a per-search config concern now, not the
    // Worker's — just keep it a clean short string.
    state: pick(body.state),
    rent: num(body.rent),
    beds: num(body.beds),
    notes: pick(body.notes),
    who: body.who === "evelyn" ? "evelyn" : "matt",
    coords: pair(body.coords), // [lat, lon] from client-side geocode
    search: searchOf(body.search),
    commutes,
    routes,
    kind,
    extras,
  };
}

const PHOTO_KEY_RE = /^photos\/[a-z0-9-]{1,80}\/[a-z0-9_-]{1,40}\.(jpg|jpeg|png|webp)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // Listing images live in R2, not in git. Immutable-cache them: a photo
    // never changes under the same key (new photos get new names).
    if (path.startsWith("/photos/") && request.method === "GET") {
      const key = path.slice(1);
      if (!PHOTO_KEY_RE.test(key)) return err("Not found", 404);
      const object = await env.PHOTOS.get(key);
      if (!object) return err("Not found", 404);
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
          etag: object.httpEtag,
        },
      });
    }

    if (!path.startsWith("/api")) return err("Not found", 404);

    if (request.method === "GET") {
      if (path === "/api/health") {
        return ok({ ok: true, pin_configured: Boolean(env.HF_PIN) });
      }
      if (path === "/api/pending") {
        const rows = await listByPrefix(env, "pending:");
        // No ?search: everything, as before (ingest/debug). With ?search=<key>,
        // only items stamped for that search — items with no `search` field
        // (pre-multi-search submissions) count as "couple".
        if (!url.searchParams.has("search")) return ok(rows);
        const want = searchOf(url.searchParams.get("search"));
        return ok(rows.filter((r) => searchOf(r.search) === want));
      }
      if (path === "/api/favorites") {
        const rows = await listByPrefix(env, "fav:");
        return ok(rows.map((r) => {
          const [, listingId, who] = r.key.split(":");
          return { listing_id: listingId, who, ts: r.ts };
        }));
      }
      if (path === "/api/data") {
        // Listings for the map and any live view: a pushed-live payload wins
        // over the baked build, so a sweep can go live without a deploy.
        // ?search=<key> selects which search's feed; missing/invalid ⇒ "couple".
        const key = searchOf(url.searchParams.get("search"));
        const live = await env.HOMEFINDER_QUEUE.get(`data:live:${key}`);
        if (live) {
          return new Response(live, {
            headers: { ...JSON_HEADERS, "x-hf-source": "live" },
          });
        }
        if (key === "couple") {
          // Legacy key from before per-search live payloads existed. Never
          // written anymore (POST /api/data always writes data:live:<search>)
          // — safe to delete this fallback once its 7-day TTL has long passed.
          const legacyLive = await env.HOMEFINDER_QUEUE.get("data:live");
          if (legacyLive) {
            return new Response(legacyLive, {
              headers: { ...JSON_HEADERS, "x-hf-source": "live" },
            });
          }
        }
        const baked = await env.ASSETS.fetch(
          new URL(`/assets/data/${key}.json`, url.origin)
        );
        return new Response(baked.body, {
          status: baked.status,
          headers: { ...JSON_HEADERS, "x-hf-source": "baked" },
        });
      }
      if (path === "/api/hidden") {
        const rows = await listByPrefix(env, "hidden:");
        return ok(rows.map((r) => ({
          listing_id: r.key.slice("hidden:".length),
          who: r.who,
          ts: r.ts,
          reason: r.reason || null,
        })));
      }
      return err("Not found", 404);
    }

    if (request.method !== "POST") return err("Method not allowed", 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return err("Body must be JSON");
    }
    const denied = requirePin(env, body);
    if (denied) return denied;

    if (path === "/api/submit") {
      const sub = cleanSubmission(body);
      if (!sub.url && !sub.address)
        return err("Give me at least a listing URL or an address");
      const existing = await env.HOMEFINDER_QUEUE.list({ prefix: "pending:" });
      if (existing.keys.length >= MAX_PENDING)
        return err("Pending queue is full — run a triage session first", 429);
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await env.HOMEFINDER_QUEUE.put(
        `pending:${id}`,
        JSON.stringify({ ...sub, id, ts: new Date().toISOString(), status: "pending" }),
        // Auto-expire: once triaged into the real data (or abandoned), the
        // pending copy quietly disappears — no PIN-gated cleanup required.
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
      return ok({ ok: true, id }, 201);
    }

    if (path === "/api/resolve") {
      // Remove a pending submission (mistake, or promoted by the pipeline).
      if (typeof body.id !== "string" || !/^[a-z0-9]+$/.test(body.id))
        return err("Bad id");
      await env.HOMEFINDER_QUEUE.delete(`pending:${body.id}`);
      return ok({ ok: true });
    }

    if (path === "/api/archive") {
      const id = body.listing_id;
      if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/.test(id))
        return err("Bad listing_id");
      await env.HOMEFINDER_QUEUE.put(
        `hidden:${id}`,
        JSON.stringify({
          who: body.who === "evelyn" ? "evelyn" : "matt",
          ts: new Date().toISOString(),
          reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
        })
      );
      return ok({ ok: true });
    }

    if (path === "/api/favorite") {
      const id = body.listing_id;
      if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/.test(id))
        return err("Bad listing_id");
      const who = body.who === "evelyn" ? "evelyn" : "matt";
      const key = `fav:${id}:${who}`;
      if (body.on === false) {
        await env.HOMEFINDER_QUEUE.delete(key);
      } else {
        await env.HOMEFINDER_QUEUE.put(
          key,
          JSON.stringify({ ts: new Date().toISOString() })
        );
      }
      return ok({ ok: true, on: body.on !== false });
    }

    if (path === "/api/photo") {
      // Remote ingest (e.g. a Cowork sweep without wrangler auth) uploads
      // photos here; ~100 KB each, base64 in JSON.
      const key = body.key;
      if (typeof key !== "string" || !PHOTO_KEY_RE.test(key))
        return err("Bad key — want photos/<listing-id>/<file>.jpg");
      if (typeof body.data !== "string" || body.data.length > 2_800_000)
        return err("Bad data — base64 image up to ~2 MB");
      let bytes;
      try {
        bytes = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0));
      } catch {
        return err("data is not valid base64");
      }
      await env.PHOTOS.put(key, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      return ok({ ok: true, key, bytes: bytes.length }, 201);
    }

    if (path === "/api/data") {
      // Push a fresher listings payload than the deployed build, for one
      // search. Expires on its own; a fresh deploy simply out-dates it and
      // ingest re-pushes.
      if (!body.data || typeof body.data !== "object")
        return err("Bad data — want the /api/data JSON shape");
      const key = searchOf(body.search);
      await env.HOMEFINDER_QUEUE.put(`data:live:${key}`, JSON.stringify(body.data), {
        expirationTtl: 60 * 60 * 24 * 7,
      });
      return ok({ ok: true });
    }

    if (path === "/api/unarchive") {
      const id = body.listing_id;
      if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/.test(id))
        return err("Bad listing_id");
      await env.HOMEFINDER_QUEUE.delete(`hidden:${id}`);
      return ok({ ok: true });
    }

    return err("Not found", 404);
  },
};
