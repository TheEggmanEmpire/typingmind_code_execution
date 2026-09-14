## Code Runner companion Worker

A private CORS proxy plus a short-lived store for large workspaces, on Cloudflare's free tier
(100,000 requests/day). With it, downloads from websites that block browsers work reliably and big
workspaces are carried between calls without touching public services.

### Deploy

```sh
cd worker
npx wrangler login                                   # opens the browser once
npx wrangler kv namespace create STORE               # copy the printed id into wrangler.toml
openssl rand -hex 24                                 # your PROXY_KEY - keep it
npx wrangler secret put PROXY_KEY                    # paste the key when asked
npx wrangler deploy                                  # prints https://code-runner-proxy.<account>.workers.dev
```

### Plugin settings

- **Personal CORS proxy**: `https://code-runner-proxy.<account>.workers.dev/?key=<PROXY_KEY>&url=`
- **Workspace store**: `https://code-runner-proxy.<account>.workers.dev/store?key=<PROXY_KEY>`

### Endpoints

| Request | Effect |
|---|---|
| `ANY /?key=KEY&url=<encoded url>` | Proxies the request (method, body, headers) and adds CORS headers. The target's own status is passed through and marked `X-CR-Proxy: 1`. Cookies are neither forwarded nor returned. |
| `POST /store?key=KEY[&ttl=seconds]` | Stores the body (max 24 MB) for `ttl` (default `STORE_TTL`, 24 h) and returns its URL. |
| `GET /store/<id>` / `DELETE /store/<id>` | Reads / deletes a stored blob. The id is random and unguessable, so the key is not needed. |

Requests without the right key get `401`, so nobody else can use the proxy. Rotate the key with
`npx wrangler secret put PROXY_KEY` and update the plugin settings.

### Local test

```sh
printf 'PROXY_KEY=local-test-key\n' > .dev.vars
npx wrangler dev --local --port 8791
curl "http://127.0.0.1:8791/?key=local-test-key&url=https%3A%2F%2Fexample.com%2F"
```
