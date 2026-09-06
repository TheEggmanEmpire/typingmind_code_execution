## Browser test

Runs the real plugin code in headless Chromium against the live Pyodide/sql.js CDNs and httpbin.org,
including the CORS-proxy fallback (through a throwaway local proxy).

```sh
node test/corsproxy.js &                      # local CORS proxy on 127.0.0.1:8787
chromium --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=240000 --dump-dom "file://$PWD/test/browser.html" | grep -A22 RESULTS
```

Expected: every `py_*`/`js_*`/`sql_*` entry prints a value, the `*_via_proxy` entries start with `<!doctype html>`,
`py_cors_blocked_no_proxy` is `ERR ConnectionError`, both `global_fetch_*` guards report `blocked`,
and `py_socket_probe` shows a fake `172.29.x.x` address (sockets do not exist in the browser).

The page also reports `pyodide_cdn` / `sqljs_cdn`, the CDN that actually served each runtime.

### Simulating a CDN outage

`blockproxy.js` is a CONNECT proxy that refuses the listed hosts and forwards everything else
(to an upstream proxy at 127.0.0.1:39425 by default; edit `UP` if you have none). Point Chromium at it:

```sh
node test/blockproxy.js 8791 cdn.jsdelivr.net &
chromium --headless=new --disable-gpu --allow-file-access-from-files \
  --proxy-server=http://127.0.0.1:8791 --proxy-bypass-list="127.0.0.1;localhost" \
  --virtual-time-budget=240000 --dump-dom "file://$PWD/test/browser.html" | grep -A24 RESULTS
```

Expected with only `cdn.jsdelivr.net` blocked: identical results, `*_cdn` show `fastly.jsdelivr.net`.
With all four jsDelivr hosts blocked: runtimes come from `unpkg.com`; plain Python, files, SQL and JS
work, and imports of wheel packages (requests, sqlite3, numpy, ...) fail with a note explaining why.

### Sandbox model test (state carry)

`sandbox-harness.html` reproduces TypingMind's real execution model: each call runs in a fresh
`<iframe sandbox="allow-scripts allow-modals">` via srcdoc, and only the previous output is fed back as
`previousRunOutput`. It proves files, the SQL database and JS storage survive between separate calls, and
that a deleted `data.sqlite` stays gone.

```sh
node test/serve.js &     # static server on 127.0.0.1:8080 (+ /report sink)
chromium --headless=new --disable-gpu --virtual-time-budget=240000 \
  --dump-dom "http://127.0.0.1:8080/test/sandbox-harness.html"
```


### Node unit harness

`node-harness.js` runs the plugin logic under Node against real Pyodide/sql.js, with a fake fetch/XHR
and a simulated fresh-sandbox wipe. It covers persistence, the CDN fallback, fetch retry/proxy, and
serve_file. Setup:

```sh
cd test && npm i pyodide@0.29.4 sql.js@1.13.0 && node node-harness.js
```

(The browser harness above is the authoritative end-to-end test; this one is faster for logic checks.)
