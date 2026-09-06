const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/";
const SQLJS_CDN   = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/";

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
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// Network. Requests go direct first. If the browser blocks one (CORS / network
// error) and the user configured a CORS proxy in the plugin settings, the same
// request is retried through the proxy. Nothing is proxied unless it failed.
// ---------------------------------------------------------------------------

function proxyUrl(url) {
  const p = globalThis.__crCorsProxy;
  if (!p || !/^https?:\/\//i.test(url)) return null;
  return p.includes("{url}") ? p.replace("{url}", encodeURIComponent(url)) : p + encodeURIComponent(url);
}

async function netFetch(input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  try { return await fetch(input, init); }
  catch (e) {
    const pu = proxyUrl(url);
    if (!pu) throw e;
    return fetch(pu, init);
  }
}

// Python's `requests`, `urllib` (via pyodide-http) and urllib3 use synchronous
// XMLHttpRequest. Give those the same direct-then-proxy behaviour. Only sync
// requests issued while run_code is executing are touched.
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
    let err = null;
    try { send.call(this, body); } catch (e) { err = e; }
    if (!err && this.status !== 0) return;
    const pu = proxyUrl(r.url);
    if (!pu) { if (err) throw err; return; }
    open.call(this, r.method, pu, false, r.user, r.pw);
    for (const [k, v] of r.headers) setHeader.call(this, k, v);
    return send.call(this, body);
  };
  P.__crPatched = true;
}

// ---------------------------------------------------------------------------
// Python (Pyodide)
// ---------------------------------------------------------------------------

async function getPyodide() {
  if (globalThis.__py) return globalThis.__py;
  if (!globalThis.__pyLoading) {
    globalThis.__pyLoading = (async () => {
      if (!globalThis.loadPyodide) await loadScript(PYODIDE_CDN + "pyodide.js");
      const py = await globalThis.loadPyodide({ indexURL: PYODIDE_CDN });
      py.FS.mkdirTree(WORKDIR);
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
  try { await py.loadPackagesFromImports(code); } catch (e) {}
  if (Array.isArray(packages) && packages.length) {
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    for (const p of packages) await micropip.install(p);
  }
  py.runPython("import os; os.makedirs('" + WORKDIR + "', exist_ok=True); os.chdir('" + WORKDIR + "')");
  const out = [];
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => out.push(s) });
  if (globalThis.__pyHttpNote && /urllib/.test(code)) out.push(globalThis.__pyHttpNote);
  let v;
  try { v = await py.runPythonAsync(code); }
  catch (e) { out.push("Python error:\n" + (e.message || e)); return out.join("\n").trim(); }
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
  } catch (e) { out.push("JavaScript error:\n" + (e.message || e)); }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// SQL (sql.js). The database image persists across calls for the session and is
// mirrored to /workspace/data.sqlite once Pyodide is loaded, so Python's sqlite3
// can read/write the same database.
// ---------------------------------------------------------------------------

async function getSqlJs() {
  if (!globalThis.__sqljs) {
    if (!globalThis.initSqlJs) await loadScript(SQLJS_CDN + "sql-wasm.js");
    globalThis.__sqljs = await globalThis.initSqlJs({ locateFile: (f) => SQLJS_CDN + f });
  }
  return globalThis.__sqljs;
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

async function run_code(params, userSettings) {
  const { language, code, packages } = params;
  if (!code || !code.trim()) throw new Error("No code was provided.");
  globalThis.__crCorsProxy = String((userSettings && userSettings.corsProxy) || "").trim();
  patchXHR();
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
  return out && out.length ? out : "(no output - did you print the result?)";
}
