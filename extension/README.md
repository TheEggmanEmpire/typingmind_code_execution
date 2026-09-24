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
3. Click **Details -> Extension options**. Copy the **pairing key** into the Code Runner plugin setting
   **Browser pairing key**. If you use TypingMind on another domain (self-hosted, custom domain), add that host under
   **Trusted hosts** and save.
4. Reload your TypingMind tab.

After editing the extension, press its reload icon in `chrome://extensions`, then reload the TypingMind tab.

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
- `background.js` checks every request: the requesting tab must be on a trusted host and the request must carry the
  pairing key; the plugin's site policy is checked before any tab is read or touched, and again for navigation targets.
- `page-agent.js` runs in the extension's isolated world: page scripts cannot see or alter it, and the page's CSP
  does not apply. The element map lives there until the next snapshot or navigation.
- Clicks and typing use the DevTools protocol (`chrome.debugger`), so they are real input events; Chrome shows a
  "started debugging" banner while one is sent. `browser_run` also runs through it, which bypasses the page's CSP
  and captures the real console.

## Safety

- **Pairing key + trusted hosts:** without both, the extension refuses every request except a status ping. A
  random website (or a page being automated) cannot drive your tabs. Rotate the key with **New key** on the options
  page.
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
| `manifest.json` | MV3 manifest: `tabs`, `scripting`, `debugger`, `storage`; all-frames content script; options page |
| `content.js` | postMessage <-> chrome.runtime relay, injected into every frame |
| `background.js` | service worker: authorization, site policy, tabs, actions, screenshots, `browser_run` |
| `page-agent.js` | isolated-world agent: numbered snapshot, element geometry, dropdowns, scrolling, Markdown, risk checks |
| `options.html` / `options.js` | pairing key and trusted hosts |
| `config.json` (optional) | `{ "pairingKey": "...", "trustedHosts": [...] }` defaults, used by the tests |

## Test

`node test/run-browser-e2e.js` loads a copy of this folder (with a test key) into Chrome for Testing / Chromium and
runs the tools against `test/fixture.html` (branded Chrome ignores `--load-extension`; the runner finds Playwright's
Chromium automatically, or set `CHROME=`).
