## Code Runner companion Worker

A private CORS proxy plus a short-lived store for large workspaces, on Cloudflare's free tier
(100,000 requests/day). With it, downloads from websites that block browsers work reliably and big
workspaces are carried between calls without touching public services.

### Deploy

```sh
cd worker
npx wrangler login                                   # opens the browser once (see WSL note below)
npx wrangler kv namespace create STORE               # copy the printed id into wrangler.toml
npx wrangler deploy                                  # prints https://code-runner-proxy.<subdomain>.workers.dev
openssl rand -hex 24 > ~/.config/code-runner/proxy_key && chmod 600 ~/.config/code-runner/proxy_key
tr -d '\n' < ~/.config/code-runner/proxy_key | npx wrangler secret put PROXY_KEY
```

Until `PROXY_KEY` is set every proxy and upload request is refused with `401`.

- **No workers.dev subdomain yet?** `wrangler deploy` stops with "You need to register a workers.dev subdomain".
  Open Workers & Pages in the dashboard once, or register one via the API:
  `curl -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"subdomain":"<name>"}' https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/subdomain`.
- **WSL:** run `npx wrangler login --browser=false`, open the printed link in the Windows browser and approve.
  The page ends on `welcome.developers.workers.dev/wrangler-oauth-consent-granted`; the login is complete at that
  point (confirm with `npx wrangler whoami`).

### Plugin settings

- **Personal CORS proxy**: `https://code-runner-proxy.<subdomain>.workers.dev/?key=<PROXY_KEY>&url=`
- **Workspace store**: `https://code-runner-proxy.<subdomain>.workers.dev/store?key=<PROXY_KEY>`

### This repository's deployment

| Item | Value |
|---|---|
| Worker URL | `https://code-runner-proxy.code-runner-lf.workers.dev` |
| workers.dev subdomain | `code-runner-lf` |
| KV namespace (`STORE`) | `3d287ebe347a4d8d92279ebdf2f20de6` (in `wrangler.toml`) |
| `STORE_TTL` | 86400 s (24 h) |
| `PROXY_KEY` | secret on Cloudflare; local copy in `~/.config/code-runner/proxy_key` (never committed) |

Verified live on 2026-09-15: key enforcement (`401`), CORS preflight, text, byte-exact binary (Google favicon,
550 KB PDF), POST passthrough, target `404` passthrough, store upload / read / delete, and the full browser
end-to-end suite (`node test/run-e2e.js` with both settings).

### Endpoints

| Request | Effect |
|---|---|
| `ANY /?key=KEY&url=<encoded url>` | Proxies the request (method, body, headers) and adds CORS headers. The target's own status is passed through and marked `X-CR-Proxy: 1`. Cookies are neither forwarded nor returned. |
| `POST /store?key=KEY[&ttl=seconds]` | Stores the body (max 24 MB) for `ttl` (default `STORE_TTL`, 24 h) and returns its URL. |
| `GET /store/<id>` / `DELETE /store/<id>` | Reads / deletes a stored blob. The id is random and unguessable, so the key is not needed. |

Requests without the right key get `401`, so nobody else can use the proxy. Rotate the key with
`npx wrangler secret put PROXY_KEY` and update both plugin settings.

### Sites that refuse Cloudflare

Some sites (for example python.org and w3.org) answer requests coming from Cloudflare Workers with `403`.
The Worker passes that status through unchanged; the plugin then also tries the public proxies for reads and
returns the site's `403` only if none of them succeeds.

### Local test

```sh
printf 'PROXY_KEY=local-test-key\n' > .dev.vars
npx wrangler dev --local --port 8791
curl "http://127.0.0.1:8791/?key=local-test-key&url=https%3A%2F%2Fexample.com%2F"
```
