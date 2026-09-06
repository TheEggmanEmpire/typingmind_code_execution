// Chained CONNECT proxy: refuses BLOCK hosts, forwards everything else to the agent proxy.
const net = require("net"), http = require("http");
const PORT = +process.argv[2], BLOCK = (process.argv[3] || "").split(",").filter(Boolean);
const UP = { host: "127.0.0.1", port: 39425 };
http.createServer((req, res) => { res.writeHead(405); res.end(); }).on("connect", (req, sock, head) => {
  const host = req.url.split(":")[0];
  if (BLOCK.includes(host)) { sock.end("HTTP/1.1 502 Blocked for test\r\n\r\n"); return; }
  const up = net.connect(UP, () => {
    up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    if (head.length) up.write(head);
    sock.pipe(up); up.pipe(sock);
  });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
}).listen(PORT, "127.0.0.1", () => console.log("blockproxy", PORT, BLOCK.join(",")));
