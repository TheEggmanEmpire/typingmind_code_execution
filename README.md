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
