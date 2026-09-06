// Minimal local CORS proxy for the browser test: GET /?url=<encoded> -> curl upstream, add CORS headers.
const http = require("http"); const { execFile } = require("child_process");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x").searchParams.get("url");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); return res.end(); }
  execFile("curl", ["-sS", "-L", "--max-time", "20", u], { maxBuffer: 1 << 24 }, (err, out) => {
    res.writeHead(err ? 502 : 200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
    res.end(err ? String(err) : out);
  });
}).listen(8787, "127.0.0.1", () => console.log("proxy on 8787"));
