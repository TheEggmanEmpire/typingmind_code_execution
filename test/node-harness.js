// Node harness: runs the real plugin code (in-thread engine, since Node has no
// Web Worker) against real Pyodide / sql.js / Babel, with every external service
// (CORS proxies, blob stores, Compiler Explorer, Wandbox) mocked. Each call runs
// in a simulated fresh sandbox, fed the previous output like TypingMind does.
//
//   cd test && npm i && node node-harness.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// --- runtimes ---------------------------------------------------------------
const { loadPyodide } = require("pyodide");
const pyIndex = path.dirname(require.resolve("pyodide")) + "/";
const cdnLog = [];
globalThis.loadPyodide = async (opts) => {
  cdnLog.push(opts.indexURL);
  if (opts.indexURL.includes("cdn.jsdelivr.net")) throw new Error("simulated CDN outage");
  return loadPyodide({ indexURL: pyIndex });
};
globalThis.initSqlJs = async (opts) => {
  cdnLog.push(opts.locateFile(""));
  return require("sql.js")({});
};
globalThis.Babel = require("@babel/standalone");

// --- network mocks ------------------------------------------------------------
const realFetch = globalThis.fetch;
let routes = [];
const hits = {};
const count = (k) => (hits[k] = (hits[k] || 0) + 1);
const hang = (init) => new Promise((_, rej) => {
  const sig = init && init.signal;
  if (!sig) return rej(new Error("no abort signal: this request would hang forever"));
  const abort = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
  if (sig.aborted) abort(); else sig.addEventListener("abort", abort);
});
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const MOCK_FETCH = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  for (const r of routes) { const res = await r(url, init); if (res !== undefined) return res; }
  if (/^https:\/\/((cdn|fastly|gcore|testingcf)\.jsdelivr\.net\/pyodide\/|pypi\.org\/|files\.pythonhosted\.org\/)/.test(url)) return realFetch(input, init);
  throw new TypeError("Failed to fetch");
};
globalThis.fetch = MOCK_FETCH;

// Blob stores: the custom Worker store and the public ones.
const store = new Map();
let storeSeq = 0;
routes.push(async (url, init) => {
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("https://store.test/store?key=")) {
    count("store:post"); const id = "s" + (++storeSeq);
    store.set("https://store.test/store/" + id, String(init.body)); return text("https://store.test/store/" + id, 201);
  }
  if (url.startsWith("https://store.test/store/")) {
    if (method === "DELETE") { count("store:delete"); store.delete(url); return text("deleted"); }
    return store.has(url) ? text(store.get(url)) : text("gone", 404);
  }
  if (url === "https://litterbox.catbox.moe/resources/internals/api.php") {
    if (globalThis.__litterDown) return text("down", 503);
    count("litter:post"); const blob = init.body.get("fileToUpload"); const id = "https://litter.catbox.moe/l" + (++storeSeq) + ".txt";
    store.set(id, await blob.text()); return text(id);
  }
  if (url.startsWith("https://litter.catbox.moe/")) return store.has(url) ? text(store.get(url)) : text("gone", 404);
  if (url === "https://api.pastes.dev/post") { if (globalThis.__litterDown) return text("down", 503); count("pastes:post"); const key = "p" + (++storeSeq); store.set("https://api.pastes.dev/" + key, String(init.body)); return text(JSON.stringify({ key }), 201); }
  if (url.startsWith("https://api.pastes.dev/")) return store.has(url) ? text(store.get(url)) : text("gone", 404);
  if (url === "https://dpaste.com/api/v2/") return text("blocked", 400);
});

// Websites and proxies.
routes.push(async (url, init) => {
  if (url.startsWith("https://open.example/")) return text("open:" + url);
  if (url.startsWith("https://files.test/data.bin")) return new Response(new Uint8Array([1, 2, 3, 250]), { headers: { "content-type": "application/octet-stream" } });
  if (url.startsWith("https://blocked.example/") || url.startsWith("https://wall.example/") || url.startsWith("https://github.com/") || url.startsWith("https://api.secure.example/")) {
    count("direct:" + new URL(url).host); throw new TypeError("Failed to fetch");
  }
  if (url.startsWith("https://slow.example/")) { count("direct:slow"); return hang(init); }
  if (url.startsWith("https://raw.githubusercontent.com/")) return text("raw:" + url);
  if (url.startsWith("https://proxy.test/?key=k&url=")) {
    const target = decodeURIComponent(url.slice("https://proxy.test/?key=k&url=".length));
    count("proxy:custom");
    const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
    if (target.includes("missing")) return text("not found upstream", 404, { "x-cr-proxy": "1" });
    return text("custom:" + target + (auth ? " auth=" + auth : ""), 200, { "x-cr-proxy": "1" });
  }
  if (url.startsWith("https://corsmirror.com/")) {
    count("proxy:public");
    if (url.includes("wall.example") || url.includes("slow.example")) return url.includes("slow.example") ? hang(init) : text("refused", 403);
    return text("public:" + decodeURIComponent(url.split("url=")[1] || ""));
  }
  if (/^https:\/\/(api\.allorigins\.win|api\.codetabs\.com|api\.cors\.lol|cors\.eu\.org|test\.cors\.workers\.dev)\//.test(url)) {
    count("proxy:public");
    if (url.includes("slow.example")) return hang(init);
    throw new TypeError("proxy down");
  }
});

// Compiler Explorer and Wandbox.
let ceLast = null, ceRetired = new Set(), ceDown = false, wbDown = false;
routes.push(async (url, init) => {
  const m = /^https:\/\/godbolt\.org\/api\/compiler\/([^/]+)\/compile$/.exec(url);
  if (m) {
    count("ce:compile");
    if (ceDown) return text("unavailable", 503);
    if (ceRetired.has(m[1])) return text("Not Found", 404);
    const req = JSON.parse(init.body); ceLast = { id: m[1], req };
    const src = req.source, stdin = req.options.executeParameters.stdin;
    if (src.includes("COMPILE_ERROR")) return text(JSON.stringify({ didExecute: false, code: -1, stderr: [{ text: "Build failed" }], buildResult: { code: 1, stderr: [{ text: "\x1b[01m<source>:1:5: error: boom\x1b[m" }] } }));
    if (src.includes("TIMEOUT")) return text(JSON.stringify({ didExecute: true, timedOut: true, code: 143, stdout: [{ text: "partial" }], stderr: [{ text: "Killed - processing time exceeded" }], buildResult: { code: 0 } }));
    return text(JSON.stringify({ didExecute: true, code: src.includes("EXIT3") ? 3 : 0, stdout: [{ text: "ran " + m[1] + (stdin ? " stdin=" + stdin.trim() : "") }], stderr: [], buildResult: { code: 0 } }));
  }
  const l = /^https:\/\/godbolt\.org\/api\/compilers\/([^?]+)/.exec(url);
  if (l) return text(JSON.stringify([
    { id: "cgtrunk", name: "x86-64 gcc (trunk)", supportsExecute: true },
    { id: "cg171", name: "x86-64 gcc 17.1", semver: "17.1", supportsExecute: true },
    { id: "cg990", name: "x86-64 gcc 9.9", semver: "9.9", supportsExecute: true },
    { id: "armcg1", name: "ARM gcc 20.1", semver: "20.1", supportsExecute: false }
  ]));
  if (url === "https://wandbox.org/api/compile.json") {
    count("wb:compile");
    if (wbDown) return text("Error: Failed to get uid", 500);
    const req = JSON.parse(init.body);
    return text(JSON.stringify({ status: "0", program_output: "wb " + req.compiler + ": " + req.code.split("\n")[0] + "\n" }));
  }
  if (url === "https://wandbox.org/api/list.json") return text("[]");
});

// Sync XMLHttpRequest (urllib / pyodide-http path).
const xhrLog = [];
class FakeXHR {
  open(method, url, async) { this.method = method; this.url = url; this.async = async; this.headers = {}; this.status = 0; this.respHeaders = {}; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  overrideMimeType() {}
  getResponseHeader(k) { return this.respHeaders[k.toLowerCase()] || null; }
  send() {
    xhrLog.push({ url: this.url, headers: { ...this.headers } });
    if (/^https:\/\/(blocked|api\.secure)\.example\//.test(this.url)) { this.status = 0; throw new Error("NetworkError"); }
    if (this.url.startsWith("https://proxy.test/")) { this.status = 200; this.respHeaders["x-cr-proxy"] = "1"; this.responseText = "xhr-custom"; return; }
    if (this.url.startsWith("https://corsmirror.com/")) { this.status = 200; this.responseText = "xhr-public"; return; }
    if (/^https:\/\/(api\.allorigins|api\.codetabs|api\.cors\.lol|cors\.eu\.org|test\.cors)/.test(this.url)) { this.status = 0; throw new Error("NetworkError"); }
    this.status = 200; this.responseText = "xhr-direct";
  }
}
globalThis.XMLHttpRequest = FakeXHR;
globalThis.crossOriginIsolated = false;

// --- plugin ---------------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, "..", "implementation.js"), "utf8");
vm.runInThisContext(src + "\nglobalThis.run_code = run_code; globalThis.serve_file = serve_file; globalThis.__cr_packBytes = packBytes; globalThis.__cr_b64 = bytesToBase64;", { filename: "implementation.js" });

let prev;
function freshSandbox() {
  for (const k of Object.keys(globalThis)) if (k.startsWith("__cr") && !k.startsWith("__cr_")) delete globalThis[k];
  globalThis.fetch = MOCK_FETCH;
}
const STATE = /\[\[cr-state:([A-Za-z0-9+/=]+)\]\]/;
const strip = (s) => String(s).replace(/\n*(<!--)?\[\[cr-state:[A-Za-z0-9+/=]+\]\](-->)?\s*$/, "");
async function run(language, code, extra = {}, settings = {}) {
  freshSandbox();
  const out = await run_code({ language, code, ...extra }, settings, { previousRunOutput: prev });
  prev = out;
  return out;
}
async function serve(params, settings = {}) {
  freshSandbox();
  const out = await serve_file(params, settings, { previousRunOutput: prev });
  prev = out;
  return out;
}
let failures = 0, passes = 0;
function check(name, got, pred) {
  let ok = false;
  try { ok = typeof pred === "function" ? pred(strip(got), String(got)) : strip(got) === pred; } catch (e) { ok = false; }
  if (ok) passes++; else failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "\n   got: " + JSON.stringify(strip(got)).slice(0, 900)));
}
const big = { stateLimitKB: "500" };   // keep test workspaces inline unless a test is about offload

(async () => {
  // 1. Python --------------------------------------------------------------------
  check("python print + file", await run("python", "open('a.txt','w').write('hello')\nprint('wrote')", {}, big), "wrote");
  check("state trailer emitted", prev, (s, raw) => STATE.test(raw));
  check("python reads file from earlier call", await run("python", "print(open('a.txt').read())", {}, big), "hello");
  check("python cwd is /workspace", await run("python", "import os; print(os.getcwd())", {}, big), "/workspace");
  check("python stdin via input()", await run("python", "print(int(input()) + int(input()))", { stdin: "40\n2\n" }, big), "42");
  check("python input() without stdin explains", await run("python", "input()", {}, big), (s) => /EOFError/.test(s) && /stdin/.test(s));
  check("python traceback is cleaned", await run("python", "x = 1\n1/0", {}, big), (s) => /File "<code>", line 2/.test(s) && /ZeroDivisionError/.test(s) && !/_pyodide/.test(s));
  check("python last expression is printed", await run("python", "6*7", {}, big), "42");
  check("python missing file lists the workspace", await run("python", "open('nope.txt')", {}, big), (s) => /FileNotFoundError/.test(s) && /a\.txt \(5 B\)/.test(s));
  check("python unknown module gets a packages hint", await run("python", "import not_a_real_module_xyz", {}, big), (s) => /packages: \["not_a_real_module_xyz"\]/.test(s));
  // In a real browser connect() fails with "Host is unreachable"; Node's emscripten fakes success, so raise it.
  check("python socket failure gets a hint", await run("python", "raise OSError(23, 'Host is unreachable')", {}, big), (s) => /sockets and DNS do not exist/.test(s));
  check("python requests ships with pyodide", await run("python", "import requests\nprint(requests.__name__)", {}, big), "requests");
  check("python yaml installs automatically", await run("python", "import yaml\nprint(yaml.safe_dump({'a': 1}).strip())", {}, big), "a: 1");
  check("python matplotlib figure saved", await run("python", "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nprint('plotted')", {}, big),
    (s) => /^plotted/.test(s) && /figure_1\.png/.test(s) && /serve_file/.test(s));
  check("pyodide CDN fallback used fastly", cdnLog.includes("https://fastly.jsdelivr.net/pyodide/v0.29.4/full/"), (s, raw) => raw === "true");

  // 2. JavaScript / TypeScript -----------------------------------------------------
  check("js sees python files", await run("javascript", "console.log((await fs.readdir()).join(','))", {}, big), (s) => /a\.txt/.test(s) && /figure_1\.png/.test(s));
  check("js fs write/read/append/stat", await run("javascript",
    "await fs.writeFile('d/x.json', {a: 1}); await fs.appendFile('a.txt', '!'); const st = await fs.stat('a.txt');\nconsole.log(await fs.readJSON('d/x.json'), st.size, await fs.readFile('a.txt'), await fs.exists('d'))", {}, big),
    '{"a":1} 6 hello! true');
  check("js fs binary + rename + rm", await run("javascript",
    "await fs.writeFile('b.bin', new Uint8Array([9, 8])); await fs.rename('b.bin', 'c.bin'); const b = await fs.readFile('c.bin', 'binary'); await fs.rm('d', {recursive: true});\nconsole.log(b[0], b.length, await fs.exists('b.bin'), await fs.exists('d/x.json'))", {}, big),
    "9 2 false false");
  check("js fs.download", await run("javascript", "const d = await fs.download('https://files.test/data.bin'); console.log(d.path, d.size, (await fs.readFile('data.bin', 'binary'))[3])", {}, big), "/workspace/data.bin 4 250");
  check("python reads js binary file", await run("python", "print(list(open('c.bin','rb').read()))", {}, big), "[9, 8]");
  check("js return value + console.table", await run("javascript", "console.table([{a: 1, b: 2}]); return {ok: true}", {}, big), 'a | b\n1 | 2\n{"ok":true}');
  check("js error names the line", await run("javascript", "const x = 1;\nnull.foo;", {}, big), (s) => /TypeError/.test(s) && /\(at line 2\)/.test(s));
  check("js missing file lists the workspace", await run("javascript", "await fs.readFile('nope.txt')", {}, big), (s) => /ENOENT/.test(s) && /a\.txt/.test(s));
  check("js require gets a browser hint", await run("javascript", "require('fs')", {}, big), (s) => /not Node\.js/.test(s));
  check("js storage set", await run("javascript", "storage.set('k', {n: [1, 2]}); console.log('set')", {}, big), "set");
  check("js storage carried", await run("javascript", "console.log(storage.get('k').n[1])", {}, big), "2");
  check("js stdin", await run("javascript", "console.log(stdin.trim().toUpperCase())", { stdin: "abc\n" }, big), "ABC");
  check("js syntax error", await run("javascript", "const = 1", {}, big), (s) => /JavaScript syntax error/.test(s));
  check("typescript runs", await run("typescript", "interface P { x: number }\nconst p: P = { x: 5 };\nconsole.log(await Promise.resolve(p.x * 2))", {}, big), "10");
  check("typescript error reported", await run("typescript", "const x: = 5", {}, big), (s) => /^TypeScript error/.test(s));

  // 3. SQL -----------------------------------------------------------------------------
  check("sql create", await run("sql", "CREATE TABLE t(a INT); INSERT INTO t VALUES (1),(2),(3);", {}, big), (s) => /^\(ok/.test(s));
  check("sql select carried", await run("sql", "SELECT SUM(a) AS s FROM t;", {}, big), "s\n6");
  check("sql multiple results labelled", await run("sql", "SELECT 1 AS x; SELECT 2 AS y;", {}, big), (s) => /-- result 1\nx\n1/.test(s) && /-- result 2\ny\n2/.test(s));
  check("sql error keeps database", await run("sql", "INSERT INTO t VALUES (4); SELECT * FROM missing;", {}, big), (s) => /SQL error: no such table: missing/.test(s));
  check("python sees sql rows", await run("python", "import sqlite3\nprint(sqlite3.connect('data.sqlite').execute('select count(*) from t').fetchone()[0])", {}, big), "4");
  check("sql sees python writes", await run("python", "import sqlite3\nc = sqlite3.connect('data.sqlite'); c.execute('insert into t values (100)'); c.commit(); print('ins')", {}, big), "ins");
  check("sql max after python insert", await run("sql", "SELECT MAX(a) AS m FROM t;", {}, big), "m\n100");
  check("deleting data.sqlite resets sql", (await run("python", "import os; os.remove('data.sqlite'); print('rm')", {}, big), await run("sql", "SELECT name FROM sqlite_master;", {}, big)), "name\n(0 rows)");

  // 4. serve_file ------------------------------------------------------------------------
  check("serve_file text as code block", await serve({ path: "a.txt" }, big), (s) => /^```\nhello!\n```/.test(s) && /data:text\/plain;base64,/.test(s));
  check("serve_file keeps the state", prev, (s, raw) => /<!--\[\[cr-state:/.test(raw));
  check("serve_file image inline", await serve({ path: "/workspace/figure_1.png" }, big), (s) => s.startsWith("![figure\\_1.png](data:image/png;base64,"));
  check("serve_file as=link", await serve({ path: "c.bin", as: "link" }, big), (s) => /^\[Download c.bin \(1 KB\)\]\(data:application\/octet-stream;base64,/.test(s));
  check("serve_file missing file lists files", await serve({ path: "zzz.csv" }, big), (s) => /`zzz.csv` is not in \/workspace/.test(s) && /`a.txt`/.test(s));
  check("serve_file without path", await serve({}, big), (s) => /no `path` was given/.test(s));
  check("workspace survives serve_file", await run("python", "print(open('a.txt').read())", {}, big), "hello!");

  // 5. Network fallbacks -------------------------------------------------------------------
  const get = (u, opts = "") => "try { const r = await fetch('" + u + "'" + (opts ? ", " + opts : "") + "); console.log(r.status, await r.text()) } catch (e) { console.log('ERR', e.message) }";
  check("direct request", await run("javascript", get("https://open.example/x"), {}, big), "200 open:https://open.example/x");
  check("blocked -> public proxy", await run("javascript", get("https://blocked.example/a"), {}, big), "200 public:https://blocked.example/a");
  check("blocked -> personal proxy first", await run("javascript", get("https://blocked.example/b"), {}, { ...big, corsProxy: "https://proxy.test/?key=k&url=" }), "200 custom:https://blocked.example/b");
  check("personal proxy passes the target's 404 through", await run("javascript", get("https://blocked.example/missing"), {}, { ...big, corsProxy: "https://proxy.test/?key=k&url=" }), "404 not found upstream");
  check("github blob -> raw mirror", await run("javascript", get("https://github.com/o/r/blob/main/f.txt"), {}, big), "200 raw:https://raw.githubusercontent.com/o/r/main/f.txt");
  hits["proxy:public"] = 0;
  check("credentials never go to public proxies", await run("javascript", get("https://api.secure.example/x", "{ headers: { Authorization: 'Bearer t' } }"), {}, big),
    (s) => /never sent through public proxies/.test(s) && hits["proxy:public"] === 0);
  check("credentials may use the personal proxy", await run("javascript", get("https://api.secure.example/y", "{ headers: { Authorization: 'Bearer t' } }"), {}, { ...big, corsProxy: "https://proxy.test/?key=k&url=" }), "200 custom:https://api.secure.example/y auth=Bearer t");
  const wall = await run("javascript", get("https://wall.example/1"), {}, big);
  check("all routes fail: clear error", wall, (s) => /Could not reach wall\.example: the browser blocked it/.test(s) && /fallback routes failed/.test(s));
  check("all routes fail: network note + tip", wall, (s) => /\(network: wall\.example - /.test(s) && /companion CORS proxy/.test(s));
  hits["proxy:public"] = 0; hits["direct:wall.example"] = 0;
  check("dead host fails fast in the next call", await run("javascript", get("https://wall.example/2"), {}, big), (s) => /still unreachable/.test(s) && hits["direct:wall.example"] === 1 && hits["proxy:public"] <= 3);
  hits["direct:slow"] = 0;
  const t0 = Date.now();
  check("silent host times out quickly", await run("javascript", get("https://slow.example/x"), {}, { ...big, fetchTimeoutMs: "100" }), (s) => /no response within 0\.1 s/.test(s) && Date.now() - t0 < 3000 && hits["direct:slow"] === 1);
  const xhr = (u, h = "") => "const x = new XMLHttpRequest(); x.open('GET', '" + u + "', false); " + h + " try { x.send(null); console.log(x.status, x.responseText) } catch (e) { console.log('ERR', e.message) }";
  check("sync XHR blocked -> public proxy", await run("javascript", xhr("https://blocked.example/q"), {}, big), "200 xhr-public");
  check("sync XHR blocked -> personal proxy", await run("javascript", xhr("https://blocked.example/r"), {}, { ...big, corsProxy: "https://proxy.test/?key=k&url=" }), "200 xhr-custom");
  xhrLog.length = 0;
  check("sync XHR with credentials not proxied publicly", await run("javascript", xhr("https://api.secure.example/q", "x.setRequestHeader('Authorization', 'Bearer t');"), {}, big),
    (s) => /^ERR/.test(s) && xhrLog.every((r) => !/corsmirror|allorigins|codetabs|cors\.lol|cors\.eu|workers\.dev/.test(r.url)));

  // 6. Persistence: offload, reuse, drop -----------------------------------------------------
  prev = undefined;
  const small = { stateLimitKB: "1", workspaceStore: "https://store.test/store?key=k" };
  hits["store:post"] = 0; hits["store:delete"] = 0;
  check("large workspace offloaded to the private store", await run("python", "import os; open('big.bin','wb').write(os.urandom(8000)); print('w')", {}, small),
    (s, raw) => s === "w" && hits["store:post"] === 1 && raw.length < 600);
  check("restored from the private store", await run("python", "import os; print(os.path.getsize('big.bin'))", {}, small), "8000");
  check("unchanged workspace is not uploaded again", hits["store:post"], (s, raw) => raw === "1");
  check("changed workspace uploads and deletes the old copy", (await run("python", "open('n.txt','w').write('x'); print('w')", {}, small), hits["store:post"] + "/" + hits["store:delete"]), (s, raw) => raw === "2/1");
  hits["litter:post"] = 0;
  const pub = { stateLimitKB: "1" };
  check("no private store -> public temporary store", await run("python", "import os; open('big2.bin','wb').write(os.urandom(9000)); print('w')", {}, pub), (s) => s === "w" && hits["litter:post"] === 1);
  check("restored from the public store", await run("python", "import os; print(sorted(os.listdir('.')))", {}, pub), (s) => /big2\.bin/.test(s) && /big\.bin/.test(s));
  globalThis.__litterDown = true;
  check("stores down: largest files dropped and named", await run("python", "open('tiny.txt','w').write('t'); print('w')", {}, { stateLimitKB: "8", bigWorkspace: "on" }),
    (s) => /too large to keep/.test(s) && /big2\.bin/.test(s) && /the other files are kept/.test(s));
  globalThis.__litterDown = false;
  check("small files survived the drop", await run("python", "print(open('tiny.txt').read(), open('a.txt').read() if __import__('os').path.exists('a.txt') else '-')", {}, { stateLimitKB: "8" }), (s) => /^t /.test(s));
  prev = undefined;
  await run("python", "import os; open('e.bin','wb').write(os.urandom(6000)); print('w')", {}, small);
  const now0 = Date.now; Date.now = () => now0() + 25 * 60 * 60 * 1000;
  check("expired offloaded workspace is reported", await run("python", "import os; print(os.listdir('.'))", {}, small), (s) => /files from earlier calls are gone: the saved workspace expired/.test(s));
  Date.now = now0;

  // v1 trailers from the previous plugin version are still read.
  const v1 = { v: 1, files: [["old.txt", Buffer.from("legacy").toString("base64")]], kv: { a: 1 }, sql: null };
  prev = "old output\n\n[[cr-state:" + __cr_b64(await __cr_packBytes(new TextEncoder().encode(JSON.stringify(v1)))) + "]]";
  check("v1 trailer restores files", await run("python", "print(open('old.txt').read())", {}, big), "legacy");
  prev = "old output\n\n[[cr-state:" + __cr_b64(await __cr_packBytes(new TextEncoder().encode(JSON.stringify(v1)))) + "]]";
  check("v1 trailer restores storage", await run("javascript", "console.log(storage.get('a'))", {}, big), "1");
  prev = "junk [[cr-state:AAAA]]";
  check("damaged trailer is reported, run continues", await run("python", "print('still runs')", {}, big), (s) => /^still runs/.test(s) && /damaged/.test(s));

  // 7. Remote languages ------------------------------------------------------------------------
  prev = undefined;
  await run("python", "open('keep.txt','w').write('k'); print('w')", {}, big);
  check("c runs with stdin", await run("c", "int main(){}", { stdin: "5\n" }, big), "ran cg162 stdin=5");
  check("remote call keeps the workspace", await run("python", "print(open('keep.txt').read())", {}, big), "k");
  await run("java", "public class Main { public static void main(String[] a) {} }", {}, big);
  check("java public class accepted", ceLast.req.source, (s, raw) => raw.startsWith("class Main"));
  check("compile error formatted", await run("rust", "COMPILE_ERROR", {}, big), (s) => s === "Compilation failed:\ncode:1:5: error: boom");
  check("remote timeout explained", await run("go", "TIMEOUT", {}, big), (s) => /^partial/.test(s) && /run-time limit/.test(s) && !/Killed/.test(s));
  check("exit code reported", await run("c++", "EXIT3", {}, big), (s) => /\(exit code 3\)/.test(s));
  ceRetired.add("cg162");
  check("retired compiler replaced by a current one", await run("c", "int main(){}", {}, big), "ran cg171");
  ceRetired.clear(); ceDown = true;
  check("Compiler Explorer down -> Wandbox", await run("ruby", "puts 1", {}, big), (s) => /^wb ruby-4\.0\.2: puts 1/.test(s) && /ran on Wandbox/.test(s));
  wbDown = true;
  check("both down: not the code's fault", await run("ruby", "puts 1", {}, big), (s) => /temporary service outage, not a problem with the code/.test(s));
  ceDown = false;
  check("wandbox-only language down", await run("php", "echo 1;", {}, big), (s) => /Wandbox/.test(s) && /Use python or javascript/.test(s));
  wbDown = false;
  check("php gets <?php added", await run("php", "echo 1;", {}, big), (s) => /^wb php-8\.3\.12: <\?php/.test(s));
  check("language aliases", await run("cpp", "int main(){}", {}, big), "ran g162");

  // 8. Never throws, always explains --------------------------------------------------------------
  check("null params", await run_code(null, null, null), (s) => /No code was provided/.test(s));
  check("unsupported language", await run("brainfuck", "+", {}, big), (s) => /Unsupported language "brainfuck"/.test(s) && /python/.test(s));
  check("empty code", await run("python", "  ", {}, big), (s) => /No code was provided/.test(s));
  check("output is capped", await run("python", "for i in range(30000): print('line', i)", {}, big),
    (s) => /characters of output omitted/.test(s) && /line 29999/.test(s) && s.length < 42000);
  check("runtime download failure is explained", await (async () => {
    const saved = globalThis.loadPyodide; globalThis.loadPyodide = async () => { throw new Error("offline"); };
    const out = await run("python", "print(1)", {}, big);
    globalThis.loadPyodide = saved; return out;
  })(), (s) => /Could not download the Python runtime from any CDN/.test(s) && /offline/.test(s));
  check("state survives a failed runtime download", prev, (s, raw) => STATE.test(raw));

  console.log("\n" + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
