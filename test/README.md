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
