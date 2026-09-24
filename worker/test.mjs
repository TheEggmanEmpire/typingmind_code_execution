import assert from "node:assert/strict";
import worker from "./src/index.js";

const key = "k".repeat(32);
const blobs = new Map();
const writes = [];
const STORE = {
  async get(id, type) {
    const value = blobs.get(id);
    if (value === undefined) return null;
    if (type === "arrayBuffer") return typeof value === "string" ? new TextEncoder().encode(value).buffer : value.slice(0);
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  },
  async put(id, body, opts) {
    const bytes = typeof body === "string" ? body : body instanceof ArrayBuffer ? body.slice(0) : await new Response(body).arrayBuffer();
    blobs.set(id, bytes);
    writes.push({ id, expirationTtl: opts.expirationTtl });
  },
  async delete(id) { blobs.delete(id); },
};
const env = { PROXY_KEY: key, STORE_TTL: "3600", STORE };
const originalFetch = globalThis.fetch;
let targetFetch;
let passed = 0;
let failed = 0;

globalThis.fetch = async (input, init) => {
  targetFetch = { url: String(input), init };
  return new Response("upstream body", {
    status: 404,
    headers: { "Set-Cookie": "secret=upstream", "Content-Type": "text/plain" },
  });
};

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

function req(path, options) {
  return new Request(`https://worker.test${path}`, options);
}

try {
  await test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const response = await worker.fetch(req("/", { method: "OPTIONS" }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  });

  await test("proxy without key returns recognizable 401", async () => {
    const response = await worker.fetch(req("/?url=https%3A%2F%2Fexample.test"), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
    assert.equal(response.headers.get("X-CR-Proxy"), null);
  });

  await test("proxy rejects wrong-length key", async () => {
    const response = await worker.fetch(req(`/?key=${"k".repeat(31)}&url=https%3A%2F%2Fexample.test`), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
  });

  await test("proxy rejects wrong key of correct length", async () => {
    const response = await worker.fetch(req(`/?key=${"x".repeat(32)}&url=https%3A%2F%2Fexample.test`), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
  });

  await test("proxy passes target status, marks response, strips cookies and sensitive request headers", async () => {
    const target = "https://example.test/path?x=1";
    const response = await worker.fetch(req(`/?key=${key}&url=${encodeURIComponent(target)}`, {
      headers: {
        Cookie: "session=private",
        "X-CR-Key": "header-secret",
        Origin: "https://caller.test",
        "X-Keep": "yes",
      },
    }), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("X-CR-Proxy"), "1");
    assert.equal(response.headers.get("X-CR-Final-Url"), target);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(targetFetch.url, target);
    assert.equal(targetFetch.init.headers.has("cookie"), false);
    assert.equal(targetFetch.init.headers.has("x-cr-key"), false);
    assert.equal(targetFetch.init.headers.has("origin"), false);
    assert.equal(targetFetch.init.headers.get("x-keep"), "yes");
  });

  await test("invalid target URL returns 400", async () => {
    const response = await worker.fetch(req(`/?key=${key}&url=${encodeURIComponent("http://[")}`), env);
    assert.equal(response.status, 400);
  });

  await test("non-HTTP target scheme returns 400", async () => {
    const response = await worker.fetch(req(`/?key=${key}&url=${encodeURIComponent("file:///etc/passwd")}`), env);
    assert.equal(response.status, 400);
  });

  await test("store POST without key returns 401 and X-CR-Error", async () => {
    const response = await worker.fetch(req("/store", { method: "POST", body: "blob" }), env);
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "store: missing or wrong key");
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
  });

  await test("store POST with key returns bare URL without key", async () => {
    const response = await worker.fetch(req(`/store?key=${key}`, { method: "POST", body: "blob" }), env);
    assert.equal(response.status, 201);
    const value = await response.text();
    assert.match(value, /^https:\/\/worker\.test\/store\/[A-Za-z0-9_-]{24,80}$/);
    assert.equal(value.includes(key), false);
  });

  const firstId = writes.at(-1).id;

  await test("store GET without key returns 401", async () => {
    const response = await worker.fetch(req(`/store/${firstId}`), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
  });

  await test("store GET accepts query key and returns exact bytes", async () => {
    const response = await worker.fetch(req(`/store/${firstId}?key=${key}`), env);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode("blob"));
  });

  await test("store GET accepts x-cr-key header", async () => {
    const response = await worker.fetch(req(`/store/${firstId}`, { headers: { "x-cr-key": key } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode("blob"));
  });

  await test("DELETE without key returns 401", async () => {
    const response = await worker.fetch(req(`/store/${firstId}`, { method: "DELETE" }), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-CR-Error"), "bad-key");
    assert.equal(blobs.has(firstId), true);
  });

  await test("DELETE with key deletes blob and subsequent GET returns 404", async () => {
    const deleted = await worker.fetch(req(`/store/${firstId}?key=${key}`, { method: "DELETE" }), env);
    assert.equal(deleted.status, 200);
    assert.equal(blobs.has(firstId), false);
    const missing = await worker.fetch(req(`/store/${firstId}?key=${key}`), env);
    assert.equal(missing.status, 404);
  });

  await test("oversized Content-Length returns 413 before reading body", async () => {
    const request = req(`/store?key=${key}`, {
      method: "POST",
      headers: { "Content-Length": String(24 * 1024 * 1024 + 1) },
      body: "x",
    });
    let read = false;
    Object.defineProperty(request, "arrayBuffer", { value: async () => { read = true; throw new Error("body was read"); } });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 413);
    assert.equal(read, false);
  });

  await test("ttl is clamped to 60 seconds minimum and 604800 maximum", async () => {
    await worker.fetch(req(`/store?key=${key}&ttl=5`, { method: "POST", body: "small" }), env);
    await worker.fetch(req(`/store?key=${key}&ttl=999999999`, { method: "POST", body: "large" }), env);
    assert.deepEqual(writes.slice(-2).map((entry) => entry.expirationTtl), [60, 604800]);
  });

  await test("deletion links: key required, GET confirms, POST deletes once (gofile)", async () => {
    const body = JSON.stringify({ service: "gofile", name: "report.pdf", url: "https://gofile.io/d/abc", id: "content-1", token: "guest-token" });
    const denied = await worker.fetch(req("/links", { method: "POST", body }), env);
    assert.equal(denied.status, 401);
    const made = await worker.fetch(req(`/links?key=${key}`, { method: "POST", body }), env);
    assert.equal(made.status, 201);
    const link = (await made.text()).trim();
    assert.match(link, /^https:\/\/worker\.test\/unshare\/[A-Za-z0-9_-]{24,}$/);
    const path = new URL(link).pathname;
    const page = await worker.fetch(req(path), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Delete shared file/);
    assert.match(html, /report\.pdf/);
    assert.ok(!/guest-token/.test(html), "the page must not reveal the token");
    let deleted = null;
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init) => { deleted = { url: String(input), init }; return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } }); };
    try {
      const done = await worker.fetch(req(path, { method: "POST" }), env);
      assert.equal(done.status, 200);
      assert.match(await done.text(), /Deleted/);
    } finally { globalThis.fetch = saved; }
    assert.equal(deleted.url, "https://api.gofile.io/contents");
    assert.equal(deleted.init.method, "DELETE");
    assert.equal(deleted.init.headers.Authorization, "Bearer guest-token");
    const again = await worker.fetch(req(path), env);
    assert.equal(again.status, 404);
  });

  await test("deletion links for catbox call deletefiles with the userhash", async () => {
    const made = await worker.fetch(req(`/links?key=${key}`, { method: "POST", body: JSON.stringify({ service: "catbox", name: "a.png", url: "https://files.catbox.moe/x1.png", file: "x1.png", userhash: "uh" }) }), env);
    const path = new URL((await made.text()).trim()).pathname;
    let form = null;
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init) => { form = init.body; return new Response("Files successfully deleted."); };
    try { assert.equal((await worker.fetch(req(path, { method: "POST" }), env)).status, 200); } finally { globalThis.fetch = saved; }
    assert.equal(form.get("reqtype"), "deletefiles");
    assert.equal(form.get("userhash"), "uh");
    assert.equal(form.get("files"), "x1.png");
  });

  await test("a failed deletion keeps the link", async () => {
    const made = await worker.fetch(req(`/links?key=${key}`, { method: "POST", body: JSON.stringify({ service: "gofile", name: "b", url: "https://gofile.io/d/b", id: "i", token: "t" }) }), env);
    const path = new URL((await made.text()).trim()).pathname;
    const saved = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "error-notFound" }));
    try { assert.equal((await worker.fetch(req(path, { method: "POST" }), env)).status, 502); } finally { globalThis.fetch = saved; }
    assert.equal((await worker.fetch(req(path), env)).status, 200);
  });

  await test("links: javascript: or foreign URLs and non-object bodies are refused", async () => {
    for (const body of [
      JSON.stringify({ service: "gofile", name: "x", url: "javascript:alert(1)", id: "i", token: "t" }),
      JSON.stringify({ service: "gofile", name: "x", url: "https://evil.example/d/x", id: "i", token: "t" }),
      JSON.stringify({ service: "catbox", name: "x", url: "https://files.catbox.moe.evil.example/x", file: "x", userhash: "u" }),
      "null", "[]"
    ]) {
      const r = await worker.fetch(req(`/links?key=${key}`, { method: "POST", body }), env);
      assert.equal(r.status, 400, body);
    }
  });

  await test("missing STORE binding returns 503", async () => {
    const response = await worker.fetch(req(`/store?key=${key}`, { method: "POST", body: "blob" }), { PROXY_KEY: key, STORE_TTL: "3600" });
    assert.equal(response.status, 503);
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
