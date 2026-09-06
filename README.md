## Code Runner (multi-language)

Runs code in 12 languages and returns the output to the AI. No API key. No server.

- **python** - Pyodide (WASM, in-browser). numpy/pandas auto-load from imports; other PyPI packages via `packages` (see below).
- **javascript** - runs in the plugin sandbox.
- **sql** - SQLite via sql.js (WASM, in-browser).
- **c, c++, rust, go, ruby, java, csharp, haskell, lua** - Compiler Explorer (godbolt.org) public API.

First Python call takes ~5-15 s while the runtime downloads. Java: do not declare the class `public`.

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
- Requests go straight from the browser, so the target must allow CORS. If it does not, set the optional
  **CORS proxy** plugin setting (e.g. `https://corsproxy.io/?url=`, or any URL containing `{url}`).
  The proxy is only used for requests that failed directly. Traffic through it is visible to the proxy operator.
- Compiler Explorer languages run in godbolt's sandbox: no network.

### Temporary storage

`/workspace` is an in-memory (WASM MEMFS) scratch directory that lives until the page reloads.
It is shared by all three in-browser runtimes:

- **python** starts in `/workspace`; anything written there is available in later calls.
- **javascript** gets `fs` (`await fs.readFile / writeFile / appendFile / readdir / exists / unlink / mkdir / stat`)
  on the same directory, plus `storage.get/set/has/delete/keys/clear` for plain values.
- **sql** keeps its database across calls. Once Python has loaded, the database is mirrored to
  `/workspace/data.sqlite`, so `sqlite3.connect('data.sqlite')` in Python sees the same tables and SQL sees Python's writes.
  Deleting `data.sqlite` resets the SQL database.

Example: *Use run_code to compute the first 20 primes in Rust.*
