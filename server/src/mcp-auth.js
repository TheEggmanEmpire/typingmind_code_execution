// Single-password OAuth 2.1 shim for the MCP endpoint.
//
// One secret (config.apiKey: MCP_API_KEY, or its alias MCP_PASSWORD) gates /mcp
// and at the same time satisfies three connector styles:
//   - direct Bearer:  Authorization: Bearer <MCP_API_KEY>   (also X-API-Key)
//   - HTTP Basic:     Authorization: Basic base64(user:pass)  (either side carries it)
//   - OAuth 2.1:      dynamic client registration + PKCE (authorization_code),
//                     and client_credentials with the key as client_secret
//
// After the OAuth dance the server mints an opaque random token (32 bytes,
// base64url, non-expiring). The raw key is never returned as an access_token.
// The gate accepts either the key or an issued token.
//
// Tokens are non-expiring (expiresAt: null) so that idle connectors (a Railway
// service that sleeps past any finite TTL) keep a valid credential across cold
// starts. To survive restarts and redeploys the token store is persisted on the
// volume (DATA_DIR/mcp-tokens.json, or MCP_TOKEN_STORE): non-expiry is useless
// if the store is wiped on boot. The key itself stays an always-valid Bearer, so
// a lost token file is recoverable without re-running OAuth.
//
// Open mode (no authentication) only with ALLOW_NO_AUTH and no key set.
//
// Ported from reddit_mcp_buddy/src/core/mcp-auth.ts. Node's crypto only.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Token / auth-code stores
//
// Single-instance only. The token store is persisted to disk so non-expiring
// tokens survive restarts. Auth codes are short-lived and stay in memory.
//
// TOKENS is keyed by the SHA-256 of the token, never the token itself, so the
// file on the volume holds nothing a reader could replay. Tokens are 256-bit
// random values, so an unsalted hash is enough here.
// ---------------------------------------------------------------------------

const TOKENS = new Map();        // sha256hex(token) -> { expiresAt, issuedAt, scope }
const AUTH_CODES = new Map();    // code -> { codeChallenge, redirectUri, clientId, expiresAt }
const DCR_REGISTRY = new Map();  // clientId -> { clientId, redirectUris, clientName, registeredAt }

// Failure tracking for rate limiting on key verification
const FAILURE_COUNTERS = new Map(); // source -> { count, lastFailureAt }

// null TTL = non-expiring. Kept as an opt-in knob (mintAccessToken({ ttlMs }))
// for callers that ever want a bounded token.
const DEFAULT_TTL_MS = null;
// Advertised on the wire only: about 10 years. Some clients reject a token
// response with no expires_in (or treat 0/absent as already expired). The
// server enforces non-expiry regardless of what it advertises.
const ADVERTISED_EXPIRES_IN_S = 10 * 365 * 24 * 60 * 60;
const AUTH_CODE_TTL_MS = 60 * 1000; // 60 s, single use
const DEFAULT_SCOPE = "mcp";
const OAUTH_BODY_MAX = 256 * 1024;

// Memory-safety caps
const MAX_TOKENS = 10_000;
const MAX_DCR_REGISTRATIONS = 1_000;
const MAX_FAILURE_COUNTERS = 10_000;
const MAX_AUTH_CODES = 10_000;

// Rate limiting: exponential backoff after N failures
const PASSWORD_FAILURE_THRESHOLD = 3;
const PASSWORD_FAILURE_BASE_DELAY_MS = 1000;  // 1 s after the 3rd failure
const PASSWORD_FAILURE_MAX_DELAY_MS = 30000;  // 30 s max backoff

// Resource paths this gate protects. Each gets RFC 9728 metadata at
// /.well-known/oauth-protected-resource<path>; /mcp also keeps the root form.
const RESOURCES = new Set(["/mcp"]);

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getPassword() {
  const raw = config.apiKey;
  // Whitespace-sensitive by design: must match the client config byte for byte.
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function isAuthConfigured() {
  return getPassword() !== undefined;
}

function isOpen() {
  return !isAuthConfigured() && !!config.allowNoAuth;
}

function getTokenStorePath() {
  const raw = (process.env.MCP_TOKEN_STORE || "").trim();
  return raw || path.join(config.dataDir, "mcp-tokens.json");
}

// ---------------------------------------------------------------------------
// Password fingerprint (detects key rotation across restarts)
//
// The source stored a bare SHA-256 of the password. Here it is an HMAC with a
// random salt kept in the same file, so the file is no offline oracle for a
// short or reused key. Rotation detection works the same way.
// ---------------------------------------------------------------------------

let seedSalt = null;
const saltHex = () => (seedSalt ||= crypto.randomBytes(16).toString("hex"));

function computePasswordSeed() {
  const password = getPassword();
  if (!password) return undefined;
  return crypto.createHmac("sha256", saltHex()).update(password, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Disk persistence for the token store
// ---------------------------------------------------------------------------

/** Atomically write the current token map to disk. */
function persistTokens() {
  const file = getTokenStorePath();
  try {
    const tokens = Object.fromEntries(TOKENS);
    // Client registrations ride in the same file. They are not credentials, but
    // /oauth/authorize checks redirect_uris against them, so losing them on a
    // restart would make every connected connector fall back to adoption.
    const clients = Object.fromEntries(DCR_REGISTRY);
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // JSON.stringify preserves null, so expiresAt: null round-trips.
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, seedSalt: saltHex(), passwordSeed: computePasswordSeed(), tokens, clients }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // Persistence is best effort; the in-memory store stays authoritative for
    // the life of the process. Surface it, but do not crash the server.
    console.error("[mcp-auth] failed to persist token store:", err && err.message);
  }
}

/** Load persisted tokens at boot, keeping non-expiring and not-yet-expired ones. */
function loadTokens() {
  const file = getTokenStorePath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // A missing file on first boot is normal; anything else is worth logging.
    if (err && err.code !== "ENOENT") console.error("[mcp-auth] failed to read token store:", err.message);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  if (typeof parsed.seedSalt === "string" && /^[0-9a-f]{32}$/.test(parsed.seedSalt)) seedSalt = parsed.seedSalt;

  // Restore client registrations before the seed gate: they are public
  // metadata, not credentials, so a key rotation must not force every connector
  // to re-register. It only invalidates the tokens below.
  const clients = parsed.clients;
  if (clients && typeof clients === "object") {
    for (const [clientId, entry] of Object.entries(clients)) {
      if (!entry || typeof entry.clientId !== "string") continue;
      if (!Array.isArray(entry.redirectUris) || !entry.redirectUris.every((u) => typeof u === "string")) continue;
      if (DCR_REGISTRY.size >= MAX_DCR_REGISTRATIONS) break;
      DCR_REGISTRY.set(clientId, {
        clientId: entry.clientId,
        redirectUris: entry.redirectUris,
        clientName: typeof entry.clientName === "string" ? entry.clientName : undefined,
        registeredAt: typeof entry.registeredAt === "number" ? entry.registeredAt : Date.now()
      });
    }
  }

  // A seed that is present and different means the key rotated: drop every
  // token. A store without a seed (written while no key was set) is adopted
  // and stamped on the next write.
  const currentSeed = computePasswordSeed();
  const storedSeed = parsed.passwordSeed;
  if (currentSeed && storedSeed !== undefined && storedSeed !== currentSeed) {
    console.error("[mcp-auth] key rotation detected; invalidating all persisted tokens");
    persistTokens();
    return;
  }

  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") return;
  const now = Date.now();
  let loaded = 0;
  for (const [hash, entry] of Object.entries(tokens)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !entry) continue;
    const expiresAt = entry.expiresAt === null ? null : typeof entry.expiresAt === "number" ? entry.expiresAt : undefined;
    if (expiresAt === undefined) continue; // malformed
    // Keep non-expiring tokens and any finite token still in its window.
    if (expiresAt === null || expiresAt > now) {
      TOKENS.set(hash, {
        expiresAt,
        issuedAt: typeof entry.issuedAt === "number" ? entry.issuedAt : now,
        scope: typeof entry.scope === "string" ? entry.scope : DEFAULT_SCOPE
      });
      loaded++;
    }
  }
  if (loaded > 0) console.error(`[mcp-auth] loaded ${loaded} persisted token(s)`);
}

loadTokens();

/** Drop the in-memory stores and read them back from disk (tests, maintenance). */
export function reloadTokenStore() {
  TOKENS.clear();
  DCR_REGISTRY.clear();
  AUTH_CODES.clear();
  FAILURE_COUNTERS.clear();
  seedSalt = null;
  loadTokens();
}

/**
 * Check a client_id/redirect_uri pair against the registry, adopting ids we
 * have never seen. Connectors cache their DCR client_id indefinitely and do not
 * re-register when authorize rejects it, so an id lost to a restart would lock
 * that connector out for good. Adoption costs no security: registration is
 * open, so anyone could register the same redirect_uri anyway. What matters is
 * that a KNOWN client cannot be pointed at a redirect it did not register, and
 * the key gate still holds.
 */
function checkClient(clientId, redirectUri) {
  const registration = DCR_REGISTRY.get(clientId);
  if (registration) return registration.redirectUris.includes(redirectUri) ? "ok" : "mismatch";
  if (!isValidRedirectUri(redirectUri)) return "mismatch";
  DCR_REGISTRY.set(clientId, { clientId, redirectUris: [redirectUri], registeredAt: Date.now() });
  while (DCR_REGISTRY.size > MAX_DCR_REGISTRATIONS) DCR_REGISTRY.delete(DCR_REGISTRY.keys().next().value);
  console.error(`[mcp-auth] adopted unregistered client_id ${clientId} for ${redirectUri}`);
  persistTokens();
  return "ok";
}

export function authStatusMessage() {
  if (isAuthConfigured()) return "MCP auth: Bearer <MCP_API_KEY>, HTTP Basic, or OAuth at /oauth/authorize";
  if (isOpen()) return "ALLOW_NO_AUTH=1 and no MCP_API_KEY: /mcp is OPEN (no authentication)";
  return "MCP_API_KEY not set: /mcp returns 503";
}

/** Startup warnings (short key, OAuth issuer that may be guessed wrong). */
export function logAuthStatus() {
  console.error("[mcp-auth] " + authStatusMessage());
  const password = getPassword();
  if (password && password.length < 16) {
    console.error("[mcp-auth] WARNING: MCP_API_KEY is shorter than 16 characters; consider a longer secret");
  }
  if (!explicitBaseUrl() && !trustProxy()) {
    console.error("[mcp-auth] WARNING: no PUBLIC_URL, RAILWAY_PUBLIC_DOMAIN or MCP_TRUST_PROXY=1; the OAuth issuer URL may be wrong behind a proxy");
  }
}

// ---------------------------------------------------------------------------
// Base URL
//
// The externally visible base URL, so the OAuth issuer is advertised correctly
// behind a TLS-terminating proxy:
//   PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN (config.publicUrl)  ->  request host
// X-Forwarded-* are trusted only with MCP_TRUST_PROXY=1.
// ---------------------------------------------------------------------------

const explicitBaseUrl = () => !!(process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN);
const trustProxy = () => /^(1|true|yes|on)$/i.test(String(process.env.MCP_TRUST_PROXY || "").trim());

export function getBaseUrl(req) {
  if (explicitBaseUrl()) return config.publicUrl.replace(/\/+$/, "");
  const trust = trustProxy();
  const forwardedProto = trust ? headerValue(req, "x-forwarded-proto") : undefined;
  const proto = (forwardedProto ? forwardedProto.split(",")[0].trim() : "") || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = trust
    ? (headerValue(req, "x-forwarded-host") || headerValue(req, "host") || "localhost")
    : (headerValue(req, "host") || "localhost");
  return `${proto}://${host}`.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Token / key verification and rate limiting
// ---------------------------------------------------------------------------

const sha256 = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest();
const tokenKey = (token) => sha256(token).toString("hex");

/** Constant-time comparison of two strings via their SHA-256 digests. */
function constantTimeEquals(a, b) {
  // Digests are always 32 bytes, so lengths match and timingSafeEqual is safe.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/**
 * The source IP for rate limiting.
 *
 * The LAST X-Forwarded-For hop is the one appended by the proxy directly in
 * front of us; every earlier hop is whatever the client chose to send. Keying
 * on the first hop would let a caller rotate the header to evade the throttle,
 * or forge someone else's IP to lock them out.
 */
function getSourceIp(req) {
  const forwarded = headerValue(req, "x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Remaining lockout for a source in ms, or 0 if it may try a key now. */
function getPasswordFailureDelay(source) {
  const entry = FAILURE_COUNTERS.get(source);
  if (!entry || entry.count < PASSWORD_FAILURE_THRESHOLD) return 0;
  // Exponential backoff: 2^(count - threshold) * base, capped. The delay runs
  // from the last failure; without that the lockout never decays.
  const exponent = Math.min(entry.count - PASSWORD_FAILURE_THRESHOLD, 4); // 2^4 = 16x
  const delay = Math.min(PASSWORD_FAILURE_BASE_DELAY_MS * 2 ** exponent, PASSWORD_FAILURE_MAX_DELAY_MS);
  const remaining = entry.lastFailureAt + delay - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordPasswordFailure(source) {
  let entry = FAILURE_COUNTERS.get(source);
  if (!entry) { entry = { count: 0, lastFailureAt: 0 }; FAILURE_COUNTERS.set(source, entry); }
  entry.count++;
  entry.lastFailureAt = Date.now();
  if (FAILURE_COUNTERS.size > MAX_FAILURE_COUNTERS) FAILURE_COUNTERS.delete(FAILURE_COUNTERS.keys().next().value);
}

function resetPasswordFailures(source) {
  FAILURE_COUNTERS.delete(source);
}

function verifyPassword(candidate) {
  const password = getPassword();
  if (!password || !candidate) return false;
  return constantTimeEquals(candidate, password);
}

function verifyAccessToken(candidate) {
  if (!candidate) return false;
  const key = tokenKey(candidate);
  const entry = TOKENS.get(key);
  if (!entry) return false;
  // expiresAt === null means non-expiring; only finite, elapsed TTLs are pruned.
  if (entry.expiresAt != null && entry.expiresAt < Date.now()) {
    TOKENS.delete(key);
    persistTokens();
    return false;
  }
  return true;
}

/** A credential is valid if it is an issued token OR the key itself. */
function verifyStringSecret(secret) {
  return !!secret && (verifyAccessToken(secret) || verifyPassword(secret));
}

/** Revoke all issued tokens. */
export function revokeAllTokens() {
  TOKENS.clear();
  persistTokens();
  console.error("[mcp-auth] all tokens revoked");
}

function mintAccessToken({ ttlMs = DEFAULT_TTL_MS, scope = DEFAULT_SCOPE } = {}) {
  const now = Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  TOKENS.set(tokenKey(token), { expiresAt: ttlMs == null ? null : now + ttlMs, issuedAt: now, scope });
  // Drop the oldest entries until the store is within MAX_TOKENS (FIFO).
  while (TOKENS.size > MAX_TOKENS) TOKENS.delete(TOKENS.keys().next().value);
  persistTokens();
  return { token, expiresIn: ttlMs == null ? ADVERTISED_EXPIRES_IN_S : Math.floor(ttlMs / 1000), scope };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function headerValue(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function queryOf(req) {
  const raw = req.url || "";
  const i = raw.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : raw.slice(i + 1));
}

/** A candidate credential from Authorization (Bearer/Basic), X-API-Key, or the query. */
function extractCredential(req) {
  const authz = headerValue(req, "authorization");
  if (authz) {
    const [scheme, ...rest] = authz.split(" ");
    const value = rest.join(" ").trim();
    if (/^bearer$/i.test(scheme) && value) return value;
    if (/^basic$/i.test(scheme) && value) {
      // Either the username or the password side may carry the secret.
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const user = sep === -1 ? decoded : decoded.slice(0, sep);
      const pass = sep === -1 ? "" : decoded.slice(sep + 1);
      if (pass && verifyStringSecret(pass)) return pass;
      if (user && verifyStringSecret(user)) return user;
      // Fall back to the password side so the 401 path is taken.
      return pass || user || undefined;
    }
  }

  const apiKeyHeader = headerValue(req, "x-api-key");
  if (apiKeyHeader) return apiKeyHeader.trim();

  // Only issued opaque tokens are accepted from the query, never the raw key:
  // URLs end up in logs.
  const q = queryOf(req);
  const fromQuery = q.get("api_key") || q.get("access_token");
  if (fromQuery && verifyAccessToken(fromQuery)) return fromQuery;
  return undefined;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length, "Cache-Control": "no-store", ...extraHeaders });
  res.end(buf);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY"
  });
  res.end(html);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function rpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** Register another path this gate protects, e.g. "/rea/mcp" (gets its own RFC 9728 metadata). */
export function protectResource(resource) {
  const p = "/" + String(resource || "").replace(/^\/+|\/+$/g, "");
  if (p !== "/") RESOURCES.add(p);
  return p;
}

function resourceMetadataUrl(req, resource) {
  const base = getBaseUrl(req);
  return resource === "/mcp" ? `${base}/.well-known/oauth-protected-resource` : `${base}/.well-known/oauth-protected-resource${resource}`;
}

/**
 * Decide whether a request may reach a protected MCP endpoint.
 * Returns { ok: true } or { ok: false, status, headers, body } for the caller to send.
 * `resource` is the path of the endpoint being guarded (default "/mcp"); the
 * 401 points the client at that resource's metadata.
 */
export function checkAuth(req, { resource = "/mcp" } = {}) {
  resource = protectResource(resource);
  if (isOpen()) return { ok: true, status: 200, headers: {}, body: null };

  if (!isAuthConfigured()) {
    return { ok: false, status: 503, headers: {}, body: rpcError(-32000, "MCP authentication not configured (MCP_API_KEY unset)") };
  }

  const source = getSourceIp(req);
  const credential = extractCredential(req);

  // An issued opaque token (256-bit, unguessable) always passes, even while
  // the source is throttled: the lockout exists to stop key guessing, not to
  // lock out a client that re-ran OAuth.
  if (credential && verifyAccessToken(credential)) {
    resetPasswordFailures(source);
    return { ok: true, status: 200, headers: {}, body: null };
  }

  if (credential) {
    // The lockout must apply BEFORE the key is tested, or every guess still
    // gets a real answer and the throttle limits nothing.
    if (getPasswordFailureDelay(source) > 0) {
      return { ok: false, status: 429, headers: { "Retry-After": "30" }, body: rpcError(-32000, "Too many authentication failures; try again later") };
    }
    if (verifyPassword(credential)) {
      resetPasswordFailures(source);
      return { ok: true, status: 200, headers: {}, body: null };
    }
    // Only a wrong credential counts as a failure. A request with none is the
    // unauthenticated probe OAuth clients send to receive the 401 challenge.
    recordPasswordFailure(source);
  }

  return {
    ok: false,
    status: 401,
    headers: { "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl(req, resource)}"` },
    body: rpcError(-32001, "Unauthorized: send 'Authorization: Bearer <MCP_API_KEY>', or connect through OAuth.")
  };
}

/** checkAuth that writes the refusal itself. Returns true if the request may proceed. */
export function requireAuth(req, res, opts) {
  const r = checkAuth(req, opts);
  if (!r.ok) sendJson(res, r.status, r.body, r.headers);
  return r.ok;
}

// ---------------------------------------------------------------------------
// OAuth routes
// ---------------------------------------------------------------------------

const PRM_PATH = "/.well-known/oauth-protected-resource";
const OAUTH_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  PRM_PATH,
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke"
]);

function isOAuthPath(pathname) {
  if (OAUTH_PATHS.has(pathname)) return true;
  return pathname.startsWith(PRM_PATH + "/") && RESOURCES.has(pathname.slice(PRM_PATH.length));
}

function isValidRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function pkceMatches(verifier, challenge) {
  const computed = Buffer.from(crypto.createHash("sha256").update(verifier, "utf8").digest("base64url"));
  const expected = Buffer.from(challenge, "utf8");
  // Compare byte lengths: a non-ASCII challenge can match in string length but
  // not in bytes, and timingSafeEqual throws on unequal buffers.
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function originOf(uri) {
  try { return new URL(uri).origin; } catch { return uri; }
}

function renderAuthorizeForm(p) {
  const errorBlock = p.error ? `<p class="error">${htmlEscape(p.error)}</p>` : "";
  const clientInfo = p.clientName ? `<p class="info"><strong>Client:</strong> ${htmlEscape(p.clientName)}</p>` : "";
  const redirectInfo = `<p class="info"><strong>Redirect to:</strong> ${htmlEscape(p.redirectOrigin)}</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Code Runner</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'">
<style>
  body { font-family: system-ui, sans-serif; background: #0b0c10; color: #e8e8e8;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #15171c; padding: 2rem; border-radius: 12px; width: 320px; max-width: calc(100vw - 32px);
          box-sizing: border-box; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  .info { font-size: .85rem; color: #ccc; margin: .5rem 0; padding: .5rem; background: #0b0c10; border-left: 3px solid #4f8cff; word-break: break-all; }
  .info strong { color: #4f8cff; }
  label { display: block; font-size: .8rem; margin-bottom: .4rem; color: #9aa0aa; }
  input[type=password] { width: 100%; padding: .6rem; border-radius: 8px; border: 1px solid #2a2d35;
          background: #0b0c10; color: #fff; box-sizing: border-box; margin-bottom: 1rem; }
  button { width: 100%; padding: .65rem; border: 0; border-radius: 8px; background: #4f8cff;
          color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #ff6b6b; font-size: .8rem; margin: 0 0 1rem; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/oauth/authorize">
    <h1>Authorize Code Runner</h1>
    ${errorBlock}
    ${clientInfo}
    ${redirectInfo}
    <label for="password">Access key (MCP_API_KEY)</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
    <input type="hidden" name="client_id" value="${htmlEscape(p.clientId)}">
    <input type="hidden" name="redirect_uri" value="${htmlEscape(p.redirectUri)}">
    <input type="hidden" name="state" value="${htmlEscape(p.state)}">
    <input type="hidden" name="code_challenge" value="${htmlEscape(p.codeChallenge)}">
    <input type="hidden" name="scope" value="${htmlEscape(p.scope)}">
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function tokenResponse(res) {
  const { token, expiresIn } = mintAccessToken();
  sendJson(res, 200, { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: DEFAULT_SCOPE });
}

/**
 * Serve OAuth discovery, dynamic client registration, authorize, token and
 * revoke routes. Returns true when the request was one of them (and has been
 * answered). Mount it BEFORE the /mcp gate so clients can negotiate without
 * credentials.
 */
export async function handleAuthHttp(req, res, url) {
  const pathname = url ? url.pathname : (req.url || "").split("?")[0];
  if (!isOAuthPath(pathname)) return false;
  const method = (req.method || "GET").toUpperCase();
  const baseUrl = getBaseUrl(req);

  let rawBody = "";
  if (method === "POST") {
    try { rawBody = await readBody(req, OAUTH_BODY_MAX); }
    catch (e) { sendJson(res, e.status || 400, { error: "invalid_request", error_description: e.message }); return true; }
  }

  // --- RFC 8414: Authorization Server Metadata ---------------------------
  if (pathname === "/.well-known/oauth-authorization-server" && method === "GET") {
    sendJson(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: [DEFAULT_SCOPE]
    });
    return true;
  }

  // --- RFC 9728: Protected Resource Metadata -----------------------------
  if (pathname.startsWith(PRM_PATH) && method === "GET") {
    const resource = pathname === PRM_PATH ? "/mcp" : pathname.slice(PRM_PATH.length);
    sendJson(res, 200, { resource: `${baseUrl}${resource}`, authorization_servers: [baseUrl], bearer_methods_supported: ["header"], scopes_supported: [DEFAULT_SCOPE] });
    return true;
  }

  // --- RFC 7591: Dynamic Client Registration -----------------------------
  if (pathname === "/oauth/register" && method === "POST") {
    let parsed;
    try { parsed = rawBody ? JSON.parse(rawBody) : {}; }
    catch { sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" }); return true; }
    if (!parsed || typeof parsed !== "object") parsed = {};
    const redirectUris = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris : [];
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
        sendJson(res, 400, { error: "invalid_client_metadata", error_description: `Invalid redirect_uri: ${uri}` });
        return true;
      }
    }
    if (redirectUris.length === 0) {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "At least one redirect_uri is required" });
      return true;
    }
    const clientId = `mcp-${crypto.randomBytes(16).toString("hex")}`;
    const clientName = typeof parsed.client_name === "string" ? parsed.client_name : undefined;
    DCR_REGISTRY.set(clientId, { clientId, redirectUris, clientName, registeredAt: Date.now() });
    while (DCR_REGISTRY.size > MAX_DCR_REGISTRATIONS) DCR_REGISTRY.delete(DCR_REGISTRY.keys().next().value);
    // Survive a restart, or the next authorize from this client would be adopted blind.
    persistTokens();
    sendJson(res, 201, {
      client_id: clientId,
      // No per-client secret: the single MCP_API_KEY is the shared secret.
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "client_credentials"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: clientName
    });
    return true;
  }

  // --- Authorization endpoint (HTML key form) ----------------------------
  if (pathname === "/oauth/authorize" && method === "GET") {
    const q = url ? url.searchParams : queryOf(req);
    const responseType = q.get("response_type") || "code";
    const clientId = q.get("client_id") || "";
    const redirectUri = q.get("redirect_uri") || "";
    const state = q.get("state") || "";
    const codeChallenge = q.get("code_challenge") || "";
    const codeChallengeMethod = q.get("code_challenge_method") || "";
    const scope = q.get("scope") || DEFAULT_SCOPE;

    if (responseType !== "code") { sendJson(res, 400, { error: "unsupported_response_type" }); return true; }
    if (!codeChallenge) { sendJson(res, 400, { error: "invalid_request", error_description: "code_challenge is required (PKCE)" }); return true; }
    if (codeChallengeMethod && codeChallengeMethod.toUpperCase() !== "S256") {
      sendJson(res, 400, { error: "invalid_request", error_description: "Only S256 PKCE is supported" });
      return true;
    }
    // A known client may only use a redirect_uri it registered.
    if (clientId && checkClient(clientId, redirectUri) === "mismatch") {
      sendHtml(res, 400, "<!DOCTYPE html><html><body><p>Error: redirect_uri not registered for this client</p></body></html>");
      return true;
    }
    if (!redirectUri || !isValidRedirectUri(redirectUri)) {
      sendJson(res, 400, { error: "invalid_request", error_description: "Invalid redirect_uri" });
      return true;
    }
    const registration = clientId ? DCR_REGISTRY.get(clientId) : undefined;
    sendHtml(res, 200, renderAuthorizeForm({ clientId, clientName: registration && registration.clientName, redirectUri, redirectOrigin: originOf(redirectUri), state, codeChallenge, scope }));
    return true;
  }

  // --- Authorization endpoint (verify key -> issue auth code) ------------
  if (pathname === "/oauth/authorize" && method === "POST") {
    const source = getSourceIp(req);
    const form = new URLSearchParams(rawBody);
    const password = form.get("password") || "";
    const clientId = form.get("client_id") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const state = form.get("state") || "";
    const codeChallenge = form.get("code_challenge") || "";
    const scope = form.get("scope") || DEFAULT_SCOPE;

    if (clientId && checkClient(clientId, redirectUri) === "mismatch") {
      sendHtml(res, 400, "<!DOCTYPE html><html><body><p>Error: Invalid client_id or redirect_uri mismatch</p></body></html>");
      return true;
    }
    if (!codeChallenge || !redirectUri || !isValidRedirectUri(redirectUri)) {
      sendJson(res, 400, { error: "invalid_request" });
      return true;
    }
    const formParams = { clientId, clientName: DCR_REGISTRY.get(clientId) && DCR_REGISTRY.get(clientId).clientName, redirectUri, redirectOrigin: originOf(redirectUri), state, codeChallenge, scope };

    if (getPasswordFailureDelay(source) > 0) {
      sendHtml(res, 429, renderAuthorizeForm({ ...formParams, error: "Too many failed attempts. Try again later." }));
      return true;
    }
    if (!verifyPassword(password)) {
      recordPasswordFailure(source);
      // Re-render the form with an error; never echo the key back.
      sendHtml(res, 401, renderAuthorizeForm({ ...formParams, error: "Incorrect key. Try again." }));
      return true;
    }
    resetPasswordFailures(source);

    const code = crypto.randomBytes(32).toString("base64url");
    AUTH_CODES.set(code, { codeChallenge, redirectUri, clientId, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
    // Unredeemed codes would otherwise pile up; drop expired ones, then the oldest.
    if (AUTH_CODES.size > MAX_AUTH_CODES) {
      const now = Date.now();
      for (const [c, e] of AUTH_CODES) if (e.expiresAt <= now) AUTH_CODES.delete(c);
      while (AUTH_CODES.size > MAX_AUTH_CODES) AUTH_CODES.delete(AUTH_CODES.keys().next().value);
    }

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end();
    return true;
  }

  // --- Token endpoint ----------------------------------------------------
  if (pathname === "/oauth/token" && method === "POST") {
    const form = new URLSearchParams(rawBody);
    const grantType = form.get("grant_type") || "";

    // client_secret may come through HTTP Basic as well (client_secret_basic).
    let basicSecret;
    const authz = headerValue(req, "authorization");
    if (authz && /^basic\s+/i.test(authz)) {
      const decoded = Buffer.from(authz.replace(/^basic\s+/i, ""), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      basicSecret = sep === -1 ? decoded : decoded.slice(sep + 1);
    }

    if (grantType === "authorization_code") {
      const code = form.get("code") || "";
      const codeVerifier = form.get("code_verifier") || "";
      const redirectUri = form.get("redirect_uri") || "";
      const clientId = form.get("client_id") || "";

      const entry = AUTH_CODES.get(code);
      if (!entry || Date.now() >= entry.expiresAt) {
        if (entry) AUTH_CODES.delete(code);
        sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid or expired code" });
        return true;
      }
      // Every failure burns the code: it is single use either way.
      if (entry.redirectUri !== redirectUri) {
        AUTH_CODES.delete(code);
        sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return true;
      }
      if (clientId && entry.clientId !== clientId) {
        AUTH_CODES.delete(code);
        sendJson(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
        return true;
      }
      if (!codeVerifier || !pkceMatches(codeVerifier, entry.codeChallenge)) {
        AUTH_CODES.delete(code);
        sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return true;
      }
      AUTH_CODES.delete(code);
      tokenResponse(res);
      return true;
    }

    if (grantType === "client_credentials") {
      const clientSecret = form.get("client_secret") || basicSecret || "";
      const source = getSourceIp(req);
      // Same throttle as /mcp and /oauth/authorize; otherwise this endpoint is
      // an unthrottled key oracle.
      if (getPasswordFailureDelay(source) > 0) {
        sendJson(res, 429, { error: "slow_down", error_description: "Too many failed attempts; try again later" });
        return true;
      }
      if (!verifyPassword(clientSecret)) {
        recordPasswordFailure(source);
        sendJson(res, 401, { error: "invalid_client", error_description: "Invalid client_secret" });
        return true;
      }
      resetPasswordFailures(source);
      tokenResponse(res);
      return true;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  // --- Token revocation --------------------------------------------------
  if (pathname === "/oauth/revoke" && method === "POST") {
    const form = new URLSearchParams(rawBody);
    const token = form.get("token") || "";
    const revokeAll = form.get("revoke_all") === "true";

    // Requires a credential, throttled like every other key check.
    const source = getSourceIp(req);
    const credential = extractCredential(req);
    let ok = !!credential && verifyAccessToken(credential);
    if (!ok && credential) {
      if (getPasswordFailureDelay(source) > 0) { sendJson(res, 429, { error: "slow_down" }); return true; }
      ok = verifyPassword(credential);
      if (!ok) recordPasswordFailure(source);
    }
    if (!ok) { sendJson(res, 401, { error: "unauthorized" }); return true; }
    resetPasswordFailures(source);

    // Persist the revocation: these tokens never expire, so one dropped only
    // from memory would come back from the store on the next boot.
    if (token && TOKENS.delete(tokenKey(token))) persistTokens();
    if (revokeAll) revokeAllTokens();
    sendJson(res, 200, { status: "ok" });
    return true;
  }

  // Method not allowed for a known OAuth path.
  sendJson(res, 405, { error: "method_not_allowed" });
  return true;
}
