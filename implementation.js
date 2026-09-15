// Code Runner - TypingMind plugin. Two entry points: run_code and serve_file.
//
// Execution model. TypingMind runs every call in a brand-new sandboxed iframe
// (opaque origin), so nothing survives in memory between calls. Python,
// JavaScript, TypeScript and SQL run inside a background Web Worker spawned
// from that iframe: a runaway loop can be stopped (the worker is terminated)
// without freezing the chat. When a Worker cannot be created the same engine
// runs in the iframe thread instead. Compiled languages run remotely on
// Compiler Explorer (Wandbox as fallback). /workspace, the SQLite database and
// JS `storage` travel between calls as a compressed [[cr-state:...]] trailer
// on the tool output (large ones are offloaded to a short-lived blob store).

// ---------------------------------------------------------------------------
// Runtime sources. CDNs are tried in order; the first that serves wins.
// ---------------------------------------------------------------------------
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
const BABEL_VERSION = "8.0.5";
const BABEL_CDNS = [
  "https://cdn.jsdelivr.net/npm/@babel/standalone@" + BABEL_VERSION + "/babel.min.js",
  "https://fastly.jsdelivr.net/npm/@babel/standalone@" + BABEL_VERSION + "/babel.min.js",
  "https://unpkg.com/@babel/standalone@" + BABEL_VERSION + "/babel.min.js"
];
const SCRIPT_TIMEOUT_MS  = 45000;
const RUNTIME_TIMEOUT_MS = 180000;   // wasm + stdlib download can be slow on mobile

const WORKDIR = "/workspace";
const DB_REL = "data.sqlite";
const OUTPUT_HEAD = 30000;           // characters of output kept from the start...
const OUTPUT_TAIL = 10000;           // ...and from the end, when a run prints more
const EXEC_TIMEOUT_S_DEFAULT = 120;
const STATE_LIMIT_KB_DEFAULT = 24;
const STATE_TTL_MIN_DEFAULT = 1440;
const MAX_CARRY_BYTES = 40 * 1024 * 1024;
const SERVE_MAX_BYTES = 20 * 1024 * 1024;

// Temporary public stores for large workspaces, used only when no private
// workspace store is configured. Verified from a sandboxed (Origin: null) page
// 2026-09: CORS, byte-exact read-back, size limits.
const PUBLIC_BINS = [
  { kind: "litterbox", host: "https://litterbox.catbox.moe/resources/internals/api.php", max: 20 * 1024 * 1024, lifeMin: 1440 },
  { kind: "pastesdev", host: "https://api.pastes.dev/post", max: 2 * 1024 * 1024 },
  { kind: "dpaste",    host: "https://dpaste.com/api/v2/", max: 380 * 1024, lifeMin: 1440 }
];

// Import names that differ from their PyPI name, and pure-Python packages that
// are installed automatically (micropip) when code imports them. Packages that
// Pyodide ships (numpy, pandas, bs4, PIL, sklearn, cv2, ...) load on their own.
const PY_PIP_ALIASES = {
  yaml: "pyyaml", docx: "python-docx", pptx: "python-pptx", dateutil: "python-dateutil",
  dotenv: "python-dotenv", slugify: "python-slugify", jose: "python-jose",
  fpdf: "fpdf2", pypdf: "pypdf", PyPDF2: "PyPDF2", pdfminer: "pdfminer.six", docx2txt: "docx2txt",
  openpyxl: "openpyxl", xlsxwriter: "xlsxwriter", xlrd: "xlrd", odf: "odfpy", tabulate: "tabulate",
  markdown: "markdown", markdownify: "markdownify", html2text: "html2text", mammoth: "mammoth",
  xmltodict: "xmltodict", toml: "toml", tomli: "tomli", tomli_w: "tomli-w", json5: "json5",
  qrcode: "qrcode", faker: "faker", unidecode: "unidecode", emoji: "emoji", rich: "rich",
  tqdm: "tqdm", humanize: "humanize", feedparser: "feedparser", icalendar: "icalendar",
  ics: "ics", geopy: "geopy", folium: "folium", plotly: "plotly", seaborn: "seaborn",
  altair: "altair", textblob: "textblob", isodate: "isodate", babel: "babel", pint: "pint",
  sortedcontainers: "sortedcontainers", cachetools: "cachetools", attrs: "attrs", cattrs: "cattrs",
  jsonschema: "jsonschema", simplejson: "simplejson", chardet: "chardet", thefuzz: "thefuzz",
  rapidfuzz: "rapidfuzz", num2words: "num2words", langdetect: "langdetect", phonenumbers: "phonenumbers",
  pycountry: "pycountry", holidays: "holidays", croniter: "croniter", arrow: "arrow", pendulum: "pendulum",
  mpmath: "mpmath", bidict: "bidict", more_itertools: "more-itertools", toolz: "toolz",
  svgwrite: "svgwrite", reportlab: "reportlab", pdfplumber: "pdfplumber", extract_msg: "extract-msg",
  vobject: "vobject", pyparsing: "pyparsing"
};

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------
const LOCAL_LANGS = ["python", "javascript", "typescript", "sql"];

// Compiler Explorer (godbolt.org) runs these. `wb` names a Wandbox compiler to
// fall back to when Compiler Explorer is unreachable; `pick` finds a current
// compiler if the pinned id is retired. Verified with stdin 2026-09.
const CE_LANGS = {
  "c":       { id: "cg162",               lang: "c",       args: "-O1 -std=gnu17 -lm", wb: "gcc-13.2.0-c",   pick: /x86-64 gcc \d/ },
  "c++":     { id: "g162",                lang: "c++",     args: "-O1 -std=c++23",     wb: "gcc-13.2.0",     pick: /x86-64 gcc \d/ },
  "rust":    { id: "r1980",               lang: "rust",    args: "-C opt-level=1 --edition 2021", wb: "rust-1.82.0", pick: /^rustc \d/ },
  "go":      { id: "gl1260",              lang: "go",      args: "",                   wb: "go-1.23.2",      pick: /x86-64 gc \d/ },
  "java":    { id: "java2501",            lang: "java",    args: "",                   pick: /^jdk \d/, fix: "java" },
  "kotlin":  { id: "kotlinc2220",         lang: "kotlin",  args: "",                   pick: /^kotlinc \d/ },
  "csharp":  { id: "dotnet100csharpmono", lang: "csharp",  args: "",                   wb: "mono-6.12.0.199", pick: /\.NET \d.*Mono/ },
  "fsharp":  { id: "dotnet100fsharpmono", lang: "fsharp",  args: "",                   pick: /\.NET \d.*Mono/ },
  "swift":   { id: "swift633",            lang: "swift",   args: "",                   wb: "swift-6.0.1",    pick: /x86-64 swiftc \d/ },
  "zig":     { id: "z0160",               lang: "zig",     args: "",                   wb: "zig-0.13.0",     pick: /^zig \d/ },
  "d":       { id: "dmd21120",            lang: "d",       args: "",                   wb: "dmd-2.109.1",    pick: /dmd|ldc/ },
  "haskell": { id: "ghc9122",             lang: "haskell", args: "",                   wb: "ghc-9.10.1",     pick: /ghc \d/ },
  "ocaml":   { id: "ocaml5200",           lang: "ocaml",   args: "",                   wb: "ocaml-5.2.0",    pick: /ocamlopt \d/ },
  "ruby":    { id: "ruby405",             lang: "ruby",    args: "",                   wb: "ruby-4.0.2",     pick: /^Ruby \d/ },
  "perl":    { id: "perl5440",            lang: "perl",    args: "",                   wb: "perl-5.42.0",    pick: /^Perl \d/ },
  "lua":     { id: "lua550",              lang: "lua",     args: "",                   wb: "lua-5.4.7",      pick: /^Lua \d/ },
  "dart":    { id: "dart373",             lang: "dart",    args: "",                   pick: /^Dart \d/ },
  "fortran": { id: "gfortran162",         lang: "fortran", args: "",                   pick: /x86-64 gfortran \d/ },
  "pascal":  { id: "fpc322",              lang: "pascal",  args: "",                   wb: "fpc-3.2.2",      pick: /fpc \d/ },
  "crystal": { id: "crystal1203",         lang: "crystal", args: "",                   wb: "crystal-1.13.3", pick: /^Crystal \d/ },
  "julia":   { id: "julia_1_12_5",        lang: "julia",   args: "",                   wb: "julia-1.10.5",   pick: /^Julia \d/ },
  "cobol":   { id: "gnucobol32",          lang: "cobol",   args: "",                   pick: /GnuCOBOL \d/ },
  "ada":     { id: "gnat162",             lang: "ada",     args: "",                   pick: /x86-64 gnat \d/ },
  "objc":    { id: "objcg162",            lang: "objc",    args: "",                   pick: /x86-64 gcc \d/ }
};

// Wandbox-only languages (best effort: a free public service).
const WB_LANGS = {
  "bash":   { compiler: "bash",          wbLang: "Bash script" },
  "php":    { compiler: "php-8.3.12",    wbLang: "PHP", fix: "php" },
  "r":      { compiler: "r-4.4.1",       wbLang: "R" },
  "scala":  { compiler: "scala-3.5.1",   wbLang: "Scala" },
  "nim":    { compiler: "nim-2.2.10",    wbLang: "Nim" },
  "elixir": { compiler: "elixir-1.17.3", wbLang: "Elixir" }
};

const ALL_LANGS = LOCAL_LANGS.concat(Object.keys(CE_LANGS), Object.keys(WB_LANGS));

const LANG_ALIASES = {
  py: "python", python3: "python", py3: "python", js: "javascript", node: "javascript", nodejs: "javascript",
  ts: "typescript", sqlite: "sql", sqlite3: "sql", cpp: "c++", cxx: "c++", cc: "c++", "c#": "csharp", cs: "csharp",
  "f#": "fsharp", fs: "fsharp", golang: "go", rs: "rust", kt: "kotlin", jl: "julia", rb: "ruby", pl: "perl",
  ml: "ocaml", hs: "haskell", sh: "bash", shell: "bash", zsh: "bash", "objective-c": "objc", objectivec: "objc",
  delphi: "pascal", rlang: "r", ex: "elixir", exs: "elixir", c99: "c", c11: "c", c17: "c"
};

function normalizeLanguage(l) {
  const k = String(l == null ? "" : l).trim().toLowerCase();
  if (ALL_LANGS.includes(k)) return k;
  return LANG_ALIASES[k] || null;
}

// ---------------------------------------------------------------------------
// Small shared helpers (also shipped into the worker)
// ---------------------------------------------------------------------------
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

function hostOf(url) { try { return new URL(String(url)).host; } catch (e) { return ""; } }
function isAbort(e) { return !!e && (e.name === "AbortError" || e.name === "TimeoutError"); }

// ---------------------------------------------------------------------------
// Network. Requests go direct first. When the browser blocks one (CORS) or the
// host does not answer, the request is retried through: a known CORS-enabled
// mirror (GitHub files), the user's own proxy (plugin setting, e.g. the
// companion Cloudflare Worker), then public CORS proxies. Credentialed requests
// only ever go to the user's own proxy. A host that fails every path is
// remembered for a few minutes so later requests fail fast.
// ---------------------------------------------------------------------------

// Public proxies, re-verified 2026-09 from a sandboxed (Origin: null) page.
// Few survive; the first is the only one that reliably passed text and POST.
// `sync: false` marks proxies that may hang without answering: a synchronous
// XHR cannot be timed out on the page thread, so they are only raced from fetch.
const BUILTIN_PROXIES = [
  { u: "https://corsmirror.com/v1?url=",            enc: "q" },
  { u: "https://api.allorigins.win/raw?url=",       enc: "q", sync: false },
  { u: "https://api.codetabs.com/v1/proxy/?quest=", enc: "q", sync: false },
  { u: "https://api.cors.lol/?url=",                enc: "q" },
  { u: "https://cors.eu.org/",                      enc: "raw" },
  { u: "https://test.cors.workers.dev/?",           enc: "raw" }
];
const PROXY_PARALLEL = 3;
const DEAD_HOST_TTL_MS = 3 * 60 * 1000;
const XHR_SYNC_ROUTES_MAX = 5;  // sync XHR cannot be raced: mirror/personal proxy + a few public ones
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

function fetchTimeoutMs() {
  const n = Number(globalThis.__crFetchTimeout);
  return n > 0 ? n : 30000;
}
function proxyTimeoutMs()  { return Math.min(fetchTimeoutMs(), 15000); }
function proxyPhaseMs()    { return Math.min(45000, 3 * proxyTimeoutMs()); }
function deadHostProbeMs() { return Math.min(fetchTimeoutMs(), 5000); }

function hostHealth() {
  if (!globalThis.__crHostHealth || typeof globalThis.__crHostHealth !== "object") globalThis.__crHostHealth = {};
  return globalThis.__crHostHealth;
}
function deadHost(host) {
  if (!host) return null;
  const h = hostHealth()[host];
  if (!h) return null;
  if (!(Date.now() - h.t < DEAD_HOST_TTL_MS)) { delete hostHealth()[host]; return null; }
  return h;
}
// k: "t" = the host never answered, "b" = it was blocked and the fallbacks failed too.
function markDead(host, why, k) { if (host) hostHealth()[host] = { t: Date.now(), why, k: k || "t" }; netNote(host, why); }
function markAlive(host) { if (host && hostHealth()[host]) delete hostHealth()[host]; }
function netNote(host, why) {
  if (!globalThis.__crNetLog) globalThis.__crNetLog = new Map();
  if (host && !globalThis.__crNetLog.has(host)) globalThis.__crNetLog.set(host, why);
}
function netError(host, why, cause) {
  const e = new TypeError("Could not reach " + (host || "host") + ": " + why);
  if (cause) e.cause = cause;
  return e;
}
function hostHealthSnapshot() {
  const out = {}, hh = hostHealth();
  for (const host of Object.keys(hh)) if (deadHost(host)) out[host] = hh[host];
  return Object.keys(out).length ? out : null;
}
function mergeHosts(hosts) {
  if (!hosts || typeof hosts !== "object") return;
  const hh = hostHealth();
  for (const [host, rec] of Object.entries(hosts)) {
    if (rec && typeof rec.t === "number" && Date.now() - rec.t < DEAD_HOST_TTL_MS) {
      hh[host] = { t: rec.t, why: String(rec.why || "unreachable"), k: rec.k === "b" ? "b" : "t" };
    }
  }
}

function applyProxy(spec, url) {
  if (spec.u.includes("{url}")) return spec.u.replace("{url}", encodeURIComponent(url));
  return spec.u + (spec.enc === "raw" ? url : encodeURIComponent(url));
}

// CORS-enabled mirrors for hosts that block browsers.
function mirrorUrl(url) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(url);
  if (m) return "https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3];
  return null;
}

// Ordered fallback candidates for a URL that failed directly.
function proxyCandidates(url, opts) {
  if (!/^https?:\/\//i.test(url)) return [];
  const credentialed = !!(opts && opts.credentialed);
  const list = [];
  const mirror = mirrorUrl(url);
  if (mirror && !credentialed) list.push({ url: mirror, mirror: true });
  const custom = globalThis.__crCorsProxy;
  if (custom) list.push({ url: applyProxy({ u: custom, enc: "q" }, url), trusted: true });
  if (credentialed) return list;
  const pub = BUILTIN_PROXIES.filter((s) => !(opts && opts.sync && s.sync === false));
  return list.concat(pub.map((s) => ({ url: applyProxy(s, url) })));
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

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

// fetch with an AbortController timeout, linked to a caller-supplied signal.
// urllib3 (behind Python requests) always passes a signal, so the cap must
// apply on top of it or a silent host hangs the run.
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

// One fallback hop with its own timeout. Resolves {r} when usable, else null.
// A trusted proxy (the user's own) passes the target's real status through
// (marked X-CR-Proxy), so a 404 from the target is returned as a 404.
function proxyHop(real, cand, init, ms, stats) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const parent = init.signal;
  const onAbort = () => ac && ac.abort();
  if (parent && ac) { if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort); }
  const t = setTimeout(onAbort, ms);
  let won = false;
  const cleanup = () => { clearTimeout(t); if (!won && parent && ac) parent.removeEventListener("abort", onAbort); };
  stats.tried++;
  const promise = Promise.resolve()
    .then(() => real(cand.url, ac ? { ...init, signal: ac.signal } : init))
    .then((r) => {
      const passthrough = cand.trusted && r && r.headers && typeof r.headers.get === "function" && r.headers.get("x-cr-proxy");
      if (r && (passthrough || (r.status >= 200 && r.status < 300))) { won = true; return { r }; }
      stats.http++;
      return null;
    }, (e) => { if (isAbort(e)) stats.timeouts++; else stats.errors++; return null; })
    .finally(cleanup);
  return { promise, abort: onAbort };
}

// Race candidates PROXY_PARALLEL at a time; first usable response wins. The
// phase budget is a hard deadline. Non-idempotent requests go one at a time
// so the target never receives the same write twice.
async function raceProxies(real, cands, init, stats, budgetMs) {
  const deadline = Date.now() + (budgetMs || proxyPhaseMs());
  const width = /^(get|head)$/i.test(init.method || "GET") ? PROXY_PARALLEL : 1;
  for (let i = 0; i < cands.length; i += width) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || (init.signal && init.signal.aborted)) { stats.skipped += cands.length - i; break; }
    const hops = cands.slice(i, i + width).map((c) => proxyHop(real, c, init, Math.min(proxyTimeoutMs(), remaining), stats));
    const win = await new Promise((resolve) => {
      let pending = hops.length;
      hops.forEach((h) => h.promise.then((v) => { if (v) resolve({ hop: h, r: v.r }); else if (--pending === 0) resolve(null); }));
    });
    if (win) { for (const h of hops) if (h !== win.hop) h.abort(); return win.r; }
  }
  return null;
}

function describeStats(stats) {
  const parts = [];
  if (stats.timeouts) parts.push(stats.timeouts + " timed out");
  if (stats.http) parts.push(stats.http + " refused");
  if (stats.errors) parts.push(stats.errors + " failed");
  if (stats.skipped) parts.push(stats.skipped + " skipped (time budget spent)");
  return parts.join(", ") || "none answered";
}

async function fetchDirectThenProxies(real, input, init) {
  const url = requestUrl(input);
  init = init || {};
  if (typeof Request === "function" && input instanceof Request) {
    // A Request body can be read only once: materialize it so retries can resend it.
    const extra = {};
    if (!init.method) extra.method = input.method;
    if (!init.headers) extra.headers = input.headers;
    if (!init.signal && input.signal) extra.signal = input.signal;
    if (init.body === undefined && !/^(GET|HEAD)$/i.test(input.method)) {
      try { extra.body = await input.clone().arrayBuffer(); } catch (e) {}
    }
    init = { ...extra, ...init };
    input = url;
  }
  const credentialed = carriesCredentials(input, init);
  const host = hostOf(url);
  const newStats = () => ({ tried: 0, timeouts: 0, http: 0, errors: 0, skipped: 0 });

  const dead = deadHost(host);
  if (dead) {
    // Known-bad host: one short direct probe; a blocked (not silent) host also
    // gets one short fallback wave. Anything answering clears the memo.
    let probeErr;
    try { const r = await timedFetch(real, input, init, deadHostProbeMs()); markAlive(host); return r; }
    catch (e) { probeErr = e; }
    if (init.signal && init.signal.aborted) throw probeErr;
    if (dead.k === "b") {
      const cands = proxyCandidates(url, { credentialed }).slice(0, PROXY_PARALLEL);
      const r = cands.length && await raceProxies(real, cands, init, newStats(), deadHostProbeMs());
      if (r) { markAlive(host); return r; }
      if (init.signal && init.signal.aborted) throw probeErr;
    }
    const left = Math.max(1, Math.ceil((DEAD_HOST_TTL_MS - (Date.now() - dead.t)) / 60000));
    const why = "still unreachable (" + dead.why + "). Requests to it fail fast for ~" + left + " more min - use a different source.";
    netNote(host, why);
    throw netError(host, why, probeErr);
  }

  let e1;
  try { return await timedFetch(real, input, init); } catch (e) { e1 = e; }
  if (init.signal && init.signal.aborted) throw e1;   // the caller's own deadline
  const timedOut = isAbort(e1);
  if (!timedOut) { try { return await timedFetch(real, input, init); } catch (e) { e1 = e; } }

  const cands = proxyCandidates(url, { credentialed });
  const streamBody = typeof ReadableStream === "function" && init.body instanceof ReadableStream;
  const direct = timedOut ? "no response within " + (fetchTimeoutMs() / 1000) + " s"
                          : "the browser blocked it (the site does not allow cross-origin access, or it is unreachable)";
  if (streamBody || !cands.length) {
    let why = direct;
    if (credentialed && !globalThis.__crCorsProxy) {
      why += "; requests carrying Authorization/API-key/cookie headers are never sent through public proxies - use an API endpoint that allows browser (CORS) access, or set a personal CORS proxy in the plugin settings";
    }
    netNote(host, why);
    throw netError(host, why, e1);
  }

  const st = newStats();
  // The user's own proxy and GitHub mirrors first, one at a time (reliable, may be large).
  // Some sites refuse requests coming from cloud providers: a 403/429/503 through the
  // personal proxy is kept while the public proxies get a chance (reads only), and
  // returned if none of them does better.
  const idempotent = /^(GET|HEAD)$/i.test(init.method || "GET");
  let held = null;
  for (const cand of cands.filter((c) => c.trusted || c.mirror)) {
    const v = await proxyHop(real, cand, init, fetchTimeoutMs(), st).promise;
    if (v) {
      if (cand.trusted && idempotent && [403, 429, 503].includes(v.r.status)) { held = held || v.r; continue; }
      return v.r;
    }
    if (init.signal && init.signal.aborted) throw e1;
  }
  const publicCands = cands.filter((c) => !c.trusted && !c.mirror);
  const r = publicCands.length ? await raceProxies(real, publicCands, init, st) : null;
  if (r) return r;
  if (held) return held;
  if (init.signal && init.signal.aborted) throw e1;
  const why = direct + ", and " + st.tried + " fallback route" + (st.tried === 1 ? "" : "s") + " failed (" + describeStats(st) + ")";
  markDead(host, why, timedOut ? "t" : "b");
  throw netError(host, why, e1);
}

async function netFetch(input, init) {
  const real = globalThis.__crRealFetch || fetch;
  return fetchDirectThenProxies(real, input, init);
}

// Patch fetch/XHR so Python (requests, urllib, pyfetch) and JavaScript get the
// fallback behaviour. On the iframe thread the patch is only active while a run
// executes, so the host page's own traffic is never touched.
function patchFetch() {
  if (globalThis.__crFetchPatched || typeof globalThis.fetch !== "function") return;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.__crRealFetch = real;
  globalThis.fetch = function (input, init) {
    if (!globalThis.__crRunning) return real(input, init);
    return fetchDirectThenProxies(real, input, init);
  };
  globalThis.__crFetchPatched = true;
}

function patchXHR() {
  const X = globalThis.XMLHttpRequest;
  if (!X || X.prototype.__crPatched) return;
  const P = X.prototype, open = P.open, send = P.send, setHeader = P.setRequestHeader, overrideMime = P.overrideMimeType;
  P.open = function (method, url, async, user, pw) {
    this.__cr = { method, url: String(url), sync: async === false, headers: [], user, pw, mime: null };
    return open.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    if (this.__cr) this.__cr.headers.push([k, v]);
    return setHeader.call(this, k, v);
  };
  if (overrideMime) {
    P.overrideMimeType = function (m) {
      if (this.__cr) this.__cr.mime = m;
      return overrideMime.call(this, m);
    };
  }
  P.send = function (body) {
    const r = this.__cr;
    if (!r || !r.sync || !globalThis.__crRunning) return send.call(this, body);
    const host = hostOf(r.url), dead = deadHost(host);
    let err = null;
    try { send.call(this, body); } catch (e) { err = e; }
    if (!err && this.status !== 0) { markAlive(host); return; }   // direct request answered
    if (dead) {
      const why = "still unreachable (" + dead.why + ") - use a different source.";
      netNote(host, why);
      throw netError(host, why, err);
    }
    const credentialed = r.headers.some(([k]) => AUTH_HEADER.test(k)) || !!this.withCredentials;
    let responseType = "";
    try { responseType = this.responseType; } catch (e) {}
    const cands = proxyCandidates(r.url, { credentialed, sync: true }).slice(0, XHR_SYNC_ROUTES_MAX);
    for (const cand of cands) {
      try {
        open.call(this, r.method, cand.url, false, r.user, r.pw);
        for (const [k, v] of r.headers) setHeader.call(this, k, v);
        if (r.mime && overrideMime) overrideMime.call(this, r.mime);
        if (responseType) { try { this.responseType = responseType; } catch (e) {} }
        send.call(this, body);
        const passthrough = cand.trusted && typeof this.getResponseHeader === "function" && this.getResponseHeader("x-cr-proxy");
        if (passthrough || (this.status >= 200 && this.status < 300)) return;
      } catch (e) { err = e; }
    }
    const why = "the browser blocked it" + (cands.length ? " and " + cands.length + " fallback routes failed" : "") +
      (credentialed && !globalThis.__crCorsProxy ? "; credentialed requests are never sent through public proxies" : "");
    if (cands.length) markDead(host, why, "b"); else netNote(host, why);
    throw netError(host, why, err);
  };
  P.__crPatched = true;
}

// ---------------------------------------------------------------------------
// Execution engine. Runs inside the worker (or in-thread as a fallback). It
// owns /workspace: an in-memory file map until Python starts, then Pyodide's
// MEMFS. Everything it uses is inside this function or shipped via
// SHARED_FUNCTIONS / workerConstants() below.
// ---------------------------------------------------------------------------
function crEngine(post, env) {
  const G = globalThis;
  const files = new Map();                 // abs path -> Uint8Array (before Python)
  const dirs = new Set(["/workspace", "/tmp"]);
  const kv = new Map();
  let cfg = {};
  let py = null, pyLoading = null, pyHttpOk = true, sqlLib = null, babelLib = null;
  let runId = 0, headLen = 0, tail = "", dropped = 0, lastTailPost = 0;

  // ----- output ---------------------------------------------------------------
  function resetOutput(id) { runId = id; headLen = 0; tail = ""; dropped = 0; lastTailPost = 0; }
  function emit(s) {
    s = String(s);
    if (!s) return;
    if (headLen < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - headLen;
      const part = s.length <= room ? s : s.slice(0, room);
      headLen += part.length;
      post({ id: runId, ev: "out", s: part });
      if (s.length <= room) return;
      s = s.slice(room);
    }
    dropped += s.length;
    tail = (tail + s).slice(-OUTPUT_TAIL);
    if (dropped - lastTailPost > 4000) { lastTailPost = dropped; post({ id: runId, ev: "tail", s: tail, dropped }); }
  }

  // ----- workspace --------------------------------------------------------------
  function norm(p) {
    p = String(p == null ? "" : p).trim();
    if (!p || p === ".") p = WORKDIR;
    if (!p.startsWith("/")) p = WORKDIR + "/" + p;
    const parts = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    return "/" + parts.join("/");
  }
  const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  function enoent(p) { const e = new Error("ENOENT: no such file or directory: " + p); e.code = "ENOENT"; return e; }
  function fsCall(fn, p) {
    try { return fn(); }
    catch (e) {
      if (e && (e.errno === 44 || e.code === "ENOENT")) throw enoent(p);
      if (e && (e.errno === 31 || e.errno === 54)) { const x = new Error("EISDIR/ENOTDIR: " + p); x.code = "EISDIR"; throw x; }
      if (e && e.errno === 55) { const x = new Error("ENOTEMPTY: directory not empty: " + p); x.code = "ENOTEMPTY"; throw x; }
      throw e;
    }
  }
  function isDirMap(p) {
    if (dirs.has(p)) return true;
    const pre = p + "/";
    for (const k of files.keys()) if (k.startsWith(pre)) return true;
    return false;
  }
  function wsExists(p) {
    p = norm(p);
    if (py) return py.FS.analyzePath(p).exists;
    return files.has(p) || isDirMap(p);
  }
  function wsIsDir(p) {
    p = norm(p);
    if (py) { const a = py.FS.analyzePath(p); return !!(a.exists && a.object && py.FS.isDir(a.object.mode)); }
    return !files.has(p) && isDirMap(p);
  }
  function wsRead(p) {
    p = norm(p);
    if (py) {
      if (wsIsDir(p)) { const e = new Error("EISDIR: is a directory: " + p); e.code = "EISDIR"; throw e; }
      return fsCall(() => py.FS.readFile(p), p);
    }
    if (!files.has(p)) throw enoent(p);
    return files.get(p);
  }
  function wsWrite(p, bytes) {
    p = norm(p);
    if (py) { py.FS.mkdirTree(dirname(p)); return fsCall(() => py.FS.writeFile(p, bytes), p); }
    files.set(p, bytes);
    let d = dirname(p);
    while (d && d !== "/") { dirs.add(d); d = dirname(d); }
  }
  function wsMkdir(p) {
    p = norm(p);
    if (py) return py.FS.mkdirTree(p);
    while (p && p !== "/") { dirs.add(p); p = dirname(p); }
  }
  function wsReaddir(p) {
    p = norm(p);
    if (py) return fsCall(() => py.FS.readdir(p), p).filter((n) => n !== "." && n !== "..").sort();
    if (!isDirMap(p)) throw enoent(p);
    const pre = p === "/" ? "/" : p + "/", names = new Set();
    for (const k of [...files.keys(), ...dirs]) if (k.startsWith(pre) && k.length > pre.length) names.add(k.slice(pre.length).split("/")[0]);
    return [...names].sort();
  }
  function wsStat(p) {
    p = norm(p);
    if (py) {
      const s = fsCall(() => py.FS.stat(p), p);
      return { size: s.size, isDir: py.FS.isDir(s.mode), isFile: !py.FS.isDir(s.mode), mtime: new Date(s.mtime) };
    }
    if (files.has(p)) return { size: files.get(p).length, isDir: false, isFile: true, mtime: new Date() };
    if (isDirMap(p)) return { size: 0, isDir: true, isFile: false, mtime: new Date() };
    throw enoent(p);
  }
  function wsRemove(p, recursive) {
    p = norm(p);
    if (py) {
      if (!wsExists(p)) throw enoent(p);
      if (wsIsDir(p)) {
        if (recursive) for (const n of wsReaddir(p)) wsRemove(p + "/" + n, true);
        return fsCall(() => py.FS.rmdir(p), p);
      }
      return fsCall(() => py.FS.unlink(p), p);
    }
    if (files.delete(p)) return;
    if (!isDirMap(p)) throw enoent(p);
    const pre = p + "/";
    const children = [...files.keys()].filter((k) => k.startsWith(pre));
    if (children.length && !recursive) { const e = new Error("ENOTEMPTY: directory not empty: " + p); e.code = "ENOTEMPTY"; throw e; }
    for (const k of children) files.delete(k);
    for (const d of [...dirs]) if (d === p || d.startsWith(pre)) dirs.delete(d);
  }
  function wsRename(a, b) {
    a = norm(a); b = norm(b);
    if (py) { py.FS.mkdirTree(dirname(b)); return fsCall(() => py.FS.rename(a, b), a); }
    if (files.has(a)) { wsWrite(b, files.get(a)); files.delete(a); return; }
    if (!isDirMap(a)) throw enoent(a);
    const pre = a + "/";
    for (const k of [...files.keys()]) if (k.startsWith(pre)) { wsWrite(b + k.slice(a.length), files.get(k)); files.delete(k); }
    for (const d of [...dirs]) if (d === a || d.startsWith(pre)) { dirs.delete(d); dirs.add(b + d.slice(a.length)); }
  }
  // Every file under /workspace as [relative path, bytes].
  function wsWalk() {
    const out = [];
    if (py) {
      const walk = (dir) => {
        if (!py.FS.analyzePath(dir).exists) return;
        for (const name of py.FS.readdir(dir)) {
          if (name === "." || name === "..") continue;
          const p = dir + "/" + name, st = py.FS.stat(p);
          if (py.FS.isDir(st.mode)) walk(p);
          else if (py.FS.isFile(st.mode)) out.push([p.slice(WORKDIR.length + 1), py.FS.readFile(p)]);
        }
      };
      walk(WORKDIR);
    } else {
      for (const [p, b] of files) if (p.startsWith(WORKDIR + "/")) out.push([p.slice(WORKDIR.length + 1), b]);
    }
    return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  }
  function listingNote() {
    let rows = [];
    try { rows = wsWalk().map(([p, b]) => p + " (" + (b.length < 1024 ? b.length + " B" : Math.ceil(b.length / 1024) + " KB") + ")"); } catch (e) {}
    if (!rows.length) return "/workspace is empty: the file was never written. Check that the step that should have created it actually succeeded.";
    const shown = rows.slice(0, 40);
    return "/workspace contains " + rows.length + " file" + (rows.length === 1 ? "" : "s") + ": " + shown.join(", ") + (rows.length > shown.length ? ", ..." : "");
  }

  // ----- Python -------------------------------------------------------------------
  const PY_SETUP = [
    "import os, sys, warnings",
    "os.environ.setdefault('MPLBACKEND', 'Agg')",
    "warnings.filterwarnings('ignore', message='.*non-interactive.*')",
    "warnings.filterwarnings('ignore', message='.*Matplotlib is currently using agg.*')",
    "def _cr_missing(names):",
    "    import importlib.util",
    "    out = []",
    "    for n in names:",
    "        try:",
    "            if importlib.util.find_spec(n) is None: out.append(n)",
    "        except Exception:",
    "            out.append(n)",
    "    return out",
    "def _cr_save_figures():",
    "    m = sys.modules.get('matplotlib.pyplot')",
    "    if m is None: return []",
    "    saved = []",
    "    for num in m.get_fignums():",
    "        name = 'figure_%d.png' % num",
    "        try:",
    "            m.figure(num).savefig(os.path.join('/workspace', name), dpi=110, bbox_inches='tight')",
    "            saved.append(name)",
    "        except Exception:",
    "            pass",
    "    m.close('all')",
    "    return saved"
  ].join("\n");

  async function ensurePy() {
    if (py) return py;
    if (!pyLoading) {
      pyLoading = (async () => {
        const errors = [];
        let inst = null;
        for (const cdn of cfg.pyodideCdns || []) {
          try {
            if (typeof G.loadPyodide !== "function") {
              await withTimeout(loadScript(cdn.index + "pyodide.js"), SCRIPT_TIMEOUT_MS, "pyodide.js from " + hostOf(cdn.index));
            }
            const opts = { indexURL: cdn.index };
            if (cdn.packages) opts.packageBaseUrl = cdn.packages;
            inst = await withTimeout(G.loadPyodide(opts), RUNTIME_TIMEOUT_MS, "Python runtime from " + hostOf(cdn.index));
            G.__crPyodideCdnUsed = cdn.index;
            break;
          } catch (e) { errors.push(hostOf(cdn.index) + ": " + (e.message || e)); }
        }
        if (!inst) throw new Error("Could not download the Python runtime from any CDN (" + errors.join("; ") + "). Check the internet connection and try again.");
        inst.FS.mkdirTree(WORKDIR);
        for (const d of dirs) { try { inst.FS.mkdirTree(d); } catch (e) {} }
        for (const [p, b] of files) { inst.FS.mkdirTree(dirname(p)); inst.FS.writeFile(p, b); }
        files.clear();
        const quiet = { messageCallback: () => {}, errorCallback: () => {} };
        try {
          await inst.loadPackage("pyodide-http", quiet);
          inst.runPython("import pyodide_http\ngetattr(pyodide_http, 'patch_urllib', pyodide_http.patch_all)()");
        } catch (e) { pyHttpOk = false; }
        inst.runPython(PY_SETUP);
        py = inst;
        return inst;
      })().catch((e) => { pyLoading = null; throw e; });
    }
    return pyLoading;
  }

  function cleanTraceback(msg) {
    const out = [];
    let skip = false;
    for (const line of String(msg).split("\n")) {
      const fm = /^  File "([^"]+)"/.exec(line);
      if (fm) { skip = /\/_pyodide\//.test(fm[1]); if (!skip) out.push(line); continue; }
      if (skip && /^    /.test(line)) continue;
      skip = false;
      out.push(line);
    }
    return out.join("\n").trim();
  }

  async function runPython(msg, notes) {
    const code = msg.code;
    const p = await ensurePy();
    const quiet = { messageCallback: () => {} };

    // Packages Pyodide ships load from the imports; retry once for a flaky CDN.
    const loadImports = async () => {
      const errs = [];
      try { await p.loadPackagesFromImports(code, { ...quiet, errorCallback: (m) => errs.push(String(m)) }); }
      catch (e) { errs.push(String(e && e.message || e)); }
      return errs;
    };
    let loadErrors = await loadImports();
    if (loadErrors.length) loadErrors = await loadImports();
    if (loadErrors.length) notes.push("some Python packages could not be downloaded: " + loadErrors.slice(0, 3).join(" | ").slice(0, 400));

    // Pure-Python packages: the ones listed, plus known imports that are missing.
    const wanted = [];
    for (const name of Array.isArray(msg.packages) ? msg.packages : []) if (typeof name === "string" && name.trim()) wanted.push(name.trim());
    try {
      const found = p.pyodide_py.code.find_imports(code);
      const names = found.toJs(); found.destroy();
      const missingProxy = p.globals.get("_cr_missing")(names);
      const missing = missingProxy.toJs(); missingProxy.destroy();
      for (const n of missing) if (PY_PIP_ALIASES[n]) wanted.push(PY_PIP_ALIASES[n]);
    } catch (e) {}
    const toInstall = [...new Set(wanted)];
    if (toInstall.length) {
      try {
        await p.loadPackage("micropip", quiet);
        const micropip = p.pyimport("micropip");
        const failed = [];
        for (const name of toInstall) {
          try { await micropip.install(name); }
          catch (e) {
            const m = String(e && e.message || e).split("\n").filter((l) => l.trim()).pop() || "install failed";
            failed.push(name + " (" + m.slice(0, 200) + ")");
          }
        }
        micropip.destroy();
        if (failed.length) notes.push("could not install: " + failed.join("; ") + ". Only pure-Python wheels or packages built for Pyodide can be installed");
      } catch (e) { notes.push("the package installer (micropip) could not be loaded: " + (e.message || e)); }
    }

    p.setStdout({ batched: (s) => emit(s + "\n") });
    p.setStderr({ batched: (s) => emit(s + "\n") });
    const lines = typeof msg.stdin === "string" && msg.stdin.length ? msg.stdin.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    p.setStdin({ stdin: () => (lines.length ? lines.shift() : null) });
    p.runPython("import os, sys\nos.makedirs('/workspace', exist_ok=True)\nos.chdir('/workspace')\nif '/workspace' not in sys.path: sys.path.insert(0, '/workspace')");

    post({ id: runId, ev: "started" });
    let error = null;
    try {
      const v = await p.runPythonAsync(code, { filename: "<code>" });
      if (v !== undefined && v !== null) {
        try { emit(String(v) + "\n"); } finally { if (v && typeof v.destroy === "function") v.destroy(); }
      }
    } catch (e) {
      const text = cleanTraceback(e && e.message || e);
      error = "Python error:\n" + text;
      const mod = /ModuleNotFoundError: No module named '([^']+)'/.exec(text);
      if (mod) {
        const top = mod[1].split(".")[0];
        error += "\nHint: pass packages: [\"" + (PY_PIP_ALIASES[top] || top) + "\"] to install it (pure-Python wheels only), or use a library Pyodide ships.";
      }
      if (/FileNotFoundError|No such file or directory/.test(text)) error += "\n" + listingNote();
      if (/Host is unreachable|socket\.|getaddrinfo/.test(text)) error += "\nHint: sockets and DNS do not exist in the browser. Use requests / urllib / pyodide.http.pyfetch (HTTP only).";
      if (/EOFError/.test(text)) error += "\nHint: input() reads from the `stdin` parameter of run_code; pass the input lines there.";
      if (/urllib/.test(code) && !pyHttpOk) error += "\nHint: urllib.request is unavailable in this session; use requests or pyodide.http.pyfetch.";
    }
    try { p.runPython("import sys\nsys.stdout.flush()\nsys.stderr.flush()"); } catch (e) {}
    try {
      const saved = p.globals.get("_cr_save_figures")();
      const names = saved.toJs(); saved.destroy();
      if (names.length) notes.push("matplotlib figure" + (names.length > 1 ? "s" : "") + " saved to /workspace: " + names.join(", ") + " - call serve_file to show " + (names.length > 1 ? "them" : "it") + " to the user");
    } catch (e) {}
    return error;
  }

  // ----- JavaScript / TypeScript ---------------------------------------------------------
  function jsonSafe(x) {
    const seen = new WeakSet();
    return JSON.stringify(x, (k, v) => {
      if (typeof v === "bigint") return v.toString() + "n";
      if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
      if (typeof v === "undefined") return "[undefined]";
      if (typeof v === "symbol") return v.toString();
      if (v instanceof Map) return { "[Map]": [...v.entries()] };
      if (v instanceof Set) return { "[Set]": [...v.values()] };
      if (v instanceof Error) return v.name + ": " + v.message;
      if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + v.length + ")";
      if (v instanceof ArrayBuffer) return "ArrayBuffer(" + v.byteLength + ")";
      if (v && typeof v === "object") { if (seen.has(v)) return "[Circular]"; seen.add(v); }
      return v;
    });
  }
  function fmt(x) {
    if (typeof x === "string") return x;
    if (x === undefined) return "undefined";
    if (x === null || typeof x === "number" || typeof x === "boolean") return String(x);
    if (typeof x === "bigint") return x.toString() + "n";
    if (typeof x === "symbol") return x.toString();
    if (typeof x === "function") return "[Function " + (x.name || "anonymous") + "]";
    if (x instanceof Error) return x.name + ": " + x.message;
    if (typeof Response === "function" && x instanceof Response) return "Response { status: " + x.status + ", url: " + JSON.stringify(x.url) + " } (read it with await r.text(), r.json() or r.arrayBuffer())";
    if (x && typeof x.then === "function") return "Promise { <pending> } (missing await?)";
    if (ArrayBuffer.isView(x) && !(x instanceof DataView)) return x.constructor.name + "(" + x.length + ") [" + Array.from(x.slice(0, 48)).join(", ") + (x.length > 48 ? ", ..." : "") + "]";
    try { const s = jsonSafe(x); return s === undefined ? String(x) : s; } catch (e) { return String(x); }
  }

  async function ensureBabel() {
    if (babelLib) return babelLib;
    const errors = [];
    for (const u of cfg.babelCdns || BABEL_CDNS) {
      if (G.Babel) break;
      try { await withTimeout(loadScript(u), SCRIPT_TIMEOUT_MS, "the TypeScript compiler from " + hostOf(u)); }
      catch (e) { errors.push(hostOf(u) + ": " + (e.message || e)); }
    }
    if (!G.Babel) throw new Error("Could not download the TypeScript compiler from any CDN (" + errors.join("; ") + "). Retry, or use javascript.");
    babelLib = G.Babel;
    return babelLib;
  }

  async function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data.slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (typeof Blob === "function" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof Response === "function" && data instanceof Response) return new Uint8Array(await data.arrayBuffer());
    if (data && typeof data === "object") return new TextEncoder().encode(JSON.stringify(data, null, 2));
    throw new TypeError("fs.writeFile expects a string, Uint8Array, ArrayBuffer, Blob, Response or JSON-able object");
  }

  function makeFs() {
    const decode = (b) => new TextDecoder().decode(b);
    return {
      readFile: async (p, enc) => {
        const e = enc && typeof enc === "object" ? enc.encoding : enc;
        const b = wsRead(p);
        if (e === "binary" || e === "buffer" || e === "bytes" || e === null) return b;
        if (e === "base64") return bytesToBase64(b);
        return decode(b);
      },
      readJSON: async (p) => JSON.parse(decode(wsRead(p))),
      writeFile: async (p, data) => { const b = await toBytes(data); wsWrite(p, b); return b.length; },
      appendFile: async (p, data) => {
        const add = await toBytes(data);
        const old = wsExists(p) ? wsRead(p) : new Uint8Array(0);
        const b = new Uint8Array(old.length + add.length); b.set(old); b.set(add, old.length);
        wsWrite(p, b); return b.length;
      },
      exists: async (p) => wsExists(p),
      readdir: async (p) => wsReaddir(p == null ? WORKDIR : p),
      mkdir: async (p) => { wsMkdir(p); return true; },
      unlink: async (p) => { wsRemove(p, false); return true; },
      rm: async (p, o) => { if (!wsExists(p)) { if (o && o.force) return false; throw enoent(norm(p)); } wsRemove(p, !!(o && o.recursive)); return true; },
      rename: async (a, b) => { wsRename(a, b); return true; },
      copyFile: async (a, b) => { wsWrite(b, wsRead(a).slice()); return true; },
      stat: async (p) => wsStat(p),
      list: async () => wsWalk().map(([path, b]) => ({ path, size: b.length })),
      download: async (url, name) => {
        const r = await netFetch(url);
        if (!r.ok) throw new Error("download failed: HTTP " + r.status + " from " + url);
        const b = new Uint8Array(await r.arrayBuffer());
        let target = name;
        if (!target) { try { target = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch (e) {} }
        target = target || "download.bin";
        wsWrite(target, b);
        return { path: norm(target), size: b.length, contentType: r.headers.get("content-type") };
      }
    };
  }

  function makeStorage() {
    return {
      get: (k) => kv.get(String(k)),
      set: (k, v) => { kv.set(String(k), v); return v; },
      has: (k) => kv.has(String(k)),
      delete: (k) => kv.delete(String(k)),
      keys: () => [...kv.keys()],
      clear: () => kv.clear()
    };
  }

  async function runJavaScript(msg) {
    const label = msg.lang === "typescript" ? "TypeScript" : "JavaScript";
    let src = msg.code;
    if (msg.lang === "typescript") {
      const B = await ensureBabel();
      try {
        src = B.transform(src, {
          filename: "code.ts",
          presets: [["typescript", { onlyRemoveTypeImports: true }]],
          sourceType: "script",
          parserOpts: { allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true },
          retainLines: true,
          comments: false
        }).code;
      } catch (e) {
        post({ id: runId, ev: "started" });
        return "TypeScript error:\n" + String(e && e.message || e).replace(/^\/?code\.ts: /, "").split("\n").slice(0, 12).join("\n");
      }
    }
    const counts = {}, timers = {};
    let indent = "";
    const line = (prefix) => (...a) => emit(indent + prefix + a.map(fmt).join(" ") + "\n");
    const con = {
      log: line(""), info: line(""), debug: line(""), trace: line(""),
      warn: line("[warn] "), error: line("[error] "),
      dir: (x) => emit(indent + fmt(x) + "\n"),
      table: (rows) => {
        if (!rows || typeof rows !== "object") return emit(indent + fmt(rows) + "\n");
        const list = Array.isArray(rows) ? rows : Object.entries(rows).map(([k, v]) => ({ "(index)": k, ...(v && typeof v === "object" ? v : { Value: v }) }));
        const cols = [...new Set(list.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : ["Value"])))];
        emit(indent + cols.join(" | ") + "\n");
        for (const r of list.slice(0, 500)) emit(indent + cols.map((c) => fmt(r && typeof r === "object" ? r[c] : r)).join(" | ") + "\n");
      },
      assert: (ok, ...a) => { if (!ok) emit(indent + "[assert] " + (a.length ? a.map(fmt).join(" ") : "Assertion failed") + "\n"); },
      count: (l = "default") => { counts[l] = (counts[l] || 0) + 1; emit(indent + l + ": " + counts[l] + "\n"); },
      time: (l = "default") => { timers[l] = Date.now(); },
      timeEnd: (l = "default") => { if (timers[l] != null) emit(indent + l + ": " + (Date.now() - timers[l]) + " ms\n"); delete timers[l]; },
      timeLog: (l = "default") => { if (timers[l] != null) emit(indent + l + ": " + (Date.now() - timers[l]) + " ms\n"); },
      group: (...a) => { if (a.length) emit(indent + a.map(fmt).join(" ") + "\n"); indent += "  "; },
      groupEnd: () => { indent = indent.slice(2); }
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try { fn = new AsyncFunction("console", "fetch", "fs", "storage", "stdin", "sleep", "importScripts", src); }
    catch (e) {
      post({ id: runId, ev: "started" });
      return label + " syntax error: " + (e && e.message || e);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // In the worker importScripts is native (synchronous); on the page thread
    // it loads script tags - `await importScripts(url)` works in both.
    const scripts = typeof G.importScripts === "function" ? G.importScripts.bind(G)
      : async (...urls) => { for (const u of urls) await withTimeout(loadScript(u), SCRIPT_TIMEOUT_MS, "importScripts " + u); };
    post({ id: runId, ev: "started" });
    try {
      const v = await fn(con, netFetch, makeFs(), makeStorage(), typeof msg.stdin === "string" ? msg.stdin : "", sleep, scripts);
      if (v !== undefined) emit(fmt(v) + "\n");
      return null;
    } catch (e) {
      let text;
      if (e instanceof Error) {
        text = e.name + ": " + e.message;
        // The user's code is an AsyncFunction: its frames end in ", <anonymous>:LINE:COL)"
        // and the generated header adds two lines.
        const m = /(?:^|[\s,(])<anonymous>:(\d+):(\d+)\)?\s*$/m.exec(e.stack || "");
        if (m) text += " (at line " + Math.max(1, Number(m[1]) - 2) + ")";
      } else text = "uncaught " + fmt(e);
      let out = label + " error: " + text;
      if (e && e.code === "ENOENT") out += "\n" + listingNote();
      if (/\b(require|module|process|Buffer|__dirname) is not defined/.test(text)) {
        out += "\nHint: this is a browser runtime, not Node.js. Use fetch, the provided fs/storage objects, and load libraries with `await import('https://cdn.jsdelivr.net/npm/<pkg>/+esm')`.";
      }
      return out;
    }
  }

  // ----- SQL ---------------------------------------------------------------------------
  async function ensureSql() {
    if (sqlLib) return sqlLib;
    const errors = [];
    for (const base of cfg.sqljsCdns || []) {
      try {
        if (typeof G.initSqlJs !== "function") await withTimeout(loadScript(base + "sql-wasm.js"), SCRIPT_TIMEOUT_MS, "sql-wasm.js from " + hostOf(base));
        sqlLib = await withTimeout(G.initSqlJs({ locateFile: (f) => base + f }), RUNTIME_TIMEOUT_MS, "SQLite runtime from " + hostOf(base));
        G.__crSqljsCdnUsed = base;
        return sqlLib;
      } catch (e) { errors.push(hostOf(base) + ": " + (e.message || e)); }
    }
    throw new Error("Could not download the SQLite runtime from any CDN (" + errors.join("; ") + "). Check the internet connection and try again.");
  }

  function formatSqlResult(r, label) {
    const cell = (v) => (v === null ? "NULL" : v instanceof Uint8Array ? "<blob " + v.length + " bytes>" : String(v));
    const rows = r.values.slice(0, 500).map((row) => row.map(cell).join(" | "));
    const more = r.values.length > 500 ? "\n(" + (r.values.length - 500) + " more rows - add LIMIT)" : "";
    return (label ? "-- result " + label + "\n" : "") + r.columns.join(" | ") + (rows.length ? "\n" + rows.join("\n") : "\n(0 rows)") + more;
  }

  async function runSql(msg) {
    const SQL = await ensureSql();
    const dbPath = WORKDIR + "/" + DB_REL;
    const image = wsExists(dbPath) ? wsRead(dbPath) : null;
    const db = image && image.length ? new SQL.Database(image) : new SQL.Database();
    post({ id: runId, ev: "started" });
    let error = null;
    const results = [];
    let changed = 0;
    try {
      // Statement by statement, so a SELECT with no rows still shows its columns.
      for (const stmt of db.iterateStatements(msg.code)) {
        try {
          const columns = stmt.getColumnNames();
          const values = [];
          while (stmt.step()) values.push(stmt.get());
          if (columns.length) results.push({ columns, values });
          else changed += db.getRowsModified();
        } finally { stmt.free(); }
      }
    } catch (e) { error = "SQL error: " + (e && e.message || e); }
    if (results.length) emit(results.map((r, i) => formatSqlResult(r, results.length > 1 ? i + 1 : 0)).join("\n\n") + "\n");
    else if (!error) emit("(ok" + (changed ? ", " + changed + " row" + (changed === 1 ? "" : "s") + " changed" : "") + ")\n");
    try {
      const hasSchema = db.exec("SELECT count(*) FROM sqlite_master")[0].values[0][0] > 0;
      if (image || hasSchema) wsWrite(dbPath, db.export());
    } finally { db.close(); }
    return error;
  }

  // ----- messages ----------------------------------------------------------------------
  async function handle(msg) {
    const id = msg && msg.id;
    try {
      switch (msg.op) {
        case "ping":
          return post({ id, ok: true, worker: !!env.inWorker });
        case "init": {
          cfg = msg.cfg || {};
          G.__crCorsProxy = cfg.corsProxy || "";
          G.__crFetchTimeout = cfg.fetchTimeoutMs || 30000;
          mergeHosts(msg.hosts);
          for (const [rel, b] of msg.files || []) wsWrite(WORKDIR + "/" + rel, b);
          for (const [k, v] of Object.entries(msg.kv || {})) kv.set(k, v);
          if (env.inWorker) { G.__crRunning = 1; patchFetch(); patchXHR(); }
          return post({ id, ok: true });
        }
        case "run": {
          resetOutput(id);
          G.__crNetLog = new Map();
          const notes = [];
          if (!env.inWorker) { patchFetch(); patchXHR(); G.__crRunning = (G.__crRunning || 0) + 1; }
          let error = null;
          try {
            if (msg.lang === "python") error = await runPython(msg, notes);
            else if (msg.lang === "javascript" || msg.lang === "typescript") error = await runJavaScript(msg);
            else if (msg.lang === "sql") error = await runSql(msg);
            else error = "Unsupported language: " + msg.lang;
          } catch (e) {
            error = String(e && e.message || e);
          } finally {
            if (!env.inWorker) G.__crRunning--;
          }
          return post({ id, ok: true, error, notes, tail, dropped, netLog: [...G.__crNetLog], hosts: hostHealthSnapshot() });
        }
        case "snapshot": {
          const kvObj = {};
          for (const [k, v] of kv) { try { JSON.stringify(v); kvObj[k] = v; } catch (e) {} }
          return post({ id, ok: true, files: wsWalk(), kv: kvObj, hosts: hostHealthSnapshot() });
        }
        default:
          return post({ id, ok: false, error: "unknown op " + msg.op });
      }
    } catch (e) {
      return post({ id, ok: false, error: String(e && e.message || e) });
    }
  }

  return { handle };
}

// Functions and constants shipped into the worker (by source text).
const SHARED_FUNCTIONS = [
  loadScript, withTimeout, bytesToBase64, base64ToBytes, hostOf, isAbort,
  fetchTimeoutMs, proxyTimeoutMs, proxyPhaseMs, deadHostProbeMs, hostHealth, deadHost, markDead, markAlive,
  netNote, netError, hostHealthSnapshot, mergeHosts, applyProxy, mirrorUrl, proxyCandidates, requestUrl,
  carriesCredentials, timedFetch, proxyHop, raceProxies, describeStats, fetchDirectThenProxies, netFetch,
  patchFetch, patchXHR, crEngine
];
function workerConstants() {
  return {
    WORKDIR, DB_REL, OUTPUT_HEAD, OUTPUT_TAIL, SCRIPT_TIMEOUT_MS, RUNTIME_TIMEOUT_MS, BABEL_CDNS,
    PY_PIP_ALIASES, BUILTIN_PROXIES, PROXY_PARALLEL, DEAD_HOST_TTL_MS, XHR_SYNC_ROUTES_MAX
  };
}
function workerSource() {
  let s = "";
  for (const [k, v] of Object.entries(workerConstants())) s += "const " + k + " = " + JSON.stringify(v) + ";\n";
  s += "const AUTH_HEADER = " + String(AUTH_HEADER) + ";\n";
  s += SHARED_FUNCTIONS.map((f) => f.toString()).join("\n\n");
  s += "\nconst __crEngine = crEngine((m) => self.postMessage(m), { inWorker: true });\n";
  s += "self.onmessage = (e) => { __crEngine.handle(e.data); };\n";
  return s;
}

// ---------------------------------------------------------------------------
// Engine client (iframe thread)
// ---------------------------------------------------------------------------
function createEngine(options) {
  options = options || {};
  const pending = new Map();
  let seq = 0, worker = null, local = null;

  function dispatch(m) {
    const p = m && pending.get(m.id);
    if (!p) return;
    if (m.ev) { if (m.ev === "started") p.onStarted(); else if (p.onEvent) p.onEvent(m); return; }
    pending.delete(m.id);
    p.done(m);
  }
  function startLocal() {
    local = crEngine((m) => { Promise.resolve().then(() => dispatch(m)); }, { inWorker: false });
  }
  function failAll(reason) {
    for (const [id, p] of pending) p.done({ id, ok: false, error: reason, crashed: true });
    pending.clear();
  }
  function terminate() {
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
  }
  const canWorker = !options.noWorker && typeof Worker === "function" && typeof Blob === "function" &&
    typeof URL === "function" && typeof URL.createObjectURL === "function";
  if (canWorker) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" })));
      w.onmessage = (e) => dispatch(e.data);
      w.onerror = (e) => {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        failAll("the background runtime crashed" + (e && e.message ? " (" + e.message + ")" : "") + " - usually out of memory");
        terminate();
      };
      worker = w;
    } catch (e) { worker = null; }
  }
  if (!worker) startLocal();

  function call(msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const id = ++seq;
      msg.id = id;
      let timer = null;
      const clear = () => { if (timer) clearTimeout(timer); timer = null; };
      const arm = (ms, phase) => {
        clear();
        if (!ms || !worker) return;
        timer = setTimeout(() => {
          pending.delete(id);
          terminate();
          resolve({ id, ok: false, timedOut: true, phase });
        }, ms);
      };
      pending.set(id, {
        onEvent: opts.onEvent,
        onStarted: () => arm(opts.execTimeoutMs, "run"),
        done: (m) => { clear(); resolve(m); }
      });
      arm(opts.timeoutMs, opts.execTimeoutMs ? "boot" : "op");
      if (!worker && !local) { pending.delete(id); clear(); return resolve({ id, ok: false, error: "the runtime is no longer available", crashed: true }); }
      try { if (worker) worker.postMessage(msg); else local.handle(msg); }
      catch (e) { pending.delete(id); clear(); resolve({ id, ok: false, error: "could not start the runtime: " + (e.message || e) }); }
    });
  }

  // A Worker can be constructed yet fail to boot (strict CSP, old browsers):
  // ping it, and fall back to running in this thread.
  async function ready() {
    if (!worker) return "thread";
    const r = await call({ op: "ping" }, { timeoutMs: 10000 });
    if (r.ok) return "worker";
    terminate();
    startLocal();
    return "thread";
  }

  return { call, ready, terminate, get mode() { return worker ? "worker" : "thread"; } };
}

// ---------------------------------------------------------------------------
// Cross-call state: [[cr-state:<base64>]] trailer.
//   packed  = flag byte (1 deflate-raw, 0 stored) + body
//   body v2 = 4-byte header length (big endian) + header JSON + file bytes
//   header  = { v: 2, files: [[relPath, byteLength], ...], kv, net, ext }
// v1 (JSON with base64 files) is still read, for trailers from older versions.
// ---------------------------------------------------------------------------
function extractTrailer(text) {
  const re = /\[\[cr-state:([A-Za-z0-9+/=]+)\]\]/g;
  let m, last = null;
  while ((m = re.exec(String(text))) !== null) last = m[1];
  return last;
}

function previousOutputText(prev) {
  if (prev == null) return "";
  if (typeof prev === "string") return prev;
  if (Array.isArray(prev)) return prev.map((p) => (p && typeof p === "object" ? p.text || p.content || "" : String(p))).join("\n");
  if (typeof prev === "object") return prev.content != null ? previousOutputText(prev.content) : prev.text != null ? String(prev.text) : JSON.stringify(prev);
  return String(prev);
}

async function pipeBytes(u8, stream) {
  const r = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(r).arrayBuffer());
}
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
  if (u8[0] === 1) {
    if (typeof DecompressionStream !== "function") throw new Error("this browser cannot decompress the saved workspace");
    return pipeBytes(body, new DecompressionStream("deflate-raw"));
  }
  return body;
}

function encodeContainer(header, files) {
  const head = new TextEncoder().encode(JSON.stringify({ ...header, v: 2, files: files.map(([p, b]) => [p, b.length]) }));
  const total = 4 + head.length + files.reduce((n, [, b]) => n + b.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let off = 4 + head.length;
  for (const [, b] of files) { out.set(b, off); off += b.length; }
  return out;
}

function decodeContainer(body) {
  if (body[0] === 0x7b) {   // "{": v1 JSON
    const snap = JSON.parse(new TextDecoder().decode(body));
    if (!snap || snap.v !== 1) throw new Error("unknown workspace format");
    const files = (snap.files || []).map(([p, b64]) => [p, base64ToBytes(b64)]);
    if (snap.sql && !files.some(([p]) => p === DB_REL)) files.push([DB_REL, base64ToBytes(snap.sql)]);
    return { files, kv: snap.kv || {}, hosts: snap.net && snap.net.hosts, ext: snap.ext || null };
  }
  const len = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + len)));
  if (!header || header.v !== 2) throw new Error("unknown workspace format");
  let off = 4 + len;
  const files = [];
  for (const [p, n] of header.files || []) { files.push([p, body.slice(off, off + n)]); off += n; }
  return { files, kv: header.kv || {}, hosts: header.net && header.net.hosts, ext: header.ext || null };
}

async function decodeState(b64) {
  return decodeContainer(await unpackBytes(base64ToBytes(b64)));
}

function rawFetch() { return globalThis.__crRealFetch || fetch; }

async function downloadBlob(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await timedFetch(rawFetch(), url, {}, fetchTimeoutMs());
      if (r.ok) return (await r.text()).trim();
      lastErr = new Error("HTTP " + r.status);
      if (r.status !== 404 && r.status < 500) break;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 800));
  }
  // Last resort: through the fallback routes (store unreachable directly).
  try {
    const r = await netFetch(url);
    if (r.ok) return (await r.text()).trim();
    lastErr = new Error("HTTP " + r.status);
  } catch (e) { lastErr = e; }
  throw lastErr;
}

// Decode a trailer (downloading an offloaded one): { files: [[rel, bytes]], kv, hosts }.
async function restoreSnapshot(b64) {
  let snap;
  try { snap = await decodeState(b64); }
  catch (e) { throw new Error("the saved workspace data is damaged"); }
  if (snap.ext) {
    const ext = snap.ext;
    if (!ext.exp || Date.now() > ext.exp) throw new Error("the saved workspace expired");
    let text;
    try { text = await downloadBlob(ext.url); }
    catch (e) { throw new Error("the saved workspace could not be downloaded from " + hostOf(ext.url) + " (" + (e.message || e) + ")"); }
    try { snap = await decodeState(text); }
    catch (e) { throw new Error("the downloaded workspace is damaged"); }
    globalThis.__crExtDel = ext.del || null;
    globalThis.__crExtIn = { ptr: ext, trailer: b64 };
  }
  mergeHosts(snap.hosts);
  return snap;
}

// A configured private store is the only destination (the user chose privacy);
// otherwise the public stores that accept this size, in order.
function workspaceBins(cfg, size) {
  if (cfg.workspaceStore) return [{ kind: "paste", host: cfg.workspaceStore, max: Infinity }];
  return PUBLIC_BINS.filter((b) => size <= b.max);
}

async function sha256Short(text) {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return bytesToBase64(new Uint8Array(d)).slice(0, 32);
  } catch (e) { return null; }
}

async function binUpload(bin, payload) {
  const real = rawFetch();
  const uploadMs = Math.max(fetchTimeoutMs(), 120000);
  if (bin.kind === "litterbox") {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "24h");
    form.append("fileToUpload", new Blob([payload], { type: "text/plain" }), "workspace.txt");
    const r = await timedFetch(real, bin.host, { method: "POST", body: form }, uploadMs);
    const url = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//i.test(url)) throw new Error("litterbox HTTP " + r.status);
    return { url, del: null };
  }
  if (bin.kind === "pastesdev") {
    const r = await timedFetch(real, bin.host, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload }, uploadMs);
    if (!(r.ok || r.status === 201)) throw new Error("pastes.dev HTTP " + r.status);
    let key = null;
    try { key = JSON.parse(await r.text()).key; } catch (e) {}
    if (!key) throw new Error("pastes.dev did not return a key");
    return { url: "https://api.pastes.dev/" + encodeURIComponent(key), del: null };
  }
  if (bin.kind === "dpaste") {
    const body = new URLSearchParams({ content: payload, syntax: "text", expiry_days: "1" });
    const r = await timedFetch(real, bin.host, { method: "POST", body }, fetchTimeoutMs());
    if (!(r.ok || r.status === 201)) throw new Error("dpaste.com HTTP " + r.status);
    const url = (await r.text()).trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(url)) throw new Error("dpaste.com did not return a URL");
    return { url: url + ".txt", del: null };
  }
  const r = await timedFetch(real, bin.host, { method: "POST", body: payload, headers: { "Content-Type": "text/plain" } }, fetchTimeoutMs());
  if (!(r.ok || r.status === 201)) throw new Error(hostOf(bin.host) + " HTTP " + r.status);
  const url = (await r.text()).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(hostOf(bin.host) + " did not return a URL");
  return { url, del: url };
}

async function uploadState(payload, cfg, hash) {
  const bins = workspaceBins(cfg, payload.length);
  if (!bins.length) {
    const e = new Error("it is " + Math.ceil(payload.length / 1024) + " KB compressed, more than the public stores accept (set the workspace store in the plugin settings to carry large workspaces)");
    e.tooLarge = true;
    throw e;
  }
  const errors = [];
  for (const bin of bins) {
    try {
      const { url, del } = await binUpload(bin, payload);
      const check = await downloadBlob(url);
      if (check !== payload) throw new Error("read-back mismatch");
      const prev = globalThis.__crExtDel;
      if (prev && prev !== del) { try { rawFetch()(prev, { method: "DELETE" }).catch(() => {}); } catch (e) {} }
      const lifeMin = Math.min(cfg.ttlMin, bin.lifeMin || Infinity);
      return { url, del, exp: Date.now() + lifeMin * 60000, h: hash || undefined };
    } catch (e) { errors.push(hostOf(bin.host) + ": " + (e.message || e)); }
  }
  throw new Error("upload failed (" + errors.join("; ") + ")");
}

async function buildTrailer(snap, cfg, notes) {
  let files = snap.files || [];
  const kvObj = snap.kv || {};
  const hosts = hostHealthSnapshot();
  if (!files.length && !Object.keys(kvObj).length && !hosts) return null;
  const total = files.reduce((n, [, b]) => n + b.length, 0);
  if (total > MAX_CARRY_BYTES) {
    // Keep the smallest files that fit; name the ones that are dropped.
    const sorted = files.slice().sort((a, b) => a[1].length - b[1].length);
    const kept = [], lost = [];
    let used = 0;
    for (const f of sorted) { if (used + f[1].length <= MAX_CARRY_BYTES) { kept.push(f); used += f[1].length; } else lost.push(f[0]); }
    files = kept;
    notes.push("/workspace is larger than " + (MAX_CARRY_BYTES >> 20) + " MB, so these files will NOT exist in the next call: " + lost.slice(0, 10).join(", ") + (lost.length > 10 ? ", ..." : "") + ". Finish the work that needs them in this call, or write smaller outputs");
  }
  const header = { kv: kvObj };
  if (hosts) header.net = { hosts };
  const limit = cfg.limitKB * 1024;
  const encode = async (list) => bytesToBase64(await packBytes(encodeContainer(header, list)));
  const pointer = async (payload) => {
    // An unchanged workspace reuses the copy already stored (no upload) until
    // shortly before it expires.
    const hash = await sha256Short(payload);
    const inc = globalThis.__crExtIn;
    if (hash && inc && inc.ptr && inc.ptr.h === hash && Date.now() < inc.ptr.exp - 30 * 60000) return inc.trailer;
    return bytesToBase64(await packBytes(encodeContainer({ ext: await uploadState(payload, cfg, hash) }, [])));
  };

  let b64 = await encode(files);
  if (b64.length <= limit) return b64;
  let reason = "offloading large workspaces is off";
  let target = limit;
  if (cfg.bigWorkspace) {
    try { return await pointer(b64); }
    catch (e) {
      reason = e.message || String(e);
      if (e.tooLarge) target = PUBLIC_BINS[0].max;   // a public store can still take a smaller set
    }
  }

  // Carry as much as possible: drop the largest files until the rest fits.
  const kept = files.slice().sort((a, b) => a[1].length - b[1].length);
  const lost = [];
  while (kept.length && b64.length > target) {
    lost.push(kept.pop()[0]);
    b64 = await encode(kept);
  }
  let trailer = null;
  if (b64.length <= limit) trailer = b64;
  else if (cfg.bigWorkspace) { try { trailer = await pointer(b64); } catch (e) {} }
  if (trailer === null) {
    lost.push(...kept.map(([p]) => p));
    kept.length = 0;
    const rest = await encode([]);
    trailer = rest.length <= limit ? rest : null;
  }
  notes.push("these /workspace files are too large to keep for the next call and will be missing there: " + lost.slice(0, 12).join(", ") +
    (lost.length > 12 ? ", ..." : "") + " (" + reason + "). Use them within this call, or save smaller outputs" + (kept.length ? "; the other files are kept" : ""));
  return trailer;
}

// ---------------------------------------------------------------------------
// Settings and output
// ---------------------------------------------------------------------------
function normalizeBase(u) {
  u = String(u || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u : u + "/";
}
function cdnCandidates(defaults, custom) {
  const c = normalizeBase(custom);
  return c ? [typeof defaults[0] === "string" ? c : { index: c }, ...defaults] : defaults;
}

function readSettings(us) {
  const s = (k) => String(us && us[k] != null ? us[k] : "").trim();
  const num = (k, d) => { const n = Number(s(k)); return n > 0 ? n : d; };
  const flag = (k, d) => { const v = s(k).toLowerCase(); return v ? !/^(off|false|0|no|disabled?)$/.test(v) : d; };
  return {
    corsProxy: s("corsProxy"),
    pyodideCdn: s("pyodideCdn"),
    sqljsCdn: s("sqljsCdn"),
    carry: flag("stateCarry", true),
    limitKB: num("stateLimitKB", STATE_LIMIT_KB_DEFAULT),
    fetchTimeoutMs: num("fetchTimeoutMs", 30000),
    bigWorkspace: flag("bigWorkspace", true),
    workspaceStore: s("workspaceStore"),
    execTimeoutS: num("execTimeoutSec", EXEC_TIMEOUT_S_DEFAULT),
    ttlMin: num("workspaceTtlMin", STATE_TTL_MIN_DEFAULT)
  };
}

function applyNetSettings(cfg) {
  globalThis.__crCorsProxy = cfg.corsProxy;
  globalThis.__crFetchTimeout = cfg.fetchTimeoutMs;
}

function capText(s) {
  s = String(s);
  if (s.length <= OUTPUT_HEAD + OUTPUT_TAIL + 200) return s;
  return s.slice(0, OUTPUT_HEAD) + "\n\n[... " + (s.length - OUTPUT_HEAD - OUTPUT_TAIL) + " characters of output omitted ...]\n\n" + s.slice(-OUTPUT_TAIL);
}

function networkNotes() {
  const log = globalThis.__crNetLog;
  if (!log || !log.size) return [];
  const lines = [...log].slice(0, 8).map(([h, why]) => "network: " + h + " - " + why);
  if (!globalThis.__crCorsProxy && [...log.values()].some((w) => /blocked/.test(w))) {
    lines.push("tip: sites that block browsers need the companion CORS proxy (plugin settings). Meanwhile prefer CORS-enabled sources: public APIs, raw.githubusercontent.com, cdn.jsdelivr.net, or https://r.jina.ai/<url> for a page's readable text");
  }
  return lines;
}

function finish(out, ctx, trailer) {
  let text = capText(String(out == null ? "" : out)).replace(/\s+$/, "");
  if (!text) text = "(no output - print the values you need)";
  const notes = ctx.notes.concat(networkNotes());
  if (notes.length) text += "\n\n" + notes.map((n) => "(" + n + ")").join("\n");
  const t = trailer === undefined ? ctx.incoming : trailer;
  if (t) text += "\n\n[[cr-state:" + t + "]]";
  return text;
}

// ---------------------------------------------------------------------------
// Remote languages
// ---------------------------------------------------------------------------
const CE_BASE = "https://godbolt.org";
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function fixSource(kind, code) {
  if (kind === "java") return code.replace(/^(\s*)public\s+((?:final\s+|abstract\s+|sealed\s+)*)(class|interface|enum|record)\b/gm, "$1$2$3");
  if (kind === "php") return /^\s*<\?php/.test(code) ? code : "<?php\n" + code;
  return code;
}

function ceText(a) { return (a || []).map((x) => String(x.text).replace(ANSI, "")).join("\n"); }

function formatCe(d) {
  const build = d.buildResult || {};
  if (!d.didExecute) {
    if (build.timedOut || d.timedOut) return "Compilation timed out on Compiler Explorer. Simplify the program.";
    const msg = [ceText(build.stderr), ceText(build.stdout), ceText(d.stderr)]
      .map((s) => s.replace(/^\s*Build failed\s*$/gm, "").replace(/<source>/g, "code").trim()).filter(Boolean).join("\n");
    return "Compilation failed:\n" + (msg || "(no compiler message)");
  }
  const parts = [];
  const so = ceText(d.stdout);
  const se = ceText(d.stderr).replace(/^\s*(Killed - processing time exceeded|Program terminated with signal: SIGKILL)\s*$/gm, "").trim();
  if (so.trim()) parts.push(so.replace(/\s+$/, ""));
  if (se) parts.push((so.trim() ? "stderr:\n" : "") + se);
  let text = parts.join("\n") || (d.timedOut ? "" : "(ran, no output)");
  if (d.timedOut) text += (text ? "\n" : "") + "(stopped: the program exceeded the remote run-time limit of a few seconds. Remote languages suit short programs; use python or javascript for long jobs.)";
  else if (d.code) text += "\n(exit code " + d.code + ")";
  if (d.truncated) text += "\n(output truncated by Compiler Explorer - print less)";
  return text;
}

async function ceRun(spec, code, stdin) {
  const real = rawFetch();
  const body = JSON.stringify({
    source: fixSource(spec.fix, code),
    lang: spec.lang,
    options: {
      userArguments: spec.args || "",
      executeParameters: { args: [], stdin: stdin || "" },
      compilerOptions: { executorRequest: true, skipAsm: true },
      filters: { execute: true },
      tools: [],
      libraries: []
    },
    allowStoreCodeDebug: false
  });
  let r = null, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await timedFetch(real, CE_BASE + "/api/compiler/" + encodeURIComponent(spec.id) + "/compile",
        { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body }, 120000);
      if (r.status !== 429 && r.status < 500) break;
      lastErr = new Error("HTTP " + r.status);
    } catch (e) { lastErr = e; r = null; }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
  }
  if (!r) return { unavailable: "Compiler Explorer is unreachable (" + (lastErr && lastErr.message || "network error") + ")" };
  if (r.status === 404) return { notFound: true };
  if (r.status === 429 || r.status >= 500) return { unavailable: "Compiler Explorer returned HTTP " + r.status };
  const raw = await r.text();
  let d;
  try { d = JSON.parse(raw); } catch (e) { return { unavailable: "Compiler Explorer returned an unexpected response (HTTP " + r.status + ")" }; }
  return { text: formatCe(d) };
}

async function ceResolve(spec) {
  const r = await timedFetch(rawFetch(), CE_BASE + "/api/compilers/" + encodeURIComponent(spec.lang) + "?fields=id,name,semver,supportsExecute",
    { headers: { "Accept": "application/json" } }, 30000);
  if (!r.ok) return null;
  const list = await r.json();
  const bad = /(trunk|nightly|snapshot|\bdev\b|assert|beta|\brc\b|latest|\bci\b|ildasm|ilspy|contracts|reflection|arm|aarch|risc|mips|power|s390|loong|sparc|avr|wasm|clang-cl|mingw)/i;
  const ver = (c) => (c.semver || (/(\d+(?:\.\d+)*)/.exec(c.name) || [, "0"])[1]).split(/\D+/).filter(Boolean).map((n) => n.padStart(6, "0")).join(".");
  const cands = list.filter((c) => c.supportsExecute && !bad.test(c.name) && !bad.test(c.id) && (!spec.pick || spec.pick.test(c.name)));
  cands.sort((a, b) => (ver(a) < ver(b) ? 1 : -1));
  return cands.length ? cands[0].id : null;
}

async function wbRun(compiler, wbLang, code, stdin, fix) {
  const real = rawFetch();
  const post = (name) => timedFetch(real, "https://wandbox.org/api/compile.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ compiler: name, code: fixSource(fix, code), stdin: stdin || "" })
  }, 120000);
  let r;
  try { r = await post(compiler); } catch (e) { return { unavailable: "Wandbox is unreachable (" + (e.message || e) + ")" }; }
  if (!r.ok && wbLang) {
    // The pinned compiler may have been retired: pick the current one for the language.
    try {
      const lr = await timedFetch(real, "https://wandbox.org/api/list.json", {}, 30000);
      const list = lr.ok ? await lr.json() : [];
      const alt = list.find((c) => c.language === wbLang && !/head/i.test(c.name));
      if (alt && alt.name !== compiler) r = await post(alt.name);
    } catch (e) {}
  }
  if (!r.ok) return { unavailable: "Wandbox returned HTTP " + r.status };
  let d;
  try { d = await r.json(); } catch (e) { return { unavailable: "Wandbox returned an unexpected response" }; }
  const po = String(d.program_output || ""), pe = String(d.program_error || "");
  const ce = String(d.compiler_error || ""), status = Number(d.status || 0);
  if (!po && !pe && ce && status !== 0) return { text: "Compilation failed:\n" + ce.trim() };
  let text = [po.replace(/\s+$/, ""), pe.trim() ? (po.trim() ? "stderr:\n" : "") + pe.trim() : ""].filter(Boolean).join("\n") || "(ran, no output)";
  if (d.signal) text += "\n(stopped by signal " + d.signal + (/kill/i.test(d.signal) ? " - probably the run-time limit" : "") + ")";
  else if (status) text += "\n(exit code " + status + ")";
  return { text };
}

async function runRemote(language, code, stdin) {
  const ce = CE_LANGS[language];
  if (ce) {
    let res = await ceRun(ce, code, stdin);
    if (res.notFound) {
      const id = await ceResolve(ce).catch(() => null);
      res = id && id !== ce.id ? await ceRun({ ...ce, id }, code, stdin) : { notFound: true };
      if (res.notFound) res = { unavailable: "the " + language + " compiler is no longer offered by Compiler Explorer" };
    }
    if (res.text != null) return res.text;
    if (ce.wb) {
      const wb = await wbRun(ce.wb, null, code, stdin, ce.fix);
      if (wb.text != null) return wb.text + "\n(ran on Wandbox: " + res.unavailable + ")";
      return "Could not run " + language + ": " + res.unavailable + ", and the Wandbox fallback failed too (" + wb.unavailable + "). This is a temporary service outage, not a problem with the code. Retry later, or solve it in python or javascript now.";
    }
    return "Could not run " + language + ": " + res.unavailable + ". This is a temporary service outage, not a problem with the code. Retry later, or solve it in python or javascript now.";
  }
  const wbSpec = WB_LANGS[language];
  const wb = await wbRun(wbSpec.compiler, wbSpec.wbLang, code, stdin, wbSpec.fix);
  if (wb.text != null) return wb.text;
  return "Could not run " + language + ": " + wb.unavailable + ". " + language + " runs on Wandbox, a free public service that is currently failing. This is not a problem with the code. Use python or javascript instead.";
}

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------
async function run_code(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  try {
    return await runCodeInner(params || {}, userSettings || {}, resources || {}, ctx);
  } catch (e) {
    return finish("Code Runner failed before the code could finish: " + (e && e.message || e) + "\nRetry the call; if it fails again, try a simpler program.", ctx);
  }
}

async function runCodeInner(params, userSettings, resources, ctx) {
  const cfg = readSettings(userSettings);
  applyNetSettings(cfg);
  globalThis.__crNetLog = new Map();
  if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources.previousRunOutput));

  const language = normalizeLanguage(params.language);
  const code = typeof params.code === "string" ? params.code : params.code == null ? "" : String(params.code);
  if (!code.trim()) return finish("No code was provided. Put the complete program in `code`.", ctx);
  if (!language) return finish("Unsupported language \"" + params.language + "\". Supported: " + ALL_LANGS.join(", ") + ".", ctx);
  const stdin = params.stdin == null ? "" : String(params.stdin);

  if (!LOCAL_LANGS.includes(language)) {
    // Remote languages never touch /workspace: the carried state passes through unchanged.
    return finish(await runRemote(language, code, stdin), ctx);
  }

  const timeoutS = Math.min(Math.max(Number(params.timeout) > 0 ? Number(params.timeout) : cfg.execTimeoutS, 5), 900);
  let restored = null;
  if (ctx.incoming) {
    try { restored = await restoreSnapshot(ctx.incoming); }
    catch (e) {
      ctx.notes.push("files from earlier calls are gone: " + (e.message || e) + ". /workspace started empty - recreate anything this code needs");
      ctx.incoming = null;
    }
  }

  const engine = createEngine({ noWorker: globalThis.__crNoWorker });
  try {
    const mode = await engine.ready();
    const init = await engine.call({
      op: "init",
      cfg: {
        corsProxy: cfg.corsProxy,
        fetchTimeoutMs: cfg.fetchTimeoutMs,
        pyodideCdns: cdnCandidates(PYODIDE_CDNS, cfg.pyodideCdn),
        sqljsCdns: cdnCandidates(SQLJS_CDNS, cfg.sqljsCdn),
        babelCdns: BABEL_CDNS
      },
      files: restored ? restored.files : [],
      kv: restored ? restored.kv : {},
      hosts: hostHealthSnapshot()
    }, { timeoutMs: 60000 });
    if (!init.ok) return finish("Code Runner could not start: " + (init.error || "unknown error") + ". Retry the call.", ctx);

    let head = "", tail = "", dropped = 0;
    const onEvent = (m) => { if (m.ev === "out") head += m.s; else if (m.ev === "tail") { tail = m.s; dropped = m.dropped; } };
    const res = await engine.call({ op: "run", lang: language, code, packages: params.packages, stdin },
      { onEvent, timeoutMs: RUNTIME_TIMEOUT_MS + 2 * SCRIPT_TIMEOUT_MS, execTimeoutMs: mode === "worker" ? timeoutS * 1000 : 0 });
    if (res && res.tail != null) { tail = res.tail; dropped = res.dropped || 0; }
    const outputText = () => {
      if (!dropped) return head;
      const omitted = dropped - tail.length;
      return head + (omitted > 0 ? "\n\n[... " + omitted + " characters of output omitted ...]\n\n" : "") + tail;
    };

    if (res.timedOut) {
      const why = res.phase === "run"
        ? "stopped after the " + timeoutS + " s time limit (infinite loop, or too much work for one call)"
        : "stopped: the runtime did not finish loading in time (slow or blocked network)";
      return finish(outputText() + "\n\n(" + why + ". Changes to /workspace made during this call were discarded; files from before it are still there. Pass a larger `timeout`, or process less per call.)", ctx);
    }
    if (res.crashed) {
      return finish(outputText() + "\n\n(" + res.error + ". Changes to /workspace made during this call were discarded. Process the data in smaller pieces.)", ctx);
    }

    for (const [h, why] of res.netLog || []) netNote(h, why);
    mergeHosts(res.hosts);
    let out = outputText();
    if (res.error) out = out.replace(/\s+$/, "") + (out.trim() ? "\n" : "") + res.error;
    for (const n of res.notes || []) ctx.notes.push(n);

    if (!cfg.carry) return finish(out, ctx, null);
    const snap = await engine.call({ op: "snapshot" }, { timeoutMs: 60000 });
    if (!snap.ok) {
      ctx.notes.push("the workspace could not be saved for the next call (" + (snap.error || "snapshot failed") + ")");
      return finish(out, ctx);
    }
    const trailer = await buildTrailer(snap, cfg, ctx.notes);
    return finish(out, ctx, trailer);
  } finally {
    engine.terminate();
  }
}

// ---------------------------------------------------------------------------
// serve_file: render a /workspace file for the user (render_markdown output).
// The carried state passes through in an invisible HTML comment.
// ---------------------------------------------------------------------------
const MIME_BY_EXT = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", geojson: "application/json", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  toml: "text/plain", ini: "text/plain", html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", py: "text/x-python", sql: "text/plain",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  sqlite: "application/x-sqlite3", db: "application/x-sqlite3", parquet: "application/octet-stream",
  bin: "application/octet-stream"
};
const FENCE_BY_EXT = { json: "json", geojson: "json", md: "markdown", csv: "csv", py: "python", js: "javascript", ts: "typescript", html: "html", css: "css", xml: "xml", yaml: "yaml", yml: "yaml", sql: "sql", toml: "toml" };

function extOf(name) { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i + 1).toLowerCase() : ""; }
function guessMime(name) { return MIME_BY_EXT[extOf(name)] || "application/octet-stream"; }
function relPath(path) {
  path = String(path == null ? "" : path).trim().replace(/\\/g, "/");
  if (path.startsWith(WORKDIR + "/")) path = path.slice(WORKDIR.length + 1);
  return path.replace(/^\/+/, "").replace(/^(\.\/)+/, "");
}
function mdEscape(s) { return String(s).replace(/([\\`*_\[\]()<>])/g, "\\$1"); }

function serveFinish(md, ctx) {
  return ctx.incoming ? md + "\n\n<!--[[cr-state:" + ctx.incoming + "]]-->" : md;
}

async function serve_file(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  try {
    const cfg = readSettings(userSettings);
    applyNetSettings(cfg);
    if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
    params = params || {};
    const path = params.path || params.file || params.filename;
    if (!path) return serveFinish("**serve_file:** no `path` was given. Pass the path of a file in /workspace, e.g. `report.csv`.", ctx);
    const rel = relPath(path);

    let snap = null;
    if (ctx.incoming) {
      try { snap = await restoreSnapshot(ctx.incoming); }
      catch (e) { return serveFinish("**serve_file:** the workspace could not be loaded (" + (e.message || e) + "). Recreate `" + rel + "` with run_code, then call serve_file right after.", ctx); }
    }
    const hit = snap && snap.files.find(([p]) => p === rel);
    if (!hit) {
      const names = snap ? snap.files.map(([p]) => p) : [];
      return serveFinish("**serve_file:** `" + rel + "` is not in /workspace. " +
        (names.length ? "Files available: " + names.slice(0, 40).map((n) => "`" + n + "`").join(", ") + "."
                      : "/workspace is empty - create the file with run_code first, in the call right before serve_file."), ctx);
    }
    const bytes = hit[1];
    const name = String(params.filename || rel.split("/").pop() || "file");
    const mime = String(params.mime || guessMime(name));
    const kb = Math.max(1, Math.ceil(bytes.length / 1024));
    const size = kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    if (bytes.length > SERVE_MAX_BYTES) {
      return serveFinish("**serve_file:** `" + rel + "` is " + size + ", too large to embed in the chat (limit " + (SERVE_MAX_BYTES >> 20) + " MB). Compress it (zip) or reduce it with run_code first.", ctx);
    }
    const dataURI = "data:" + mime + ";base64," + bytesToBase64(bytes);
    const link = "[Download " + mdEscape(name) + " (" + size + ")](" + dataURI + ")";
    const mode = String(params.as || "auto").toLowerCase();
    const isImage = /^image\//.test(mime);
    const isText = /^text\//.test(mime) || /^application\/(json|xml)$/.test(mime);

    let md;
    if (mode === "link") md = link;
    else if (mode === "image" || (mode === "auto" && isImage)) md = "![" + mdEscape(name) + "](" + dataURI + ")\n\n" + link;
    else if (mode === "text" || (mode === "auto" && isText && bytes.length <= 64 * 1024)) {
      const text = new TextDecoder().decode(bytes);
      const fence = text.includes("```") ? "~~~~" : "```";
      md = fence + (FENCE_BY_EXT[extOf(name)] || "") + "\n" + text.replace(/\s+$/, "") + "\n" + fence + "\n\n" + link;
    } else md = link;
    return serveFinish(md, ctx);
  } catch (e) {
    return serveFinish("**serve_file failed:** " + (e && e.message || e) + ". Retry, or recreate the file with run_code.", ctx);
  }
}

// ---------------------------------------------------------------------------
// Browser bridge (browser_run, browser_tabs)
// ---------------------------------------------------------------------------
// These two functions reach OUT of the sandboxed plugin iframe to a small
// companion Chrome extension (extension/ folder of this repository), which the
// user loads unpacked. The extension injects a content script into this very
// frame; we talk to it with window.postMessage and it drives chrome.tabs /
// chrome.scripting on our behalf. With no extension present the ping times out
// and we return install instructions instead of hanging.

const BROWSER_PING_MS = 800;
const BROWSER_CALL_MS = 20000;

function browserBridgeCall(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const id = "crb" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const onMsg = (e) => {
      const d = e && e.data;
      if (!d || d.__crbRes !== true || d.id !== id) return;
      settled = true;
      try { removeEventListener("message", onMsg); } catch (x) {}
      resolve(d.response || { ok: false, error: "empty response from the bridge" });
    };
    try { addEventListener("message", onMsg); } catch (x) { return resolve({ ok: false, error: "no window messaging in this runtime" }); }
    try { postMessage({ __crbReq: true, id, request }, "*"); }
    catch (x) { try { removeEventListener("message", onMsg); } catch (y) {} return resolve({ ok: false, error: "could not post to the bridge: " + (x && x.message || x) }); }
    setTimeout(() => {
      if (settled) return;
      try { removeEventListener("message", onMsg); } catch (x) {}
      resolve({ ok: false, error: "__timeout" });
    }, timeoutMs || BROWSER_CALL_MS);
  });
}

const BROWSER_INSTALL_HINT =
  "The Code Runner browser bridge extension is not responding, so tabs cannot be reached.\n" +
  "One-time setup (Chrome/Chromium, desktop):\n" +
  "1. Get this plugin's repository and open chrome://extensions .\n" +
  "2. Turn on \"Developer mode\" (top right).\n" +
  "3. Click \"Load unpacked\" and select the extension/ folder.\n" +
  "4. Make sure the extension is enabled, then reload the TypingMind tab and try again.\n" +
  "Note: it is Chrome-only and works on desktop, not mobile.";

async function browserReady(ctx) {
  const pong = await browserBridgeCall({ op: "ping" }, BROWSER_PING_MS);
  if (pong && pong.ok) return true;
  return false;
}

function browserFinish(md, ctx) {
  // Like serve_file: these tools never touch /workspace, so carry the incoming
  // state trailer straight through so interleaving them does not lose files.
  return ctx.incoming ? md + "\n\n[[cr-state:" + ctx.incoming + "]]" : md;
}

function browserPrelude(userSettings, resources) {
  const ctx = { incoming: null };
  try {
    const cfg = readSettings(userSettings || {});
    if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
  } catch (e) {}
  return ctx;
}

async function browser_run(params, userSettings, resources) {
  const ctx = browserPrelude(userSettings, resources);
  try {
    params = params || {};
    const code = typeof params.code === "string" ? params.code : params.code == null ? "" : String(params.code);
    if (!code.trim()) return browserFinish("**browser_run:** no `code` was given. Pass JavaScript to run in the tab, e.g. `return document.title;`.", ctx);
    if (!(await browserReady(ctx))) return browserFinish(BROWSER_INSTALL_HINT, ctx);

    const timeoutMs = Math.min(Math.max((Number(params.timeout) || 15) * 1000, 1000), 120000);
    const req = { op: "run", code, timeoutMs };
    if (params.tabId != null) req.tabId = Number(params.tabId);

    const r = await browserBridgeCall(req, timeoutMs + 4000);
    if (r.error === "__timeout") return browserFinish("**browser_run:** the tab did not answer in time. The script may be running an infinite loop, or the tab is busy. Try a smaller script or a larger `timeout`.", ctx);
    if (!r.ok) return browserFinish("**browser_run failed:** " + (r.error || "unknown error") + ".", ctx);

    let out = "tab " + r.tabId;
    out += "\n\nresult: " + (r.result === undefined ? "undefined" : r.result);
    if (r.logs && r.logs.length) out += "\n\nconsole:\n" + r.logs.join("\n");
    if (r.error) out += "\n\nerror: " + r.error;
    return browserFinish(out, ctx);
  } catch (e) {
    return browserFinish("**browser_run failed:** " + (e && e.message || e) + ".", ctx);
  }
}

async function browser_tabs(params, userSettings, resources) {
  const ctx = browserPrelude(userSettings, resources);
  try {
    params = params || {};
    const action = String(params.action || "list").toLowerCase();
    const map = { list: "tabs.list", activate: "tabs.activate", open: "tabs.open", close: "tabs.close", reload: "tabs.reload", navigate: "tabs.navigate" };
    const op = map[action];
    if (!op) return browserFinish("**browser_tabs:** unknown action \"" + params.action + "\". Use one of: " + Object.keys(map).join(", ") + ".", ctx);
    if (!(await browserReady(ctx))) return browserFinish(BROWSER_INSTALL_HINT, ctx);

    const req = { op };
    if (params.tabId != null) req.tabId = Number(params.tabId);
    if (params.url != null) req.url = String(params.url);
    if (params.active != null) req.active = !!params.active;
    if (params.allWindows != null) req.allWindows = !!params.allWindows;

    const r = await browserBridgeCall(req, BROWSER_CALL_MS);
    if (r.error === "__timeout") return browserFinish("**browser_tabs:** the extension did not answer in time. Reload the TypingMind tab and try again.", ctx);
    if (!r.ok) return browserFinish("**browser_tabs failed:** " + (r.error || "unknown error") + ".", ctx);

    if (op === "tabs.list") {
      const rows = (r.tabs || []).map((t) => "#" + t.id + (t.active ? " *" : "  ") + " " + (t.title || "(untitled)") + "  -  " + t.url);
      return browserFinish(rows.length ? "Open tabs (id, * = active):\n" + rows.join("\n") : "No tabs found.", ctx);
    }
    if (op === "tabs.close") return browserFinish("Closed tab " + r.closed + ".", ctx);
    if (op === "tabs.reload") return browserFinish("Reloaded tab " + r.tab + ".", ctx);
    const t = r.tab || {};
    return browserFinish((action === "open" ? "Opened" : action === "navigate" ? "Navigated" : "Activated") + " tab #" + t.id + ": " + (t.title || t.url || ""), ctx);
  } catch (e) {
    return browserFinish("**browser_tabs failed:** " + (e && e.message || e) + ".", ctx);
  }
}
