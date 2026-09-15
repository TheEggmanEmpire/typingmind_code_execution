## Code Runner

Lets the AI run code and hand files back to you. 34 languages, no API key, no server of your own required.

| Where | Languages | Internet | Files (`/workspace`) |
|---|---|---|---|
| In your browser (WASM) | **python** (Pyodide, Python 3.13), **javascript**, **typescript**, **sql** (SQLite) | yes, over HTTP | yes, shared and kept between calls |
| Compiler Explorer (godbolt.org) | c, c++, rust, go, java, kotlin, csharp, fsharp, swift, zig, d, haskell, ocaml, ruby, perl, lua, dart, fortran, pascal, crystal, julia, cobol, ada, objc | no | no |
| Wandbox (best effort) | bash, php, r, scala, nim, elixir | no | no |

Two functions:

- **run_code** runs a program and returns its output to the AI.
- **serve_file** shows a file from `/workspace` to you in the chat: images inline, small text as a code block,
  anything else (PDF, XLSX, ZIP, ...) as a download link. The bytes never pass through the AI's context.

### Recommended setup (5 minutes, free)

Browsers only let a page read other websites that explicitly allow it (CORS). Most don't, and the free public
CORS proxies that used to work around this are nearly all gone. For reliable downloads, deploy the small
companion Cloudflare Worker from the `worker/` folder of this plugin's repository (see `worker/README.md`),
then set:

- **Personal CORS proxy**: `https://<worker>.<account>.workers.dev/?key=<PROXY_KEY>&url=`
- **Workspace store**: `https://<worker>.<account>.workers.dev/store?key=<PROXY_KEY>`

Without the Worker everything still runs; downloads from sites that block browsers fall back to a few public
proxies (text usually works, binary files often don't), and large workspaces use public temporary stores.

### How it runs

- Every call starts fresh (TypingMind runs each plugin call in a new sandbox). **Variables do not survive
  between calls; files in `/workspace` do.**
- Python, JavaScript, TypeScript and SQL run in a background worker. A run that exceeds its time limit
  (default 120 s, **Run time limit** setting or a per-call `timeout`) is stopped cleanly: the output printed so far
  is kept and `/workspace` is returned to its state before the call. The chat never freezes.
- Output is capped at 40,000 characters (start and end are kept) so a runaway print cannot flood the AI's context.
- Errors come back as short, actionable messages: cleaned Python tracebacks, JavaScript errors with line numbers,
  compiler messages, the list of files that do exist when a file is missing, and a hint when a package or
  input is missing.

### Python

- numpy, pandas, scipy, matplotlib, scikit-learn, pillow, requests, beautifulsoup4, lxml and the rest of
  Pyodide's packages load automatically from the imports.
- Common pure-Python packages (yaml, docx, pptx, openpyxl, tabulate, markdown, faker, ...) install automatically too;
  anything else: `packages: ["name"]`. Packages with native code must be part of Pyodide.
- Open matplotlib figures are saved as `/workspace/figure_N.png` after the run, ready for serve_file.
- `input()` reads the `stdin` parameter. Top-level `await` works.

### JavaScript and TypeScript

- A browser worker, not Node.js: `fetch`, `fs` (async, paths relative to `/workspace`: `readFile`, `writeFile`,
  `appendFile`, `readdir`, `exists`, `stat`, `mkdir`, `rm`, `rename`, `copyFile`, `list`, `download(url, name)`),
  `storage.get/set` (JSON values kept between calls), `stdin`, `sleep(ms)`.
- Libraries: `await import('https://cdn.jsdelivr.net/npm/<package>/+esm')` or `await importScripts(url)`.
- TypeScript is compiled with Babel first (types are stripped, not checked).

### SQL

SQLite on `/workspace/data.sqlite`; Python sees the same database with `sqlite3.connect('data.sqlite')`.
Delete the file to start over.

### Compiled and remote languages

Single-file programs with a normal `main`, input via `stdin`, a run-time limit of a few seconds, no network or files.
Compile errors, runtime errors and exit codes are reported. A `public class` in Java is accepted as-is. If a pinned
compiler is retired, a current one is picked automatically; if Compiler Explorer is down, Wandbox is tried.

### Internet access

- Python: `requests`, `urllib.request`, `pyodide.http.pyfetch`. JavaScript: `fetch`, `fs.download`.
- Requests go straight from the browser first. If the browser blocks one, it is retried through GitHub's raw file
  mirror (for github.com links), your personal proxy, then public proxies. A host that fails every route is
  remembered for 3 minutes so later requests fail fast, and the output names each unreachable host.
- Requests carrying credentials (Authorization, API-key or cookie headers) are only ever sent through your own proxy.
- A few sites refuse requests from cloud providers (python.org, w3.org, ...). When your proxy gets such a
  403/429/503 for a read, the public proxies are tried as well before that answer is returned.
- No raw sockets, DNS or ping: the runtime lives inside the browser tab.

### Persistence between calls

`/workspace` (including the SQLite database) and JavaScript `storage` are compressed and attached to the tool output
as a hidden `[[cr-state:...]]` marker that the next call reads back.

- Up to 24 KB compressed travels inline (**Inline workspace limit**).
- Larger workspaces are uploaded to the **Workspace store**; only a pointer travels. Without a store of your own,
  public temporary stores are used (litterbox.catbox.moe for 24 h, pastes.dev, dpaste.com), which means anyone with
  the link can read the data. Set **Offload large workspaces** to `off` to never upload.
- An unchanged workspace is not uploaded again.
- When something cannot be carried, the largest files are dropped first and the AI is told exactly which ones.

### Settings

| Setting | Default | Purpose |
|---|---|---|
| Personal CORS proxy | - | Reliable downloads from sites that block browsers |
| Workspace store | - | Private carry of large workspaces |
| Run time limit (seconds) | 120 | Stops runaway Python/JS/SQL |
| Persist workspace between calls | on | Carry `/workspace` and `storage` |
| Inline workspace limit (KB) | 24 | Size carried inside the output |
| Offload large workspaces | on | Upload bigger workspaces to a store |
| Offloaded workspace lifetime (minutes) | 1440 | Older offloaded workspaces are not restored |
| HTTP request timeout (ms) | 30000 | Per request, before fallbacks |
| Pyodide CDN / sql.js CDN | - | Put a mirror in front of the built-in CDN lists |

### Development

`implementation.js` is the plugin code; `node build.js` regenerates `plugin.json` (descriptions, schema, README).
Tests live in `test/` (see `test/README.md`).
