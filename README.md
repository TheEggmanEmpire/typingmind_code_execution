## Code Runner (multi-language)

Runs code in 12 languages and returns the output to the AI. No API key. No server.

- **python** - Pyodide (WASM, in-browser). numpy/pandas auto-load from imports; other PyPI packages via `packages` (see below).
- **javascript** - runs in the plugin sandbox.
- **sql** - SQLite via sql.js (WASM, in-browser).
- **c, c++, rust, go, ruby, java, csharp, haskell, lua** - Compiler Explorer (godbolt.org) public API.

First Python call takes ~5-15 s while the runtime downloads. Java: do not declare the class `public`.

### CDN fallback

Runtimes are fetched from a list of CDNs in order; the first one that answers wins. A CDN that fails or
stalls (30 s for the loader script, 180 s for the runtime download) is skipped.

- Pyodide: `cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `gcore.jsdelivr.net` → `testingcf.jsdelivr.net` →
  `unpkg.com` (core runtime only; wheels are still fetched from jsDelivr).
- sql.js: `cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `unpkg.com` → `gcore.jsdelivr.net`.
- The optional **Pyodide CDN** / **sql.js CDN** plugin settings put a self-hosted or regional mirror first.
- Works in a plain page and in a Web Worker (no DOM), so the same code runs in desktop, mobile and headless browsers.

Toolchains (Compiler Explorer): gcc 14.2, rustc 1.82, Go 1.26, Ruby 4.0, JDK 25, .NET 9 (Mono), GHC 9.8, Lua 5.5.

### Python packages

- numpy, pandas, scipy, matplotlib, requests and other packages Pyodide ships auto-load from `import` lines.
- Anything else: pass `packages: ["beautifulsoup4", "pyyaml"]` (micropip) or install inline with
  `import micropip; await micropip.install("pkg")`.
- Installs are temporary: they live in the in-browser runtime for the session and vanish on page reload.
- Pure-Python wheels and Pyodide-prebuilt packages only. Packages with native code that Pyodide does not build cannot be installed.

### Internet access

- **python**: `requests`, `urllib.request` (via pyodide-http) and `pyodide.http.pyfetch` all work.
- **javascript**: `fetch` works.
- Requests go straight from the browser. If the target does not allow CORS, the request is **automatically
  retried through a list of ~10 built-in public CORS proxies** (corsproxy.io, allorigins, codetabs, cors.eu.org,
  thingproxy, cors.sh, ...), so cross-origin downloads work with no configuration. The first proxy that answers wins.
- Proxies are used **only** for a request that failed directly, never for requests carrying credentials
  (Authorization/cookie), and only while a run is executing. Traffic through any proxy is visible to its operator.
- The optional **CORS proxy override** setting puts your own proxy first (prefix like `https://corsproxy.io/?url=`,
  or any URL containing `{url}`); the built-ins remain as further fallbacks.
- There is no container behind the runner: Python runs as WASM inside the browser tab. Raw sockets, DNS and ping
  do not exist there. Emscripten hands out fake `172.29.x.x` addresses and every `connect()` fails with
  `Host is unreachable`, so socket-level probes prove nothing. HTTP through the browser is the only path.
- Compiler Explorer languages run in godbolt's sandbox: no network.

### Temporary storage

`/workspace` is an in-memory (WASM MEMFS) scratch directory that lives until the page reloads.
It is shared by all three in-browser runtimes and, by default, is **carried across separate tool calls**:

- **python** starts in `/workspace`; anything written there is available in later calls.
- **javascript** gets `fs` (`await fs.readFile / writeFile / appendFile / readdir / exists / unlink / mkdir / stat`)
  on the same directory, plus `storage.get/set/has/delete/keys/clear` for plain values.
- **sql** keeps its database across calls. Once Python has loaded, the database is mirrored to
  `/workspace/data.sqlite`, so `sqlite3.connect('data.sqlite')` in Python sees the same tables and SQL sees Python's writes.
  Deleting `data.sqlite` resets the SQL database.

### How persistence works

TypingMind runs every plugin call in a brand-new sandboxed iframe, so nothing in memory survives on its own.
To keep `/workspace`, the SQL database and JS `storage` alive between calls, the plugin serializes them
(deflate-compressed) and appends a hidden `[[cr-state:...]]` trailer to its output; the next call reads that
trailer back from `previousRunOutput` and rebuilds the workspace before running.

- Default budget is 24 KB compressed. Larger workspaces are not carried; a note tells the model to finish in one call or delete big files.
- Turn it off with the **Persist workspace between calls** setting, or raise the cap with **Max carried workspace size (KB)**.
- The trailer counts against the model's token budget, so keep scratch data small.

### Large workspaces (ephemeral bin offload)

The inline trailer is capped (default 24 KB compressed) because it costs tokens. When the workspace is bigger
and **Offload large workspaces** is on (default), the plugin uploads the compressed snapshot to a public
ephemeral paste bin and carries only a small pointer (URL + delete handle + expiry) in the output; the next
call downloads it and rebuilds the workspace.

- **Three built-in bins, tried in order:** `paste.rs` → `dpaste.com` → `sprunge.us`. The first that accepts the
  upload (and reads back identically) wins.
- **~10-minute lifetime:** a 10-minute logical expiry is enforced (an older pointer is ignored), and every new
  snapshot deletes the previous blob, so at most one blob exists during an active chain. Exact server-side
  deletion timing depends on the bin.
- **Privacy:** your `/workspace` bytes leave the browser to that public service. Set **Offload large workspaces**
  to `off` to keep everything inline, or set **Workspace store endpoint** to your own paste-style server
  (POST body → returns read URL; GET returns it; DELETE removes it) to keep large state private. Your own
  endpoint is tried before the public bins.
- Small workspaces still travel inline with no upload.

### Limits & how files move

`/workspace` holds **as many files as you want** - there is no file-count limit. What varies is scope:

- **Within one `run_code` call:** limited only by the browser tab's memory (WASM MEMFS) - tens to a few
  hundred MB on desktop, less on mobile, on top of Pyodide's ~30 MB. Nothing is uploaded. Heavy multi-file
  work (download several files, edit, zip) is best done inside a single call.
- **Persisting between separate calls:** the whole workspace is snapshotted (compressed). ≤ the inline limit
  (default 24 KB compressed) rides in the output as tokens; larger snapshots are offloaded to an ephemeral
  bin whose own upload cap then applies (public bins allow roughly a few hundred KB to a couple MB; your own
  `workspaceStore` endpoint lifts that).

**Two separate "uploads" - don't confuse them:**

- **`serve_file` uploads nothing.** It embeds the file as a `data:` URI directly in the chat message. That is
  the only "serving" path.
- **The bin offload is not serving.** It uploads the workspace snapshot solely to carry it from one tool call
  to the next (the sandbox is destroyed between calls), and only when the snapshot exceeds the inline limit.

### Serving files back to the user

The plugin has a second function, **`serve_file`**, that renders a `/workspace` file straight into the chat
for the user, without the bytes passing through the model's context. Images show inline; anything else becomes
a download link (a `data:` URL).

Typical flow — *load from the internet → edit in temp → serve to the user*:

1. `run_code` (python or javascript): fetch a file and save it to `/workspace`.
2. `run_code`: edit it (crop the image, filter the CSV, rewrite the HTML, ...).
3. `serve_file` with the file's path: the user sees/downloads the result.

```
run_code(javascript): const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
                      await fs.writeFile('photo.jpg', b);
run_code(python):     from PIL import Image; im = Image.open('photo.jpg'); im.rotate(90).save('rotated.jpg')
serve_file(path='rotated.jpg')     # rendered inline to the user
```

`serve_file` params: `path` (required), optional `filename`, `mime`, and `as` (`auto` | `image` | `link` | `text`).
It reads the carried workspace, so it works right after the `run_code` call that produced the file.

Example: *Use run_code to compute the first 20 primes in Rust.*
