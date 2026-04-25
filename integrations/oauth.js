// Shared OAuth machinery for Google + Microsoft.
//
// Both providers use standard OAuth 2.0 authorization code flow with PKCE.
// This module handles the parts that are identical between them:
//   - generating PKCE code_verifier / code_challenge pairs
//   - minting short-lived CSRF state tokens tied to a specific user + provider
//   - building the redirect URL the browser should be sent to
//   - verifying the state token on callback
//
// State tokens live on the store (pruned on each mint + on callback) rather
// than in a dedicated table, because the whole datastore is a single JSON
// blob already. This is fine — states are tiny and short-lived (10 min max).

import { randomBytes, createHash } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STATE_BYTES = 24;
const CODE_VERIFIER_BYTES = 48; // produces ~64 char verifier

// Base64url (no padding, URL-safe alphabet) — used for both PKCE and state.
function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkcePair() {
  const verifier = base64url(randomBytes(CODE_VERIFIER_BYTES));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function pruneExpiredStates(db) {
  if (!Array.isArray(db.data.oauthStates)) {
    db.data.oauthStates = [];
    return;
  }
  const now = Date.now();
  db.data.oauthStates = db.data.oauthStates.filter(
    (entry) => typeof entry?.expiresAt === "number" && entry.expiresAt > now
  );
}

export function issueState(db, { userId, provider, pkceVerifier, returnTo = "/account" }) {
  pruneExpiredStates(db);
  const token = base64url(randomBytes(STATE_BYTES));
  db.data.oauthStates.push({
    token,
    userId: String(userId),
    provider: String(provider),
    pkceVerifier: String(pkceVerifier),
    returnTo: String(returnTo || "/account"),
    expiresAt: Date.now() + STATE_TTL_MS
  });
  return token;
}

export function consumeState(db, { token, provider }) {
  pruneExpiredStates(db);
  if (!Array.isArray(db.data.oauthStates)) {
    return null;
  }
  const index = db.data.oauthStates.findIndex(
    (entry) => entry.token === token && entry.provider === provider
  );
  if (index < 0) {
    return null;
  }
  const [state] = db.data.oauthStates.splice(index, 1);
  return state;
}

export function resolveRedirectUri(request, providerPath) {
  // Priority order:
  //   1. INTEGRATION_PUBLIC_ORIGIN env (set by compose) — the canonical
  //      HTTPS origin Google/Microsoft have whitelisted.
  //   2. HEARTHBOARD_PUBLIC_DOMAIN env — used by Caddy for TLS. Build
  //      https://<domain>/... from it.
  //   3. Fall back to the request's own origin. Works on LAN during
  //      development but won't match what's registered at Google/MS,
  //      so the OAuth provider will reject the callback.
  const explicit = String(process.env.INTEGRATION_PUBLIC_ORIGIN || "").trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "") + providerPath;
  }

  const publicDomain = String(process.env.HEARTHBOARD_PUBLIC_DOMAIN || "").trim();
  if (publicDomain) {
    return `https://${publicDomain}${providerPath}`;
  }

  const protocol = request.protocol || "https";
  const host = request.get("host") || "localhost";
  return `${protocol}://${host}${providerPath}`;
}

// Build a URL-encoded form body for token exchange requests. Both Google
// and Microsoft accept application/x-www-form-urlencoded for their
// /token endpoints.
export function buildFormBody(params) {
  return Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}
