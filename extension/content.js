// Code Runner Browser Bridge - content script.
//
// Injected into EVERY frame of every page (all_frames + match_origin_as_fallback),
// so it also lands inside TypingMind's sandboxed, opaque-origin plugin iframe -
// the one place the Code Runner plugin code actually runs. It is a relay: the
// plugin posts a window message, this script forwards it to the service worker,
// and posts the reply back to the window.
//
// Protocol (page -> here):  { __crbReq: true, id, request }
//          (here -> page):  { __crbRes: true, id, response }
//
// The service worker only acts for pages on its trusted hosts (TypingMind by
// default) that also send the pairing key, so a random website cannot use it.

(function () {
  if (window.__crbBridgeInstalled) return;      // all_frames can re-run on some navigations
  window.__crbBridgeInstalled = true;

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__crbReq !== true || typeof d.id !== "string") return;
    // Only messages a frame posts to itself (the plugin posts to its own window).
    if (e.source !== window) return;
    try {
      chrome.runtime.sendMessage({ type: "crb", request: d.request }, function (resp) {
        var err = chrome.runtime.lastError;
        window.postMessage({
          __crbRes: true,
          id: d.id,
          response: err ? { ok: false, error: "bridge: " + err.message } : resp
        }, "*");
      });
    } catch (err) {
      // Extension context gone (reloaded/updated). Tell the caller instead of hanging.
      window.postMessage({ __crbRes: true, id: d.id, response: { ok: false, error: "bridge unavailable: " + (err && err.message || err) } }, "*");
    }
  }, false);
})();
