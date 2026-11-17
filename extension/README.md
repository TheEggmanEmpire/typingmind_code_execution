# Code Runner Browser Bridge

A small unpacked Chrome extension that lets the Code Runner TypingMind plugin read and operate **your own open
browser tabs** through four plugin tools:

- **`browser_state`**: the page with every visible interactive element numbered, the page's text as Markdown, or a
  screenshot (saved into the plugin's `/workspace`, element numbers drawn on it).
- **`browser_act`**: click, type, press keys, list and pick dropdown options, scroll, go to a URL, search, back,
  forward, reload, wait, switch / open / close tabs, by element number, several actions per call.
- **`browser_run`**: run custom JavaScript in a tab and get the value plus console output.
- **`browser_tabs`**: list / activate / open / close / reload / navigate tabs.

The numbered-snapshot approach (the model sees `[12]<button>Search</button>` and acts on 12) is the core of
[nanobrowser](https://github.com/nanobrowser/nanobrowser) and browser-use. Here TypingMind's model is the agent;
this extension provides the eyes and hands. `page-agent.js` is an independent, compact implementation.

## Install (one time, about 2 minutes)

1. Open `chrome://extensions` in Chrome or Chromium desktop (**130 or newer**: the bridge relies on
   `match_origin_as_fallback` reaching sandboxed frames).
2. Turn on **Developer mode**, click **Load unpacked** and pick this `extension/` folder.
3. Reload your TypingMind tab. No key or sign-in: the extension answers typingmind.com pages. If you use TypingMind
   on another domain (self-hosted, custom domain), add that host under **Trusted hosts** on the options page
   (**Details -> Extension options**).

After editing the extension, press its reload icon in `chrome://extensions`, then reload the TypingMind tab.

## Remote link (LibreChat, Hermes and other MCP clients)

The remote MCP server can reach this extension without a TypingMind page. Pair each browser profile separately:

1. Install the extension as above, then open **Details -> Extension options**.
2. Ask the AI in your MCP client to use a browser tool. When no browser is connected, it gives you the server URL
   and a one-time pairing code. The code expires after 10 minutes and works once. It is not a reusable credential.
3. Under **Remote link**, enter that URL and code, choose a device name, and click **Pair**. You can also paste
   `https://your-server#CODE` in the URL field. Use HTTPS; only `http://localhost` and `http://127.0.0.1` are allowed
   for local development. The URL must be the server origin, without a path or login.
4. Check that the options page says **Connected to … as …**. The icon shows a green **on** badge while connected.
   Retry the browser tool. With several connected devices, the server chooses the most recently paired or answering one.

The extension opens an outbound WebSocket at `/bridge`. It sends the device credential in the first message,
never in the URL, and exchanges traffic every 20 seconds to keep the service worker alive (Chrome 116+).
Disconnects retry automatically; a rejected pairing stops retries until you pair again. The extension keeps its
credential in local extension storage, restricted to trusted extension contexts. The server stores only its hash.
Neither the token nor a derivable reusable credential is returned to the AI.

**Local safety controls** apply to remote requests in addition to the server's settings. Save changes with
**Save settings**; the **Remote link enabled** switch takes effect immediately.

- **Allowed sites / Blocked sites:** a block in either source wins. Every non-empty allow list must permit the host.
  Empty local allow lists add no restriction. The same host patterns as the TypingMind settings are supported.
- **Always confirm risky actions:** on by default. The server cannot disable the recognizable risky-click and
  Enter/Space guard. A client can still send `confirm: true`; this relies on the AI asking you, not a browser dialog.
- **Allow running scripts (browser_run):** on by default. Turn it off to refuse the `run` operation. Scripts are
  arbitrary JavaScript inside an allowed tab and are not subject to the risky-action guard.
- **Chat page hosts:** optional. These tabs are marked as chat tabs and skipped when choosing a default target.
  This list grants no access. Pass an explicit tab id when you mean to work on a chat tab.
- **Remote link enabled:** off disconnects the remote path. The TypingMind relay keeps its existing trusted-host rules.

The paired server can read and operate allowed tabs, including pages where you are signed in. It cannot edit
these local controls through the bridge protocol or use them to grant itself access. Site lists constrain the
selected tab and navigation checks; they are not a network firewall. A page, redirect, or arbitrary script can
make requests to other sites. Redirects are detected after navigation. Turning scripts off does not stop ordinary
page scripts or make clicks harmless. Browser automation and signed-in data remain powerful access.

Click **Unlink** to revoke this device on the server and forget its local credential. If the server is unreachable,
local access stops immediately but server revocation is unconfirmed; revoke browser devices through the MCP client
when it is reachable. Server revocation closes sockets and invalidates old credentials. Existing actions cannot
be undone by disconnecting. After rejection, unlink before pairing a new code.

## Troubleshooting

- **"The browser tools only work from the plugin itself, not from content nested inside it."** Chrome is running
  an extension older than 0.4.2. Versions 0.4.0 and 0.4.1 refused TypingMind's real plugin frame, which sits behind
  sandboxed wrapper frames. Update and reload as below.
- **Updated, but nothing changed.** Chrome runs the copy in the folder it was loaded from, not your repository.
  Open **Details** on the extension card and check **Source**. A common trap on Windows with WSL: `git pull` runs
  in WSL while Chrome loads a separate `C:\...` copy. Either copy the folder over
  (`cp -r ~/path/to/repo/extension/. /mnt/c/path/to/extension/`) or remove the extension and **Load unpacked**
  straight from `\\wsl$\<distro>\home\<you>\...\extension`. Then press reload and check that the card shows the
  new version.
- **Self-diagnosis from the chat.** Models tend to reword errors and drop the details. Ask:

  ```
  Diagnostic only, do not summarize or reword anything.
  1. Call the browser_tabs tool with {"action": "list"}.
  2. Reply with ONLY the exact, complete text the tool returned, inside a code block, character for character.
  3. Then state the exact tool name you called and the exact arguments you passed.
  ```

  "not responding" means the extension is missing or disabled; "does not trust this page" means the host needs
  adding under **Trusted hosts**; a refusal that ends without "(Bridge saw frame depth ...)" means an old extension.
- After any update: reload the extension, then reload the TypingMind tab.

## Try it

- "What's on my active tab?" -> `browser_state {}`
- "Search Wikipedia for Ada Lovelace" -> `browser_state` on the Wikipedia tab, then
  `browser_act { actions: [{ action: "type", index: 5, text: "Ada Lovelace", submit: true }] }`
- "Put the prices from this table into a CSV and chart them" -> `browser_run { code: "...", save_to: "prices.csv" }`,
  then `run_code` with `chart()`.

## How it works

```
plugin (sandboxed iframe) --window.postMessage--> content.js (same frame) --chrome.runtime--> background.js
                                                                                  |
                          page-agent.js (isolated world): snapshot, focus, scroll, dropdowns, Markdown
                          DevTools protocol: real mouse clicks, keystrokes, typed text, screenshots, browser_run
```

- `content.js` is injected into every frame (`all_frames` + `match_origin_as_fallback`) so it reaches the plugin's
  opaque-origin iframe. It only relays messages a frame posts to itself.
- `background.js` checks every request: the requesting tab must be on a trusted host; the plugin's site policy is
  checked before any tab is read or touched, and again for navigation targets, redirects and history.
- After each snapshot the numbered boxes are drawn on the page itself (nanobrowser style) until the next snapshot;
  they are ignored by the snapshot and by reading, and never catch clicks.
- `page-agent.js` runs in the extension's isolated world: page scripts cannot see or alter it, and the page's CSP
  does not apply. The element map lives there until the next snapshot or navigation.
- Clicks and typing use the DevTools protocol (`chrome.debugger`), so they are real input events; Chrome shows a
  "started debugging" banner while one is sent. `browser_run` also runs through it, which bypasses the page's CSP
  and captures the real console.

## Safety

- **Trusted hosts:** only frames inside a trusted page (where TypingMind runs its plugins) are answered. Other
  websites, pages being automated and the TypingMind page itself are refused. **Frames nested inside the plugin
  (rendered previews and charts) and other plugins' HTML outputs can also use the bridge**: TypingMind wraps its
  plugin frame in sandboxed frames, so the plugin cannot be told apart from content nested in it by position.
  Preview only content you trust, and install only plugins you trust.
- **Site policy:** the plugin settings **Browser: allowed sites** / **blocked sites** are sent with each request and
  enforced here, including `goto`, `open_tab`, `switch_tab` and pages reached by clicks.
- **Confirmation:** clicks and Enter presses whose element, form or text suggests buying, paying, deleting,
  sending, publishing or a password/payment form are held; the model must ask you and repeat with `confirm: true`.
  `browser_run` runs arbitrary code and is not covered by this check.
- **Default tab:** when no tab id is given, the active tab is used, or the most recently used other tab when the
  active one is the chat itself.
- Chrome forbids automating `chrome://` pages, the Web Store and tabs with DevTools open.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `tabs`, `scripting`, `debugger`, `storage`, `alarms`; all-frames content script; options page |
| `content.js` | postMessage <-> chrome.runtime relay, injected into every frame |
| `background.js` | service worker: authorization, site policy, tabs, actions, screenshots, `browser_run` |
| `page-agent.js` | isolated-world agent: numbered snapshot, element geometry, dropdowns, scrolling, Markdown, risk checks |
| `options.html` / `options.js` | trusted hosts, remote pairing, local safety controls and status |
| `config.json` (optional) | `{ "trustedHosts": [...] }` default, used by the tests |

## Test

`node test/run-browser-e2e.js` loads a copy of this folder (trusting 127.0.0.1) into Chrome for Testing / Chromium and
runs the tools against `test/fixture.html` (branded Chrome ignores `--load-extension`; the runner finds Playwright's
Chromium automatically, or set `CHROME=`).

`node test/run-remote-bridge-e2e.js` starts a local server and a disposable Chrome for Testing profile, then tests
the real WebSocket path, page snapshots, clicks and local-policy enforcement. It uses the existing `ws` package
and Chromium's DevTools interface; Playwright is not required. It never attaches to your everyday browser.
