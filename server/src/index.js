// Code Runner MCP server.
//
//   POST /mcp            MCP over Streamable HTTP (stateless: every request stands alone,
//                        so redeploys and several clients need no session bookkeeping)
//   GET  /health         liveness and a short capability summary (no secrets)
//   /bridge, /bridge/*   the Chrome extension's remote link (WebSocket + pairing)
//   /f /p /w             signed links for the user: downloads, previews, workspace page
//
// Who is calling: the API key proves the client (LibreChat, Hermes) is ours; the
// client names the end user in X-User-ID and may pick a workspace with
// X-Workspace. Both are trusted because only the client holds the key.

import http from "node:http";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config, parseSecrets } from "./config.js";
import { getWorkspace } from "./sessions.js";
import { initSandbox, sandboxReport } from "./sandbox.js";
import { listTools, callTool, INSTRUCTIONS, startScheduler, stopScheduler } from "./tools.js";
import { attachBridge, handleBridgeHttp } from "./bridge.js";
import { handleWeb } from "./web.js";
import { guardedCall } from "./guard.js";
import { shutdownRunner, localLanguages } from "./runner.js";
// Auth for every MCP endpoint: Bearer key, HTTP Basic, or OAuth 2.1 (claude.ai-style
// connectors). Other endpoints reuse checkAuth/requireAuth with { resource: "/their/path" }.
import { handleAuthHttp, checkAuth, logAuthStatus } from "./mcp-auth.js";
import { reaListTools, reaCallTool, shutdownRea, reaAvailable } from "./rea.js";

const VERSION = "1.0.0";
const REA_NOTE = () => (config.reaTools === "compact"
  ? "\n- Reverse engineering (REA, about 140 tools): rea_find lists them and shows one tool's parameters, rea_call runs one. They read files from the same workspace (relative paths), so download or upload the target there first."
  : "\n- Reverse engineering: the other tools (open_binary, analyze_javascript_application, inspect_*, trace_*, ...) are REA. They read files from the same workspace (relative paths), so download or upload the target there first.");
const MCP_BODY_MAX = 64 * 1024 * 1024;   // `files` may carry base64 content

function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length, "Cache-Control": "no-store", ...headers });
  res.end(buf);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const header = (req, name) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };

// One MCP server object per request: it carries that request's user, workspace and secrets.
function mcpServerFor(req) {
  const user = header(req, "x-user-id") || "default";
  const ws = getWorkspace(user, header(req, "x-workspace") || "main");
  const secrets = { ...config.codeSecrets, ...parseSecrets(header(req, "x-code-secrets")) };

  const server = new Server({ name: "code-runner", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS + (reaAvailable() ? REA_NOTE() : "") });
  // One list: the Code Runner tools, then REA's (reverse engineering), which work on the same workspace.
  const own = new Set(listTools().map((t) => t.name));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...listTools(), ...(await reaListTools(ws, [...own]))] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = String(request.params.name);
    if (!own.has(name) && reaAvailable()) return guardedCall(ws, name === "rea_call" ? "rea:" + String((request.params.arguments || {}).tool || "?").slice(0, 60) : name, () => reaCallTool(ws, request.params, extra));
    const token = request.params._meta && request.params._meta.progressToken;
    let n = 0;
    // Output while a run is going, for clients that asked for progress.
    const progress = (message) => {
      if (token === undefined || !message) return;
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message: String(message).slice(-2000) } }).catch(() => {});
    };
    return guardedCall(ws, name, () => callTool(name, request.params.arguments, { ws, user: ws.user, secrets, progress, signal: extra.signal }));
  });
  return server;
}

async function handleMcp(req, res) {
  const gate = checkAuth(req, { resource: "/mcp" });
  if (!gate.ok) return json(res, gate.status, gate.body, gate.headers);
  if (req.method !== "POST") return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null }, { Allow: "POST" });
  let body;
  try { body = JSON.parse((await readBody(req, MCP_BODY_MAX)).toString("utf8")); }
  catch (e) { return json(res, e.status || 400, { jsonrpc: "2.0", error: { code: -32700, message: e.status ? e.message : "Parse error" }, id: null }); }
  const server = mcpServerFor(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400).end(); return; }
  try {
    // OAuth discovery, registration, authorize and token routes answer before
    // everything else, without credentials.
    if (await handleAuthHttp(req, res, url)) return;
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") return await handleMcp(req, res);
    if (url.pathname === "/health") {
      const rep = sandboxReport();
      return json(res, rep.refuse ? 503 : 200, { ok: !rep.refuse, version: VERSION, sandbox: rep.refuse ? "unavailable" : rep.mode, layers: rep.layers, network: config.network, languages: Object.keys(localLanguages()), rea: reaAvailable() });
    }
    if (url.pathname.startsWith("/bridge") && await handleBridgeHttp(req, res, url)) return;
    if (await handleWeb(req, res, url)) return;
    if (url.pathname === "/") {
      const body = "Code Runner MCP server " + VERSION + "\nMCP endpoint: " + config.publicUrl + "/mcp (Streamable HTTP, Authorization: Bearer <key>)\n";
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
  } catch (e) {
    console.error("request failed:", req.method, url.pathname, e && e.message);
    if (!res.headersSent) json(res, 500, { error: "internal error" }); else res.destroy();
  }
});

// Node closes an idle keep-alive connection after 5 s by default. A proxy or
// client that reuses it at that moment loses the request, so stay open longer
// than they do.
httpServer.keepAliveTimeout = 75000;
httpServer.headersTimeout = 80000;

async function main() {
  if (!config.apiKey && !config.allowNoAuth) {
    console.error("MCP_API_KEY is not set. Refusing to start: this server runs code for whoever can reach it.\nSet MCP_API_KEY (a long random string; MCP_PASSWORD is accepted as an alias), or ALLOW_NO_AUTH=1 for a local test.");
    process.exit(1);
  }
  logAuthStatus();
  const rep = await initSandbox();
  console.log("sandbox:", rep.mode, JSON.stringify(rep.layers));
  for (const n of rep.notes || []) console.log("sandbox note:", n);
  console.log("languages:", Object.keys(localLanguages()).join(", "));
  attachBridge(httpServer);
  startScheduler();
  httpServer.listen(config.port, "0.0.0.0", () => console.log("code-runner listening on :" + config.port + "  public " + config.publicUrl));
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(signal + ": saving sessions and stopping");
  stopScheduler();
  httpServer.close();
  // Railway allows a few seconds: save Python sessions, then leave.
  await Promise.race([Promise.all([shutdownRunner().catch(() => {}), shutdownRea().catch(() => {})]), new Promise((r) => setTimeout(r, 8000))]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e && e.stack || e));

main().catch((e) => { console.error(e); process.exit(1); });
