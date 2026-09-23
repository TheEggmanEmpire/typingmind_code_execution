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
vm.runInContext(code + "\n;globalThis.__langs = { all: ALL_LANGS, ce: Object.keys(CE_LANGS), wb: Object.keys(WB_LANGS), local: LOCAL_LANGS };", sandbox);
const { all: LANGS, ce: CE, wb: WB } = sandbox.__langs;
for (const fn of ["run_code", "serve_file", "preview_file", "manage_files", "browser_run", "browser_tabs"]) {
  if (vm.runInContext("typeof " + fn, sandbox) !== "function") throw new Error(fn + " is not defined in implementation.js");
}

const runCodeSpec = {
  name: "run_code",
  description:
    "Run code and return its output (print what you need). In the browser, with HTTP internet and a persistent /workspace folder: " +
    "python (Pyodide 3.13; numpy, pandas, matplotlib, requests, sklearn...), javascript / typescript (top-level await, fetch, fs, storage), " +
    "sql (SQLite, /workspace/data.sqlite), duckdb (SQL over CSV/Parquet/JSON files), r (webR; packages from library() install automatically). " +
    "Files in /workspace AND Python/R variables, DuckDB tables and JS storage survive between calls (reset: true starts clean). " +
    "Files the user attaches appear in /workspace/uploads. " +
    "Remote, short programs without internet or files: " + CE.join(", ") + "; best-effort: " + WB.join(", ") + ". " +
    "Show results to the user with preview_file (tables, HTML, media) or serve_file (images, downloads). No shell, subprocess or sockets. " +
    "User's open browser tabs: browser_tabs, browser_run.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: LANGS, description: "Language of `code`. Prefer python for data, files, web requests and long jobs; duckdb for SQL over large CSV/Parquet files; r for statistics." },
      code: {
        type: "string",
        description:
          "The complete program. Output is everything printed, plus the last expression's value (python, r) or a top-level `return` value (javascript/typescript). Paths are relative to /workspace. " +
          "PYTHON: open('data.csv') reads /workspace; top-level await; open matplotlib figures are saved as figure_N.png; input() reads `stdin`; variables, functions, classes and imports from earlier calls are still defined. HTTP via requests, urllib or pyodide.http.pyfetch. " +
          "JAVASCRIPT / TYPESCRIPT (browser worker, not Node.js: no require/process/DOM): fetch(url); async fs relative to /workspace: fs.readFile(p) text, fs.readFile(p, 'binary') Uint8Array, fs.writeFile(p, string | Uint8Array | Blob | Response | object), fs.appendFile, fs.readdir(), fs.exists, fs.stat, fs.mkdir, fs.rm(p, {recursive: true}), fs.rename, fs.copyFile, fs.list(), fs.download(url, name?); " +
          "storage.get/set(key, value) keeps JSON values; `stdin` is a string; libraries: `await import('https://cdn.jsdelivr.net/npm/<pkg>/+esm')`. Variables do not persist in JS (use storage or files). " +
          "SQL: SQLite on /workspace/data.sqlite (python: sqlite3.connect('data.sqlite')). " +
          "DUCKDB: query files by name, e.g. SELECT * FROM 'uploads/sales.csv' or read_parquet('x.parquet'); CREATE TABLE ... persists; COPY (...) TO 'out.csv' writes a file. " +
          "R: cwd is /workspace; plots are saved as rplot_N.png; readline() reads `stdin`; objects persist, library() calls are re-attached. " +
          "REMOTE LANGUAGES: one file with a normal main, input from `stdin`, a few seconds of run time. " +
          "INTERNET: for a page's readable text fetch 'https://r.jina.ai/' + url; GitHub files via raw.githubusercontent.com."
      },
      files: {
        type: "array",
        description: "Optional files to write into /workspace before running, e.g. data the user pasted into the chat: [{\"path\": \"data.csv\", \"content\": \"a,b\\n1,2\"}]. Use encoding \"base64\" for binary content. Prefer this over embedding large text in `code`.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path in /workspace." },
            content: { type: "string", description: "File content (text, or base64 when encoding is base64)." },
            encoding: { type: "string", enum: ["text", "base64"], description: "Default text." }
          },
          required: ["path", "content"]
        }
      },
      packages: {
        type: "array",
        items: { type: "string" },
        description: "Extra packages. Python: PyPI names installed with micropip (pure-Python wheels or Pyodide builds; common ones such as yaml, docx, openpyxl load automatically from imports). R: package names from the webR repository (library() calls install automatically)."
      },
      stdin: { type: "string", description: "Optional standard input: python input() and R readline() read it line by line, javascript/typescript get it as `stdin`, compiled programs read stdin." },
      timeout: { type: "number", description: "Optional time limit in seconds for the in-browser languages (default 120, max 900). The run is stopped and reported when exceeded; /workspace keeps its state from before the call." },
      reset: { type: "boolean", description: "Start without the Python/R variables and DuckDB tables saved by earlier calls (files are kept). Use when earlier state gets in the way." },
      typecheck: { type: "boolean", description: "TypeScript only: type-check with the real TypeScript compiler (strict) before running; type errors are reported with line numbers and the code does not run. Slower on first use (downloads ~9 MB)." },
      compiler_args: { type: "string", description: "Remote compiled languages only: compiler flags, e.g. \"-O2 -std=c++20\" or \"--edition 2024\". They replace the matching default flags." },
      compiler_version: { type: "string", description: "Remote languages only: compiler version, e.g. \"13\" (gcc 13), \"clang 18\", \"1.80\" (rust). An unknown version returns the list of available ones." }
    },
    required: ["language", "code"]
  }
};

const serveFileSpec = {
  name: "serve_file",
  description:
    "Show a file from /workspace to the user directly in the chat, without its contents passing through your context: " +
    "images appear inline, small text/code/CSV/JSON files as a code block, anything else (PDF, XLSX, DOCX, ZIP, audio...) as a download link. " +
    "Create the file with run_code first, then call serve_file with its path. Use it instead of pasting file contents into your answer, and whenever the user wants to download a file. Files up to 20 MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in /workspace, e.g. 'chart.png', 'out/report.csv' or '/workspace/data.xlsx'." },
      filename: { type: "string", description: "Optional download name shown to the user. Defaults to the file's own name." },
      mime: { type: "string", description: "Optional MIME type, e.g. text/csv. Guessed from the extension when omitted." },
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

const previewFileSpec = {
  name: "preview_file",
  description:
    "Show the user an interactive preview of a /workspace file in the chat: CSV/TSV/JSON/XLSX as a sortable, filterable table; " +
    "HTML pages rendered live (dashboards, charts made with Plotly/Chart.js/D3, reports); Markdown rendered; audio and video with players; images; PDFs. " +
    "Use it to present tables, HTML output and media; use serve_file when the user needs to download the file. The file contents do not pass through your context. Files up to 15 MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file in /workspace, e.g. 'results.csv' or 'report.html'." },
      as: { type: "string", enum: ["auto", "table", "sheet", "json", "html", "markdown", "text", "image", "audio", "video", "pdf"], description: "Presentation. auto (default) chooses from the file extension." }
    },
    required: ["path"]
  }
};

const manageFilesSpec = {
  name: "manage_files",
  description:
    "List, delete, rename or clear the files in /workspace without running code. " +
    "list shows every file with its size (including the user's attachments in uploads/) and what state is saved between calls. " +
    "delete takes paths or globs (\"tmp/*\", \"out/\"); rename moves a file or folder; clear empties the workspace; reset_variables forgets saved Python/R variables and DuckDB tables but keeps the files.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "delete", "rename", "clear", "reset_variables"], description: "Default list." },
      paths: { type: "array", items: { type: "string" }, description: "delete: files, folders (ending in /) or globs (* and **)." },
      from: { type: "string", description: "rename: current path." },
      to: { type: "string", description: "rename: new path." },
      keep_variables: { type: "boolean", description: "clear: keep saved variables and tables, remove only the files." }
    }
  }
};

// Always in the model's context while the plugin is enabled: how to use the tools well.
const USAGE_GUIDE = [
  "Code Runner tools: run_code, preview_file, serve_file, manage_files.",
  "- Work in steps. /workspace files, Python and R variables, DuckDB tables and JavaScript storage persist between run_code calls, so load data once and reuse it; pass reset: true to start clean.",
  "- Files the user attaches to their message are saved to /workspace/uploads/<name> automatically; check with manage_files (action list) when unsure what exists.",
  "- Data the user pastes as text: pass it in run_code `files` instead of embedding it in code.",
  "- Pick the language: python for general data work, files, web requests, charts; duckdb for SQL over big CSV/Parquet/JSON files; sql for a small persistent SQLite database; r for statistics and ggplot2; javascript/typescript for JS tasks (typecheck: true for strict type checking). Other languages run remotely without files or internet.",
  "- Show results instead of pasting them: preview_file for tables (sortable), HTML pages and dashboards, Markdown, audio/video; serve_file for images inline and download links. Charts: matplotlib figures and R plots are saved automatically (figure_N.png, rplot_N.png).",
  "- Output is capped at 40,000 characters: print summaries (df.head(), describe(), counts), not whole datasets.",
  "- Internet works over HTTP from the browser. Blocked sites are retried through proxies; for a web page's readable text fetch https://r.jina.ai/<url>. Requests with API keys never go through public proxies.",
  "- Each run has a time limit (default 120 s, `timeout` up to 900). A stopped run keeps /workspace as it was before the call.",
  "- Read the notes in parentheses at the end of run_code output: they list new files, saved figures, installed packages and problems.",
  "- The user's own open browser tabs are separate from /workspace: browser_tabs lists and switches them, browser_run runs JavaScript in one (needs the companion Chrome extension)."
].join("\n");

const userSettings = [
  { name: "corsProxy", label: "Personal CORS proxy (recommended)", description: "Makes downloads from websites that block browsers work reliably. Deploy the free companion Cloudflare Worker (worker/ folder of this plugin's repository) and enter https://<worker-name>.<account>.workers.dev/?key=<PROXY_KEY>&url= . Any proxy URL prefix, or a URL containing {url}, also works. Without it only a few public proxies are tried, and they often fail.", placeholder: "https://code-runner-proxy.example.workers.dev/?key=SECRET&url=", required: false },
  { name: "workspaceStore", label: "Workspace store (recommended)", description: "Carries large workspaces (charts, downloads, datasets) between calls privately. With the companion Worker enter https://<worker-name>.<account>.workers.dev/store?key=<PROXY_KEY> . Contract for other servers: POST the payload, respond with a read URL as plain text; GET returns it; DELETE removes it. Without it, files above the inline limit are not carried between calls unless public temporary stores are allowed below.", placeholder: "https://code-runner-proxy.example.workers.dev/store?key=SECRET", required: false },
  { name: "execTimeoutSec", label: "Run time limit (seconds)", description: "Default 120. Python, JavaScript, TypeScript and SQL runs are stopped after this long (the model can pass a different `timeout` per call, up to 900).", type: "number", required: false },
  { name: "stateCarry", label: "Persist workspace between calls", description: "Default on. TypingMind runs each call in a fresh sandbox, so /workspace (including the SQLite database) and JavaScript storage are carried forward inside the tool output. Set to \"off\" to disable.", placeholder: "on", required: false },
  { name: "stateLimitKB", label: "Inline workspace limit (KB)", description: "Default 24. A compressed workspace up to this size travels inside the tool output (it costs tokens); a larger one is offloaded to the workspace store.", type: "number", required: false },
  { name: "bigWorkspace", label: "Offload large workspaces", description: "Default on. Workspaces above the inline limit are uploaded to the workspace store and only a small pointer travels in the output. Set \"off\" to never upload; oversized files are then dropped between calls (the model is told which).", placeholder: "on", required: false },
  { name: "publicStores", label: "Allow public temporary stores", description: "Default off (private). When no workspace store is set, \"on\" lets large workspaces be uploaded to public temporary paste services (litterbox.catbox.moe, pastes.dev, dpaste.com; anyone with the link can read them until they expire). Keep off for private data.", placeholder: "off", required: false },
  { name: "publicProxies", label: "Allow public CORS proxies", description: "Default on. Requests to sites that block browsers are retried through public CORS proxies (never requests carrying keys, tokens or passwords). Set \"off\" for a private-only setup: only your personal proxy is used.", placeholder: "on", required: false },
  { name: "keepVariables", label: "Keep variables between calls", description: "Default on. Python and R variables, functions and imports, and DuckDB tables are saved with the workspace and restored in the next call. Set \"off\" to start every call with a clean interpreter (files still persist).", placeholder: "on", required: false },
  { name: "importAttachments", label: "Import attached files", description: "Default on. Files the user attaches to a message are saved to /workspace/uploads so code can read them. Set \"off\" to disable.", placeholder: "on", required: false },
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
  permissions: ["read_user_message"],
  dynamicContextEndpoints: [
    { id: "code-runner-usage-fa4fdbb3", name: "How to use Code Runner", source: "static", method: "GET", url: "", staticContent: USAGE_GUIDE, cacheDurationHours: 1, cacheRefreshPolicy: "REFRESH_NEVER" }
  ],
  pluginFunctions: [
    { id: "run-code-fn-fa4fdbb3", name: "run_code", implementationType: "javascript", openaiSpec: runCodeSpec, code, outputType: "respond_to_ai" },
    { id: "serve-file-fn-fa4fdbb3", name: "serve_file", implementationType: "javascript", openaiSpec: serveFileSpec, code, outputType: "render_markdown" },
    { id: "browser-run-fn-fa4fdbb3", name: "browser_run", implementationType: "javascript", openaiSpec: browserRunSpec, code, outputType: "respond_to_ai" },
    { id: "browser-tabs-fn-fa4fdbb3", name: "browser_tabs", implementationType: "javascript", openaiSpec: browserTabsSpec, code, outputType: "respond_to_ai" },
    { id: "preview-file-fn-fa4fdbb3", name: "preview_file", implementationType: "javascript", openaiSpec: previewFileSpec, code, outputType: "render_html" },
    { id: "manage-files-fn-fa4fdbb3", name: "manage_files", implementationType: "javascript", openaiSpec: manageFilesSpec, code, outputType: "respond_to_ai" }
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
console.log("wrote plugin.json (" + json.length + " bytes; descriptions " + plugin.pluginFunctions.map((f) => f.name + " " + f.openaiSpec.description.length).join(", ") +
  "; usage guide " + USAGE_GUIDE.length + " chars; " + LANGS.length + " languages)");
