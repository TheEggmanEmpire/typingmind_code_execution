#!/usr/bin/env node
// Loads the unpacked extension/ into headless Chromium and drives the plugin's
// browser_run / browser_tabs tools from a sandboxed iframe (like TypingMind),
// proving the postMessage <-> extension bridge reaches the sandboxed frame.
//
//   node test/run-browser-e2e.js
//   CHROME=/path/to/chrome node test/run-browser-e2e.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const PORT = 8766;

// Branded Chrome ignores --load-extension since version 137: prefer a Chrome for
// Testing / Chromium build (Playwright installs one).
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = path.join(os.homedir(), ".cache", "ms-playwright");
  const fromPw = fs.existsSync(pw) ? fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .flatMap((d) => ["chrome-linux64/chrome", "chrome-linux/chrome"].map((f) => path.join(pw, d, f))) : [];
  const guesses = [...fromPw, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "chromium", "chromium-browser", "google-chrome", "chrome"];
  for (const c of guesses) {
    try { if (c.startsWith("/")) { fs.accessSync(c, fs.constants.X_OK); return c; } return execSync("command -v " + c, { encoding: "utf8" }).trim(); } catch (e) {}
  }
  throw new Error("Chrome/Chromium not found; set CHROME=/path/to/chrome");
}

// A copy of the extension with 127.0.0.1 as trusted host (localhost stays
// untrusted, for the refusal test).
const EXT_COPY = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ext-"));
for (const f of fs.readdirSync(EXT)) fs.copyFileSync(path.join(EXT, f), path.join(EXT_COPY, f));
fs.writeFileSync(path.join(EXT_COPY, "config.json"), JSON.stringify({ trustedHosts: ["127.0.0.1"] }));

const results = [];
let untrusted = null;
let finish;
const done = new Promise((r) => (finish = r));

const server = http.createServer((req, res) => {
  if (req.url === "/report-untrusted" && req.method === "POST") {
    let body = ""; req.on("data", (d) => (body += d)).on("end", () => { untrusted = JSON.parse(body); res.end("ok"); });
    return;
  }
  if (req.url === "/untrusted-result") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(untrusted)); }
  if (req.url === "/report" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      const r = JSON.parse(body);
      if (r.done) finish();
      else { results.push(r); console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "\n   got: " + JSON.stringify(r.out))); }
      res.end("ok");
    });
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : "text/javascript");
  res.end(fs.readFileSync(file));
}).listen(PORT);

const url = "http://127.0.0.1:" + PORT + "/test/browser-e2e.html";
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bridge-"));
const chrome = spawn(findChrome(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-first-run",
  "--user-data-dir=" + userDir,
  "--disable-extensions-except=" + EXT_COPY,
  "--load-extension=" + EXT_COPY,
  url
], { stdio: "ignore" });

const timer = setTimeout(() => { console.log("TIMEOUT: browser e2e did not finish in time"); finish(); }, (Number(process.env.E2E_TIMEOUT_MIN) || 8) * 60 * 1000);

done.then(() => {
  clearTimeout(timer);
  chrome.kill();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed || !results.length ? 1 : 0);
});
