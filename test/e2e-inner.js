// Loaded into a fresh <iframe sandbox="allow-scripts"> for every call, like
// TypingMind: an opaque origin, nothing in memory from earlier calls. The parent
// posts the plugin source and the previous output; this frame evals the plugin,
// runs one function and posts the result back.
window.addEventListener("message", async (e) => {
  const { impl, fn, params, settings, prev, name, noWorker } = e.data || {};
  try {
    if (noWorker) globalThis.__crNoWorker = true;   // exercise the in-thread fallback
    (0, eval)(impl);
    const t0 = Date.now();
    const f = { run_code, serve_file, preview_file, manage_files }[fn] || run_code;
    const out = await f(params, settings || {}, { previousRunOutput: prev });
    parent.postMessage({ name, out, ms: Date.now() - t0 }, "*");
  } catch (err) {
    parent.postMessage({ name, out: "HARNESS THROW: " + (err && err.stack || err), ms: 0 }, "*");
  }
});
