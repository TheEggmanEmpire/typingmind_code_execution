# Code Runner MCP server

The Code Runner plugin as a remote MCP server: the AI runs code in a sandboxed workspace on your server, shows
you the results, and can operate your own browser tabs through the companion Chrome extension. One Docker
container, built from this repository's root, made for Railway. Clients: LibreChat, Hermes Agent, and anything
else that speaks MCP over Streamable HTTP.

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md)

## What changed compared with the TypingMind plugin

| Plugin (in the browser) | Server |
|---|---|
| Every call starts in a fresh sandbox; state travels inside the tool output (24 KB inline, costs tokens) | A real folder per user on a volume. Python is a live session: variables stay defined between calls |
| Pyodide: only pure-Python or pre-built packages | Real CPython, Node.js, bash, gcc: any pip or npm package, native code included |
| Other websites only through CORS proxies; no sockets | Direct network access from the code (can be switched off) |
| Output arrives once, at the end; a run cannot outlive its call | Output is streamed as MCP progress; a run that takes long continues as a background job (`job` tool) |
| Nothing runs between chat turns | `schedule` runs code every N minutes or daily |
| Compiled languages only remotely, without files | C and C++ locally with the workspace; R, Go, Rust, Java as build options; the rest still remotely |
| Files shown through data URLs in the chat | Signed links: downloads, interactive preview pages, revocable public shares, an upload page |
| The extension answers the TypingMind page | The extension keeps a paired, outbound link to this server |

## Tools

`run_code`, `job`, `schedule`, `serve_file`, `preview_file`, `manage_files`, `make_image`, `edit_image`,
`browser_state`, `browser_act`, `browser_run`, `browser_tabs`.

## Deploy on Railway

1. **New project -> Deploy from GitHub repo**, pick this repository. Railway finds `railway.json` and builds the
   `Dockerfile` in the repository root. Put the service into a project of its own: the code it runs can reach
   that project's private network.
2. **Variables**: set `MCP_API_KEY` to a long random string (`openssl rand -hex 32`). The server refuses to
   start without it.
3. **Volume**: attach one to this service (any mount path; `/data` is the usual choice). Workspaces, schedules,
   installed packages and revocation lists live there. A volume belongs to one service: another service's
   volume cannot be shared. Without one the server runs, but those are lost on every redeploy.
4. **Networking -> Generate domain**. The server reads `RAILWAY_PUBLIC_DOMAIN` for the links it hands out; with
   a custom domain set `PUBLIC_URL=https://your.domain`.
5. Open `https://<domain>/health`: it reports the sandbox layers that are active on the host.

### Variables

| Variable | Default | Purpose |
|---|---|---|
| `MCP_API_KEY` | required | The one secret: sent as a Bearer key, or typed on the OAuth consent page. `MCP_PASSWORD` is accepted as another name for it |
| `MCP_TOKEN_STORE` | `DATA_DIR/mcp-tokens.json` | Where tokens issued through OAuth are kept (hashed, mode 0600) |
| `MCP_TRUST_PROXY` | off | `1` lets the OAuth addresses follow `X-Forwarded-Host`/`-Proto`; only needed without `PUBLIC_URL` or a Railway domain |
| `PUBLIC_URL` | Railway domain | Base of the links given to the user, and of the OAuth addresses |
| `DATA_DIR` | the volume's mount path, else `/data` | Where data is kept. Only set it to override the attached volume's path |
| `CODE_NETWORK` | `open` | `off` removes network access from the code |
| `CODE_SECRETS` | - | `NAME=value; NAME2=value`: environment variables for the code, replaced by `[secret NAME]` in everything the AI reads |
| `OMNIROUTE_API_KEY` | - | Enables `make_image` / `edit_image` (`OMNIROUTE_BASE_URL` overrides the endpoint) |
| `RUN_TIMEOUT_S` / `MAX_TIMEOUT_S` | 120 / 3600 | Default and highest time limit of one run |
| `WAIT_BUDGET_S` | 45 | A run still going after this many seconds becomes a background job. Keep it below the client's tool timeout |
| `KERNEL_IDLE_MIN` | 30 | An idle Python session is saved and stopped after this |
| `WORKSPACE_QUOTA_MB` / `MAX_FILE_MB` | 2048 / 512 | Size of a workspace and of one file |
| `MAX_JOBS` / `MAX_PROCS` | 4 / 256 | Concurrent runs and processes per workspace |
| `BROWSER_ALLOW_SITES` / `BROWSER_BLOCK_SITES` | - | Sites the browser tools may touch (the extension has its own lists as well) |
| `BRIDGE_LINK_KEY` | on | `off` refuses browsers linked by config file; only per-user pairing codes work then |
| `BROWSER_CONFIRM` | on | Hold buy/pay/delete/send clicks for the user's approval |
| `RESULT_MAX_CHARS` / `RESULT_IMAGE_MAX_KB` | 60000 / 1024 | Budget of one tool result. Longer text is saved under `results/` in the workspace and shortened; larger images are left out with a note |
| `CALL_CEILING_S` | 600 | A tool call that has not answered by then returns an error instead of hanging |
| `SANDBOX` | `auto` | `off` runs code as the server's own user (local testing only) |
| `SERVER_SECRET` | generated on the volume | Signs links |

Build options (service variables on Railway, `--build-arg` elsewhere): `WITH_R=1`, `WITH_GO=1`, `WITH_RUST=1`,
`WITH_JAVA=1`, `EXTRA_APT="pkg ..."`, `EXTRA_PIP="pkg ..."`.

## Connect LibreChat

`librechat.yaml`:

```yaml
mcpServers:
  code-runner:
    type: streamable-http
    url: https://<domain>/mcp
    headers:
      Authorization: "Bearer ${CODE_RUNNER_API_KEY}"
      X-User-ID: "{{LIBRECHAT_USER_ID}}"
    requiresOAuth: false
    serverInstructions: true
    timeout: 120000
```

Put `CODE_RUNNER_API_KEY` into LibreChat's environment. `X-User-ID` gives each LibreChat user a workspace and a
browser link of their own. `timeout` must be above `WAIT_BUDGET_S` (LibreChat's default is 60 s, which is why
long runs turn into background jobs after 45 s).

One workspace per conversation instead of per user (recent LibreChat versions):

```yaml
    requestHeaders:
      X-Workspace: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
```

Per-user API keys for the code (`customUserVars` in LibreChat) can be sent as
`X-Code-Secrets: "MY_KEY={{MY_KEY}}"`.

## Connect claude.ai / other OAuth connectors

Add a custom connector with the URL `https://<domain>/mcp` and no client ID or secret. The connector finds the
OAuth addresses on its own, registers itself and opens a consent page on this server: the key it asks for is
`MCP_API_KEY`. After that the connector holds a token of its own; the key never leaves the server.

Tokens do not expire, are kept on the volume across redeploys and stop working when `MCP_API_KEY` changes.
Scripts that cannot open a browser can trade the key for a token:
`curl -d grant_type=client_credentials -d client_secret=<MCP_API_KEY> https://<domain>/oauth/token`.

## Connect Hermes Agent

`~/.hermes/config.yaml`, then `/reload-mcp`:

```yaml
mcp_servers:
  code_runner:
    url: "https://<domain>/mcp"
    headers:
      Authorization: "Bearer ${CODE_RUNNER_API_KEY}"
    timeout: 120
```

Add `X-User-ID` or `X-Workspace` headers to keep several agents apart; without them everything uses the
workspace `main` of the user `default`.

## REA (reverse engineering)

[REA](https://github.com/morluto/rea) (npm `rea-agents`, about 140 tools) inspects native binaries, JavaScript
and Electron apps, web bundles, .NET assemblies, APKs and websites. It is part of the same MCP endpoint; there
is nothing extra to connect.

- **Two tools by default**: `rea_find` (the catalogue: all tools, a search, or one tool's parameters) and
  `rea_call` (run one). REA's own definitions are over half a megabyte of JSON, which no chat should carry on
  every turn. `REA_TOOLS=full` lists all REA tools directly instead (output schemas are left out either way).
- **Results stay small**: a result above `REA_MAX_CHARS` is saved as `rea/<tool>-<time>.json` in the workspace
  and returned shortened with that file name, so the AI reads the rest with `run_code`. (One REA call can
  return several hundred kilobytes; a chat client cannot send that back to the model.)
- Each workspace gets its own REA process, started on the first REA call and stopped after `REA_IDLE_MIN` idle
  minutes (and on shutdown). It runs in the same sandbox as the model's code, with the workspace as its
  working directory: REA analyses files the user uploaded or the code produced (relative paths such as
  `app/` or `dist/main.js` resolve there). Its cache and settings live in the workspace's hidden `.cr/rea/`.
- Works out of the box: static JavaScript / Electron (`.asar`) / web-bundle / source-map analysis, .NET metadata,
  plists, artifact inventories, saved HAR captures. Native decompilation (Ghidra + JDK, IDA, Hopper), Android
  (JADX + JDK), firmware (binwalk) and browser capture (a Chrome-family browser) need their engines in the image:
  add them with `EXTRA_APT` where Debian packages them.
- The image installs REA pinned (`WITH_REA=1`, `REA_VERSION=6.2.0` build arguments; `WITH_REA=0` leaves it out).
  `/health` reports `"rea": true` when the tools are offered.

| Variable | Default | Purpose |
|---|---|---|
| `REA` | `1` | `0` leaves the REA tools out |
| `REA_TOOLS` | `compact` | `full` lists every REA tool instead of `rea_find` / `rea_call` |
| `REA_MAX_CHARS` | 20000 | Longer REA results are saved to a workspace file and shortened |
| `REA_COMMAND` | `rea mcp` | REA's stdio MCP command line, e.g. `node /opt/rea/node_modules/rea-agents/scripts/rea.mjs mcp`. A tool folder outside `/usr` is made readable to the sandbox automatically |
| `REA_IDLE_MIN` | 15 | An idle REA process is stopped after this |
| `REA_CALL_TIMEOUT_S` | 300 | Limit of one REA tool call |

## Your files

Attachments in a chat do not reach an MCP server. Ask the AI for the upload page (`manage_files`, action
`upload_link`): a link to a page where you drop files (they land in `uploads/`) and download anything from the
workspace. `serve_file` and `preview_file` return links you can open directly; a `share` link is public and
can be revoked.

## Link your browser

1. Load the `extension/` folder of this repository in Chrome (`chrome://extensions`, Developer mode, Load unpacked).
2. Put a `config.json` next to its `manifest.json` with the server address and the link key, then reload the
   extension:

   ```json
   { "server": "https://<domain>", "key": "<link key>" }
   ```

   The link key is derived from the access key; `extension/README.md` has the one-line command that prints it.

That is all: the extension connects by itself whenever Chrome runs, and the browser tools work at once. No
pairing code, nothing to repeat after a redeploy. A browser linked this way serves every user of the server who
has no browser of their own paired; set `BRIDGE_LINK_KEY=off` to allow only per-user pairing, which works through
a one-time code the AI shows (see `extension/README.md`).

The extension connects out to the server; nothing listens on your machine. Its own allowed/blocked site lists,
the confirmation of risky actions and the switch for running scripts are enforced in the extension and cannot be
changed by the server. Details: [`extension/README.md`](../extension/README.md).

## Security

What the server runs is written by a model, so it is treated as hostile.

- **Access**: every MCP request needs the API key (`Authorization: Bearer`, `X-API-Key` or HTTP Basic) or a
  token issued through OAuth (authorization code with PKCE, or client credentials). Keys are compared in
  constant time; after three wrong keys an address waits, longer with each further miss, up to 30 seconds.
  Issued tokens are stored only as hashes, and changing the key invalidates them all. Links for the user carry
  a signed token naming one workspace and, except for the workspace page, one file.
- **Sandbox**: each run goes through a small launcher (`sandbox/crbox.c`) that applies what the host permits,
  probed at startup and shown at `/health` and by `manage_files` (action `status`): an own unix user per
  workspace, resource limits, no-new-privileges, Landlock filesystem rules, a seccomp syscall filter, and
  mount/pid namespaces through bubblewrap. The code gets a scrubbed environment: none of the server's
  variables, only `CODE_SECRETS`.
- **Files**: the server reads and writes workspace files as the workspace's own user, so a symlink planted by
  the code cannot make it serve or overwrite anything else. Served files carry a sandboxing
  Content-Security-Policy.
- **Browser**: pairing uses a one-time code; the device token is stored hashed; site lists and confirmations
  are enforced in the extension.

Limits you should know:

- This is isolation inside one container on a shared kernel, not a virtual machine. A kernel exploit, or a
  host that permits none of the optional layers, leaves less between the code and the server. Check `/health`
  after deploying. For mutually distrusting users, run one deployment per user or use a microVM sandbox service.
- With `CODE_NETWORK=open` the code can reach the internet and the Railway project's private network. Keep the
  service in a project of its own, or set `CODE_NETWORK=off`.
- Disk use is checked before each run, not enforced by the kernel; one run can overshoot the quota.
- `X-User-ID` is trusted because only your MCP client holds the API key. Anyone with the key can act as any user.

## When a chat stalls

Every tool call writes one line to the server log: tool, workspace, duration, size of the answer, and whether it
was cut or failed (never content). A chat client that receives a tool result too large to pass on to the model
usually just stops, so every result goes through one size guard before it leaves the server, whichever tool
made it.

## Develop

```sh
cd server && npm install
sh sandbox/build.sh
MCP_API_KEY=dev DATA_DIR=/tmp/cr-data node src/index.js
npm test
```

`src/legacy.js` loads the plugin's `implementation.js` to reuse its preview pages, remote compilers, notebook
export and image routes, so those stay identical in both versions.
