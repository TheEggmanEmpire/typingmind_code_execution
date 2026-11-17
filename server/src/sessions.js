// Workspaces: one real directory per (user, workspace name) on the volume, a
// dedicated unix uid for the code that runs in it, a metadata file the code
// cannot reach, and signed tokens for the links handed to the user.
//
//   <DATA_DIR>/ws/<id>/     the workspace (the code's cwd); owned by ws.uid, 0700
//   <DATA_DIR>/tmp/<id>/    private TMPDIR of that workspace; owned by ws.uid, 0700
//   <DATA_DIR>/meta/<id>.json   server-side state (history, shares, schedules); root only
//   <DATA_DIR>/uids.json    id -> uid

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const cache = new Map();
let uids = null;

const clean = (s, d) => {
  s = String(s == null ? "" : s).trim().replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 80);
  return s && !/^\.+$/.test(s) ? s : d;
};

function loadUids() {
  if (uids) return uids;
  try { uids = JSON.parse(fs.readFileSync(path.join(config.dataDir, "uids.json"), "utf8")); } catch (e) { uids = {}; }
  return uids;
}
function uidFor(id) {
  if (!isRoot) return process.getuid();
  const map = loadUids();
  if (map[id]) return map[id];
  const used = new Set(Object.values(map));
  let uid = config.uidBase;
  while (used.has(uid)) uid++;
  map[id] = uid;
  const file = path.join(config.dataDir, "uids.json");
  fs.mkdirSync(config.dataDir, { recursive: true });   // first start without a volume: /data does not exist yet
  fs.writeFileSync(file + ".tmp", JSON.stringify(map), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  return uid;
}

function ensureDir(dir, uid, gid, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
  // lstat: a workspace directory is never replaced by a link we would follow.
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error("workspace path is not a directory");
  if (isRoot && (st.uid !== uid || st.gid !== gid)) fs.lchownSync(dir, uid, gid);
  if ((st.mode & 0o777) !== mode) fs.chmodSync(dir, mode);
}

class Workspace {
  constructor(user, name) {
    this.user = user;
    this.name = name;
    // The id is a directory name: readable, and unique even when cleaning collapses two names.
    const h = crypto.createHash("sha256").update(user + "\0" + name).digest("hex").slice(0, 10);
    this.id = clean(user, "user").slice(0, 24) + "-" + clean(name, "main").slice(0, 24) + "-" + h;
    this.uid = uidFor(this.id);
    this.gid = isRoot ? this.uid : process.getgid();
    this.dir = path.join(config.dataDir, "ws", this.id);
    this.tmp = path.join(config.dataDir, "tmp", this.id);
    this.metaFile = path.join(config.dataDir, "meta", this.id + ".json");
    for (const d of ["ws", "tmp", "meta"]) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true, mode: 0o711 });
    fs.chmodSync(path.join(config.dataDir, "meta"), 0o700);
    ensureDir(this.dir, this.uid, this.gid, 0o700);
    ensureDir(this.tmp, this.uid, this.gid, 0o700);
    this._meta = null;
  }

  // Server-side state. Never stored inside the workspace, where the code could edit it.
  get meta() {
    if (this._meta) return this._meta;
    try { this._meta = JSON.parse(fs.readFileSync(this.metaFile, "utf8")); } catch (e) { this._meta = {}; }
    return this._meta;
  }
  saveMeta() {
    fs.writeFileSync(this.metaFile + ".tmp", JSON.stringify(this.meta), { mode: 0o600 });
    fs.renameSync(this.metaFile + ".tmp", this.metaFile);
  }

  // A link token for this workspace: `kind` separates downloads, previews and
  // the upload page; `exp` is a unix time in seconds (0 = no expiry).
  token(kind, exp = 0) { return signToken({ w: this.id, u: this.user, n: this.name, k: kind, e: exp }); }
}

export function getWorkspace(user, name) {
  user = clean(user, "default");
  name = clean(name, "main");
  const key = user + "\0" + name;
  let ws = cache.get(key);
  if (!ws) {
    ws = new Workspace(user, name);
    cache.set(key, ws);
    if (!ws.meta.owner) { ws.meta.owner = { user, name }; ws.saveMeta(); }
  }
  return ws;
}

export function allWorkspaces() {
  // Every workspace that has metadata on the volume (for schedules after a restart).
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(config.dataDir, "meta")); } catch (e) {}
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(config.dataDir, "meta", f), "utf8"));
      if (m && m.owner) out.push(getWorkspace(m.owner.user, m.owner.name));
    } catch (e) {}
  }
  return out;
}

// ---- signed tokens -----------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function mac(body) { return crypto.createHmac("sha256", config.secret).update(body).digest().subarray(0, 16); }

export function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + b64u(mac(body));
}

// Returns the payload, or null when the token is forged, damaged or expired.
export function verifyToken(token, kind) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = mac(body);
  let got;
  try { got = Buffer.from(sig, "base64url"); } catch (e) { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
  if (kind && p.k !== kind) return null;
  if (p.e && p.e < Date.now() / 1000) return null;
  return p;
}

export function workspaceFromToken(token, kind) {
  const p = verifyToken(token, kind);
  if (!p || !p.u || !p.n) return null;
  const ws = getWorkspace(p.u, p.n);
  return ws.id === p.w ? { ws, payload: p } : null;
}
