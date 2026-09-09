// CDNs are tried in order; the first one that serves the runtime wins.
// The jsDelivr endpoints are separate providers (multi-CDN, Fastly, Gcore,
// Cloudflare) that all carry the full Pyodide distribution including wheels.
// unpkg mirrors only the npm package (core runtime), so wheels still come
// from a full distribution when it is used.
const PYODIDE_VERSION = "0.29.4";
const PYODIDE_CDNS = [
  { index: "https://cdn.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://fastly.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://gcore.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://testingcf.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://unpkg.com/pyodide@" + PYODIDE_VERSION + "/",
    packages: "https://fastly.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" }
];
const SQLJS_VERSION = "1.13.0";
const SQLJS_CDNS = [
  "https://cdn.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://fastly.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://unpkg.com/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://gcore.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/"
];
const SCRIPT_TIMEOUT_MS  = 30000;
const RUNTIME_TIMEOUT_MS = 180000;   // wasm + stdlib download can be slow on mobile

// Session-scoped scratch space inside the Pyodide (Emscripten MEMFS) filesystem.
// Shared by Python, JavaScript (via `fs`) and SQL (data.sqlite). Lives until the page reloads.
const WORKDIR = "/workspace";
const DB_FILE = WORKDIR + "/data.sqlite";

const CE = {
  "c":       { id: "cg142",              lang: "c"       },
  "c++":     { id: "g142",               lang: "c++"     },
  "rust":    { id: "r1820",              lang: "rust"    },
  "go":      { id: "gl1260",             lang: "go"      },
  "ruby":    { id: "ruby405",            lang: "ruby"    },
  "java":    { id: "java2501",           lang: "java"    },
  "csharp":  { id: "dotnet90csharpmono", lang: "csharp"  },
  "haskell": { id: "ghc984",             lang: "haskell" },
  "lua":     { id: "lua550",             lang: "lua"     }
};

function loadScript(src) {
  if (typeof document === "undefined") {
    // Web Worker (no DOM): importScripts is synchronous.
    if (typeof importScripts === "function") {
      try { importScripts(src); return Promise.resolve(); }
      catch (e) { return Promise.reject(new Error("Could not load " + src + ": " + (e.message || e))); }
    }
    return Promise.reject(new Error("No document or importScripts to load " + src));
  }
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => { s.remove(); rej(new Error("Could not load " + src)); };
    document.head.appendChild(s);
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + " timed out after " + ms / 1000 + " s")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeBase(u) {
  u = String(u || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u : u + "/";
}

// Custom CDN from plugin settings goes first, then the built-in list.
function cdnCandidates(defaults, custom) {
  const c = normalizeBase(custom);
  return c ? [typeof defaults[0] === "string" ? c : { index: c }, ...defaults] : defaults;
}

// ---------------------------------------------------------------------------
// Network. Requests go direct first. If the browser blocks one (CORS) the same
// request is retried through public CORS proxies so it works out of the box -
// a user-configured proxy (plugin settings) is tried first, then the built-in
// list below. Nothing is proxied unless the direct request actually failed, and
// credentialed requests are never proxied.
// ---------------------------------------------------------------------------

// enc: how the target URL is attached. "q" = encodeURIComponent appended,
// "raw" = appended as-is, "tpl" = replace {url} (encoded) in the template.
const BUILTIN_PROXIES = [
  { u: "https://corsproxy.io/?url=",                 enc: "q" },
  { u: "https://api.allorigins.win/raw?url=",         enc: "q" },
  { u: "https://api.codetabs.com/v1/proxy/?quest=",   enc: "q" },
  { u: "https://proxy.corsfix.com/?",                 enc: "q" },
  { u: "https://cors.eu.org/",                        enc: "raw" },
  { u: "https://thingproxy.freeboard.io/fetch/",      enc: "raw" },
  { u: "https://proxy.cors.sh/",                      enc: "raw" },
  { u: "https://yacdn.org/proxy/",                    enc: "raw" },
  { u: "https://test.cors.workers.dev/?",             enc: "raw" },
  { u: "https://whateverorigin.org/get?url=",         enc: "q", wrap: "json" }
];

function applyProxy(spec, url) {
  if (spec.enc === "tpl" || spec.u.includes("{url}")) return spec.u.replace("{url}", encodeURIComponent(url));
  return spec.u + (spec.enc === "raw" ? url : encodeURIComponent(url));
}

// Ordered proxy candidates for a URL: the user's custom proxy first, then the
// built-ins. Only http(s) URLs are proxied.
function proxyCandidates(url) {
  if (!/^https?:\/\//i.test(url)) return [];
  const list = [];
  const custom = globalThis.__crCorsProxy;
  if (custom) list.push({ u: custom, enc: custom.includes("{url}") ? "tpl" : "q" });
  return list.concat(BUILTIN_PROXIES).map((spec) => ({ url: applyProxy(spec, url), wrap: spec.wrap }));
}

// Back-compat single-proxy helper (custom proxy only), still used by the sync
// XHR path's simplest case.
function proxyUrl(url) {
  const c = proxyCandidates(url);
  return c.length ? c[0].url : null;
}

function fetchTimeoutMs() {
  const n = Number(globalThis.__crFetchTimeout);
  return n > 0 ? n : 30000;
}
// Time budget for one request, worst case: direct (fetchTimeoutMs, default
// 30 s) + the proxy phase (at most proxyPhaseMs, default 45 s). Proxies are
// raced PROXY_PARALLEL at a time with a short per-hop timeout, so a wall of
// dead proxies costs seconds, not minutes.
const PROXY_PARALLEL = 3;
function proxyTimeoutMs() { return Math.min(fetchTimeoutMs(), 15000); }
function proxyPhaseMs()   { return Math.min(45000, 3 * proxyTimeoutMs()); }
// A host that failed direct + proxies is remembered for a few minutes (also
// across calls, via the state trailer). Later requests to it get one short
// direct probe and no proxy walk, so a dead image CDN costs seconds per URL
// instead of a full timeout cycle per URL.
const DEAD_HOST_TTL_MS = 3 * 60 * 1000;
function deadHostProbeMs() { return Math.min(fetchTimeoutMs(), 5000); }
const XHR_SYNC_PROXY_MAX = 4;   // sync XHR has no timeout on the main thread: keep the walk short

function hostOf(url) { try { return new URL(String(url)).host; } catch (e) { return ""; } }
function isAbort(e) { return !!e && (e.name === "AbortError" || e.name === "TimeoutError"); }

function hostHealth() {
  if (!globalThis.__crHostHealth || typeof globalThis.__crHostHealth !== "object") globalThis.__crHostHealth = {};
  return globalThis.__crHostHealth;
}
// Live (non-expired) record for a host, or null.
function deadHost(host) {
  if (!host) return null;
  const h = hostHealth()[host];
  if (!h) return null;
  if (!(Date.now() - h.t < DEAD_HOST_TTL_MS)) { delete hostHealth()[host]; return null; }
  return h;
}
// k: "t" = the host never answered (timeout), "b" = it was blocked (CORS/reset)
// and the proxies failed too. A blocked host is re-probed through a proxy wave.
function markDead(host, why, k) { if (host) hostHealth()[host] = { t: Date.now(), why, k: k || "t" }; netNote(host, why); }
function markAlive(host) { if (host && hostHealth()[host]) delete hostHealth()[host]; }
// Per-run log of hosts that could not be reached; appended to the output so
// the model learns what failed even when its own code swallowed the error.
function netNote(host, why) {
  if (!globalThis.__crNetLog) globalThis.__crNetLog = new Map();
  if (host && !globalThis.__crNetLog.has(host)) globalThis.__crNetLog.set(host, why);
}
function netError(host, why, cause) {
  const e = new TypeError("Could not reach " + (host || "host") + ": " + why);
  if (cause) e.cause = cause;
  return e;
}
// Snapshot of remembered-dead hosts for the state trailer (expired ones dropped).
function hostHealthSnapshot() {
  const out = {}, hh = hostHealth();
  for (const host of Object.keys(hh)) if (deadHost(host)) out[host] = hh[host];
  return Object.keys(out).length ? out : null;
}

// fetch with an AbortController timeout. The cap applies on top of a
// caller-supplied signal: urllib3's emscripten backend (behind `requests`)
// always passes a signal, even when the Python code set no timeout, so leaving
// such requests uncapped would let a silent host hang the run. A caller whose
// own signal fires keeps its deadline: fetchDirectThenProxies checks
// init.signal.aborted and stops there instead of walking the proxies.
async function timedFetch(real, input, init, ms) {
  init = init || {};
  if (typeof AbortController !== "function") return real(input, init);
  const ac = new AbortController(), parent = init.signal;
  const onAbort = () => ac.abort();
  if (parent) { if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort); }
  const t = setTimeout(onAbort, ms || fetchTimeoutMs());
  try { return await real(input, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); if (parent) parent.removeEventListener("abort", onAbort); }
}

// One proxy hop with its own timeout, linked to the caller's signal if any.
// Resolves {r} on a 2xx, null otherwise (never rejects); `abort` cancels it.
function proxyHop(real, cand, init, ms, stats) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const parent = init.signal;
  const onAbort = () => ac && ac.abort();
  if (parent && ac) { if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort); }
  const t = setTimeout(onAbort, ms);
  let won = false;
  // A winner stays linked to the caller's signal so a later caller abort still cancels its body.
  const cleanup = () => { clearTimeout(t); if (!won && parent && ac) parent.removeEventListener("abort", onAbort); };
  stats.tried++;
  const promise = Promise.resolve()
    .then(() => real(cand.url, ac ? { ...init, signal: ac.signal } : init))
    .then(async (r) => {
      if (!(r && r.status >= 200 && r.status < 300)) { stats.http++; return null; }
      if (cand.wrap === "json") {   // e.g. whateverorigin: {"contents": "...", "status": {...}}
        try { const j = await r.json(); if (j && typeof j.contents === "string") { won = true; return { r: new Response(j.contents, { status: 200 }) }; } } catch (e) {}
        stats.errors++; return null;
      }
      won = true;
      return { r };
    }, (e) => { if (isAbort(e)) stats.timeouts++; else stats.errors++; return null; })
    .finally(cleanup);
  return { promise, abort: onAbort };
}

// Race the proxy candidates PROXY_PARALLEL at a time; the first 2xx wins and
// the rest of its wave is aborted. The phase budget is a hard deadline: no hop
// outlives it. Non-idempotent requests (POST, PUT, ...) go one proxy at a time
// so the target never sees the same write twice. Returns the winning Response
// or null; stops as soon as the caller's own signal aborts.
async function raceProxies(real, cands, init, stats, budgetMs) {
  const deadline = Date.now() + (budgetMs || proxyPhaseMs());
  const width = /^(get|head)$/i.test(init.method || "GET") ? PROXY_PARALLEL : 1;
  for (let i = 0; i < cands.length; i += width) {
    const left = deadline - Date.now();
    if (left <= 0 || (init.signal && init.signal.aborted)) { stats.skipped = cands.length - i; break; }
    const hops = cands.slice(i, i + width).map((c) => proxyHop(real, c, init, Math.min(proxyTimeoutMs(), left), stats));
    const win = await new Promise((resolve) => {
      let left = hops.length;
      hops.forEach((h) => h.promise.then((v) => { if (v) resolve({ hop: h, r: v.r }); else if (--left === 0) resolve(null); }));
    });
    if (win) { for (const h of hops) if (h !== win.hop) h.abort(); return win.r; }
  }
  return null;
}

function describeStats(stats) {
  const parts = [];
  if (stats.timeouts) parts.push(stats.timeouts + " timed out");
  if (stats.http) parts.push(stats.http + " returned an error status");
  if (stats.errors) parts.push(stats.errors + " failed");
  if (stats.skipped) parts.push(stats.skipped + " skipped, time budget spent");
  return parts.join(", ");
}

// Direct first. A transport failure that is not a timeout (CORS block, DNS,
// reset) gets one immediate retry; a timeout does not - waiting twice for a
// host that does not answer only doubles the loss. If direct fails, the proxy
// candidates are raced (see raceProxies). A real HTTP response (even 4xx/5xx)
// is returned as-is and never triggers a proxy hop. A host that fails every
// path is remembered (markDead) so the next request to it fails fast.
async function fetchDirectThenProxies(real, input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  init = init || {};
  if (typeof Request === "function" && input instanceof Request) {
    if (!init.method) init = { ...init, method: input.method };
    if (!init.headers) init = { ...init, headers: input.headers };
  }
  const host = hostOf(url);
  const dead = deadHost(host);
  if (dead) {
    // Known-bad host: one short direct probe; a host that was blocked (not
    // silent) also gets one short proxy wave, since the proxies were its only
    // viable path. Anything answering clears the memo.
    let probeErr;
    try { const r = await timedFetch(real, input, init, deadHostProbeMs()); markAlive(host); return r; }
    catch (e) { probeErr = e; }
    if (init.signal && init.signal.aborted) throw probeErr;
    if (dead.k === "b") {
      const cands = proxyCandidates(url).slice(0, PROXY_PARALLEL);   // one wave, one probe budget
      const r = cands.length && await raceProxies(real, cands, init, { tried: 0, timeouts: 0, http: 0, errors: 0, skipped: 0 }, deadHostProbeMs());
      if (r) { markAlive(host); return r; }
      if (init.signal && init.signal.aborted) throw probeErr;
    }
    const age = Math.max(1, Math.round((Date.now() - dead.t) / 1000));
    const left = Math.max(1, Math.ceil((DEAD_HOST_TTL_MS - (Date.now() - dead.t)) / 60000));
    const why = "unreachable " + age + " s ago (" + dead.why + "); a " + (deadHostProbeMs() / 1000) +
      " s re-probe also failed. Requests to it fail fast for ~" + left + " more min - use a different host or URL.";
    netNote(host, why);
    throw netError(host, why, probeErr);
  }
  let e1;
  try { return await timedFetch(real, input, init); } catch (e) { e1 = e; }
  if (init.signal && init.signal.aborted) throw e1;   // the caller's own deadline: not ours to work around
  const timedOut = isAbort(e1);
  if (!timedOut) { try { return await timedFetch(real, input, init); } catch (e) { e1 = e; } }
  const cands = proxyCandidates(url);
  const streamBody = typeof ReadableStream === "function" && init.body instanceof ReadableStream;
  if (!cands.length || streamBody) throw e1;
  const stats = { tried: 0, timeouts: 0, http: 0, errors: 0, skipped: 0 };
  const r = await raceProxies(real, cands, init, stats);
  if (r) return r;
  if (init.signal && init.signal.aborted) throw e1;   // caller gave up mid-race: not the host's fault
  const why = (timedOut ? "direct request timed out after " + (fetchTimeoutMs() / 1000) + " s"
                        : "direct request failed (" + (e1 && e1.message || e1) + ")") +
    "; " + stats.tried + " CORS proxies failed (" + describeStats(stats) + "). Remembered for " +
    (DEAD_HOST_TTL_MS / 60000) + " min: further requests to this host fail fast - use a different host or URL.";
  markDead(host, why, timedOut ? "t" : "b");
  throw netError(host, why, e1);
}

async function netFetch(input, init) {
  const real = globalThis.__crRealFetch || fetch;
  return fetchDirectThenProxies(real, input, init);
}

// Python's urllib3 (behind `requests`) calls the global fetch when the browser
// supports JSPI, and pyodide-http / urllib3 without JSPI use synchronous
// XMLHttpRequest. Both get the same direct-then-proxy behaviour, but only while
// run_code is executing, and never for requests that carry credentials, so the
// host app's own API traffic is never routed through the proxy.
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i;

function carriesCredentials(input, init) {
  if (init && init.credentials === "include") return true;
  const scan = (h) => {
    if (!h) return false;
    if (typeof h.forEach === "function" && !Array.isArray(h)) { let hit = false; h.forEach((v, k) => { if (AUTH_HEADER.test(k)) hit = true; }); return hit; }
    if (Array.isArray(h)) return h.some(([k]) => AUTH_HEADER.test(k));
    return Object.keys(h).some((k) => AUTH_HEADER.test(k));
  };
  if (init && scan(init.headers)) return true;
  if (input && typeof input === "object" && input.headers && scan(input.headers)) return true;
  return false;
}

function patchFetch() {
  if (globalThis.__crFetchPatched || typeof globalThis.fetch !== "function") return;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.__crRealFetch = real;
  globalThis.fetch = async function (input, init) {
    // Outside a run, or for credentialed requests, stay out of the way entirely.
    if (!globalThis.__crRunning || carriesCredentials(input, init)) return real(input, init);
    return fetchDirectThenProxies(real, input, init);
  };
  globalThis.__crFetchPatched = true;
}

function patchXHR() {
  const X = globalThis.XMLHttpRequest;
  if (!X || X.prototype.__crPatched) return;
  const P = X.prototype, open = P.open, send = P.send, setHeader = P.setRequestHeader;
  P.open = function (method, url, async, user, pw) {
    this.__cr = { method, url: String(url), sync: async === false, headers: [], user, pw };
    return open.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    if (this.__cr) this.__cr.headers.push([k, v]);
    return setHeader.call(this, k, v);
  };
  P.send = function (body) {
    const r = this.__cr;
    if (!r || !r.sync || !globalThis.__crRunning) return send.call(this, body);
    const host = hostOf(r.url), dead = deadHost(host);
    let err = null;
    try { send.call(this, body); } catch (e) { err = e; }
    if (!err && this.status !== 0) { markAlive(host); return; }   // direct request already answered
    if (dead) {   // known-bad host: no proxy walk, fail now
      const why = "unreachable " + Math.max(1, Math.round((Date.now() - dead.t) / 1000)) + " s ago (" + dead.why + "); direct retry failed again - use a different host or URL.";
      netNote(host, why);
      throw netError(host, why, err);
    }
    const cands = proxyCandidates(r.url).filter((c) => !c.wrap).slice(0, XHR_SYNC_PROXY_MAX);
    for (const cand of cands) {
      try {
        open.call(this, r.method, cand.url, false, r.user, r.pw);
        for (const [k, v] of r.headers) setHeader.call(this, k, v);
        send.call(this, body);
        if (this.status >= 200 && this.status < 300) return;   // a proxy answered
      } catch (e) { err = e; }
    }
    if (cands.length) markDead(host, "direct request failed; " + cands.length + " CORS proxies failed. Remembered for " + (DEAD_HOST_TTL_MS / 60000) + " min: further requests to this host fail fast - use a different host or URL.", "b");
    if (err) throw err;   // nothing worked: surface the original failure
    throw netError(host, "direct request and " + cands.length + " CORS proxies failed", null);
  };
  P.__crPatched = true;
}

// ---------------------------------------------------------------------------
// Cross-call state. TypingMind runs every call in a brand-new sandboxed iframe
// with an opaque origin: nothing in memory, IndexedDB or localStorage survives
// from one call to the next. The one channel between calls is the plugin's own
// previous output (resources.previousRunOutput), so the workspace, the SQL
// database and the JS storage map travel as a compressed trailer on the output.
// ---------------------------------------------------------------------------

// Trailer that carries state to the next call. run_code emits the plain form at
// the end of its output; serve_file emits it inside an HTML comment so it stays
// invisible when the markdown is rendered. Both are parsed here.
const STATE_LIMIT_KB_DEFAULT = 24;

// Return the last [[cr-state:...]] payload in the text (plain or HTML-comment
// form). A fresh regex each call - never a shared, stateful global one.
function extractTrailer(text) {
  const re = /\[\[cr-state:([A-Za-z0-9+/=]+)\]\]/g;
  let m, last = null;
  while ((m = re.exec(String(text))) !== null) last = m[1];
  return last;
}

function bytesToBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
async function pipeBytes(u8, stream) {
  const r = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(r).arrayBuffer());
}
// Prefix byte: 1 = deflate-raw, 0 = stored.
async function packBytes(u8) {
  if (typeof CompressionStream === "function") {
    try {
      const z = await pipeBytes(u8, new CompressionStream("deflate-raw"));
      const out = new Uint8Array(z.length + 1); out[0] = 1; out.set(z, 1); return out;
    } catch (e) {}
  }
  const out = new Uint8Array(u8.length + 1); out[0] = 0; out.set(u8, 1); return out;
}
async function unpackBytes(u8) {
  const body = u8.subarray(1);
  if (u8[0] === 1) return pipeBytes(body, new DecompressionStream("deflate-raw"));
  return body;
}

function walkWorkspace(py, dir, out) {
  for (const name of py.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const p = dir + "/" + name, st = py.FS.stat(p);
    if (py.FS.isDir(st.mode)) walkWorkspace(py, p, out);
    else out.push([p.slice(WORKDIR.length + 1), bytesToBase64(py.FS.readFile(p))]);
  }
}

// ---------------------------------------------------------------------------
// Large-workspace offload. When the packed snapshot is bigger than the inline
// token budget, it is uploaded to a public ephemeral bin and only a tiny
// pointer (URL + delete handle + expiry) travels in the trailer. The next call
// downloads it (via netFetch, so the CORS proxies apply), and supersedes the
// previous blob by deleting it. A 10-minute logical expiry is enforced here;
// exact server-side deletion timing depends on the bin.
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;

// Bins are tried in order; the user's own endpoint (workspaceStore setting) is
// tried first when set. A "paste" bin: POST body -> response body is the read
// URL; GET url -> body; DELETE url. A "dpaste" bin: form POST -> URL, raw at
// url+".txt", no delete (logical expiry + supersede still bound its life).
const BUILTIN_BINS = [
  { host: "https://paste.rs/",            kind: "paste"   },
  { host: "https://dpaste.com/api/v2/",   kind: "dpaste"  },
  { host: "https://sprunge.us",           kind: "sprunge" }
];

function storeBins() {
  const custom = globalThis.__crWorkspaceStore;
  const list = custom ? [{ host: custom, kind: "paste", custom: true }] : [];
  return list.concat(BUILTIN_BINS);
}

function rawFetch() { return globalThis.__crRealFetch || fetch; }

async function binUpload(bin, payload) {
  const real = rawFetch();
  if (bin.kind === "dpaste") {
    const body = new URLSearchParams({ content: payload, syntax: "text", expiry_days: "1" });
    const r = await withTimeout(real(bin.host, { method: "POST", body }), fetchTimeoutMs(), "upload to " + bin.host);
    if (!r.ok) throw new Error("dpaste HTTP " + r.status);
    const url = (await r.text()).trim().replace(/\/$/, "");
    return { url: url + ".txt", del: null };
  }
  if (bin.kind === "sprunge") {
    const body = new URLSearchParams({ sprunge: payload });
    const r = await withTimeout(real(bin.host, { method: "POST", body }), fetchTimeoutMs(), "upload to " + bin.host);
    if (!r.ok) throw new Error("sprunge HTTP " + r.status);
    const url = (await r.text()).trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("sprunge did not return a URL");
    return { url, del: null };
  }
  // paste: POST the payload, response body is the URL.
  const r = await withTimeout(real(bin.host, { method: "POST", body: payload }), fetchTimeoutMs(), "upload to " + bin.host);
  if (!(r.ok || r.status === 201)) throw new Error("paste HTTP " + r.status);
  let url = (await r.text()).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("upload did not return a URL");
  return { url, del: url };
}

async function uploadState(payload, prevDel) {
  let last = null;
  for (const bin of storeBins()) {
    try {
      const { url, del } = await binUpload(bin, payload);
      // Read it straight back to prove the blob is really there.
      const check = await downloadBlob(url);
      if (check !== payload) throw new Error("verify mismatch from " + bin.host);
      if (prevDel) deleteBlob(prevDel);   // supersede: drop the previous blob
      return { url, del, exp: Date.now() + STATE_TTL_MS, host: bin.host };
    } catch (e) { last = e; }
  }
  throw last || new Error("no workspace store available");
}

async function downloadBlob(url) {
  const r = await withTimeout(netFetch(url), fetchTimeoutMs(), "download from " + url);
  if (!r.ok) throw new Error("download HTTP " + r.status);
  return (await r.text()).trim();
}

function deleteBlob(del) {
  if (!del) return;
  try { rawFetch()(del, { method: "DELETE" }).catch(() => {}); } catch (e) {}
}

function kvSnapshot() {
  const kv = globalThis.__crKV, o = {};
  if (kv) for (const [k, v] of kv) { try { JSON.stringify(v); o[k] = v; } catch (e) {} }
  return o;
}

// Packed bytes of everything that should survive to the next call, or null.
async function snapshotPacked() {
  const snap = { v: 1, files: [], kv: kvSnapshot() };
  const py = globalThis.__py;
  if (py && py.FS.analyzePath(WORKDIR).exists) walkWorkspace(py, WORKDIR, snap.files);
  const hasDb = snap.files.some(([p]) => p === "data.sqlite");
  // If Pyodide is up and we hold a db image but the file is gone, the user
  // deleted it this call: drop the stale image so it is not resurrected.
  const dbDeleted = py && globalThis.__sqlBytes && globalThis.__sqlBytes.length && !py.FS.analyzePath(DB_FILE).exists;
  if (dbDeleted) { globalThis.__sqlBytes = null; globalThis.__sqlSynced = false; }
  if (!hasDb && globalThis.__sqlBytes && globalThis.__sqlBytes.length) snap.sql = bytesToBase64(globalThis.__sqlBytes);
  const hosts = hostHealthSnapshot();
  if (hosts) snap.net = { hosts };
  if (!snap.files.length && !snap.sql && !snap.net && !Object.keys(snap.kv).length) return null;
  return packBytes(new TextEncoder().encode(JSON.stringify(snap)));
}

// Inline base64 trailer payload (used for small state and by serve_file).
async function snapshotState() {
  const packed = await snapshotPacked();
  return packed ? bytesToBase64(packed) : null;
}

// A tiny pointer payload for an externally stored snapshot.
async function externalTrailer(ptr) {
  const packed = await packBytes(new TextEncoder().encode(JSON.stringify({ v: 1, ext: ptr })));
  return bytesToBase64(packed);
}

function previousOutputText(prev) {
  if (prev == null) return "";
  if (typeof prev === "string") return prev;
  if (Array.isArray(prev)) return prev.map((p) => (p && typeof p === "object" ? p.text || "" : String(p))).join("\n");
  if (typeof prev === "object") return prev.content != null ? previousOutputText(prev.content) : JSON.stringify(prev);
  return String(prev);
}

// Rehydrate memory-level state now; files are applied when Pyodide comes up.
async function restoreState(prev) {
  const b64 = extractTrailer(previousOutputText(prev));
  if (!b64) return false;
  let snap;
  try { snap = JSON.parse(new TextDecoder().decode(await unpackBytes(base64ToBytes(b64)))); }
  catch (e) { return false; }
  if (!snap || snap.v !== 1) return false;
  if (snap.ext) {
    if (!snap.ext.exp || Date.now() > snap.ext.exp) return false;   // logically expired
    let inner;
    try { inner = JSON.parse(new TextDecoder().decode(await unpackBytes(base64ToBytes(await downloadBlob(snap.ext.url))))); }
    catch (e) { return false; }
    if (!inner || inner.v !== 1) return false;
    globalThis.__crExtDel = snap.ext.del || null;   // delete this blob when we write the next one
    snap = inner;
  }
  globalThis.__crSnapshot = snap;
  globalThis.__crKV = new Map(Object.entries(snap.kv || {}));
  if (snap.net && snap.net.hosts && typeof snap.net.hosts === "object") {
    const hh = hostHealth();
    for (const [host, rec] of Object.entries(snap.net.hosts)) {
      if (rec && typeof rec.t === "number" && Date.now() - rec.t < DEAD_HOST_TTL_MS) hh[host] = { t: rec.t, why: String(rec.why || "unreachable"), k: rec.k === "b" ? "b" : "t" };
    }
  }
  const db = (snap.files || []).find(([p]) => p === "data.sqlite");
  if (db) globalThis.__sqlBytes = base64ToBytes(db[1]);
  else if (snap.sql) globalThis.__sqlBytes = base64ToBytes(snap.sql);
  if (globalThis.__py) applySnapshotFiles(globalThis.__py);
  return true;
}

function applySnapshotFiles(py) {
  const snap = globalThis.__crSnapshot;
  if (!snap || snap.applied) return;
  snap.applied = true;
  for (const [rel, b64] of snap.files || []) {
    const p = WORKDIR + "/" + rel, dir = p.slice(0, p.lastIndexOf("/"));
    py.FS.mkdirTree(dir);
    py.FS.writeFile(p, base64ToBytes(b64));
  }
}

const MIME_BY_EXT = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  html: "text/html", htm: "text/html", js: "text/javascript", css: "text/css",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
  pdf: "application/pdf", zip: "application/zip", wav: "audio/wav", mp3: "audio/mpeg",
  ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", sqlite: "application/x-sqlite3",
  bin: "application/octet-stream"
};
function guessMime(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
function relPath(path) {
  path = String(path == null ? "" : path).trim();
  if (path.startsWith(WORKDIR + "/")) return path.slice(WORKDIR.length + 1);
  if (path.startsWith("/")) return path.replace(/^\/+/, "");
  return path.replace(/^\.\//, "");
}

// Read one workspace file as bytes. Prefers the live Pyodide FS, then the
// restored snapshot (so serving needs no Pyodide boot on mobile), then a
// carried SQL image for data.sqlite.
function readWorkspaceFile(path) {
  const rel = relPath(path);
  const py = globalThis.__py;
  if (py) {
    const abs = WORKDIR + "/" + rel;
    if (py.FS.analyzePath(abs).exists && !py.FS.isDir(py.FS.stat(abs).mode)) return py.FS.readFile(abs);
  }
  const snap = globalThis.__crSnapshot;
  if (snap) {
    const hit = (snap.files || []).find(([p]) => p === rel);
    if (hit) return base64ToBytes(hit[1]);
  }
  if (rel === "data.sqlite" && globalThis.__sqlBytes && globalThis.__sqlBytes.length) return globalThis.__sqlBytes;
  throw new Error("File not found in /workspace: " + rel + ". Write it with run_code first, in the same session.");
}

function mdEscape(s) { return String(s).replace(/([\\`*_\[\]()])/g, "\\$1"); }

// One-line inventory of /workspace, appended to "file not found" errors so the
// model sees at once which files really exist (a failed download in an earlier
// step is the usual cause) instead of guessing.
function workspaceListing(limit) {
  const py = globalThis.__py, rows = [];
  try {
    if (py && py.FS.analyzePath(WORKDIR).exists) {
      const walk = (dir) => {
        for (const name of py.FS.readdir(dir)) {
          if (name === "." || name === "..") continue;
          const p = dir + "/" + name, st = py.FS.stat(p);
          if (py.FS.isDir(st.mode)) walk(p);
          else rows.push(p.slice(WORKDIR.length + 1) + " (" + (st.size < 1024 ? st.size + " B" : Math.ceil(st.size / 1024) + " KB") + ")");
        }
      };
      walk(WORKDIR);
    } else if (globalThis.__crSnapshot) {
      for (const [rel, b64] of globalThis.__crSnapshot.files || []) rows.push(rel + " (" + Math.ceil(b64.length * 3 / 4 / 1024) + " KB)");
    }
  } catch (e) {}
  if (!rows.length) return "(/workspace is empty. The file was never written - check that the earlier download/write step actually succeeded before reading its result.)";
  const shown = rows.slice(0, limit || 40);
  return "(/workspace contains " + rows.length + " file" + (rows.length === 1 ? "" : "s") + ": " + shown.join(", ") +
    (rows.length > shown.length ? ", ..." : "") + ". Files are only there if the step that wrote them succeeded.)";
}
const FILE_MISSING_RE = /FileNotFoundError|No such file or directory|ENOENT/;
function isMissingFileError(e) {
  return FILE_MISSING_RE.test(String(e && e.message || e)) || (e && e.errno === 44);
}

// ---------------------------------------------------------------------------
// Python (Pyodide)
// ---------------------------------------------------------------------------

async function loadPyodideWithFallback() {
  const errors = [];
  for (const cdn of cdnCandidates(PYODIDE_CDNS, globalThis.__crPyodideCdn)) {
    try {
      if (!globalThis.loadPyodide) {
        await withTimeout(loadScript(cdn.index + "pyodide.js"), SCRIPT_TIMEOUT_MS, "pyodide.js from " + cdn.index);
      }
      const opts = { indexURL: cdn.index };
      if (cdn.packages) opts.packageBaseUrl = cdn.packages;
      const py = await withTimeout(globalThis.loadPyodide(opts), RUNTIME_TIMEOUT_MS, "Pyodide runtime from " + cdn.index);
      globalThis.__crPyodideCdnUsed = cdn.index;
      return py;
    } catch (e) {
      errors.push(cdn.index + " -> " + (e.message || e));
    }
  }
  throw new Error("Could not load the Python runtime from any CDN:\n" + errors.join("\n"));
}

async function getPyodide() {
  if (globalThis.__py) return globalThis.__py;
  if (!globalThis.__pyLoading) {
    globalThis.__pyLoading = (async () => {
      const py = await loadPyodideWithFallback();
      py.FS.mkdirTree(WORKDIR);
      applySnapshotFiles(py);
      // A database carried from a SQL-only call lives in __sqlBytes, not as a
      // file. Write it so Python's sqlite3 can open /workspace/data.sqlite.
      if (globalThis.__sqlBytes && globalThis.__sqlBytes.length && !py.FS.analyzePath(DB_FILE).exists) {
        py.FS.writeFile(DB_FILE, globalThis.__sqlBytes);
        globalThis.__sqlSynced = true;
      }
      // requests/urllib3 work natively in Pyodide; pyodide-http adds urllib.request.
      try {
        await py.loadPackage("pyodide-http");
        py.runPython(
          "import pyodide_http\n" +
          "getattr(pyodide_http, 'patch_urllib', pyodide_http.patch_all)()"
        );
      } catch (e) {
        globalThis.__pyHttpNote = "(note: urllib.request could not be enabled: " + (e.message || e) +
          ". Use requests or pyodide.http.pyfetch instead.)";
      }
      globalThis.__py = py;
      return py;
    })().catch((e) => { globalThis.__pyLoading = null; throw e; });
  }
  return globalThis.__pyLoading;
}

async function runPython(code, packages) {
  const py = await getPyodide();
  let pkgNote = "";
  try { await py.loadPackagesFromImports(code); }
  catch (e) { pkgNote = "(note: could not download Python packages for the imports in this code: " + (e.message || e) + ")"; }
  if (Array.isArray(packages) && packages.length) {
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    for (const p of packages) await micropip.install(p);
  }
  py.runPython("import os; os.makedirs('" + WORKDIR + "', exist_ok=True); os.chdir('" + WORKDIR + "')");
  const out = [];
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => out.push(s) });
  if (pkgNote) out.push(pkgNote);
  if (globalThis.__pyHttpNote && /urllib/.test(code)) out.push(globalThis.__pyHttpNote);
  let v;
  try { v = await py.runPythonAsync(code); }
  catch (e) {
    out.push("Python error:\n" + (e.message || e));
    if (isMissingFileError(e)) out.push(workspaceListing());
    return out.join("\n").trim();
  }
  if (v !== undefined && v !== null) out.push(String(v));
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Shared filesystem helpers (backed by Pyodide's MEMFS)
// ---------------------------------------------------------------------------

function absPath(p) {
  p = String(p == null ? "" : p);
  if (p.startsWith("/")) return p;
  return WORKDIR + (p ? "/" + p.replace(/^\.\//, "") : "");
}

function makeFs(py) {
  const F = py.FS;
  const toBytes = (d) => typeof d === "string" ? d : new Uint8Array(d);
  return {
    readFile: (p, enc = "utf8") =>
      enc === "binary" || enc === null ? F.readFile(absPath(p)) : F.readFile(absPath(p), { encoding: "utf8" }),
    writeFile: (p, data) => { F.writeFile(absPath(p), toBytes(data)); return true; },
    appendFile: (p, data) => {
      const a = absPath(p);
      const old = F.analyzePath(a).exists ? F.readFile(a, { encoding: "utf8" }) : "";
      F.writeFile(a, old + String(data));
      return true;
    },
    exists: (p) => F.analyzePath(absPath(p)).exists,
    readdir: (p) => F.readdir(absPath(p)).filter((n) => n !== "." && n !== ".."),
    mkdir: (p) => { F.mkdirTree(absPath(p)); return true; },
    unlink: (p) => { F.unlink(absPath(p)); return true; },
    stat: (p) => { const s = F.stat(absPath(p)); return { size: s.size, mtime: s.mtime, isDir: F.isDir(s.mode) }; }
  };
}

// Lazy async wrapper for JavaScript runs: `await fs.readFile("a.txt")`.
const fsAsync = {};
for (const m of ["readFile", "writeFile", "appendFile", "exists", "readdir", "mkdir", "unlink", "stat"]) {
  fsAsync[m] = async (...a) => makeFs(await getPyodide())[m](...a);
}

// Cheap session-scoped key/value store for JavaScript (no Pyodide needed).
function getStorage() {
  if (!globalThis.__crKV) globalThis.__crKV = new Map();
  const kv = globalThis.__crKV;
  return {
    get: (k) => kv.get(String(k)),
    set: (k, v) => { kv.set(String(k), v); return v; },
    has: (k) => kv.has(String(k)),
    delete: (k) => kv.delete(String(k)),
    keys: () => [...kv.keys()],
    clear: () => kv.clear()
  };
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

async function runJavaScript(code) {
  const out = [];
  const fmt = (x) => {
    if (typeof x !== "object" || x === null) return String(x);
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  };
  const log = (...a) => out.push(a.map(fmt).join(" "));
  try {
    const fn = new Function("console", "fetch", "fs", "storage", "return (async () => {" + code + "\n})()");
    const v = await fn({ log, info: log, warn: log, error: log, debug: log }, netFetch, fsAsync, getStorage());
    if (v !== undefined) out.push(fmt(v));
  } catch (e) {
    out.push("JavaScript error:\n" + (e.message || e));
    if (isMissingFileError(e)) out.push(workspaceListing());
  }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// SQL (sql.js). The database image persists across calls for the session and is
// mirrored to /workspace/data.sqlite once Pyodide is loaded, so Python's sqlite3
// can read/write the same database.
// ---------------------------------------------------------------------------

async function getSqlJs() {
  if (globalThis.__sqljs) return globalThis.__sqljs;
  const errors = [];
  for (const base of cdnCandidates(SQLJS_CDNS, globalThis.__crSqljsCdn)) {
    try {
      if (!globalThis.initSqlJs) {
        await withTimeout(loadScript(base + "sql-wasm.js"), SCRIPT_TIMEOUT_MS, "sql-wasm.js from " + base);
      }
      globalThis.__sqljs = await withTimeout(
        globalThis.initSqlJs({ locateFile: (f) => base + f }), RUNTIME_TIMEOUT_MS, "sql.js runtime from " + base);
      globalThis.__crSqljsCdnUsed = base;
      return globalThis.__sqljs;
    } catch (e) {
      errors.push(base + " -> " + (e.message || e));
    }
  }
  throw new Error("Could not load the SQL runtime from any CDN:\n" + errors.join("\n"));
}

function loadDbImage() {
  const py = globalThis.__py;
  if (py) {
    if (py.FS.analyzePath(DB_FILE).exists) return py.FS.readFile(DB_FILE);
    if (globalThis.__sqlSynced) return null;          // file was deleted on purpose: start fresh
  }
  return globalThis.__sqlBytes || null;
}

function saveDbImage(bytes) {
  globalThis.__sqlBytes = bytes;
  const py = globalThis.__py;
  if (py) {
    py.FS.mkdirTree(WORKDIR);
    py.FS.writeFile(DB_FILE, bytes);
    globalThis.__sqlSynced = true;
  }
}

async function runSQL(code) {
  const SQL = await getSqlJs();
  const image = loadDbImage();
  const db = image && image.length ? new SQL.Database(image) : new SQL.Database();
  let text;
  try {
    const res = db.exec(code);
    text = !res.length ? "(statement ran, no rows returned)" : res.map((r) =>
      [r.columns.join(" | "), r.values.map((v) => v.join(" | ")).join("\n")].join("\n")
    ).join("\n\n");
  } catch (e) { text = "SQL error:\n" + (e.message || e); }
  try { saveDbImage(db.export()); } finally { db.close(); }
  return text;
}

// ---------------------------------------------------------------------------
// Compiler Explorer (no network, no persistent files inside the sandbox)
// ---------------------------------------------------------------------------

async function runRemote(language, code) {
  const c = CE[language];
  if (!c) throw new Error("Unsupported language: " + language);
  const r = await fetch("https://godbolt.org/api/compiler/" + c.id + "/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      source: code,
      lang: c.lang,
      options: {
        userArguments: "",
        executeParameters: { args: [], stdin: "" },
        compilerOptions: { executorRequest: true },
        filters: { execute: true }
      }
    })
  });
  if (!r.ok) throw new Error("Compiler Explorer returned HTTP " + r.status);
  const d = await r.json();
  const strip = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const txt = (a) => (a || []).map((x) => strip(x.text)).join("\n");
  const output = [txt(d.stdout), txt(d.stderr), txt(d.buildResult && d.buildResult.stderr)]
    .filter((s) => s && s.trim()).join("\n").trim();
  const exit = d.didExecute && d.code ? "\n(exit code " + d.code + ")" : "";
  return (output || "(compiled and ran, no output)") + exit;
}

// ---------------------------------------------------------------------------

// Serve a workspace file to the human user. Rendered as markdown (outputType
// render_markdown), so the file reaches the user directly without passing the
// bytes through the AI's context. Images show inline; text can show as a code
// block; everything gets a data-URL download link. State is passed through
// unchanged (invisible HTML-comment trailer) so the next call keeps the workspace.
async function serve_file(params, userSettings, resources) {
  const path = params && (params.path || params.file || params.filename);
  if (!path) throw new Error("serve_file needs a `path` to a file in /workspace.");
  const carry = String((userSettings && userSettings.stateCarry) || "").trim().toLowerCase() !== "off";
  const incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
  if (carry) { try { await restoreState(resources && resources.previousRunOutput); } catch (e) {} }

  const bytes = readWorkspaceFile(path);
  const name = params.filename || relPath(path).split("/").pop() || "file";
  const mime = params.mime || guessMime(name);
  const b64 = bytesToBase64(bytes);
  const dataURI = "data:" + mime + ";base64," + b64;
  const kb = Math.ceil(bytes.length / 1024);

  const mode = (params.as || "auto").toLowerCase();
  const isImage = /^image\//.test(mime) && mime !== "image/svg+xml" || mime === "image/svg+xml";
  const isText = /^text\//.test(mime) || mime === "application/json" || mime === "application/xml";
  const link = "[Download " + mdEscape(name) + " (" + kb + " KB)](" + dataURI + ")";

  let md;
  if (mode === "link") md = link;
  else if (mode === "image" || (mode === "auto" && isImage)) md = "![" + mdEscape(name) + "](" + dataURI + ")\n\n" + link;
  else if (mode === "text" || (mode === "auto" && isText && bytes.length <= 64 * 1024)) {
    const text = new TextDecoder().decode(bytes);
    const fence = mime === "application/json" ? "json" : mime === "text/markdown" ? "markdown" : "";
    md = "```" + fence + "\n" + text + "\n```\n\n" + link;
  } else md = link;

  if (!carry) return md;
  const trailer = incoming || (await snapshotState());
  return trailer ? md + "\n\n<!--[[cr-state:" + trailer + "]]-->" : md;
}

// Hosts that could not be reached during this run, as a note under the output.
// The model's own try/except may have swallowed the error; this keeps the
// failure (and the fail-fast memo) visible so it moves to another host.
function networkNote() {
  const log = globalThis.__crNetLog;
  if (!log || !log.size) return "";
  return "\n\n(network: " + [...log].map(([h, why]) => h + " - " + why).join("\n network: ") + ")";
}

async function run_code(params, userSettings, resources) {
  const { language, code, packages } = params;
  if (!code || !code.trim()) throw new Error("No code was provided.");
  const setting = (k) => String((userSettings && userSettings[k]) || "").trim();
  globalThis.__crCorsProxy = setting("corsProxy");
  globalThis.__crPyodideCdn = setting("pyodideCdn");
  globalThis.__crSqljsCdn = setting("sqljsCdn");
  const carry = setting("stateCarry").toLowerCase() !== "off";
  const limitKB = Number(setting("stateLimitKB")) > 0 ? Number(setting("stateLimitKB")) : STATE_LIMIT_KB_DEFAULT;
  globalThis.__crFetchTimeout = Number(setting("fetchTimeoutMs")) > 0 ? Number(setting("fetchTimeoutMs")) : 30000;
  globalThis.__crWorkspaceStore = setting("workspaceStore");
  const bigWorkspace = setting("bigWorkspace").toLowerCase() !== "off";   // default on

  // A fresh sandbox has no memory of earlier calls: rebuild it from the previous
  // output. A context that already ran code keeps its live state instead.
  if (carry && !globalThis.__crLive) {
    try { await restoreState(resources && resources.previousRunOutput); } catch (e) {}
  }
  globalThis.__crLive = true;

  patchFetch();
  patchXHR();
  globalThis.__crNetLog = new Map();
  globalThis.__crRunning = (globalThis.__crRunning || 0) + 1;
  let out;
  try {
    switch (language) {
      case "python":     out = await runPython(code, packages); break;
      case "javascript": out = await runJavaScript(code);       break;
      case "sql":        out = await runSQL(code);              break;
      default:           out = await runRemote(language, code);
    }
  } finally {
    globalThis.__crRunning--;
  }
  out = out && out.length ? out : "(no output - did you print the result?)";
  out += networkNote();
  if (!carry) return out;
  let packed = null;
  try { packed = await snapshotPacked(); } catch (e) {}
  if (!packed) return out;

  // Small enough for the inline token budget: carry it in the trailer.
  const b64 = bytesToBase64(packed);
  if (b64.length <= limitKB * 1024) return out + "\n\n[[cr-state:" + b64 + "]]";

  // Too big for tokens: offload to an ephemeral bin, carry only a pointer.
  if (bigWorkspace) {
    try {
      const ptr = await uploadState(b64, globalThis.__crExtDel);
      const trailer = await externalTrailer(ptr);
      const host = (ptr.host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return out + "\n\n(workspace " + Math.ceil(b64.length / 1024) + " KB stored on " + host +
        ", auto-expires ~10 min; carried to the next call.)\n\n[[cr-state:" + trailer + "]]";
    } catch (e) {
      return out + "\n\n(workspace " + Math.ceil(b64.length / 1024) +
        " KB exceeds the " + limitKB + " KB inline limit and no ephemeral store was reachable (" +
        (e.message || e) + "). Finish multi-step work in one call, or set a workspaceStore endpoint.)";
    }
  }
  return out + "\n\n(workspace not carried: " + Math.ceil(b64.length / 1024) +
    " KB compressed exceeds the " + limitKB + " KB inline limit and large-workspace offload is off.)";
}
