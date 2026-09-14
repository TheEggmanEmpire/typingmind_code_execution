## Tests

### Node harness (fast, offline except Pyodide wheels)

Runs the real plugin code in Node against real Pyodide, sql.js and Babel. Node has no Web Worker, so this
exercises the in-thread engine. Every external service (CORS proxies, blob stores, Compiler Explorer, Wandbox)
is mocked, and each call runs in a simulated fresh sandbox fed the previous output, like TypingMind.

```sh
cd test && npm i && node node-harness.js
```

Covers Python/JavaScript/TypeScript/SQL behaviour, the shared workspace, the network fallback chain
(public proxy, personal proxy, GitHub mirror, credential guard, dead-host memo, timeouts, sync XHR),
persistence (inline, private store, public store, unchanged-workspace reuse, dropping large files, expiry,
v1 trailers), serve_file, the remote runners (compile errors, timeouts, retired compilers, Wandbox fallback)
and that run_code always returns an explanation instead of throwing.

### Browser end-to-end (real Chrome, real Web Worker, live internet)

Opens `test/e2e.html` in headless Chrome. Every call runs in a fresh `<iframe sandbox="allow-scripts">`
(opaque origin, like TypingMind), so this is the authoritative test for the Worker path, time limits,
CORS fallbacks, dynamic imports, Compiler Explorer and serve_file.

```sh
node test/run-e2e.js
node test/run-e2e.js --settings '{"corsProxy":"https://<worker>.workers.dev/?key=KEY&url="}'
```

Steps that depend on third-party services report `WARN` instead of `FAIL` when they fail.

### Companion Worker

See `worker/README.md` for a local `wrangler dev` check of the proxy and store.
