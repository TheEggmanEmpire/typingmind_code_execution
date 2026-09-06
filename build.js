#!/usr/bin/env node
// Generates plugin.json from this manifest, injecting implementation.js into
// every function's `code` field and README.md into overviewMarkdown. Both
// functions share the same source (it defines run_code and serve_file), so the
// TypingMind sandbox can eval the whole file and call either entry point.
//
//   node build.js        # write plugin.json
//   node build.js --check # verify plugin.json is up to date (CI/pre-commit)

const fs = require("fs");
const path = require("path");
const ROOT = __dirname;

const code = fs.readFileSync(path.join(ROOT, "implementation.js"), "utf8");
const overviewMarkdown = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

const LANGS = ["python", "javascript", "sql", "c", "c++", "rust", "go", "ruby", "java", "csharp", "haskell", "lua"];

const runCodeSpec = {
  name: "run_code",
  description:
    "Execute code and return its printed output. Languages: python, javascript, sql (SQLite), c, c++, rust, go, ruby, java, csharp, haskell, lua. Use whenever a result should be computed, not guessed. Always print the values you want returned. " +
    "INTERNET (python, javascript): the runtime is WASM in the browser tab - no container, no sockets, no DNS; socket/ping/DNS probes always fail. HTTP works via the browser: python `requests.get(url)` (also urllib.request, pyodide.http.pyfetch); javascript `fetch(url)`. Browser CORS applies; a blocked request auto-retries through ~10 built-in public CORS proxies, so cross-origin downloads work with no setup. " +
    "TEMP FILES: /workspace is shared by python (cwd), javascript (fs) and sql; it persists across calls (large workspaces auto-offload to an ephemeral bin, ~10 min). To show a saved file to the user, call serve_file. " +
    "PACKAGES: extra Python packages via `packages` (micropip, session-only). Compiler Explorer languages: no internet, no files. Java: do NOT declare the class public.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: LANGS, description: "Language to execute the code in." },
      code: {
        type: "string",
        description:
          "Complete source code. Must print its own output. " +
          "Temp files: python starts in /workspace, so open('data.csv','w') writes there and later calls can read it; use /tmp for throwaway files. " +
          "javascript has `await fs.writeFile(name, textOrBytes)`, `await fs.readFile(name)` (`'binary'` as 2nd arg for bytes), `fs.appendFile`, `fs.readdir('/workspace')`, `fs.exists`, `fs.unlink`, `fs.mkdir`, `fs.stat`, plus `storage.set(key,value)`/`storage.get(key)` for values between calls. " +
          "Any number of files is fine; within one call /workspace is limited only by browser memory (tens-hundreds of MB). Files, the SQL database and JS storage also persist across separate calls (carried in the tool output, or offloaded to an ephemeral bin when large); for heavy multi-file work prefer a single call. " +
          "sql keeps its tables between calls; python can open the same database with `sqlite3.connect('/workspace/data.sqlite')`. Delete data.sqlite to reset it. " +
          "Internet: python `requests.get/post`, `urllib.request.urlopen`, `await pyodide.http.pyfetch`; javascript `fetch`. Binary download example (js): `const b=new Uint8Array(await (await fetch(url)).arrayBuffer()); await fs.writeFile('f.bin', b)`. " +
          "Install Python packages inline: `import micropip; await micropip.install('pkg')` (top-level await allowed)."
      },
      packages: {
        type: "array",
        items: { type: "string" },
        description:
          "Python only. Extra PyPI packages to install with micropip before running, e.g. ['beautifulsoup4', 'pyyaml']. Session-only (gone on page reload; skipped if already installed). Pure-Python wheels and Pyodide-prebuilt packages (numpy, pandas, scipy, scikit-learn, matplotlib, pillow, lxml, sqlalchemy, ...). numpy/pandas/requests etc. auto-load from imports without listing them. Slow - omit unless needed."
      }
    },
    required: ["language", "code"]
  }
};

const serveFileSpec = {
  name: "serve_file",
  description:
    "Serve a file from /workspace to the user - it is rendered directly in the chat, so the bytes do not pass through your context. Use this to hand the user a file that run_code fetched, generated or edited (a report, an image, a CSV, an HTML page, a converted document). Call run_code first to create the file, then serve_file with its /workspace path. Images display inline; other files show as a download link. serve_file uploads nothing - the file is embedded in the message as a data: URI. Only works for files already in /workspace this session.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file inside /workspace, e.g. 'report.csv', 'chart.png', or '/workspace/out.html'." },
      filename: { type: "string", description: "Optional download name shown to the user. Defaults to the file's own name." },
      mime: { type: "string", description: "Optional MIME type. Guessed from the extension when omitted." },
      as: { type: "string", enum: ["auto", "image", "link", "text"], description: "How to present it. auto (default): image inline, small text files as a code block, otherwise a download link." }
    },
    required: ["path"]
  }
};

const userSettings = [
  { name: "corsProxy", label: "CORS proxy override (optional)", description: "A blocked cross-origin request already falls back automatically through ~10 built-in public CORS proxies. Set this only to try your own proxy first (prefix like https://corsproxy.io/?url= or a URL with {url}). Traffic through any proxy is visible to its operator.", placeholder: "https://corsproxy.io/?url=", required: false },
  { name: "pyodideCdn", label: "Pyodide CDN (optional)", description: "Base URL of a Pyodide 0.29.4 full distribution to try first, e.g. a self-hosted copy. Built-in fallbacks: cdn/fastly/gcore/testingcf.jsdelivr.net, then unpkg (core only).", placeholder: "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/", required: false },
  { name: "sqljsCdn", label: "sql.js CDN (optional)", description: "Base URL of a sql.js 1.13.0 dist directory to try first. Built-in fallbacks: cdn/fastly.jsdelivr.net, unpkg, gcore.jsdelivr.net.", placeholder: "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/", required: false },
  { name: "stateCarry", label: "Persist workspace between calls", description: "Default on. TypingMind runs each call in a fresh sandbox, so /workspace, the SQL database and JS storage are carried forward inside the tool output. Set to \"off\" to disable.", placeholder: "on", required: false },
  { name: "stateLimitKB", label: "Max carried workspace size (KB)", description: "Default 24. If the compressed workspace exceeds this, it is not carried and a note is shown. Keep well under your model's token budget.", type: "number", required: false },
  { name: "fetchTimeoutMs", label: "HTTP request timeout (ms)", description: "Default 30000. Per-request timeout for fetch/requests from Python and JavaScript.", type: "number", required: false },
  { name: "bigWorkspace", label: "Offload large workspaces to an ephemeral bin", description: "Default on. When the carried workspace is bigger than the inline limit, it is uploaded to a public ephemeral paste bin (paste.rs -> dpaste.com -> sprunge.us) and only a small pointer travels in the tool output; the next call downloads it. A 10-minute logical expiry is enforced and each new snapshot deletes the previous blob. Your workspace bytes leave the browser to that public service - set \"off\" to keep everything inline, or set your own endpoint below.", placeholder: "on", required: false },
  { name: "workspaceStore", label: "Workspace store endpoint (optional)", description: "Your own paste-style endpoint for large-workspace offload, tried before the public bins. Contract: POST the payload as the body, respond with the read URL as plain text; GET that URL returns the payload; DELETE that URL removes it. Keeps large workspaces private to your own server.", placeholder: "https://your-worker.example/blob", required: false }
];

const plugin = {
  uuid: "fa4fdbb3-3f30-49d4-9171-40480971642d",
  id: "fa4fdbb3-3f30-49d4-9171-40480971642d",
  emoji: "🧪",
  title: "Code Runner",
  iconURL: "https://custom.typingmind.com/assets/plugins/javascript.webp",
  authenticationType: "AUTH_TYPE_NONE",
  oauthConfig: null,
  userSettings,
  dynamicContextEndpoints: [],
  pluginFunctions: [
    { id: "run-code-fn-fa4fdbb3", name: "run_code", implementationType: "javascript", openaiSpec: runCodeSpec, code, outputType: "respond_to_ai" },
    { id: "serve-file-fn-fa4fdbb3", name: "serve_file", implementationType: "javascript", openaiSpec: serveFileSpec, code, outputType: "render_markdown" }
  ],
  overviewMarkdown
};

const outPath = path.join(ROOT, "plugin.json");
const json = JSON.stringify(plugin, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (current !== json) { console.error("plugin.json is out of date - run: node build.js"); process.exit(1); }
  // Validate function-description length (OpenAI caps at 1024).
  for (const fn of plugin.pluginFunctions) {
    if (fn.openaiSpec.description.length > 1024) { console.error(fn.name + " description too long: " + fn.openaiSpec.description.length); process.exit(1); }
  }
  console.log("plugin.json up to date"); process.exit(0);
}

for (const fn of plugin.pluginFunctions) {
  if (fn.openaiSpec.description.length > 1024) { console.error("WARNING: " + fn.name + " description is " + fn.openaiSpec.description.length + " chars (>1024)"); process.exit(1); }
}
fs.writeFileSync(outPath, json);
console.log("wrote plugin.json (" + json.length + " bytes; run_code desc " + runCodeSpec.description.length + ", serve_file desc " + serveFileSpec.description.length + ")");
