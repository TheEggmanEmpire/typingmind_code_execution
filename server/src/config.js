// Configuration: everything comes from environment variables (Railway service
// variables). Nothing here is ever passed to the code the model runs.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;
const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(Math.max(n, min), max) : d;
};
const flag = (v, d) => (v === undefined || v === "" ? d : !/^(0|off|false|no)$/i.test(String(v).trim()));

// "NAME=value; NAME2=value" (also newline separated). Values shorter than 6
// characters are refused: redacting them would mangle ordinary output.
export function parseSecrets(raw) {
  const out = {};
  for (const part of String(raw || "").split(/[;\n]+/)) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v.length >= 6) out[k] = v;
  }
  return out;
}

// "node /opt/rea/rea.mjs mcp" -> argv; double or single quotes keep spaces inside one argument.
export function splitCommand(raw) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(raw || "")))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const port = num(env.PORT, 8080, 1, 65535);
const dataDir = path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || "/data");

function publicUrl() {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return "https://" + env.RAILWAY_PUBLIC_DOMAIN;
  return "http://localhost:" + port;
}

// Signs file links and pairing codes. Kept on the volume so links survive a
// redeploy; SERVER_SECRET overrides it.
function serverSecret() {
  if (env.SERVER_SECRET && env.SERVER_SECRET.length >= 16) return env.SERVER_SECRET;
  const file = path.join(dataDir, ".secret");
  // A short or empty file (a failed first write, a stray `touch`) must never
  // become the signing key: anyone could forge links with it.
  try { const have = fs.readFileSync(file, "utf8").trim(); if (have.length >= 32) return have; } catch (e) {}
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + ".tmp", s, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  return s;
}

export const config = {
  port,
  dataDir,
  publicUrl: publicUrl(),
  apiKey: env.MCP_API_KEY || env.MCP_PASSWORD || "",
  allowNoAuth: flag(env.ALLOW_NO_AUTH, false),
  get secret() { return (this._secret ||= serverSecret()); },

  // Execution
  runTimeoutS: num(env.RUN_TIMEOUT_S, 120, 1, 86400),        // default limit of one run
  maxTimeoutS: num(env.MAX_TIMEOUT_S, 3600, 1, 86400),       // highest per-call `timeout`
  waitBudgetS: num(env.WAIT_BUDGET_S, 45, 5, 3600),          // a run still going after this becomes a background job
  kernelIdleMin: num(env.KERNEL_IDLE_MIN, 30, 1, 1440),      // idle Python kernels are saved and stopped
  maxJobs: num(env.MAX_JOBS, 4, 1, 64),                      // concurrent runs per workspace
  outputHead: 30000,
  outputTail: 10000,

  // Sandbox
  sandbox: /^(off)$/i.test(env.SANDBOX || "") ? "off" : "auto",
  network: /^(off)$/i.test(env.CODE_NETWORK || "") ? "off" : "open",
  uidBase: num(env.SANDBOX_UID_BASE, 370000, 1000, 4000000000),
  quotaMb: num(env.WORKSPACE_QUOTA_MB, 2048, 1, 1048576),
  maxFileMb: num(env.MAX_FILE_MB, 512, 1, 1048576),
  maxProcs: num(env.MAX_PROCS, 256, 8, 65536),

  // Code-visible secrets (environment variables in the code, redacted from output)
  codeSecrets: parseSecrets(env.CODE_SECRETS),

  // Images (make_image / edit_image)
  omnirouteKey: env.OMNIROUTE_API_KEY || "",
  omnirouteBase: (env.OMNIROUTE_BASE_URL || "").replace(/\/+$/, ""),

  // Browser bridge defaults (the extension's own lists always apply as well)
  browserAllow: String(env.BROWSER_ALLOW_SITES || "").split(/[\s,;]+/).filter(Boolean),
  browserBlock: String(env.BROWSER_BLOCK_SITES || "").split(/[\s,;]+/).filter(Boolean),
  browserConfirm: flag(env.BROWSER_CONFIRM, true),
  browserHighlight: flag(env.BROWSER_HIGHLIGHT, true),

  // REA (reverse engineering): its tools are part of /mcp; one REA process per workspace
  rea: flag(env.REA, true),
  reaCommand: splitCommand(env.REA_COMMAND || "rea mcp"),       // full command line of REA's stdio MCP server
  reaIdleMin: num(env.REA_IDLE_MIN, 15, 1, 1440),              // an idle REA process is stopped after this
  // "compact" (default): two tools, rea_find and rea_call, instead of REA's ~140 tool
  // definitions (over half a megabyte of schemas in every model request). "full" lists them all.
  reaTools: /^full$/i.test(env.REA_TOOLS || "") ? "full" : "compact",
  reaMaxChars: num(env.REA_MAX_CHARS, 20000, 2000, 1000000),   // longer REA results are saved to a file and shortened
  reaCallTimeoutS: num(env.REA_CALL_TIMEOUT_S, 300, 5, 86400), // limit of one forwarded REA call

  serveMaxBytes: 20 * 1024 * 1024,
  previewMaxBytes: 15 * 1024 * 1024
};
