// REA (Reverse Engineer Anything, npm package rea-agents) as part of the main MCP
// endpoint: its tools are listed on /mcp next to the Code Runner tools.
//
// REA is a stdio MCP server. Each workspace gets its own REA process, started on
// the first call through the same sandbox as model-written code (cwd = the
// workspace, so REA sees uploaded and generated files), kept alive between calls
// and stopped after REA_IDLE_MIN idle minutes or on shutdown. Calls are forwarded
// through the SDK Client over the child's stdin/stdout (newline-delimited JSON-RPC);
// progress is passed through when the caller sent a progressToken.

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { spawnInWorkspace, killTree } from "./sandbox.js";

const BODY_MAX = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 90000;
const STDERR_KEEP = 8192;
const children = new Map();          // ws.id -> entry
let idleMs = config.reaIdleMin * 60000;
let known = null;                    // { capabilities, instructions, version } of the last REA that started
let resolved;                        // cached result of resolveCommand()

// ---- command ----------------------------------------------------------------
function executable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
function which(name) {
  const dirs = [...String(process.env.PATH || "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
  for (const d of dirs) { const p = path.join(d, name); if (executable(p)) return p; }
  return null;
}
// Directory to expose read-only: the folder holding node_modules (an npm prefix or
// runtime folder), otherwise the file's own folder.
function installRoot(p) {
  const i = p.indexOf("/node_modules/");
  const root = i > 0 ? p.slice(0, i) : path.dirname(p);
  return root.split("/").filter(Boolean).length >= 1 ? root : null;
}
function resolveCommand() {
  if (!config.rea) return { ok: false, reason: "REA is disabled (REA=0)." };
  const argv = [...config.reaCommand];
  if (!argv.length) return { ok: false, reason: "REA_COMMAND is empty." };
  const prog = argv[0].includes("/") ? path.resolve(argv[0]) : which(argv[0]);
  if (!prog || !executable(prog)) return { ok: false, reason: `REA command not found: '${argv[0]}'.` };
  argv[0] = prog;
  const readOnly = new Set();
  for (const a of argv) {
    if (!path.isAbsolute(a) || !fs.existsSync(a)) continue;
    for (const p of new Set([a, fs.realpathSync(a)])) { const r = installRoot(p); if (r) readOnly.add(r); }
  }
  for (const a of argv.slice(1)) if (/\.(m?js|cjs)$/.test(a) && path.isAbsolute(a) && !fs.existsSync(a)) return { ok: false, reason: `REA script not found: '${a}'.` };
  return { ok: true, argv, readOnly: [...readOnly] };
}
function status() { return (resolved ||= resolveCommand()); }
export function reaAvailable() { return status().ok; }

const HOW_TO_ENABLE = "To enable it: build the image with WITH_REA=1 (the default; it installs rea-agents globally), " +
  "or install it with 'npm install -g rea-agents', set REA=1, and point REA_COMMAND at REA's stdio MCP command line " +
  "when it is not the 'rea' on PATH (for example REA_COMMAND=\"node /path/to/rea-agents/scripts/rea.mjs mcp\"). Then restart the server.";

// ---- stdio transport over an already spawned (sandboxed) child ---------------
class ChildTransport {
  constructor(child) { this.child = child; this.buf = new ReadBuffer({ maxBufferSize: 64 * 1024 * 1024 }); }
  async start() {
    this.child.stdout.on("data", (chunk) => {
      try { this.buf.append(chunk); } catch (e) { this.onerror?.(e); return; }
      for (;;) {
        let msg;
        try { msg = this.buf.readMessage(); } catch (e) { this.onerror?.(e); continue; }
        if (!msg) break;
        this.onmessage?.(msg);
      }
    });
    this.child.stdin.on("error", (e) => this.onerror?.(e));
    this.child.on("close", () => this.onclose?.());
  }
  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin.writable) return reject(new Error("REA process is not running."));
      this.child.stdin.write(serializeMessage(message), (e) => (e ? reject(e) : resolve()));
    });
  }
  async close() {
    try { this.child.stdin.end(); } catch {}
    killTree(this.child, "SIGTERM");
    const t = setTimeout(() => { try { killTree(this.child, "SIGKILL"); } catch {} }, 3000);
    t.unref();
  }
}

// ---- children -----------------------------------------------------------------
function reaEnv(ws) {
  const base = path.join(ws.dir, ".cr", "rea");
  return { XDG_CACHE_HOME: path.join(base, "cache"), XDG_CONFIG_HOME: path.join(base, "config"), XDG_DATA_HOME: path.join(base, "data"), NO_COLOR: "1" };
}

function startChild(ws) {
  const cmd = status();
  if (!cmd.ok) throw Object.assign(new Error(cmd.reason), { unavailable: true });
  const env = reaEnv(ws);
  // The directories are made inside the sandbox, as the workspace's own user.
  const argv = ["/bin/sh", "-c", 'mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" && exec "$@"', "rea", ...cmd.argv];
  const child = spawnInWorkspace(ws, argv, { env, readOnly: cmd.readOnly });
  const entry = { ws, child, client: null, tools: null, info: null, active: 0, timer: null, stderr: "", closed: false, lastUsed: Date.now() };
  child.stderr.on("data", (b) => { entry.stderr = (entry.stderr + b.toString()).slice(-STDERR_KEEP); });
  child.on("error", (e) => { entry.stderr += "\n" + e.message; });
  child.on("close", (code, signal) => {
    entry.closed = true;
    clearTimeout(entry.timer);
    if (children.get(ws.id) === entry) children.delete(ws.id);
    if (!entry.stopping) console.error(`rea: process of workspace ${ws.id} exited (${signal || code})` + (entry.stderr.trim() ? ": " + entry.stderr.trim().slice(-500) : ""));
  });
  const client = new Client({ name: "code-runner-rea-proxy", version: "1.0.0" }, { capabilities: {} });
  entry.client = client;
  entry.ready = (async () => {
    let timer;
    try {
      await Promise.race([
        client.connect(new ChildTransport(child)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`REA did not answer initialize within ${START_TIMEOUT_MS / 1000} s.`)), START_TIMEOUT_MS); })
      ]);
    } catch (e) {
      stopEntry(entry);
      throw new Error("REA could not start: " + e.message + (entry.stderr.trim() ? "\nREA stderr: " + entry.stderr.trim().slice(-2000) : ""));
    } finally { clearTimeout(timer); }
    const caps = client.getServerCapabilities() || {};
    entry.info = { capabilities: caps, instructions: client.getInstructions(), version: client.getServerVersion()?.version || "unknown" };
    known = entry.info;
    return entry;
  })();
  entry.ready.catch(() => {});
  children.set(ws.id, entry);
  return entry;
}

function ready(ws) {
  const e = children.get(ws.id);
  return e && !e.closed ? e.ready : startChild(ws).ready;
}

function stopEntry(entry) {
  if (entry.stopping) return;
  entry.stopping = true;
  clearTimeout(entry.timer);
  if (children.get(entry.ws.id) === entry) children.delete(entry.ws.id);
  entry.client.close().catch(() => {});
  if (!entry.closed) { try { killTree(entry.child, "SIGTERM"); } catch {} }
}

function touch(entry, delta) {
  entry.active += delta;
  entry.lastUsed = Date.now();
  clearTimeout(entry.timer);
  if (entry.active <= 0) {
    entry.active = 0;
    entry.timer = setTimeout(() => { if (entry.active === 0) stopEntry(entry); }, idleMs);
    entry.timer.unref();
  }
}

async function using(ws, fn) {
  const entry = await ready(ws);
  touch(entry, +1);
  try { return await fn(entry); } finally { touch(entry, -1); }
}

function errorText(e, entry) {
  let msg = e && e.message ? e.message : String(e);
  if (entry && entry.closed && entry.stderr.trim()) msg += "\nREA stderr: " + entry.stderr.trim().slice(-2000);
  return msg;
}

// ---- part of the main MCP endpoint ------------------------------------------------
// REA's tools are listed next to the Code Runner tools on /mcp and calls to them
// are forwarded to the workspace's REA process.
function withoutProgress(params) {
  const out = { ...params };
  if (out._meta) { const { progressToken, ...rest } = out._meta; out._meta = Object.keys(rest).length ? rest : undefined; if (!out._meta) delete out._meta; }
  return out;
}

// The tool list depends on the installed REA version only, so one answer serves
// every workspace: listing tools does not start a process per user.
let catalog = null, catalogPending = null, catalogFailedAt = 0;
const CATALOG_RETRY_MS = 60000;

async function fetchTools(entry) {
  const tools = [];
  let cursor;
  do {
    const r = await entry.client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, { timeout: 60000 });
    tools.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor);
  return tools;
}

// `reserved`: names of the server's own tools; a REA tool of the same name is left out.
export async function reaListTools(ws, reserved = []) {
  if (!config.rea || !reaAvailable()) return [];
  if (catalog) return catalog;
  // A REA that cannot start must not make every tools/list slow or fail.
  if (Date.now() - catalogFailedAt < CATALOG_RETRY_MS) return [];
  catalogPending ||= using(ws, fetchTools).then((tools) => {
    const taken = new Set(reserved);
    catalog = tools.filter((t) => !taken.has(t.name));
    return catalog;
  }).catch((e) => {
    catalogFailedAt = Date.now();
    console.error("rea: tools are not offered: " + (e && e.message || e));
    return [];
  }).finally(() => { catalogPending = null; });
  return catalogPending;
}
export const reaInstructions = () => (known && known.instructions) || "";

// params: the tools/call params as received; extra: the MCP handler's extra (signal, sendNotification).
export async function reaCallTool(ws, params, extra) {
  const token = params._meta && params._meta.progressToken;
  const timeout = config.reaCallTimeoutS * 1000;
  let entry;
  try {
    return await using(ws, async (e) => {
      entry = e;
      const options = { timeout, maxTotalTimeout: timeout, signal: extra.signal };
      if (token !== undefined) {
        options.onprogress = (p) => {
          extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken: token } }).catch(() => {});
        };
      }
      return await e.client.request({ method: "tools/call", params: withoutProgress(params) }, CallToolResultSchema, options);
    });
  } catch (e) {
    if (extra.signal && extra.signal.aborted) throw e;
    if (e && e.unavailable) return { content: [{ type: "text", text: "REA is not available on this server. " + e.message + " " + HOW_TO_ENABLE }], isError: true };
    return { content: [{ type: "text", text: "REA call failed: " + errorText(e, entry) }], isError: true };
  }
}

export async function shutdownRea() {
  const all = [...children.values()];
  const exits = all.map((e) => e.closed ? null : new Promise((r) => e.child.once("close", r)));
  for (const e of all) stopEntry(e);
  await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 4000).unref())]);
  for (const e of all) if (!e.closed) { try { killTree(e.child, "SIGKILL"); } catch {} }
}

export function reaReport() { return { available: reaAvailable(), running: children.size }; }

// Test seams.
export const __test = {
  setIdleMs(ms) { idleMs = ms; },
  children,
  reset() { resolved = undefined; known = null; catalog = null; catalogFailedAt = 0; }
};
