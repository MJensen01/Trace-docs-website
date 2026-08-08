/**
 * Home Finder API — runs in front of the static site.
 *
 * Static assets are served automatically by the assets binding; only requests
 * that don't match a file (i.e. /api/*) reach this Worker.
 *
 * KV (HOMEFINDER_QUEUE) keys:
 *   pending:<id>  — a listing submitted through the site, awaiting triage
 *   hidden:<listing-id> — a published listing archived through the site
 *   fav:<listing-id>:<who> — a heart from matt or evelyn
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

  return {
    url: pick(body.url),
    name: pick(body.name),
    address: pick(body.address),
    town: pick(body.town),
    state: body.state === "PA" || body.state === "NJ" ? body.state : pick(body.state),
    rent: num(body.rent),
    beds: num(body.beds),
    notes: pick(body.notes),
    who: body.who === "evelyn" ? "evelyn" : "matt",
    coords: pair(body.coords), // [lat, lon] from client-side geocode
    commute_work: commute(body.commute_work),
    commute_home: commute(body.commute_home),
    route_work: routeLeg(body.route_work),
    route_home: routeLeg(body.route_home),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    if (!path.startsWith("/api")) return err("Not found", 404);

    if (request.method === "GET") {
      if (path === "/api/health") {
        return ok({ ok: true, pin_configured: Boolean(env.HF_PIN) });
      }
      if (path === "/api/pending") return ok(await listByPrefix(env, "pending:"));
      if (path === "/api/favorites") {
        const rows = await listByPrefix(env, "fav:");
        return ok(rows.map((r) => {
          const [, listingId, who] = r.key.split(":");
          return { listing_id: listingId, who, ts: r.ts };
        }));
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
