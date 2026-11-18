// End to end: the real server process, a real MCP client over Streamable HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-e2e-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = "http://127.0.0.1:" + port;
const KEY = "e2e-key-0123456789abcdef";
let proc, log = "";
// A stand-in OmniRoute for the omniroute tool.
import http from "node:http";
const omniPort = port + 1;
const omniSeen = [];
const omni = http.createServer((req, res) => {
  let b = []; req.on("data", (d) => b.push(d)); req.on("end", () => {
    const body = Buffer.concat(b).toString("utf8");
    omniSeen.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url.endsWith("/audio/speech")) {
      if (body.includes("cooling")) { res.writeHead(429, { "retry-after": "109" }); return res.end("credentials_cooling: 1"); }
      res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end(Buffer.from("ID3fakeaudio"));
    }
    if (req.url.endsWith("/audio/transcriptions")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ text: "hello world" })); }
    if (req.url.endsWith("/embeddings")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] })); }
    res.writeHead(404); res.end("no route");
  });
});

async function client(headers = {}) {
  const c = new Client({ name: "e2e", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + KEY, ...headers } } }));
  return c;
}
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = async (c, name, args) => c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });

function boot() {
  return spawn(process.execPath, ["src/index.js"], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MCP_API_KEY: KEY, PUBLIC_URL: base, WAIT_BUDGET_S: "5", CODE_SECRETS: "E2E_TOKEN=supersecretvalue123", REA: "0", OMNIROUTE_API_KEY: "omni-test-key-123", OMNIROUTE_BASE_URL: "http://127.0.0.1:" + omniPort + "/api/v1", OMNIROUTE_ENDPOINTS: "speech,transcribe,embeddings" }, stdio: ["ignore", "pipe", "pipe"] });
}
async function start() {
  proc = boot();
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start:\n" + log);
}
before(async () => { await new Promise((r) => omni.listen(omniPort, "127.0.0.1", r)); await start(); });
after(() => { omni.close(); proc && proc.kill("SIGTERM"); fs.rmSync(dataDir, { recursive: true, force: true }); });

test("health reports an active sandbox", async () => {
  const h = await (await fetch(base + "/health")).json();
  assert.equal(h.ok, true);
  assert.notEqual(h.sandbox, "unavailable", log);
  assert.ok(h.languages.includes("python"));
});

test("requests without the key are refused", async () => {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 401);
});

test("tools are listed with instructions", async () => {
  const c = await client();
  const { tools } = await c.listTools();
  for (const n of ["run_code", "job", "schedule", "serve_file", "preview_file", "manage_files", "make_image", "edit_image", "browser_state", "browser_act", "browser_run", "browser_tabs"]) assert.ok(tools.some((t) => t.name === n), n);
  assert.match(c.getInstructions() || "", /Code Runner/);
});

test("python keeps variables and files across separate requests; secrets are redacted", async () => {
  const c1 = await client();
  let r = await call(c1, "run_code", { language: "python", code: "x = 41\nopen('note.txt','w').write('hello')\nimport os\nprint(os.environ['E2E_TOKEN'])" });
  assert.match(textOf(r), /\[secret E2E_TOKEN\]/);
  assert.doesNotMatch(textOf(r), /supersecretvalue123/);
  assert.match(textOf(r), /note\.txt/);
  const c2 = await client();
  r = await call(c2, "run_code", { language: "python", code: "x + 1" });
  assert.match(textOf(r), /42/);
  r = await call(c2, "run_code", { language: "javascript", code: "const fs2 = await import('node:fs'); return fs2.readFileSync('note.txt','utf8')" });
  assert.match(textOf(r), /hello/);
});

test("the code cannot read the server's environment or key", async () => {
  const c = await client();
  const r = await call(c, "run_code", { language: "bash", code: "env | sort; cat /proc/$PPID/environ 2>&1 | tr '\\0' '\\n' | head -50" });
  assert.doesNotMatch(textOf(r), new RegExp(KEY));
  assert.doesNotMatch(textOf(r), /MCP_API_KEY/);
});

test("package installs are allowed and land in the workspace's hidden folder", async () => {
  const c = await client();
  const r = await call(c, "run_code", { language: "bash", code: "env | grep -E '^(PIP_|PYTHONUSERBASE|NPM_CONFIG_PREFIX)' | sort; python3 -m pip --version >/dev/null && echo pip-ok" });
  assert.match(textOf(r), /PIP_BREAK_SYSTEM_PACKAGES=1/);
  assert.match(textOf(r), /PYTHONUSERBASE=.*\.cr\/pyuser/);
  assert.match(textOf(r), /NPM_CONFIG_PREFIX=.*\.cr\/npm/);
});

test("workspaces are separate per user", async () => {
  const a = await client({ "X-User-ID": "alice" });
  const b = await client({ "X-User-ID": "bob" });
  await call(a, "run_code", { language: "bash", code: "echo private > a.txt" });
  const r = await call(b, "manage_files", { action: "list" });
  assert.doesNotMatch(textOf(r), /a\.txt/);
});

test("a long run becomes a job that can be followed", async () => {
  const c = await client();
  let r = await call(c, "run_code", { language: "bash", code: "for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 1; done; echo finished" });
  const m = /job\s+`?([a-z0-9]+)`?/i.exec(textOf(r));
  assert.ok(m, textOf(r));
  r = await call(c, "job", { action: "output", id: m[1], wait: 20 });
  assert.match(textOf(r), /finished/);
});

test("serve_file, preview_file and the upload page give working links", async () => {
  const c = await client();
  await call(c, "run_code", { language: "python", code: "open('t.csv','w').write('a,b\\n1,2\\n')" });
  let r = await call(c, "serve_file", { path: "t.csv", share: true });
  const urls = [...textOf(r).matchAll(/http:\/\/127\.0\.0\.1:\d+\/f\/[^\s)]+/g)].map((x) => x[0]);
  assert.ok(urls.length >= 2, textOf(r));
  let f = await fetch(urls[0]);
  assert.equal(f.status, 200);
  assert.equal(await f.text(), "a,b\n1,2\n");
  assert.match(f.headers.get("content-security-policy") || "", /sandbox/);
  r = await call(c, "preview_file", { path: "t.csv" });
  const p = /http:\/\/127\.0\.0\.1:\d+\/p\/[^\s)]+/.exec(textOf(r))[0];
  f = await fetch(p);
  assert.equal(f.status, 200);
  assert.match(await f.text(), /<html/i);
  // revoke the share
  await call(c, "manage_files", { action: "unshare", path: "t.csv" });
  assert.equal((await fetch(urls[urls.length - 1])).status, 403);
  // upload page
  r = await call(c, "manage_files", { action: "upload_link" });
  const w = /http:\/\/127\.0\.0\.1:\d+\/w\/[^\s)]+/.exec(textOf(r))[0];
  assert.equal((await fetch(w)).status, 200);
  const up = await fetch(w + "upload?name=in.txt", { method: "POST", body: "uploaded" });
  assert.equal(up.status, 200, await up.text());
  r = await call(c, "run_code", { language: "bash", code: "cat uploads/in.txt" });
  assert.match(textOf(r), /uploaded/);
  assert.equal((await fetch(base + "/f/forged.token/x")).status, 403);
});

test("a symlink planted by the code is not served", async () => {
  const c = await client();
  await call(c, "run_code", { language: "bash", code: "ln -s /etc/passwd leak.txt" });
  const r = await call(c, "serve_file", { path: "leak.txt", as: "text" });
  assert.doesNotMatch(textOf(r), /root:x:0/);
});

test("status, schedule and browser pairing answer sensibly", async () => {
  const c = await client();
  let r = await call(c, "manage_files", { action: "status" });
  assert.match(textOf(r), /Sandbox:/);
  r = await call(c, "schedule", { action: "create", name: "beat", language: "bash", code: "date >> beat.txt; echo ran", every_minutes: 5 });
  assert.match(textOf(r), /Created schedule beat/);
  r = await call(c, "schedule", { action: "run", name: "beat" });
  assert.match(textOf(r), /done/);
  r = await call(c, "run_code", { language: "bash", code: "cat schedules/beat.log" });
  assert.match(textOf(r), /ran/);
  r = await call(c, "schedule", { action: "delete", name: "beat" });
  r = await call(c, "browser_tabs", { action: "list" });
  assert.match(textOf(r), /pairing code [A-Z0-9-]+/i);
});

test("the tab list says it is complete, marks browser pages and names ignored parameters", async () => {
  const { default: WebSocket } = await import("ws");
  const c = await client({ "X-User-ID": "tabs-user" });
  const code = /pairing code ([A-Z0-9-]+)/i.exec(textOf(await call(c, "browser_tabs", {})))[1];
  const dev = await (await fetch(base + "/bridge/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "stand-in", version: "0.5.2" }) })).json();
  const ws = new WebSocket(base.replace("http", "ws") + "/bridge");
  let seen;
  await new Promise((res, rej) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", deviceId: dev.deviceId, token: dev.token, version: "0.5.2" })));
    ws.on("message", (m) => {
      const d = JSON.parse(m.toString());
      if (d.type === "ready") res();
      if (d.type === "req") { seen = d.request; ws.send(JSON.stringify({ type: "res", id: d.id, response: { ok: true, hidden: 1, tabs: [
        { id: 1, active: true, title: "Example", url: "https://example.com/" },
        { id: 2, active: false, title: "Extensions", url: "chrome://extensions/", restricted: true }] } })); }
    });
    ws.on("error", rej);
  });
  try {
    const t = textOf(await call(c, "browser_tabs", { action: "list", includeHidden: true, showAll: true }));
    assert.equal(seen.allWindows, true, "all windows by default");
    assert.match(t, /All 2 open tabs in every window/);
    assert.match(t, /#2 .*chrome:\/\/extensions\/ {2}\(browser page: cannot be read or operated\)/);
    assert.match(t, /1 more tab is open on sites the user excluded/);
    assert.match(t, /complete list/);
    assert.match(t, /Ignored: includeHidden, showAll\. browser_tabs has no such parameters; it takes only: action, tabId, url, active, allWindows/);
    assert.doesNotMatch(t, /hidden by the site lists/);
  } finally { ws.terminate(); }
});

// Runs last: everything above has left real state in the data directory.
test("a restart on the same data directory comes up and keeps files, sign-ins and schedules", async () => {
  const c = await client();
  await call(c, "run_code", { language: "bash", code: "echo survives > keep.txt" });
  await call(c, "schedule", { action: "create", name: "keeper", language: "bash", code: "echo hi", every_minutes: 60 });
  const tok = (await (await fetch(base + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials&client_secret=" + KEY })).json()).access_token;
  await fetch(base + "/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer " + KEY }, body: "token=" + encodeURIComponent(tok) });
  const kept = (await (await fetch(base + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials&client_secret=" + KEY })).json()).access_token;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM"); await exited;
  log = "";
  await start();
  const ping = (t) => fetch(base + "/mcp", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }).then((r) => r.status);
  assert.equal(await ping(kept), 200, log);
  assert.equal(await ping(tok), 401);
  const c2 = await client();
  assert.match(textOf(await call(c2, "run_code", { language: "bash", code: "cat keep.txt" })), /survives/);
  assert.match(textOf(await call(c2, "schedule", { action: "list" })), /keeper/);
});

test("omniroute: speech, cooldown, transcription, embeddings; chat refused", async () => {
  const c = await client();
  const t = (await c.listTools()).tools.find((x) => x.name === "omniroute");
  assert.deepEqual(t.inputSchema.properties.op.enum, ["speech", "transcribe", "embeddings"]);
  let r = await call(c, "omniroute", { op: "speech", model: "Lauren Ezzo", input: "Hi there" });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /saved as `speech_1\.mp3`/);
  const sp = omniSeen.find((x) => x.url === "/api/v1/audio/speech");
  assert.equal(sp.auth, "Bearer omni-test-key-123");
  assert.equal(JSON.parse(sp.body).model, "Lauren Ezzo");
  r = await call(c, "omniroute", { op: "speech", model: "Lauren Ezzo", input: "cooling" });
  assert.ok(r.isError); assert.match(textOf(r), /429[\s\S]*retry after 109 s[\s\S]*Do not retry/);
  r = await call(c, "omniroute", { op: "transcribe", model: "whisper", src: "speech_1.mp3" });
  assert.ok(!r.isError, textOf(r)); assert.match(textOf(r), /hello world/);
  r = await call(c, "omniroute", { op: "embeddings", model: "emb", input: ["a"] });
  assert.match(textOf(r), /dimension 3/);
  r = await call(c, "omniroute", { op: "chat", model: "x" });
  assert.ok(r.isError); assert.match(textOf(r), /omniroute_route_request/);
  assert.ok(!textOf(r).includes("omni-test-key-123"));
});
