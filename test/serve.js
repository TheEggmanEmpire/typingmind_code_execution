// Static server + POST /report sink for the sandbox harness.
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.cwd();  // run from the repo root
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let b = ""; req.on("data", (c) => b += c); req.on("end", () => { fs.writeFileSync(path.join(ROOT, "report.json"), b); res.writeHead(204); res.end(); });
    return;
  }
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "application/javascript" }); res.end(data);
  });
}).listen(8080, "127.0.0.1", () => console.log("serve 8080"));
