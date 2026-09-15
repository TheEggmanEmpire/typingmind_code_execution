// Code Runner Browser Bridge - service worker.
//
// Receives relayed requests from content.js and drives the real Chrome APIs.
// Tabs are handled with chrome.tabs. Running a script uses chrome.debugger
// (the DevTools protocol): Runtime.evaluate runs the model's code in the page's
// own context, BYPASSES the page's Content-Security-Policy (so it works on sites
// that forbid eval), and reports the real console via Runtime.consoleAPICalled.
// The browser shows a "started debugging this browser" banner while a run is in
// flight; we attach per call and detach as soon as it returns.
//
// Every reply is { ok: true, ... } or { ok: false, error }.

const VERSION = "0.2.0";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "crb") return;
  handle(msg.request || {}, sender)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async sendResponse
});

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error((what || "operation") + " timed out after " + ms + " ms")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function resolveTabId(req) {
  if (req.tabId != null) return Number(req.tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab (pass an explicit tabId from browser_tabs list)");
  return tab.id;
}

function tabView(t) {
  return { id: t.id, windowId: t.windowId, index: t.index, active: t.active, url: t.url || t.pendingUrl || "", title: t.title || "" };
}

async function handle(req, sender) {
  switch (req.op) {
    case "ping":
      return { ok: true, version: VERSION };

    // ---- tabs ----
    case "tabs.list": {
      const tabs = await chrome.tabs.query(req.allWindows ? {} : { currentWindow: true });
      return { ok: true, tabs: tabs.map(tabView) };
    }
    case "tabs.activate": {
      const id = await resolveTabId(req);
      const t = await chrome.tabs.update(id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
      return { ok: true, tab: tabView(t) };
    }
    case "tabs.open": {
      const t = await chrome.tabs.create({ url: req.url || undefined, active: req.active !== false });
      return { ok: true, tab: tabView(t) };
    }
    case "tabs.close": {
      const id = await resolveTabId(req);
      await chrome.tabs.remove(id);
      return { ok: true, closed: id };
    }
    case "tabs.reload": {
      const id = await resolveTabId(req);
      await chrome.tabs.reload(id);
      return { ok: true, tab: id };
    }
    case "tabs.navigate": {
      const id = await resolveTabId(req);
      if (!req.url) throw new Error("tabs.navigate needs a url");
      const t = await chrome.tabs.update(id, { url: req.url });
      return { ok: true, tab: tabView(t) };
    }

    // ---- run script (via the DevTools protocol) ----
    case "run": {
      const id = await resolveTabId(req);
      const ms = Math.min(Math.max(Number(req.timeoutMs) || 15000, 1000), 120000);
      return await runViaDebugger(id, String(req.code || ""), ms);
    }

    default:
      return { ok: false, error: "unknown op: " + req.op };
  }
}

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

// Render a CDP RemoteObject as a short string for console lines.
function remoteToText(o) {
  if (!o) return "";
  if ("value" in o) return typeof o.value === "string" ? o.value : safeJson(o.value);
  if (o.unserializableValue != null) return String(o.unserializableValue);
  return o.description || o.className || o.type || "";
}
function safeJson(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

async function runViaDebugger(tabId, code, timeoutMs) {
  const target = { tabId };
  try {
    await dbgAttach(target);
  } catch (e) {
    const m = String(e && e.message || e);
    if (/Cannot access|devtools|Another debugger|chrome-untrusted|Cannot attach/i.test(m)) {
      return { ok: false, error: "cannot script this tab (" + m + "). Chrome forbids debugging chrome:// pages, the Web Store, and tabs with DevTools already open. Pick another tab." };
    }
    return { ok: false, error: "could not attach to the tab: " + m };
  }

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
    await dbgSend(target, "Runtime.enable");
    // Wrap so the model can use `await` and `return <value>`.
    const expression = "(async () => {\n" + code + "\n})()";
    const res = await withTimeout(
      dbgSend(target, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true
      }),
      timeoutMs,
      "script"
    );
    // consoleAPICalled events and the evaluate reply are separate CDP messages;
    // let any console lines emitted during the run drain before we detach.
    await new Promise((r) => setTimeout(r, 50));
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception ? remoteToText(d.exception) : (d.text || "error");
      return { ok: true, tabId, result: undefined, logs, error: text };
    }
    const r = res.result || {};
    let result;
    if (r.type === "undefined") result = undefined;
    else if ("value" in r) result = typeof r.value === "string" ? r.value : safeJson(r.value);
    else result = r.description || r.type;  // not serialisable (e.g. a DOM node)
    return { ok: true, tabId, result, logs, error: null };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), logs };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    try { await new Promise((r) => chrome.debugger.detach(target, () => { void chrome.runtime.lastError; r(); })); } catch (e) {}
  }
}
