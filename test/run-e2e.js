#!/usr/bin/env node
// Serves the repository, opens test/e2e.html in headless Chrome and prints the
// results. Uses the live internet (CDNs, Compiler Explorer, public proxies).
//
//   node test/run-e2e.js [--settings '{"corsProxy":"https://...&url="}']
//   CHROME=/path/to/chrome node test/run-e2e.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8765;
const settingsArg = process.argv.indexOf("--settings");
const settings = settingsArg > 0 ? process.argv[settingsArg + 1] : "";

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
    try { return execSync("command -v " + c, { encoding: "utf8" }).trim(); } catch (e) {}
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
      else {
        results.push(r);
        console.log((r.ok ? "PASS " : r.live ? "WARN " : "FAIL ") + r.name + " (" + r.ms + " ms)" + (r.ok ? "" : "\n   got: " + JSON.stringify(r.out)));
      }
      res.end("ok");
    });
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : "text/javascript");
  res.end(fs.readFileSync(file));
}).listen(PORT, "127.0.0.1");

const query = [];
if (settings) query.push("settings=" + encodeURIComponent(settings));
if (process.argv.includes("--no-worker")) query.push("noWorker=1");
const url = "http://127.0.0.1:" + PORT + "/test/e2e.html" + (query.length ? "?" + query.join("&") : "");
const chrome = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "cr-e2e-")), url], { stdio: "ignore" });
const timer = setTimeout(() => { console.log("TIMEOUT: e2e run did not finish in time"); finish(); }, (Number(process.env.E2E_TIMEOUT_MIN) || 15) * 60 * 1000);

done.then(() => {
  clearTimeout(timer);
  chrome.kill();
  server.close();
  const failed = results.filter((r) => !r.ok && !r.live).length;
  const warned = results.filter((r) => !r.ok && r.live).length;
  console.log("\n" + results.filter((r) => r.ok).length + " passed, " + failed + " failed, " + warned + " live-network warnings");
  process.exit(failed ? 1 : 0);
});
