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
