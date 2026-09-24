// Code Runner Browser Bridge - service worker.
//
// Receives relayed requests from content.js and drives the real Chrome APIs:
//   - tabs: chrome.tabs
//   - page snapshot, reading and DOM-side actions: page-agent.js, injected into
//     the extension's isolated world with chrome.scripting
//   - real mouse clicks, keystrokes, typed text, screenshots and the model's own
//     scripts: the DevTools protocol (chrome.debugger), attached per call
//
// Every request must come from a trusted page (TypingMind by default; more hosts
// on the options page), so other websites cannot drive your tabs through this
// extension. Each request also carries the plugin's site policy (allow / block
// lists), checked before a tab is touched.
//
// Every reply is { ok: true, ... } or { ok: false, error, code? }.

const VERSION = "0.4.0";
const DEFAULT_TRUSTED = ["typingmind.com", "*.typingmind.com"];

// ---- settings: trusted hosts -----------------------------------------------------
let settingsCache = null;
async function settings() {
  if (settingsCache) return settingsCache;
  let file = {};
  try { const r = await fetch(chrome.runtime.getURL("config.json")); if (r.ok) file = await r.json(); } catch (e) {}
  const s = await chrome.storage.local.get(["trustedHosts"]);
  const hosts = Array.isArray(s.trustedHosts) && s.trustedHosts.length ? s.trustedHosts : Array.isArray(file.trustedHosts) && file.trustedHosts.length ? file.trustedHosts : DEFAULT_TRUSTED;
  settingsCache = { hosts };
  return settingsCache;
}
chrome.storage.onChanged.addListener(() => { settingsCache = null; });
chrome.runtime.onInstalled.addListener(() => { settings(); });

function hostMatches(host, pattern) {
  pattern = String(pattern || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  host = String(host || "").toLowerCase();
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  return host === pattern || host.endsWith("." + pattern);
}
function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ""; } }

async function authorize(req, sender) {
  const s = await settings();
  const pageUrl = sender && sender.tab && sender.tab.url || "";
  const host = hostOf(pageUrl);
  const trusted = !!host && s.hosts.some((p) => hostMatches(host, p));
  return { trusted, host };
}

// ---- site policy (plugin settings) ---------------------------------------------------
function policyBlocks(url, policy) {
  if (!policy) return null;
  const host = hostOf(url);
  if (!host) return null;   // about:blank, chrome://newtab etc. are handled by Chrome itself
  const block = (policy.block || []).filter(Boolean), allow = (policy.allow || []).filter(Boolean);
  if (block.some((p) => hostMatches(host, p))) return host + " is on the plugin's blocked sites list";
  if (allow.length && !allow.some((p) => hostMatches(host, p))) return host + " is not on the plugin's allowed sites list";
  return null;
}
async function checkTab(tabId, policy) {
  const t = await chrome.tabs.get(tabId);
  const why = policyBlocks(t.url || t.pendingUrl || "", policy);
  if (why) throw Object.assign(new Error("not allowed: " + why + " (Browser allowed/blocked sites setting)"), { code: "policy" });
  return t;
}
function checkUrl(url, policy) {
  const why = policyBlocks(url, policy);
  if (why) throw Object.assign(new Error("not allowed: " + why + " (Browser allowed/blocked sites setting)"), { code: "policy" });
}

// ---- messaging ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "crb") return;
  handle(msg.request || {}, sender, msg.depth)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e), code: e && e.code }));
  return true; // async sendResponse
});

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error((what || "operation") + " timed out after " + ms + " ms")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// The tab to act on: the one asked for; otherwise the active tab, unless that is
// the chat itself - then the most recently used other tab.
async function resolveTabId(req, sender) {
  if (req.tabId != null) return Number(req.tabId);
  const own = sender && sender.tab ? sender.tab.id : null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id !== own) return tab.id;
  const others = (await chrome.tabs.query({})).filter((t) => t.id !== own && /^https?:/.test(t.url || ""));
  others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (others.length) return others[0].id;
  if (tab) return tab.id;
  throw new Error("no tab to act on (open one with browser_tabs, or pass a tabId)");
}

function tabView(t) {
  return { id: t.id, windowId: t.windowId, index: t.index, active: t.active, url: t.url || t.pendingUrl || "", title: t.title || "", status: t.status };
}

async function handle(req, sender, depth) {
  const auth = await authorize(req, sender);
  // Only a frame placed directly in the trusted page (where TypingMind runs its
  // plugins) may use the bridge: not the page itself, not frames nested deeper
  // (rendered previews, charts, embedded content).
  if (auth.trusted && depth !== 1) auth.trusted = false, auth.nested = true;
  if (req.op === "ping") return { ok: true, version: VERSION, trusted: auth.trusted, nested: !!auth.nested, host: auth.host };
  if (auth.nested) return { ok: false, code: "untrusted", error: "only the plugin frame itself may use the Code Runner bridge (this request came from a frame nested inside it, or from the page)." };
  if (!auth.trusted) return { ok: false, code: "untrusted", error: "this page (" + (auth.host || "unknown") + ") is not a trusted host of the Code Runner bridge. Add it on the extension's options page." };
  const policy = req.policy || null;

  switch (req.op) {
    // ---- tabs ----
    case "tabs.list": {
      const tabs = await chrome.tabs.query(req.allWindows ? {} : { currentWindow: true });
      const own = sender && sender.tab ? sender.tab.id : null;
      const shown = tabs.filter((t) => t.id === own || !policyBlocks(t.url || t.pendingUrl || "", policy));
      return { ok: true, tabs: shown.map((t) => ({ ...tabView(t), chat: t.id === own })), hidden: tabs.length - shown.length };
    }
    case "tabs.activate": {
      const id = await resolveTabId(req, sender);
      await checkTab(id, policy);
      const t = await chrome.tabs.update(id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
      return { ok: true, tab: tabView(t) };
    }
    case "tabs.open": {
      if (req.url) checkUrl(req.url, policy);
      const t = await chrome.tabs.create({ url: req.url || undefined, active: req.active !== false });
      if (req.url) { await waitForLoad(t.id, 15000); await landed(t.id, policy, true); }
      return { ok: true, tab: tabView(await chrome.tabs.get(t.id)) };
    }
    case "tabs.close": {
      const id = await resolveTabId(req, sender);
      await checkTab(id, policy);
      await chrome.tabs.remove(id);
      return { ok: true, closed: id };
    }
    case "tabs.reload": {
      const id = await resolveTabId(req, sender);
      await checkTab(id, policy);
      await chrome.tabs.reload(id);
      await waitForLoad(id, 15000);
      return { ok: true, tab: id };
    }
    case "tabs.navigate": {
      const id = await resolveTabId(req, sender);
      if (!req.url) throw new Error("tabs.navigate needs a url");
      await checkTab(id, policy);
      checkUrl(req.url, policy);
      const t = await chrome.tabs.update(id, { url: req.url });
      await waitForLoad(id, 15000);
      await landed(id, policy, false);
      return { ok: true, tab: tabView(await chrome.tabs.get(t.id)) };
    }

    // ---- run script (via the DevTools protocol) ----
    case "run": {
      const id = await resolveTabId(req, sender);
      await checkTab(id, policy);
      const ms = Math.min(Math.max(Number(req.timeoutMs) || 15000, 1000), 120000);
      return await runViaDebugger(id, String(req.code || ""), ms);
    }

    // ---- page state: snapshot / read / screenshot ----
    case "page.state": {
      const id = await resolveTabId(req, sender);
      const t = await checkTab(id, policy);
      return await pageState(id, t, req);
    }

    // ---- actions ----
    case "page.act": {
      const id = await resolveTabId(req, sender);
      await checkTab(id, policy);
      return await pageAct(id, req, policy, sender);
    }

    default:
      return { ok: false, error: "unknown op: " + req.op };
  }
}

// ---- page agent ----------------------------------------------------------------------------
async function agent(tabId, fn, args) {
  const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: () => !!(window.__crbAgent && window.__crbAgent.version === 3) });
  if (!probe || !probe.result) await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", files: ["page-agent.js"] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "ISOLATED",
    func: (name, a) => { try { return { ok: true, value: window.__crbAgent[name].apply(null, a) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } },
    args: [fn, args || []]
  });
  if (!res) throw new Error("the page did not answer (it may still be loading)");
  if (!res.result.ok) throw new Error(res.result.error);
  return res.result.value;
}

async function waitForLoad(tabId, ms) {
  const end = Date.now() + (ms || 10000);
  await new Promise((r) => setTimeout(r, 150));
  while (Date.now() < end) {
    let t;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (t.status === "complete") { await new Promise((r) => setTimeout(r, 250)); return; }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function otherTabs(currentId, policy) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.filter((t) => t.id !== currentId && !policyBlocks(t.url || "", policy)).slice(0, 12).map((t) => "#" + t.id + " " + (t.title || "").slice(0, 50));
}

// After a navigation: if the page that loaded (redirects, history) is on a
// blocked site, leave it at once (back, or close a tab we opened) and fail.
async function landed(tabId, policy, openedByUs) {
  let t;
  try { t = await chrome.tabs.get(tabId); } catch (e) { return; }
  const why = policyBlocks(t.url || t.pendingUrl || "", policy);
  if (!why) return;
  if (openedByUs) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  else { try { await chrome.tabs.goBack(tabId); await waitForLoad(tabId, 8000); } catch (e) { try { await chrome.tabs.update(tabId, { url: "about:blank" }); } catch (e2) {} } }
  throw Object.assign(new Error("the page led to a blocked site (" + why + "); " + (openedByUs ? "the tab was closed" : "went back")), { code: "policy" });
}

// The tab whose snapshot the model saw last: indexed actions without an explicit
// tab must target it (session storage survives service-worker restarts).
async function noteSnapshot(tabId) { try { await chrome.storage.session.set({ lastSnapshotTab: tabId }); } catch (e) {} }
async function lastSnapshotTab() { try { return (await chrome.storage.session.get("lastSnapshotTab")).lastSnapshotTab; } catch (e) { return null; } }

async function pageState(tabId, tab, req) {
  const mode = String(req.mode || "elements");
  if (mode === "text") {
    const r = await agent(tabId, "read", [{ selector: req.selector, maxChars: req.maxChars }]);
    return { ok: true, tabId, mode, ...r };
  }
  if (mode === "screenshot") return await screenshot(tabId, req);
  const snap = await agent(tabId, "snapshot", [{ scope: req.scope, maxChars: req.maxChars }]);
  await noteSnapshot(tabId);
  // Like nanobrowser: numbered boxes on the page itself, so the user sees what
  // the AI sees. They stay until the next snapshot (or highlight: false).
  try { await agent(tabId, "highlight", [req.highlight !== false, "page"]); } catch (e) {}
  return { ok: true, tabId, mode: "elements", ...snap, tabs: await otherTabs(tabId, req.policy) };
}

// ---- DevTools protocol helpers ----------------------------------------------------------
function dbgSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res);
    });
  });
}
function dbgAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}
function dbgDetach(target) {
  return new Promise((r) => chrome.debugger.detach(target, () => { void chrome.runtime.lastError; r(); }));
}
// One debugger session per tab at a time: calls queue up instead of detaching
// each other's session.
const debuggerLocks = new Map();
function withDebugger(tabId, fn) {
  const prev = debuggerLocks.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => withDebuggerNow(tabId, fn));
  const tail = run.catch(() => {});
  debuggerLocks.set(tabId, tail);
  tail.then(() => { if (debuggerLocks.get(tabId) === tail) debuggerLocks.delete(tabId); });
  return run;
}
async function withDebuggerNow(tabId, fn) {
  const target = { tabId };
  try { await dbgAttach(target); }
  catch (e) {
    const m = String(e && e.message || e);
    if (/Another debugger|already attached/i.test(m)) {
      // Not ours (the lock above serializes our own sessions): a session left over
      // from before a service-worker restart. Detach it and retry once.
      await dbgDetach(target); await dbgAttach(target);
    } else if (/Cannot access|devtools|chrome-untrusted|Cannot attach/i.test(m)) {
      throw new Error("cannot control this tab (" + m + "). Chrome forbids chrome:// pages, the Web Store, and tabs with DevTools open.");
    } else throw new Error("could not attach to the tab: " + m);
  }
  try { return await fn(target); } finally { await dbgDetach(target); }
}

const KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 }, esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 }, delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " }, home: { key: "Home", code: "Home", keyCode: 36 }, end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 }, pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }, right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }
};
const MODS = { alt: { bit: 1, key: "Alt", code: "AltLeft", keyCode: 18 }, control: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 }, meta: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 }, shift: { bit: 8, key: "Shift", code: "ShiftLeft", keyCode: 16 } };
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

function keyDef(name) {
  const k = KEYS[name.toLowerCase()];
  if (k) return k;
  if (/^f([1-9]|1[0-2])$/i.test(name)) { const n = Number(name.slice(1)); return { key: "F" + n, code: "F" + n, keyCode: 111 + n }; }
  if (name.length === 1) {
    const up = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? "Key" + up : /[0-9]/.test(name) ? "Digit" + name : "";
    return { key: name, code, keyCode: up.charCodeAt(0), text: name };
  }
  throw new Error('unknown key "' + name + '" (use Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp, PageDown, F1-F12, letters, or combos like Control+a)');
}

async function pressKeys(target, combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  const mods = parts.slice(0, -1).map((m) => { const d = MODS[m.toLowerCase()]; if (!d) throw new Error('unknown modifier "' + m + '"'); return d; });
  const k = keyDef(parts[parts.length - 1] || "");
  let bits = 0;
  for (const m of mods) { bits |= m.bit; await dbgSend(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: bits, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode }); }
  const withText = !bits || bits === 8;
  const cmd = bits & (2 | 4) && EDIT_COMMANDS[k.key.toLowerCase()] ? [EDIT_COMMANDS[k.key.toLowerCase()]] : undefined;
  await dbgSend(target, "Input.dispatchKeyEvent", { type: withText && k.text ? "keyDown" : "rawKeyDown", modifiers: bits, key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode, text: withText ? k.text : undefined, unmodifiedText: withText ? k.text : undefined, commands: cmd });
  await dbgSend(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: bits, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  for (const m of mods.reverse()) { bits &= ~m.bit; await dbgSend(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: bits, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode }); }
}

async function mouseClick(target, x, y) {
  await dbgSend(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await dbgSend(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await dbgSend(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
}

// ---- screenshots ---------------------------------------------------------------------------
async function screenshot(tabId, req) {
  const t = await chrome.tabs.get(tabId);
  let restore = null;
  if (!t.active) {
    // Chrome only paints the visible tab: bring it forward briefly.
    const [was] = await chrome.tabs.query({ active: true, windowId: t.windowId });
    restore = was && was.id !== tabId ? was.id : null;
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 400));
  }
  let marked = 0;
  try {
    if (req.highlight) {
      await agent(tabId, "snapshot", [{ scope: "viewport" }]);
      marked = await agent(tabId, "highlight", [true]);
    } else { try { await agent(tabId, "highlight", [false]); } catch (e) {} }
    return await withDebugger(tabId, async (target) => {
      const full = !!req.fullPage;
      const params = { format: full ? "jpeg" : "png", captureBeyondViewport: full };
      if (full) {
        params.quality = 80;
        const m = await dbgSend(target, "Page.getLayoutMetrics");
        const size = m.cssContentSize || m.contentSize;
        params.clip = { x: 0, y: 0, width: Math.min(size.width, 2000), height: Math.min(size.height, 12000), scale: 1 };
      }
      const shot = await withTimeout(dbgSend(target, "Page.captureScreenshot", params), 20000, "screenshot");
      return { ok: true, tabId, mode: "screenshot", format: params.format, data: shot.data, url: t.url, title: t.title, highlighted: marked };
    });
  } finally {
    if (req.highlight) { try { await agent(tabId, "highlight", [false]); } catch (e) {} }
    if (restore) { try { await chrome.tabs.update(restore, { active: true }); } catch (e) {} }
  }
}

// ---- actions --------------------------------------------------------------------------------
// Runs a list of actions in order and stops at the first failure or at a risky
// action that has not been confirmed. Returns one line per action and, unless
// asked not to, a fresh snapshot of the page afterwards.
async function pageAct(tabId, req, policy, sender) {
  const actions = Array.isArray(req.actions) ? req.actions.slice(0, 20) : [];
  if (!actions.length) throw new Error("browser_act needs `actions`, e.g. [{\"action\": \"click\", \"index\": 3}]");
  const confirm = req.confirm === true, guard = req.confirmRisky !== false;
  const steps = [];
  let current = tabId, stopped = null;
  const before = await chrome.tabs.get(tabId);
  const indexed = (a) => a && (["click", "type", "select", "options"].includes(String(a.action)) || (a.action === "scroll" && a.index));
  const needsSnapshot = actions.some(indexed);
  if (needsSnapshot && !(await agent(current, "hasSnapshot", []))) {
    throw new Error("no snapshot for this tab yet: call browser_state first, then use the [index] numbers it shows");
  }
  if (needsSnapshot && req.tabId == null) {
    const last = await lastSnapshotTab();
    if (last != null && last !== current) throw new Error("the last snapshot was of tab #" + last + ", but this would act on tab #" + current + ": pass tabId " + last + " (or take a snapshot of the tab you mean)");
  }
  let switched = false;   // after switch_tab / open_tab, numbers from an older snapshot must not be used

  for (const [i, a] of actions.entries()) {
    const name = String(a.action || "").toLowerCase();
    const label = (i + 1) + ". " + name + (a.index ? " [" + a.index + "]" : "");
    try {
      await checkTab(current, policy);
      if (switched && indexed(a)) throw new Error("the tab changed in this call: take a snapshot of it (browser_state) before using element numbers");
      let note = "";
      if (name === "click") {
        const p = await agent(current, "point", [a.index, { checkRisk: guard && !confirm }]);
        if (p.risky) { stopped = { index: a.index, reason: p.risky, desc: p.desc }; steps.push(label + " " + p.desc + " -> NOT DONE: needs confirmation (" + p.risky + ")"); break; }
        const urlBefore = (await chrome.tabs.get(current)).url;
        if (p.covered) { await agent(current, "clickDirect", [a.index]); note = " (covered by another element: clicked directly)"; }
        else await withDebugger(current, (t) => mouseClick(t, p.x, p.y));
        await settle(current, urlBefore);
        await landed(current, policy, false);
        const after = await chrome.tabs.get(current);
        if (after.url !== urlBefore) note += " -> now at " + after.url;
        steps.push(label + " " + p.desc + " -> ok" + note);
      } else if (name === "type") {
        const f = await agent(current, "focusField", [a.index, a.mode === "append" ? "append" : "fill"]);
        const text = String(a.text == null ? "" : a.text);
        await withDebugger(current, async (t) => {
          if (!text && a.mode !== "append" && f.hadText) await pressKeys(t, "Backspace");
          if (text) await dbgSend(t, "Input.insertText", { text });
        });
        let done = label + ' "' + (text.length > 60 ? text.slice(0, 57) + "..." : text) + '" -> ok';
        if (a.submit) {
          const risk = guard && !confirm ? await agent(current, "enterRisk", [a.index]) : null;
          if (risk) { stopped = { index: a.index, reason: risk }; steps.push(done + "; Enter NOT pressed: needs confirmation (" + risk + ")"); break; }
          const urlBefore = (await chrome.tabs.get(current)).url;
          await withDebugger(current, (t) => pressKeys(t, "Enter"));
          await settle(current, urlBefore);
          await landed(current, policy, false);
          const after = await chrome.tabs.get(current);
          done += ", Enter pressed" + (after.url !== urlBefore ? " -> now at " + after.url : "");
        }
        steps.push(done);
      } else if (name === "key" || name === "keys" || name === "send_keys") {
        const combo = String(a.keys || a.key || "").trim();
        const last = (combo.split("+").pop() || "").trim().toLowerCase();
        if (["enter", "space", " "].includes(last) && guard && !confirm) {
          // Enter (with or without modifiers) and Space activate the focused control.
          const risk = await agent(current, "enterRisk", [null]);
          if (risk) { stopped = { reason: risk }; steps.push(label + " " + combo + " -> NOT DONE: needs confirmation (" + risk + ")"); break; }
        }
        const urlBefore = (await chrome.tabs.get(current)).url;
        await withDebugger(current, (t) => pressKeys(t, combo));
        await settle(current, urlBefore);
        await landed(current, policy, false);
        steps.push(label + " " + combo + " -> ok");
      } else if (name === "select") {
        steps.push(label + ' -> selected "' + (await agent(current, "select", [a.index, a.option != null ? a.option : a.text])) + '"');
      } else if (name === "options") {
        const opts = await agent(current, "options", [a.index]);
        steps.push(label + " -> " + opts.map((o) => (o.selected ? "*" : "") + o.text + (o.value && o.value !== o.text ? " (" + o.value + ")" : "")).join(" | "));
      } else if (name === "scroll") {
        steps.push(label + " -> " + (await agent(current, "scroll", [{ to: a.to, percent: a.percent, text: a.text, index: a.index }])));
      } else if (name === "goto" || name === "navigate") {
        if (!a.url) throw new Error("goto needs a url");
        checkUrl(a.url, policy);
        await chrome.tabs.update(current, { url: a.url });
        await waitForLoad(current, Number(a.timeout) * 1000 || 20000);
        await landed(current, policy, false);
        steps.push(label + " " + a.url + " -> " + (await chrome.tabs.get(current)).url);
      } else if (name === "search") {
        const url = "https://www.google.com/search?q=" + encodeURIComponent(String(a.query || a.text || ""));
        checkUrl(url, policy);
        await chrome.tabs.update(current, { url });
        await waitForLoad(current, 20000);
        await landed(current, policy, false);
        steps.push(label + ' "' + (a.query || a.text) + '" -> ok');
      } else if (name === "back" || name === "forward") {
        const urlBefore = (await chrome.tabs.get(current)).url;
        await (name === "back" ? chrome.tabs.goBack(current) : chrome.tabs.goForward(current));
        await settle(current, urlBefore, 15000);
        if (policyBlocks((await chrome.tabs.get(current)).url, policy)) {
          // History led to a blocked site: undo the step.
          await (name === "back" ? chrome.tabs.goForward(current) : chrome.tabs.goBack(current));
          await settle(current, "", 15000);
          throw Object.assign(new Error("that history entry is on a blocked site; stayed on the current page"), { code: "policy" });
        }
        steps.push(label + " -> " + (await chrome.tabs.get(current)).url);
      } else if (name === "reload") {
        await chrome.tabs.reload(current);
        await waitForLoad(current, 20000);
        steps.push(label + " -> ok");
      } else if (name === "wait") {
        const s = Math.min(Math.max(Number(a.seconds) || 2, 0.2), 30);
        if (a.text) {
          const end = Date.now() + s * 1000;
          let found = false;
          while (Date.now() < end && !found) {
            const [r] = await chrome.scripting.executeScript({ target: { tabId: current }, world: "ISOLATED", func: (t) => (document.body && document.body.innerText || "").toLowerCase().includes(String(t).toLowerCase()), args: [a.text] });
            found = !!(r && r.result);
            if (!found) await new Promise((r2) => setTimeout(r2, 300));
          }
          steps.push(label + ' for "' + a.text + '" -> ' + (found ? "found" : "not found after " + s + " s"));
        } else { await new Promise((r) => setTimeout(r, s * 1000)); steps.push(label + " " + s + " s -> ok"); }
      } else if (name === "switch_tab") {
        await checkTab(Number(a.tabId), policy);
        current = Number(a.tabId);
        switched = true;
        await chrome.tabs.update(current, { active: true });
        steps.push(label + " #" + current + " -> ok");
      } else if (name === "open_tab") {
        if (a.url) checkUrl(a.url, policy);
        const t = await chrome.tabs.create({ url: a.url || undefined, active: true });
        if (a.url) { await waitForLoad(t.id, 20000); await landed(t.id, policy, true); }
        current = t.id;
        switched = true;
        steps.push(label + " " + (a.url || "") + " -> tab #" + t.id);
      } else if (name === "close_tab") {
        const id = a.tabId != null ? Number(a.tabId) : current;
        await checkTab(id, policy);
        await chrome.tabs.remove(id);
        steps.push(label + " #" + id + " -> closed");
        if (id === current) { current = await resolveTabId({}, sender); switched = true; }
      } else {
        throw new Error("unknown action (use click, type, key, select, options, scroll, goto, search, back, forward, reload, wait, switch_tab, open_tab, close_tab)");
      }
    } catch (e) {
      steps.push(label + " -> FAILED: " + String(e && e.message || e));
      stopped = stopped || { failed: true };
      break;
    }
  }

  const out = { ok: true, tabId: current, steps, stopped, done: !stopped, urlBefore: before.url };
  if (req.state !== "none") {
    try {
      await checkTab(current, policy);
      const snap = await agent(current, "snapshot", [{ scope: "viewport", maxChars: req.maxChars || 8000 }]);
      await noteSnapshot(current);
      try { await agent(current, "highlight", [req.highlight !== false, "page"]); } catch (e) {}
      out.state = { ...snap, tabs: await otherTabs(current, policy) };
    } catch (e) { out.stateError = String(e && e.message || e); }
  }
  return out;
}

// After an input that may navigate: wait for a new page to load, or briefly for
// the page to react.
async function settle(tabId, urlBefore, ms) {
  await new Promise((r) => setTimeout(r, 200));
  let t;
  try { t = await chrome.tabs.get(tabId); } catch (e) { return; }
  if (t.status === "loading" || t.url !== urlBefore) await waitForLoad(tabId, ms || 15000);
  else await new Promise((r) => setTimeout(r, 250));
}

// ---- the model's own scripts ---------------------------------------------------------------
// Render a CDP RemoteObject as a short string for console lines.
function remoteToText(o) {
  if (!o) return "";
  if ("value" in o) return typeof o.value === "string" ? o.value : safeJson(o.value);
  if (o.unserializableValue != null) return String(o.unserializableValue);
  return o.description || o.className || o.type || "";
}
function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

async function runViaDebugger(tabId, code, timeoutMs) {
  const logs = [];
  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tabId) return;
    if (method === "Runtime.consoleAPICalled") {
      const args = (params.args || []).map(remoteToText).join(" ");
      logs.push(params.type + ": " + args);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      logs.push("exception: " + (d.exception ? remoteToText(d.exception) : d.text || "error"));
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    return await withDebugger(tabId, async (target) => {
      await dbgSend(target, "Runtime.enable");
      // Wrap so the model can use `await` and `return <value>`.
      const expression = "(async () => {\n" + code + "\n})()";
      const res = await withTimeout(
        dbgSend(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true }),
        timeoutMs, "script");
      // consoleAPICalled events and the evaluate reply are separate CDP messages;
      // let any console lines emitted during the run drain before we detach.
      await new Promise((r) => setTimeout(r, 50));
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        return { ok: true, tabId, result: undefined, value: undefined, logs, error: d.exception ? remoteToText(d.exception) : (d.text || "error") };
      }
      const r = res.result || {};
      let result;
      if (r.type === "undefined") result = undefined;
      else if ("value" in r) result = typeof r.value === "string" ? r.value : safeJson(r.value);
      else result = r.description || r.type;  // not serialisable (e.g. a DOM node)
      return { ok: true, tabId, result, value: "value" in r ? r.value : undefined, logs, error: null };
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), logs };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}
