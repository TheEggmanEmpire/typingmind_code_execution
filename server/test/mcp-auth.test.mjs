// mcp-auth.js against a tiny http server of its own (the full server is not started).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cr-auth-"));
process.env.DATA_DIR = DATA;
process.env.MCP_API_KEY = "test-key-0123456789abcdef";
delete process.env.MCP_PASSWORD;
delete process.env.MCP_TOKEN_STORE;
delete process.env.PUBLIC_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.ALLOW_NO_AUTH;
const KEY = process.env.MCP_API_KEY;
const STORE = path.join(DATA, "mcp-tokens.json");

const { config } = await import("../src/config.js");
const auth = await import("../src/mcp-auth.js");

let server, base;
before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (await auth.handleAuthHttp(req, res, url)) return;
    if (url.pathname === "/mcp" || url.pathname === "/rea/mcp") {
      const g = auth.checkAuth(req, { resource: url.pathname });
      if (!g.ok) { res.writeHead(g.status, { "Content-Type": "application/json", ...g.headers }); res.end(JSON.stringify(g.body)); return; }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// Each test speaks from its own address so the failure throttle of one cannot touch another.
let ipN = 0;
const newIp = () => "10.0.0." + (++ipN);
const mcp = (headers = {}, p = "/mcp") => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
const form = (p, fields, headers = {}) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const basic = (s) => "Basic " + Buffer.from(s).toString("base64");
const pkce = () => { const verifier = crypto.randomBytes(32).toString("base64url"); return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") }; };

async function register(redirect = "https://claude.ai/api/mcp/auth_callback") {
  const r = await fetch(base + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }) });
  assert.equal(r.status, 201);
  return { ...(await r.json()), redirect };
}

async function authorizeCode(client, challenge, ip) {
  const r = await form("/oauth/authorize", { password: KEY, client_id: client.client_id, redirect_uri: client.redirect, state: "st-1", code_challenge: challenge, scope: "mcp" }, { "X-Forwarded-For": ip });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, client.redirect);
  assert.equal(loc.searchParams.get("state"), "st-1");
  return loc.searchParams.get("code");
}

test("bearer with the key passes; X-API-Key too", async () => {
  const ip = newIp();
  assert.equal((await mcp({ Authorization: "Bearer " + KEY, "X-Forwarded-For": ip })).status, 200);
  assert.equal((await mcp({ "X-API-Key": KEY, "X-Forwarded-For": ip })).status, 200);
});

test("wrong key and no key: 401 with resource_metadata", async () => {
  const ip = newIp();
  for (const headers of [{ Authorization: "Bearer nope" }, {}]) {
    const r = await mcp({ ...headers, "X-Forwarded-For": ip });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    assert.equal((await r.json()).error.code, -32001);
  }
  // A guarded endpoint at another path points at its own metadata.
  const r = await mcp({ "X-Forwarded-For": ip }, "/rea/mcp");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), new RegExp(`resource_metadata="${base}/\\.well-known/oauth-protected-resource/rea/mcp"`));
});

test("HTTP Basic: the key on either side", async () => {
  const ip = newIp();
  assert.equal((await mcp({ Authorization: basic("anyone:" + KEY), "X-Forwarded-For": ip })).status, 200);
  assert.equal((await mcp({ Authorization: basic(KEY + ":"), "X-Forwarded-For": ip })).status, 200);
  assert.equal((await mcp({ Authorization: basic("anyone:wrong"), "X-Forwarded-For": ip })).status, 401);
});

test("the raw key is refused in the query string", async () => {
  assert.equal((await fetch(base + "/mcp?api_key=" + encodeURIComponent(KEY), { method: "POST", headers: { "X-Forwarded-For": newIp() }, body: "{}" })).status, 401);
});

test("metadata documents", async () => {
  const as = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  assert.equal(as.issuer, base);
  assert.equal(as.authorization_endpoint, base + "/oauth/authorize");
  assert.equal(as.token_endpoint, base + "/oauth/token");
  assert.equal(as.registration_endpoint, base + "/oauth/register");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.grant_types_supported.includes("authorization_code") && as.grant_types_supported.includes("client_credentials"));

  const prm = await (await fetch(base + "/.well-known/oauth-protected-resource")).json();
  assert.equal(prm.resource, base + "/mcp");
  assert.deepEqual(prm.authorization_servers, [base]);
  assert.equal((await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json()).resource, base + "/mcp");
  auth.protectResource("/rea/mcp");
  assert.equal((await (await fetch(base + "/.well-known/oauth-protected-resource/rea/mcp")).json()).resource, base + "/rea/mcp");
  assert.equal((await fetch(base + "/.well-known/oauth-protected-resource/elsewhere")).status, 404);
  assert.equal((await fetch(base + "/oauth/token")).status, 405);
});

test("DCR -> authorize form -> token with PKCE -> token works on /mcp", async () => {
  const ip = newIp();
  const client = await register();
  assert.match(client.client_id, /^mcp-[0-9a-f]{32}$/);
  const { verifier, challenge } = pkce();

  const page = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(client.redirect)}&state=st-1&code_challenge=${challenge}&code_challenge_method=S256`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="password"/);
  assert.match(html, /https:\/\/claude\.ai/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  // Wrong key re-renders the form, never echoing the key.
  const bad = await form("/oauth/authorize", { password: "wrong-key", client_id: client.client_id, redirect_uri: client.redirect, state: "st-1", code_challenge: challenge }, { "X-Forwarded-For": ip });
  assert.equal(bad.status, 401);
  assert.doesNotMatch(await bad.text(), /wrong-key/);

  const code = await authorizeCode(client, challenge, ip);
  const tok = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirect, client_id: client.client_id });
  assert.equal(tok.status, 200);
  const body = await tok.json();
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.expires_in > 0);
  assert.notEqual(body.access_token, KEY);
  assert.equal((await mcp({ Authorization: "Bearer " + body.access_token, "X-Forwarded-For": newIp() })).status, 200);

  // The code is single use.
  const again = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirect });
  assert.equal(again.status, 400);
});

test("a registered client cannot use another redirect_uri", async () => {
  const client = await register();
  const { challenge } = pkce();
  const r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${challenge}&code_challenge_method=S256`);
  assert.equal(r.status, 400);
  const reg = await fetch(base + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(reg.status, 400);
  const plain = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(client.redirect)}&code_challenge=${challenge}&code_challenge_method=plain`);
  assert.equal(plain.status, 400);
});

test("wrong PKCE verifier is rejected and burns the code", async () => {
  const ip = newIp();
  const client = await register();
  const { verifier, challenge } = pkce();
  const code = await authorizeCode(client, challenge, ip);
  const bad = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: client.redirect, client_id: client.client_id });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_grant");
  const late = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirect, client_id: client.client_id });
  assert.equal(late.status, 400);
});

test("client_credentials: key as client_secret (post and basic)", async () => {
  const ip = newIp();
  const r = await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": ip });
  assert.equal(r.status, 200);
  const { access_token } = await r.json();
  assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": ip })).status, 200);
  assert.equal((await form("/oauth/token", { grant_type: "client_credentials" }, { Authorization: basic("client:" + KEY), "X-Forwarded-For": ip })).status, 200);
  assert.equal((await form("/oauth/token", { grant_type: "client_credentials", client_secret: "nope" }, { "X-Forwarded-For": ip })).status, 401);
  assert.equal((await form("/oauth/token", { grant_type: "password" })).status, 400);
});

test("lockout after three wrong keys; issued tokens still pass", async () => {
  const ip = newIp();
  const { access_token } = await (await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": newIp() })).json();
  for (let i = 0; i < 3; i++) assert.equal((await mcp({ Authorization: "Bearer wrong" + i, "X-Forwarded-For": ip })).status, 401);
  assert.equal((await mcp({ Authorization: "Bearer " + KEY, "X-Forwarded-For": ip })).status, 429);
  assert.equal((await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": ip })).status, 429);
  // Spoofed earlier X-Forwarded-For hops do not dodge it: the last hop counts.
  assert.equal((await mcp({ Authorization: "Bearer " + KEY, "X-Forwarded-For": "1.2.3.4, " + ip })).status, 429);
  // An issued token passes even from the throttled address (and clears its counter).
  assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": ip })).status, 200);
  assert.equal((await mcp({ Authorization: "Bearer " + KEY, "X-Forwarded-For": ip })).status, 200);
});

test("revoke removes a token for good", async () => {
  const ip = newIp();
  const { access_token } = await (await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": ip })).json();
  assert.equal((await form("/oauth/revoke", { token: access_token }, { "X-Forwarded-For": ip })).status, 401);
  assert.equal((await form("/oauth/revoke", { token: access_token }, { Authorization: "Bearer " + KEY, "X-Forwarded-For": ip })).status, 200);
  assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": ip })).status, 401);
  auth.reloadTokenStore();
  assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": newIp() })).status, 401);
});

test("token and client registration survive a reload from disk; file holds no secrets", async () => {
  const ip = newIp();
  const client = await register();
  const { verifier, challenge } = pkce();
  const code = await authorizeCode(client, challenge, ip);
  const { access_token } = await (await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirect })).json();

  const st = fs.statSync(STORE);
  assert.equal(st.mode & 0o777, 0o600);
  const raw = fs.readFileSync(STORE, "utf8");
  assert.ok(!raw.includes(KEY), "raw key in the token file");
  assert.ok(!raw.includes(access_token), "raw token in the token file");
  assert.ok(!raw.includes(crypto.createHash("sha256").update(KEY).digest("hex")), "unsalted key hash in the token file");
  assert.deepEqual(fs.readdirSync(DATA).filter((f) => f.endsWith(".tmp")), []);

  auth.reloadTokenStore();
  assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": newIp() })).status, 200);
  // The client is still known after the reload, so a foreign redirect is still refused.
  const r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${challenge}`);
  assert.equal(r.status, 400);
});

test("a token survives a wiped store (redeploy without a volume); a revoked one does not come back", async () => {
  const ip = newIp();
  const issue = async () => (await (await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": ip })).json()).access_token;
  const kept = await issue(), gone = await issue();
  assert.equal((await form("/oauth/revoke", { token: gone }, { Authorization: "Bearer " + KEY, "X-Forwarded-For": ip })).status, 200);
  // Revocations are in the store; a reload keeps them.
  auth.reloadTokenStore();
  assert.equal((await mcp({ Authorization: "Bearer " + gone, "X-Forwarded-For": newIp() })).status, 401);
  // The store vanishes entirely, as on a redeploy with no volume.
  fs.rmSync(STORE, { force: true });
  auth.reloadTokenStore();
  assert.equal((await mcp({ Authorization: "Bearer " + kept, "X-Forwarded-For": newIp() })).status, 200, "a valid token must outlive the store");
  // A forged or altered token still fails.
  const forged = kept.slice(0, -3) + (kept.endsWith("AAA") ? "BBB" : "AAA");
  assert.equal((await mcp({ Authorization: "Bearer " + forged, "X-Forwarded-For": newIp() })).status, 401);
  assert.equal((await mcp({ Authorization: "Bearer crt1.e30.x", "X-Forwarded-For": newIp() })).status, 401);
});

test("a rotated key invalidates persisted tokens", async () => {
  const { access_token } = await (await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": newIp() })).json();
  const old = config.apiKey;
  try {
    config.apiKey = "rotated-key-0123456789abcdef";
    auth.reloadTokenStore();
    assert.equal((await mcp({ Authorization: "Bearer " + access_token, "X-Forwarded-For": newIp() })).status, 401);
    assert.equal((await mcp({ Authorization: "Bearer rotated-key-0123456789abcdef", "X-Forwarded-For": newIp() })).status, 200);
  } finally {
    config.apiKey = old;
    auth.reloadTokenStore();
  }
});

test("the module starts with a token store already on disk (a volume that kept it)", async () => {
  // Every field a previous run may have written, including the revocation lists.
  const ip = newIp();
  const { access_token } = await (await form("/oauth/token", { grant_type: "client_credentials", client_secret: KEY }, { "X-Forwarded-For": ip })).json();
  await form("/oauth/revoke", { token: access_token }, { Authorization: "Bearer " + KEY, "X-Forwarded-For": ip });
  const stored = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.ok(Array.isArray(stored.revoked) && stored.revoked.length >= 1 && typeof stored.revokedBefore === "number");
  // A fresh copy of the module loads that file while it is being evaluated.
  const fresh = await import("../src/mcp-auth.js?boot-with-store");
  assert.equal(typeof fresh.checkAuth, "function");
});
