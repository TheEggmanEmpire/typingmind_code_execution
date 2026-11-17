import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { once } from "node:events";
import { setTimeout as realDelay } from "node:timers/promises";
import { WebSocket } from "ws";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bridge-unit-"));
process.env.BRIDGE_TRUST_LOCAL_XFF = "1";
process.env.DATA_DIR = dir;
process.env.MCP_API_KEY = "bridge-test-access-key-0123456789";
const bridge = await import("../src/bridge.js");
const server = http.createServer(async (req, res) => {
  try { if (!await bridge.handleBridgeHttp(req, res, new URL(req.url, "http://localhost"))) res.writeHead(404).end(); }
  catch { res.writeHead(500).end(); }
});
bridge.attachBridge(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let ip = 0;
const clients = new Set();
after(async () => {
  for (const ws of clients) ws.terminate();
  await new Promise(r => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
async function post(route, body, headers = {}) {
  return fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ip}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function pair(user, name = "Test Chrome") {
  const { code } = bridge.createPairingCode(user);
  const res = await post("/bridge/pair", { code, name, version: "0.5.0" });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.user, user);
  assert.match(result.token, /^crd1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  return { code, ...result };
}
async function connect(device, overrides = {}) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/bridge");
  clients.add(ws);
  await once(ws, "open");
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", ...device, ...overrides, version: "0.5.0" }));
  const [raw] = await ready;
  assert.equal(JSON.parse(raw).type, "ready");
  return ws;
}
async function respond(ws, user, label) {
  const got = once(ws, "message");
  const call = bridge.bridgeCall(user, { op: "ping" }, 500);
  const [raw] = await got;
  const msg = JSON.parse(raw);
  assert.equal(msg.type, "req");
  assert.deepEqual(msg.request, { op: "ping" });
  ws.send(JSON.stringify({ type: "res", id: msg.id, response: { ok: true, label } }));
  assert.deepEqual(await call, { ok: true, label });
}

test("pairing is one-time, grouped, stored privately with hashes only", async () => {
  const d = await pair("pair-test");
  assert.match(d.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
  assert.equal((await post("/bridge/pair", { code: d.code })).status, 401);
  const file = path.join(dir, "bridge.json");
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(d.token), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(text).devices.length, 1);
});
test("expired code is refused", async t => {
  const { code } = bridge.createPairingCode("expired");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 600001);
  assert.equal((await post("/bridge/pair", { code })).status, 401);
});
test("at most five open pairing codes per user", () => {
  const first = bridge.createPairingCode("five").code;
  for (let i = 0; i < 4; i++) bridge.createPairingCode("five");
  // A sixth code is still issued; the oldest one stops working instead.
  const sixth = bridge.createPairingCode("five").code;
  assert.match(sixth, /^[A-HJ-NP-Z2-9-]{12}$/);
  return post("/bridge/pair", { code: first, name: "x", version: "0.5.1" }).then(r => assert.equal(r.status, 401));
});
test("concurrent redemption can create only one device", async () => {
  const { code } = bridge.createPairingCode("race");
  const replies = await Promise.all([post("/bridge/pair", { code }), post("/bridge/pair", { code })]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 401]);
});
test("wrong hello token closes with 4401", async () => {
  const d = await pair("wrong");
  const ws = new WebSocket(base.replace("http:", "ws:") + "/bridge"); clients.add(ws);
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "hello", deviceId: d.deviceId, token: "bad" }));
  assert.equal((await closed)[0], 4401);
});
test("offline, round trip, ping, timeout and disconnect results", async () => {
  assert.deepEqual(await bridge.bridgeCall("absent", { op: "ping" }, 20), { ok: false, code: "offline" });
  const d = await pair("roundtrip"); const ws = await connect(d);
  assert.equal(bridge.bridgeStatus("roundtrip").connected, true);
  assert.equal(bridge.bridgeStatus("roundtrip").devices[0].id, d.deviceId);
  await respond(ws, "roundtrip", "one");
  const pong = once(ws, "message"); ws.send(JSON.stringify({ type: "ping" }));
  assert.equal(JSON.parse((await pong)[0]).type, "pong");
  assert.deepEqual(await bridge.bridgeCall("roundtrip", { op: "ping" }, 20), { ok: false, error: "__timeout" });
  const pending = bridge.bridgeCall("roundtrip", { op: "ping" }, 5000);
  ws.close();
  assert.deepEqual(await pending, { ok: false, code: "offline" });
});
test("most recently paired or answering device wins; late replies update priority", async () => {
  const a = await pair("multi", "a"); const wa = await connect(a);
  const awaiting = once(wa, "message"); const first = bridge.bridgeCall("multi", { op: "ping" }, 2000);
  const req = JSON.parse((await awaiting)[0]);
  const b = await pair("multi", "b"); const wb = await connect(b);
  await respond(wb, "multi", "b");
  wa.send(JSON.stringify({ type: "res", id: req.id, response: { ok: true } }));
  await first;
  await respond(wa, "multi", "a");
});
test("a response id from a different socket cannot complete a call", async () => {
  const a = await pair("scope", "a"); const wa = await connect(a);
  const b = await pair("scope", "b"); const wb = await connect(b);
  const got = once(wb, "message"); const pending = bridge.bridgeCall("scope", { op: "ping" }, 2000);
  const req = JSON.parse((await got)[0]);
  wa.send(JSON.stringify({ type: "res", id: req.id, response: { ok: true, forged: true } }));
  wb.send(JSON.stringify({ type: "res", id: req.id, response: { ok: true, real: true } }));
  assert.deepEqual(await pending, { ok: true, real: true });
});
test("revoke removes devices, closes sockets and invalidates reconnect", async () => {
  const d = await pair("revoke"); const ws = await connect(d); const closed = once(ws, "close");
  assert.equal(bridge.revokeDevices("revoke"), 1);
  await closed;
  const again = new WebSocket(base.replace("http:", "ws:") + "/bridge"); clients.add(again);
  await once(again, "open"); const rejected = once(again, "close");
  again.send(JSON.stringify({ type: "hello", ...d }));
  assert.equal((await rejected)[0], 4401);
  assert.deepEqual(await bridge.bridgeCall("revoke", {}, 20), { ok: false, code: "offline" });
});
test("unpair requires the credential and invalidates it", async () => {
  const d = await pair("unpair"); const ws = await connect(d);
  assert.equal((await post("/bridge/unpair", { deviceId: d.deviceId, token: "bad" })).status, 401);
  const closed = once(ws, "close");
  assert.equal((await post("/bridge/unpair", d)).status, 200);
  await closed;
  assert.equal((await post("/bridge/unpair", d)).status, 401);
});
test("per-IP pair limit uses last forwarded hop", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post("/bridge/pair", { code: "WRONG" }, { "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` })).status, 401);
  const res = await post("/bridge/pair", { code: "WRONG" }, { "x-forwarded-for": "198.51.100.100, 203.0.113.9" });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
});
test("pairing rejects oversized bodies and arbitrary web origins", async () => {
  assert.equal((await post("/bridge/pair", "x".repeat(4097))).status, 413);
  const bad = await post("/bridge/pair", {}, { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const origin = "chrome-extension://" + "a".repeat(32);
  const good = await fetch(base + "/bridge/pair", { method: "OPTIONS", headers: { origin } });
  assert.equal(good.status, 204); assert.equal(good.headers.get("access-control-allow-origin"), origin);
});
test("oversized chunked pairing body receives 413 before the sender finishes", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + "/bridge/pair", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ip}` } }, res => {
      resolve(res.statusCode); res.resume(); req.end();
    });
    req.on("error", reject);
    req.write("x".repeat(2048));
    setTimeout(() => req.write("x".repeat(2049)), 10);
  });
  assert.equal(status, 413);
});
test("persisted device credentials authenticate after module reload", async () => {
  const d = await pair("restart");
  const restarted = await import("../src/bridge.js?restart");
  const second = http.createServer(); restarted.attachBridge(second);
  second.listen(0, "127.0.0.1"); await once(second, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${second.address().port}/bridge`);
  try {
    await once(ws, "open"); const ready = once(ws, "message");
    ws.send(JSON.stringify({ type: "hello", ...d }));
    assert.equal(JSON.parse((await ready)[0]).type, "ready");
  } finally { ws.terminate(); await new Promise(r => second.close(r)); }
});

test("a pairing survives a wiped bridge.json; an unlinked device does not come back", async () => {
  const kept = await pair("wiped"), gone = await pair("wiped-gone");
  assert.equal((await post("/bridge/unpair", gone)).status, 200);
  const file = path.join(dir, "bridge.json");
  const saved = fs.readFileSync(file);
  const hello = async (mod, d) => {
    const srv = http.createServer(); mod.attachBridge(srv);
    srv.listen(0, "127.0.0.1"); await once(srv, "listening");
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/bridge`);
    try {
      await once(ws, "open");
      const first = new Promise(res => { ws.once("message", m => res(JSON.parse(m).type)); ws.once("close", c => res(c)); });
      ws.send(JSON.stringify({ type: "hello", ...d }));
      return await first;
    } finally { ws.terminate(); await new Promise(r => srv.close(r)); }
  };
  // With the file as it is, the unlinked device stays refused after a restart.
  assert.equal(await hello(await import("../src/bridge.js?afterunlink"), gone), 4401);
  try {
    // The store vanishes entirely, as on a redeploy with no volume: the signed token restores the pairing.
    fs.rmSync(file);
    const fresh = await import("../src/bridge.js?wiped");
    assert.equal(await hello(fresh, kept), "ready");
    assert.equal(await hello(fresh, { ...kept, token: kept.token.slice(0, -2) + "xx" }), 4401);
  } finally { fs.writeFileSync(file, saved); }
});

test("the link key connects a browser without pairing and serves every user; an own pairing wins", async () => {
  const key = bridge.linkKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  // A wrong key is refused like a wrong token.
  const bad = new WebSocket(base.replace("http:", "ws:") + "/bridge"); clients.add(bad);
  await once(bad, "open"); const closed = once(bad, "close");
  bad.send(JSON.stringify({ type: "hello", key: key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"), deviceId: "x" }));
  assert.equal((await closed)[0], 4401);
  assert.deepEqual(await bridge.bridgeCall("nobody-yet", { op: "ping" }, 300), { ok: false, code: "offline" });
  // The right key: no code, no stored device.
  const before = fs.readFileSync(path.join(dir, "bridge.json"), "utf8");
  const linked = await connect({ key, deviceId: "home-chrome", name: "Home Chrome" });
  assert.equal(bridge.bridgeStatus("anyone-at-all").connected, true);
  await respond(linked, "anyone-at-all", "linked");
  assert.equal(fs.readFileSync(path.join(dir, "bridge.json"), "utf8"), before, "a key-linked browser is not written to the device store");
  // A user with a browser of their own gets that one, not the shared one.
  const own = await connect(await pair("has-own"));
  await respond(own, "has-own", "own");
  await respond(linked, "someone-else", "linked");
  // Unlinking a user's devices leaves the key-linked browser alone.
  bridge.revokeDevices("has-own");
  assert.equal(bridge.bridgeStatus("has-own").connected, true);
  linked.terminate();
});

test("missing hello expires in five seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ws = new WebSocket(base.replace("http:", "ws:") + "/bridge"); clients.add(ws);
  await once(ws, "open");
  const closed = once(ws, "close");
  t.mock.timers.tick(5001);
  assert.equal((await closed)[0], 4401);
});
test("oversized WebSocket response is rejected at the framing boundary", async () => {
  const d = await pair("oversize"); const ws = await connect(d);
  const closed = once(ws, "close");
  ws.send("x".repeat(32 * 1024 * 1024 + 1));
  assert.equal((await closed)[0], 1009);
});
test("malformed persisted state fails closed", async () => {
  const file = path.join(dir, "bridge.json"), saved = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, "null");
    const fresh = await import("../src/bridge.js?corrupt");
    assert.throws(() => fresh.bridgeStatus("any"), /Invalid bridge.json/);
  } finally { fs.writeFileSync(file, saved); }
});
test("a socket silent for 70 seconds is dropped", async t => {
  const d = await pair("silent");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ws = await connect(d), closed = once(ws, "close");
  try {
    t.mock.timers.tick(70_001);
    const result = await Promise.race([closed, realDelay(100).then(() => [0])]);
    assert.equal(result[0], 1006);
  } finally { ws.terminate(); }
});
test("global pair limit also applies across distinct IPs", async t => {
  const now = Date.now(); t.mock.method(Date, "now", () => now + 86_400_000);
  for (let i = 0; i < 120; i++) assert.equal((await post("/bridge/pair", {})).status, 401);
  assert.equal((await post("/bridge/pair", {})).status, 429);
});

const extensionDir = process.env.BRIDGE_EXTENSION_DIR || path.resolve(import.meta.dirname, "../../extension");
function extensionApi(name = "background.js") {
  const context = vm.createContext({ URL, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, console });
  const exposed = name === "background.js" ? "{ normalizeServerUrl, remotePolicy, policyBlocks, handle, REMOTE_SOURCE, resolveTabId, setSettings:s=>settingsCache=s }" : "{ normalizeServerUrl }";
  vm.runInContext(fs.readFileSync(path.join(extensionDir, name), "utf8") + "\nglobalThis.api = " + exposed + ";", context);
  return { api: context.api, context };
}
test("options and worker both enforce HTTPS with loopback-only HTTP", () => {
  for (const file of ["background.js", "options.js"]) {
    const { api } = extensionApi(file);
    assert.equal(api.normalizeServerUrl("https://EXAMPLE.com/"), "https://example.com");
    assert.equal(api.normalizeServerUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
    assert.equal(api.normalizeServerUrl("http://localhost:8080"), "http://localhost:8080");
    for (const url of ["http://example.com", "http://localhost.evil.example", "http://[::1]", "wss://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x", "https://example.com/#secret"])
      assert.throws(() => api.normalizeServerUrl(url), undefined, file + ": " + url);
  }
});
test("local and server allow lists intersect, blocks combine, executable schemes fail", () => {
  const { api } = extensionApi();
  const p = api.remotePolicy({ allow: ["example.com"], block: ["server.example.com"] }, { remoteAllow: ["shop.example.com"], remoteBlock: ["local.shop.example.com"] });
  assert.equal(api.policyBlocks("https://shop.example.com", p), null);
  assert.ok(api.policyBlocks("https://www.example.com", p));
  assert.ok(api.policyBlocks("https://local.shop.example.com", p));
  assert.match(api.policyBlocks("https://blocked.example./", api.remotePolicy({}, { remoteBlock: ["blocked.example"] })) || "", /blocked sites/);
  assert.ok(api.policyBlocks("https://server.example.com", p));
  assert.ok(api.policyBlocks("https://shop.example.com.evil.test", p));
  const unrestricted = api.remotePolicy({}, {});
  assert.equal(api.policyBlocks("https://anything.example", unrestricted), null);
  for (const u of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "chrome://extensions", "about:blank"]) assert.ok(api.policyBlocks(u, unrestricted));
});
test("remote authority cannot be supplied by an untrusted page and legacy frame rule remains", async () => {
  const { api } = extensionApi();
  api.setSettings({ hosts: ["typingmind.com"], remoteLink: { deviceId: "test" } });
  const bad = await api.handle({ op: "tabs.list", remote: true }, { tab: { id: 1, url: "https://evil.example" } }, 1);
  assert.equal(bad.code, "untrusted");
  const top = await api.handle({ op: "ping" }, { tab: { id: 1, url: "https://typingmind.com" } }, 0);
  assert.equal(top.trusted, false); assert.equal(top.nested, true);
  const frame = await api.handle({ op: "ping" }, { tab: { id: 1, url: "https://typingmind.com" } }, 2);
  assert.equal(frame.trusted, true);
  const remote = await api.handle({ op: "ping" }, api.REMOTE_SOURCE);
  assert.equal(remote.remote, true); assert.equal(remote.trusted, true);
});
test("script and master switches are local decisions, remote chat tabs are skipped", async () => {
  const { api, context } = extensionApi();
  const cfg = { hosts: ["typingmind.com"], remoteLink: { deviceId: "test" }, remoteScripts: false, remoteChatHosts: ["chat.example"] };
  api.setSettings(cfg);
  assert.equal((await api.handle({ op: "run", code: "return 1", remoteScripts: true }, api.REMOTE_SOURCE)).code, "scripts-disabled");
  api.setSettings({ ...cfg, remoteEnabled: false });
  assert.equal((await api.handle({ op: "tabs.list" }, api.REMOTE_SOURCE)).code, "offline");
  api.setSettings(cfg);
  const chat = { id: 1, url: "https://chat.example", active: true }, other = { id: 2, url: "https://shop.example" };
  context.chrome = { tabs: { query: async q => q.active ? [chat] : [chat, other] } };
  assert.equal(await api.resolveTabId({}, api.REMOTE_SOURCE), 2);
  const tabs = await api.handle({ op: "tabs.list" }, api.REMOTE_SOURCE);
  assert.equal(tabs.tabs[0].chat, true); assert.equal(tabs.tabs[1].chat, false);
});
