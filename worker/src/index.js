// Code Runner companion Worker: a private CORS proxy plus a short-lived blob
// store for large workspaces. Deployed on the Cloudflare free tier.
//
//   GET|POST|... /?key=KEY&url=<encoded target>   proxy any http(s) request
//   POST /store?key=KEY[&ttl=seconds]              store the body, returns its URL
//   GET|DELETE /store/<id>?key=KEY                 read / delete a stored blob
//   POST /links?key=KEY                             register a shared file, returns its deletion link
//   GET|POST /unshare/<id>                          deletion page (GET) / delete the shared file (POST)
//
// The proxy and all store operations require KEY (secret PROXY_KEY).

const STRIP_REQUEST = /^(host|origin|referer|cookie|content-length|connection|accept-encoding|x-forwarded-.*|x-real-ip|cf-.*|sec-fetch-.*|x-cr-key)$/i;
const STORE_ID = /^\/store\/([A-Za-z0-9_-]{24,80})$/;
const MAX_STORE_BYTES = 24 * 1024 * 1024;   // KV values are capped at 25 MB
const LINK_ID = /^\/unshare\/([A-Za-z0-9_-]{24,80})$/;
const LINK_TTL = 90 * 86400;               // deletion links live 90 days

function html(title, body, status = 200) {
  const page = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>" + title +
    "</title><body style='font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px'>" + body + "</body>";
  return new Response(page, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Stores what is needed to delete a shared file; the link itself is the permission.
async function registerLink(request, url, env) {
  if (!env.STORE) return text("links: KV binding STORE is not configured", 503);
  let d;
  try { d = await request.json(); } catch (e) { return text("links: send JSON", 400); }
  if (!d || typeof d !== "object" || Array.isArray(d)) return text("links: send a JSON object", 400);
  const rec = { service: String(d.service || ""), name: String(d.name || "file").slice(0, 200), url: String(d.url || "").slice(0, 500), time: Date.now() };
  // The page links to the shared file: only https links on the service's own hosts.
  const hosts = { gofile: /^(www\.)?gofile\.io$/, catbox: /^files\.catbox\.moe$/ }[rec.service];
  let u = null;
  try { u = new URL(rec.url); } catch (e) {}
  if (!hosts || !u || u.protocol !== "https:" || !hosts.test(u.hostname)) return text("links: url must be an https link on " + (rec.service || "the service") + "'s host", 400);
  if (rec.service === "gofile") { if (!d.id || !d.token) return text("links: gofile needs id and token", 400); rec.id = String(d.id); rec.token = String(d.token); }
  else if (rec.service === "catbox") { if (!d.file || !d.userhash) return text("links: catbox needs file and userhash", 400); rec.file = String(d.file); rec.userhash = String(d.userhash); }
  else return text("links: service must be gofile or catbox", 400);
  const id = newId();
  await env.STORE.put("link:" + id, JSON.stringify(rec), { expirationTtl: LINK_TTL });
  return text(url.origin + "/unshare/" + id, 201);
}

async function deleteShared(rec) {
  if (rec.service === "gofile") {
    const r = await fetch("https://api.gofile.io/contents", { method: "DELETE", headers: { "Authorization": "Bearer " + rec.token, "Content-Type": "application/json" }, body: JSON.stringify({ contentsId: rec.id }) });
    const d = await r.json().catch(() => null);
    if (!d || d.status !== "ok") throw new Error("gofile.io refused (" + (d && d.status || "HTTP " + r.status) + ")");
    return;
  }
  const form = new FormData();
  form.append("reqtype", "deletefiles"); form.append("userhash", rec.userhash); form.append("files", rec.file);
  const r = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
  const t = (await r.text()).trim();
  if (!r.ok || !/success/i.test(t)) throw new Error("catbox.moe refused (" + (t.slice(0, 100) || "HTTP " + r.status) + ")");
}

// GET shows a confirmation page (link previews must not delete anything); POST deletes.
async function unshare(request, id, env) {
  if (!env.STORE) return html("Not available", "<p>This deletion service is not configured.</p>", 503);
  const raw = await env.STORE.get("link:" + id);
  if (!raw) return html("Link expired", "<h2>Nothing to delete</h2><p>This file was already deleted, or the deletion link has expired.</p>", 404);
  const rec = JSON.parse(raw);
  if (request.method === "POST") {
    try { await deleteShared(rec); }
    catch (e) { return html("Not deleted", "<h2>Could not delete</h2><p>" + esc(e.message) + "</p><p>Try again later.</p>", 502); }
    await env.STORE.delete("link:" + id);
    return html("Deleted", "<h2>Deleted</h2><p><b>" + esc(rec.name) + "</b> was removed from " + esc(rec.service) + ".</p>");
  }
  return html("Delete shared file", "<h2>Delete shared file?</h2><p><b>" + esc(rec.name) + "</b><br><a href='" + esc(rec.url) + "'>" + esc(rec.url) + "</a><br>" +
    "on " + esc(rec.service) + ", shared " + esc(new Date(rec.time).toISOString().slice(0, 16).replace("T", " ")) + " UTC</p>" +
    "<form method=post><button style='font:inherit;padding:8px 16px;background:#cf222e;color:#fff;border:0;border-radius:6px;cursor:pointer'>Delete it</button></form>");
}

function cors(headers = new Headers()) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Access-Control-Max-Age", "86400");
  headers.delete("Access-Control-Allow-Credentials");
  return headers;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: cors(new Headers({ "Content-Type": "text/plain; charset=utf-8" })) });
}

function authError(body) {
  const headers = cors(new Headers({ "Content-Type": "text/plain; charset=utf-8", "X-CR-Error": "bad-key" }));
  return new Response(body, { status: 401, headers });
}

function keyOk(request, url, env) {
  const expected = env.PROXY_KEY || "";
  const given = url.searchParams.get("key") || request.headers.get("x-cr-key") || "";
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function proxy(request, target) {
  let dest;
  try { dest = new URL(target); } catch (e) { return text("proxy: invalid url " + target, 400); }
  if (!/^https?:$/.test(dest.protocol)) return text("proxy: only http(s) urls are allowed", 400);

  const headers = new Headers();
  for (const [k, v] of request.headers) if (!STRIP_REQUEST.test(k)) headers.set(k, v);
  const method = request.method.toUpperCase();
  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;

  let upstream;
  try { upstream = await fetch(dest.toString(), init); }
  catch (e) { return text("proxy: could not reach " + dest.host + ": " + (e.message || e), 502); }

  const out = cors(new Headers(upstream.headers));
  out.delete("Set-Cookie");
  out.set("X-CR-Proxy", "1");                 // tells the plugin this status is the target's own
  out.set("X-CR-Final-Url", upstream.url || dest.toString());
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

function newId() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function store(request, url, env) {
  if (!env.STORE) return text("store: KV binding STORE is not configured", 503);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_STORE_BYTES) {
    return text("store: payload too large (max 24 MB)", 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_STORE_BYTES) return text("store: payload too large (max 24 MB)", 413);
  const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl")) || Number(env.STORE_TTL) || 3600, 60), 7 * 86400);
  const id = newId();
  await env.STORE.put(id, body, { expirationTtl: ttl });
  return text(url.origin + "/store/" + id, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    try {
      const lm = url.pathname.match(LINK_ID);
      if (lm) return await unshare(request, lm[1], env);
      if (url.pathname === "/links") {
        if (request.method !== "POST") return text("links: POST JSON to /links", 405);
        if (!keyOk(request, url, env)) return authError("links: missing or wrong key");
        return await registerLink(request, url, env);
      }
      const m = url.pathname.match(STORE_ID);
      if (m) {
        if (!keyOk(request, url, env)) return authError("store: missing or wrong key");
        if (!env.STORE) return text("store: KV binding STORE is not configured", 503);
        if (request.method === "DELETE") { await env.STORE.delete(m[1]); return text("deleted"); }
        const v = await env.STORE.get(m[1], "arrayBuffer");
        if (v === null) return text("store: not found or expired", 404);
        return new Response(v, { headers: cors(new Headers({ "Content-Type": "text/plain; charset=utf-8" })) });
      }
      if (url.pathname === "/store") {
        if (request.method !== "POST") return text("store: POST a body to /store", 405);
        if (!keyOk(request, url, env)) return authError("store: missing or wrong key");
        return store(request, url, env);
      }
      if (url.pathname === "/" && url.searchParams.has("url")) {
        if (!keyOk(request, url, env)) return authError("proxy: missing or wrong key");
        return proxy(request, url.searchParams.get("url"));
      }
      if (url.pathname === "/") return text("Code Runner proxy is running.");
      return text("not found", 404);
    } catch (e) {
      return text("worker error: " + (e.message || e), 500);
    }
  }
};
