// Code Runner companion Worker: a private CORS proxy plus a short-lived blob
// store for large workspaces. Deployed on the Cloudflare free tier.
//
//   GET|POST|... /?key=KEY&url=<encoded target>   proxy any http(s) request
//   POST /store?key=KEY[&ttl=seconds]              store the body, returns its URL
//   GET|DELETE /store/<id>?key=KEY                 read / delete a stored blob
//
// The proxy and all store operations require KEY (secret PROXY_KEY).

const STRIP_REQUEST = /^(host|origin|referer|cookie|content-length|connection|accept-encoding|x-forwarded-.*|x-real-ip|cf-.*|sec-fetch-.*|x-cr-key)$/i;
const STORE_ID = /^\/store\/([A-Za-z0-9_-]{24,80})$/;
const MAX_STORE_BYTES = 24 * 1024 * 1024;   // KV values are capped at 25 MB

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
