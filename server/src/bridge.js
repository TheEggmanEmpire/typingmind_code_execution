// Paired browser devices. Credentials never enter model-visible tool replies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./config.js";

const PAIR_TTL = 10 * 60_000;
const MAX_MESSAGE = 32 * 1024 * 1024;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codes = new Map(), devices = new Map(), sockets = new Map();
const attempts = new Map(), attached = new WeakMap();
let loaded = false, order = 0;
const hash = value => crypto.createHash("sha256").update(String(value)).digest();
const extensionOrigin = origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin || "");
const filename = path.join(config.dataDir, "bridge.json");

function load() {
  if (loaded) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  if (data !== undefined && (!data || !Array.isArray(data.devices) || data.devices.some(d => !d || typeof d.deviceId !== "string" || typeof d.user !== "string" || !/^[a-f0-9]{64}$/.test(d.tokenHash))))
    throw new Error("Invalid bridge.json; refusing to discard paired devices");
  for (const d of (data?.devices || []).sort((a, b) => a.lastSeen - b.lastSeen)) devices.set(d.deviceId, { ...d, order: ++order });
  loaded = true;
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = filename + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ devices: [...devices.values()].map(({ order, ...d }) => d) }) + "\n");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function credential(deviceId, token) {
  load();
  const d = typeof deviceId === "string" ? devices.get(deviceId) : null;
  const supplied = hash(typeof token === "string" ? token : "");
  const expected = d ? Buffer.from(d.tokenHash, "hex") : Buffer.alloc(32);
  const match = crypto.timingSafeEqual(supplied, expected);
  return match && d && typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? d : null;
}

function cleanCodes() {
  const now = Date.now();
  for (const [key, c] of codes) if (c.expiresAt <= now) codes.delete(key);
}

export function createPairingCode(user) {
  load(); cleanCodes();
  if (typeof user !== "string" || !user) throw new Error("Pairing needs a user");
  if ([...codes.values()].filter(c => c.user === user).length >= 5) throw new Error("Five pairing codes are already open; use one or wait 10 minutes");
  if (codes.size >= 10_000) throw new Error("Pairing code limit reached; try later");
  let raw, digest;
  do {
    raw = Array.from({ length: 10 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
    digest = hash(raw).toString("hex");
  } while (codes.has(digest));
  const expiresAt = Date.now() + PAIR_TTL;
  codes.set(digest, { user, expiresAt });
  return { code: raw.slice(0, 4) + "-" + raw.slice(4, 8) + "-" + raw.slice(8), expiresAt };
}

function limited(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  for (const [key, v] of attempts) if (v.until <= now) attempts.delete(key);
  const keys = [["global", 120], ["ip:" + ip, 10]];
  if (keys.some(([key, max]) => (attempts.get(key)?.count || 0) >= max)) return true;
  for (const [key] of keys) {
    const v = attempts.get(key) || { count: 0, until: now + 60_000 };
    v.count++; attempts.set(key, v);
  }
  return false;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) {
      // Do not destroy the request: the caller must receive the 413 response.
      req.resume();
      throw Object.assign(new Error("Request body exceeds 4 KB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch { throw Object.assign(new Error("Expected a JSON object"), { status: 400 }); }
}

function removeDevice(d) {
  devices.delete(d.deviceId);
  try { save(); } catch (e) { devices.set(d.deviceId, d); throw e; }
  const socket = sockets.get(d.deviceId);
  if (socket) { socket.finish(); socket.ws.close(4401, "Pairing rejected, pair again"); }
}

export async function handleBridgeHttp(req, res, url) {
  if (!["/bridge/pair", "/bridge/unpair"].includes(url.pathname)) return false;
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("cache-control", "no-store");
  if (origin && !extensionOrigin(origin)) { json(res, 403, { ok: false, error: "Extension origin required" }); return true; }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return true;
  }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); json(res, 405, { ok: false, error: "Use POST" }); return true; }
  if (limited(req)) { res.setHeader("Retry-After", "60"); json(res, 429, { ok: false, code: "rate-limit", error: "Too many pairing attempts; wait a minute" }); return true; }
  try {
    const body = await bodyJson(req);
    load();
    if (url.pathname === "/bridge/unpair") {
      const d = credential(body.deviceId, body.token);
      if (!d) json(res, 401, { ok: false, error: "Pairing rejected, pair again" });
      else { removeDevice(d); json(res, 200, { ok: true }); }
      return true;
    }
    cleanCodes();
    const normalized = typeof body.code === "string" ? body.code.toUpperCase().replace(/[-\s]/g, "") : "";
    const supplied = hash(normalized);
    let matched;
    // All comparisons have the same length; do not stop on the matching entry.
    for (const [key, c] of codes) if (crypto.timingSafeEqual(supplied, Buffer.from(key, "hex"))) matched = [key, c];
    if (!matched) { json(res, 401, { ok: false, code: "pairing-invalid", error: "Pairing code invalid or expired" }); return true; }
    const [key, code] = matched;
    const token = crypto.randomBytes(32).toString("base64url");
    const d = { deviceId: crypto.randomUUID(), tokenHash: hash(token).toString("hex"), user: code.user,
      name: String(body.name || "Chrome").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100),
      version: String(body.version || "").slice(0, 40), created: Date.now(), lastSeen: Date.now(), order: ++order };
    codes.delete(key); devices.set(d.deviceId, d);
    try { save(); } catch (e) { devices.delete(d.deviceId); codes.set(key, code); throw e; }
    json(res, 200, { deviceId: d.deviceId, token, user: d.user });
  } catch (e) {
    json(res, e.status || 500, { ok: false, error: e.status ? e.message : "Could not save browser pairing" });
  }
  return true;
}

export function attachBridge(httpServer) {
  if (attached.has(httpServer)) return;
  load();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  attached.set(httpServer, wss);
  httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return; }
    if (url.pathname !== "/bridge") return;
    if (url.search || (req.headers.origin && !extensionOrigin(req.headers.origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  });
  wss.on("connection", ws => {
    let active = null, authPending = false;
    const reject = () => { authPending = true; ws.close(4401, "Pairing rejected, pair again"); };
    const authTimer = setTimeout(reject, 5000); authTimer.unref();
    ws.on("error", () => {}); // ws reports oversized/malformed frames here, then closes.
    ws.on("close", () => { clearTimeout(authTimer); active?.finish(); });
    ws.on("message", (raw, binary) => {
      let msg;
      try { if (binary) throw new Error(); msg = JSON.parse(raw.toString()); if (!msg || typeof msg !== "object") throw new Error(); }
      catch { if (!active) reject(); else ws.close(4400, "Invalid bridge message"); return; }
      if (!active) {
        if (authPending) return;
        authPending = true;
        const d = msg.type === "hello" ? credential(msg.deviceId, msg.token) : null;
        if (!d) { reject(); return; }
        clearTimeout(authTimer);
        sockets.get(d.deviceId)?.ws.close(4400, "Device reconnected");
        sockets.get(d.deviceId)?.finish();
        const entry = { ws, device: d, since: Date.now(), pending: new Map(), silenceTimer: null,
          touch() {
            clearTimeout(entry.silenceTimer);
            entry.silenceTimer = setTimeout(() => { entry.finish(); ws.terminate(); }, 70_000);
            entry.silenceTimer.unref();
          },
          finish() {
            clearTimeout(entry.silenceTimer);
            if (sockets.get(d.deviceId) === entry) sockets.delete(d.deviceId);
            for (const p of entry.pending.values()) p.resolve({ ok: false, code: "offline" });
            entry.pending.clear();
          } };
        active = entry; sockets.set(d.deviceId, entry); entry.touch();
        d.version = String(msg.version || d.version).slice(0, 40);
        ws.send(JSON.stringify({ type: "ready", user: d.user }));
        return;
      }
      active.touch();
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (msg.type !== "res" || typeof msg.id !== "string") return;
      const pending = active.pending.get(msg.id);
      if (!pending || !msg.response || typeof msg.response !== "object" || typeof msg.response.ok !== "boolean") return;
      active.pending.delete(msg.id);
      active.device.lastSeen = Date.now(); active.device.order = ++order;
      // The response remains useful if the volume temporarily becomes unwritable.
      try { save(); } catch {}
      pending.resolve(msg.response);
    });
  });
  httpServer.once("close", () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
}

export function bridgeStatus(user) {
  load();
  const online = [...sockets.values()].filter(e => e.device.user === user && e.ws.readyState === WebSocket.OPEN);
  return { connected: !!online.length, devices: online.map(e => ({ id: e.device.deviceId, name: e.device.name, version: e.device.version, since: e.since })) };
}

export async function bridgeCall(user, request, timeoutMs = 30_000) {
  load();
  const entry = [...sockets.values()].filter(e => e.device.user === user && e.ws.readyState === WebSocket.OPEN)
    .sort((a, b) => b.device.order - a.device.order)[0];
  if (!entry) return { ok: false, code: "offline" };
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { entry.pending.delete(id); resolve({ ok: false, error: "__timeout" }); }, Math.max(1, Number(timeoutMs) || 30_000));
    const finish = response => { clearTimeout(timer); resolve(response); };
    entry.pending.set(id, { resolve: finish });
    try {
      const payload = JSON.stringify({ type: "req", id, request });
      if (Buffer.byteLength(payload) > MAX_MESSAGE) throw new Error("Bridge request exceeds 32 MB");
      entry.ws.send(payload, err => { if (err) { entry.pending.delete(id); finish({ ok: false, code: "offline" }); } });
    } catch (e) { entry.pending.delete(id); finish({ ok: false, error: e.message }); }
  });
}

export function revokeDevices(user) {
  load();
  const removed = [...devices.values()].filter(d => d.user === user);
  for (const d of removed) devices.delete(d.deviceId);
  try { save(); } catch (e) { for (const d of removed) devices.set(d.deviceId, d); throw e; }
  for (const d of removed) { const e = sockets.get(d.deviceId); if (e) { e.finish(); e.ws.close(4401, "Pairing rejected, pair again"); } }
  for (const [key, c] of codes) if (c.user === user) codes.delete(key);
  return removed.length;
}
