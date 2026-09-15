# Code Runner Browser Bridge (development extension)

A tiny unpacked Chrome extension that lets the Code Runner TypingMind plugin
read and control **your own open browser tabs** through two plugin tools:

- **`browser_run`** - run JavaScript in a tab and get the return value + console output
  (read the DOM, click, fill forms, scroll, change the view).
- **`browser_tabs`** - list / activate / open / close / reload / navigate tabs.

The plugin itself runs inside a locked-down sandboxed iframe with no access to
other tabs. Only an extension can cross that line, so this companion does the
tab work and the plugin talks to it over a `window.postMessage` bridge.

## Load it (one time, ~1 minute)

1. Open `chrome://extensions` in Chrome or a Chromium desktop browser
   (Chrome **130 or newer** - the bridge relies on `match_origin_as_fallback`
   reaching sandboxed frames, fixed in 130).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Confirm the extension is **enabled**.
5. Reload your TypingMind tab. The `browser_run` / `browser_tabs` tools now work.

No options page, no popup, no sign-in. To update it after an edit, hit the
reload icon on its card in `chrome://extensions`, then reload the TypingMind tab.

## Try it

Ask the model to:

- "List my open tabs" -> `browser_tabs { action: "list" }`
- "What's the title of the active tab?" -> `browser_run { code: "return document.title" }`
- "Click the button with id save on tab 42" ->
  `browser_run { tabId: 42, code: "document.querySelector('#save').click(); return 'clicked'" }`

## How it works

```
plugin (sandboxed iframe)  --window.postMessage-->  content.js (same frame)
      ^                                                    |
      |                                          chrome.runtime.sendMessage
      +------window.postMessage------  content.js  <--  background.js
                                                     (chrome.tabs / chrome.scripting)
```

- `content.js` is injected into **every frame** (`all_frames` +
  `match_origin_as_fallback`) so it reaches the plugin's opaque-origin iframe.
- `background.js` runs the tab and scripting calls and returns a result.
- `browser_run` code executes as an async function body: `await` works and you
  return a value with `return <value>`. It runs in the **isolated** world by
  default (sees the DOM, safe from page scripts); pass `world: "main"` to touch
  the page's own globals (subject to the page's CSP).

## Scope and safety

This is a **development** build, deliberately minimal:

- `host_permissions` is `<all_urls>` and the content script relays any window
  message tagged `__crbReq`, so **while it is enabled, any page you visit could
  drive your tabs through it**. Enable it only while you are using the plugin,
  or narrow `matches`/`host_permissions` in `manifest.json` to your TypingMind
  origin(s) before loading.
- It is Chrome/Chromium **desktop only**. Firefox and Safari do not support
  `match_origin_as_fallback`; mobile browsers do not load unpacked extensions.
- Console capture covers `console.*` emitted **while your script runs**. Full
  pre-existing console/network history would need the `chrome.debugger` API,
  which this build intentionally does not request.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `tabs` + `scripting`, all-frames content script |
| `content.js` | postMessage <-> chrome.runtime relay, injected into every frame |
| `background.js` | service worker: runs `chrome.tabs` / `chrome.scripting` |
