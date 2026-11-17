// Links for the user: downloads, interactive previews, public shares and a
// workspace page with upload. Nothing here needs the API key: each link carries
// a signed token that names one workspace (and, except for the workspace page,
// one file).
//
//   /f/<token>/<name>   the file itself (kind "f"), or a public share (kind "s")
//   /p/<token>/<name>   interactive preview page (tables, charts, documents, media)
//   /w/<token>/         workspace page: list, download, upload
//
// Files are written by model-run code, so every response is sandboxed with a CSP:
// a served HTML page runs in an opaque origin and cannot reach this server's
// other pages or the visitor's storage.

import crypto from "node:crypto";
import { config } from "./config.js";
import { signToken, verifyToken, getWorkspace } from "./sessions.js";
import { wsfs } from "./sandbox.js";
import { legacy } from "./legacy.js";

const DAY = 86400;
const LINK_DAYS = 30;       // download and preview links
const PAGE_DAYS = 7;        // workspace page
const UPLOAD_MAX = Math.min(config.maxFileMb, 200) * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const seg = (name) => encodeURIComponent(String(name).split("/").pop() || "file");

function tokenFor(ws, kind, extra, days) {
  return signToken({ w: ws.id, u: ws.user, n: ws.name, k: kind, e: days ? now() + days * DAY : 0, ...extra });
}

export function fileUrl(ws, rel, { download = false, name } = {}) {
  const t = tokenFor(ws, "f", { p: rel, ...(download ? { d: 1 } : {}), ...(name ? { fn: name } : {}) }, LINK_DAYS);
  return config.publicUrl + "/f/" + t + "/" + seg(name || rel);
}
export function previewUrl(ws, rel, as) {
  const t = tokenFor(ws, "p", { p: rel, ...(as && as !== "auto" ? { as } : {}) }, LINK_DAYS);
  return config.publicUrl + "/p/" + t + "/" + seg(rel);
}
export function workspaceUrl(ws) {
  return config.publicUrl + "/w/" + tokenFor(ws, "w", {}, PAGE_DAYS) + "/";
}

// A share is a link that can be revoked: it is honoured only while its id is
// still listed in the workspace's metadata.
export function shareUrl(ws, rel, hours) {
  const id = crypto.randomBytes(6).toString("base64url");
  const h = Math.min(Math.max(Number(hours) || 0, 0), 24 * 365);
  const exp = h ? now() + Math.round(h * 3600) : 0;
  const shares = (ws.meta.shares ||= {});
  shares[id] = { path: rel, created: Date.now(), exp };
  ws.saveMeta();
  const t = signToken({ w: ws.id, u: ws.user, n: ws.name, k: "s", p: rel, i: id, e: exp });
  return { id, url: config.publicUrl + "/f/" + t + "/" + seg(rel), expires: exp ? new Date(exp * 1000).toISOString() : null };
}
export function unshare(ws, idOrRel) {
  const shares = ws.meta.shares || {};
  let n = 0;
  for (const [id, s] of Object.entries(shares)) {
    if (idOrRel === "all" || id === idOrRel || s.path === idOrRel) { delete shares[id]; n++; }
  }
  if (n) ws.saveMeta();
  return n;
}
export function listShares(ws) {
  const out = [];
  for (const [id, s] of Object.entries(ws.meta.shares || {})) {
    if (s.exp && s.exp < now()) continue;
    out.push({ id, path: s.path, created: s.created, expires: s.exp ? new Date(s.exp * 1000).toISOString() : null });
  }
  return out;
}

// ---- responses ---------------------------------------------------------------
const SANDBOX_CSP = "sandbox allow-scripts allow-downloads allow-popups allow-forms allow-modals";
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    ...headers
  });
  res.end(buf);
}
const plain = (res, status, text) => send(res, status, text + "\n", { "Content-Type": "text/plain; charset=utf-8" });

function workspaceOf(token, kind) {
  const p = verifyToken(token, kind);
  if (!p || !p.u || !p.n) return null;
  const ws = getWorkspace(p.u, p.n);
  return ws.id === p.w ? { ws, p } : null;
}

function contentDisposition(name, attachment) {
  const base = String(name).split("/").pop() || "file";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return (attachment ? "attachment" : "inline") + '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(base);
}

// Types a browser may render in place. Everything else downloads.
function inlineable(mime) {
  return /^(image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)|audio\/|video\/|text\/|application\/(pdf|json|xml))/.test(mime);
}

async function serveFile(req, res, ws, p) {
  let bytes;
  try { bytes = await wsfs.read(ws, p.p, { maxBytes: config.maxFileMb * 1024 * 1024 }); }
  catch (e) { return plain(res, e.code === "ENOENT" ? 404 : 400, e.code === "ENOENT" ? "This file no longer exists in the workspace." : "The file cannot be served: " + e.message); }
  let mime = legacy.guessMime(p.p);
  if (/^text\//.test(mime) || mime === "application/json") mime += "; charset=utf-8";
  const headers = {
    "Content-Type": mime,
    "Content-Disposition": contentDisposition(p.fn || p.p, !!p.d || !inlineable(mime)),
    "Content-Security-Policy": SANDBOX_CSP,
    "Accept-Ranges": "bytes"
  };
  // Media players seek with Range requests.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(bytes.length - Number(m[2]), 0);
    let end = m[1] && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) return send(res, 416, "", { "Content-Range": "bytes */" + bytes.length });
    return send(res, 206, bytes.subarray(start, end + 1), { ...headers, "Content-Range": "bytes " + start + "-" + end + "/" + bytes.length });
  }
  return send(res, 200, req.method === "HEAD" ? "" : bytes, headers);
}

async function servePreview(res, ws, p) {
  let bytes;
  try { bytes = await wsfs.read(ws, p.p, { maxBytes: config.previewMaxBytes }); }
  catch (e) {
    if (e.code === "ETOOBIG") return plain(res, 413, "This file is too large to preview. Use the download link instead.");
    return plain(res, e.code === "ENOENT" ? 404 : 400, e.code === "ENOENT" ? "This file no longer exists in the workspace." : "The file cannot be previewed: " + e.message);
  }
  const mime = legacy.guessMime(p.p);
  const kind = legacy.previewKind(p.p, mime, p.as || "auto");
  const html = legacy.previewHtml(p.p.split("/").pop(), mime, kind, new Uint8Array(bytes));
  return send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SANDBOX_CSP });
}

// ---- workspace page ------------------------------------------------------------
const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#16181d;--mut:#667085;--line:#e3e6ec;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e8eaf0;--mut:#98a2b3;--line:#262b36;--acc:#6ea8fe}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 20px;color:var(--mut)}
.drop{border:2px dashed var(--line);border-radius:12px;padding:26px;text-align:center;background:var(--card);cursor:pointer}
.drop.over{border-color:var(--acc)}.drop b{color:var(--acc)}#status{min-height:22px;margin:10px 2px;color:var(--mut)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
td,th{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--mut);font-size:13px}
tr:last-child td{border-bottom:0}td.n{word-break:break-all}td.s,td.t{white-space:nowrap;color:var(--mut)}td.a{white-space:nowrap}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}.empty{padding:22px;text-align:center;color:var(--mut)}
`;
const PAGE_JS = `
const drop=document.getElementById('drop'),pick=document.getElementById('pick'),status=document.getElementById('status');
async function send(files){
  for(const f of files){
    status.textContent='Uploading '+f.name+' ...';
    const r=await fetch('upload?name='+encodeURIComponent(f.name),{method:'POST',body:f});
    if(!r.ok){status.textContent='Upload of '+f.name+' failed: '+(await r.text());return;}
  }
  status.textContent='Done. Reloading ...';location.reload();
}
drop.addEventListener('click',()=>pick.click());
pick.addEventListener('change',()=>send([...pick.files]));
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');send([...e.dataTransfer.files]);});
`;

async function workspacePage(res, ws) {
  const files = (await wsfs.list(ws)).filter((f) => !f.path.startsWith(".cr/") && !f.link);
  const rows = files.map((f) => {
    const mime = legacy.guessMime(f.path);
    const kind = legacy.previewKind(f.path, mime, "auto");
    return "<tr><td class=n>" + esc(f.path) + "</td><td class=s>" + esc(legacy.fmtSize(f.size)) + "</td><td class=t>" + esc(new Date(f.mtime).toISOString().slice(0, 16).replace("T", " ")) +
      "</td><td class=a>" + (kind !== "download" ? '<a href="' + esc(previewUrl(ws, f.path)) + '" target="_blank" rel="noopener">open</a> &middot; ' : "") +
      '<a href="' + esc(fileUrl(ws, f.path, { download: true })) + '">download</a></td></tr>';
  }).join("");
  const html = "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><meta name=robots content=noindex>" +
    "<title>Workspace files</title><style>" + PAGE_CSS + "</style></head><body><main><h1>Workspace files</h1>" +
    "<p class=sub>Files the AI works with. Uploads land in <code>uploads/</code>; tell the AI the file name.</p>" +
    "<div class=drop id=drop><b>Choose files</b> or drop them here<input id=pick type=file multiple hidden></div><div id=status></div>" +
    (rows ? "<table><tr><th>File</th><th>Size</th><th>Changed (UTC)</th><th></th></tr>" + rows + "</table>" : "<div class=empty>No files yet.</div>") +
    "</main><script>" + PAGE_JS + "</script></body></html>";
  // Our own page: scripts only from this document, requests only back to this page.
  return send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("too large"), { code: "ETOOBIG" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function upload(req, res, ws, url) {
  // Only this page may post here: a cross-site form or script cannot.
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return plain(res, 403, "Uploads are accepted from the workspace page only.");
  const raw = String(url.searchParams.get("name") || "").split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, "").trim();
  const rel = wsfs.safeRel("uploads/" + raw);
  if (!raw || raw.startsWith(".") || !rel) return plain(res, 400, "That file name cannot be used.");
  if ((await wsfs.usage(ws)) > config.quotaMb * 1024 * 1024) return plain(res, 507, "The workspace is full (" + config.quotaMb + " MB). Delete files first.");
  let body;
  try { body = await readBody(req, UPLOAD_MAX); }
  catch (e) { return plain(res, 413, "The file is larger than " + Math.round(UPLOAD_MAX / 1048576) + " MB."); }
  await wsfs.write(ws, rel, body);
  return plain(res, 200, "saved " + rel);
}

// Returns true when the request was one of ours.
export async function handleWeb(req, res, url) {
  const m = /^\/([fpw])\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!m) return false;
  const [, route, token, rest = ""] = m;
  try {
    if (route === "w") {
      const hit = workspaceOf(token, "w");
      if (!hit) { plain(res, 403, "This workspace link is invalid or has expired. Ask the AI for a new one (manage_files, action upload_link)."); return true; }
      if (rest === "upload" && req.method === "POST") await upload(req, res, hit.ws, url);
      else if (rest === "" && (req.method === "GET" || req.method === "HEAD")) await workspacePage(res, hit.ws);
      else plain(res, 404, "Not found.");
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { plain(res, 405, "Method not allowed."); return true; }
    if (route === "p") {
      const hit = workspaceOf(token, "p");
      if (!hit) plain(res, 403, "This preview link is invalid or has expired.");
      else await servePreview(res, hit.ws, hit.p);
      return true;
    }
    let hit = workspaceOf(token, "f");
    if (!hit) {
      hit = workspaceOf(token, "s");
      const share = hit && (hit.ws.meta.shares || {})[hit.p.i];
      if (!share || share.path !== hit.p.p) hit = null;   // revoked
    }
    if (!hit) plain(res, 403, "This link is invalid, has expired or was revoked.");
    else await serveFile(req, res, hit.ws, hit.p);
  } catch (e) {
    if (!res.headersSent) plain(res, 500, "The file could not be served."); else res.destroy();
  }
  return true;
}
