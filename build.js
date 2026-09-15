#!/usr/bin/env node
// Generates plugin.json from this manifest, injecting implementation.js into
// every function's `code` field and README.md into overviewMarkdown. Both
// functions share the same source (it defines run_code and serve_file), so the
// TypingMind sandbox can eval the whole file and call either entry point.
//
//   node build.js         # write plugin.json
//   node build.js --check # verify plugin.json is up to date (CI/pre-commit)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = __dirname;

const code = fs.readFileSync(path.join(ROOT, "implementation.js"), "utf8");
const overviewMarkdown = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// The language list comes from the implementation itself, so the schema can never drift.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code + "\n;globalThis.__langs = { all: ALL_LANGS, ce: Object.keys(CE_LANGS), wb: Object.keys(WB_LANGS) };", sandbox);
const { all: LANGS, ce: CE, wb: WB } = sandbox.__langs;

const runCodeSpec = {
  name: "run_code",
  description:
    "Run code and return its output (print what you need). " +
    "In-browser, with HTTP internet access and a /workspace folder that persists across calls: " +
    "python (Pyodide, Python 3.13: numpy, pandas, matplotlib, requests, bs4, PIL, sklearn...; common pure-Python packages install automatically), " +
    "javascript / typescript (top-level await, fetch, fs, storage), sql (SQLite file /workspace/data.sqlite). " +
    "Remote, short programs without internet or files: " + CE.join(", ") + "; best-effort: " + WB.join(", ") + ". " +
    "Each call is a new process: variables do not survive, files in /workspace do. " +
    "To give the user a file (chart, CSV, image, document), save it in /workspace, then call serve_file. " +
    "No shell, subprocess, sockets or pip; blocked sites retry through proxies. " +
    "To read or control the user's open browser tabs (click, fill, read the DOM, switch/open tabs) use browser_run and browser_tabs.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: LANGS, description: "Language of `code`. Prefer python for data, files, web requests and anything long-running." },
      code: {
        type: "string",
        description:
          "The complete program. Output is everything printed, plus the last expression's value (python) or a top-level `return` value (javascript/typescript). " +
          "PYTHON: cwd is /workspace, so open('data.csv') reads and writes there; top-level await works; open matplotlib figures are saved automatically as figure_N.png; input() reads `stdin`. " +
          "HTTP via requests, urllib.request or pyodide.http.pyfetch. " +
          "JAVASCRIPT / TYPESCRIPT (a browser worker, not Node.js - no require, process or DOM): fetch(url); async fs with paths relative to /workspace: " +
          "fs.readFile(p) returns text, fs.readFile(p, 'binary') a Uint8Array, fs.writeFile(p, string | Uint8Array | Blob | Response | object), fs.appendFile, fs.readdir(), fs.exists, fs.stat, fs.mkdir, fs.rm(p, {recursive: true}), fs.rename, fs.copyFile, fs.list(), fs.download(url, name?); " +
          "storage.get/set(key, value) keeps JSON values between calls; `stdin` is a string; libraries load with `await import('https://cdn.jsdelivr.net/npm/<package>/+esm')` or `await importScripts(url)`. " +
          "SQL runs on /workspace/data.sqlite; python opens the same database with sqlite3.connect('data.sqlite'). " +
          "REMOTE LANGUAGES: one file with a normal main function, input from `stdin`, a run-time limit of a few seconds. " +
          "INTERNET: for the readable text of a web page fetch 'https://r.jina.ai/' + url; for GitHub files use raw.githubusercontent.com URLs."
      },
      packages: {
        type: "array",
        items: { type: "string" },
        description:
          "Python only. Extra PyPI packages to install before running, e.g. [\"beautifulsoup4\", \"pyyaml\"]. Packages Pyodide ships (numpy, pandas, scipy, matplotlib, scikit-learn, pillow, lxml, bs4...) and common ones such as yaml, docx, openpyxl or tabulate load automatically from the imports. Pure-Python wheels or packages built for Pyodide only."
      },
      stdin: {
        type: "string",
        description: "Optional standard input: python input() reads it line by line, javascript/typescript get it as `stdin`, compiled programs read it from stdin."
      },
      timeout: {
        type: "number",
        description: "Optional time limit in seconds for python, javascript, typescript and sql (default 120, max 900). The run is stopped and reported when it is exceeded."
      }
    },
    required: ["language", "code"]
  }
};

const serveFileSpec = {
  name: "serve_file",
  description:
    "Show a file from /workspace to the user directly in the chat, without its contents passing through your context: " +
    "images appear inline, small text/code/CSV/JSON files as a code block, and anything else (PDF, XLSX, DOCX, ZIP, audio...) as a download link. " +
    "First create the file with run_code (for example save a chart, a CSV or a report into /workspace), then call serve_file with its path. " +
    "Use this instead of pasting file contents into your answer. Files up to 20 MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in /workspace, e.g. 'chart.png', 'out/report.csv' or '/workspace/data.xlsx'." },
      filename: { type: "string", description: "Optional download name shown to the user. Defaults to the file's own name." },
      mime: { type: "string", description: "Optional MIME type. Guessed from the extension when omitted." },
      as: { type: "string", enum: ["auto", "image", "link", "text"], description: "How to present it. auto (default): image inline, small text files as a code block, otherwise a download link." }
    },
    required: ["path"]
  }
};

const browserRunSpec = {
  name: "browser_run",
  description:
    "Run JavaScript inside one of the USER'S OWN open browser tabs; returns the value plus real console output. " +
    "Use it to read or control a page the user is looking at: read the DOM (return document.title, innerText, a table as JSON), click or fill things (document.querySelector('#save').click()), scroll, change the view. " +
    "Code runs in the page as an async function body: `await` works and you get a result by writing `return <value>` (JSON-serialisable, never DOM nodes). console.log/warn/error during the run are captured. " +
    "It runs via the browser's debugger, so it works even on strict-CSP sites; a 'started debugging' banner shows while it runs. " +
    "Default tab is the active one; pass `tabId` from browser_tabs for another. Cannot script chrome:// pages, the Web Store, or a tab with DevTools open. " +
    "Needs the companion Chrome extension (extension/ folder) loaded unpacked; returns setup steps if missing. Chrome desktop only, and separate from run_code's /workspace sandbox.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript to run in the page. Use `await` freely and `return <value>` to send a result back, e.g. `return [...document.querySelectorAll('h2')].map(e => e.innerText)`. To act on the page: `document.querySelector('button.buy').click(); return 'clicked'`." },
      tabId: { type: "number", description: "Optional. Which tab to run in (get ids from browser_tabs with action 'list'). Omitted: the currently active tab." },
      timeout: { type: "number", description: "Optional seconds before the run is abandoned (default 15, max 120)." }
    },
    required: ["code"]
  }
};

const browserTabsSpec = {
  name: "browser_tabs",
  description:
    "List and manage the user's open browser tabs: see what is open, switch to a tab, open a new one, close one, reload, or navigate a tab to a URL. " +
    "Call it with action 'list' first to learn tab ids and titles, then pass a `tabId` to act on a specific tab; browser_run uses the same ids. " +
    "Requires the same companion Chrome extension as browser_run (extension/ folder, loaded unpacked); returns setup steps if it is missing. Chrome desktop only.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "activate", "open", "close", "reload", "navigate"], description: "What to do. list: all tabs in the current window (add allWindows for every window). activate: bring a tab to the front. open: new tab (optionally at `url`). close/reload: act on `tabId`. navigate: send `tabId` to `url`." },
      tabId: { type: "number", description: "Target tab id (from action 'list'). Required for activate, close, reload, navigate." },
      url: { type: "string", description: "For open (page to open) and navigate (where to send the tab)." },
      active: { type: "boolean", description: "For open: focus the new tab (default true) or open it in the background (false)." },
      allWindows: { type: "boolean", description: "For list: include tabs from every window, not just the current one." }
    },
    required: ["action"]
  }
};

const userSettings = [
  { name: "corsProxy", label: "Personal CORS proxy (recommended)", description: "Makes downloads from websites that block browsers work reliably. Deploy the free companion Cloudflare Worker (worker/ folder of this plugin's repository) and enter https://<worker-name>.<account>.workers.dev/?key=<PROXY_KEY>&url= . Any proxy URL prefix, or a URL containing {url}, also works. Without it only a few public proxies are tried, and they often fail.", placeholder: "https://code-runner-proxy.example.workers.dev/?key=SECRET&url=", required: false },
  { name: "workspaceStore", label: "Workspace store (recommended)", description: "Carries large workspaces (charts, downloads, datasets) between calls privately. With the companion Worker enter https://<worker-name>.<account>.workers.dev/store?key=<PROXY_KEY> . Contract for other servers: POST the payload, respond with a read URL as plain text; GET returns it; DELETE removes it. Without it, workspaces above the inline limit go to public temporary stores (litterbox.catbox.moe, pastes.dev, dpaste.com).", placeholder: "https://code-runner-proxy.example.workers.dev/store?key=SECRET", required: false },
  { name: "execTimeoutSec", label: "Run time limit (seconds)", description: "Default 120. Python, JavaScript, TypeScript and SQL runs are stopped after this long (the model can pass a different `timeout` per call, up to 900).", type: "number", required: false },
  { name: "stateCarry", label: "Persist workspace between calls", description: "Default on. TypingMind runs each call in a fresh sandbox, so /workspace (including the SQLite database) and JavaScript storage are carried forward inside the tool output. Set to \"off\" to disable.", placeholder: "on", required: false },
  { name: "stateLimitKB", label: "Inline workspace limit (KB)", description: "Default 24. A compressed workspace up to this size travels inside the tool output (it costs tokens); a larger one is offloaded to the workspace store.", type: "number", required: false },
  { name: "bigWorkspace", label: "Offload large workspaces", description: "Default on. Workspaces above the inline limit are uploaded to the workspace store (yours, or a public temporary store when none is set) and only a small pointer travels in the output. Set \"off\" to never upload; oversized files are then dropped between calls (the model is told which).", placeholder: "on", required: false },
  { name: "workspaceTtlMin", label: "Offloaded workspace lifetime (minutes)", description: "Default 1440 (24 hours). An offloaded workspace older than this is not restored.", type: "number", required: false },
  { name: "fetchTimeoutMs", label: "HTTP request timeout (ms)", description: "Default 30000. Per-request timeout for fetch / requests from Python and JavaScript before fallbacks are tried.", type: "number", required: false },
  { name: "pyodideCdn", label: "Pyodide CDN (optional)", description: "Base URL of a Pyodide 0.29.4 full distribution to try first, e.g. a self-hosted copy. Built-in fallbacks: cdn/fastly/gcore/testingcf.jsdelivr.net, then unpkg.", placeholder: "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/", required: false },
  { name: "sqljsCdn", label: "sql.js CDN (optional)", description: "Base URL of a sql.js 1.13.0 dist directory to try first. Built-in fallbacks: cdn/fastly.jsdelivr.net, unpkg, gcore.jsdelivr.net.", placeholder: "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/", required: false }
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
    { id: "serve-file-fn-fa4fdbb3", name: "serve_file", implementationType: "javascript", openaiSpec: serveFileSpec, code, outputType: "render_markdown" },
    { id: "browser-run-fn-fa4fdbb3", name: "browser_run", implementationType: "javascript", openaiSpec: browserRunSpec, code, outputType: "respond_to_ai" },
    { id: "browser-tabs-fn-fa4fdbb3", name: "browser_tabs", implementationType: "javascript", openaiSpec: browserTabsSpec, code, outputType: "respond_to_ai" }
  ],
  overviewMarkdown
};

const outPath = path.join(ROOT, "plugin.json");
const json = JSON.stringify(plugin, null, 2) + "\n";

// OpenAI caps function descriptions at 1024 characters.
for (const fn of plugin.pluginFunctions) {
  const n = fn.openaiSpec.description.length;
  if (n > 1024) { console.error(fn.name + " description is " + n + " chars (max 1024)"); process.exit(1); }
}

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  if (current !== json) { console.error("plugin.json is out of date - run: node build.js"); process.exit(1); }
  console.log("plugin.json up to date"); process.exit(0);
}

fs.writeFileSync(outPath, json);
console.log("wrote plugin.json (" + json.length + " bytes; run_code desc " + runCodeSpec.description.length +
  ", serve_file desc " + serveFileSpec.description.length +
  ", browser_run desc " + browserRunSpec.description.length +
  ", browser_tabs desc " + browserTabsSpec.description.length +
  ", " + LANGS.length + " languages)");
