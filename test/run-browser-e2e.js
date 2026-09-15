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

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const guesses = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "google-chrome", "chromium", "chromium-browser", "chrome"
  ];
  for (const c of guesses) {
    try { if (c.startsWith("/")) { fs.accessSync(c, fs.constants.X_OK); return c; } return execSync("command -v " + c, { encoding: "utf8" }).trim(); } catch (e) {}
  }
  throw new Error("Chrome/Chromium not found; set CHROME=/path/to/chrome");
}

const results = [];
let finish;
const done = new Promise((r) => (finish = r));

const server = http.createServer((req, res) => {
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
}).listen(PORT, "127.0.0.1");

const url = "http://127.0.0.1:" + PORT + "/test/browser-e2e.html";
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bridge-"));
const chrome = spawn(findChrome(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-first-run",
  "--user-data-dir=" + userDir,
  "--disable-extensions-except=" + EXT,
  "--load-extension=" + EXT,
  url
], { stdio: "ignore" });

const timer = setTimeout(() => { console.log("TIMEOUT: browser e2e did not finish in time"); finish(); }, (Number(process.env.E2E_TIMEOUT_MIN) || 3) * 60 * 1000);

done.then(() => {
  clearTimeout(timer);
  chrome.kill();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed || !results.length ? 1 : 0);
});
