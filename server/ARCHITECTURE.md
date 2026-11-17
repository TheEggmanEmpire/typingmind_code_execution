# Code Runner MCP server: how it works inside

This document describes the server in `server/` as the code implements it. It is written for two readers: the
owner coming back to it after months away, and an engineer who has to debug or extend it. Every mechanism is
named by file and function. Where the code does something other than its own comments (or the README) say, this
document follows the code and says so; those places are collected in [Known discrepancies](#15-known-discrepancies).

Figures labelled **measured** come from the live Railway service on 2026-11-17. They describe what that
deployment showed on that day, not a guarantee for every host: the sandbox probes the host at every start and
uses what it finds.

Contents

1. [Overview](#1-overview)
2. [Request path of one tool call](#2-request-path-of-one-tool-call)
3. [Identity and workspaces](#3-identity-and-workspaces)
4. [Isolation](#4-isolation)
5. [Running code](#5-running-code)
6. [REA](#6-rea-reverse-engineering)
7. [The result guard](#7-the-result-guard)
8. [Authentication](#8-authentication)
9. [Browser bridge](#9-browser-bridge)
10. [Links for the user](#10-links-for-the-user)
11. [Schedules](#11-schedules)
12. [Failure and recovery](#12-failure-and-recovery)
13. [Configuration reference](#13-configuration-reference)
14. [Extending it](#14-extending-it)
15. [Known discrepancies](#15-known-discrepancies)

---

## 1. Overview

### What runs where

Everything runs in **one Docker container** (`Dockerfile` at the repository root, `railway.json` points Railway
at it). Inside it:

| Process | Started by | Runs as (on Railway) | Purpose |
|---|---|---|---|
| `tini` | container entrypoint | root | PID 1, reaps zombies, forwards signals |
| `node server/src/index.js` | `tini` | root | the whole server: HTTP, MCP, OAuth, bridge, links, scheduler |
| `crbox` (+ the program it execs) | `sandbox.js` `spawnInWorkspace()` | workspace uid | every piece of model-written code, the Python kernels, REA, and the file helper `wsfs.py` |
| Python kernel (`py/kernel.py`) | `runner.js` `ensureKernel()` | workspace uid | one persistent interpreter per workspace |
| REA (`rea mcp`) | `rea.js` `startChild()` | workspace uid | one reverse-engineering MCP server per workspace |
| `python3 -I -B py/wsfs.py` | `sandbox.js` `request()` | workspace uid | one short process per server-side file operation |

The container runs as root because `RAILWAY_RUN_UID=0` is set in the Dockerfile. Root is used for one thing:
`crbox` switches each run to the workspace's own unix user before anything model-written executes.

The Chrome extension (`extension/`) runs in the user's browser and connects out to the server over a WebSocket.
Nothing listens on the user's machine.

Persistent state lives in the data directory: `DATA_DIR` if set, else `RAILWAY_VOLUME_MOUNT_PATH` (the mount
path of an attached Railway volume), else `/data` (`config.js`; the Dockerfile no longer sets `DATA_DIR`). This
document writes `DATA_DIR` for that directory. Without a volume it lives in the container's filesystem and is lost
on redeploy (see [section 12](#12-failure-and-recovery)). **Measured** on 2026-11-17: a 50 GB Railway volume is
attached to the service at `/data`.

### Endpoints

All routes are served by the single `http.createServer` handler in `index.js`, checked in this order:

| Path | Method | Auth | Handled in | Purpose |
|---|---|---|---|---|
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/<resource>]` | GET | none | `mcp-auth.js` `handleAuthHttp()` | OAuth discovery (RFC 8414, RFC 9728) |
| `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | GET/POST | see [section 8](#8-authentication) | `mcp-auth.js` `handleAuthHttp()` | dynamic registration, consent form, tokens, revocation |
| `/mcp` (and `/mcp/`) | POST only | key or token | `index.js` `handleMcp()` | MCP over Streamable HTTP, stateless |
| `/health` | any | none | `index.js` | liveness plus capability summary, no secrets |
| `/bridge` | WebSocket upgrade | device token in first message | `bridge.js` `attachBridge()` | the extension's link |
| `/bridge/pair`, `/bridge/unpair` | POST, OPTIONS | pairing code / device token | `bridge.js` `handleBridgeHttp()` | pair and unpair a browser |
| `/f/<token>/<name>` | GET, HEAD | signed token | `web.js` `handleWeb()` | a file, or a public share |
| `/p/<token>/<name>` | GET, HEAD | signed token | `web.js` | interactive preview page |
| `/w/<token>/`, `/w/<token>/upload` | GET/HEAD, POST | signed token | `web.js` | workspace page and upload |
| `/` | any | none | `index.js` | plain-text banner |

`/health` answers `503` with `"sandbox": "unavailable"` when the sandbox refused to start (fail-closed rule,
[4.10](#410-the-fail-closed-rule)). Its body has this shape:

```json
{"ok":true,"version":"1.0.0","sandbox":"root",
 "layers":{"uid":true,"rlimits":true,"noNewPrivs":true,"landlock":6,"seccomp":true,"namespaces":false},
 "network":"open","languages":["python","javascript","typescript","bash","sql","duckdb","c","c++","ruby","php","perl"],
 "rea":true}
```

(The layer values are the measured Railway situation; `languages` depends on the image and is illustrative.)

### Stateless Streamable HTTP, and why

`handleMcp()` builds a new MCP `Server` and a new `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
for every POST, and closes both when the response closes. No `Mcp-Session-Id` is issued, `GET /mcp` (the
server-to-client stream of stateful MCP) is refused with 405.

Reasons visible in the code:

- **Redeploys and several clients need no session bookkeeping** (comment at the top of `index.js`). A Railway
  redeploy replaces the process; a stateful session table would be lost and every client would have to notice
  and re-initialise.
- **Each request carries its own identity.** `mcpServerFor(req)` reads `X-User-ID`, `X-Workspace` and
  `X-Code-Secrets` from that request and binds them into the handlers. A per-request server object is the
  simplest way to make sure one request's user and secrets never leak into another's.
- Everything that must outlive a request (Python variables, jobs, REA processes, pairings) is keyed by
  workspace or user, not by MCP session, so nothing depends on the transport keeping state.

Progress during a long call still works: notifications are sent on the same POST's SSE response when the client
sent a `progressToken` (see `progress` in `mcpServerFor()`).

---

## 2. Request path of one tool call

```
MCP client (LibreChat, Hermes, claude.ai connector)
   |  HTTPS  POST /mcp
   |  Authorization: Bearer <MCP_API_KEY or issued token>
   |  X-User-ID / X-Workspace / X-Code-Secrets (optional)
   v
Railway edge proxy (TLS, appends X-Forwarded-For)
   v
index.js  http handler
   |-- handleAuthHttp(req,res,url)        OAuth and .well-known paths end here
   |-- handleMcp(req,res)
   |     checkAuth(req,{resource:"/mcp"})  mcp-auth.js   -> 401 / 429 / 503 on failure
   |     POST only (else 405); body <= 64 MB; JSON.parse (else -32700)
   |     mcpServerFor(req)
   |        user  = X-User-ID  || "default"
   |        ws    = getWorkspace(user, X-Workspace || "main")       sessions.js
   |        secrets = CODE_SECRETS + parseSecrets(X-Code-Secrets)   config.js
   |     new StreamableHTTPServerTransport({sessionIdGenerator: undefined})
   |
   |   tools/list -> [...listTools(), ...reaListTools(ws, own names)]
   |   tools/call -> name is a Code Runner tool?
   |        yes: guardedCall(ws, name, () => callTool(name, args, ctx))      guard.js -> tools.js
   |        no (and REA available):
   |             guardedCall(ws, name==="rea_call" ? "rea:"+args.tool : name,
   |                         () => reaCallTool(ws, params, extra))           guard.js -> rea.js
   v
guardedCall()                                                             guard.js
   race(run(), CALL_CEILING_S timer)        -> error result on throw or ceiling
   guardResult(ws, tool, result)            -> text <= RESULT_MAX_CHARS (rest saved to results/)
                                               media <= RESULT_IMAGE_MAX_KB in total
                                               structuredContent dropped
   console.log("tool <name> ws=<id> <ms>ms <bytes>B ...")
   v
SSE response to the client; on close: transport.close(), server.close()
```

### An actual request

```http
POST /mcp HTTP/1.1
Host: <domain>
Authorization: Bearer <MCP_API_KEY>
X-User-ID: alice
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"run_code","arguments":{
  "language":"python",
  "code":"import pandas as pd\ndf = pd.DataFrame({'a':[1,2]})\ndf.to_csv('out.csv')\nint(df.a.sum())"}}}
```

What happens: `getWorkspace("alice","main")` gives the workspace `alice-main-8c8ce93975` ([section 3](#3-identity-and-workspaces)).
`run_code` (tools.js) calls `runner.runCode()`, which starts a job, runs the code in the workspace's Python kernel,
lists the workspace before and after, and returns the output plus a note about the new file. The answer arrives as
one SSE event:

```
event: message
data: {"result":{"content":[{"type":"text","text":"3\n\nFiles created: out.csv (11 B)\n"}]},"jsonrpc":"2.0","id":7}
```

and the server log gets one line (duration illustrative):

```
tool run_code ws=alice-main-8c8ce93975 1290ms 75B
```

### The log line

Written by `guardedCall()` for every `tools/call`, whatever tool, after the result guard:

```
tool <tool> ws=<workspace id> <duration>ms <size>B[ (cut from <size before>B)][ error][ ceiling| threw]
```

| Field | Meaning |
|---|---|
| `<tool>` | the tool name; for compact REA calls `rea:<REA tool>` (first 60 characters) |
| `ws=` | workspace id, the directory name under `DATA_DIR/ws/` |
| `<duration>ms` | wall time from the start of the handler to the guarded result |
| `<size>B` | length of `JSON.stringify` of the result that was sent (characters, labelled bytes) |
| `(cut from …B)` | the guard shortened the result (only shown when it shrank by more than 64) |
| `error` | the result has `isError: true` (a tool failure the model sees, not a server crash) |
| `ceiling` | the handler had not answered within `CALL_CEILING_S`; an error was sent instead |
| `threw` | the handler threw; its message was turned into an error result |

Content is never logged. `tools/list` and the link routes do not produce tool lines.

A second line comes from the gate in `handleMcp()`: when a request to `/mcp` carried a credential
(`Authorization` or `X-API-Key`) that was not accepted, the server logs

```
auth refused <status> <method> /mcp (a credential was sent and not accepted; the client has to sign in again)
```

with `<status>` 401 (wrong key or unknown token), 429 (address throttled) or 503 (no key configured). The
credential is never logged. A request without any credential (the normal first step of an OAuth sign-in) is not
logged.

**Using it to explain a stalled chat.** Find the time the chat stopped and look for the last `tool` line of that
workspace, and for `auth refused` lines around it:

- *`auth refused 401`* right before the stall: the client's token or key was refused before any tool ran. The
  client usually shows nothing and just stops. It has to sign in again (OAuth) or get the current key.
- *No line at all* for the expected call: the call is still running (it will produce a `ceiling` line at the
  latest after `CALL_CEILING_S`, default 600 s), or the request never reached the server. Check the client's own
  log next.
- *A line with `ceiling`*: a handler hung. For `run_code` the run itself continues as a job; for browser tools
  the extension did not answer.
- *A line with a large size* (tens of kilobytes or more) shortly before the stall: the client probably dropped a
  result it could not pass to the model. The guard should prevent this; if it happens, lower `RESULT_MAX_CHARS`.
- *A normal-looking line*: the server answered; the stall is between client and model.
- *`(cut from 406311B)`-style entries on `rea:` tools* are expected: REA results are routinely large.

---

## 3. Identity and workspaces

All of this is in `sessions.js`.

### How ids are derived

`getWorkspace(user, name)` takes the **raw header values** (trimmed, at most 256 characters; empty means
`default` / `main`). The raw pair is the identity; it is the cache key and it is stored in the metadata as
`owner`. The directory name is derived from it in `Workspace` constructor:

```
id = clean(user).slice(0,24) + "-" + clean(name).slice(0,24) + "-" + sha256(user + "\0" + name).hex.slice(0,10)
clean(s) = s with every character outside [A-Za-z0-9._@-] replaced by "_", at most 80 characters
```

Examples: user `alice`, workspace `main` gives `alice-main-8c8ce93975`. A LibreChat user id
`6650f0c3a1b2c3d4e5f60718` with a conversation id as workspace gives
`6650f0c3a1b2c3d4e5f60718-683e9b2c-5f1a-4d2e-9c3b--a947545f24`. The readable prefix is for humans; the hash
(40 bits of SHA-256 over the raw values) keeps two names apart that clean to the same prefix.

### Unix user per workspace

`uidFor(id)` (root mode only): looks the id up in `DATA_DIR/uids.json`; if absent, takes the smallest uid
`>= SANDBOX_UID_BASE` (default 370000) not yet used, writes the map atomically (`.tmp` then rename, mode 0600)
and returns it. The gid equals the uid. There is no `/etc/passwd` entry; the environment says `USER=runner`.

`loadUids()` treats only `ENOENT` as "empty map". Any other read or parse error throws
(`uids.json on the volume is unreadable … refusing to assign unix users`): guessing would hand a new workspace
a uid that still owns another workspace's files. The map is read once per process and cached.

When the server is not root, every workspace uses the server's own uid and gid (`user` mode, see
[section 4](#4-isolation)).

### Directory layout

| Path | Owner (root mode) | Mode | Created by | Holds |
|---|---|---|---|---|
| `DATA_DIR/` | not set by the code | not set by the code | volume / first `mkdirSync` | must be searchable (x bit) by workspace uids |
| `DATA_DIR/.secret` | root | 0600 | `config.js` `serverSecret()` | HMAC key for link tokens; only created when neither `SERVER_SECRET` nor a key of 16+ characters exists |
| `DATA_DIR/uids.json` | root | 0600 | `sessions.js` `uidFor()` | workspace id -> uid |
| `DATA_DIR/mcp-tokens.json` | root | 0600 | `mcp-auth.js` `persistTokens()` | hashed OAuth tokens, client registrations, revocations |
| `DATA_DIR/bridge.json` | root | 0600 | `bridge.js` `save()` | paired browser devices (token hashes), revoked device ids |
| `DATA_DIR/ws/` | root | 0711 at creation | `Workspace` | parent of all workspaces |
| `DATA_DIR/ws/<id>/` | workspace uid | 0700 (re-applied on every load) | `ensureDir()` | the workspace: cwd and `HOME` of the code |
| `DATA_DIR/ws/<id>/.cr/` | workspace uid | as created by the code | kernel, prelude, helpers | runner state: `session.pkl`, `pyuser/` (pip), `npm/` (npm -g), `storage.json`, `tables/`, `duck.db`, `session.RData`, `rea/` |
| `DATA_DIR/ws/<id>/results/`, `rea/`, `schedules/`, `uploads/` | workspace uid | files 0600 | `wsfs` | guard overflow, REA overflow, schedule logs, uploads |
| `DATA_DIR/tmp/` | root | 0711 at creation | `Workspace` | parent of the private temp dirs |
| `DATA_DIR/tmp/<id>/` | workspace uid | 0700 | `ensureDir()` | `TMPDIR` of the code |
| `DATA_DIR/tmp/<id>/run-XXXXXX/` | workspace uid | 0700 (mkdtemp) | `runner.js` `execute()`; removed by `finish()` (or when the kernel started from it exits) | per-run files: `kernel.py`, `helpers.py`, `chart.html`, `run.mjs`, `resolve.mjs`, `Run.<ext>`, `program`, `sqlrun.py`, `run.sql` (each 0600, chowned to the workspace uid) |
| `DATA_DIR/tmp/<id>/jobs/` | root | process umask (0755 with the usual 022) | `execute()` | `j<hex>.log` (output, up to 5 MB) and `j<hex>.json` (status), both root 0600 |
| `DATA_DIR/meta/` | root | 0700 | `Workspace` | server-side metadata, unreachable for the code |
| `DATA_DIR/meta/<id>.json` | root | 0600 | `saveMeta()` | owner, history, shares, schedules, `jobSeen`, `lastImage` |

`ensureDir()` uses `lstat` and refuses a path that is not a directory, so a workspace directory replaced by a
symlink is never followed. It re-applies owner and mode on every load.

A job's `run-*` folder is removed when the job finishes, by a sandboxed `rm -rf` running as the workspace user
(`finish()`), except the folder a live Python kernel was started from, which is removed when that kernel exits
(`ensureKernel()` close handler). Job logs under `tmp/<id>/jobs/` are kept, and `DATA_DIR/tmp/<id>` is not counted
by the quota (see [4.15](#415-threat-table)).

### Metadata outside the workspace, and why

`ws.meta` is stored in `DATA_DIR/meta/<id>.json`, owned by root with mode 0600 in a 0700 directory. It holds:

- `owner` (the raw user and workspace name, used by `allWorkspaces()` after a restart),
- `history` (last 200 runs, for the notebook export),
- `shares` (the list that makes public share links revocable),
- `schedules` (the timetable),
- `jobSeen` (output offsets of the `job` tool) and `lastImage`.

It lives outside the workspace because the code can write anything inside the workspace. If shares lived there,
code could re-enable a revoked link; if schedules lived there, code could give itself a timetable. The comment
on `get meta()` says it directly: "Never stored inside the workspace, where the code could edit it."

### Signed link tokens

`signToken(payload)` = `base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(secret, body)[0..16])`.
`verifyToken(token, kind)` checks the MAC in constant time, the kind, and the expiry `e` (unix seconds, 0 = none).
The secret (`config.js` `serverSecret()`, also the base of the browser device key, [9.1](#91-pairing-step-by-step))
is chosen in this order:

1. `SERVER_SECRET`, if it is at least 16 characters;
2. otherwise derived from the access key, `HMAC-SHA256(MCP_API_KEY, "code-runner server secret v1")`, if the key
   (`MCP_API_KEY` or `MCP_PASSWORD`) is at least 16 characters. Links and pairings then survive a redeploy even
   without a volume; changing the key ends them;
3. otherwise `DATA_DIR/.secret` (generated, at least 32 characters; a shorter file is replaced, so a stray empty
   file never becomes the key). This file only survives with a volume.

Every token carries `w` (workspace id), `u` and `n` (raw user and workspace name), `k` (kind) and `e`.
On use, `getWorkspace(u, n)` is recomputed and must give the same id `w`.

| Kind | Made by | Expiry | Extra fields | Grants |
|---|---|---|---|---|
| `f` | `web.js` `fileUrl()` | 30 days | `p` path, `d` download, `fn` filename | reading that one path of that workspace (current content at the time of the request) |
| `p` | `previewUrl()` | 30 days | `p`, `as` | a rendered preview page of that path |
| `w` | `workspaceUrl()` | 7 days | none | listing every file, downloading any of them (fresh `f`/`p` links are minted per page view), uploading into `uploads/` |
| `s` | `shareUrl()` | none, or `share_hours` (max 365 days) | `p`, `i` share id | reading that path, but only while `meta.shares[i]` still exists with the same path |

`Workspace.token()` and `sessions.js` `workspaceFromToken()` exist as well but the routes use `web.js`'s own
`tokenFor()` / `workspaceOf()`, which do the same.

Plainly: the payload is signed, not encrypted. Anyone who sees a link can decode the user id and workspace name
in it. `f`, `p` and `w` links cannot be revoked one by one; only changing the secret invalidates them, and it
invalidates all of them (and every browser pairing): set a new `SERVER_SECRET`, or change `MCP_API_KEY` when the
secret is derived from it, or delete `DATA_DIR/.secret` when that file is the source.

---

## 4. Isolation

What the server runs is written by a model and treated as hostile. Isolation is **defence in depth inside one
shared kernel**, not a virtual machine (first line of `crbox.c`). Each layer is applied by the small C launcher
`server/sandbox/crbox.c`, assembled by `sandbox.js` `command()`, and probed at startup by `sandbox.js`
`initSandbox()`.

### 4.1 Measured situation on Railway (2026-11-17)

Measured on the live service, as reported by `/health` and by probes from inside `run_code`:

- The container runs as **root**, so the sandbox runs in `root` mode.
- **Active layers**: per-workspace unix user, rlimits, no_new_privs, Landlock (**ABI 6 or 7**, depending on the
  host the deployment landed on), seccomp.
- **Not active**: bubblewrap namespaces. Bubblewrap is installed in the image, but the platform refuses the
  namespaces it needs, so the probe fails and `namespaces: false`.
- From inside run code, these were **denied**: `/data`, `/data/meta`, `/app/server/src`, `/proc/1/environ`,
  another user's workspace.
- The code's environment held **none of the server's variables** (no `MCP_API_KEY`, no Railway variables).
- A 50 GB volume is attached at `/data`.
- `CODE_NETWORK=open`, chosen by the owner. From run code the project's private hosts
  `mongodb.railway.internal` and `librechat.railway.internal` resolve, so **model-run code can reach the
  LibreChat MongoDB and the LibreChat service over the private network** (see the threat table, [4.15](#415-threat-table)).
- A signed OAuth token minted before a redeploy was accepted after it.
- `OMNIROUTE_API_KEY` is set and `make_image` returned an image.

This is one measurement. A redeploy can land on another host with another kernel; check `/health` (or
`manage_files` action `status`) after deploying.

### 4.2 The launch chain

`spawnInWorkspace(ws, argv, opts)` builds the command with `command()` and spawns it with a scrubbed
environment. There are two shapes, depending on whether the bubblewrap probe succeeded.

Without namespaces (the measured Railway case): one `crbox` does everything.

```
node (root)
  spawn  crbox  --rlimit-fsize <MAX_FILE_MB> --rlimit-nofile 1024 --rlimit-core 0 --setsid
                [--rlimit-nproc <MAX_PROCS>] [--rlimit-cpu N] --gid <uid> --uid <uid>     (root mode)
                --chdir <cwd>
                --landlock --ro <path> ... --rw <path> ...                                (if Landlock)
                --seccomp [--no-net]                                                      (if seccomp)
                -- <program> <args>
          |
          | inside crbox.c main(), in this order:
          | 1 setrlimit CPU, FSIZE, NPROC, NOFILE (soft = hard), CORE = 0
          | 2 setsid()                       new session and process group
          | 3 setgroups(0) setgid setuid     verify setuid(0) now fails
          | 4 chdir(cwd)
          | 5 prctl(PR_SET_NO_NEW_PRIVS)
          | 6 Landlock ruleset, restrict_self
          | 7 seccomp filter
          | 8 close every fd above 2
          | 9 execvp(program)
          v
      program (workspace uid, no privileges, filtered)
```

With namespaces (where the host allows them): an outer `crbox` does limits, session and uid drop, then execs
bubblewrap as the workspace user; bubblewrap builds the namespaces and the mount view; an inner `crbox` then
applies Landlock and seccomp inside it.

```
node (root)
  crbox (outer)  rlimits, --setsid, --gid/--uid          -> steps 1-3, 5, 8, 9
    bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts [--unshare-net]
          --die-with-parent --cap-drop ALL
          --ro-bind /usr /bin /sbin /lib /lib64 /lib32 /etc /opt py/ <node prefix> crbox <extra ro>
          --proc /proc --dev /dev [--ro-bind /sys/devices/system/cpu]
          --bind <ws.dir> <ws.dir> --bind <ws.tmp> <ws.tmp> --bind <ws.dir> /workspace
          --chdir <cwd> --remount-ro /
      crbox (inner)  --chdir --landlock ... --rw /workspace --seccomp [--no-net]   -> steps 4-9
        program
```

### 4.3 Why the order matters

- **rlimits first, while still root.** Soft and hard limits are set to the same value, and only a privileged
  process can raise a hard limit; once the uid is dropped the code cannot lift them.
- **setsid before seccomp.** The seccomp filter denies `setsid` and `setpgid` (so the code cannot leave the
  process group, see `killTree`, [4.13](#413-killtree)). `crbox` must therefore create the group before the
  filter is installed.
- **uid drop before chdir and Landlock.** `chdir` and the `open(O_PATH)` of every Landlock rule path happen as
  the workspace user, so they succeed only where that user may go. The drop is verified: `setuid(0)` must fail
  and the effective ids must match, or `crbox` exits (`uid drop was reversible`).
- **no_new_privs before Landlock and seccomp.** Both require it for an unprivileged process; it also means no
  setuid binary can give privileges back.
- **Landlock before seccomp.** Landlock needs its own syscalls and `prctl`; seccomp goes last so that nothing
  after it needs a call it denies, except `execve`, which it allows.
- **`/proc/self` in the Landlock rules is resolved by `crbox` itself, just before exec.** `execvp` keeps the
  PID, so the program can read its own `/proc/self`; processes it forks get new PIDs and cannot (cost noted
  in the startup notes).
- **Closing fds last.** Whatever the parent passed on above stderr is closed (`close_range`, falling back to
  `/proc/self/fd`, falling back to a loop to 1048576), so the code never inherits a server descriptor. This is
  also why the Python kernel cannot get extra pipes (see [5.2](#52-the-persistent-python-kernel)).
- **With namespaces, Landlock and seccomp go in the inner crbox.** bubblewrap needs `unshare`, `mount` and
  `pivot_root`, which seccomp denies, and the Landlock rule for `/workspace` only resolves inside the new mount
  namespace.

### 4.4 Layer: per-workspace unix user

- **Stops**: reading or writing another workspace's files (each is 0700 under its own uid); signalling or
  tracing other workspaces' processes and the root server; reading the server's `/proc/<pid>/environ` and other
  per-process files that the kernel restricts to the same uid; reading root-owned 0600 files such as
  `uids.json`, `mcp-tokens.json`, `bridge.json`, `.secret` and job logs.
- **Applied**: `--gid <uid> --uid <uid>` in the outer crbox, root mode only (`command()`). `setgroups(0)`
  first, so no supplementary root groups remain.
- **Probed**: `crbox --probe` forks a child that drops to 65534 and checks that `setuid(0)` then fails
  (`child_probe(2)`, reported as `setuid`). `initSandbox()` sets `mode: "root"` and `layers.uid: true` when the
  server is root; root without a working `setuid` is a fatal error.
- **Missing** (server not root, `mode: "user"`): all workspaces and the server share one uid. Separation then
  rests on Landlock (or namespaces). The startup note says so: same-uid signalling and non-filesystem IPC can
  reach sibling jobs and the server.

### 4.5 Layer: rlimits

Set in `crbox` `limit()`, values chosen in `command()`:

| Limit | Value | Notes |
|---|---|---|
| `RLIMIT_FSIZE` | `MAX_FILE_MB` (512) MB, or `opts.limits.fileMb` | largest single file a process may write |
| `RLIMIT_NOFILE` | 1024 (128 for `wsfs.py`) | open descriptors |
| `RLIMIT_CORE` | 0, always | no core dumps of processes that may hold secrets |
| `RLIMIT_NPROC` | `MAX_PROCS` (256), **root mode only** | fork bombs |
| `RLIMIT_CPU` | only when `opts.limits.cpuS` is given | used for `wsfs.py` (10 s); runs, kernels and REA get none |

**Why `RLIMIT_NPROC` only in root mode** (comment in `command()`): the kernel counts this limit per real uid, not
per process tree. With a uid of its own the limit belongs to one workspace. In user mode it would count the
server and every other workspace too, and would start refusing forks everywhere.

**Why no `RLIMIT_AS`**: the code sets no address-space limit and gives no reason. Memory is not bounded per job
at all (the startup note says: "Memory and aggregate disk use are not bounded by per-job cgroups"). A likely
reason, which is an inference and not stated in the code: runtimes such as V8 (Node), the JVM and Go reserve large
virtual address ranges they never touch, and an address-space cap breaks them long before real memory is the
problem.

Time limits of runs are wall-clock timers in `runner.js` (`timeout`), not CPU limits.

### 4.6 Layer: no_new_privs

- **Stops**: gaining privileges through `execve` of a setuid or file-capability binary (`su`, `ping`, whatever
  is in the image).
- **Applied**: `prctl(PR_SET_NO_NEW_PRIVS, 1)` in every `crbox`, unconditionally.
- **Probed**: `child_probe(0)`, reported as `nnp`. `initSandbox()` refuses to start the sandbox without it
  (`crbox cannot enable no_new_privs`).
- **Missing**: not possible in a working sandbox; it is mandatory. (`crbox --allow-missing` would downgrade it
  to a warning, but `sandbox.js` never passes that flag.)

### 4.7 Layer: Landlock

- **Stops**: filesystem access outside an allow-list, even where unix permissions would allow it: the server's
  source, the volume's root files, `/data/meta`, `/tmp`, other workspaces, `/proc` entries of other processes.
- **Applied**: `--landlock` plus `--ro` / `--rw` rules (`command()`), executed by `crbox` `landlock()`.

`landlock()` asks the kernel for its ABI version and handles these rights: the 13 basic filesystem rights of
ABI 1 (execute, write, read file, read dir, remove dir/file, make char/dir/reg/sock/fifo/block/sym), plus REFER
(ABI 2), TRUNCATE (ABI 3) and IOCTL_DEV (ABI 5). A read-only rule grants execute, read file and read dir; a
read-write rule grants every handled right. Rules on a file (not a directory) are reduced to the rights that
apply to files.

Read-only paths (only those that exist are added, `uniqueExisting()`):

```
/usr /bin /sbin /lib /lib64 /lib32 /etc /opt
/sys/devices/system/cpu
/dev
<server>/py                         (kernel.py, helpers.py, sqlrun.py, wsfs.py)
<node prefix>                       (dirname(dirname(realpath(node))), e.g. /usr/local)
<opts.readOnly>                     (e.g. REA's install root)
```

plus, for `/proc`:

- **without namespaces**: `/proc/self`, `/proc/cpuinfo`, `/proc/meminfo`, `/proc/stat`, `/proc/uptime`,
  `/proc/loadavg`, `/proc/version`, `/proc/filesystems`, `/proc/sys/kernel/random`. A broad `/proc` rule
  would let a same-uid process read the server's environment (comment in `command()`); this list keeps the
  common system files and the program's own entry only.
- **with namespaces**: the whole `/proc`, because it is the PID namespace's own `/proc` and shows only the
  sandbox's processes.

Read-write paths:

```
<ws.dir>  <ws.tmp>
/dev/null /dev/zero /dev/urandom /dev/random /dev/tty /dev/shm
/workspace                          (namespaces only: the bind mount of ws.dir)
```

- **Probed**: `crbox --probe` reads the ABI and then forks a child that installs an empty ruleset and checks
  that opening `/etc/passwd` fails with `EACCES` (`child_probe(3)`). The ABI number is reported as `landlock`
  (0 = unavailable).
- **What ABI 6 and 7 add, and what is used**: `crbox` requests only the filesystem rights listed above (up to
  ABI 5). It does not request Landlock's network rules (ABI 4) or its IPC scoping (ABI 6: abstract unix sockets
  and signals). On the measured Railway hosts (ABI 6 or 7) those features exist but are not used.
- **Missing**: in root mode the uid layer still separates workspaces and protects root-owned files, but the code
  can read anything world-readable (including the server's source). In user mode without namespaces, startup is
  refused ([4.10](#410-the-fail-closed-rule)).

### 4.8 Layer: seccomp

`crbox` `seccomp()` installs a BPF filter (`prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)`).

**Architecture check**: the first instructions compare `seccomp_data.arch` with the build architecture
(x86_64 or aarch64; anything else does not compile). A syscall from another ABI kills the process
(`SECCOMP_RET_KILL_PROCESS`). On x86_64, syscall numbers with bit `0x40000000` (the x32 ABI) are refused with
`EPERM`, so the same call cannot be made under a second number.

**Denied with `EPERM`**, grouped by purpose:

| Purpose | Syscalls |
|---|---|
| Inspecting or changing other processes | `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd`, `process_madvise`, `kcmp` |
| Namespaces and mounts | `unshare`, `setns`, `mount`, `umount2`, `pivot_root`, `chroot`, `mount_setattr`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `open_tree`, `move_mount` |
| Large kernel attack surface | `bpf`, `perf_event_open`, `userfaultfd`, `io_uring_setup`, `io_uring_enter`, `io_uring_register` |
| Kernel keyrings | `keyctl`, `add_key`, `request_key` |
| File handles that bypass path checks | `open_by_handle_at`, `name_to_handle_at` |
| Host administration | `kexec_load`, `kexec_file_load`, `init_module`, `finit_module`, `delete_module`, `reboot`, `swapon`, `swapoff`, `acct`, `quotactl`, `syslog`, `vhangup`, `iopl`, `ioperm`, `lookup_dcookie` |
| Clock | `settimeofday`, `clock_settime`, `adjtimex`, `clock_adjtime` |
| NUMA memory policy | `move_pages`, `mbind`, `set_mempolicy`, `migrate_pages` |
| Leaving the process group | `setsid`, `setpgid` (so `killTree` reaches every descendant) |

(Calls the build headers do not define are left out with `#ifdef`.)

**`clone3` and `clone`**: `clone3` returns `ENOSYS`. Its flags are in a struct behind a pointer, which a BPF
filter cannot read; `ENOSYS` makes glibc fall back to `clone`. For `clone`, the first argument (the flags) is
checked and any namespace flag (`CLONE_NEWNS`, `NEWCGROUP`, `NEWUTS`, `NEWIPC`, `NEWUSER`, `NEWPID`, `NEWNET`,
`NEWTIME`, mask `0x7e020080`) is refused with `EPERM`. Threads and ordinary forks work.

**`personality`**: only the values 0, `PER_LINUX32` (0x0008), `UNAME26` (0x20000), their combination, and
`0xffffffff` (query) are allowed; anything else (for example `READ_IMPLIES_EXEC` or `ADDR_NO_RANDOMIZE`) gets
`EPERM`.

**`--no-net`**: `socket` and `socketpair` are allowed only for `AF_UNIX`; any other family (IPv4, IPv6, packet,
netlink, vsock, …) gets `EACCES`. `socketcall` is denied where it exists.

- **Probed**: `child_probe(1)` installs the filter and checks that `ptrace` fails with `EPERM`; reported as
  `seccomp`.
- **Missing**: dangerous syscalls are not filtered, code can leave its process group (so `killTree` may miss
  processes), and `CODE_NETWORK=off` cannot be enforced unless a network namespace exists (startup then refuses
  that setting). The startup note starts with `WARNING: seccomp unavailable`.

### 4.9 Layer: bubblewrap namespaces

- **Stops**: seeing other processes (PID namespace), System V IPC and hostname of the host (IPC, UTS), the host
  filesystem outside the bind mounts (mount namespace, root remounted read-only), and with `--unshare-net` all
  network. `--cap-drop ALL` and `--die-with-parent` as well.
- **Applied**: only when the probe succeeded, as described in [4.2](#42-the-launch-chain).
- **Probed**: `initSandbox()` looks for `bwrap` on `PATH`. If found, it runs `/bin/true` through the complete
  chain (outer crbox, bwrap, inner crbox with Landlock and seccomp) in a temporary probe workspace. Success sets
  `namespaces: true`; a second probe with `--unshare-net` decides `netNamespace`.
- **Missing** (measured on Railway): the note says `Bubblewrap is installed but the complete
  UID/namespace/Landlock/seccomp chain failed; namespaces are unavailable.` The sandbox continues with the other
  layers; `/proc` gets the narrow Landlock list; network off relies on seccomp only.

### 4.10 The fail-closed rule

`initSandbox()` either produces a working configuration or sets `refuse: true`. With `refuse`,
`spawnInWorkspace()` throws the reason for every call, which means **no code runs and no server-side file
operation works** (they also go through the sandbox), and `/health` answers 503.

Code execution is refused when:

- the `crbox` binary is missing and `build.sh` (gcc) fails,
- `crbox --probe` fails or reports no `no_new_privs`,
- the server is root but cannot irreversibly drop to another uid,
- the complete selected chain cannot run `/bin/true`,
- the server is not root and there is neither Landlock nor namespaces ("this host offers no separate user, no
  Landlock and no namespaces"),
- `CODE_NETWORK=off` is set but neither seccomp nor a network namespace is available.

The refusal message tells the operator to fix the cause or to set `SANDBOX=off`. `SANDBOX=off` is the only way
to run code without isolation; it has to be chosen explicitly and is reported as a warning (`mode: "off"`). Even
then `spawnInWorkspace()` still scrubs the environment and checks the working directory.

### 4.11 The scrubbed environment

`sandbox.js` `environment(ws, extra)` builds the child environment from scratch; nothing of `process.env` is
passed on:

```
PATH=<ws.dir>/.cr/pyuser/bin:<ws.dir>/.cr/npm/bin:/usr/local/bin:/usr/bin:/bin
HOME=<ws.dir>
TMPDIR=<ws.tmp>
LANG=C.UTF-8
WORKSPACE=<ws.dir>
USER=runner
PIP_USER=1
PYTHONUSERBASE=<ws.dir>/.cr/pyuser
PIP_BREAK_SYSTEM_PACKAGES=1
PIP_DISABLE_PIP_VERSION_CHECK=1
PIP_CACHE_DIR=<ws.tmp>/pip-cache
NPM_CONFIG_PREFIX=<ws.dir>/.cr/npm
NPM_CONFIG_CACHE=<ws.tmp>/npm-cache
NPM_CONFIG_UPDATE_NOTIFIER=false
NODE_PATH=<ws.dir>/.cr/npm/lib/node_modules
```

The package variables make `pip install` and `npm install -g` work from any language and land in the workspace
(on the volume, hidden under `.cr/`), never in the read-only system directories; caches go to the temp dir. Plus
what the caller adds for that spawn:

| Added by | Variables |
|---|---|
| `runner.js` `processRun()` (non-Python runs) | the run's secrets (`CODE_SECRETS` + `X-Code-Secrets`) as `NAME=value` |
| `runner.js` `pipEnv()` (Python, SQL, pip installs) | `PIP_USER=1`, `PYTHONUSERBASE=<ws>/.cr/pyuser` (same as the base), `PYTHONUNBUFFERED=1`, `MPLBACKEND=Agg` |
| `runner.js` `ensureKernel()` | `CR_CHART_HTML`, `CR_CONTROL_STDIO=1`, `CR_CONTROL_PREFIX=<random>` |
| `rea.js` `reaEnv()` | `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` (under `.cr/rea/`), `NO_COLOR=1` |

The Python kernel does not get secrets at spawn time; they arrive with each request and are set in
`os.environ` for that run only ([5.6](#56-secrets-and-redaction)).

### 4.12 wsfs.py: server-side file access as the workspace user

Every file operation the server does on a workspace (serving a link, an upload, writing a guard overflow file,
listing before and after a run, the quota check, screenshots, `manage_files`) goes through `sandbox.js` `wsfs`,
which runs `python3 -I -B py/wsfs.py` through `spawnInWorkspace()` with network off, a 10 s CPU limit, 128 open
files and the file-size limit.

**Why**: the server is root. A root process that opens `uploads/report.pdf` after the code replaced `uploads`
with a symlink to `/data/meta` would serve or overwrite whatever the link points at. Running the operation as
the workspace user, inside the same Landlock rules as the code, means the kernel enforces the boundary even if
path handling has a bug. `-I` (isolated mode) keeps the workspace directory, user site-packages and `PYTHON*`
variables out of `sys.path`, so a planted `json.py` in the workspace is not imported; `-B` writes no bytecode.

**Protocol** (`sandbox.js` `request()` and `wsfs.py` `main()`): one request per process.

```
stdin : {"op":"read","path":"uploads/a.csv","maxBytes":20971520}\n      (one JSON line, at most 64 KB)
        [for write: exactly `size` bytes of payload]
stdout: {"ok":true,"size":1234}\n<1234 bytes>                           (read)
        {"ok":true,"result":...}\n                                       (list, stat, usage, write, ...)
        {"ok":false,"code":"EACCES","error":"Path must stay inside the workspace."}\n
```

Operations: `read`, `write`, `list`, `stat`, `remove`, `rename`, `clear`, `usage`. The server side kills the
helper after 30 s and when the reply exceeds the requested size plus 64 KB (32 MB plus 64 KB for non-reads).

**Symlink rules**:

- Paths are relative; absolute paths (except the `/workspace/` prefix, stripped by `safeRel()`), `..` and NUL
  are refused before the helper starts.
- Traversal opens each directory component with `O_DIRECTORY | O_NOFOLLOW` relative to the previous directory
  descriptor, starting from a descriptor of the workspace root. **Any symlink on the way is refused, even one
  pointing inside the workspace** (a realpath check alone could race with code renaming directories).
- The final file is opened with `O_NOFOLLOW | O_NONBLOCK` and must be a regular file (FIFOs and devices are
  refused; `O_NONBLOCK` keeps a FIFO from hanging the helper).
- `stat` of a symlink is refused; `list` reports symlinks with `link: true` and the tools hide them.
- `remove` and `rename` act on a final symlink itself, never on its target.

`ELOOP` and `ENOTDIR` are reported as `EACCES`, `EFBIG` as `ETOOBIG`.

Cost: one Python start per operation. A run does at least three (usage, list before, list after).

### 4.13 killTree

`sandbox.js` `killTree(child, signal = "SIGKILL")`. `crbox --setsid` makes the spawned process the leader of a
new process group (pgid = its pid); seccomp keeps all descendants in that group.

- In root mode it first scans `/proc/*/stat` and signals every process whose process group equals the job's
  pgid, children before the leader (so a namespace keeper can reap). It matches by **process group, not by uid**:
  the workspace's Python kernel runs under the same uid in another group and must survive a killed job.
- Then `kill(-pgid, signal)`, then `child.kill()` if the leader has not exited (covers a kill that arrives before
  `crbox` called `setsid`).
- It refuses pgid <= 1 and the server's own pid.

`processRun()` calls `killTree` when a run's main process exits, so anything the run left in the background
(`nohup`, `&`) ends with it.

### 4.14 Network modes

`CODE_NETWORK` (`config.network`): `open` (default) or `off`. A spawn can override it (`wsfs.py` always runs
with `off`).

| | `open` | `off` with seccomp only (measured Railway) | `off` with a network namespace |
|---|---|---|---|
| Internet | yes | no: non-`AF_UNIX` sockets get `EACCES` | no |
| Railway project private network (`*.railway.internal`) | **yes** | no | no |
| The server's own port on 127.0.0.1 | yes (still needs the key or a token) | no | no |
| Unix-domain sockets on the host (pathname or abstract) | yes | **yes** | pathname sockets inside the bind mounts only |
| Socket descriptors received over a unix socket | yes | **yes** | yes |

What "off" really enforces without a network namespace is the creation of new non-unix sockets. Landlock does
not restrict connecting to pathname unix sockets, and the abstract-socket scoping of Landlock ABI 6 is not
requested, so any host service listening on a unix socket remains reachable. The startup note says so.

### 4.15 Threat table

What is protected, and by which layer (measured Railway configuration: uid, rlimits, nnp, Landlock, seccomp, no
namespaces):

| Threat from run code | Protected by |
|---|---|
| Reading the API key, Railway variables or other server environment | scrubbed environment; `/proc/<server>/environ` denied by uid and Landlock |
| Reading the server's source, `/data/.secret`, `uids.json`, token and pairing stores | Landlock (no rule), uid (root-owned 0600) |
| Reading or changing workspace metadata (shares, schedules, history) | stored in `/data/meta` (root 0700), Landlock |
| Reading or writing another workspace | uid (0700 per workspace), Landlock |
| Tricking the server into serving or overwriting a file outside the workspace through a symlink | `wsfs.py` running as the workspace user, `O_NOFOLLOW` traversal |
| Signalling or tracing the server or other workspaces | uid; seccomp denies `ptrace`, `process_vm_*`, `pidfd_getfd` |
| Regaining root through setuid binaries | no_new_privs, irreversible uid drop |
| Creating namespaces, mounting, loading modules, kexec, eBPF | seccomp |
| Escaping `killTree` / outliving the time limit | `setsid` by crbox, seccomp denies `setsid`/`setpgid`, group kill after every run |
| Fork bombs | `RLIMIT_NPROC` per workspace uid |
| One giant file | `RLIMIT_FSIZE` |
| Core dumps containing secrets | `RLIMIT_CORE = 0` |
| Network access when `CODE_NETWORK=off` | seccomp socket filter |

What is **not** protected:

- **Shared kernel.** A kernel exploit from run code gives control of the container, and the container runs the
  server as root: every workspace, the link secret, the token store and the pairings.
- **No memory or CPU isolation per job.** There are no cgroups per run and no `RLIMIT_AS`. One run can exhaust
  the container's memory; the OOM killer may then take the server (and with it every unsaved Python session).
  CPU is unlimited apart from the wall-clock timeout.
- **Disk.** The quota (`WORKSPACE_QUOTA_MB`) is checked only at the start of a run and before an upload; one run
  can overshoot it by as much as it likes (up to `RLIMIT_FSIZE` per file). `DATA_DIR/tmp/<id>` is not counted
  at all: job logs there (up to 5 MB each) are never deleted, and a run's scratch folder lives there until the
  run (or its kernel) ends. `/dev/shm` is shared by all workspaces and counted nowhere.
- **Open network, including the Railway project's private network.** With `CODE_NETWORK=open` the code reaches
  the internet, the server's own port on loopback, and every service in the same Railway project and environment
  over the private network. **Measured on the live deployment (2026-11-17): `CODE_NETWORK=open`, and
  `mongodb.railway.internal` and `librechat.railway.internal` resolve from run code. Model-run code can therefore
  connect to the LibreChat database and the LibreChat service.** Whether it gets further depends only on those
  services' own authentication. The fixes are `CODE_NETWORK=off` or moving this service into a Railway project of
  its own.
- **Unix sockets and `/dev/shm`.** Without namespaces, host unix sockets (pathname and abstract) are reachable
  and `/dev/shm` is a shared directory; Landlock IPC scoping is not used. This is a channel between workspaces
  as far as file modes allow.
- **The Python kernel's control channel is in-band and forgeable** ([5.2](#52-the-persistent-python-kernel)).
  Code in the kernel can read the marker from its environment, write fake events and read control frames from
  fd 0. The effect is limited to its own workspace: wrong output, a fake exit code, a swallowed interrupt (the
  kernel is killed 3 s later anyway).
- **Secrets are visible to the code by design.** Redaction ([5.6](#56-secrets-and-redaction)) only rewrites
  output; code that encodes a secret differently, or sends it over the network, defeats it.
- **Identity headers are trusted.** Anyone holding the key (or an OAuth token) can name any `X-User-ID` and
  `X-Workspace`, read any workspace and use any user's paired browser ([8.6](#86-the-trust-statement)).
- **Links are bearer URLs.** Whoever has one has access until it expires; only share links are revocable.
- **Things that run in the server process, outside the sandbox**: the TypeScript type check (`typecheck: true`,
  `runner.js` `typeErrors()`), import splitting with the TypeScript parser, preview rendering of file bytes
  (`legacy.previewHtml()`), notebook export, and remote compilation requests (`legacy.runRemote()`).
- **Remote languages leave the server**: code for languages that are not installed is sent to Compiler Explorer
  or Wandbox, public third-party services.
- **User mode** (a host where the server is not root): no uid separation; signals and non-filesystem IPC between
  workspaces and towards the server are possible.

---

## 5. Running code

### 5.1 Languages

At import time `runner.js` probes every entry of `descriptors` with `which <bin>` (Rust: through `rustup which
rustc` when the binary is a rustup proxy, so the workspace `HOME` can stay scrubbed). A language is **local** when
found; DuckDB additionally needs `import duckdb` to succeed. `/health` lists the local languages.

| Language | Local runtime | How a run works | What persists |
|---|---|---|---|
| python | `python3` | persistent kernel ([5.2](#52-the-persistent-python-kernel)); with `fresh: true` a one-shot process ([5.3](#53-fresh-one-shot-runs)) | kernel: variables, imports, functions; pip packages in `.cr/pyuser` either way |
| javascript | the server's own `node` | fresh: `node --import resolve.mjs run.mjs` | `storage` (`.cr/storage.json`), files |
| typescript | the server's own `node` (native type stripping of `.mts`) | as javascript; `typecheck: true` runs `tsc` checks in the server first | same |
| bash | `bash` | `bash Run.sh` | files |
| sql | `python3` (sqlite3) | `sqlrun.py sql run.sql` on `data.sqlite` | `data.sqlite` |
| duckdb | `python3` + `duckdb` wheel | `sqlrun.py duckdb` on `.cr/duck.db`, shared tables as temp views | `.cr/duck.db` |
| c, c++ | `gcc`, `g++` (build-essential) | compile `-O2 -std=c17` / `-std=c++20` (+ `compiler_args`) to `run-*/program`, run it | files |
| ruby, php, lua, perl | Debian packages in the image | `<interpreter> Run.<ext>` | files |
| r | `Rscript` (build arg `WITH_R=1`) | wrapper loads/saves `.cr/session.RData`, copies plots to `rplot_N.png` | R workspace image |
| go | `go` (`WITH_GO=1`) | `go build -o program`, run | files |
| rust | `rustc` (`WITH_RUST=1`) | `rustc -O`, run | files |
| java | `java` (`WITH_JAVA=1`) | `java Run.java` (single-file source launch) | files |

**Remote fallback** (`execute()`, through `legacy.js` `runRemote()`): a run goes remote when

- `compiler_version` is given for a compiled language (anything with a `compile` entry, any Compiler Explorer
  language, or java), or
- the language is not installed and is a Compiler Explorer language (c, c++, rust, go, java, kotlin, csharp,
  fsharp, swift, zig, d, haskell, ocaml, perl, lua, dart, fortran, pascal, crystal, julia, cobol, ada, objc),
  a Wandbox language (bash, php, scala, nim, elixir), r or ruby.

Remote runs have no workspace files and no network. The output ends with `(ran remotely on Compiler Explorer
…)` or `(… Wandbox …)`. `legacy.js` loads the plugin's `implementation.js` into a `vm` context and exports its
remote adapters, preview renderer, notebook builder and image routes, so both products behave the same.

A language that is neither local nor remote-capable is refused with the list of installed languages.

### 5.2 The persistent Python kernel

One kernel per workspace (`kernels` map in `runner.js`), started on the first Python run by `ensureKernel()`
through the sandbox, with `kernel.py`, `helpers.py` and `chart.html` copied into that run's `run-*` directory
(the kernel's `home`, which stays until the kernel exits).

**The control channel.** `crbox` closes every descriptor above 2, so the kernel has only stdin, stdout and
stderr. The channel is in-band by design (comment in `ensureKernel()`); there is one spawn per kernel:

1. The kernel is spawned with `CR_CONTROL_STDIO=1` and `CR_CONTROL_PREFIX=__CR_<48 random hex>__`, random per
   kernel, so ordinary output never carries it by accident.
2. **Requests** (server to kernel) are length-prefixed JSON frames (4-byte big-endian length) on the kernel's
   **stdin**: `{id, code, stdin, cwd, secrets}` for a run, `{op:"interrupt", id}`, `{op:"stop", id}`.
3. **Events** (kernel to server) are lines on the kernel's **original stderr**: the prefix followed by
   base64-encoded JSON. Types: `ready` (with `skipped`), `output`, `missing` (module name), `done`
   (`exitCode`, `notes`), `saved` (`skipped` or `error`).
4. Before any user code runs, the kernel `dup2`s a fresh pipe onto fds 1 and 2. All user output, including
   output of C extensions and subprocesses, goes into that pipe; a reader thread turns it into `output` events.
   Lines on the original stderr without the prefix are appended to the running job.
5. **Barrier**: after a run, `flush_output()` flushes Python and libc buffers, writes a random marker into the
   output pipe and waits (at most 2 s) until the reader thread has seen it. Only then is `done` emitted, so no
   output arrives after its job finished.

The marker is in the kernel's environment and the control descriptors are reachable from Python, so code can
forge events or read control frames; see the threat table. (The docstring of `kernel.py` still describes frames on
fds 3 and 4, and `kernel.py` and `runner.js` still contain that branch; it is not used.)

A kernel that does not send `ready` within 15 s is killed.

**Running code in the kernel** (`kernel.py` main loop): set the request's secrets in `os.environ` (and restore the
previous values on the next request), `chdir` to the workspace, add the user site-packages and the workspace to
`sys.path`, give `input()` the request's `stdin`, parse with `ast`, remember the source of every top-level
`def`, `class` and `name = lambda`, run the module with top-level `await` allowed, evaluate a final expression
and print its `repr`. Exceptions become a traceback limited to user frames (`clean_error()`); a
`ModuleNotFoundError` also emits `missing`, and the runner adds `Hint: pass packages: ["<name>"]` (with the
plugin's PyPI aliases). Open matplotlib figures are saved as `figure_N.png`.

Only one job at a time uses a workspace's live Python session; a second gets `python is busy with job …`. A `fresh` run is its own process: it is not refused by a busy session, and a chat run started while it is going is not refused either (the check in `runCode()` looks only at unfinished Python jobs that are not `fresh`).

**Save and restore** (`save_state()` / `restore_state()`), for idle stop and shutdown:

- Modules are saved by name and re-imported.
- User functions and classes are saved as their source (captured when they were defined) and re-executed;
  without a captured source they are skipped.
- Everything else is pickled (protocol 4); a value whose pickle contains a secret value seen in this kernel is
  skipped.
- The state goes to `.cr/session.pkl` (atomic rename), as the workspace user.
- On the next start, values are restored first, then definitions, then values that failed the first time
  (instances of user classes). The file is deleted right after loading, so a later hard kill does not replay old
  variables. Names that could not be kept are reported once: `These Python variables could not be kept: …`.

**Idle stop**: after each Python run a timer of `KERNEL_IDLE_MIN` (30) minutes calls `stopKernel()`: send
`stop`, wait up to 5 s for `saved`, up to 1 s for exit, then `killTree`.

**Timeout and kill** (`abortJob()`): the server sends `interrupt`; the kernel's control thread raises `SIGINT` in
its own process, which becomes `KeyboardInterrupt` in the running code (also inside `time.sleep` and
interruptible native I/O). If the job has not finished 3 s later, the kernel is killed with `SIGKILL`, the
workspace is marked in `lostKernels`, and the next run starts fresh with the note `The Python kernel was
stopped. Variables were lost; this is a fresh kernel.` Code that catches `KeyboardInterrupt` or a native call
that ignores `SIGINT` ends up in this hard path.

`reset: true` kills the kernel and deletes `.cr/session.pkl` before the run.

`packages: [...]` runs `python -m pip install --user --quiet …` as a normal sandboxed process first (needs
network); packages land in `.cr/pyuser` and count against the quota.

### 5.3 Fresh one-shot runs

All non-Python languages, and Python with `fresh: true`, start a new process per run (`processRun()`), with the
run's secrets in the environment, the request's `stdin` piped in, and `killTree` after exit.

Python with `fresh: true` (`pythonOnce()`; used by schedules; not in the `run_code` schema, although `run_code` passes its arguments through, so a client could send it): the code is
written to `run.py` and run by a small driver (`PYTHON_ONCE`, written as `once.py`) next to a copy of
`helpers.py` and `chart.html`. The driver makes the helpers (`chart`, `share_table`, `get_table`, `list_tables`,
`read_text`) builtins, runs the module, prints the `repr` of a final expression, and saves open matplotlib figures
as `figure_N.png`. There is no top-level `await`, no kept state, and no kernel involved, so a busy kernel does not
block it.

JavaScript and TypeScript (`nodeRun()`): the code becomes the body of an async function in `run.mjs` / `run.mts`
after a serialised prelude (`nodePrelude()`) that defines `fs` helpers (with `/workspace/` paths mapped to the
cwd), `stdin`, `sleep`, `env`, `storage` (JSON in `.cr/storage.json`), `tables`, `chart()` and a `require`
rooted in the workspace. `import` declarations are lifted to the top. `resolve.mjs` registers a resolve hook so
the entry file's imports resolve as if the file were in the workspace (`node_modules` there work). A `return`
value is printed.

### 5.4 Jobs

Every run is a job (`runCode()`): id `j` + 10 hex characters.

| State | Exit code | When |
|---|---|---|
| `running` | null | started |
| `done` | 0 | program exited 0 |
| `failed` | program's code, or 1 | non-zero exit, preparation error, or interrupted by a restart |
| `timeout` | 124 | `timeout` reached (`RUN_TIMEOUT_S`, at most `MAX_TIMEOUT_S`) |
| `killed` | 137 | `job` action `kill`, `manage_files clear`, shutdown |

- **Wait budget and auto-detach**: unless `background: true`, `runCode()` waits `min(timeout, WAIT_BUDGET_S)`
  (default 45 s). A run still going after that returns its output so far plus
  `Still running as job j… … use the job tool (action output, wait up to 45 s per call) to follow it.` The run is
  not tied to the request: it keeps going if the client gives up.
- **Limits**: at most `MAX_JOBS` (4) unfinished jobs per workspace; one Python job at a time (a `fresh` run is not stopped by a busy kernel, see [5.2](#52-the-persistent-python-kernel)).
- **Scratch folder**: when the job finishes, `finish()` removes its `run-*` folder with `rm -rf` spawned through the sandbox as the workspace user (the folder's contents are the code's to plant, so the server does not delete them as root). The folder a live kernel was started from is kept until that kernel exits.
- **`job` tool** (tools.js): `output` waits up to `wait` seconds (default 30, max 45) and returns only output
  not seen before (offset in `meta.jobSeen`; `all: true` from the start); `list`; `kill`.
- **Logs on disk**: `DATA_DIR/tmp/<id>/jobs/<job>.log` (raw redacted output, up to 5 MB) and `<job>.json`
  (public fields; head and tail of the output once finished). Both are created by root with
  `O_EXCL | O_NOFOLLOW` through a held directory descriptor and written through held descriptors, so code that
  owns the parent directory cannot redirect them.
- **Recovery after restart**: the first access to a workspace's jobs (`workspaceJobs()`) reads `jobs/*.json`
  (with `O_NOFOLLOW`, a regular file with one link required). Jobs saved as `running` become `failed` with
  `interrupted`; their output comes from the log with the note `Server restarted; this job was interrupted.`
  A process from the old server is not controlled any more.

### 5.5 Output caps

- In memory each job keeps the first `outputHead` (30,000) and the last `outputTail` (10,000) characters;
  the rest is replaced by `[N characters dropped in the middle]`.
- Progress notifications carry new output at most every 250 ms, at most the last 2,000 characters per message,
  and only when the client sent a `progressToken`.
- The log file keeps up to 5 MB.
- Then the result guard applies ([section 7](#7-the-result-guard)).

### 5.6 Secrets and redaction

Secrets come from `CODE_SECRETS` (operator) and the `X-Code-Secrets` header (per request), both in the form
`NAME=value; NAME2=value` (`config.js` `parseSecrets()`; names must be identifiers, values shorter than 6
characters are dropped because redacting them would mangle ordinary output).

- They reach the code as environment variables (non-Python: at spawn; Python: per request in `os.environ`,
  restored afterwards).
- **Redaction** (`runner.js`): each value is replaced by `[secret NAME]` in its raw, base64, URL-encoded and
  form-encoded forms, longest first, in one regular-expression pass. `StreamRedactor` holds back a tail that
  could be the beginning of a secret, so a value split across output chunks is still caught.
- A per-workspace bank (`secretBanks`, in memory) remembers every secret form seen in that workspace, so output
  of later runs is redacted even if the secret is not sent again.
- The job label, history entries, browser texts and error messages are redacted too; the pickled session skips
  values containing secrets.

This prevents accidental echo. It does not stop code that wants to leak a secret (reverse it, hex it, send it
over the network).

### 5.7 File change notes

`execute()` lists the workspace before the run, `finish()` after it (excluding `.cr/`) and appends one note:
`Files created: out.csv (11 B); changed: data.json; deleted: old.txt`. If the output mentions `ENOENT`,
`FileNotFoundError` or `No such file or directory`, it adds the workspace contents (or says it is empty).

### 5.8 History and notebook export

`finish()` appends `{language, code (redacted), output (first 2,000 characters), time}` to `meta.history` (unless the run was started with `record: false`, as scheduled runs are),
keeping the last 200. `manage_files` action `export_notebook` turns it into `notebook.ipynb` or `notebook.md` in
the workspace (`legacy.buildNotebook()`).

### 5.9 Example of a long run

```
run_code {"language":"python","code":"import time\nfor i in range(100):\n    print(i, flush=True); time.sleep(1)"}
```

returns after 45 s:

```
0
1
...
44


Still running as job j3f9a1c2b7d ... use the job tool (action output, wait up to 45 s per call) to follow it.
```

and `job {"id":"j3f9a1c2b7d","wait":45}` later returns

```
Job j3f9a1c2b7d  running  python  90 s  import time
for i in range(100):
    print(i, flush=True); time.

45
...
```

---

## 6. REA (reverse engineering)

### What it is

REA ("Reverse Engineer Anything", npm package `rea-agents`, pinned by the build argument `REA_VERSION=6.2.0`)
is a stdio MCP server with about 140 tools for native binaries, JavaScript/Electron apps, web bundles, .NET,
APKs, firmware and websites. `rea.js` makes its tools part of `/mcp`; there is no second endpoint.

### One sandboxed process per workspace

- `resolveCommand()` resolves `REA_COMMAND` (default `rea mcp`) on `PATH`, checks it is executable, and collects
  the install root of every absolute argument (the folder containing `node_modules`, else the file's folder) as
  extra read-only Landlock paths. A missing command makes `reaAvailable()` false and the tools disappear.
- `startChild()` spawns `/bin/sh -c 'mkdir -p "$XDG_…" && exec "$@"' rea <command>` through
  `spawnInWorkspace()`: same uid, Landlock, seccomp and network setting as model code, cwd = the workspace, so
  relative paths in REA arguments resolve to workspace files. Cache and settings live in `.cr/rea/`.
- Started on the first call that needs it; `initialize` must answer within 90 s.
- An active-call counter keeps it alive; after `REA_IDLE_MIN` (15) idle minutes `stopEntry()` closes it
  (SIGTERM, SIGKILL 3 s later). On shutdown all are stopped (4 s, then SIGKILL).
- An unexpected exit is logged with the tail of REA's stderr; the next call starts a new process.

### The custom stdio transport

The SDK's own stdio client transport spawns its child process itself, which would bypass the sandbox.
`ChildTransport` instead wraps the already-spawned sandboxed child: it feeds stdout into the SDK's `ReadBuffer`
(newline-delimited JSON-RPC, 64 MB buffer) and writes `serializeMessage()` output to stdin. The SDK `Client`
runs on top of it.

### Compact mode versus `REA_TOOLS=full`

| | `compact` (default) | `full` |
|---|---|---|
| `tools/list` | `rea_find`, `rea_call` (static, no REA process needed) | every REA tool, output schemas removed |
| Model calls | `rea_find` (catalogue, search, one tool's schema), then `rea_call {tool, arguments}` | the REA tool directly |
| Direct REA names | still forwarded (clients that cached a long list) | forwarded |

**The measured reason** (REA 6.2.0, measured by the operator; the comments in `rea.js` and `config.js` give the
same figures rounded): REA's own tool list was **2.0 MB** of JSON, of which **1.38 MB were output schemas**. A chat
client sends the tool list with every model request. And one `binary_session` result was **406 KB**, which
**stalled a LibreChat turn**: the client could not pass the result back to the model and the chat stopped. Hence
output schemas are always stripped (`slim()`), compact mode is the default (what is left without output schemas
is still over half a megabyte), and results are capped.

### Result capping and the `rea/` files

`fit()` joins the text parts (or, when there is no text, serialises `structuredContent`), drops
`structuredContent`, and when the text exceeds `REA_MAX_CHARS` (20,000) saves the full text as
`rea/<tool>-<UTC time>.json` in the workspace and returns 75 % head, 25 % tail and a note with the file name and
a `json.load(open(...))` hint. The general result guard then applies on top. A rejected argument list gets a
pointer to `rea_find {tool}`.

Each forwarded call has `REA_CALL_TIMEOUT_S` (300) as timeout and total timeout, follows the client's abort
signal, and passes progress notifications through when the client asked for them.

### The catalogue cache

`loadCatalog()` fetches the tool list once per server process, from the REA process of whichever workspace
first needs it (in compact mode the first `rea_find`, in full mode the first `tools/list`), strips output
schemas and keeps it in memory for every workspace. A failed load returns an empty list and is retried at most
once a minute, so a REA that cannot start does not slow down every `tools/list`. REA tools that share a name
with a Code Runner tool are left out.

Note: that first process runs with its own workspace's `.cr/rea/` configuration, which that workspace's code can
write.

### What works without native engines

Static JavaScript, Electron (`.asar`), web-bundle and source-map analysis, .NET metadata, plists, artifact
inventories and saved HAR captures. Native decompilation (Ghidra with a JDK, IDA, Hopper), Android (JADX with a
JDK), firmware (binwalk) and browser capture (a Chrome-family browser) need their engines in the image.

### Adding engines

Install them in the image with `EXTRA_APT="…"` (Debian packages) or a Dockerfile change. They must live where
the sandbox can read them: under `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc` or `/opt`, or under an install root
derived from `REA_COMMAND`'s arguments. A tool installed anywhere else (for example under `/root`) is invisible
to REA inside Landlock. Then restart; the catalogue is per process.

---

## 7. The result guard

`guard.js`. A chat client hands each tool result to the model; a result that is too big does not fail loudly,
the client drops the turn and the chat stops. Every tool has its own limits, but one forgotten path is enough,
so this is enforced once, for all tools including REA.

**`guardResult(ws, tool, result)`**:

- A result without a `content` array becomes `The tool returned nothing.` (error).
- All text parts are joined with blank lines. Above `RESULT_MAX_CHARS` (60,000) the full text is written to
  `results/<tool>-<UTC time>.txt` in the workspace (through `wsfs`, as the workspace user) and the text is cut to
  75 % head and 25 % tail with `... [N characters left out] ...` and a note naming the file.
- Non-text parts (images, attachments) share one budget of `RESULT_IMAGE_MAX_KB` (1024 KB), estimated from the
  base64 length. A part over the remaining budget is left out with `(An image of N KB was left out … Use
  serve_file …)`. Images are already files in the workspace.
- `structuredContent` is never sent (it is a second copy of the same data). Only `content` and `isError` leave.

**`guardedCall(ws, tool, run)`**:

- Races the handler against `CALL_CEILING_S` (600 s). At the ceiling the answer is
  `**<tool> failed:** no answer within 600 s. The call was given up on; a run it started may still be going (see
  the job tool).` The handler is not cancelled; its work continues.
- A thrown error becomes `**<tool> failed:** <message>`.
- If the guard itself fails, the answer is an error saying the result could not be prepared.
- Writes the log line of [section 2](#the-log-line).

---

## 8. Authentication

`mcp-auth.js`, ported from another project (`reddit_mcp_buddy`), Node crypto only.

### 8.1 The single secret

`config.apiKey` = `MCP_API_KEY`, or `MCP_PASSWORD` as an alias. It is compared byte for byte (whitespace
counts). Without it the server refuses to start (`index.js` `main()`), unless `ALLOW_NO_AUTH=1`, which opens
`/mcp` without any authentication (local tests only). A key shorter than 16 characters gives a startup warning,
and it is then not used to derive the server secret, so links and pairings depend on `SERVER_SECRET` or the
volume's `.secret` file.

### 8.2 Ways to present it

`checkAuth()` takes a credential from (in order) `Authorization: Bearer`, `Authorization: Basic` (the key may be
the user name or the password; an issued token works too), `X-API-Key`, or the query string `api_key` /
`access_token`. **The raw key is refused in the query string** (URLs end up in logs); only issued tokens are
accepted there.

A request without credentials gets 401 with
`WWW-Authenticate: Bearer realm="mcp", resource_metadata="<base>/.well-known/oauth-protected-resource"`, which is
what OAuth clients use to discover the authorisation server.

### 8.3 OAuth 2.1

| Route | What it does |
|---|---|
| `GET /.well-known/oauth-authorization-server` | issuer, endpoints, `code` only, grants `authorization_code` and `client_credentials`, PKCE `S256`, auth methods `client_secret_post`, `client_secret_basic`, `none` |
| `GET /.well-known/oauth-protected-resource[/mcp]` | resource `<base>/mcp`, authorisation server `<base>` |
| `POST /oauth/register` | open dynamic client registration (RFC 7591): 1 to 5 redirect URIs, each at most 2000 characters, `https:` or `http://localhost` / `127.0.0.1`. Returns a random `client_id`, no client secret |
| `GET /oauth/authorize` | requires `code_challenge` (only `S256`), checks the redirect URI against the client's registration, renders a consent form asking for the key |
| `POST /oauth/authorize` | verifies the key (throttled), issues a single-use code valid 60 s, redirects with `code` and `state` |
| `POST /oauth/token`, `grant_type=authorization_code` | code must exist, not expired, same `redirect_uri`, same `client_id` if given, PKCE verifier must match; any failure burns the code |
| `POST /oauth/token`, `grant_type=client_credentials` | `client_secret` (form or Basic) must be the key (throttled) |
| `POST /oauth/revoke` | needs a valid credential; revokes one `token`, or all with `revoke_all=true` |

An unknown `client_id` at `/oauth/authorize` is adopted with its redirect URI: connectors cache their client id
forever and do not re-register, so an id lost from the registry would lock them out. Registration is open
anyway, so adoption grants nothing; a known client still cannot use a redirect URI it did not register.

**Issued tokens are self-validating** (`mintAccessToken()`, `readSignedToken()`):

```
crt1.<base64url(JSON {i: issued ms, n: 12 random bytes, s: "mcp"[, e: expiry ms]})>.<base64url(HMAC-SHA256(K, body))>
K = HMAC-SHA256(MCP_API_KEY, "code-runner access token v1")
```

The server accepts a token that is in its store, or, when it is not (store wiped, new volume), one whose
signature checks out with the current key, that was not issued before `revokedBefore`, is not in the `REVOKED`
set and has not expired. A token admitted by its signature is written back into the store. Tokens longer than
600 characters are not considered. Changing `MCP_API_KEY` changes `K` and so ends every token.

Why: a redeploy without a volume wiped the token store, and the next request of a LibreChat connector was refused
with 401 before any tool ran; the chat simply stalled. With signed tokens the store is a convenience, not a
requirement (comment above `SIGNED_PREFIX`). Tokens of the older opaque format (random bytes, from before this
change) are still accepted while they are in the store, but not after it is lost.

Tokens do not expire on the server; the token response advertises `expires_in` of about ten years because some
clients reject a missing value. The key itself is never returned as a token.

### 8.4 The token store

`DATA_DIR/mcp-tokens.json` (or `MCP_TOKEN_STORE`), mode 0600, written atomically:

```json
{"version":2,
 "seedSalt":"<32 hex>",
 "passwordSeed":"<HMAC-SHA256(seedSalt, key)>",
 "tokens":{"<sha256 hex of the token>":{"expiresAt":null,"issuedAt":1763380000000,"scope":"mcp"}},
 "clients":{"mcp-<hex>":{"clientId":"mcp-<hex>","redirectUris":["https://…"],"clientName":"…","registeredAt":…}},
 "revoked":["<sha256 hex of a revoked signed token>"],
 "revokedBefore":0}
```

- Tokens are stored only as SHA-256 hashes; the file holds nothing that can be replayed.
- `revoked` and `revokedBefore` are needed because a signed token would otherwise pass again by its signature
  alone: `/oauth/revoke` with `token` adds that token's hash to `revoked` (at most 10,000 kept, oldest dropped);
  `revoke_all=true` empties the store and sets `revokedBefore` to now, which refuses every token issued earlier.
  **Revocations are only as durable as this file**: without a volume, a redeploy forgets them and revoked signed
  tokens become valid again (until the key changes).
- `passwordSeed` detects key rotation: at boot, a stored seed that differs from the current key's seed drops
  every stored token (signed tokens fail anyway, their key changed). Client registrations survive rotation.
- Caps: 10,000 tokens and 1,000 clients (oldest dropped first), 10,000 open auth codes.
- Auth codes and failure counters are in memory only.
- A failed write is logged and the in-memory store stays authoritative for the life of the process.

### 8.5 Lockout and forwarded-for handling

Per source address (`FAILURE_COUNTERS`): a wrong credential on `/mcp`, a wrong key on the consent form, a wrong
`client_secret` or a wrong revoke credential counts as a failure; a request with no credential does not. From
the third failure on, the address must wait `1 s × 2^(failures − 3)` after its last failure, capped at
2^4 = **16 s** (the 30 s maximum constant is never reached), and gets 429 with `Retry-After: 30`. The lockout is
checked before the key is compared, so a throttled guess gets no answer. A correct key resets the counter. An
issued token passes even while its address is throttled.

The source address (`getSourceIp()`) is the **last** `X-Forwarded-For` hop, the one the proxy in front of the
server appended; earlier hops are whatever the client sent and would let it rotate addresses or lock out
someone else. A connection from loopback (code in the sandbox, which did not come through the proxy) ignores the
header. The bridge's pairing rate limit uses the same rule.

`MCP_TRUST_PROXY=1` lets the OAuth issuer URL follow `X-Forwarded-Proto` / `X-Forwarded-Host`; with
`PUBLIC_URL` or `RAILWAY_PUBLIC_DOMAIN` set it is not needed.

### 8.6 The trust statement

`X-User-ID`, `X-Workspace` and `X-Code-Secrets` are taken from the request as they are. They are trusted because
only the MCP client holds the key. Consequences:

- Anyone with the key, or with any issued OAuth token, can act as any user: read and write any workspace,
  start code there, use any user's paired browser.
- OAuth tokens are not bound to a user. A connector that sends no `X-User-ID` (for example claude.ai) works in
  user `default`, workspace `main`, shared by every such connector.
- For mutually distrusting users, run one deployment per user.

---

## 9. Browser bridge

Server side `bridge.js`, browser side `extension/background.js` (service worker), `extension/options.js`
(options page), `extension/content.js` (TypingMind relay), `extension/page-agent.js` (in-page agent).

### 9.1 Pairing, step by step

1. The model calls a `browser_*` tool. `tools.js` `browserCall()` asks `bridgeStatus(user)` for connected
   devices of that user. With none, it calls `createPairingCode(user)` and returns instructions with the server
   URL and the code (`pairingHelp()`).
2. `createPairingCode()`: 10 characters from a 32-letter alphabet without `I`, `O`, `0`, `1`, shown as
   `ABCD-EFGH-JK`, valid 10 minutes, single use, bound to the user. Stored **in memory only**, as its SHA-256.
   At most 5 open codes per user: a sixth replaces the oldest (every browser call without a linked browser asks
   for a code, and that call must still get a usable answer). 10,000 open codes in total, then an error.
3. The user enters the URL (origin only, `https:`, or `http:` on localhost / 127.0.0.1; `https://host#CODE` is
   accepted) and the code on the options page and presses **Pair** (`options.js` `pair()`; refused while a link
   already exists: unlink first).
4. `POST /bridge/pair` `{code, name, version}`. The server (`handleBridgeHttp()`) requires either no `Origin` or
   a `chrome-extension://<32 letters a-p>` origin, a body of at most 4 KB, and passes the rate limit
   (10 attempts per minute per address, 120 per minute in total). It compares the hash of the code against every
   open code in constant time without stopping early.
5. On a match it creates a device `{deviceId (UUID), tokenHash, user, name, version, created, lastSeen}`, mints
   its token, writes `bridge.json` (0600, fsync, atomic rename), deletes the code, and answers
   `{deviceId, token, user}`. If the write fails, the pairing is rolled back.
6. The extension (0.5.1; `options.js` accepts tokens of 43 to 900 characters of `[A-Za-z0-9_.-]`) stores
   `{url, deviceId, token, user}` in `chrome.storage.local`, which `bootRemote()` restricts to trusted extension
   contexts (content scripts cannot read it), and connects.

**Device tokens are self-validating** (`mintDeviceToken()`, `readDeviceToken()`), like OAuth tokens:

```
crd1.<base64url(JSON {d: deviceId, u: user, n: name, c: created, r: 9 random bytes})>.<base64url(HMAC-SHA256(D, body))>
D = HMAC-SHA256(server secret, "code-runner bridge device v1")
```

`credential()` first looks the device up in `bridge.json`. If the device is unknown (the file was wiped) and its
id is not in `revoked`, a token with a valid signature whose `d` matches restores the pairing from the token's own
fields and saves it. Since the server secret is derived from `MCP_API_KEY` when that is long enough
([section 3](#signed-link-tokens)), pairings survive a redeploy without a volume; changing the key (or the secret)
ends them all.

`bridge.json` holds token hashes and the `revoked` list of unlinked device ids (the newest 5,000). A damaged
`bridge.json` makes `load()` throw ("refusing to discard paired devices") instead of starting with an empty list.

### 9.2 The WebSocket protocol

`wss://<server>/bridge`, no query string allowed, `Origin` must be absent or an extension origin, JSON text
frames only, at most 32 MB per message, no compression.

| Direction | Message | Notes |
|---|---|---|
| ext -> server | `{"type":"hello","deviceId":"…","token":"crd1.…","version":"0.5.1"}` | must be the first message, within 5 s |
| server -> ext | `{"type":"ready","user":"alice"}` | credential verified in constant time |
| server -> ext | `{"type":"req","id":"<uuid>","request":{"op":"page.state",…,"policy":{…},"confirmRisky":true,"highlight":true}}` | one per tool call |
| ext -> server | `{"type":"res","id":"<uuid>","response":{"ok":true,…}}` | `response.ok` must be a boolean |
| ext -> server | `{"type":"ping"}` | every 20 s |
| server -> ext | `{"type":"pong"}` | |

Close codes: **4401** "Pairing rejected, pair again" (bad hello, revoked device), **4400** invalid message,
handshake timeout or "Device reconnected" (a second socket of the same device replaces the first).

At most 16 sockets may wait for their hello at a time (each could buffer a large frame). A response id is only
accepted on the socket the request went out on.

### 9.3 Keepalive and reconnect

- The extension pings every 20 s; this also keeps the MV3 service worker alive. The server drops a socket that
  has been silent for 70 s.
- On close (other than 4401) the extension reconnects with exponential backoff: `1 s × 2^min(failures, 6)`,
  ±20 % jitter, capped at 60 s. A `chrome.alarms` alarm every minute restarts the link when the service worker
  was suspended.
- On 4401 the extension sets `remoteAuthRejected` and stops retrying; the user has to unlink and pair again.
- With several connected devices of one user, the request goes to the one paired or answering most recently.
  `lastSeen` is saved on each answer.

### 9.4 How a browser_* call travels

```
model -> tools/call browser_state {mode:"elements"}
  tools.js browser_state() -> browserCall(ctx, {op:"page.state", ...}, 45000)
     adds policy {allow: BROWSER_ALLOW_SITES, block: BROWSER_BLOCK_SITES},
          confirmRisky: BROWSER_CONFIRM, highlight: BROWSER_HIGHLIGHT
  bridge.js bridgeCall(user, request, timeout) -> {"type":"req",...} over the user's newest socket
     extension background.js handle(request, REMOTE_SOURCE)
        local switches and lists applied (9.5)
        chrome.tabs / chrome.scripting (page-agent.js, isolated world) / chrome.debugger (CDP input, screenshots, scripts)
     {"type":"res","id":...,"response":{ok:true,...}}
  tools.js formats the snapshot, redacts secrets, caps text at 24,000 characters (or max_chars)
  -> guard.js -> client
```

Timeouts per call: 20 s by default, `browser_tabs` 30 s, `browser_state` 45 s, `browser_run` its own timeout
plus 5 s (max 120 s), `browser_act` 60 s plus waits plus 15 s per action. Screenshots are saved into the
workspace and returned inline when small enough.

### 9.5 Controls the server cannot override

Applied in `background.js` `handle()` for requests that come over the remote link (`REMOTE_SOURCE`, an object
only the socket callback holds, so no page message can claim it):

- **Master switch** (`Remote link enabled`): off refuses every remote request (`code: "offline"`), and the link
  disconnects.
- **Site lists**: the extension's blocked sites are added to the server's; the server's and the extension's
  allow lists must both permit the host when non-empty. Remote access is limited to `http:` and `https:` pages.
  Lists are checked before a tab is read or touched, for navigation targets, after redirects, and for history
  steps (a step onto a blocked site is undone).
- **Risky-action confirmation**: the guard is on if the extension's switch is on **or** the server asks for it
  (`s.remoteConfirmRisky !== false || req.confirmRisky !== false`). The server can turn it on but not off.
  Held are clicks and Enter/Space presses whose element, form or text suggests buying, paying, deleting,
  sending, publishing or a password form. The model releases a held action by repeating it with
  `confirm: true`; that relies on the model asking the user, there is no browser dialog.
- **Script switch** (`Allow running scripts`): off refuses `browser_run` (`code: "scripts-disabled"`). Scripts
  are not covered by the risky-action guard.
- **Chat page hosts**: tabs on these hosts are skipped when choosing a default tab. This list grants nothing.

The paired server can read and operate allowed tabs, including signed-in pages. Site lists constrain the
selected tab and navigation; they are not a firewall: a page or a script can still make requests elsewhere.

### 9.6 The TypingMind relay, and its weakness

The extension still serves the original plugin: `content.js` is injected into every frame of every page
(`all_frames`, `match_origin_as_fallback`), relays `{__crbReq, id, request}` messages a frame posts to itself to
the service worker, and posts the answer back. The service worker answers only when the tab's top-level page is
on a trusted host (default `typingmind.com`, `*.typingmind.com`) and the request came from a frame at depth 1 or
deeper (not from the page itself).

**Known weakness**: TypingMind wraps its plugin frame in sandboxed frames, so the plugin cannot be told apart from
content nested inside it. **Any frame inside a trusted TypingMind page can use the bridge**: rendered previews and
charts, other plugins' HTML output. On this path the site policy and `confirmRisky` come from the request
itself, and the extension's remote-link lists and switches do not apply (they are checked only for
`REMOTE_SOURCE`). Turning the remote link off does not affect the relay.

### 9.7 Revocation

- From the server: `manage_files` action `unlink_browser` (`revokeDevices(user)`) deletes all devices of that
  user, adds their ids to `revoked`, closes their sockets with 4401 and deletes their open codes.
- From the extension: **Unlink** calls `POST /bridge/unpair {deviceId, token}` (`removeDevice()`, which also
  records the id in `revoked`), then forgets the local credential. If the server cannot be reached, local access
  stops anyway but the server-side device remains.
- The `revoked` list is what keeps an unlinked device's still-valid signed token from restoring itself. It is
  stored in `bridge.json`, so **without a volume a redeploy forgets it** and an unlinked browser that still holds
  its token could reconnect. Changing the key (or `SERVER_SECRET`) is the revocation that survives everything.

---

## 10. Links for the user

`web.js`. No link needs the API key; each carries a signed token ([section 3](#signed-link-tokens)). A link in a
chat transcript is a bearer credential.

### Routes

- **`/f/<token>/<name>`** (kinds `f` and `s`): the file. `Content-Disposition` is `inline` for types a browser
  renders (common images including SVG, audio, video, `text/*`, PDF, JSON, XML) unless the link was made with
  `download`, otherwise `attachment`. Range requests are supported (media seeking). GET and HEAD only.
- **`/p/<token>/<name>`**: an interactive preview page built by `legacy.previewHtml()` (tables for CSV, TSV,
  JSON, Excel, Parquet and SQLite; rendered HTML and chart pages; Markdown, Word, PowerPoint, notebooks; audio,
  video, images, PDF). Files above 15 MB are refused with 413.
- **`/w/<token>/`**: the workspace page: every file (without `.cr/` and symlinks) with "open" and "download"
  links minted fresh on each view, and an upload box.
- **`POST /w/<token>/upload?name=<file>`**: one file per request into `uploads/`.

### Shares and revocation

`serve_file` with `share: true` calls `shareUrl()`: a 6-byte random id stored in `meta.shares[id] = {path,
created, exp}` and a token of kind `s` with that id. `/f/` honours an `s` token only while the id is still in the
metadata with the same path. `manage_files` action `unshare` removes by id, by path or `all`; deleting a file
also removes its shares; `clear` removes all. `f`, `p` and `w` links are not revocable individually.

### The sandbox CSP

Every file and preview response carries

```
Content-Security-Policy: sandbox allow-scripts allow-downloads allow-popups allow-forms allow-modals
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

Without `allow-same-origin` the page runs in an opaque origin: scripts in a model-written HTML file run, but
cannot read this server's other pages, cookies or storage. They can still make network requests to other sites.
The workspace page itself gets a strict CSP of its own (`default-src 'none'`, inline script and style only,
`connect-src 'self'`, `frame-ancestors 'none'`).

### Upload rules

- If the browser sends `Sec-Fetch-Site`, it must be `same-origin` (so a cross-site form or script cannot post).
- The name is reduced to its last path segment, control characters removed; empty names and names starting
  with `.` are refused. The file goes to `uploads/<name>` and replaces an existing file of that name.
- The quota is checked first (507 when full); the body is limited to `min(MAX_FILE_MB, 200)` MB (413).
- The file is written through `wsfs`, as the workspace user.

### Size and concurrency bounds

- A served file is read completely into memory, up to `min(MAX_FILE_MB, 256)` MB (256 MB with the defaults).
- At most 4 files are served at the same time; a fifth request gets 503 with `Retry-After: 2`. With the
  defaults that is up to about 1 GB of memory at peak.
- Previews: 15 MB. `serve_file` inlines images up to `RESULT_IMAGE_MAX_KB`.

---

## 11. Schedules

`schedule.js`, tool `schedule` (`create`, `list`, `delete`, `run`).

- **Storage**: `meta.schedules[name] = {name, language, code, created, runs, everyMin | dailyAt, timeout, next,
  lastRun, lastState}`, in the server-side metadata, so the code cannot change its own timetable.
- **Limits**: 10 schedules per workspace; names of 1 to 40 letters, digits, `-`, `_`; `every_minutes` at least 5
  (at most 31 days), or `daily_at` `HH:MM` in UTC; `timeout` per run clamped to `MAX_TIMEOUT_S`.
- **Ticker**: `startScheduler()` runs `tick()` every 30 s. It loads every workspace that has metadata
  (`allWorkspaces()`, which reads every file in `DATA_DIR/meta` on each tick) and starts each due schedule. The
  next time is computed from now, so runs missed while the server was down are not replayed (at most one run
  fires on catch-up).
- **A run** (`runOnce()`): never two at once for the same schedule; `runCode(..., background: true, fresh: true,
  record: false)` with per-request secrets empty (operator `CODE_SECRETS` still apply). `fresh` makes Python a
  one-shot process ([5.3](#53-fresh-one-shot-runs)), so every run really starts without the chat's variables and
  is not blocked by a busy chat kernel; `record: false` keeps it out of the run history. `runOnce()` then polls the job every 30 s until it ends or its
  timeout plus 15 s has passed (then kills it); appends
  `=== <ISO time>  <state> ===\n<output, at most 20,000 characters>` to `schedules/<name>.log` in the workspace,
  which keeps its newest 512 KB (older entries are removed, the file is read back up to 2 MB). Then `lastRun`,
  `lastState` and `runs` are updated.
- Scheduled runs count against `MAX_JOBS`.

A run that `runCode()` refuses before creating a job (too many jobs, server shutting down) returns no job id and
is logged with state `refused` and the refusal text. A full workspace is not a refusal in that sense: the quota is
checked inside the job, which then ends as `failed` (the comment in `runOnce()` lists quota among the refusals).
While a scheduled Python run is going, a chat Python run is refused as busy.

---

## 12. Failure and recovery

| What breaks | What happens automatically | What the operator must do |
|---|---|---|
| **Server restart or redeploy, with a volume** | `SIGTERM`: scheduler stops, running jobs are killed (state `killed`), every Python kernel saves its variables to `.cr/session.pkl`, REA processes are stopped; all within 8 s, then exit. After start: variables are restored on the next Python run (unpicklable ones are listed), jobs are recovered from `tmp/<id>/jobs` (ones still marked `running`, e.g. after a hard kill, show as `failed` and interrupted with their saved log), OAuth tokens, client registrations and revocations load from `mcp-tokens.json`, pairings and revoked device ids from `bridge.json` and the extension reconnects within about a minute, links stay valid, schedules continue. Lost: open pairing codes, OAuth auth codes, lockout counters, REA processes (restarted on demand), the secret redaction bank (rebuilt as secrets are sent again). | Nothing. A run that needed more than the shutdown window is gone; rerun it. |
| **Redeploy without a volume** | Everything under `/data` is in the container and starts empty. **Still working** (with `MCP_API_KEY` of 16+ characters and unchanged): OAuth tokens of the signed `crt1.` format (admitted by signature and written back), browser pairings (restored from the `crd1.` token on the extension's next hello), `f`/`p`/`w` links as tokens (the server secret is derived from the key, unless `SERVER_SECRET` is set, which also survives). **Lost**: every workspace's files (so file and preview links answer "no longer exists"), Python sessions and package installs (`.cr/pyuser`, `.cr/npm`), job logs and job history, the run history, schedules, share-link metadata (so every public share stops working), the uid map (`uids.json`, rebuilt from scratch on the empty volume), the revocation lists (`revoked` tokens and `revokedBefore`, revoked device ids: revoked signed tokens and unlinked browsers are accepted again), OAuth client registrations (re-adopted on the next authorize), older opaque OAuth tokens, `.secret` if it was the secret source. Background: before tokens were signed, exactly this case stalled a LibreChat turn: the wiped store made the client's token fail with 401 before any tool ran. | Attach a volume at `/data`. If revocations mattered, change `MCP_API_KEY` (ends all tokens, pairings and links). If the key is shorter than 16 characters and no `SERVER_SECRET` is set, also all links and pairings are lost. |
| **Python kernel crash** | The pending run fails with `Python kernel stopped (…). Variables were lost; the next run starts a fresh kernel.`; the next run starts a fresh kernel and says so. | Nothing; look at the run's output for the cause (often memory). |
| **Python run timeout** | Interrupt (`KeyboardInterrupt`); if the run has not ended 3 s later, the kernel is killed and variables are lost. State `timeout`, exit 124. | Nothing. Raise `timeout` per call (up to `MAX_TIMEOUT_S`) or use `background: true`. |
| **Kernel does not start** | After 15 s the start is abandoned, the run fails. | Check the log; usually the sandbox or Python installation. |
| **REA crash** | Logged as `rea: process of workspace … exited (…)` with stderr; the call in flight fails with `REA call failed: … REA stderr: …`; the next call starts a new process. | Nothing, unless it repeats (then read REA's stderr in the log). |
| **REA fails to start** | `REA could not start: …` with stderr (initialise timeout 90 s). If it happened while loading the catalogue, `rea_find` reports REA as unavailable and the load is retried at most once a minute. If the command itself is missing, the REA tools are not listed at all and `/health` says `"rea": false`. | Fix `REA_COMMAND` / the image (`WITH_REA=1`), restart. |
| **Extension offline (paired, browser closed)** | The browser tool answers with **a new pairing code** (because `bridgeStatus()` counts only connected devices, see [section 15](#15-known-discrepancies)); from the sixth call on, each new code replaces the oldest open one. | Tell the user to open Chrome; the extension reconnects within a minute. Do not re-pair. |
| **Key changed (`MCP_API_KEY`)** | Every issued token, every device token and (when the secret is derived from the key) every link stops working; `auth refused 401` lines appear for connectors still using old tokens. | Reconnect OAuth clients, update Bearer clients, unlink and re-pair browsers. |
| **Pairing revoked or rejected** | The socket closes with 4401; the extension stops retrying and shows "Pairing rejected, pair again". | User: Unlink, then pair with a new code. |
| **Sandbox unavailable at startup** | `refuse: true`. Every code run and every server-side file operation (links, uploads, previews) fails with `Sandbox unavailable: <reason> Code execution is refused. …`. `/health` returns 503, so a new Railway deployment fails its health check (120 s) and does not go live. Startup log: `sandbox: off {...}` and `sandbox note: Sandbox unavailable: …`. | Fix the reason given (missing gcc/crbox, root without setuid, `CODE_NETWORK=off` without seccomp, a host with no Landlock in user mode). `SANDBOX=off` only for local testing. |
| **Damaged `uids.json`** | On the first workspace load after a restart, `loadUids()` throws; every MCP request and link fails with 500 `internal error` (`request failed:` in the log). Nothing is reassigned. | Restore it from a backup, or rebuild it from the owners of the directories: `{"<id>": <uid of DATA_DIR/ws/<id>>, ...}` (e.g. `stat -c '"%n": %u' /data/ws/*` and edit to JSON with the bare ids). Never start with an empty map while workspaces exist. |
| **Damaged `bridge.json`** | `load()` throws at startup (`attachBridge`), the server does not start. | Restore or fix the file; deleting it unpairs every browser. |
| **Damaged `mcp-tokens.json`** | Logged (`failed to read token store`), the server starts with an empty store; signed tokens are admitted again by signature. Revocations in the file are lost. | Nothing for working clients; restore the file if revocations mattered, or change the key. |
| **Full disk** | Writes fail where they happen: metadata (`saveMeta`) and new workspaces throw (500), `wsfs.write` fails (tool errors, guard notes "could not be saved"), job logs stop silently, the token store logs `failed to persist` and continues in memory, pairing answers 500 and is rolled back, saving Python variables fails (they are lost on stop). | Free space: `manage_files` `clear` per workspace, and on the volume the never-cleaned `DATA_DIR/tmp/<id>/jobs/*.log` (and any `run-*` folder left behind by a server that died mid-run). Enlarge the volume (measured: 50 GB attached). |
| **Oversized result** | The guard keeps 60,000 characters (head and tail), saves the full text to `results/…txt`, leaves out media over 1 MB; REA results over 20,000 characters go to `rea/…json`. Log: `(cut from …B)`. | Nothing; lower `RESULT_MAX_CHARS` if a client still stalls. |
| **A call that never returns** | After `CALL_CEILING_S` (600 s) an error result is sent; log `ceiling`. The work is not cancelled (a run continues as a job). | Look at what the tool waited for (browser extension, REA). |
| **Client timeout during a long run** | The run is independent of the request: after `WAIT_BUDGET_S` (45 s) `run_code` returns the job id. If the client gave up earlier, the job still runs and the model can follow it with `job`. A client cancel does not stop a run (`ctx.signal` is not used by the runner). | Keep the client's tool timeout above `WAIT_BUDGET_S` (LibreChat: `timeout: 120000`). |
| **Out of memory** | No per-job limit; the kernel's OOM killer picks a process, possibly the server. Railway restarts the container on failure (`restartPolicyType: ON_FAILURE`, 10 retries). Unsaved Python variables are lost; jobs show as interrupted. | Find the run from the tool lines before the crash; consider a larger instance. |

---

## 13. Configuration reference

All variables read anywhere in `server/src`. Numbers are clamped to the range shown; flags treat `0`, `off`,
`false`, `no` as off.

### Server, identity, links

| Variable | Default | Range | Read in | Effect |
|---|---|---|---|---|
| `PORT` | 8080 | 1-65535 | config.js | listen port |
| `DATA_DIR` | unset: `RAILWAY_VOLUME_MOUNT_PATH`, else `/data` | | config.js | all persistent state (the Dockerfile does not set it) |
| `RAILWAY_VOLUME_MOUNT_PATH` | set by Railway | | config.js | fallback for `DATA_DIR` |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN`, else `http://localhost:$PORT` | | config.js, mcp-auth.js | base of links and OAuth URLs |
| `RAILWAY_PUBLIC_DOMAIN` | set by Railway | | config.js, mcp-auth.js | see above |
| `SERVER_SECRET` | derived from `MCP_API_KEY` (16+ chars), else `DATA_DIR/.secret` | at least 16 chars | config.js | HMAC key for link tokens and base of the browser device key; when set it takes precedence over the key-derived secret |

### Authentication

| Variable | Default | Read in | Effect |
|---|---|---|---|
| `MCP_API_KEY` | required | config.js | the one secret; also the signing base of issued OAuth tokens and (16+ characters, no `SERVER_SECRET`) of links and device tokens, so changing it ends all of them |
| `MCP_PASSWORD` | | config.js | alias of `MCP_API_KEY` |
| `ALLOW_NO_AUTH` | off | config.js | with no key: start and leave `/mcp` open (tests only) |
| `MCP_TOKEN_STORE` | `DATA_DIR/mcp-tokens.json` | mcp-auth.js | token store file |
| `MCP_TRUST_PROXY` | off (`1`, `true`, `yes`, `on`) | mcp-auth.js | OAuth base URL from `X-Forwarded-Proto/-Host` when no `PUBLIC_URL` |

### Execution

| Variable | Default | Range | Effect |
|---|---|---|---|
| `RUN_TIMEOUT_S` | 120 | 1-86400 | default time limit of a run |
| `MAX_TIMEOUT_S` | 3600 | 1-86400 | highest `timeout` per call |
| `WAIT_BUDGET_S` | 45 | 5-3600 | a run still going after this becomes a background job |
| `KERNEL_IDLE_MIN` | 30 | 1-1440 | idle Python kernels are saved and stopped |
| `MAX_JOBS` | 4 | 1-64 | unfinished jobs per workspace |
| `CODE_SECRETS` | | | `NAME=value; …` for the code, redacted in output |
| `OMNIROUTE_API_KEY` | | | enables `make_image` / `edit_image` (a secret named `OMNIROUTE_API_KEY` in the request overrides it) |
| `OMNIROUTE_BASE_URL` | the plugin's `IMAGE_API_BASE` | | image API base |

Fixed in code: output head 30,000 and tail 10,000 characters per job; job log 5 MB; `wsfs` read default 20 MB;
preview limit 15 MB.

### Sandbox

| Variable | Default | Range | Effect |
|---|---|---|---|
| `SANDBOX` | `auto` | `auto`, `off` | `off` runs code as the server user without isolation |
| `CODE_NETWORK` | `open` | `open`, `off` | network for code ([4.14](#414-network-modes)); startup refuses `off` if unenforceable |
| `SANDBOX_UID_BASE` | 370000 | 1000-4000000000 | first workspace uid |
| `WORKSPACE_QUOTA_MB` | 2048 | 1-1048576 | checked before runs and uploads |
| `MAX_FILE_MB` | 512 | 1-1048576 | `RLIMIT_FSIZE`; also bounds uploads (max 200 MB) and served files (max 256 MB) |
| `MAX_PROCS` | 256 | 8-65536 | `RLIMIT_NPROC` per workspace uid (root mode) |

### Results

| Variable | Default | Range | Effect |
|---|---|---|---|
| `RESULT_MAX_CHARS` | 60000 | 4000-2000000 | text budget of one result |
| `RESULT_IMAGE_MAX_KB` | 1024 | 0-20480 | media budget of one result; also inline image limit of `serve_file` and screenshots |
| `CALL_CEILING_S` | 600 | 30-86400 | longest a tool call may take before an error answer |

### Browser

| Variable | Default | Read in | Effect |
|---|---|---|---|
| `BROWSER_ALLOW_SITES` | | config.js | server allow list (whitespace, comma or semicolon separated) |
| `BROWSER_BLOCK_SITES` | | config.js | server block list |
| `BROWSER_CONFIRM` | on | config.js | ask the extension to hold risky actions (it may hold them anyway) |
| `BROWSER_HIGHLIGHT` | on | config.js | draw element numbers on the page |
| `BRIDGE_TRUST_LOCAL_XFF` | off (`1`) | bridge.js | tests only: honour `X-Forwarded-For` from loopback |

### REA

| Variable | Default | Range | Effect |
|---|---|---|---|
| `REA` | on | | `0` leaves the REA tools out |
| `REA_COMMAND` | `rea mcp` | | REA's stdio MCP command line (quotes keep spaces) |
| `REA_TOOLS` | `compact` | `compact`, `full` | tool list shape |
| `REA_IDLE_MIN` | 15 | 1-1440 | idle REA processes are stopped |
| `REA_MAX_CHARS` | 20000 | 2000-1000000 | longer REA results go to `rea/` |
| `REA_CALL_TIMEOUT_S` | 300 | 5-86400 | limit of one forwarded REA call |

`rea.js` also reads `PATH` to find the REA command.

### Test-only

`SANDBOX_TEST_STUB=1` (runner tests against `test/_sandbox_stub.mjs`), `NET_TESTS=1` (remote compiler test),
`REA_TEST_RUNTIME` (path of a local REA runtime), `SANDBOX_TEST_SECRET` (set by the sandbox test itself).

### Dockerfile

Build arguments (on Railway, service variables of the same name):

| Argument | Default | Effect |
|---|---|---|
| `WITH_R` | 0 | install R with jsonlite, ggplot2, dplyr |
| `WITH_GO` | 0 | install Go |
| `WITH_RUST` | 0 | install rustc |
| `WITH_JAVA` | 0 | install a headless JDK |
| `EXTRA_APT` | | further Debian packages (also REA engines) |
| `EXTRA_PIP` | | further Python packages |
| `WITH_REA` | 1 | install `rea-agents` globally |
| `REA_VERSION` | 6.2.0 | pinned REA version |

Environment set by the image: `NODE_ENV=production`, `PORT=8080`, `RAILWAY_RUN_UID=0` (run as
root on Railway), `PIP_NO_CACHE_DIR=1`, `PIP_DISABLE_PIP_VERSION_CHECK=1`, `PIP_BREAK_SYSTEM_PACKAGES=1`,
`PYTHONDONTWRITEBYTECODE=1`, `DEBIAN_FRONTEND=noninteractive`. The image builds `crbox` (`sandbox/build.sh`),
removes group/other write on `/app`, and has its own health check against `/health`. `railway.json`: Dockerfile
builder, health check `/health` with 120 s timeout, restart on failure up to 10 times.

---

## 14. Extending it

### Adding a tool

1. In `tools.js` `specs()`, add `{ name, description, inputSchema }` and an entry in `ANNOTATIONS`.
2. Write the handler `async function my_tool(args, ctx)`; `ctx` has `ws`, `user`, `secrets`, `progress(text)`
   and `signal`. Return `{ content: [...] }` (use `text()` / `fail()`).
3. Register it in `HANDLERS`.
4. Access workspace files only through `wsfs` (never `fs` on `ws.dir` as root). Return links (`fileUrl`,
   `previewUrl`) instead of file contents; redact anything that may contain secrets with `runner.redact()`.
5. Nothing else: `guardedCall()` caps the result and logs the call for every tool. The tool list is built once
   per process (`toolCache`), so restart after changes. A REA tool with the same name is hidden automatically.

### Adding a language

1. Install the runtime in the `Dockerfile` (or via `EXTRA_APT`), somewhere under the read-only paths
   (`/usr`, `/bin`, `/opt`, …).
2. Add a descriptor in `runner.js` `descriptors`: `bin` (found with `which`), `extension`, and `compile` (default
   compiler flags) for compiled languages. Interpreted languages then run as `<bin> Run.<ext>`; compiled ones as
   `<bin> <flags> Run.<ext> -o program` followed by `program`. Anything special goes into `localRun()`.
3. Add aliases in `languageOf()` if needed. `allLanguages()` (the tool's enum) picks the new name up.
4. If the runtime needs files outside the read-only list, add the path to `systemPaths` in `sandbox.js` or pass
   it as `readOnly` for that spawn.

### Adding an optional engine (for REA or for code)

Install it in the image (`EXTRA_APT`, `EXTRA_PIP`, or a Dockerfile step) under a path the sandbox can read, and
restart. REA discovers engines itself; check with `rea_find` and a test call.

### Tests

`cd server && npm test` runs `node --test test/*.test.mjs`.

| File | Covers | Skips |
|---|---|---|
| `sandbox.test.mjs` | crbox compile and probe, closed descriptors and no core dumps, honest report, scrubbed environment, no access outside the workspace or to server files, parent environ unreadable, seccomp (unshare, ptrace), runtimes, threads, multiprocessing, network off/open, file size limit, `safeRel`, `wsfs` binary round trip and size bound, symlink refusal, `killTree`, process-group escape, root uid drop, Landlock without bubblewrap, off mode, `clear` | Landlock/namespace, seccomp and network tests when the layer is missing; **the uid-drop test unless the tests run as root with working setuid**; gcc subcheck without gcc |
| `runner.test.mjs` | Python namespace, expressions, await, stdin, tracebacks, native and subprocess output, matplotlib, interrupt and timeout, reset, idle save/restore, output cap, JS return/await/storage, shared files, TypeScript stripping and type errors, bash, SQLite, C, jobs and wait budget, kill, busy refusal, redaction (encoded forms, split chunks, logs), streaming, file diffs, offsets, hard-interrupt fallback, job/quota limits, durable logs and recovery, DuckDB, R, other runtimes, lambdas, symlinked job logs, Node imports | runtimes that are not installed; matplotlib if missing. `SANDBOX_TEST_STUB=1` runs it against a stub without isolation (which, unlike the real sandbox, does pass extra fds) |
| `guard.test.mjs` | small results unchanged except `structuredContent`, long text cut and saved, image budget, broken results, the ceiling | none (uses the real sandbox for `wsfs`) |
| `mcp-auth.test.mjs` | Bearer and `X-API-Key`, 401 with resource metadata, Basic on either side, key refused in the query, metadata documents, full DCR + PKCE flow, redirect mismatch, wrong verifier burns the code, client_credentials, lockout with tokens still passing, revocation, persistence without secrets, a token surviving a wiped store while a revoked one stays revoked, rotation | none |
| `bridge.test.mjs` | one-time pairing with hashes on disk, expiry, five open codes per user (a sixth replaces the oldest), concurrent redemption, bad hello (4401), offline/round trip/ping/timeout, device priority, foreign response ids, revoke, unpair, per-IP and global rate limits, origin and body limits, reload of persisted devices, a pairing surviving a wiped `bridge.json` while an unlinked device stays out, hello timeout, oversized frames, malformed state fails closed, 70 s silence, HTTPS rules in the extension, policy intersection, remote authority, local switches | none |
| `e2e.test.mjs` | the real server over Streamable HTTP: `/health`, refusal without key, tool list, persistent Python across requests with redaction, no server environment visible, per-user workspaces, a long run becoming a job, working links and upload page, planted symlink not served, status/schedule/pairing answers | none (REA off) |
| `rea.test.mjs` | compact tool list, `rea_find`, `rea_call` on a workspace file, huge result saved to a file, one REA process per user, `REA_TOOLS=full` without output schemas, `REA=0` | **all, when no local REA runtime is found** at `~/.local/share/rea/runtime` or `REA_TEST_RUNTIME` |
| `legacy.test.mjs` | previews, languages, notebook from `implementation.js` | the remote C test unless `NET_TESTS=1` |

On a machine without root the suite runs in `user` mode: workspaces share the test user's uid, `RLIMIT_NPROC`
is not applied, and the uid-drop test is skipped. Without Landlock (old kernel, WSL kernels without it) the
file-boundary tests are skipped and, since user mode then has no separation at all, the sandbox refuses to start
and most runner/e2e tests fail; that is the fail-closed rule working.

---

## 15. Known discrepancies

Places where the code still differs from its own comments, the README or the tool descriptions, or behaves in a
way a reader would not expect. The code is what runs.

1. **Offline browsers get a new pairing code.** `bridgeStatus()` lists only connected devices, so
   `browserCall()` treats a paired-but-offline browser as unpaired and hands out a fresh pairing code. Its own
   "paired but not connected" message is reached only if the socket drops between the status check and the
   call, and the "paired, but the browser is not connected" text of `manage_files status` can never appear.
   (Since a sixth open code replaces the oldest, this no longer ends in an error.)
2. **Lockout length.** The README says the wait grows "up to 30 seconds"; the exponent is capped at 4, so the
   longest wait is 16 s, while the 429 response says `Retry-After: 30`.
3. **Landlock ABI use.** The measured hosts offer ABI 6 or 7; `crbox` uses only filesystem rights up to ABI 5,
   and neither Landlock's network rules nor its IPC scoping (abstract unix sockets, signals).
4. **Remote R label.** R without a local `Rscript` runs on Wandbox, but the note appended by `execute()` says
   "Compiler Explorer", because R is not in `WB_LANGS`.
5. **Client cancellation.** `ctx.signal` is handed to every tool, but only REA calls use it; a cancelled
   `run_code` keeps running.
6. **Job logs outside the quota.** `DATA_DIR/tmp/<id>/jobs/*.log` (up to 5 MB each) and `*.json` are never
   deleted, are not counted by the quota, and are not touched by `manage_files clear`. (`run-*` scratch folders
   are now removed when their job or kernel ends.)
7. **Work in the server process.** The TypeScript type check (`typecheck: true`, `typeErrors()`), the import
   splitting with the TypeScript parser, preview rendering of workspace file bytes (`legacy.previewHtml()`),
   the notebook export and remote compiler requests run inside the root server process, outside the sandbox.
8. **Kernel docstring.** `kernel.py`'s docstring still says "JSON frames on fd 3 (in) and fd 4 (out)", and
   `kernel.py` and `ensureKernel()` still carry that branch; the only path used is the prefixed stdin/stderr
   channel ([5.2](#52-the-persistent-python-kernel)).
9. **Refused schedules and the quota.** The comment in `runOnce()` counts a full quota among the refusals; a
   full quota actually produces a job that ends as `failed`, not a `refused` log entry.
10. **`fresh` and `record` from a chat.** They are not in the `run_code` schema, but `run_code` passes its
    arguments through, so a client can send them.
11. **Secret precedence.** `SERVER_SECRET` (16+ characters) wins over the key-derived server secret; only
    without it is the secret derived from `MCP_API_KEY`.
12. **Revocations without a volume.** Signed OAuth and device tokens survive a lost store, but the revocation
    lists (`revoked`, `revokedBefore`, revoked device ids) live in the same files, so losing the store also
    re-admits revoked tokens and unlinked devices (the code comments say so).
13. **`RLIMIT_AS`.** There is none and the code gives no reason; the reason in [4.5](#45-layer-rlimits) is an
    inference.
