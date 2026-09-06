// Static server + /report sink + a mock paste bin (POST /store -> url; GET/DELETE /store/:id).
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.cwd();
const bin = {}; let seq = 0;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*" };
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const u = req.url.split("?")[0];
  if (req.method === "POST" && u === "/report") { let b = ""; req.on("data", c => b += c); req.on("end", () => { fs.writeFileSync(path.join(ROOT, "report.json"), b); res.writeHead(204, cors); res.end(); }); return; }
  if (req.method === "POST" && u === "/store") { let b = ""; req.on("data", c => b += c); req.on("end", () => { const id = "b" + (++seq); bin[id] = b; res.writeHead(201, cors); res.end("http://127.0.0.1:8080/store/" + id); }); return; }
  const m = u.match(/^\/store\/(b\d+)$/);
  if (m) {
    if (req.method === "DELETE") { delete bin[m[1]]; res.writeHead(200, cors); return res.end("ok"); }
    if (bin[m[1]] === undefined) { res.writeHead(404, cors); return res.end("gone"); }
    res.writeHead(200, cors); return res.end(bin[m[1]]);
  }
  if (u === "/__bincount") { res.writeHead(200, cors); return res.end(String(Object.keys(bin).length)); }
  const f = path.join(ROOT, decodeURIComponent(u));
  fs.readFile(f, (err, data) => { if (err) { res.writeHead(404, cors); return res.end("nf"); } res.writeHead(200, { ...cors, "Content-Type": f.endsWith(".html") ? "text/html" : "application/javascript" }); res.end(data); });
}).listen(8080, "127.0.0.1", () => console.log("serve+bin 8080"));
