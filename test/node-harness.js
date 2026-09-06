const fs = require("fs");
const path = require("path");
const vm = require("vm");

// --- environment stubs so implementation.js runs in Node -------------------
const { loadPyodide } = require("pyodide");
const localIndex = path.dirname(require.resolve("pyodide")) + "/";
// Primary CDN "down": reject the first candidate so the fallback path is exercised.
const cdnLog = [];
globalThis.loadPyodide = async (opts) => {
  cdnLog.push(opts.indexURL);
  if (opts.indexURL.includes("cdn.jsdelivr.net")) throw new Error("simulated CDN outage");
  return loadPyodide({ indexURL: localIndex });
};
globalThis.initSqlJs = async (opts) => {
  const base = opts.locateFile("");
  cdnLog.push(base);
  if (base.includes("cdn.jsdelivr.net")) throw new Error("simulated CDN outage");
  return require("sql.js")({});
};

// Fake fetch: fails for "blocked.example" unless proxied; records calls.
const fetchLog = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  fetchLog.push(url);
  if (url.startsWith("https://blocked.example/")) throw new TypeError("Failed to fetch");
  return { ok: true, status: 200, text: async () => "fetched:" + url, json: async () => ({ url }) };
};

// Fake XMLHttpRequest (sync) to exercise the proxy-fallback patch.
const xhrLog = [];
class FakeXHR {
  open(method, url, async, user, pw) { this.method = method; this.url = url; this.async = async; this.headers = {}; this.status = 0; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) {
    xhrLog.push({ url: this.url, headers: { ...this.headers }, async: this.async });
    if (this.url.startsWith("https://blocked.example/")) { this.status = 0; throw new Error("NetworkError"); }
    this.status = 200; this.responseText = "xhr:" + this.url;
  }
}
globalThis.XMLHttpRequest = FakeXHR;
globalThis.crossOriginIsolated = false; // browser global pyodide-http imports

const src = fs.readFileSync(path.join(__dirname, "..", "implementation.js"), "utf8");
vm.runInThisContext(src + "\nglobalThis.run_code = run_code;", { filename: "implementation.js" });

let failures = 0;
function check(name, got, want) {
  const ok = typeof want === "function" ? want(got) : got === want;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "\n   got:  " + JSON.stringify(got) + "\n   want: " + JSON.stringify(want)));
  if (!ok) failures++;
}
let lastState = null;   // most recent [[cr-state:...]] trailer captured from run()
const STATE_RE = /\n\n\[\[cr-state:([A-Za-z0-9+/=]+)\]\]\s*$/;
async function run(language, code, extra = {}, settings = {}) {
  // Emulate TypingMind: feed the previous output back in as previousRunOutput.
  const resources = { previousRunOutput: run._prev };
  let out = await run_code({ language, code, ...extra }, settings, resources);
  run._prev = out;
  if (typeof out === "string") {
    const m = STATE_RE.exec(out);
    lastState = m ? m[1] : null;
    out = out.replace(STATE_RE, "");
  }
  return out;
}
run._prev = undefined;
globalThis.run_code = run_code;
// serve_file returns render_markdown; TypingMind stores that string as
// previousRunOutput, so feed it back like run() does.
const COMMENT_RE = /<!--\[\[cr-state:([A-Za-z0-9+/=]+)\]\]-->/;
async function serve(params, settings = {}) {
  const resources = { previousRunOutput: run._prev };
  const out = await serve_file(params, settings, resources);
  run._prev = out;   // carry chain continues through serve_file
  return out;
}
// Simulate a brand-new sandbox iframe: wipe all in-memory state, keep only the
// previous output (which run._prev already holds), exactly like TypingMind.
function freshSandbox() {
  for (const k of Object.keys(globalThis)) if (k.startsWith("__cr") || k === "__py" || k === "__pyLoading" || k === "__sqljs" || k === "__sqlBytes" || k === "__sqlSynced" || k === "__pyHttpNote") delete globalThis[k];
}

(async () => {
  // 1. SQL persists across calls BEFORE Pyodide exists
  check("sql create", await run("sql", "CREATE TABLE t(a INT); INSERT INTO t VALUES (1),(2);"), "(statement ran, no rows returned)");
  check("sql select persisted", await run("sql", "SELECT SUM(a) AS s FROM t;"), "s\n3");
  check("sql error keeps db", await run("sql", "INSERT INTO t VALUES (3); SELECT * FROM nope;"), (s) => s.startsWith("SQL error:"));
  check("sql partial statements before error persisted", await run("sql", "SELECT COUNT(*) AS n FROM t;"), "n\n3");

  // 2. JS storage + fetch + proxy fallback (no Pyodide needed)
  check("js storage set", await run("javascript", "storage.set('k', {v: 42}); console.log('ok')"), "ok");
  check("js storage get later", await run("javascript", "console.log(storage.get('k').v)"), "42");
  check("js fetch direct", await run("javascript", "const r = await fetch('https://api.example/x'); console.log(await r.text())"), "fetched:https://api.example/x");
  check("js fetch blocked, no proxy -> error", await run("javascript", "await fetch('https://blocked.example/y')"), (s) => s.includes("Failed to fetch"));
  check("js fetch blocked, proxy fallback", await run("javascript", "const r = await fetch('https://blocked.example/y'); console.log(await r.text())", {}, { corsProxy: "https://proxy.example/?url=" }),
    "fetched:https://proxy.example/?url=" + encodeURIComponent("https://blocked.example/y"));
  check("js fetch proxy with {url} placeholder", await run("javascript", "const r = await fetch('https://blocked.example/z'); console.log(await r.text())", {}, { corsProxy: "https://p.example/{url}/raw" }),
    "fetched:https://p.example/" + encodeURIComponent("https://blocked.example/z") + "/raw");
  check("js fetch direct never proxied", fetchLog.filter((u) => u.includes("proxy.example") && u.includes("api.example")).length, 0);

  // 3. XHR sync fallback: simulate Python-side sync XHR while a run is active
  check("xhr sync fallback during run", await run("javascript",
    "const x = new XMLHttpRequest(); x.open('GET', 'https://blocked.example/q', false); x.setRequestHeader('X-A', '1'); x.send(null); console.log(x.responseText)",
    {}, { corsProxy: "https://proxy.example/?url=" }),
    "xhr:https://proxy.example/?url=" + encodeURIComponent("https://blocked.example/q"));
  check("xhr headers replayed on proxied retry", xhrLog[xhrLog.length - 1].headers["X-A"], "1");
  check("xhr sync fallback without proxy throws", await run("javascript",
    "const x = new XMLHttpRequest(); x.open('GET', 'https://blocked.example/q', false); x.send(null);"), (s) => s.includes("NetworkError"));
  check("xhr async untouched", await run("javascript",
    "const x = new XMLHttpRequest(); x.open('GET', 'https://blocked.example/q', true); try { x.send(null) } catch (e) { console.log('direct-only') }", {}, { corsProxy: "https://proxy.example/?url=" }), "direct-only");
  check("xhr outside a run untouched", (() => { const x = new XMLHttpRequest(); x.open("GET", "https://blocked.example/o", false); try { x.send(null); return "threw"; } catch (e) { return "threw"; } })(), "threw");
  check("xhr run counter back to zero", globalThis.__crRunning, 0);

  // 4. Python: workspace, cwd, persistence, urllib patch, requests importable
  check("python cwd is workspace", await run("python", "import os; print(os.getcwd())"), "/workspace");
  check("python write file", await run("python", "open('note.txt','w').write('hello'); print('w')"), "w");
  check("python read file next call", await run("python", "print(open('/workspace/note.txt').read())"), "hello");
  check("python urllib patched by pyodide-http", await run("python", "import urllib.request, pyodide_http; print(urllib.request.urlopen.__module__)"), (s) => s.includes("pyodide_http"));
  check("python requests importable", await run("python", "import requests; print(requests.__version__)"), "2.32.4");
  check("python chdir away, next run back in workspace", await run("python", "import os; os.chdir('/tmp'); print(os.getcwd())"), "/tmp");
  check("python cwd restored", await run("python", "import os; print(os.getcwd())"), "/workspace");

  // 5. SQL mirrored to /workspace/data.sqlite once Pyodide exists; Python can read and write it
  check("sql after pyodide load still has data", await run("sql", "SELECT COUNT(*) AS n FROM t;"), "n\n3");
  check("python reads sqlite file", await run("python", "import sqlite3; c = sqlite3.connect('/workspace/data.sqlite'); print(c.execute('select sum(a) from t').fetchone()[0])"), "6");
  check("python writes sqlite file", await run("python", "import sqlite3; c = sqlite3.connect('data.sqlite'); c.execute('insert into t values (100)'); c.commit(); c.close(); print('ins')"), "ins");
  check("sql sees python insert", await run("sql", "SELECT COUNT(*) AS n, MAX(a) AS m FROM t;"), "n | m\n4 | 100");

  // 6. JS fs shares the same workspace
  check("js fs readFile python file", await run("javascript", "console.log(await fs.readFile('note.txt'))"), "hello");
  check("js fs writeFile", await run("javascript", "await fs.writeFile('from_js.json', JSON.stringify({a:1})); console.log(await fs.readdir('/workspace'))"), (s) => s.includes("from_js.json") && s.includes("note.txt") && s.includes("data.sqlite"));
  check("python reads js file", await run("python", "import json; print(json.load(open('from_js.json'))['a'])"), "1");
  check("js fs exists/unlink/stat", await run("javascript", "await fs.appendFile('note.txt', '!'); const st = await fs.stat('note.txt'); await fs.unlink('from_js.json'); console.log(await fs.exists('from_js.json'), st.size, await fs.readFile('note.txt'))"), "false 6 hello!");
  check("js fs binary", await run("javascript", "await fs.writeFile('b.bin', new Uint8Array([1,2,3])); const b = await fs.readFile('b.bin', 'binary'); console.log(b.length, b[2])"), "3 3");

  // 7. Deleting data.sqlite resets the SQL database
  check("python deletes db file", await run("python", "import os; os.remove('data.sqlite'); print('rm')"), "rm");
  check("sql starts fresh after delete", await run("sql", "SELECT name FROM sqlite_master;"), "(statement ran, no rows returned)");
  check("sql fresh db usable", await run("sql", "CREATE TABLE u(x); INSERT INTO u VALUES (7); SELECT x FROM u;"), "x\n7");

  // 8. CDN fallback picked the second candidate after the primary failed
  check("pyodide fell back to fastly", globalThis.__crPyodideCdnUsed, "https://fastly.jsdelivr.net/pyodide/v0.29.4/full/");
  check("sql.js fell back to fastly", globalThis.__crSqljsCdnUsed, "https://fastly.jsdelivr.net/npm/sql.js@1.13.0/dist/");
  check("primary tried first for both", cdnLog.filter((u) => u.includes("cdn.jsdelivr.net")).length, 2);
  check("custom cdn setting goes first", await (async () => {
    const saved = globalThis.__sqljs; globalThis.__sqljs = null;
    await run("sql", "SELECT 1;", {}, { sqljsCdn: "https://mirror.example/sqljs" });
    const used = globalThis.__crSqljsCdnUsed; globalThis.__sqljs = saved; return used; })(), "https://mirror.example/sqljs/");

  // 9. Existing behaviour intact
  check("python error", await run("python", "1/0"), (s) => s.startsWith("Python error:") && s.includes("ZeroDivisionError"));
  check("empty output message", await run("python", "x = 1"), "(no output - did you print the result?)");
  check("js object logging", await run("javascript", "console.log({a: [1, 2]}); return 5"), '{"a":[1,2]}\n5');
  check("unsupported language", await run("cobol", "x").catch((e) => e.message), "Unsupported language: cobol");

  // 10. State carry across a simulated fresh sandbox (TypingMind's real model)
  run._prev = undefined; freshSandbox();
  await run("python", "open('carry.txt','w').write('kept'); import os; print(os.listdir('/workspace'))");
  check("state trailer emitted", typeof lastState === "string" && lastState.length > 0, true);
  freshSandbox();   // next call starts in a brand-new iframe
  check("python file survives fresh sandbox", await run("python", "print(open('carry.txt').read())"), "kept");
  freshSandbox();
  check("cwd still workspace after carry", await run("python", "import os; print(os.getcwd())"), "/workspace");

  run._prev = undefined; freshSandbox();
  await run("sql", "CREATE TABLE c(x); INSERT INTO c VALUES (7);");
  freshSandbox();
  check("sql db survives fresh sandbox", await run("sql", "SELECT x FROM c;"), "x\n7");
  freshSandbox();
  check("python reads carried sql db", await run("python", "import sqlite3; print(sqlite3.connect('data.sqlite').execute('select x from c').fetchone()[0])"), "7");

  run._prev = undefined; freshSandbox();
  await run("javascript", "storage.set('tok', 'abc'); console.log('set')");
  freshSandbox();
  check("js storage survives fresh sandbox", await run("javascript", "console.log(storage.get('tok'))"), "abc");

  run._prev = undefined; freshSandbox();
  await run("sql", "CREATE TABLE d(x); INSERT INTO d VALUES (1);");
  freshSandbox();
  await run("python", "import os; os.remove('data.sqlite'); print('removed')");
  freshSandbox();
  check("deleted sql db stays gone across sandbox", await run("sql", "SELECT name FROM sqlite_master;"), "(statement ran, no rows returned)");

  run._prev = undefined; freshSandbox();
  await run("sql", "CREATE TABLE e(x); INSERT INTO e VALUES (2);");
  freshSandbox();
  await run("python", "import sqlite3; sqlite3.connect('data.sqlite').execute('select 1')");   // loads py, materializes db file
  freshSandbox();
  await run("python", "import os; os.remove('data.sqlite'); print('rm')");                      // db was a carried FILE here
  freshSandbox();
  check("deleted db (file path) stays gone", await run("sql", "SELECT name FROM sqlite_master;"), "(statement ran, no rows returned)");

  run._prev = undefined; freshSandbox();
  const big = await run("python", "import os; open('big.bin','wb').write(os.urandom(60000)); print('wrote')", {}, { stateLimitKB: 8 });
  check("oversized workspace warns instead of carrying", big, (s) => s.includes("wrote") && s.includes("not carried"));
  check("no trailer when over limit", lastState, null);

  run._prev = undefined; freshSandbox();
  await run("python", "open('x.txt','w').write('1'); print('a')", {}, { stateCarry: "off" });
  check("stateCarry off emits no trailer", lastState, null);

  // 11. serve_file: fetch-edit-serve style flow across fresh sandboxes
  run._prev = undefined; freshSandbox();
  await run("javascript", "await fs.writeFile('hello.txt', 'hi there'); console.log('wrote')");
  freshSandbox();
  let served = await serve({ path: "hello.txt" });
  check("serve_file text renders download link", served, (s) => s.includes("data:text/plain;base64,") && s.includes("Download hello.txt"));
  check("serve_file carries state (comment trailer)", COMMENT_RE.test(served), true);
  freshSandbox();
  check("workspace survived serve_file in the chain", await run("javascript", "console.log(await fs.readFile('hello.txt'))"), "hi there");

  run._prev = undefined; freshSandbox();
  // 1x1 PNG written as binary, then served inline as an image
  await run("javascript", "const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'; const bin=Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); await fs.writeFile('px.png', bin); console.log('img '+bin.length)");
  freshSandbox();
  served = await serve({ path: "px.png" });
  check("serve_file image renders inline", served, (s) => s.startsWith("![px.png](data:image/png;base64,") && s.includes("Download px.png"));

  freshSandbox();
  served = await serve({ path: "px.png", as: "link" });
  check("serve_file as=link is link only", served, (s) => s.startsWith("[Download px.png") && !s.startsWith("!"));

  run._prev = undefined; freshSandbox();
  const missing = await serve({ path: "nope.bin" }).catch((e) => "THROW:" + e.message);
  check("serve_file missing file throws clearly", missing, (s) => s.includes("not found in /workspace"));

  // 12. fetch hardening: timeout aborts, one retry, then proxy fallback
  run._prev = undefined; freshSandbox();
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://flaky.example/")) { attempts++; if (attempts < 2) throw new TypeError("Failed to fetch"); return { ok: true, status: 200, text: async () => "recovered" }; }
    return origFetch(input, init);
  };
  delete globalThis.__crFetchPatched; delete globalThis.__crRealFetch;
  check("fetch retries once then succeeds", await run("javascript", "const r = await fetch('https://flaky.example/x'); console.log(await r.text())"), "recovered");
  check("fetch retried exactly twice", attempts, 2);
  globalThis.fetch = origFetch;

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
