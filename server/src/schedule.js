// Scheduled runs: code that runs between chat turns. A schedule belongs to a
// workspace, is stored in its server-side metadata (so the code cannot edit its
// own timetable) and each run appends its output to schedules/<name>.log in the
// workspace, where a later chat can read it.

import { config } from "./config.js";
import { allWorkspaces } from "./sessions.js";
import { wsfs } from "./sandbox.js";
import * as runner from "./runner.js";

export const MAX_SCHEDULES = 10;
export const MIN_INTERVAL_MIN = 5;
const TICK_MS = 30000;
const LOG_MAX = 512 * 1024;       // each log keeps its newest half megabyte
const OUT_MAX = 20000;            // per run, in the log

let timer = null;
const running = new Set();        // "<ws id>/<name>": never two runs of one schedule at once

const all = (ws) => (ws.meta.schedules ||= {});
export const list = (ws) => Object.values(ws.meta.schedules || {});

function nextRun(s, from) {
  if (s.dailyAt) {
    const [h, m] = s.dailyAt.split(":").map(Number);
    const d = new Date(from);
    d.setUTCHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  return from + s.everyMin * 60000;
}

async function appendLog(ws, name, entry) {
  const rel = "schedules/" + name + ".log";
  let prev = "";
  try { prev = (await wsfs.read(ws, rel, { maxBytes: 4 * LOG_MAX })).toString("utf8"); } catch (e) {}
  let out = prev + entry;
  if (out.length > LOG_MAX) out = "(older entries removed)\n" + out.slice(out.length - LOG_MAX / 2).replace(/^[^\n]*\n/, "");
  await wsfs.write(ws, rel, Buffer.from(out, "utf8"));
}

async function runOnce(ws, s) {
  const key = ws.id + "/" + s.name;
  if (running.has(key)) return "skipped: the previous run is still going";
  running.add(key);
  const started = new Date();
  let summary;
  try {
    // A scheduled run only ever sees the operator's secrets: per-request ones are not stored.
    const first = await runner.runCode(ws, { language: s.language, code: s.code, timeout: s.timeout, background: true, fresh: true, record: false, secrets: {} });
    let body = first.text || "";
    // No job id means the run was refused (too many jobs, quota, shutting down): that is not "done".
    let state = first.jobId ? "done" : "refused";
    if (first.jobId) {
      const limit = Date.now() + (s.timeout || config.runTimeoutS) * 1000 + 15000;
      for (;;) {
        const r = await runner.jobOutput(ws, first.jobId, { waitMs: 30000, since: 0 });
        body = r.text; state = r.job.state;
        if (state !== "running" || Date.now() > limit) break;
      }
      if (state === "running") { runner.killJob(ws, first.jobId); state = "timeout"; }
    }
    summary = state;
    await appendLog(ws, s.name, "=== " + started.toISOString() + "  " + state + " ===\n" + (body.length > OUT_MAX ? body.slice(0, OUT_MAX) + "\n... (output cut)" : body).replace(/\s+$/, "") + "\n\n");
  } catch (e) {
    summary = "failed: " + String(e && e.message || e).slice(0, 200);
    try { await appendLog(ws, s.name, "=== " + started.toISOString() + "  failed ===\n" + summary + "\n\n"); } catch (e2) {}
  } finally {
    running.delete(key);
  }
  const cur = all(ws)[s.name];
  if (cur) { cur.lastRun = started.getTime(); cur.lastState = summary; cur.runs = (cur.runs || 0) + 1; ws.saveMeta(); }
  return summary;
}

async function tick() {
  const now = Date.now();
  for (const ws of allWorkspaces()) {
    for (const s of list(ws)) {
      if (s.next > now) continue;
      s.next = nextRun(s, now);
      ws.saveMeta();
      runOnce(ws, s).catch(() => {});
    }
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref();
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

const when = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
function describe(s) {
  return s.name + "  " + s.language + "  " + (s.dailyAt ? "daily at " + s.dailyAt + " UTC" : "every " + s.everyMin + " min") + "  next " + when(s.next) +
    (s.lastRun ? "  last " + when(s.lastRun) + " (" + s.lastState + ", " + s.runs + " run" + (s.runs === 1 ? "" : "s") + ")" : "  not run yet");
}

export async function tool(args, ctx, { text, fail }) {
  const ws = ctx.ws;
  const action = String(args.action || "list").toLowerCase();
  if (action === "list") {
    const items = list(ws);
    return text(items.length ? "Schedules:\n" + items.map(describe).join("\n") + "\n\nOutput of each run is appended to schedules/<name>.log in the workspace." : "No schedules in this workspace.");
  }
  const name = String(args.name || "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return fail("`name` is required: 1-40 letters, digits, - or _.");
  const have = all(ws)[name];
  if (action === "delete") {
    if (!have) return fail("No schedule `" + name + "`. Existing: " + (Object.keys(all(ws)).join(", ") || "none") + ".");
    delete all(ws)[name];
    ws.saveMeta();
    return text("Schedule " + name + " was deleted. Its log schedules/" + name + ".log is kept.");
  }
  if (action === "run") {
    if (!have) return fail("No schedule `" + name + "`.");
    const state = await runOnce(ws, have);
    return text("Ran " + name + " now: " + state + ". Output is at the end of schedules/" + name + ".log.");
  }
  if (action !== "create") return fail("Unknown action \"" + args.action + "\". Use create, list, delete or run.");

  if (!have && list(ws).length >= MAX_SCHEDULES) return fail("This workspace already has " + MAX_SCHEDULES + " schedules. Delete one first.");
  const language = String(args.language || "").trim().toLowerCase();
  if (!runner.allLanguages().includes(language)) return fail("`language` is required, one of: " + Object.keys(runner.localLanguages()).join(", ") + ".");
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) return fail("`code` is required: the program to run each time.");
  const s = { name, language, code, created: Date.now(), runs: 0 };
  if (args.daily_at != null && String(args.daily_at).trim()) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(args.daily_at).trim());
    if (!m) return fail("`daily_at` must be a UTC time such as \"07:30\".");
    s.dailyAt = m[1].padStart(2, "0") + ":" + m[2];
  } else {
    const n = Number(args.every_minutes);
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MIN) return fail("Pass `every_minutes` (at least " + MIN_INTERVAL_MIN + ") or `daily_at` (\"HH:MM\", UTC).");
    s.everyMin = Math.min(Math.round(n), 60 * 24 * 31);
  }
  if (args.timeout != null) s.timeout = Math.min(Math.max(Number(args.timeout) || config.runTimeoutS, 1), config.maxTimeoutS);
  s.next = nextRun(s, Date.now());
  all(ws)[name] = s;
  ws.saveMeta();
  return text((have ? "Replaced" : "Created") + " schedule " + describe(s) + "\nEach run starts fresh and appends its output to schedules/" + name + ".log. Test it now with action run.");
}
