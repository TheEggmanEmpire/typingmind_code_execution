## Tests

### Node harness (fast, offline except Pyodide wheels)

Runs the real plugin code in Node against real Pyodide, sql.js, Babel and the TypeScript 6 compiler. Node has no Web Worker, so this
exercises the in-thread engine. Every external service (CORS proxies, blob stores, Compiler Explorer, Wandbox)
is mocked, and each call runs in a simulated fresh sandbox fed the previous output, like TypingMind.

```sh
cd test && npm i && node node-harness.js
```

Covers Python/JavaScript/TypeScript/SQL behaviour, the shared workspace, the network fallback chain
(public proxy, personal proxy, GitHub mirror, credential guard for headers/URLs/bodies, public proxies off,
rejected proxy key, dead-host memo, timeouts, sync XHR), persistence (inline, private store with key, public
stores opt-in, unchanged-workspace reuse, dropping large files, expiry, v1 trailers), the fake-trailer defence,
saved Python variables (data, functions, classes, imports, reset, off), the `files` parameter, attachments,
TypeScript `typecheck`, compiler flags and versions, serve_file, preview_file, manage_files, the remote runners
(compile errors, timeouts, retired compilers, Wandbox fallback) and that run_code always returns an explanation
instead of throwing.

R (webR) and DuckDB need a real browser; the end-to-end test covers them.

### Browser end-to-end (real Chrome, real Web Worker, live internet)

Opens `test/e2e.html` in headless Chrome. Every call runs in a fresh `<iframe sandbox="allow-scripts">`
(opaque origin, like TypingMind), so this is the authoritative test for the Worker path, time limits,
CORS fallbacks, dynamic imports, Compiler Explorer, R, DuckDB, TypeScript type checking, saved variables,
the engine's isolation from user code, serve_file, preview_file and manage_files.

```sh
node test/run-e2e.js                 # Web Worker path
node test/run-e2e.js --no-worker     # in-thread fallback (time-limit steps skipped)
node test/run-e2e.js --only "duckdb|r "   # only the steps whose name matches

# against the deployed companion Worker (adds personal-proxy and workspace-store steps)
W=https://code-runner-proxy.code-runner-lf.workers.dev; K=$(tr -d '\n' < ~/.config/code-runner/proxy_key)
node test/run-e2e.js --settings "{\"corsProxy\":\"$W/?key=$K&url=\",\"workspaceStore\":\"$W/store?key=$K\"}"
```

Steps that depend on third-party services report `WARN` instead of `FAIL` when they fail.
`E2E_TIMEOUT_MIN` overrides the 15-minute overall limit.

### Companion Worker

See `worker/README.md` for a local `wrangler dev` check of the proxy and store.

### Browser bridge (real Chrome, loads the companion extension)

Loads `extension/` unpacked into headless Chromium and drives `browser_run` / `browser_tabs`
from a sandboxed iframe (like TypingMind), proving the postMessage↔extension bridge reaches the
sandboxed frame and that scripts run in the page, capture console, and return values.

```sh
node test/run-browser-e2e.js
CHROME=/path/to/chrome node test/run-browser-e2e.js
```

Needs a Chrome/Chromium that supports unpacked extensions in `--headless=new` (Chrome 130+).
