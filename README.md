## Code Runner

Lets the AI run code, work with your files and show you the results. 35 languages, no API key, no server of your own required.

| Where | Languages | Internet | Files (`/workspace`) | Variables kept between calls |
|---|---|---|---|---|
| In your browser (WASM) | **python** (Pyodide, Python 3.13), **javascript**, **typescript**, **sql** (SQLite), **duckdb** (DuckDB), **r** (webR), **ruby** (ruby.wasm) | yes, over HTTP (not Ruby) | yes, shared by all of them | Python and R variables, DuckDB tables, JS `storage` |
| Compiler Explorer (godbolt.org) | c, c++, rust, go, java, kotlin, csharp, fsharp, swift, zig, d, haskell, ocaml, perl, lua, dart, fortran, pascal, crystal, julia, cobol, ada, objc | no | no | no |
| Wandbox (best effort) | bash, php, scala, nim, elixir | no | no | no |

Six functions:

- **run_code** runs a program and returns its output to the AI.
- **preview_file** shows a file to you as an interactive page: CSV, TSV, JSON, Excel (with a formulas toggle),
  Parquet and SQLite as sortable, filterable tables; HTML pages and charts rendered live; Markdown, Word, PowerPoint
  and Jupyter notebooks rendered; audio and video with players; images and PDFs.
- **serve_file** shows a file in the chat: images inline, small text as a code block, anything else
  (PDF, XLSX, ZIP, ...) as a download link.
- **manage_files** lists, deletes, renames or clears the files in `/workspace` without running code, and exports
  the session as a Jupyter notebook (`export_notebook`).
- **browser_run** runs JavaScript in one of *your own open browser tabs* and returns the value plus console output:
  read the page, click, fill forms, scroll, change the view. Needs the companion extension (below).
- **browser_tabs** lists / activates / opens / closes / reloads / navigates your tabs. Needs the companion extension.

The contents of files you are shown never pass through the AI's context.

### Helpers in your code

- **`chart(data, x, y, kind, title, path)`** (Python, R, JavaScript) writes an interactive chart page (Vega-Lite:
  zoom, tooltips, PNG/SVG export) from a DataFrame, dict or list of rows; `kind` is line, bar, barh, scatter, area,
  pie, donut or histogram, and `y` can list several columns. The AI then shows it with `preview_file`.
- **`share_table(name, df)` / `get_table(name)` / `list_tables()`** (Python, R; `tables.set/get/list` in
  JavaScript) pass tables between languages. A shared table is also a DuckDB view of the same name.
- **`read_text(path)`** (Python) returns the text of a PDF, Word, PowerPoint, Excel or HTML file.

### Your files

Files you attach to a message are saved to `/workspace/uploads/` automatically, so you can say "analyse the
attached spreadsheet" and the code finds it at `uploads/<name>`. Each attachment is imported once; if the code
changes it, later calls keep the changed copy. The AI can also write text you paste into the chat straight to a
file (the `files` parameter) instead of copying it into the code.

### Browser control (optional, Chrome desktop only)

`run_code` runs in a locked-down sandbox with no access to your tabs. To let the AI read and drive the pages you
actually have open, load the small companion extension in the [`extension/`](extension/) folder:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `extension/` folder.
2. Reload your TypingMind tab. `browser_run` and `browser_tabs` now work.

It runs the AI's script through the browser's debugger, so it works even on strict-CSP sites and captures the real
console; Chrome shows a "started debugging" banner while a script runs. It is **Chrome/Chromium desktop only**, and
while enabled any page you visit can drive your tabs through it, so keep it on only while you need it. See
[`extension/README.md`](extension/README.md) for details, scope and safety.

### Secrets

Put API keys the code may use into the **Secrets** setting (`NAME=value; NAME2=value`). They become environment
variables (`os.environ`, `Sys.getenv`, `ENV`, `env` in JavaScript). Their values are replaced by `[secret NAME]` in
everything the AI reads, are never saved with the workspace (variables or files containing one are dropped from
the carry, with a note), are not kept in the run history, and requests carrying them (also URL-encoded) never go
through public proxies. Values shorter than 6 characters are refused.

### Recommended setup (5 minutes, free)

Deploy the small companion Cloudflare Worker from the `worker/` folder of this plugin's repository
(see `worker/README.md`), then set:

- **Personal CORS proxy**: `https://<worker>.<account>.workers.dev/?key=<PROXY_KEY>&url=`
- **Workspace store**: `https://<worker>.<account>.workers.dev/store?key=<PROXY_KEY>`

Why: browsers only let a page read other websites that explicitly allow it (CORS), and most don't. The proxy makes
downloads from those sites reliable. The store carries workspaces above 24 KB (datasets, charts, saved variables)
between calls privately. Without it, everything still runs, but files that don't fit the inline limit are not
kept for the next call (the AI is told which ones).

### How it runs

- Every call starts fresh (TypingMind runs each plugin call in a new sandbox). Files in `/workspace` are carried to
  the next call, and so is the state of the interpreters: Python variables, functions, classes and imports,
  R objects and attached packages, and DuckDB tables. `reset: true` starts a call without that saved state; files stay.
- The in-browser languages run in a background worker. A run that exceeds its time limit (default 120 s,
  **Run time limit** setting or a per-call `timeout`) is stopped cleanly: the output printed so far is kept and
  `/workspace` is returned to its state before the call.
- Output is capped at 40,000 characters (start and end are kept) so a runaway print cannot flood the AI's context.
- After each run a short note tells the AI which files were created, changed or deleted.
- Errors come back as short, actionable messages: cleaned Python tracebacks, JavaScript errors with line numbers,
  TypeScript type errors, compiler messages, the list of files that do exist when a file is missing, and a hint when
  a package or input is missing.

### Python

- numpy, pandas, scipy, matplotlib, scikit-learn, pillow, requests, beautifulsoup4, lxml and the rest of
  Pyodide's packages load automatically from the imports.
- Common pure-Python packages (yaml, docx, pptx, openpyxl, tabulate, markdown, faker, ...) install automatically too;
  anything else: `packages: ["name"]`. Packages with native code must be part of Pyodide.
- Open matplotlib figures are saved as `/workspace/figure_N.png` after the run, ready for serve_file or preview_file.
- `input()` reads the `stdin` parameter. Top-level `await` works.
- Variables are pickled after each run; functions and classes defined at the top level are kept by their source.
  Things that cannot be saved (open files, generators, database connections) are skipped, and the AI is told when
  a value it may need was not kept.

### Ruby

Ruby 3.4 with its standard library runs in the browser (ruby.wasm, about 30 MB on first use): `/workspace` is the
working directory, `gets` reads `stdin`, the last expression's value is shown. No internet or gems, and variables
are not kept. With `compiler_version` or `compiler_args`, or when ruby.wasm cannot load, Ruby runs on Compiler
Explorer instead.

### R

- R 4.6 via [webR](https://docs.r-wasm.org/webr/). `library(x)`, `require(x)` and `x::f` install packages from the
  webR repository automatically (ggplot2, dplyr, jsonlite and most of CRAN that builds for WebAssembly).
- The working directory is `/workspace`. Plots are saved as `rplot_N.png`. `readline()` reads `stdin`.
- Objects are kept between calls and packages that were attached are attached again.
- If webR cannot be downloaded, the code runs on Wandbox instead (base R only, no files).

### DuckDB

- SQL over files: `SELECT * FROM 'uploads/sales.csv'`, `read_parquet('data.parquet')`, `read_json_auto(...)`.
- `COPY (SELECT ...) TO 'result.csv' (HEADER)` or `(FORMAT parquet)` writes a file into `/workspace`.
- Tables and views are kept between calls. Each statement's result is shown (up to 500 rows each).

### SQL (SQLite)

SQLite on `/workspace/data.sqlite`; Python sees the same database with `sqlite3.connect('data.sqlite')`.
Delete the file to start over. Results show up to 500 rows per statement.

### JavaScript and TypeScript

- A browser worker, not Node.js: `fetch`, `fs` (async, paths relative to `/workspace`: `readFile`, `writeFile`,
  `appendFile`, `readdir`, `exists`, `stat`, `mkdir`, `rm`, `rename`, `copyFile`, `list`, `download(url, name)`),
  `storage.get/set` (JSON values kept between calls), `stdin`, `sleep(ms)`.
- Libraries: `await import('https://cdn.jsdelivr.net/npm/<package>/+esm')` or `await importScripts(url)`.
- TypeScript is compiled with Babel (types stripped). With `typecheck: true` it is first checked with the real
  TypeScript compiler in strict mode (TypeScript 6.0, about 9 MB on first use); type errors are reported with line
  numbers and the code does not run.

### Compiled and remote languages

Single-file programs with a normal `main`, input via `stdin`, a run-time limit of a few seconds, no network or files.

- `compiler_args` passes flags (`-O2 -std=c++20`, `--edition 2024`, ...); they replace the matching defaults.
- `compiler_version` picks a version (`13` for gcc 13, `clang 18`, `1.80` for Rust); an unknown version returns the
  list of available ones.
- Compile errors, runtime errors and exit codes are reported. A `public class` in Java is accepted as-is. If a pinned
  compiler is retired, a current one is picked automatically; if Compiler Explorer is down, Wandbox is tried.

### Internet access

- Python: `requests`, `urllib.request`, `pyodide.http.pyfetch`. JavaScript: `fetch`, `fs.download`. R: `download.file`
  and `url()` work for sites that allow browser access.
- Requests go straight from the browser first. If the browser blocks one, it is retried through GitHub's raw file
  mirror (for github.com links), your personal proxy, then public proxies. A host that fails every route is
  remembered for 3 minutes so later requests fail fast, and the output names each unreachable host.
- Requests carrying credentials are only ever sent through your own proxy: Authorization, cookie and API-key/token
  headers, and URLs or form/JSON bodies with fields such as `key`, `api_key`, `token`, `password` or `secret`.
- A wrong key in the personal proxy setting is reported as such instead of silently falling back.
- A few sites refuse requests from cloud providers (python.org, w3.org, ...). When your proxy gets such a
  403/429/503 for a read, the public proxies are tried as well before that answer is returned.
- **Allow public CORS proxies** `off` keeps every request on your own proxy.
- No raw sockets, DNS or ping: the runtime lives inside the browser tab.

### Persistence between calls

`/workspace` (including the SQLite database and the saved variables in `.cr/`) and JavaScript `storage` are
compressed and attached to the tool output as a hidden `[[cr-state:...]]` marker that the next call reads back.

- Up to 24 KB compressed travels inline (**Inline workspace limit**). It costs tokens, so keep it small.
- Larger workspaces are uploaded to your **Workspace store** (in parts when above the store's 24 MB limit, up to
  150 MB in total); only a pointer travels. The store's key is never
  written into the chat, so a shared chat does not expose the files.
- Without a store, larger workspaces are not uploaded anywhere unless you turn on **Allow public temporary stores**
  (litterbox.catbox.moe, pastes.dev, dpaste.com: anyone with the link can read the data until it expires).
- Saved variables get a budget (a third of the inline limit without a store) so they never push real files out.
- An unchanged workspace is not uploaded again, and earlier uploads are left to expire rather than deleted, so
  editing or regenerating an earlier message still finds its files.
- When something cannot be carried, the largest files are dropped first and the AI is told exactly which ones.
- Program output and file contents cannot fake this marker: any `[[cr-state:` they contain is neutralised, so only
  the plugin's own marker is ever read back.

### Session notebook

Each in-browser run is recorded (code, and the start of its output, with secrets removed). `manage_files` with
`action: export_notebook` writes them as `notebook.ipynb` (Python cells runnable, other languages as annotated
blocks) or Markdown, ready for `serve_file` or `preview_file`.

### What is not possible here

TypingMind runs each plugin call in a sandboxed frame with an opaque (`null`) origin and returns its output once:
there is no browser storage to cache packages in (the browser's HTTP cache still speeds up repeat downloads),
no way to stream partial output while a run is going, and nothing that runs between chat turns, so scheduled runs
are out of reach. Lua and PHP stay remote: the in-browser Lua has no file access and the PHP runtime needs
`crypto.subtle`, which the sandbox lacks.

### Security notes

- Code runs inside TypingMind's sandboxed iframe (no access to your TypingMind data) and, normally, in a Web Worker
  inside it. The engine's own state, including the personal proxy URL with its key, is kept out of reach of the
  code it runs, and results travel over a private channel the code cannot write to.
- If the browser cannot start a worker, code runs on the page thread instead: the time limit then stops code that is
  waiting (network, sleep) but not a CPU-bound endless loop, and the engine is not isolated from the code.

### Settings

| Setting | Default | Purpose |
|---|---|---|
| Personal CORS proxy | - | Reliable downloads from sites that block browsers |
| Workspace store | - | Private carry of large workspaces |
| Run time limit (seconds) | 120 | Stops runaway code |
| Persist workspace between calls | on | Carry `/workspace` and `storage` |
| Inline workspace limit (KB) | 24 | Size carried inside the output |
| Offload large workspaces | on | Upload bigger workspaces to the store |
| Allow public temporary stores | off | Public paste services for large workspaces when no store is set |
| Allow public CORS proxies | on | Public proxies for sites that block browsers (never for credentialed requests) |
| Keep variables between calls | on | Save Python/R variables and DuckDB tables |
| Import attached files | on | Save the user's attachments to `/workspace/uploads` |
| Secrets | - | API keys for code, as environment variables (redacted, never saved) |
| Offloaded workspace lifetime (minutes) | 1440 | Older offloaded workspaces are not restored |
| HTTP request timeout (ms) | 30000 | Per request, before fallbacks |
| Pyodide CDN / sql.js CDN | - | Put a mirror in front of the built-in CDN lists |

For a fully private setup: deploy the Worker, set both of its URLs, and turn **Allow public CORS proxies** off.

### Development

`implementation.js` is the plugin code; `node build.js` regenerates `plugin.json` (tool descriptions, schema,
the usage guide the AI always sees, and this README). Tests live in `test/` (see `test/README.md`) and
`worker/test.mjs`.
