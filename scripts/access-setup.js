#!/usr/bin/env node
/**
 * access-setup.js — put trace-docs.com behind Cloudflare Access so only the
 * allow-listed emails can reach it (site, /api/*, /photos/* — everything).
 *
 *   CF_API_TOKEN=... node scripts/access-setup.js [--team <name>] [--dry]
 *
 * Needs an API token scoped to this account with:
 *   Access: Apps and Policies                          → Edit
 *   Access: Organizations, Identity Providers & Groups → Edit
 *
 * Idempotent: creates the Zero Trust org (if missing), makes sure the
 * One-time PIN login method exists, then creates or updates the "Home Finder"
 * Access application for HOSTNAME with a single allow policy for EMAILS.
 * Login flow for users: enter email → 6-digit code by email → in for 30 days.
 */

const ACCOUNT = "a847b1efe32265d69f8f7e66ef25b5c3";
const HOSTNAME = "trace-docs.com";
const APP_NAME = "Home Finder";
const EMAILS = ["mij998@gmail.com", "ena23luna@gmail.com"];
// The account's existing Zero Trust org. Only used if no org exists yet (it does:
// mjensen1.cloudflareaccess.com), so this is a fallback, not a rename.
const DEFAULT_TEAM = "mjensen1";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const teamIdx = args.indexOf("--team");
const TEAM = teamIdx >= 0 ? args[teamIdx + 1] : DEFAULT_TEAM;

const TOKEN = process.env.CF_API_TOKEN;
if (!TOKEN) {
  console.error("CF_API_TOKEN is not set.");
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

async function cf(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    const err = new Error(`${method} ${path} → ${res.status} ${msg}`);
    err.status = res.status;
    err.errors = json.errors || [];
    throw err;
  }
  return json.result;
}

async function ensureOrg() {
  let org = null;
  try {
    org = await cf("GET", "/access/organizations");
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (org && org.auth_domain) {
    console.log(`Zero Trust org: ${org.auth_domain} (exists)`);
    return org;
  }
  const authDomain = `${TEAM}.cloudflareaccess.com`;
  console.log(`Creating Zero Trust org ${authDomain}`);
  if (DRY) return { auth_domain: authDomain };
  return cf("POST", "/access/organizations", {
    name: APP_NAME,
    auth_domain: authDomain,
    is_ui_read_only: false,
    auto_redirect_to_identity: false,
  });
}

async function ensureOtp() {
  const idps = await cf("GET", "/access/identity_providers");
  const otp = idps.find((p) => p.type === "onetimepin");
  if (otp) {
    console.log(`Login method: One-time PIN (exists, ${otp.id})`);
    return otp;
  }
  console.log("Creating One-time PIN login method");
  if (DRY) return { id: "dry-otp" };
  return cf("POST", "/access/identity_providers", {
    name: "One-time PIN",
    type: "onetimepin",
    config: {},
  });
}

async function ensureApp(otpId) {
  const apps = await cf("GET", "/access/apps");
  const existing = apps.find((a) => a.domain === HOSTNAME || a.name === APP_NAME);

  const desired = {
    name: APP_NAME,
    type: "self_hosted",
    domain: HOSTNAME,
    self_hosted_domains: [HOSTNAME],
    session_duration: "720h",
    allowed_idps: [otpId],
    auto_redirect_to_identity: true,
    skip_interstitial: true,
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    policies: [
      {
        name: "Matt & Evelyn",
        decision: "allow",
        precedence: 1,
        include: EMAILS.map((email) => ({ email: { email } })),
      },
    ],
  };

  if (existing) {
    console.log(`Access app "${existing.name}" exists (${existing.id}) — updating`);
    if (DRY) return existing;
    return cf("PUT", `/access/apps/${existing.id}`, desired);
  }
  console.log(`Creating Access app "${APP_NAME}" for ${HOSTNAME}`);
  if (DRY) return desired;
  return cf("POST", "/access/apps", desired);
}

(async () => {
  const org = await ensureOrg();
  const otp = await ensureOtp();
  const app = await ensureApp(otp.id);
  console.log("");
  console.log(`Done. https://${HOSTNAME} now requires login via ${org.auth_domain}`);
  console.log(`Allowed: ${EMAILS.join(", ")}`);
  if (app && app.policies) {
    for (const p of app.policies) console.log(`Policy "${p.name}": ${p.decision}`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
