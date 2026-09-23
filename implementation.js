// Code Runner - TypingMind plugin. Two entry points: run_code and serve_file.
//
// Execution model. TypingMind runs every call in a brand-new sandboxed iframe
// (opaque origin), so nothing survives in memory between calls. Python,
// JavaScript, TypeScript and SQL run inside a background Web Worker spawned
// from that iframe: a runaway loop can be stopped (the worker is terminated)
// without freezing the chat. When a Worker cannot be created the same engine
// runs in the iframe thread instead. Compiled languages run remotely on
// Compiler Explorer (Wandbox as fallback). /workspace, the SQLite database and
// JS `storage` travel between calls as a compressed [[cr-state:...]] trailer
// on the tool output (large ones are offloaded to a short-lived blob store).

// ---------------------------------------------------------------------------
// Runtime sources. CDNs are tried in order; the first that serves wins.
// ---------------------------------------------------------------------------
const PYODIDE_VERSION = "0.29.4";
const PYODIDE_CDNS = [
  { index: "https://cdn.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://fastly.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://gcore.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://testingcf.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" },
  { index: "https://unpkg.com/pyodide@" + PYODIDE_VERSION + "/",
    packages: "https://fastly.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/" }
];
const SQLJS_VERSION = "1.13.0";
const SQLJS_CDNS = [
  "https://cdn.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://fastly.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://unpkg.com/sql.js@" + SQLJS_VERSION + "/dist/",
  "https://gcore.jsdelivr.net/npm/sql.js@" + SQLJS_VERSION + "/dist/"
];
const BABEL_VERSION = "8.0.5";
const BABEL_CDNS = [
  "https://cdn.jsdelivr.net/npm/@babel/standalone@" + BABEL_VERSION + "/babel.min.js",
  "https://fastly.jsdelivr.net/npm/@babel/standalone@" + BABEL_VERSION + "/babel.min.js",
  "https://unpkg.com/@babel/standalone@" + BABEL_VERSION + "/babel.min.js"
];
// TypeScript 6 is the last release with a JavaScript compiler API (7 is native).
// It is only downloaded for `typecheck: true`.
const TS_VERSION = "6.0.3";
const TSC_CDNS = [
  "https://cdn.jsdelivr.net/npm/typescript@" + TS_VERSION + "/lib/",
  "https://fastly.jsdelivr.net/npm/typescript@" + TS_VERSION + "/lib/",
  "https://unpkg.com/typescript@" + TS_VERSION + "/lib/"
];
const TS_LIBS = ["lib.es2023.d.ts", "lib.webworker.d.ts", "lib.webworker.iterable.d.ts", "lib.webworker.asynciterable.d.ts"];
// Declarations of the globals a JavaScript/TypeScript run gets (see makeFs).
const TS_GLOBALS = [
  "interface CrStat { size: number; isDir: boolean; isFile: boolean; mtime: Date }",
  "type CrData = string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob | Response | object;",
  "declare const fs: {",
  "  readFile(path: string, encoding?: 'utf8' | 'utf-8' | 'text' | { encoding?: 'utf8' }): Promise<string>;",
  "  readFile(path: string, encoding: 'binary' | 'buffer' | 'bytes' | null | { encoding: null }): Promise<Uint8Array>;",
  "  readFile(path: string, encoding: 'base64'): Promise<string>;",
  "  readJSON<T = any>(path: string): Promise<T>;",
  "  writeFile(path: string, data: CrData): Promise<number>;",
  "  appendFile(path: string, data: CrData): Promise<number>;",
  "  exists(path: string): Promise<boolean>;",
  "  readdir(path?: string): Promise<string[]>;",
  "  mkdir(path: string): Promise<boolean>;",
  "  unlink(path: string): Promise<boolean>;",
  "  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<boolean>;",
  "  rename(from: string, to: string): Promise<boolean>;",
  "  copyFile(from: string, to: string): Promise<boolean>;",
  "  stat(path: string): Promise<CrStat>;",
  "  list(): Promise<{ path: string; size: number }[]>;",
  "  download(url: string, name?: string): Promise<{ path: string; size: number; contentType: string | null }>;",
  "};",
  "declare const storage: { get(key: string): any; set<T>(key: string, value: T): T; has(key: string): boolean; delete(key: string): boolean; keys(): string[]; clear(): void };",
  "declare const stdin: string;",
  "declare function sleep(ms: number): Promise<void>;",
  "declare function chart(rows: object[], options?: { x?: string; y?: string | string[]; kind?: 'line' | 'bar' | 'barh' | 'scatter' | 'point' | 'area' | 'pie' | 'donut' | 'histogram'; title?: string; path?: string; color?: string; bins?: number; height?: number; spec?: object }): Promise<string>;",
  "declare const tables: { get(name: string): Record<string, any>[]; set(name: string, rows: object[]): string; list(): string[] };",
  "declare const env: Readonly<Record<string, string>>;"
].join("\n");
const WEBR_VERSION = "0.6.0";
const WEBR_CDNS = [
  "https://webr.r-wasm.org/v" + WEBR_VERSION + "/",
  "https://cdn.jsdelivr.net/npm/webr@" + WEBR_VERSION + "/dist/"
];
const DUCKDB_VERSION = "1.32.0";
const DUCKDB_CDNS = [
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@" + DUCKDB_VERSION + "/+esm",
  "https://fastly.jsdelivr.net/npm/@duckdb/duckdb-wasm@" + DUCKDB_VERSION + "/+esm"
];
// Ruby 3.4 (ruby.wasm) with its standard library, and the WASI shim that gives
// it a /workspace directory.
const RUBY_CDNS = [
  { vm: "https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi@2.10.1/+esm", shim: "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/+esm",
    wasm: "https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@2.10.1/dist/ruby+stdlib.wasm" },
  { vm: "https://fastly.jsdelivr.net/npm/@ruby/wasm-wasi@2.10.1/+esm", shim: "https://fastly.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/+esm",
    wasm: "https://fastly.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@2.10.1/dist/ruby+stdlib.wasm" }
];

// chart() in python, javascript and r writes this page with the rows and
// options in place of __OPTS__; the Vega-Lite spec is built when the page is
// viewed (preview_file), so each language only serializes data and options.
const CHART_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/vega@5.30.0"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5.21.0"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6.26.0"></script>
<style>body{margin:0;padding:10px;font:14px system-ui,sans-serif;background:#fff}#c{width:100%}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}</style></head>
<body><div id="c"></div><script>
const o = __OPTS__;
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
let spec;
if (o.spec) { spec = o.spec; if (!spec.data) spec.data = { values: o.data || [] }; }
else {
  const rows = o.data || [];
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const x = o.x || keys[0];
  const first = (k) => { const r = rows.find((r) => r[k] !== null && r[k] !== undefined); return r ? r[k] : null; };
  const ys = [].concat(o.y || keys.filter((k) => k !== x && typeof first(k) === "number")).slice(0, 12);
  const type = (k) => { const v = first(k); if (typeof v === "number") return "quantitative"; if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/.test(v)) return "temporal"; return "nominal"; };
  const kind = String(o.kind || "line").toLowerCase();
  const mark = { line: "line", bar: "bar", barh: "bar", scatter: "point", point: "point", area: "area", pie: "arc", donut: "arc", histogram: "bar" }[kind] || kind;
  const multi = ys.length > 1, yField = multi ? "value" : ys[0], color = multi ? "series" : o.color;
  spec = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", width: "container", height: o.height || 360,
    data: { values: rows }, mark: { type: mark, tooltip: true } };
  if (o.title) spec.title = o.title;
  if (mark === "line" && rows.length <= 80) spec.mark.point = true;
  if (kind === "donut") spec.mark.innerRadius = 70;
  if (multi) spec.transform = [{ fold: ys, as: ["series", "value"] }];
  if (mark === "arc") spec.encoding = { theta: { field: yField, type: "quantitative", stack: true }, color: { field: x, type: "nominal" } };
  else if (kind === "histogram") spec.encoding = { x: { field: x, bin: { maxbins: o.bins || 30 }, type: "quantitative" }, y: { aggregate: "count", type: "quantitative" } };
  else {
    const X = { field: x, type: type(x), sort: null }, Y = { field: yField, type: "quantitative", title: multi ? null : yField };
    spec.encoding = kind === "barh" ? { y: X, x: Y } : { x: X, y: Y };
    if (color) spec.encoding.color = { field: color, type: "nominal" };
    if (mark !== "bar") spec.params = [{ name: "zoom", select: "interval", bind: "scales" }];
  }
}
vegaEmbed("#c", spec, { theme: dark ? "dark" : undefined, actions: { export: true, source: false, compiled: false, editor: false } })
  .catch((e) => { document.getElementById("c").textContent = "Chart error: " + e.message; });
</script></body></html>`;

// Helpers defined in every Python run: chart(), share_table()/get_table()/
// list_tables() and read_text(). Plain Python source (no JS escaping).
const PY_HELPERS = String.raw`
import os as _cr_os, sys as _cr_sys

def chart(data, x=None, y=None, kind='line', title='', path='chart.html', color=None, bins=None, spec=None, height=None):
    # Write an interactive chart page to /workspace/<path>; show it with preview_file.
    import json, math
    pd, np = _cr_sys.modules.get('pandas'), _cr_sys.modules.get('numpy')
    rows = data
    if pd is not None and isinstance(data, pd.Series):
        data = data.reset_index()
    if pd is not None and isinstance(data, pd.DataFrame):
        if not isinstance(data.index, pd.RangeIndex):
            data = data.reset_index()
        rows = json.loads(data.to_json(orient='records', date_format='iso'))
    elif isinstance(data, dict):
        if data and all(isinstance(v, (list, tuple)) for v in data.values()):
            keys = list(data)
            rows = [dict(zip(keys, vals)) for vals in zip(*data.values())]
        else:
            rows = [{'label': k, 'value': v} for k, v in data.items()]
            x = x or 'label'
            y = y or 'value'
    else:
        rows = [r if isinstance(r, dict) else {'x': i, 'y': r} for i, r in enumerate(list(rows))]
    def clean(v):
        if np is not None and isinstance(v, np.generic):
            v = v.item()
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v if v is None or isinstance(v, (int, float, str, bool)) else str(v)
    rows = [{str(k): clean(v) for k, v in r.items()} for r in rows[:50000]]
    opts = dict(data=rows, x=x, y=y, kind=kind, title=title, color=color, bins=bins, spec=spec, height=height)
    page = _CR_CHART_HTML.replace('__OPTS__', json.dumps(opts, default=str).replace('</', '<\\/'))
    full = _cr_os.path.join('/workspace', path)
    _cr_os.makedirs(_cr_os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(page)
    return path

def _cr_table_path(name):
    import re
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', str(name)):
        raise ValueError('table names use letters, digits and _')
    return '/workspace/.cr/tables/%s.csv' % name

def share_table(name, data):
    # Share a table with the other languages: a DuckDB view, get_table() in R/JS/Python.
    import csv
    p = _cr_table_path(name)
    _cr_os.makedirs(_cr_os.path.dirname(p), exist_ok=True)
    pd = _cr_sys.modules.get('pandas')
    if pd is not None and isinstance(data, (pd.DataFrame, pd.Series)):
        df = data.to_frame() if isinstance(data, pd.Series) else data
        df.to_csv(p, index=not isinstance(df.index, pd.RangeIndex))
        return name
    rows = list(data)
    with open(p, 'w', newline='', encoding='utf-8') as f:
        if rows and isinstance(rows[0], dict):
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        else:
            csv.writer(f).writerows(rows)
    return name

def list_tables():
    d = '/workspace/.cr/tables'
    return sorted(n[:-4] for n in _cr_os.listdir(d) if n.endswith('.csv')) if _cr_os.path.isdir(d) else []

def get_table(name):
    # A shared table: a pandas DataFrame when pandas is available, else a list of dicts.
    p = _cr_table_path(name)
    if not _cr_os.path.exists(p):
        raise FileNotFoundError('no shared table %r (shared tables: %s)' % (name, ', '.join(list_tables()) or 'none'))
    try:
        import pandas as pd
        return pd.read_csv(p)
    except ImportError:
        import csv
        with open(p, newline='', encoding='utf-8') as f:
            return list(csv.DictReader(f))

def read_text(path, max_chars=None):
    # Plain text of a PDF, DOCX, PPTX, XLSX, HTML or text file.
    ext = _cr_os.path.splitext(str(path))[1].lower()
    try:
        if ext == '.pdf':
            import pypdf
            t = '\n\n'.join((pg.extract_text() or '') for pg in pypdf.PdfReader(path).pages)
        elif ext == '.docx':
            import docx
            d = docx.Document(path)
            t = '\n'.join(p.text for p in d.paragraphs)
            for tb in d.tables:
                t += '\n' + '\n'.join('\t'.join(c.text for c in r.cells) for r in tb.rows)
        elif ext == '.pptx':
            from pptx import Presentation
            t = '\n\n'.join('--- slide %d ---\n' % (i + 1) + '\n'.join(sh.text_frame.text for sh in sl.shapes if sh.has_text_frame)
                            for i, sl in enumerate(Presentation(path).slides))
        elif ext in ('.xlsx', '.xlsm'):
            import openpyxl
            wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
            t = '\n\n'.join('--- sheet %s ---\n' % ws.title + '\n'.join('\t'.join('' if v is None else str(v) for v in r)
                            for r in ws.iter_rows(values_only=True)) for ws in wb.worksheets)
        elif ext in ('.html', '.htm'):
            from bs4 import BeautifulSoup
            with open(path, encoding='utf-8', errors='replace') as f:
                t = BeautifulSoup(f.read(), 'html.parser').get_text('\n')
        else:
            with open(path, encoding='utf-8', errors='replace') as f:
                t = f.read()
    except ModuleNotFoundError as e:
        pkg = {'pypdf': 'pypdf', 'docx': 'python-docx', 'pptx': 'python-pptx', 'openpyxl': 'openpyxl', 'bs4': 'beautifulsoup4'}.get(e.name, e.name)
        raise ModuleNotFoundError('read_text needs %s for %s files: pass packages: ["%s"]' % (pkg, ext, pkg)) from None
    return t[:max_chars] if max_chars else t
`;

// Helpers attached in every R run: chart(), share_table(), get_table(), list_tables().
const R_HELPERS = String.raw`local({
  e <- new.env()
  e$.cr_json1 <- function(v) {
    if (length(v) == 0 || (length(v) == 1 && is.na(v))) return("null")
    if (inherits(v, c("Date", "POSIXt"))) return(encodeString(format(v), quote = '"'))
    if (is.factor(v)) v <- as.character(v)
    if (is.logical(v)) return(tolower(as.character(v)))
    if (is.numeric(v)) return(if (is.finite(v)) format(v, digits = 15, scientific = FALSE, trim = TRUE) else "null")
    encodeString(as.character(v), quote = '"')
  }
  e$.cr_json_rows <- function(df) {
    df <- as.data.frame(df, stringsAsFactors = FALSE)
    if (!is.null(rownames(df)) && !identical(rownames(df), as.character(seq_len(nrow(df))))) df <- cbind(row = rownames(df), df)
    n <- min(nrow(df), 50000)
    keys <- encodeString(names(df), quote = '"')
    rows <- vapply(seq_len(n), function(i) paste0("{", paste0(keys, ":", vapply(df, function(col) e$.cr_json1(col[[i]]), ""), collapse = ","), "}"), "")
    paste0("[", paste(rows, collapse = ","), "]")
  }
  e$chart <- function(data, x = NULL, y = NULL, kind = "line", title = "", path = "chart.html", color = NULL, bins = NULL) {
    s <- function(v) if (is.null(v)) "null" else if (length(v) > 1) paste0("[", paste(encodeString(v, quote = '"'), collapse = ","), "]") else encodeString(as.character(v), quote = '"')
    opts <- paste0('{"data":', e$.cr_json_rows(data), ',"x":', s(x), ',"y":', s(y), ',"kind":', s(kind), ',"title":', s(title),
                   ',"color":', s(color), ',"bins":', if (is.null(bins)) "null" else bins, '}')
    page <- paste(readLines("/tmp/cr_chart.html", warn = FALSE), collapse = "\n")
    opts <- paste(strsplit(opts, "</", fixed = TRUE)[[1]], collapse = "<\\/")
    parts <- strsplit(page, "__OPTS__", fixed = TRUE)[[1]]
    page <- paste0(parts[1], opts, parts[2])
    if (dirname(path) != ".") dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
    writeLines(page, path)
    invisible(path)
  }
  e$.cr_table_path <- function(name) {
    if (!grepl("^[A-Za-z_][A-Za-z0-9_]*$", name)) stop("table names use letters, digits and _")
    file.path("/workspace/.cr/tables", paste0(name, ".csv"))
  }
  e$share_table <- function(name, data) {
    p <- e$.cr_table_path(name); dir.create(dirname(p), recursive = TRUE, showWarnings = FALSE)
    utils::write.csv(as.data.frame(data), p, row.names = FALSE); invisible(name)
  }
  e$list_tables <- function() sub("\\.csv$", "", list.files("/workspace/.cr/tables", pattern = "\\.csv$"))
  e$get_table <- function(name) {
    p <- e$.cr_table_path(name)
    if (!file.exists(p)) stop(sprintf("no shared table '%s' (shared tables: %s)", name, paste(e$list_tables(), collapse = ", ")))
    utils::read.csv(p, stringsAsFactors = FALSE, check.names = FALSE)
  }
  attach(e, name = "cr:helpers", warn.conflicts = FALSE)
})
`;

// Packages read_text() needs, installed when the code names such a file.
const READ_TEXT_PKGS = { pdf: "pypdf", docx: "python-docx", pptx: "python-pptx", xlsx: "openpyxl", xlsm: "openpyxl" };

const SCRIPT_TIMEOUT_MS  = 45000;
const RUNTIME_TIMEOUT_MS = 180000;   // wasm + stdlib download can be slow on mobile

const WORKDIR = "/workspace";
const DB_REL = "data.sqlite";
const PY_SESSION_REL = ".cr/session.pkl";   // saved Python variables, carried like any file
const UPLOADS_DIR = "uploads";              // files the user attached to their message
const TABLES_DIR = ".cr/tables";            // share_table(): CSV files every language can read
const SQL_ROWS_SHOWN = 500;
const OUTPUT_HEAD = 30000;           // characters of output kept from the start...
const OUTPUT_TAIL = 10000;           // ...and from the end, when a run prints more
const EXEC_TIMEOUT_S_DEFAULT = 120;
const STATE_LIMIT_KB_DEFAULT = 24;
const STATE_TTL_MIN_DEFAULT = 1440;
const MAX_CARRY_BYTES = 40 * 1024 * 1024;         // without a private store
const MAX_CARRY_BYTES_STORE = 150 * 1024 * 1024;  // with one: uploaded in parts
const MAX_STORE_PARTS = 8;
function maxCarry(cfg) { return cfg && cfg.workspaceStore && cfg.bigWorkspace ? MAX_CARRY_BYTES_STORE : MAX_CARRY_BYTES; }
const PRIVATE_STORE_MAX = 24 * 1024 * 1024;   // the companion Worker's limit (KV values are capped at 25 MB)
const SERVE_MAX_BYTES = 20 * 1024 * 1024;

// Temporary public stores for large workspaces, used only when no private
// workspace store is configured. Verified from a sandboxed (Origin: null) page
// 2026-09: CORS, byte-exact read-back, size limits.
const PUBLIC_BINS = [
  { kind: "litterbox", host: "https://litterbox.catbox.moe/resources/internals/api.php", max: 20 * 1024 * 1024, lifeMin: 1440 },
  { kind: "pastesdev", host: "https://api.pastes.dev/post", max: 2 * 1024 * 1024 },
  { kind: "dpaste",    host: "https://dpaste.com/api/v2/", max: 380 * 1024, lifeMin: 1440 }
];

// Import names that differ from their PyPI name, and pure-Python packages that
// are installed automatically (micropip) when code imports them. Packages that
// Pyodide ships (numpy, pandas, bs4, PIL, sklearn, cv2, ...) load on their own.
const PY_PIP_ALIASES = {
  yaml: "pyyaml", docx: "python-docx", pptx: "python-pptx", dateutil: "python-dateutil",
  dotenv: "python-dotenv", slugify: "python-slugify", jose: "python-jose",
  fpdf: "fpdf2", pypdf: "pypdf", PyPDF2: "PyPDF2", pdfminer: "pdfminer.six", docx2txt: "docx2txt",
  openpyxl: "openpyxl", xlsxwriter: "xlsxwriter", xlrd: "xlrd", odf: "odfpy", tabulate: "tabulate",
  markdown: "markdown", markdownify: "markdownify", html2text: "html2text", mammoth: "mammoth",
  xmltodict: "xmltodict", toml: "toml", tomli: "tomli", tomli_w: "tomli-w", json5: "json5",
  qrcode: "qrcode", faker: "faker", unidecode: "unidecode", emoji: "emoji", rich: "rich",
  tqdm: "tqdm", humanize: "humanize", feedparser: "feedparser", icalendar: "icalendar",
  ics: "ics", geopy: "geopy", folium: "folium", plotly: "plotly", seaborn: "seaborn",
  altair: "altair", textblob: "textblob", isodate: "isodate", babel: "babel", pint: "pint",
  sortedcontainers: "sortedcontainers", cachetools: "cachetools", attrs: "attrs", cattrs: "cattrs",
  jsonschema: "jsonschema", simplejson: "simplejson", chardet: "chardet", thefuzz: "thefuzz",
  rapidfuzz: "rapidfuzz", num2words: "num2words", langdetect: "langdetect", phonenumbers: "phonenumbers",
  pycountry: "pycountry", holidays: "holidays", croniter: "croniter", arrow: "arrow", pendulum: "pendulum",
  mpmath: "mpmath", bidict: "bidict", more_itertools: "more-itertools", toolz: "toolz",
  svgwrite: "svgwrite", reportlab: "reportlab", pdfplumber: "pdfplumber", extract_msg: "extract-msg",
  vobject: "vobject", pyparsing: "pyparsing"
};

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------
const LOCAL_LANGS = ["python", "javascript", "typescript", "sql", "duckdb", "r", "ruby"];

// Compiler Explorer (godbolt.org) runs these. `wb` names a Wandbox compiler to
// fall back to when Compiler Explorer is unreachable; `pick` finds a current
// compiler if the pinned id is retired. Verified with stdin 2026-09.
const CE_LANGS = {
  "c":       { id: "cg162",               lang: "c",       args: "-O1 -std=gnu17 -lm", wb: "gcc-13.2.0-c",   pick: /x86-64 gcc \d/ },
  "c++":     { id: "g162",                lang: "c++",     args: "-O1 -std=c++23",     wb: "gcc-13.2.0",     pick: /x86-64 gcc \d/ },
  "rust":    { id: "r1980",               lang: "rust",    args: "-C opt-level=1 --edition 2021", wb: "rust-1.82.0", pick: /^rustc \d/ },
  "go":      { id: "gl1260",              lang: "go",      args: "",                   wb: "go-1.23.2",      pick: /x86-64 gc \d/ },
  "java":    { id: "java2501",            lang: "java",    args: "",                   pick: /^jdk \d/, fix: "java" },
  "kotlin":  { id: "kotlinc2220",         lang: "kotlin",  args: "",                   pick: /^kotlinc \d/ },
  "csharp":  { id: "dotnet100csharpmono", lang: "csharp",  args: "",                   wb: "mono-6.12.0.199", pick: /\.NET \d.*Mono/ },
  "fsharp":  { id: "dotnet100fsharpmono", lang: "fsharp",  args: "",                   pick: /\.NET \d.*Mono/ },
  "swift":   { id: "swift633",            lang: "swift",   args: "",                   wb: "swift-6.0.1",    pick: /x86-64 swiftc \d/ },
  "zig":     { id: "z0160",               lang: "zig",     args: "",                   wb: "zig-0.13.0",     pick: /^zig \d/ },
  "d":       { id: "dmd21120",            lang: "d",       args: "",                   wb: "dmd-2.109.1",    pick: /dmd|ldc/ },
  "haskell": { id: "ghc9122",             lang: "haskell", args: "",                   wb: "ghc-9.10.1",     pick: /ghc \d/ },
  "ocaml":   { id: "ocaml5200",           lang: "ocaml",   args: "",                   wb: "ocaml-5.2.0",    pick: /ocamlopt \d/ },
  "perl":    { id: "perl5440",            lang: "perl",    args: "",                   wb: "perl-5.42.0",    pick: /^Perl \d/ },
  "lua":     { id: "lua550",              lang: "lua",     args: "",                   wb: "lua-5.4.7",      pick: /^Lua \d/ },
  "dart":    { id: "dart373",             lang: "dart",    args: "",                   pick: /^Dart \d/ },
  "fortran": { id: "gfortran162",         lang: "fortran", args: "",                   pick: /x86-64 gfortran \d/ },
  "pascal":  { id: "fpc322",              lang: "pascal",  args: "",                   wb: "fpc-3.2.2",      pick: /fpc \d/ },
  "crystal": { id: "crystal1203",         lang: "crystal", args: "",                   wb: "crystal-1.13.3", pick: /^Crystal \d/ },
  "julia":   { id: "julia_1_12_5",        lang: "julia",   args: "",                   wb: "julia-1.10.5",   pick: /^Julia \d/ },
  "cobol":   { id: "gnucobol32",          lang: "cobol",   args: "",                   pick: /GnuCOBOL \d/ },
  "ada":     { id: "gnat162",             lang: "ada",     args: "",                   pick: /x86-64 gnat \d/ },
  "objc":    { id: "objcg162",            lang: "objc",    args: "",                   pick: /x86-64 gcc \d/ }
};

// Ruby runs in the browser (ruby.wasm); Compiler Explorer runs it when a
// version or flags are asked for, or when ruby.wasm cannot load.
const RUBY_CE = { id: "ruby405", lang: "ruby", args: "", wb: "ruby-4.0.2", pick: /^Ruby \d/ };

// R runs in the browser (webR); Wandbox is its fallback when webR cannot load.
const R_WANDBOX = { compiler: "r-4.4.1", wbLang: "R" };

// Wandbox-only languages (best effort: a free public service).
const WB_LANGS = {
  "bash":   { compiler: "bash",          wbLang: "Bash script" },
  "php":    { compiler: "php-8.3.12",    wbLang: "PHP", fix: "php" },
  "scala":  { compiler: "scala-3.5.1",   wbLang: "Scala" },
  "nim":    { compiler: "nim-2.2.10",    wbLang: "Nim" },
  "elixir": { compiler: "elixir-1.17.3", wbLang: "Elixir" }
};

const ALL_LANGS = LOCAL_LANGS.concat(Object.keys(CE_LANGS), Object.keys(WB_LANGS));

const LANG_ALIASES = {
  py: "python", python3: "python", py3: "python", js: "javascript", node: "javascript", nodejs: "javascript",
  ts: "typescript", sqlite: "sql", sqlite3: "sql", cpp: "c++", cxx: "c++", cc: "c++", "c#": "csharp", cs: "csharp",
  "f#": "fsharp", fs: "fsharp", golang: "go", rs: "rust", kt: "kotlin", jl: "julia", rb: "ruby", pl: "perl",
  ml: "ocaml", hs: "haskell", sh: "bash", shell: "bash", zsh: "bash", "objective-c": "objc", objectivec: "objc",
  delphi: "pascal", rlang: "r", rscript: "r", ex: "elixir", exs: "elixir", c99: "c", c11: "c", c17: "c",
  duck: "duckdb", "duck-db": "duckdb"
};

function normalizeLanguage(l) {
  const k = String(l == null ? "" : l).trim().toLowerCase();
  if (ALL_LANGS.includes(k)) return k;
  return LANG_ALIASES[k] || null;
}

// ---------------------------------------------------------------------------
// Small shared helpers (also shipped into the worker)
// ---------------------------------------------------------------------------
function loadScript(src) {
  if (typeof document === "undefined") {
    // Web Worker (no DOM): importScripts is synchronous.
    if (typeof importScripts === "function") {
      try { importScripts(src); return Promise.resolve(); }
      catch (e) { return Promise.reject(new Error("Could not load " + src + ": " + (e.message || e))); }
    }
    return Promise.reject(new Error("No document or importScripts to load " + src));
  }
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => { s.remove(); rej(new Error("Could not load " + src)); };
    document.head.appendChild(s);
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + " timed out after " + ms / 1000 + " s")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function bytesToBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function hostOf(url) { try { return new URL(String(url)).host; } catch (e) { return ""; } }
function isAbort(e) { return !!e && (e.name === "AbortError" || e.name === "TimeoutError"); }

// ---------------------------------------------------------------------------
// Network. Requests go direct first. When the browser blocks one (CORS) or the
// host does not answer, the request is retried through: a known CORS-enabled
// mirror (GitHub files), the user's own proxy (plugin setting, e.g. the
// companion Cloudflare Worker), then public CORS proxies. Credentialed requests
// only ever go to the user's own proxy. A host that fails every path is
// remembered for a few minutes so later requests fail fast.
// ---------------------------------------------------------------------------

// Public proxies, re-verified 2026-09 from a sandboxed (Origin: null) page.
// Few survive; the first is the only one that reliably passed text and POST.
// `sync: false` marks proxies that may hang without answering: a synchronous
// XHR cannot be timed out on the page thread, so they are only raced from fetch.
const BUILTIN_PROXIES = [
  { u: "https://corsmirror.com/v1?url=",            enc: "q" },
  { u: "https://api.allorigins.win/raw?url=",       enc: "q", sync: false },
  { u: "https://api.codetabs.com/v1/proxy/?quest=", enc: "q", sync: false },
  { u: "https://api.cors.lol/?url=",                enc: "q" },
  { u: "https://cors.eu.org/",                      enc: "raw" },
  { u: "https://test.cors.workers.dev/?",           enc: "raw" }
];
const PROXY_PARALLEL = 3;
const DEAD_HOST_TTL_MS = 3 * 60 * 1000;
const XHR_SYNC_ROUTES_MAX = 5;  // sync XHR cannot be raced: mirror/personal proxy + a few public ones
// Headers, query parameters and body fields that look like credentials. A
// request carrying any of them is never sent through a public proxy.
const AUTH_HEADER = /^(authorization|proxy-authorization|cookie)$|(^|[-_])(api[-_]?key|apikey|token|secret|auth|password|passwd|signature|sig|session|subscription[-_]key|access[-_]key)([-_]|$)/i;
const SECRET_FIELD = /(^|[-_.])(api[-_]?key|apikey|key|token|secret|auth|password|passwd|pwd|signature|sig|session|client[-_]secret|access[-_]key|credential)s?$/i;

function fetchTimeoutMs() {
  const n = Number(globalThis.__crFetchTimeout);
  return n > 0 ? n : 30000;
}
function proxyTimeoutMs()  { return Math.min(fetchTimeoutMs(), 15000); }
function proxyPhaseMs()    { return Math.min(45000, 3 * proxyTimeoutMs()); }
function deadHostProbeMs() { return Math.min(fetchTimeoutMs(), 5000); }

function hostHealth() {
  if (!globalThis.__crHostHealth || typeof globalThis.__crHostHealth !== "object") globalThis.__crHostHealth = {};
  return globalThis.__crHostHealth;
}
function deadHost(host) {
  if (!host) return null;
  const h = hostHealth()[host];
  if (!h) return null;
  if (!(Date.now() - h.t < DEAD_HOST_TTL_MS)) { delete hostHealth()[host]; return null; }
  return h;
}
// k: "t" = the host never answered, "b" = it was blocked and the fallbacks failed too.
function markDead(host, why, k) { if (host) hostHealth()[host] = { t: Date.now(), why, k: k || "t" }; netNote(host, why); }
function markAlive(host) { if (host && hostHealth()[host]) delete hostHealth()[host]; }
function netNote(host, why) {
  if (!globalThis.__crNetLog) globalThis.__crNetLog = new Map();
  if (host && !globalThis.__crNetLog.has(host)) globalThis.__crNetLog.set(host, why);
}
function netError(host, why, cause) {
  const e = new TypeError("Could not reach " + (host || "host") + ": " + why);
  if (cause) e.cause = cause;
  return e;
}
// The personal proxy answered with its own error (not the target's): say so
// plainly instead of silently falling back to public proxies.
function noteProxyRejected(status, errHeader) {
  const host = hostOf(globalThis.__crCorsProxy) || "personal proxy";
  if (errHeader === "bad-key" || status === 401) {
    netNote(host, "your personal CORS proxy rejected the key (HTTP " + status + "). Fix the key in the plugin settings (Personal CORS proxy)");
  } else if (status >= 500 || status === 404 || status === 405) {
    netNote(host, "your personal CORS proxy returned HTTP " + status + " - check that the Worker is deployed and the setting ends with ?key=<KEY>&url=");
  }
}

function hostHealthSnapshot() {
  const out = {}, hh = hostHealth();
  for (const host of Object.keys(hh)) if (deadHost(host)) out[host] = hh[host];
  return Object.keys(out).length ? out : null;
}
function mergeHosts(hosts) {
  if (!hosts || typeof hosts !== "object") return;
  const hh = hostHealth();
  for (const [host, rec] of Object.entries(hosts)) {
    if (rec && typeof rec.t === "number" && Date.now() - rec.t < DEAD_HOST_TTL_MS) {
      hh[host] = { t: rec.t, why: String(rec.why || "unreachable"), k: rec.k === "b" ? "b" : "t" };
    }
  }
}

function applyProxy(spec, url) {
  if (spec.u.includes("{url}")) return spec.u.replace("{url}", encodeURIComponent(url));
  return spec.u + (spec.enc === "raw" ? url : encodeURIComponent(url));
}

// CORS-enabled mirrors for hosts that block browsers.
function mirrorUrl(url) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(url);
  if (m) return "https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3];
  return null;
}

// Ordered fallback candidates for a URL that failed directly.
function proxyCandidates(url, opts) {
  if (!/^https?:\/\//i.test(url)) return [];
  const credentialed = !!(opts && opts.credentialed);
  const list = [];
  const mirror = mirrorUrl(url);
  if (mirror && !credentialed) list.push({ url: mirror, mirror: true });
  const custom = globalThis.__crCorsProxy;
  if (custom) list.push({ url: applyProxy({ u: custom, enc: "q" }, url), trusted: true });
  if (credentialed || globalThis.__crNoPublicProxies) return list;
  const pub = BUILTIN_PROXIES.filter((s) => !(opts && opts.sync && s.sync === false));
  return list.concat(pub.map((s) => ({ url: applyProxy(s, url) })));
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

function carriesCredentials(input, init) {
  if (init && init.credentials === "include") return true;
  const scan = (h) => {
    if (!h) return false;
    if (typeof h.forEach === "function" && !Array.isArray(h)) { let hit = false; h.forEach((v, k) => { if (AUTH_HEADER.test(k)) hit = true; }); return hit; }
    if (Array.isArray(h)) return h.some(([k]) => AUTH_HEADER.test(k));
    return Object.keys(h).some((k) => AUTH_HEADER.test(k));
  };
  if (init && scan(init.headers)) return true;
  if (input && typeof input === "object" && input.headers && scan(input.headers)) return true;
  return urlCarriesSecret(requestUrl(input)) || bodyCarriesSecret(init && init.body) || containsSecretValue(input, init);
}

// Any configured secret value in the URL, a header or a text body.
function containsSecretValue(input, init) {
  const vals = [].concat(...Object.values(globalThis.__crSecrets || {}).filter((v) => typeof v === "string" && v.length >= 6).map(secretForms));
  if (!vals.length) return false;
  const parts = [requestUrl(input)];
  try { parts.push(decodeURIComponent(requestUrl(input))); } catch (e) {}
  const addHeaders = (h) => {
    if (!h) return;
    if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach((v) => parts.push(String(v)));
    else if (Array.isArray(h)) h.forEach(([, v]) => parts.push(String(v)));
    else Object.values(h).forEach((v) => parts.push(String(v)));
  };
  addHeaders(init && init.headers);
  if (input && typeof input === "object") addHeaders(input.headers);
  const b = init && init.body;
  if (typeof b === "string") parts.push(b);
  else if (b && (b instanceof ArrayBuffer || ArrayBuffer.isView(b))) parts.push(new TextDecoder().decode(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
  else if (typeof URLSearchParams === "function" && b instanceof URLSearchParams) parts.push(b.toString());
  const all = parts.join("\n");
  return vals.some((v) => all.includes(v));
}

// user:pass@host, or a query parameter named like a key/token (?api_key=, ?token=, ?key=).
function urlCarriesSecret(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (u.username || u.password) return true;
  for (const k of u.searchParams.keys()) if (SECRET_FIELD.test(k)) return true;
  return false;
}

// A form or JSON body with a field named like a key/token/password.
function bodyCarriesSecret(body) {
  if (body == null) return false;
  let text = null;
  if (typeof body === "string") text = body;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    // Bytes (a materialized Request body, or a typed array): scan them as text.
    const u8 = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    text = new TextDecoder().decode(u8.subarray(0, 1048576));
  }
  // Bodies that cannot be read synchronously are never sent to public proxies.
  else if ((typeof Blob === "function" && body instanceof Blob) || (typeof ReadableStream === "function" && body instanceof ReadableStream)) return true;
  else if (typeof URLSearchParams === "function" && body instanceof URLSearchParams) text = body.toString();
  else if (typeof FormData === "function" && body instanceof FormData) {
    for (const k of body.keys()) if (SECRET_FIELD.test(k)) return true;
    return false;
  }
  if (text == null) return false;
  if (/"(?:[\w.-]*[-_.])?(?:api[-_]?key|apikey|key|token|secret|password|passwd|auth|signature|client[-_]secret|access[-_]key|credentials?)"\s*:/i.test(text)) return true;
  try { for (const k of new URLSearchParams(text).keys()) if (SECRET_FIELD.test(k)) return true; } catch (e) {}
  return false;
}

// fetch with an AbortController timeout, linked to a caller-supplied signal.
// urllib3 (behind Python requests) always passes a signal, so the cap must
// apply on top of it or a silent host hangs the run.
async function timedFetch(real, input, init, ms) {
  init = init || {};
  if (typeof AbortController !== "function") return real(input, init);
  const ac = new AbortController(), parent = init.signal;
  const onAbort = () => ac.abort();
  if (parent) { if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort); }
  const t = setTimeout(onAbort, ms || fetchTimeoutMs());
  try { return await real(input, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); if (parent) parent.removeEventListener("abort", onAbort); }
}

// One fallback hop with its own timeout. Resolves {r} when usable, else null.
// A trusted proxy (the user's own) passes the target's real status through
// (marked X-CR-Proxy), so a 404 from the target is returned as a 404.
function proxyHop(real, cand, init, ms, stats) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const parent = init.signal;
  const onAbort = () => ac && ac.abort();
  if (parent && ac) { if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort); }
  const t = setTimeout(onAbort, ms);
  let won = false;
  const cleanup = () => { clearTimeout(t); if (!won && parent && ac) parent.removeEventListener("abort", onAbort); };
  stats.tried++;
  const promise = Promise.resolve()
    .then(() => real(cand.url, ac ? { ...init, signal: ac.signal } : init))
    .then((r) => {
      const passthrough = cand.trusted && r && r.headers && typeof r.headers.get === "function" && r.headers.get("x-cr-proxy");
      if (r && (passthrough || (r.status >= 200 && r.status < 300))) { won = true; return { r }; }
      if (cand.trusted && r) noteProxyRejected(r.status, r.headers && typeof r.headers.get === "function" ? r.headers.get("x-cr-error") : null);
      stats.http++;
      return null;
    }, (e) => { if (isAbort(e)) stats.timeouts++; else stats.errors++; return null; })
    .finally(cleanup);
  return { promise, abort: onAbort };
}

// Race candidates PROXY_PARALLEL at a time; first usable response wins. The
// phase budget is a hard deadline. Non-idempotent requests go one at a time
// so the target never receives the same write twice.
async function raceProxies(real, cands, init, stats, budgetMs) {
  const deadline = Date.now() + (budgetMs || proxyPhaseMs());
  const width = /^(get|head)$/i.test(init.method || "GET") ? PROXY_PARALLEL : 1;
  for (let i = 0; i < cands.length; i += width) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || (init.signal && init.signal.aborted)) { stats.skipped += cands.length - i; break; }
    const hops = cands.slice(i, i + width).map((c) => proxyHop(real, c, init, Math.min(proxyTimeoutMs(), remaining), stats));
    const win = await new Promise((resolve) => {
      let pending = hops.length;
      hops.forEach((h) => h.promise.then((v) => { if (v) resolve({ hop: h, r: v.r }); else if (--pending === 0) resolve(null); }));
    });
    if (win) { for (const h of hops) if (h !== win.hop) h.abort(); return win.r; }
  }
  return null;
}

function describeStats(stats) {
  const parts = [];
  if (stats.timeouts) parts.push(stats.timeouts + " timed out");
  if (stats.http) parts.push(stats.http + " refused");
  if (stats.errors) parts.push(stats.errors + " failed");
  if (stats.skipped) parts.push(stats.skipped + " skipped (time budget spent)");
  return parts.join(", ") || "none answered";
}

async function fetchDirectThenProxies(real, input, init) {
  const url = requestUrl(input);
  init = init || {};
  if (typeof Request === "function" && input instanceof Request) {
    // A Request body can be read only once: materialize it so retries can resend it.
    const extra = {};
    if (!init.method) extra.method = input.method;
    if (!init.headers) extra.headers = input.headers;
    if (!init.signal && input.signal) extra.signal = input.signal;
    if (init.body === undefined && !/^(GET|HEAD)$/i.test(input.method)) {
      try { extra.body = await input.clone().arrayBuffer(); } catch (e) {}
    }
    init = { ...extra, ...init };
    input = url;
  }
  const credentialed = carriesCredentials(input, init);
  const host = hostOf(url);
  const newStats = () => ({ tried: 0, timeouts: 0, http: 0, errors: 0, skipped: 0 });

  const dead = deadHost(host);
  if (dead) {
    // Known-bad host: one short direct probe; a blocked (not silent) host also
    // gets one short fallback wave. Anything answering clears the memo.
    let probeErr;
    try { const r = await timedFetch(real, input, init, deadHostProbeMs()); markAlive(host); return r; }
    catch (e) { probeErr = e; }
    if (init.signal && init.signal.aborted) throw probeErr;
    if (dead.k === "b") {
      const cands = proxyCandidates(url, { credentialed }).slice(0, PROXY_PARALLEL);
      const r = cands.length && await raceProxies(real, cands, init, newStats(), deadHostProbeMs());
      if (r) { markAlive(host); return r; }
      if (init.signal && init.signal.aborted) throw probeErr;
    }
    const left = Math.max(1, Math.ceil((DEAD_HOST_TTL_MS - (Date.now() - dead.t)) / 60000));
    const why = "still unreachable (" + dead.why + "). Requests to it fail fast for ~" + left + " more min - use a different source.";
    netNote(host, why);
    throw netError(host, why, probeErr);
  }

  let e1;
  try { return await timedFetch(real, input, init); } catch (e) { e1 = e; }
  if (init.signal && init.signal.aborted) throw e1;   // the caller's own deadline
  const timedOut = isAbort(e1);
  const cands = proxyCandidates(url, { credentialed });
  // A browser-blocked request fails the same way twice; retry directly only
  // when there is no fallback route to try instead.
  if (!timedOut && !cands.length) { try { return await timedFetch(real, input, init); } catch (e) { e1 = e; } }

  const streamBody = typeof ReadableStream === "function" && init.body instanceof ReadableStream;
  const direct = timedOut ? "no response within " + (fetchTimeoutMs() / 1000) + " s"
                          : "the browser blocked it (the site does not allow cross-origin access, or it is unreachable)";
  if (streamBody || !cands.length) {
    let why = direct;
    if (credentialed && !globalThis.__crCorsProxy) {
      why += "; requests carrying credentials (Authorization/API-key/cookie headers, or key/token/password fields in the URL or body) are never sent through public proxies - use an API endpoint that allows browser (CORS) access, or set a personal CORS proxy in the plugin settings";
    }
    netNote(host, why);
    throw netError(host, why, e1);
  }

  const st = newStats();
  // The user's own proxy and GitHub mirrors first, one at a time (reliable, may be large).
  // Some sites refuse requests coming from cloud providers: a 403/429/503 through the
  // personal proxy is kept while the public proxies get a chance (reads only), and
  // returned if none of them does better.
  const idempotent = /^(GET|HEAD)$/i.test(init.method || "GET");
  let held = null;
  for (const cand of cands.filter((c) => c.trusted || c.mirror)) {
    const v = await proxyHop(real, cand, init, fetchTimeoutMs(), st).promise;
    if (v) {
      if (cand.trusted && idempotent && [403, 429, 503].includes(v.r.status)) { held = held || v.r; continue; }
      return v.r;
    }
    if (init.signal && init.signal.aborted) throw e1;
  }
  const publicCands = cands.filter((c) => !c.trusted && !c.mirror);
  const r = publicCands.length ? await raceProxies(real, publicCands, init, st) : null;
  if (r) return r;
  if (held) return held;
  if (init.signal && init.signal.aborted) throw e1;
  const why = direct + ", and " + st.tried + " fallback route" + (st.tried === 1 ? "" : "s") + " failed (" + describeStats(st) + ")";
  markDead(host, why, timedOut ? "t" : "b");
  throw netError(host, why, e1);
}

async function netFetch(input, init) {
  const real = globalThis.__crRealFetch || fetch;
  return fetchDirectThenProxies(real, input, init);
}

// Patch fetch/XHR so Python (requests, urllib, pyfetch) and JavaScript get the
// fallback behaviour. On the iframe thread the patch is only active while a run
// executes, so the host page's own traffic is never touched.
function patchFetch() {
  if (globalThis.__crFetchPatched || typeof globalThis.fetch !== "function") return;
  // Bound to the real global object: in the worker `globalThis` is a private shadow.
  const real = globalThis.fetch.bind(typeof self !== "undefined" ? self : globalThis);
  globalThis.__crRealFetch = real;
  globalThis.fetch = function (input, init) {
    if (!globalThis.__crRunning) return real(input, init);
    return fetchDirectThenProxies(real, input, init);
  };
  globalThis.__crFetchPatched = true;
}

function patchXHR() {
  const X = globalThis.XMLHttpRequest;
  if (!X || X.prototype.__crPatched) return;
  const P = X.prototype, open = P.open, send = P.send, setHeader = P.setRequestHeader, overrideMime = P.overrideMimeType;
  P.open = function (method, url, async, user, pw) {
    this.__cr = { method, url: String(url), sync: async === false, headers: [], user, pw, mime: null };
    return open.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    if (this.__cr) this.__cr.headers.push([k, v]);
    return setHeader.call(this, k, v);
  };
  if (overrideMime) {
    P.overrideMimeType = function (m) {
      if (this.__cr) this.__cr.mime = m;
      return overrideMime.call(this, m);
    };
  }
  P.send = function (body) {
    const r = this.__cr;
    if (!r || !r.sync || !globalThis.__crRunning) return send.call(this, body);
    const host = hostOf(r.url), dead = deadHost(host);
    let err = null;
    try { send.call(this, body); } catch (e) { err = e; }
    if (!err && this.status !== 0) { markAlive(host); return; }   // direct request answered
    if (dead) {
      const why = "still unreachable (" + dead.why + ") - use a different source.";
      netNote(host, why);
      throw netError(host, why, err);
    }
    const credentialed = r.headers.some(([k]) => AUTH_HEADER.test(k)) || !!this.withCredentials ||
      urlCarriesSecret(r.url) || bodyCarriesSecret(body) || containsSecretValue(r.url, { headers: r.headers, body });
    let responseType = "";
    try { responseType = this.responseType; } catch (e) {}
    const cands = proxyCandidates(r.url, { credentialed, sync: true }).slice(0, XHR_SYNC_ROUTES_MAX);
    for (const cand of cands) {
      try {
        open.call(this, r.method, cand.url, false, r.user, r.pw);
        for (const [k, v] of r.headers) setHeader.call(this, k, v);
        if (r.mime && overrideMime) overrideMime.call(this, r.mime);
        if (responseType) { try { this.responseType = responseType; } catch (e) {} }
        send.call(this, body);
        const passthrough = cand.trusted && typeof this.getResponseHeader === "function" && this.getResponseHeader("x-cr-proxy");
        if (passthrough || (this.status >= 200 && this.status < 300)) return;
        if (cand.trusted) noteProxyRejected(this.status, typeof this.getResponseHeader === "function" ? this.getResponseHeader("x-cr-error") : null);
      } catch (e) { err = e; }
    }
    const why = "the browser blocked it" + (cands.length ? " and " + cands.length + " fallback routes failed" : "") +
      (credentialed && !globalThis.__crCorsProxy ? "; credentialed requests are never sent through public proxies" : "");
    if (cands.length) markDead(host, why, "b"); else netNote(host, why);
    throw netError(host, why, err);
  };
  P.__crPatched = true;
}

// ---------------------------------------------------------------------------
// Execution engine. Runs inside the worker (or in-thread as a fallback). It
// owns /workspace: an in-memory file map until Python starts, then Pyodide's
// MEMFS. Everything it uses is inside this function or shipped via
// SHARED_FUNCTIONS / workerConstants() below.
// ---------------------------------------------------------------------------
function crEngine(post, env) {
  const G = globalThis;
  const files = new Map();                 // abs path -> Uint8Array (before Python)
  const dirs = new Set(["/workspace", "/tmp"]);
  const kv = new Map();
  let cfg = {};
  let py = null, pyLoading = null, pyHttpOk = true, sqlLib = null, babelLib = null, tscLib = null;
  let runId = 0, headLen = 0, tail = "", dropped = 0, lastTailPost = 0;

  // ----- output ---------------------------------------------------------------
  function resetOutput(id) { runId = id; headLen = 0; tail = ""; dropped = 0; lastTailPost = 0; }
  function emit(s) {
    s = String(s);
    if (!s) return;
    if (headLen < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - headLen;
      const part = s.length <= room ? s : s.slice(0, room);
      headLen += part.length;
      post({ id: runId, ev: "out", s: part });
      if (s.length <= room) return;
      s = s.slice(room);
    }
    dropped += s.length;
    tail = (tail + s).slice(-OUTPUT_TAIL);
    if (dropped - lastTailPost > 4000) { lastTailPost = dropped; post({ id: runId, ev: "tail", s: tail, dropped }); }
  }

  // ----- workspace --------------------------------------------------------------
  function norm(p) {
    p = String(p == null ? "" : p).trim();
    if (!p || p === ".") p = WORKDIR;
    if (!p.startsWith("/")) p = WORKDIR + "/" + p;
    const parts = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    return "/" + parts.join("/");
  }
  const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  function enoent(p) { const e = new Error("ENOENT: no such file or directory: " + p); e.code = "ENOENT"; return e; }
  function fsCall(fn, p) {
    try { return fn(); }
    catch (e) {
      if (e && (e.errno === 44 || e.code === "ENOENT")) throw enoent(p);
      if (e && (e.errno === 31 || e.errno === 54)) { const x = new Error("EISDIR/ENOTDIR: " + p); x.code = "EISDIR"; throw x; }
      if (e && e.errno === 55) { const x = new Error("ENOTEMPTY: directory not empty: " + p); x.code = "ENOTEMPTY"; throw x; }
      throw e;
    }
  }
  function isDirMap(p) {
    if (dirs.has(p)) return true;
    const pre = p + "/";
    for (const k of files.keys()) if (k.startsWith(pre)) return true;
    return false;
  }
  function wsExists(p) {
    p = norm(p);
    if (py) return py.FS.analyzePath(p).exists;
    return files.has(p) || isDirMap(p);
  }
  function wsIsDir(p) {
    p = norm(p);
    if (py) { const a = py.FS.analyzePath(p); return !!(a.exists && a.object && py.FS.isDir(a.object.mode)); }
    return !files.has(p) && isDirMap(p);
  }
  function wsRead(p) {
    p = norm(p);
    if (py) {
      if (wsIsDir(p)) { const e = new Error("EISDIR: is a directory: " + p); e.code = "EISDIR"; throw e; }
      return fsCall(() => py.FS.readFile(p), p);
    }
    if (!files.has(p)) throw enoent(p);
    return files.get(p);
  }
  function wsWrite(p, bytes) {
    p = norm(p);
    if (py) { py.FS.mkdirTree(dirname(p)); return fsCall(() => py.FS.writeFile(p, bytes), p); }
    files.set(p, bytes);
    let d = dirname(p);
    while (d && d !== "/") { dirs.add(d); d = dirname(d); }
  }
  function wsMkdir(p) {
    p = norm(p);
    if (py) return py.FS.mkdirTree(p);
    while (p && p !== "/") { dirs.add(p); p = dirname(p); }
  }
  function wsReaddir(p) {
    p = norm(p);
    if (py) return fsCall(() => py.FS.readdir(p), p).filter((n) => n !== "." && n !== "..").sort();
    if (!isDirMap(p)) throw enoent(p);
    const pre = p === "/" ? "/" : p + "/", names = new Set();
    for (const k of [...files.keys(), ...dirs]) if (k.startsWith(pre) && k.length > pre.length) names.add(k.slice(pre.length).split("/")[0]);
    return [...names].sort();
  }
  function wsStat(p) {
    p = norm(p);
    if (py) {
      const s = fsCall(() => py.FS.stat(p), p);
      return { size: s.size, isDir: py.FS.isDir(s.mode), isFile: !py.FS.isDir(s.mode), mtime: new Date(s.mtime) };
    }
    if (files.has(p)) return { size: files.get(p).length, isDir: false, isFile: true, mtime: new Date() };
    if (isDirMap(p)) return { size: 0, isDir: true, isFile: false, mtime: new Date() };
    throw enoent(p);
  }
  function wsRemove(p, recursive) {
    p = norm(p);
    if (py) {
      if (!wsExists(p)) throw enoent(p);
      if (wsIsDir(p)) {
        if (recursive) for (const n of wsReaddir(p)) wsRemove(p + "/" + n, true);
        return fsCall(() => py.FS.rmdir(p), p);
      }
      return fsCall(() => py.FS.unlink(p), p);
    }
    if (files.delete(p)) return;
    if (!isDirMap(p)) throw enoent(p);
    const pre = p + "/";
    const children = [...files.keys()].filter((k) => k.startsWith(pre));
    if (children.length && !recursive) { const e = new Error("ENOTEMPTY: directory not empty: " + p); e.code = "ENOTEMPTY"; throw e; }
    for (const k of children) files.delete(k);
    for (const d of [...dirs]) if (d === p || d.startsWith(pre)) dirs.delete(d);
  }
  function wsRename(a, b) {
    a = norm(a); b = norm(b);
    if (py) { py.FS.mkdirTree(dirname(b)); return fsCall(() => py.FS.rename(a, b), a); }
    if (files.has(a)) { wsWrite(b, files.get(a)); files.delete(a); return; }
    if (!isDirMap(a)) throw enoent(a);
    const pre = a + "/";
    for (const k of [...files.keys()]) if (k.startsWith(pre)) { wsWrite(b + k.slice(a.length), files.get(k)); files.delete(k); }
    for (const d of [...dirs]) if (d === a || d.startsWith(pre)) { dirs.delete(d); dirs.add(b + d.slice(a.length)); }
  }
  // Every file under /workspace as [relative path, bytes].
  function wsWalk() {
    const out = [];
    if (py) {
      const walk = (dir) => {
        if (!py.FS.analyzePath(dir).exists) return;
        for (const name of py.FS.readdir(dir)) {
          if (name === "." || name === "..") continue;
          const p = dir + "/" + name, st = py.FS.stat(p);
          if (py.FS.isDir(st.mode)) walk(p);
          else if (py.FS.isFile(st.mode)) out.push([p.slice(WORKDIR.length + 1), py.FS.readFile(p)]);
        }
      };
      walk(WORKDIR);
    } else {
      for (const [p, b] of files) if (p.startsWith(WORKDIR + "/")) out.push([p.slice(WORKDIR.length + 1), b]);
    }
    return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  }
  function listingNote() {
    let rows = [];
    try { rows = wsWalk().map(([p, b]) => p + " (" + (b.length < 1024 ? b.length + " B" : Math.ceil(b.length / 1024) + " KB") + ")"); } catch (e) {}
    if (!rows.length) return "/workspace is empty: the file was never written. Check that the step that should have created it actually succeeded.";
    const shown = rows.slice(0, 40);
    return "/workspace contains " + rows.length + " file" + (rows.length === 1 ? "" : "s") + ": " + shown.join(", ") + (rows.length > shown.length ? ", ..." : "");
  }

  // ----- Python -------------------------------------------------------------------
  const PY_SETUP = [
    "import os, sys, warnings",
    "os.environ.setdefault('MPLBACKEND', 'Agg')",
    "warnings.filterwarnings('ignore', message='.*non-interactive.*')",
    "warnings.filterwarnings('ignore', message='.*Matplotlib is currently using agg.*')",
    "def _cr_missing(names):",
    "    import importlib.util",
    "    out = []",
    "    for n in names:",
    "        try:",
    "            if importlib.util.find_spec(n) is None: out.append(n)",
    "        except Exception:",
    "            out.append(n)",
    "    return out",
    "def _cr_save_figures():",
    "    m = sys.modules.get('matplotlib.pyplot')",
    "    if m is None: return []",
    "    saved = []",
    "    for num in m.get_fignums():",
    "        name = 'figure_%d.png' % num",
    "        try:",
    "            m.figure(num).savefig(os.path.join('/workspace', name), dpi=110, bbox_inches='tight')",
    "            saved.append(name)",
    "        except Exception:",
    "            pass",
    "    m.close('all')",
    "    return saved",
    // Variables survive between calls: data is pickled, imports are recorded by
    // module name, and top-level functions/classes by their source (registered
    // in linecache under the name the code ran as). Restored before the next run.
    "import linecache as _cr_lc",
    "_CR_SRC = {}",
    "def _cr_register(src, fn='<code>'):",
    "    _cr_lc.cache[fn] = (len(src), None, [l + '\\n' for l in src.split('\\n')], fn)",
    "def _cr_def_source(name, v):",
    "    import inspect, re",
    "    if inspect.isfunction(v):",
    "        fn, start = v.__code__.co_filename, v.__code__.co_firstlineno",
    "    else:",
    "        fn, start = _CR_SRC.get(name, '<code>'), getattr(v, '__firstlineno__', None)",
    "    entry = _cr_lc.cache.get(fn)",
    "    if not entry or len(entry) < 3: return None",
    "    lines = entry[2]",
    "    if not start:",
    "        hits = [i for i, l in enumerate(lines) if re.match(r'class\\s+%s\\b' % re.escape(name), l)]",
    "        if not hits: return None",
    "        start = hits[-1] + 1",
    "    if start - 1 >= len(lines): return None",
    "    first = lines[start - 1]",
    "    if first[:1] in (' ', '\\t'): return None",
    "    if getattr(v, '__name__', '') == '<lambda>':",
    "        return first if re.match(r'%s\\s*=\\s*lambda\\b' % re.escape(name), first) else None",
    "    if getattr(v, '__name__', None) != name: return None",
    "    return ''.join(inspect.getblock(lines[start - 1:]))",
    "def _cr_resource(v):",
    "    import inspect, io",
    "    if inspect.isgenerator(v) or inspect.iscoroutine(v) or inspect.isasyncgen(v) or isinstance(v, io.IOBase): return True",
    "    m = getattr(type(v), '__module__', '') or ''",
    "    return m.split('.')[0] in ('sqlite3', '_sqlite3', 'socket', '_thread', 'threading', 'pyodide', '_pyodide', 'js', 'zipfile', 'tarfile')",
    "def _cr_session_save(path, limit, secrets=()):",
    "    import pickle, types, inspect, os",
    "    g = globals()",
    "    imports, defs, data, mods, skipped = {}, [], {}, set(), []",
    "    for name in list(g):",
    "        if name.startswith('_') or name in _CR_BASE: continue",
    "        v = g[name]",
    "        try:",
    "            if isinstance(v, types.ModuleType):",
    "                imports[name] = v.__name__; mods.add(v.__name__.split('.')[0]); continue",
    "            if (inspect.isfunction(v) or inspect.isclass(v)) and getattr(v, '__module__', None) == '__main__':",
    "                src = _cr_def_source(name, v)",
    "                if src: defs.append((name, src))",
    "                else: skipped.append(name)",
    "                continue",
    "            if _cr_resource(v): continue",
    "            b = pickle.dumps(v, protocol=4)",
    "            if any(sec and sec.encode('utf-8') in b for sec in secrets): continue",
    "            data[name] = b",
    "            m = (getattr(type(v), '__module__', '') or '').split('.')[0]",
    "            if m and m not in ('builtins', '__main__'): mods.add(m)",
    "        except Exception:",
    "            skipped.append(name)",
    // Keep the smallest values that fit the budget; name the ones left out.
    "    used, kept = 0, {}",
    "    for name, b in sorted(data.items(), key=lambda kv: len(kv[1])):",
    "        if used + len(b) <= limit: kept[name] = b; used += len(b)",
    "        else: skipped.append('%s (%d KB, too large)' % (name, (len(b) + 1023) // 1024))",
    "    data = kept",
    "    if not (imports or defs or data):",
    "        try: os.remove(path)",
    "        except OSError: pass",
    "        return skipped",
    "    os.makedirs(os.path.dirname(path), exist_ok=True)",
    "    with open(path, 'wb') as f:",
    "        pickle.dump({'v': 1, 'imports': imports, 'defs': defs, 'data': data, 'mods': sorted(mods)}, f, protocol=4)",
    "    return skipped",
    "def _cr_session_mods(path):",
    "    import pickle, os",
    "    try:",
    "        with open(path, 'rb') as f: return list(pickle.load(f).get('mods', []))",
    "    except Exception: return []",
    "async def _cr_session_restore(path):",
    "    import pickle, os, importlib",
    "    if not os.path.exists(path): return [[], []]",
    "    try:",
    "        with open(path, 'rb') as f: s = pickle.load(f)",
    "    except Exception:",
    "        return [[], ['(all: the saved variables could not be read)']]",
    "    from pyodide_js import loadPackagesFromImports as _lp",
    "    async def load(mods):",
    "        if not mods: return",
    "        try: await _lp('\\n'.join('import ' + m for m in mods))",
    "        except Exception: pass",
    "    await load(s.get('mods', []))",
    "    g = globals(); ok, bad = [], []",
    "    for name, mod in s.get('imports', {}).items():",
    "        try: g[name] = importlib.import_module(mod); ok.append(name)",
    "        except Exception: bad.append(name)",
    "    for name, src in s.get('defs', []):",
    "        fn = '<session:%s>' % name",
    "        _cr_register(src, fn)",
    "        try:",
    "            exec(compile(src, fn, 'exec'), g)",
    "            if isinstance(g.get(name), type): _CR_SRC[name] = fn",
    "            ok.append(name)",
    "        except Exception: bad.append(name)",
    "    for name, b in s.get('data', {}).items():",
    "        for attempt in (0, 1):",
    "            try:",
    "                g[name] = pickle.loads(b); ok.append(name); break",
    "            except ModuleNotFoundError as e:",
    "                if attempt == 0 and e.name:",
    "                    await load([e.name.split('.')[0]]); continue",
    "                bad.append(name); break",
    "            except Exception:",
    "                bad.append(name); break",
    "    return [ok, bad]",
    "_CR_BASE = set(globals())"
  ].join("\n");

  async function ensurePy() {
    if (py) return py;
    if (!pyLoading) {
      pyLoading = (async () => {
        const errors = [];
        let inst = null;
        for (const cdn of cfg.pyodideCdns || []) {
          try {
            if (typeof G.loadPyodide !== "function") {
              await withTimeout(loadScript(cdn.index + "pyodide.js"), SCRIPT_TIMEOUT_MS, "pyodide.js from " + hostOf(cdn.index));
            }
            const opts = { indexURL: cdn.index };
            if (cdn.packages) opts.packageBaseUrl = cdn.packages;
            inst = await withTimeout(G.loadPyodide(opts), RUNTIME_TIMEOUT_MS, "Python runtime from " + hostOf(cdn.index));
            G.__crPyodideCdnUsed = cdn.index;
            break;
          } catch (e) { errors.push(hostOf(cdn.index) + ": " + (e.message || e)); }
        }
        if (!inst) throw new Error("Could not download the Python runtime from any CDN (" + errors.join("; ") + "). Check the internet connection and try again.");
        inst.FS.mkdirTree(WORKDIR);
        for (const d of dirs) { try { inst.FS.mkdirTree(d); } catch (e) {} }
        for (const [p, b] of files) { inst.FS.mkdirTree(dirname(p)); inst.FS.writeFile(p, b); }
        files.clear();
        const quiet = { messageCallback: () => {}, errorCallback: () => {} };
        try {
          await inst.loadPackage("pyodide-http", quiet);
          inst.runPython("import pyodide_http\ngetattr(pyodide_http, 'patch_urllib', pyodide_http.patch_all)()");
        } catch (e) { pyHttpOk = false; }
        inst.runPython(PY_SETUP);
        inst.globals.set("_CR_CHART_HTML", CHART_HTML);
        inst.runPython(PY_HELPERS);
        inst.runPython("_CR_BASE = set(globals())");
        py = inst;
        return inst;
      })().catch((e) => { pyLoading = null; throw e; });
    }
    return pyLoading;
  }

  function cleanTraceback(msg) {
    const out = [];
    let skip = false;
    for (const line of String(msg).split("\n")) {
      const fm = /^  File "([^"]+)"/.exec(line);
      if (fm) { skip = /\/_pyodide\//.test(fm[1]); if (!skip) out.push(line); continue; }
      if (skip && /^    /.test(line)) continue;
      skip = false;
      out.push(line);
    }
    return out.join("\n").trim();
  }

  async function runPython(msg, notes) {
    const code = msg.code;
    const p = await ensurePy();
    const quiet = { messageCallback: () => {} };

    // Saved variables from earlier calls (unless this call starts fresh).
    const sessionPath = WORKDIR + "/" + PY_SESSION_REL;
    const keepVars = msg.keepVars !== false;
    if (msg.reset && wsExists(sessionPath)) { try { wsRemove(sessionPath); } catch (e) {} }
    let sessionMods = [];
    if (keepVars && wsExists(sessionPath)) {
      try { const m = p.globals.get("_cr_session_mods")(sessionPath); sessionMods = m.toJs(); m.destroy(); } catch (e) {}
    }

    // Packages Pyodide ships load from the imports; retry once for a flaky CDN.
    const loadImports = async () => {
      const errs = [];
      const src = code + "\n" + sessionMods.map((m) => "import " + m).join("\n") + (/\bget_table\s*\(/.test(code) ? "\nimport pandas" : "");
      try { await p.loadPackagesFromImports(src, { ...quiet, errorCallback: (m) => errs.push(String(m)) }); }
      catch (e) { errs.push(String(e && e.message || e)); }
      return errs;
    };
    // Secrets from the plugin settings, as environment variables.
    if (G.__crSecrets && Object.keys(G.__crSecrets).length) {
      try { p.globals.set("_cr_env", p.toPy(G.__crSecrets)); p.runPython("import os\nos.environ.update(_cr_env)\ndel _cr_env"); } catch (e) {}
    }
    let loadErrors = await loadImports();
    if (loadErrors.length) loadErrors = await loadImports();
    if (loadErrors.length) notes.push("some Python packages could not be downloaded: " + loadErrors.slice(0, 3).join(" | ").slice(0, 400));

    // Pure-Python packages: the ones listed, plus known imports that are missing.
    const wanted = [];
    for (const name of Array.isArray(msg.packages) ? msg.packages : []) if (typeof name === "string" && name.trim()) wanted.push(name.trim());
    try {
      const found = p.pyodide_py.code.find_imports(code);
      const names = found.toJs().concat(sessionMods); found.destroy();
      const missingProxy = p.globals.get("_cr_missing")(names);
      const missing = missingProxy.toJs(); missingProxy.destroy();
      for (const n of missing) if (PY_PIP_ALIASES[n]) wanted.push(PY_PIP_ALIASES[n]);
    } catch (e) {}
    if (/\bread_text\s*\(/.test(code)) {
      for (const m of code.matchAll(/\.(pdf|docx|pptx|xlsx|xlsm)\b/gi)) wanted.push(READ_TEXT_PKGS[m[1].toLowerCase()]);
      if (/\.html?\b/i.test(code)) { try { await p.loadPackage("beautifulsoup4", quiet); } catch (e) {} }
    }
    const toInstall = [...new Set(wanted)];
    if (toInstall.length) {
      try {
        await p.loadPackage("micropip", quiet);
        const micropip = p.pyimport("micropip");
        const failed = [];
        for (const name of toInstall) {
          try { await micropip.install(name); }
          catch (e) {
            const m = String(e && e.message || e).split("\n").filter((l) => l.trim()).pop() || "install failed";
            failed.push(name + " (" + m.slice(0, 200) + ")");
          }
        }
        micropip.destroy();
        if (failed.length) notes.push("could not install: " + failed.join("; ") + ". Only pure-Python wheels or packages built for Pyodide can be installed");
      } catch (e) { notes.push("the package installer (micropip) could not be loaded: " + (e.message || e)); }
    }

    p.runPython("import os, sys\nos.makedirs('/workspace', exist_ok=True)\nos.chdir('/workspace')\nif '/workspace' not in sys.path: sys.path.insert(0, '/workspace')");
    if (keepVars && wsExists(sessionPath)) {
      p.setStdout({ batched: () => {} });
      p.setStderr({ batched: () => {} });
      try {
        const r = await p.globals.get("_cr_session_restore")(sessionPath);
        const [, bad] = r.toJs(); r.destroy();
        if (bad.length) notes.push("these saved Python variables could not be restored and must be recreated: " + bad.slice(0, 12).join(", "));
      } catch (e) { notes.push("the saved Python variables could not be restored (" + String(e && e.message || e).split("\n").pop().slice(0, 200) + ")"); }
    }
    p.setStdout({ batched: (s) => emit(s + "\n") });
    p.setStderr({ batched: (s) => emit(s + "\n") });
    const lines = typeof msg.stdin === "string" && msg.stdin.length ? msg.stdin.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    p.setStdin({ stdin: () => (lines.length ? lines.shift() : null) });
    try { p.globals.get("_cr_register")(code); } catch (e) {}

    post({ id: runId, ev: "started" });
    let error = null;
    try {
      const v = await p.runPythonAsync(code, { filename: "<code>" });
      if (v !== undefined && v !== null) {
        try { emit(String(v) + "\n"); } finally { if (v && typeof v.destroy === "function") v.destroy(); }
      }
    } catch (e) {
      const text = cleanTraceback(e && e.message || e);
      error = "Python error:\n" + text;
      const mod = /ModuleNotFoundError: No module named '([^']+)'/.exec(text);
      if (mod) {
        const top = mod[1].split(".")[0];
        error += "\nHint: pass packages: [\"" + (PY_PIP_ALIASES[top] || top) + "\"] to install it (pure-Python wheels only), or use a library Pyodide ships.";
      }
      if (/FileNotFoundError|No such file or directory/.test(text)) error += "\n" + listingNote();
      if (/Host is unreachable|socket\.|getaddrinfo/.test(text)) error += "\nHint: sockets and DNS do not exist in the browser. Use requests / urllib / pyodide.http.pyfetch (HTTP only).";
      if (/EOFError/.test(text)) error += "\nHint: input() reads from the `stdin` parameter of run_code; pass the input lines there.";
      if (/urllib/.test(code) && !pyHttpOk) error += "\nHint: urllib.request is unavailable in this session; use requests or pyodide.http.pyfetch.";
    }
    try { p.runPython("import sys\nsys.stdout.flush()\nsys.stderr.flush()"); } catch (e) {}
    try {
      const saved = p.globals.get("_cr_save_figures")();
      const names = saved.toJs(); saved.destroy();
      if (names.length) notes.push("matplotlib figure" + (names.length > 1 ? "s" : "") + " saved to /workspace: " + names.join(", ") + " - call serve_file to show " + (names.length > 1 ? "them" : "it") + " to the user");
    } catch (e) {}
    if (keepVars) {
      try {
        const r = p.globals.get("_cr_session_save")(sessionPath, msg.stateBudget || 20 * 1024 * 1024, p.toPy(Object.values(G.__crSecrets || {})));
        const skipped = r.toJs(); r.destroy();
        if (skipped.length) notes.push("not kept for the next call: " + skipped.slice(0, 12).join(", ") +
          (skipped.some((x) => /too large/.test(x)) && msg.stateBudget < 1048576 ? " (large values need a workspace store in the plugin settings; save data to files or recompute it)" : ""));
      } catch (e) { notes.push("the Python variables could not be saved for the next call (" + String(e && e.message || e).split("\n").pop().slice(0, 200) + ")"); }
    }
    return error;
  }

  // ----- JavaScript / TypeScript ---------------------------------------------------------
  function jsonSafe(x) {
    const seen = new WeakSet();
    return JSON.stringify(x, (k, v) => {
      if (typeof v === "bigint") return v.toString() + "n";
      if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
      if (typeof v === "undefined") return "[undefined]";
      if (typeof v === "symbol") return v.toString();
      if (v instanceof Map) return { "[Map]": [...v.entries()] };
      if (v instanceof Set) return { "[Set]": [...v.values()] };
      if (v instanceof Error) return v.name + ": " + v.message;
      if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + v.length + ")";
      if (v instanceof ArrayBuffer) return "ArrayBuffer(" + v.byteLength + ")";
      if (v && typeof v === "object") { if (seen.has(v)) return "[Circular]"; seen.add(v); }
      return v;
    });
  }
  function fmt(x) {
    if (typeof x === "string") return x;
    if (x === undefined) return "undefined";
    if (x === null || typeof x === "number" || typeof x === "boolean") return String(x);
    if (typeof x === "bigint") return x.toString() + "n";
    if (typeof x === "symbol") return x.toString();
    if (typeof x === "function") return "[Function " + (x.name || "anonymous") + "]";
    if (x instanceof Error) return x.name + ": " + x.message;
    if (typeof Response === "function" && x instanceof Response) return "Response { status: " + x.status + ", url: " + JSON.stringify(x.url) + " } (read it with await r.text(), r.json() or r.arrayBuffer())";
    if (x && typeof x.then === "function") return "Promise { <pending> } (missing await?)";
    if (ArrayBuffer.isView(x) && !(x instanceof DataView)) return x.constructor.name + "(" + x.length + ") [" + Array.from(x.slice(0, 48)).join(", ") + (x.length > 48 ? ", ..." : "") + "]";
    try { const s = jsonSafe(x); return s === undefined ? String(x) : s; } catch (e) { return String(x); }
  }

  async function ensureBabel() {
    if (babelLib) return babelLib;
    const errors = [];
    for (const u of cfg.babelCdns || BABEL_CDNS) {
      if (G.Babel) break;
      try { await withTimeout(loadScript(u), SCRIPT_TIMEOUT_MS, "the TypeScript compiler from " + hostOf(u)); }
      catch (e) { errors.push(hostOf(u) + ": " + (e.message || e)); }
    }
    if (!G.Babel) throw new Error("Could not download the TypeScript compiler from any CDN (" + errors.join("; ") + "). Retry, or use javascript.");
    babelLib = G.Babel;
    return babelLib;
  }

  // ----- TypeScript type checking (opt-in: the compiler is ~9 MB) -------------------
  async function ensureTsc() {
    if (tscLib) return tscLib;
    const errors = [];
    const get = G.__crRealFetch || fetch;
    for (const base of cfg.tscCdns || TSC_CDNS) {
      try {
        if (!G.ts || typeof G.ts.createProgram !== "function") {
          await withTimeout(loadScript(base + "typescript.js"), RUNTIME_TIMEOUT_MS, "the TypeScript compiler from " + hostOf(base));
        }
        if (!G.ts || typeof G.ts.createProgram !== "function") throw new Error("typescript.js did not define `ts`");
        // The standard library files, following their /// <reference lib> links.
        const libs = new Map();
        let queue = TS_LIBS.slice();
        while (queue.length) {
          const batch = queue.filter((n) => !libs.has(n));
          queue = [];
          for (const n of batch) libs.set(n, "");
          await Promise.all(batch.map(async (n) => {
            const r = await withTimeout(get(base + n), SCRIPT_TIMEOUT_MS, n + " from " + hostOf(base));
            if (!r.ok) throw new Error("HTTP " + r.status + " for " + n);
            const text = await r.text();
            libs.set(n, text);
            for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"/g)) {
              const f = "lib." + m[1].toLowerCase() + ".d.ts";
              if (!libs.has(f)) queue.push(f);
            }
          }));
        }
        tscLib = { ts: G.ts, libs };
        return tscLib;
      } catch (e) { errors.push(hostOf(base) + ": " + (e.message || e)); }
    }
    throw new Error("Could not download the TypeScript type checker from any CDN (" + errors.join("; ") + "). Run without typecheck, or retry.");
  }

  // Type-check the code as the body of an async function (top-level await and
  // return are allowed, like at run time). Returns error lines, empty when clean.
  function typeErrors(T, code) {
    const ts = T.ts;
    const HEADER = "export {};\nasync function __main(): Promise<unknown> {\n";
    const files = new Map([["/main.ts", HEADER + code + "\n}\n"], ["/globals.d.ts", TS_GLOBALS]]);
    for (const [n, text] of T.libs) files.set("/lib/" + n, text);
    const key = (f) => (f.startsWith("/") ? f : "/lib/" + f.replace(/^.*\//, ""));
    const options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noEmit: true,
      skipLibCheck: true, types: [], lib: TS_LIBS.slice(), noUnusedLocals: false
    };
    const host = {
      getSourceFile: (f, lv) => { const t = files.get(key(f)); return t == null ? undefined : ts.createSourceFile(f, t, lv, true); },
      getDefaultLibFileName: () => "/lib/" + TS_LIBS[0],
      getDefaultLibLocation: () => "/lib/",
      writeFile: () => {}, getCurrentDirectory: () => "/", getDirectories: () => [],
      fileExists: (f) => files.has(key(f)), readFile: (f) => files.get(key(f)),
      getCanonicalFileName: (f) => f, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n"
    };
    const program = ts.createProgram(["/main.ts", "/globals.d.ts"], options, host);
    const out = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n  ");
      if (d.file && d.file.fileName === "/main.ts" && d.start != null) {
        const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1 - 2;
        out.push("line " + Math.max(1, line) + ": TS" + d.code + ": " + msg);
      } else if (!d.file || d.file.fileName === "/main.ts") out.push("TS" + d.code + ": " + msg);
    }
    return out;
  }

  async function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data.slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (typeof Blob === "function" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof Response === "function" && data instanceof Response) return new Uint8Array(await data.arrayBuffer());
    if (data && typeof data === "object") return new TextEncoder().encode(JSON.stringify(data, null, 2));
    throw new TypeError("fs.writeFile expects a string, Uint8Array, ArrayBuffer, Blob, Response or JSON-able object");
  }

  function makeFs() {
    const decode = (b) => new TextDecoder().decode(b);
    return {
      readFile: async (p, enc) => {
        const e = enc && typeof enc === "object" ? enc.encoding : enc;
        const b = wsRead(p);
        if (e === "binary" || e === "buffer" || e === "bytes" || e === null) return b;
        if (e === "base64") return bytesToBase64(b);
        return decode(b);
      },
      readJSON: async (p) => JSON.parse(decode(wsRead(p))),
      writeFile: async (p, data) => { const b = await toBytes(data); wsWrite(p, b); return b.length; },
      appendFile: async (p, data) => {
        const add = await toBytes(data);
        const old = wsExists(p) ? wsRead(p) : new Uint8Array(0);
        const b = new Uint8Array(old.length + add.length); b.set(old); b.set(add, old.length);
        wsWrite(p, b); return b.length;
      },
      exists: async (p) => wsExists(p),
      readdir: async (p) => wsReaddir(p == null ? WORKDIR : p),
      mkdir: async (p) => { wsMkdir(p); return true; },
      unlink: async (p) => { wsRemove(p, false); return true; },
      rm: async (p, o) => { if (!wsExists(p)) { if (o && o.force) return false; throw enoent(norm(p)); } wsRemove(p, !!(o && o.recursive)); return true; },
      rename: async (a, b) => { wsRename(a, b); return true; },
      copyFile: async (a, b) => { wsWrite(b, wsRead(a).slice()); return true; },
      stat: async (p) => wsStat(p),
      list: async () => wsWalk().map(([path, b]) => ({ path, size: b.length })),
      download: async (url, name) => {
        const r = await netFetch(url);
        if (!r.ok) throw new Error("download failed: HTTP " + r.status + " from " + url);
        const b = new Uint8Array(await r.arrayBuffer());
        let target = name;
        if (!target) { try { target = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch (e) {} }
        target = target || "download.bin";
        wsWrite(target, b);
        return { path: norm(target), size: b.length, contentType: r.headers.get("content-type") };
      }
    };
  }

  // chart(rows, { x, y, kind, title, path }) -> writes an interactive chart page.
  async function jsChart(rows, o) {
    o = o || {};
    const data = Array.isArray(rows) ? rows.slice(0, 50000).map((r, i) => (r && typeof r === "object" ? r : { x: i, y: r })) : [];
    const opts = { data, x: o.x || null, y: o.y || null, kind: o.kind || "line", title: o.title || "", color: o.color || null, bins: o.bins || null, spec: o.spec || null, height: o.height || null };
    const path = o.path || "chart.html";
    const json = JSON.stringify(opts, (k, v) => (typeof v === "bigint" ? Number(v) : v)).replace(/<\//g, "<\\/");
    wsWrite(path, new TextEncoder().encode(CHART_HTML.replace("__OPTS__", () => json)));
    return path;
  }

  // tables.get/set/list: the shared CSV tables (share_table in Python and R).
  function parseCsv(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
      if (c === '"' && cur === "") q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
    const num = (v) => (v !== "" && !isNaN(Number(v)) ? Number(v) : v);
    return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, num(r[i] == null ? "" : r[i])]))) : [];
  }
  function toCsv(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const keys = [...new Set(list.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
    const cell = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [keys.map(cell).join(",")].concat(list.map((r) => keys.map((k) => cell(r && r[k])).join(","))).join("\n") + "\n";
  }
  function makeTables() {
    const path = (name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) throw new Error("table names use letters, digits and _");
      return WORKDIR + "/" + TABLES_DIR + "/" + name + ".csv";
    };
    const list = () => (wsExists(WORKDIR + "/" + TABLES_DIR) ? wsReaddir(WORKDIR + "/" + TABLES_DIR).filter((n) => n.endsWith(".csv")).map((n) => n.slice(0, -4)) : []);
    return {
      list,
      get: (name) => { const p = path(name); if (!wsExists(p)) throw new Error("no shared table '" + name + "' (shared tables: " + (list().join(", ") || "none") + ")"); return parseCsv(new TextDecoder().decode(wsRead(p))); },
      set: (name, rows) => { wsWrite(path(name), new TextEncoder().encode(toCsv(rows))); return name; }
    };
  }

  function makeStorage() {
    return {
      get: (k) => kv.get(String(k)),
      set: (k, v) => { kv.set(String(k), v); return v; },
      has: (k) => kv.has(String(k)),
      delete: (k) => kv.delete(String(k)),
      keys: () => [...kv.keys()],
      clear: () => kv.clear()
    };
  }

  async function runJavaScript(msg) {
    const label = msg.lang === "typescript" ? "TypeScript" : "JavaScript";
    let src = msg.code;
    if (msg.lang === "typescript" && msg.typecheck) {
      const errs = typeErrors(await ensureTsc(), src);
      if (errs.length) {
        post({ id: runId, ev: "started" });
        return "TypeScript type errors (the code was not run):\n" + errs.slice(0, 20).join("\n") + (errs.length > 20 ? "\n... " + (errs.length - 20) + " more" : "");
      }
    }
    if (msg.lang === "typescript") {
      const B = await ensureBabel();
      try {
        src = B.transform(src, {
          filename: "code.ts",
          presets: [["typescript", { onlyRemoveTypeImports: true }]],
          sourceType: "script",
          parserOpts: { allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true },
          retainLines: true,
          comments: false
        }).code;
      } catch (e) {
        post({ id: runId, ev: "started" });
        return "TypeScript error:\n" + String(e && e.message || e).replace(/^\/?code\.ts: /, "").split("\n").slice(0, 12).join("\n");
      }
    }
    const counts = {}, timers = {};
    let indent = "";
    const line = (prefix) => (...a) => emit(indent + prefix + a.map(fmt).join(" ") + "\n");
    const con = {
      log: line(""), info: line(""), debug: line(""), trace: line(""),
      warn: line("[warn] "), error: line("[error] "),
      dir: (x) => emit(indent + fmt(x) + "\n"),
      table: (rows) => {
        if (!rows || typeof rows !== "object") return emit(indent + fmt(rows) + "\n");
        const list = Array.isArray(rows) ? rows : Object.entries(rows).map(([k, v]) => ({ "(index)": k, ...(v && typeof v === "object" ? v : { Value: v }) }));
        const cols = [...new Set(list.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : ["Value"])))];
        emit(indent + cols.join(" | ") + "\n");
        for (const r of list.slice(0, 500)) emit(indent + cols.map((c) => fmt(r && typeof r === "object" ? r[c] : r)).join(" | ") + "\n");
      },
      assert: (ok, ...a) => { if (!ok) emit(indent + "[assert] " + (a.length ? a.map(fmt).join(" ") : "Assertion failed") + "\n"); },
      count: (l = "default") => { counts[l] = (counts[l] || 0) + 1; emit(indent + l + ": " + counts[l] + "\n"); },
      time: (l = "default") => { timers[l] = Date.now(); },
      timeEnd: (l = "default") => { if (timers[l] != null) emit(indent + l + ": " + (Date.now() - timers[l]) + " ms\n"); delete timers[l]; },
      timeLog: (l = "default") => { if (timers[l] != null) emit(indent + l + ": " + (Date.now() - timers[l]) + " ms\n"); },
      group: (...a) => { if (a.length) emit(indent + a.map(fmt).join(" ") + "\n"); indent += "  "; },
      groupEnd: () => { indent = indent.slice(2); }
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try { fn = new AsyncFunction("console", "fetch", "fs", "storage", "stdin", "sleep", "importScripts", "chart", "tables", "env", src); }
    catch (e) {
      post({ id: runId, ev: "started" });
      return label + " syntax error: " + (e && e.message || e);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // In the worker importScripts is native (synchronous); on the page thread
    // it loads script tags - `await importScripts(url)` works in both.
    const scripts = typeof G.importScripts === "function" ? G.importScripts.bind(typeof self !== "undefined" ? self : G)
      : async (...urls) => { for (const u of urls) await withTimeout(loadScript(u), SCRIPT_TIMEOUT_MS, "importScripts " + u); };
    post({ id: runId, ev: "started" });
    try {
      const v = await fn(con, netFetch, makeFs(), makeStorage(), typeof msg.stdin === "string" ? msg.stdin : "", sleep, scripts,
        jsChart, makeTables(), Object.freeze({ ...(G.__crSecrets || {}) }));
      if (v !== undefined) emit(fmt(v) + "\n");
      return null;
    } catch (e) {
      let text;
      if (e instanceof Error) {
        text = e.name + ": " + e.message;
        // The user's code is an AsyncFunction: its frames end in ", <anonymous>:LINE:COL)"
        // and the generated header adds two lines.
        const m = /(?:^|[\s,(])<anonymous>:(\d+):(\d+)\)?\s*$/m.exec(e.stack || "");
        if (m) text += " (at line " + Math.max(1, Number(m[1]) - 2) + ")";
      } else text = "uncaught " + fmt(e);
      let out = label + " error: " + text;
      if (e && e.code === "ENOENT") out += "\n" + listingNote();
      if (/\b(require|module|process|Buffer|__dirname) is not defined/.test(text)) {
        out += "\nHint: this is a browser runtime, not Node.js. Use fetch, the provided fs/storage objects, and load libraries with `await import('https://cdn.jsdelivr.net/npm/<pkg>/+esm')`.";
      }
      return out;
    }
  }

  // ----- SQL ---------------------------------------------------------------------------
  async function ensureSql() {
    if (sqlLib) return sqlLib;
    const errors = [];
    for (const base of cfg.sqljsCdns || []) {
      try {
        if (typeof G.initSqlJs !== "function") await withTimeout(loadScript(base + "sql-wasm.js"), SCRIPT_TIMEOUT_MS, "sql-wasm.js from " + hostOf(base));
        sqlLib = await withTimeout(G.initSqlJs({ locateFile: (f) => base + f }), RUNTIME_TIMEOUT_MS, "SQLite runtime from " + hostOf(base));
        G.__crSqljsCdnUsed = base;
        return sqlLib;
      } catch (e) { errors.push(hostOf(base) + ": " + (e.message || e)); }
    }
    throw new Error("Could not download the SQLite runtime from any CDN (" + errors.join("; ") + "). Check the internet connection and try again.");
  }

  function formatSqlResult(r, label) {
    const cell = (v) => (v === null ? "NULL" : v instanceof Uint8Array ? "<blob " + v.length + " bytes>" : String(v));
    const rows = r.values.map((row) => row.map(cell).join(" | "));
    const more = r.more ? "\n(" + r.more + " more rows not shown - add LIMIT, or aggregate)" : "";
    return (label ? "-- result " + label + "\n" : "") + r.columns.join(" | ") + (rows.length ? "\n" + rows.join("\n") : "\n(0 rows)") + more;
  }

  async function runSql(msg) {
    const SQL = await ensureSql();
    const dbPath = WORKDIR + "/" + DB_REL;
    const image = wsExists(dbPath) ? wsRead(dbPath) : null;
    const db = image && image.length ? new SQL.Database(image) : new SQL.Database();
    post({ id: runId, ev: "started" });
    let error = null;
    const results = [];
    let changed = 0;
    try {
      // Statement by statement, so a SELECT with no rows still shows its columns.
      for (const stmt of db.iterateStatements(msg.code)) {
        try {
          const columns = stmt.getColumnNames();
          const values = [];
          let more = 0;   // rows past the display cap are stepped (for their effects) but not kept
          while (stmt.step()) { if (values.length < SQL_ROWS_SHOWN) values.push(stmt.get()); else more++; }
          if (columns.length) results.push({ columns, values, more });
          else changed += db.getRowsModified();
        } finally { stmt.free(); }
      }
    } catch (e) { error = "SQL error: " + (e && e.message || e); }
    if (results.length) emit(results.map((r, i) => formatSqlResult(r, results.length > 1 ? i + 1 : 0)).join("\n\n") + "\n");
    else if (!error) emit("(ok" + (changed ? ", " + changed + " row" + (changed === 1 ? "" : "s") + " changed" : "") + ")\n");
    try {
      const hasSchema = db.exec("SELECT count(*) FROM sqlite_master")[0].values[0][0] > 0;
      if (image || hasSchema) wsWrite(dbPath, db.export());
    } finally { db.close(); }
    return error;
  }

  // ----- R (webR) ------------------------------------------------------------------------
  let webr = null, rLoading = null;
  const R_SESSION = ".cr/session.RData", R_PKGS = ".cr/session.rpkgs";

  async function ensureR() {
    if (webr) return webr;
    if (!rLoading) {
      rLoading = (async () => {
        const errors = [];
        const get = G.__crRealFetch || fetch;
        for (const base of cfg.webrCdns || WEBR_CDNS) {
          try {
            const r = await withTimeout(get(base + "webr.mjs"), SCRIPT_TIMEOUT_MS, "webr.mjs from " + hostOf(base));
            if (!r.ok) throw new Error("HTTP " + r.status);
            // A sandboxed page's origin is "null", which webR tries to use as a URL base.
            const text = (await r.text()).replace("new URL(r,location.origin)", 'new URL(r,"https://webr.invalid")');
            const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
            let mod;
            try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
            const w = new mod.WebR({ baseUrl: base, channelType: mod.ChannelType.PostMessage, interactive: false });
            await withTimeout(w.init(), RUNTIME_TIMEOUT_MS, "the R runtime from " + hostOf(base));
            return w;
          } catch (e) { errors.push(hostOf(base) + ": " + (e.message || e)); }
        }
        const err = new Error("Could not download the R runtime (webR) from any CDN (" + errors.join("; ") + ")");
        err.runtimeUnavailable = true;
        throw err;
      })().catch((e) => { rLoading = null; throw e; });
    }
    webr = await rLoading;
    return webr;
  }

  async function rMkdirs(w, dir) {
    let cur = "";
    for (const part of dir.split("/").filter(Boolean)) {
      cur += "/" + part;
      try { await w.FS.mkdir(cur); } catch (e) {}
    }
  }
  async function rWalk(w, dir, rel, out) {
    let node;
    try { node = await w.FS.lookupPath(dir); } catch (e) { return out; }
    for (const [name, child] of Object.entries(node.contents || {})) {
      const p = dir + "/" + name, r = rel ? rel + "/" + name : name;
      if (child.isFolder) await rWalk(w, p, r, out); else out.push(r);
    }
    return out;
  }
  const rString = (x) => JSON.stringify(String(x));   // a JSON string is a valid R string literal

  async function runR(msg, notes) {
    const w = await ensureR();
    const keepVars = msg.keepVars !== false;
    // /workspace in.
    await rMkdirs(w, WORKDIR);
    const before = new Map();
    for (const [rel, b] of wsWalk()) {
      await rMkdirs(w, dirname(WORKDIR + "/" + rel));
      await w.FS.writeFile(WORKDIR + "/" + rel, b);
      before.set(rel, b);
    }
    if (msg.reset) { for (const f of [R_SESSION, R_PKGS]) try { await w.FS.unlink(WORKDIR + "/" + f); } catch (e) {} }
    await w.FS.writeFile("/tmp/cr_stdin.txt", new TextEncoder().encode(typeof msg.stdin === "string" ? msg.stdin : ""));
    await w.FS.writeFile("/tmp/cr_chart.html", new TextEncoder().encode(CHART_HTML));
    try { await w.evalRVoid(R_HELPERS); } catch (e) {}
    const secrets = G.__crSecrets || {};
    for (const [k, v] of Object.entries(secrets)) { try { await w.evalRVoid("Sys.setenv(" + rString(k) + " = " + rString(v) + ")"); } catch (e) {} }
    await w.evalRVoid("setwd('/workspace')\n" +
      "local({ lines <- readLines('/tmp/cr_stdin.txt', warn = FALSE); e <- new.env()\n" +
      "  e$readline <- function(prompt = '') { cat(prompt); if (!length(lines)) return(''); x <- lines[1]; lines <<- lines[-1]; x }\n" +
      "  e$stdin_text <- paste(lines, collapse = '\\n')\n" +
      "  attach(e, name = 'cr:stdin', warn.conflicts = FALSE) })");

    // Packages: the ones the code loads, plus those the saved session had attached.
    const wantPkgs = new Set();
    for (const m of msg.code.matchAll(/\b(?:library|require|requireNamespace)\s*\(\s*["']?([A-Za-z][A-Za-z0-9.]*)["']?/g)) wantPkgs.add(m[1]);
    for (const m of msg.code.matchAll(/\b([A-Za-z][A-Za-z0-9.]*):::?[A-Za-z._]/g)) wantPkgs.add(m[1]);
    let sessionPkgs = [];
    if (keepVars && before.has(R_PKGS)) sessionPkgs = new TextDecoder().decode(before.get(R_PKGS)).split("\n").map((x) => x.trim()).filter(Boolean);
    for (const p of sessionPkgs) wantPkgs.add(p);
    for (const p of Array.isArray(msg.packages) ? msg.packages : []) if (typeof p === "string" && p.trim()) wantPkgs.add(p.trim());
    if (wantPkgs.size) {
      try {
        const inst = await w.evalR("rownames(installed.packages())");
        const have = new Set(await inst.toArray());
        const missing = [...wantPkgs].filter((p) => !have.has(p));
        if (missing.length) {
          await w.installPackages(missing, { quiet: true });
          const inst2 = await w.evalR("rownames(installed.packages())");
          const have2 = new Set(await inst2.toArray());
          const failed = missing.filter((p) => !have2.has(p));
          if (failed.length) notes.push("R packages not available for webR: " + failed.join(", ") + " (packages must be built for WebAssembly; see repo.r-wasm.org)");
        }
      } catch (e) { notes.push("R packages could not be installed: " + String(e && e.message || e).slice(0, 200)); }
    }
    if (keepVars && before.has(R_SESSION)) {
      try {
        await w.evalRVoid("load(" + rString(R_SESSION) + ", envir = globalenv())");
        for (const p of sessionPkgs) { try { await w.evalRVoid("suppressPackageStartupMessages(library(" + rString(p) + ", character.only = TRUE))"); } catch (e) {} }
      } catch (e) { notes.push("the saved R variables could not be restored (" + String(e && e.message || e).slice(0, 200) + ")"); }
    }

    post({ id: runId, ev: "started" });
    const shelter = await new w.Shelter();
    let error = null, images = [];
    try {
      const res = await shelter.captureR(msg.code, {
        withAutoprint: true, captureStreams: true, captureConditions: false,
        captureGraphics: { width: 800, height: 600 }
      });
      for (const o of res.output || []) emit(String(o.data) + "\n");
      images = res.images || [];
    } catch (e) {
      error = "R error: " + String(e && e.message || e).replace(/^Error in `eval\(expr, env\)`: /, "");
    }
    // Plots come back as bitmaps: saved as PNG files for serve_file.
    const plots = [];
    for (const img of images) {
      try {
        const c = new OffscreenCanvas(img.width, img.height);
        c.getContext("2d").drawImage(img, 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        const name = "rplot_" + (plots.length + 1) + ".png";
        await w.FS.writeFile(WORKDIR + "/" + name, new Uint8Array(await blob.arrayBuffer()));
        plots.push(name);
      } catch (e) {}
    }
    if (plots.length) notes.push("R plot" + (plots.length > 1 ? "s" : "") + " saved to /workspace: " + plots.join(", ") + " - call serve_file to show " + (plots.length > 1 ? "them" : "it") + " to the user");
    if (keepVars) {
      try {
        await w.evalRVoid("local({ dir.create('.cr', showWarnings = FALSE)\n" +
          "  v <- ls(globalenv())\n" +
          "  sec <- " + (Object.keys(secrets).length ? "c(" + Object.values(secrets).map(rString).join(", ") + ")" : "character(0)") + "\n" +
          "  v <- Filter(function(n) { x <- get(n, envir = globalenv()); !(is.character(x) && length(sec) && any(vapply(sec, function(s) any(grepl(s, x, fixed = TRUE)), TRUE))) }, v)\n" +
          "  if (length(v)) save(list = v, file = " + rString(R_SESSION) + ", envir = globalenv(), compress = FALSE) else unlink(" + rString(R_SESSION) + ")\n" +
          "  p <- setdiff(.packages(), c('stats', 'graphics', 'grDevices', 'utils', 'datasets', 'methods', 'base', 'webr'))\n" +
          "  if (length(p)) writeLines(p, " + rString(R_PKGS) + ") else unlink(" + rString(R_PKGS) + ") })");
        let size = 0;
        try { size = (await w.FS.readFile(WORKDIR + "/" + R_SESSION)).length; } catch (e) {}
        if (size > (msg.stateBudget || Infinity)) {
          await w.FS.unlink(WORKDIR + "/" + R_SESSION);
          notes.push("the R variables (" + Math.ceil(size / 1024) + " KB) are too large to keep for the next call without a workspace store; save data to files or recompute it");
        }
      } catch (e) { notes.push("the R variables could not be saved for the next call (" + String(e && e.message || e).slice(0, 200) + ")"); }
    }
    try { await shelter.purge(); } catch (e) {}

    // /workspace out: new and changed files, and removals.
    try { await w.FS.unlink(WORKDIR + "/Rplots.pdf"); } catch (e) {}
    const after = await rWalk(w, WORKDIR, "", []);
    const seen = new Set();
    for (const rel of after) {
      seen.add(rel);
      const b = await w.FS.readFile(WORKDIR + "/" + rel);
      const old = before.get(rel);
      if (!old || old.length !== b.length || old.some((x, i) => x !== b[i])) wsWrite(WORKDIR + "/" + rel, b);
    }
    for (const rel of before.keys()) if (!seen.has(rel)) { try { wsRemove(WORKDIR + "/" + rel); } catch (e) {} }
    return error;
  }

  // ----- DuckDB ------------------------------------------------------------------------
  const DUCK_DIR = ".cr/duck";

  async function ensureDuck() {
    const errors = [];
    for (const url of cfg.duckdbCdns || DUCKDB_CDNS) {
      try {
        const duckdb = await withTimeout(import(url), SCRIPT_TIMEOUT_MS, "DuckDB from " + hostOf(url));
        const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
        // Its worker script lives on the CDN: start it through a same-origin blob.
        const wurl = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" }));
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(wurl));
        try { await withTimeout(db.instantiate(bundle.mainModule, bundle.pthreadWorker), RUNTIME_TIMEOUT_MS, "the DuckDB runtime"); }
        finally { URL.revokeObjectURL(wurl); }
        return db;
      } catch (e) { errors.push(hostOf(url) + ": " + (e.message || e)); }
    }
    throw new Error("Could not download DuckDB from any CDN (" + errors.join("; ") + "). Check the internet connection, or use sql (SQLite).");
  }

  // Split a script into statements, respecting quotes, comments and $$ bodies.
  function splitSql(src) {
    const out = [];
    let cur = "", i = 0;
    while (i < src.length) {
      const c = src[i], two = src.slice(i, i + 2);
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < src.length) { if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue; } break; } j++; }
        cur += src.slice(i, j + 1); i = j + 1; continue;
      }
      if (two === "--") { const j = src.indexOf("\n", i); cur += src.slice(i, j < 0 ? src.length : j); i = j < 0 ? src.length : j; continue; }
      if (two === "/*") { const j = src.indexOf("*/", i + 2); cur += src.slice(i, j < 0 ? src.length : j + 2); i = j < 0 ? src.length : j + 2; continue; }
      if (two === "$$") { const j = src.indexOf("$$", i + 2); cur += src.slice(i, j < 0 ? src.length : j + 2); i = j < 0 ? src.length : j + 2; continue; }
      if (c === ";") { if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(cur.trim()); cur = ""; i++; continue; }
      cur += c; i++;
    }
    if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(cur.trim());
    return out;
  }

  // Arrow values as text: dates and timestamps as ISO, decimals with their scale.
  function duckCell(v, type) {
    if (v === null || v === undefined) return "NULL";
    const id = type && type.typeId;
    if (id === 8 && typeof v === "number") return new Date(v).toISOString().slice(0, 10);           // Date
    if (id === 10 && typeof v === "number") return new Date(v).toISOString().replace("T", " ").replace(/\.000Z$|Z$/, "");  // Timestamp
    if (id === 7) {                                                                                   // Decimal
      let digits = String(v).replace(/[^0-9-]/g, ""), neg = digits.startsWith("-");
      if (neg) digits = digits.slice(1);
      const sc = type.scale || 0;
      if (sc > 0) { digits = digits.padStart(sc + 1, "0"); digits = digits.slice(0, -sc) + "." + digits.slice(-sc); }
      return (neg ? "-" : "") + digits;
    }
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return "<blob " + v.length + " bytes>";
    if (typeof v === "object") {
      const plain = typeof v.toJSON === "function" ? v.toJSON() : v;
      return JSON.stringify(plain, (k, x) => (typeof x === "bigint" ? x.toString() : x));
    }
    return String(v);
  }

  async function runDuck(msg, notes) {
    const db = await ensureDuck();
    const keepVars = msg.keepVars !== false;
    const before = new Map();
    for (const [rel, b] of wsWalk()) {
      if (msg.reset && rel.startsWith(DUCK_DIR + "/")) { try { wsRemove(WORKDIR + "/" + rel); } catch (e) {} continue; }
      await db.registerFileBuffer(rel, b.slice());
      before.set(rel, b);
    }
    const conn = await db.connect();
    let error = null;
    try {
      if (keepVars && before.has(DUCK_DIR + "/schema.sql")) {
        try { await conn.query("IMPORT DATABASE '" + DUCK_DIR + "'"); }
        catch (e) { notes.push("the saved DuckDB tables could not be restored (" + String(e && e.message || e).split("\n")[0].slice(0, 200) + ")"); }
      }
      // Shared tables (share_table in Python/R, tables.set in JS) appear as views.
      for (const rel of before.keys()) {
        const m = new RegExp("^" + TABLES_DIR.replace(/[.]/g, "\\.") + "/([A-Za-z_][A-Za-z0-9_]*)\\.csv$").exec(rel);
        if (!m) continue;
        try { await conn.query("CREATE VIEW IF NOT EXISTS \"" + m[1] + "\" AS SELECT * FROM read_csv_auto('" + rel + "')"); } catch (e) {}
      }
      post({ id: runId, ev: "started" });
      const blocks = [];
      let changed = 0;
      for (const stmt of splitSql(msg.code)) {
        let reader;
        try { reader = await conn.send(stmt); }
        catch (e) { error = "DuckDB error: " + String(e && e.message || e).trim(); break; }
        let fields = null, rows = [], more = 0, count = null;
        for await (const batch of reader) {
          fields = fields || batch.schema.fields;
          if (fields.length === 1 && fields[0].name === "Count" && !/^\s*(select|with|from|values|table|pivot|unpivot)\b/i.test(stmt)) {
            for (const r of batch.toArray()) count = (count || 0) + Number(r.Count);
            continue;
          }
          for (let i = 0; i < batch.numRows; i++) {
            if (rows.length >= SQL_ROWS_SHOWN) { more += batch.numRows - i; break; }
            rows.push(fields.map((f, c) => duckCell(batch.getChildAt(c).get(i), f.type)));
          }
        }
        if (count !== null) { changed += count; continue; }
        if (!fields && /^\s*(select|with|from|values|table|show|describe|summarize|pivot|unpivot)\b/i.test(stmt)) {
          // A query with no rows: still show its columns.
          try { const d = await conn.query("DESCRIBE " + stmt); fields = d.toArray().map((r) => ({ name: String(r.column_name) })); } catch (e) {}
        }
        if (fields) blocks.push({ columns: fields.map((f) => f.name), rows, more });
      }
      if (blocks.length) {
        emit(blocks.map((b, i) => (blocks.length > 1 ? "-- result " + (i + 1) + "\n" : "") + b.columns.join(" | ") +
          (b.rows.length ? "\n" + b.rows.map((r) => r.join(" | ")).join("\n") : "\n(0 rows)") +
          (b.more ? "\n(" + b.more + " more rows not shown - add LIMIT, or aggregate)" : "")).join("\n\n") + "\n");
      } else if (!error) emit("(ok" + (changed ? ", " + changed + " row" + (changed === 1 ? "" : "s") + " changed" : "") + ")\n");

      // Tables and views survive between calls as an EXPORT DATABASE folder.
      if (keepVars) {
        const n = await conn.query("SELECT (SELECT count(*) FROM duckdb_tables() WHERE NOT internal AND database_name = current_database()) + (SELECT count(*) FROM duckdb_views() WHERE NOT internal AND database_name = current_database()) AS n");
        const has = Number(n.toArray()[0].n) > 0;
        for (const rel of [...before.keys()]) if (rel.startsWith(DUCK_DIR + "/")) { try { wsRemove(WORKDIR + "/" + rel); } catch (e) {} before.delete(rel); try { await db.dropFile(rel); } catch (e) {} }
        if (has) {
          await conn.query("EXPORT DATABASE '" + DUCK_DIR + "' (FORMAT parquet)");
          let size = 0;
          for (const f of await db.globFiles(DUCK_DIR + "/*")) size += f.fileSize || 0;
          if (size > (msg.stateBudget || Infinity)) {
            for (const f of await db.globFiles(DUCK_DIR + "/*")) { try { await db.dropFile(f.fileName); } catch (e) {} }
            notes.push("the DuckDB tables (" + Math.ceil(size / 1024) + " KB) are too large to keep for the next call without a workspace store; write them to Parquet files with COPY ... TO, or recreate them");
          }
        }
      }
    } finally {
      try { await conn.close(); } catch (e) {}
    }
    // Files DuckDB wrote (COPY ... TO 'file') go back into /workspace. Named
    // COPY targets always do; others only when new or resized.
    const targets = new Set([...msg.code.matchAll(/\bTO\s+'([^']+)'/gi)].map((m) => m[1].replace(/^\/workspace\//, "").replace(/^\.\//, "")));
    for (const f of await db.globFiles("*")) {
      const rel = f.fileName, old = before.get(rel);
      if (old && old.length === f.fileSize && !targets.has(rel)) continue;
      try { wsWrite(WORKDIR + "/" + rel, await db.copyFileToBuffer(rel)); } catch (e) {}
    }
    try { await db.terminate(); } catch (e) {}
    return error;
  }

  // ----- Ruby (ruby.wasm) -------------------------------------------------------------
  let rubyLib = null;
  async function ensureRuby() {
    if (rubyLib) return rubyLib;
    const errors = [];
    const get = G.__crRealFetch || fetch;
    for (const c of cfg.rubyCdns || RUBY_CDNS) {
      try {
        const [vmMod, shim] = await withTimeout(Promise.all([import(c.vm), import(c.shim)]), SCRIPT_TIMEOUT_MS, "ruby.wasm modules from " + hostOf(c.vm));
        const r = await withTimeout(get(c.wasm), RUNTIME_TIMEOUT_MS, "the Ruby runtime from " + hostOf(c.wasm));
        if (!r.ok) throw new Error("HTTP " + r.status);
        const module = await withTimeout(WebAssembly.compile(await r.arrayBuffer()), RUNTIME_TIMEOUT_MS, "compiling the Ruby runtime");
        rubyLib = { RubyVM: vmMod.RubyVM, shim, module };
        return rubyLib;
      } catch (e) { errors.push(hostOf(c.wasm) + ": " + (e.message || e)); }
    }
    const err = new Error("Could not download the Ruby runtime (ruby.wasm) from any CDN (" + errors.join("; ") + ")");
    err.runtimeUnavailable = true;
    throw err;
  }

  async function runRuby(msg) {
    const { RubyVM, shim, module } = await ensureRuby();
    // /workspace as a WASI directory tree.
    const root = new Map();
    const before = new Map(wsWalk());
    for (const [rel, b] of before) {
      const parts = rel.split("/");
      let dir = root;
      for (const d of parts.slice(0, -1)) {
        let sub = dir.get(d);
        if (!sub || !(sub instanceof shim.Directory)) { sub = new shim.Directory(new Map()); dir.set(d, sub); }
        dir = sub.contents;
      }
      dir.set(parts[parts.length - 1], new shim.File(b.slice()));
    }
    const pre = new shim.PreopenDirectory(WORKDIR, root);
    const decOut = new TextDecoder(), decErr = new TextDecoder();
    const fds = [
      new shim.OpenFile(new shim.File(new TextEncoder().encode(typeof msg.stdin === "string" ? msg.stdin : ""))),
      new shim.ConsoleStdout((b) => emit(decOut.decode(b, { stream: true }))),
      new shim.ConsoleStdout((b) => emit(decErr.decode(b, { stream: true }))),
      pre
    ];
    const envList = ["HOME=" + WORKDIR, "PWD=" + WORKDIR].concat(Object.entries(G.__crSecrets || {}).map(([k, v]) => k + "=" + v));
    const wasi = new shim.WASI(["ruby"], envList, fds, { debug: false });
    const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
    vm.eval('Dir.chdir("' + WORKDIR + '")');
    post({ id: runId, ev: "started" });
    let error = null;
    try {
      const v = vm.eval(msg.code);
      if (v && String(v.call("nil?")) !== "true") emit("=> " + String(v.call("inspect")) + "\n");
    } catch (e) {
      const m = String(e && e.message || e).split("\n").filter((l) => !/^\s*-e:in 'Kernel\.eval'/.test(l)).join("\n").replace(/^eval:(\d+)/gm, "line $1");
      error = "Ruby error: " + m.trim();
    }
    try { vm.eval("$stdout.flush; $stderr.flush"); } catch (e) {}
    emit(decOut.decode()); emit(decErr.decode());
    // Back out: walk the tree.
    const after = new Map();
    const walk = (dir, prefix) => {
      for (const [name, node] of dir) {
        const rel = prefix ? prefix + "/" + name : name;
        if (node instanceof shim.Directory) walk(node.contents, rel);
        else if (node instanceof shim.File) after.set(rel, node.data instanceof Uint8Array ? node.data : new Uint8Array(node.data));
      }
    };
    walk(pre.dir.contents, "");
    for (const [rel, b] of after) { const old = before.get(rel); if (!old || old.length !== b.length || old.some((x, i) => x !== b[i])) wsWrite(WORKDIR + "/" + rel, b); }
    for (const rel of before.keys()) if (!after.has(rel)) { try { wsRemove(WORKDIR + "/" + rel); } catch (e) {} }
    return error;
  }

  // ----- messages ----------------------------------------------------------------------
  async function handle(msg) {
    const id = msg && msg.id;
    try {
      switch (msg.op) {
        case "ping":
          return post({ id, ok: true, worker: !!env.inWorker });
        case "init": {
          cfg = msg.cfg || {};
          G.__crCorsProxy = cfg.corsProxy || "";
          G.__crFetchTimeout = cfg.fetchTimeoutMs || 30000;
          G.__crNoPublicProxies = !!cfg.noPublicProxies;
          G.__crSecrets = cfg.secrets && typeof cfg.secrets === "object" ? cfg.secrets : {};
          mergeHosts(msg.hosts);
          for (const [rel, b] of msg.files || []) wsWrite(WORKDIR + "/" + rel, b);
          for (const [k, v] of Object.entries(msg.kv || {})) kv.set(k, v);
          if (env.inWorker) { G.__crRunning = 1; patchFetch(); patchXHR(); }
          return post({ id, ok: true });
        }
        case "run": {
          resetOutput(id);
          G.__crNetLog = new Map();
          const notes = [];
          if (!env.inWorker) { patchFetch(); patchXHR(); G.__crRunning = (G.__crRunning || 0) + 1; }
          let error = null;
          try {
            if (msg.lang === "python") error = await runPython(msg, notes);
            else if (msg.lang === "javascript" || msg.lang === "typescript") error = await runJavaScript(msg);
            else if (msg.lang === "sql") error = await runSql(msg);
            else if (msg.lang === "r") error = await runR(msg, notes);
            else if (msg.lang === "duckdb") error = await runDuck(msg, notes);
            else if (msg.lang === "ruby") error = await runRuby(msg);
            else error = "Unsupported language: " + msg.lang;
          } catch (e) {
            error = String(e && e.message || e);
            if (e && e.runtimeUnavailable) return post({ id, ok: true, runtimeUnavailable: error, notes, netLog: [...G.__crNetLog], hosts: hostHealthSnapshot() });
          } finally {
            if (!env.inWorker) G.__crRunning--;
          }
          return post({ id, ok: true, error, notes, tail, dropped, netLog: [...G.__crNetLog], hosts: hostHealthSnapshot() });
        }
        case "snapshot": {
          const kvObj = {};
          const secretVals = Object.values(G.__crSecrets || {}).filter(Boolean);
          for (const [k, v] of kv) { try { const j = JSON.stringify(v); if (!secretVals.some((sv) => j.includes(sv))) kvObj[k] = v; } catch (e) {} }
          return post({ id, ok: true, files: wsWalk(), kv: kvObj, hosts: hostHealthSnapshot() });
        }
        default:
          return post({ id, ok: false, error: "unknown op " + msg.op });
      }
    } catch (e) {
      return post({ id, ok: false, error: String(e && e.message || e) });
    }
  }

  return { handle };
}

// Functions and constants shipped into the worker (by source text).
const SHARED_FUNCTIONS = [
  loadScript, withTimeout, bytesToBase64, base64ToBytes, hostOf, isAbort,
  fetchTimeoutMs, proxyTimeoutMs, proxyPhaseMs, deadHostProbeMs, hostHealth, deadHost, markDead, markAlive,
  netNote, netError, hostHealthSnapshot, mergeHosts, applyProxy, mirrorUrl, proxyCandidates, requestUrl,
  carriesCredentials, urlCarriesSecret, bodyCarriesSecret, containsSecretValue, secretForms, noteProxyRejected, timedFetch, proxyHop, raceProxies, describeStats, fetchDirectThenProxies, netFetch,
  patchFetch, patchXHR, crEngine
];
function workerConstants() {
  return {
    WORKDIR, DB_REL, PY_SESSION_REL, SQL_ROWS_SHOWN, RUBY_CDNS, CHART_HTML, PY_HELPERS, R_HELPERS, READ_TEXT_PKGS, TABLES_DIR, TSC_CDNS, TS_LIBS, TS_GLOBALS, WEBR_CDNS, DUCKDB_CDNS, OUTPUT_HEAD, OUTPUT_TAIL, SCRIPT_TIMEOUT_MS, RUNTIME_TIMEOUT_MS, BABEL_CDNS,
    PY_PIP_ALIASES, BUILTIN_PROXIES, PROXY_PARALLEL, DEAD_HOST_TTL_MS, XHR_SYNC_ROUTES_MAX
  };
}
// The worker runs the model's code in the same global scope as the engine, so
// the engine is sealed off from it: everything lives inside one closure, the
// engine's own state (__cr*, including the personal proxy URL and its key) goes
// to a private shadow of `globalThis`, and results travel over a MessageChannel
// port that user code cannot reach (so it cannot forge a result either).
function workerSource() {
  let s = "(() => {\n";
  s += "const __crPriv = Object.create(null);\n";
  s += "const __crOwn = (k) => typeof k === 'string' && k.startsWith('__cr');\n";
  s += "const globalThis = new Proxy(self, {\n" +
       "  get: (t, k) => (__crOwn(k) ? __crPriv[k] : Reflect.get(t, k)),\n" +
       "  set: (t, k, v) => { if (__crOwn(k)) __crPriv[k] = v; else t[k] = v; return true; },\n" +
       "  has: (t, k) => (__crOwn(k) ? k in __crPriv : k in t),\n" +
       "  deleteProperty: (t, k) => (__crOwn(k) ? delete __crPriv[k] : delete t[k])\n" +
       "});\n";
  for (const [k, v] of Object.entries(workerConstants())) s += "const " + k + " = " + JSON.stringify(v) + ";\n";
  s += "const AUTH_HEADER = " + String(AUTH_HEADER) + ";\n";
  s += "const SECRET_FIELD = " + String(SECRET_FIELD) + ";\n";
  s += SHARED_FUNCTIONS.map((f) => f.toString()).join("\n\n");
  s += "\nlet __crEngine = null;\n";
  // Native functions captured now, before any user code can patch the prototypes.
  s += "const __crSend = MessagePort.prototype.postMessage, __crApply = Reflect.apply;\n";
  s += "self.onmessage = (e) => {\n" +
       "  const port = e.ports && e.ports[0];\n" +
       "  if (!port || __crEngine) return;\n" +
       "  self.onmessage = null;\n" +
       "  __crEngine = crEngine((m) => __crApply(__crSend, port, [m]), { inWorker: true });\n" +
       "  port.onmessage = (ev) => { __crEngine.handle(ev.data); };\n" +
       "};\n";
  s += "})();\n";
  return s;
}

// ---------------------------------------------------------------------------
// Engine client (iframe thread)
// ---------------------------------------------------------------------------
function createEngine(options) {
  options = options || {};
  const pending = new Map();
  let seq = 0, worker = null, port = null, workerUrl = null, local = null;

  function dispatch(m) {
    const p = m && pending.get(m.id);
    if (!p) return;
    if (m.ev) { if (m.ev === "started") p.onStarted(); else if (p.onEvent) p.onEvent(m); return; }
    pending.delete(m.id);
    p.done(m);
  }
  function startLocal() {
    local = crEngine((m) => { Promise.resolve().then(() => dispatch(m)); }, { inWorker: false });
  }
  function failAll(reason) {
    for (const [id, p] of pending) p.done({ id, ok: false, error: reason, crashed: true });
    pending.clear();
  }
  function terminate() {
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (port) { try { port.close(); } catch (e) {} port = null; }
    if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (e) {} workerUrl = null; }
    // An in-thread run cannot be killed; it is abandoned and its late messages ignored.
    local = null;
  }
  const canWorker = !options.noWorker && typeof Worker === "function" && typeof Blob === "function" &&
    typeof MessageChannel === "function" && typeof URL === "function" && typeof URL.createObjectURL === "function";
  if (canWorker) {
    try {
      workerUrl = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
      const w = new Worker(workerUrl);
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => dispatch(e.data);
      w.onerror = (e) => {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        failAll("the background runtime crashed" + (e && e.message ? " (" + e.message + ")" : "") + " - usually out of memory");
        terminate();
      };
      w.postMessage({ op: "port" }, [ch.port2]);
      worker = w;
      port = ch.port1;
    } catch (e) { terminate(); }
  }
  if (!worker) startLocal();

  function call(msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const id = ++seq;
      msg.id = id;
      let timer = null;
      const clear = () => { if (timer) clearTimeout(timer); timer = null; };
      const arm = (ms, phase) => {
        clear();
        if (!ms) return;
        timer = setTimeout(() => {
          pending.delete(id);
          terminate();
          resolve({ id, ok: false, timedOut: true, phase });
        }, ms);
      };
      pending.set(id, {
        onEvent: opts.onEvent,
        onStarted: () => arm(opts.execTimeoutMs, "run"),
        done: (m) => { clear(); resolve(m); }
      });
      arm(opts.timeoutMs, opts.execTimeoutMs ? "boot" : "op");
      if (!worker && !local) { pending.delete(id); clear(); return resolve({ id, ok: false, error: "the runtime is no longer available", crashed: true }); }
      try { if (worker) port.postMessage(msg); else local.handle(msg); }
      catch (e) { pending.delete(id); clear(); resolve({ id, ok: false, error: "could not start the runtime: " + (e.message || e) }); }
    });
  }

  // A Worker can be constructed yet fail to boot (strict CSP, old browsers):
  // ping it, and fall back to running in this thread.
  async function ready() {
    if (!worker) return "thread";
    const r = await call({ op: "ping" }, { timeoutMs: 10000 });
    if (r.ok) return "worker";
    terminate();
    startLocal();
    return "thread";
  }

  return { call, ready, terminate, get mode() { return worker ? "worker" : "thread"; } };
}

// ---------------------------------------------------------------------------
// Cross-call state: [[cr-state:<base64>]] trailer.
//   packed  = flag byte (1 deflate-raw, 0 stored) + body
//   body v2 = 4-byte header length (big endian) + header JSON + file bytes
//   header  = { v: 2, files: [[relPath, byteLength], ...], kv, net, ext }
// v1 (JSON with base64 files) is still read, for trailers from older versions.
// ---------------------------------------------------------------------------
function extractTrailer(text) {
  const re = /\[\[cr-state:([A-Za-z0-9+/=]+)\]\]/g;
  let m, last = null;
  while ((m = re.exec(String(text))) !== null) last = m[1];
  return last;
}

function previousOutputText(prev) {
  if (prev == null) return "";
  if (typeof prev === "string") return prev;
  if (Array.isArray(prev)) return prev.map((p) => (p && typeof p === "object" ? p.text || p.content || "" : String(p))).join("\n");
  if (typeof prev === "object") return prev.content != null ? previousOutputText(prev.content) : prev.text != null ? String(prev.text) : JSON.stringify(prev);
  return String(prev);
}

async function pipeBytes(u8, stream) {
  const r = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(r).arrayBuffer());
}
async function packBytes(u8) {
  if (typeof CompressionStream === "function") {
    try {
      const z = await pipeBytes(u8, new CompressionStream("deflate-raw"));
      const out = new Uint8Array(z.length + 1); out[0] = 1; out.set(z, 1); return out;
    } catch (e) {}
  }
  const out = new Uint8Array(u8.length + 1); out[0] = 0; out.set(u8, 1); return out;
}
async function unpackBytes(u8) {
  const body = u8.subarray(1);
  if (u8[0] === 1) {
    if (typeof DecompressionStream !== "function") throw new Error("this browser cannot decompress the saved workspace");
    return pipeBytes(body, new DecompressionStream("deflate-raw"));
  }
  return body;
}

function encodeContainer(header, files) {
  const head = new TextEncoder().encode(JSON.stringify({ ...header, v: 2, files: files.map(([p, b]) => [p, b.length]) }));
  const total = 4 + head.length + files.reduce((n, [, b]) => n + b.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let off = 4 + head.length;
  for (const [, b] of files) { out.set(b, off); off += b.length; }
  return out;
}

function decodeContainer(body) {
  if (body[0] === 0x7b) {   // "{": v1 JSON
    const snap = JSON.parse(new TextDecoder().decode(body));
    if (!snap || snap.v !== 1) throw new Error("unknown workspace format");
    const files = (snap.files || []).map(([p, b64]) => [p, base64ToBytes(b64)]);
    if (snap.sql && !files.some(([p]) => p === DB_REL)) files.push([DB_REL, base64ToBytes(snap.sql)]);
    return { files, kv: snap.kv || {}, hosts: snap.net && snap.net.hosts, ext: snap.ext || null, att: [], hist: [] };
  }
  const len = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + len)));
  if (!header || header.v !== 2) throw new Error("unknown workspace format");
  let off = 4 + len;
  const files = [];
  for (const [p, n] of header.files || []) { files.push([p, body.slice(off, off + n)]); off += n; }
  return { files, kv: header.kv || {}, hosts: header.net && header.net.hosts, ext: header.ext || null,
    att: Array.isArray(header.att) ? header.att : [], hist: Array.isArray(header.hist) ? header.hist : [] };
}

async function decodeState(b64) {
  return decodeContainer(await unpackBytes(base64ToBytes(b64)));
}

function rawFetch() { return globalThis.__crRealFetch || fetch; }

// A blob in the user's own store is read with the store's key; the key itself
// never goes into the trailer, so a shared chat does not expose the workspace.
function storeAuthUrl(url, cfg) {
  if (!cfg || !cfg.workspaceStore) return url;
  try {
    const store = new URL(cfg.workspaceStore), u = new URL(url);
    const key = store.searchParams.get("key");
    if (store.origin !== u.origin || !key || u.searchParams.has("key")) return url;
    u.searchParams.set("key", key);
    return u.toString();
  } catch (e) { return url; }
}

async function downloadBlob(url, cfg) {
  url = storeAuthUrl(url, cfg);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await timedFetch(rawFetch(), url, {}, fetchTimeoutMs());
      if (r.status === 401) throw new Error("the workspace store rejected the key (HTTP 401) - check the Workspace store setting");
      if (r.ok) return (await r.text()).trim();
      lastErr = new Error("HTTP " + r.status);
      if (r.status !== 404 && r.status < 500) break;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 800));
  }
  if (/rejected the key/.test(lastErr && lastErr.message)) throw lastErr;
  // Last resort: through the fallback routes (store unreachable directly). A
  // URL carrying the store key only ever goes through the personal proxy.
  try {
    const r = await netFetch(url);
    if (r.ok) return (await r.text()).trim();
    lastErr = new Error("HTTP " + r.status);
  } catch (e) { lastErr = e; }
  throw lastErr;
}

// Decode a trailer (downloading an offloaded one): { files: [[rel, bytes]], kv, hosts }.
async function restoreSnapshot(b64, cfg) {
  let snap;
  try { snap = await decodeState(b64); }
  catch (e) { throw new Error("the saved workspace data is damaged"); }
  if (snap.ext) {
    const ext = snap.ext, hist = snap.hist, att = snap.att;
    if (!ext.exp || Date.now() > ext.exp) throw new Error("the saved workspace expired");
    let text = "";
    const urls = Array.isArray(ext.parts) ? ext.parts : [ext.url];
    for (const u of urls) {
      try { text += await downloadBlob(u, cfg); }
      catch (e) { throw new Error("the saved workspace could not be downloaded from " + hostOf(u) + " (" + (e.message || e) + ")"); }
    }
    try { snap = await decodeState(text); }
    catch (e) { throw new Error("the downloaded workspace is damaged"); }
    // Run history and attachment ids travel in the small pointer, not in the
    // uploaded workspace, so an unchanged workspace is not uploaded again.
    if (hist && hist.length) snap.hist = hist;
    if (att && att.length) snap.att = att;
    globalThis.__crExtIn = { ptr: ext, trailer: b64 };
  }
  mergeHosts(snap.hosts);
  return snap;
}

// A configured private store is the only destination (the user chose privacy);
// public temporary stores only when the user allowed them.
function workspaceBinsFor(cfg) {
  if (cfg.workspaceStore) return [{ kind: "paste", host: cfg.workspaceStore, max: PRIVATE_STORE_MAX }];
  return cfg.publicStores ? PUBLIC_BINS : [];
}

async function sha256Short(text) {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return bytesToBase64(new Uint8Array(d)).slice(0, 32);
  } catch (e) { return null; }
}

async function binUpload(bin, payload) {
  const real = rawFetch();
  const uploadMs = Math.max(fetchTimeoutMs(), 120000);
  if (bin.kind === "litterbox") {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "24h");
    form.append("fileToUpload", new Blob([payload], { type: "text/plain" }), "workspace.txt");
    const r = await timedFetch(real, bin.host, { method: "POST", body: form }, uploadMs);
    const url = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//i.test(url)) throw new Error("litterbox HTTP " + r.status);
    return { url, del: null };
  }
  if (bin.kind === "pastesdev") {
    const r = await timedFetch(real, bin.host, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload }, uploadMs);
    if (!(r.ok || r.status === 201)) throw new Error("pastes.dev HTTP " + r.status);
    let key = null;
    try { key = JSON.parse(await r.text()).key; } catch (e) {}
    if (!key) throw new Error("pastes.dev did not return a key");
    return { url: "https://api.pastes.dev/" + encodeURIComponent(key), del: null };
  }
  if (bin.kind === "dpaste") {
    const body = new URLSearchParams({ content: payload, syntax: "text", expiry_days: "1" });
    const r = await timedFetch(real, bin.host, { method: "POST", body }, fetchTimeoutMs());
    if (!(r.ok || r.status === 201)) throw new Error("dpaste.com HTTP " + r.status);
    const url = (await r.text()).trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(url)) throw new Error("dpaste.com did not return a URL");
    return { url: url + ".txt", del: null };
  }
  const r = await timedFetch(real, bin.host, { method: "POST", body: payload, headers: { "Content-Type": "text/plain" } }, uploadMs);
  if (r.status === 401) throw new Error(hostOf(bin.host) + " rejected the key (HTTP 401) - check the Workspace store setting");
  if (!(r.ok || r.status === 201)) throw new Error(hostOf(bin.host) + " HTTP " + r.status);
  const url = (await r.text()).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(hostOf(bin.host) + " did not return a URL");
  return { url, del: null };
}

async function uploadState(payload, cfg, hash) {
  const all = workspaceBinsFor(cfg);
  if (!all.length) {
    const e = new Error("no workspace store is set up, so files above the inline limit cannot be carried (set the Workspace store in the plugin settings, or allow public temporary stores)");
    e.noStore = true;
    throw e;
  }
  // A payload bigger than a store's limit goes up in parts (at most MAX_STORE_PARTS).
  const bins = all.filter((b) => payload.length <= b.max * MAX_STORE_PARTS);
  if (!bins.length) {
    const max = Math.max(...all.map((b) => b.max)) * MAX_STORE_PARTS;
    const e = new Error("it is " + Math.ceil(payload.length / 1024) + " KB compressed, more than the workspace store accepts (" + Math.round(max / 1048576) + " MB)");
    e.tooLarge = true;
    e.max = max;
    throw e;
  }
  const errors = [];
  for (const bin of bins) {
    try {
      const size = bin.max - 1024;
      const chunks = [];
      for (let i = 0; i < payload.length; i += size) chunks.push(payload.slice(i, i + size));
      const urls = [];
      for (const chunk of chunks) {
        const { url } = await binUpload(bin, chunk);
        const check = await downloadBlob(url, cfg);
        if (check !== chunk) throw new Error("read-back mismatch");
        urls.push(url);
      }
      // Earlier uploads are left to expire: an edited or regenerated message
      // further up the chat may still point at them.
      const lifeMin = Math.min(cfg.ttlMin, bin.lifeMin || Infinity);
      const ptr = { exp: Date.now() + lifeMin * 60000, h: hash || undefined };
      if (urls.length === 1) ptr.url = urls[0]; else ptr.parts = urls;
      return ptr;
    } catch (e) { errors.push(hostOf(bin.host) + ": " + (e.message || e)); }
  }
  throw new Error("upload failed (" + errors.join("; ") + ")");
}

// Internal files (saved Python variables) are named for what they are.
const INTERNAL_DIR = ".cr/";
function displayName(p) { return p === PY_SESSION_REL ? "the saved Python variables" : p; }
function isInternal(p) { return String(p).startsWith(INTERNAL_DIR); }

async function buildTrailer(snap, cfg, notes) {
  let files = snap.files || [];
  const kvObj = snap.kv || {};
  const hosts = hostHealthSnapshot();
  if (!files.length && !Object.keys(kvObj).length && !hosts && !(snap.att && snap.att.length) && !(snap.hist && snap.hist.length)) return null;
  const secretVals = secretValues(cfg.secrets);
  if (secretVals.length) {
    const leaking = files.filter(([, b]) => bytesContainSecret(b, secretVals)).map(([p]) => p);
    if (leaking.length) {
      files = files.filter(([p]) => !leaking.includes(p));
      notes.push("these files contain one of your secrets, so they are not kept for the next call (the workspace travels in the chat): " + leaking.slice(0, 10).map(displayName).join(", "));
    }
  }
  const total = files.reduce((n, [, b]) => n + b.length, 0);
  const cap = maxCarry(cfg);
  if (total > cap) {
    // Keep the smallest files that fit; name the ones that are dropped.
    const sorted = files.slice().sort((a, b) => a[1].length - b[1].length);
    const kept = [], lost = [];
    let used = 0;
    for (const f of sorted) { if (used + f[1].length <= cap) { kept.push(f); used += f[1].length; } else lost.push(f[0]); }
    files = kept;
    notes.push("/workspace is larger than " + (cap >> 20) + " MB, so these files will NOT exist in the next call: " + lost.slice(0, 10).map(displayName).join(", ") + (lost.length > 10 ? ", ..." : "") + ". Finish the work that needs them in this call, or write smaller outputs");
  }
  const header = { kv: kvObj };
  if (hosts) header.net = { hosts };
  const outer = {};
  if (snap.att && snap.att.length) outer.att = snap.att.slice(-50);
  if (snap.hist && snap.hist.length) outer.hist = snap.hist;
  Object.assign(header, outer);
  const limit = cfg.limitKB * 1024;
  const inner = { kv: kvObj };
  if (hosts) inner.net = { hosts };
  const encode = async (list) => bytesToBase64(await packBytes(encodeContainer(header, list)));
  const encodeInner = async (list) => bytesToBase64(await packBytes(encodeContainer(inner, list)));
  const pointer = async (payload) => {
    // An unchanged workspace reuses the copy already stored (no upload) until
    // shortly before it expires.
    const hash = await sha256Short(payload);
    const inc = globalThis.__crExtIn;
    const ptr = hash && inc && inc.ptr && inc.ptr.h === hash && Date.now() < inc.ptr.exp - 30 * 60000 ? inc.ptr : await uploadState(payload, cfg, hash);
    return bytesToBase64(await packBytes(encodeContainer({ ext: ptr, ...outer }, [])));
  };

  let b64 = await encode(files);
  if (b64.length <= limit) return b64;
  let reason = "offloading large workspaces is off";
  let target = limit;
  if (cfg.bigWorkspace) {
    try { return await pointer(await encodeInner(files)); }
    catch (e) {
      reason = e.message || String(e);
      if (e.tooLarge) target = e.max;   // the store can still take a smaller set
    }
  }

  // Carry as much as possible: drop the largest files until the rest fits.
  // Each pass drops as many files as the current compression ratio says are
  // needed, so a big workspace is re-encoded a few times, not once per file.
  const kept = files.slice().sort((a, b) => a[1].length - b[1].length);
  const lost = [];
  while (kept.length && b64.length > target) {
    const raw = kept.reduce((n, [, b]) => n + b.length, 0) || 1;
    const ratio = b64.length / raw;
    let est = b64.length;
    do { const f = kept.pop(); lost.push(f[0]); est -= f[1].length * ratio; } while (kept.length && est > target * 0.9);
    b64 = await encode(kept);
  }
  let trailer = null;
  if (b64.length <= limit) trailer = b64;
  else if (cfg.bigWorkspace) { try { trailer = await pointer(await encodeInner(kept)); } catch (e) {} }
  if (trailer === null) {
    lost.push(...kept.map(([p]) => p));
    kept.length = 0;
    const rest = await encode([]);
    trailer = rest.length <= limit ? rest : null;
  }
  notes.push("these /workspace files are too large to keep for the next call and will be missing there: " + lost.slice(0, 12).map(displayName).join(", ") +
    (lost.length > 12 ? ", ..." : "") + " (" + reason + "). Use them within this call, or save smaller outputs" + (kept.length ? "; the other files are kept" : ""));
  return trailer;
}

// ---------------------------------------------------------------------------
// Settings and output
// ---------------------------------------------------------------------------
function normalizeBase(u) {
  u = String(u || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u : u + "/";
}
function cdnCandidates(defaults, custom) {
  const c = normalizeBase(custom);
  return c ? [typeof defaults[0] === "string" ? c : { index: c }, ...defaults] : defaults;
}

// Secrets setting: a JSON object {"NAME": "value"} or NAME=value pairs separated
// by newlines or semicolons. Names must be valid environment variable names.
function parseSecrets(raw) {
  const out = {};
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return out;
  let obj = null;
  if (text.startsWith("{")) { try { obj = JSON.parse(text); } catch (e) {} }
  if (!obj) {
    obj = {};
    for (const part of text.split(/[\n;]+/)) {
      const i = part.indexOf("=");
      if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  // Values shorter than 6 characters cannot be told apart from ordinary text
  // (redacting them would mangle output), so they are refused, not half-protected.
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || v == null) continue;
    if (String(v).length >= 6) out[k] = String(v); else out.__tooShort = (out.__tooShort || []).concat(k);
  }
  return out;
}
function secretEntries(secrets) { return Object.entries(secrets || {}).filter(([k, v]) => k !== "__tooShort" && typeof v === "string"); }
function secretValues(secrets) { return secretEntries(secrets).map(([, v]) => v); }

// The forms a secret can take on its way out: as is, URL-encoded, form-encoded.
function secretForms(v) {
  const forms = new Set([v]);
  try { forms.add(encodeURIComponent(v)); forms.add(encodeURIComponent(v).replace(/%20/g, "+")); } catch (e) {}
  return [...forms];
}

// Does this byte array contain one of the secrets (UTF-8)?
function bytesContainSecret(u8, values) {
  for (const v of values) {
    const needle = new TextEncoder().encode(v);
    if (!needle.length) continue;
    let i = u8.indexOf(needle[0]);
    while (i !== -1 && i + needle.length <= u8.length) {
      let j = 1;
      while (j < needle.length && u8[i + j] === needle[j]) j++;
      if (j === needle.length) return true;
      i = u8.indexOf(needle[0], i + 1);
    }
  }
  return false;
}

// Secret values never appear in what the model reads.
function redactSecrets(text, secrets) {
  let t = String(text);
  for (const [k, v] of secretEntries(secrets).sort((a, b) => b[1].length - a[1].length)) {
    for (const f of secretForms(v)) t = t.split(f).join("[secret " + k + "]");
  }
  return t;
}

function readSettings(us) {
  const s = (k) => String(us && us[k] != null ? us[k] : "").trim();
  const num = (k, d) => { const n = Number(s(k)); return n > 0 ? n : d; };
  const flag = (k, d) => { const v = s(k).toLowerCase(); return v ? !/^(off|false|0|no|disabled?)$/.test(v) : d; };
  return {
    corsProxy: s("corsProxy"),
    pyodideCdn: s("pyodideCdn"),
    sqljsCdn: s("sqljsCdn"),
    carry: flag("stateCarry", true),
    limitKB: num("stateLimitKB", STATE_LIMIT_KB_DEFAULT),
    fetchTimeoutMs: num("fetchTimeoutMs", 30000),
    bigWorkspace: flag("bigWorkspace", true),
    workspaceStore: s("workspaceStore"),
    execTimeoutS: num("execTimeoutSec", EXEC_TIMEOUT_S_DEFAULT),
    ttlMin: num("workspaceTtlMin", STATE_TTL_MIN_DEFAULT),
    publicProxies: flag("publicProxies", true),
    publicStores: flag("publicStores", false),
    keepVars: flag("keepVariables", true),
    importAttachments: flag("importAttachments", true),
    secrets: parseSecrets(us && us.secrets)
  };
}

function applyNetSettings(cfg) {
  globalThis.__crSecrets = Object.fromEntries(secretEntries(cfg.secrets));
  globalThis.__crCorsProxy = cfg.corsProxy;
  globalThis.__crFetchTimeout = cfg.fetchTimeoutMs;
  globalThis.__crNoPublicProxies = !cfg.publicProxies;
}

function capText(s) {
  s = String(s);
  if (s.length <= OUTPUT_HEAD + OUTPUT_TAIL + 200) return s;
  return s.slice(0, OUTPUT_HEAD) + "\n\n[... " + (s.length - OUTPUT_HEAD - OUTPUT_TAIL) + " characters of output omitted ...]\n\n" + s.slice(-OUTPUT_TAIL);
}

function networkNotes() {
  const log = globalThis.__crNetLog;
  if (!log || !log.size) return [];
  const lines = [...log].slice(0, 8).map(([h, why]) => "network: " + h + " - " + why);
  if (!globalThis.__crCorsProxy && [...log.values()].some((w) => /blocked/.test(w))) {
    lines.push("tip: sites that block browsers need the companion CORS proxy (plugin settings). Meanwhile prefer CORS-enabled sources: public APIs, raw.githubusercontent.com, cdn.jsdelivr.net, or https://r.jina.ai/<url> for a page's readable text");
  }
  return lines;
}

// Program output, file contents and error text are untrusted: a fetched web
// page could contain a fake state trailer that the next call would restore as
// the workspace. Only the plugin's own trailer, appended last, stays intact.
function defuseTrailers(s) {
  return String(s).replace(/\[\[cr-state:/g, "[[cr-state\u200b:");
}

function finish(out, ctx, trailer) {
  let text = capText(String(out == null ? "" : out)).replace(/\s+$/, "");
  if (!text) text = "(no output - print the values you need)";
  const notes = ctx.notes.concat(networkNotes());
  if (notes.length) text += "\n\n" + notes.map((n) => "(" + n + ")").join("\n");
  text = defuseTrailers(redactSecrets(text, globalThis.__crSecrets));
  const t = trailer === undefined ? ctx.incoming : trailer;
  if (t) text += "\n\n[[cr-state:" + t + "]]";
  return text;
}

// ---------------------------------------------------------------------------
// Remote languages
// ---------------------------------------------------------------------------
const CE_BASE = "https://godbolt.org";
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function fixSource(kind, code) {
  if (kind === "java") return code.replace(/^(\s*)public\s+((?:final\s+|abstract\s+|sealed\s+)*)(class|interface|enum|record)\b/gm, "$1$2$3");
  if (kind === "php") return /^\s*<\?php/.test(code) ? code : "<?php\n" + code;
  return code;
}

function ceText(a) { return (a || []).map((x) => String(x.text).replace(ANSI, "")).join("\n"); }

function formatCe(d) {
  const build = d.buildResult || {};
  if (!d.didExecute) {
    if (build.timedOut || d.timedOut) return "Compilation timed out on Compiler Explorer. Simplify the program.";
    const msg = [ceText(build.stderr), ceText(build.stdout), ceText(d.stderr)]
      .map((s) => s.replace(/^\s*Build failed\s*$/gm, "").replace(/<source>/g, "code").trim()).filter(Boolean).join("\n");
    return "Compilation failed:\n" + (msg || "(no compiler message)");
  }
  const parts = [];
  const so = ceText(d.stdout);
  const se = ceText(d.stderr).replace(/^\s*(Killed - processing time exceeded|Program terminated with signal: SIGKILL)\s*$/gm, "").trim();
  if (so.trim()) parts.push(so.replace(/\s+$/, ""));
  if (se) parts.push((so.trim() ? "stderr:\n" : "") + se);
  let text = parts.join("\n") || (d.timedOut ? "" : "(ran, no output)");
  if (d.timedOut) text += (text ? "\n" : "") + "(stopped: the program exceeded the remote run-time limit of a few seconds. Remote languages suit short programs; use python or javascript for long jobs.)";
  else if (d.code) text += "\n(exit code " + d.code + ")";
  if (d.truncated) text += "\n(output truncated by Compiler Explorer - print less)";
  return text;
}

// The caller's flags replace the defaults they overlap with (-O, -std=,
// --edition, -C opt-level=); other defaults (like -lm) stay.
function mergeArgs(defaults, extra) {
  extra = String(extra || "").trim();
  if (!extra) return defaults || "";
  const tokens = String(defaults || "").match(/(?:--edition|-C)\s+\S+|\S+/g) || [];
  const family = (t) => (/^-O/.test(t) ? "O" : /^-std=/.test(t) ? "std" : /^--edition/.test(t) ? "edition" : /opt-level=/.test(t) ? "opt" : null);
  const given = new Set((extra.match(/(?:--edition|-C)\s+\S+|\S+/g) || []).map(family).filter(Boolean));
  return tokens.filter((t) => !given.has(family(t))).concat(extra).join(" ").trim();
}

async function ceRun(spec, code, stdin) {
  const real = rawFetch();
  const body = JSON.stringify({
    source: fixSource(spec.fix, code),
    lang: spec.lang,
    options: {
      userArguments: spec.args || "",
      executeParameters: { args: [], stdin: stdin || "" },
      compilerOptions: { executorRequest: true, skipAsm: true },
      filters: { execute: true },
      tools: [],
      libraries: []
    },
    allowStoreCodeDebug: false
  });
  let r = null, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await timedFetch(real, CE_BASE + "/api/compiler/" + encodeURIComponent(spec.id) + "/compile",
        { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body }, 120000);
      if (r.status !== 429 && r.status < 500) break;
      lastErr = new Error("HTTP " + r.status);
    } catch (e) { lastErr = e; r = null; }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
  }
  if (!r) return { unavailable: "Compiler Explorer is unreachable (" + (lastErr && lastErr.message || "network error") + ")" };
  if (r.status === 404) return { notFound: true };
  if (r.status === 429 || r.status >= 500) return { unavailable: "Compiler Explorer returned HTTP " + r.status };
  const raw = await r.text();
  let d;
  try { d = JSON.parse(raw); } catch (e) { return { unavailable: "Compiler Explorer returned an unexpected response (HTTP " + r.status + ")" }; }
  return { text: formatCe(d) };
}

// Compilers for a language that can execute, newest first.
async function ceCompilers(spec) {
  const r = await timedFetch(rawFetch(), CE_BASE + "/api/compilers/" + encodeURIComponent(spec.lang) + "?fields=id,name,semver,supportsExecute",
    { headers: { "Accept": "application/json" } }, 30000);
  if (!r.ok) return null;
  const list = await r.json();
  const bad = /(trunk|nightly|snapshot|\bdev\b|assert|beta|\brc\b|latest|\bci\b|ildasm|ilspy|contracts|reflection|arm|aarch|risc|mips|power|s390|loong|sparc|avr|wasm|clang-cl|mingw)/i;
  const ver = (c) => (c.semver || (/(\d+(?:\.\d+)*)/.exec(c.name) || [, "0"])[1]).split(/\D+/).filter(Boolean).map((n) => n.padStart(6, "0")).join(".");
  const cands = list.filter((c) => c.supportsExecute && !bad.test(c.name) && !bad.test(c.id) && (!spec.pick || spec.pick.test(c.name)));
  cands.sort((a, b) => (ver(a) < ver(b) ? 1 : -1));
  return cands;
}

async function ceResolve(spec) {
  const cands = await ceCompilers(spec);
  return cands && cands.length ? cands[0].id : null;
}

// A requested version ("12", "gcc 13.2", "1.80", or an exact Compiler
// Explorer id) -> the newest matching compiler, or the list to choose from.
async function ceResolveVersion(spec, want) {
  want = String(want).trim().toLowerCase();
  let all = null;
  try { all = await ceCompilers({ ...spec, pick: null }); } catch (e) {}
  if (!all) return { error: "could not list the " + spec.lang + " compilers on Compiler Explorer" };
  const exact = all.find((c) => c.id.toLowerCase() === want);
  if (exact) return { id: exact.id, name: exact.name };
  const pool = all.filter((c) => !spec.pick || spec.pick.test(c.name));
  const words = want.split(/\s+/).filter(Boolean);
  const num = (words.find((w) => /^\d/.test(w)) || "").replace(/[^\d.]/g, "");
  const match = (c) => {
    const name = c.name.toLowerCase(), v = String(c.semver || (/(\d+(?:\.\d+)*)/.exec(c.name) || [, ""])[1]);
    const textOk = words.filter((w) => !/^\d/.test(w)).every((w) => name.includes(w));
    const numOk = !num || v === num || v.startsWith(num + ".");
    return textOk && numOk;
  };
  const hit = pool.find(match) || all.find(match);
  if (hit) return { id: hit.id, name: hit.name };
  const seen = new Set(), names = [];
  for (const c of pool.length ? pool : all) { const v = c.semver || c.name; if (!seen.has(v)) { seen.add(v); names.push(c.semver || c.name); } }
  return { error: "no " + spec.lang + " compiler matches version \"" + want + "\". Available: " + names.slice(0, 20).join(", ") };
}

async function wandboxList() {
  const lr = await timedFetch(rawFetch(), "https://wandbox.org/api/list.json", {}, 30000);
  return lr.ok ? await lr.json() : [];
}

async function wbRun(compiler, wbLang, code, stdin, fix, opts) {
  opts = opts || {};
  const real = rawFetch();
  const flags = String(opts.args || "").trim().split(/\s+/).filter(Boolean).join("\n");
  const post = (name) => timedFetch(real, "https://wandbox.org/api/compile.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ compiler: name, code: fixSource(fix, code), stdin: stdin || "", "compiler-option-raw": flags })
  }, 120000);
  if (opts.version && wbLang) {
    // A requested version: the Wandbox compiler of this language whose name contains it.
    try {
      const want = String(opts.version).trim().toLowerCase();
      const list = (await wandboxList()).filter((c) => c.language === wbLang);
      const hit = list.find((c) => c.name.toLowerCase() === want) || list.find((c) => c.name.toLowerCase().includes(want) || String(c.version || "").startsWith(want));
      if (!hit) return { text: "No " + wbLang + " compiler on Wandbox matches version \"" + opts.version + "\". Available: " + list.map((c) => c.name).slice(0, 20).join(", ") };
      compiler = hit.name;
    } catch (e) {}
  }
  let r;
  try { r = await post(compiler); } catch (e) { return { unavailable: "Wandbox is unreachable (" + (e.message || e) + ")" }; }
  if (!r.ok && wbLang) {
    // The pinned compiler may have been retired: pick the current one for the language.
    try {
      const list = await wandboxList();
      const alt = list.find((c) => c.language === wbLang && !/head/i.test(c.name));
      if (alt && alt.name !== compiler) r = await post(alt.name);
    } catch (e) {}
  }
  if (!r.ok) return { unavailable: "Wandbox returned HTTP " + r.status };
  let d;
  try { d = await r.json(); } catch (e) { return { unavailable: "Wandbox returned an unexpected response" }; }
  const po = String(d.program_output || ""), pe = String(d.program_error || "");
  const ce = String(d.compiler_error || ""), status = Number(d.status || 0);
  if (!po && !pe && ce && status !== 0) return { text: "Compilation failed:\n" + ce.trim() };
  let text = [po.replace(/\s+$/, ""), pe.trim() ? (po.trim() ? "stderr:\n" : "") + pe.trim() : ""].filter(Boolean).join("\n") || "(ran, no output)";
  if (d.signal) text += "\n(stopped by signal " + d.signal + (/kill/i.test(d.signal) ? " - probably the run-time limit" : "") + ")";
  else if (status) text += "\n(exit code " + status + ")";
  return { text };
}

async function runRemote(language, code, stdin, opts) {
  opts = opts || {};
  const ce0 = CE_LANGS[language] || (language === "ruby" ? RUBY_CE : null);
  if (ce0) {
    let ce = { ...ce0, args: mergeArgs(ce0.args, opts.args) };
    let chosen = "";
    if (opts.version) {
      const v = await ceResolveVersion(ce0, opts.version);
      if (v.error) return "Could not pick a compiler: " + v.error + ".";
      ce = { ...ce, id: v.id };
      chosen = "\n(compiler: " + v.name + ")";
    }
    let res = await ceRun(ce, code, stdin);
    if (res.notFound) {
      const id = await ceResolve(ce).catch(() => null);
      res = id && id !== ce.id ? await ceRun({ ...ce, id }, code, stdin) : { notFound: true };
      if (res.notFound) res = { unavailable: "the " + language + " compiler is no longer offered by Compiler Explorer" };
    }
    if (res.text != null) return res.text + chosen;
    if (ce.wb) {
      const wb = await wbRun(ce.wb, null, code, stdin, ce.fix, { args: opts.args });
      if (wb.text != null) return wb.text + "\n(ran on Wandbox: " + res.unavailable + ")";
      return "Could not run " + language + ": " + res.unavailable + ", and the Wandbox fallback failed too (" + wb.unavailable + "). This is a temporary service outage, not a problem with the code. Retry later, or solve it in python or javascript now.";
    }
    return "Could not run " + language + ": " + res.unavailable + ". This is a temporary service outage, not a problem with the code. Retry later, or solve it in python or javascript now.";
  }
  const wbSpec = language === "r" ? R_WANDBOX : WB_LANGS[language];
  const wb = await wbRun(wbSpec.compiler, wbSpec.wbLang, code, stdin, wbSpec.fix, opts);
  if (wb.text != null) return wb.text;
  return "Could not run " + language + ": " + wb.unavailable + ". " + language + " runs on Wandbox, a free public service that is currently failing. This is not a problem with the code. Use python or javascript instead.";
}

// ---------------------------------------------------------------------------
// Files coming in: the model's `files` parameter and the user's attachments
// ---------------------------------------------------------------------------
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? Math.ceil(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
function safeRel(p) {
  const rel = relPath(p);
  if (!rel || rel.split("/").some((seg) => seg === ".." || seg === "") || isInternal(rel)) return null;
  return rel;
}

function inlineFiles(list, notes) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const f of list.slice(0, 50)) {
    if (!f || typeof f !== "object") continue;
    const rel = safeRel(f.path || f.name);
    if (!rel) { notes.push("a file in `files` was skipped: give it a relative path such as data/input.csv"); continue; }
    const content = f.content == null ? "" : String(f.content);
    let bytes;
    if (String(f.encoding || "").toLowerCase() === "base64") {
      try { bytes = base64ToBytes(content.replace(/\s+/g, "")); }
      catch (e) { notes.push("`files` entry " + rel + " is not valid base64 and was skipped"); continue; }
    } else bytes = new TextEncoder().encode(content);
    out.push([rel, bytes]);
  }
  return out;
}

// TypingMind passes the attachments of the user's latest message (permission
// read_user_message). Each is saved once into /workspace/uploads; later calls
// in the same turn do not overwrite a copy the code has since changed.
async function importAttachments(resources, seen, notes) {
  const msg = resources && resources.userMessage;
  const list = msg && Array.isArray(msg.attachments) ? msg.attachments : [];
  const files = [], ids = [], used = new Set();
  for (const a of list.slice(0, 20)) {
    if (!a || typeof a.url !== "string" || !a.url) continue;
    const id = (await sha256Short(a.url + "|" + (a.name || ""))) || a.url.slice(-48);
    if (seen.has(id)) continue;
    let name = String(a.name || "").split(/[\\/]/).pop().replace(/[^\w.\- ()]+/g, "_").trim();
    if (/^\.*$/.test(name)) name = "";
    if (!name) name = "attachment_" + (files.length + 1) + "." + (String(a.type || "").split("/")[1] || "bin").replace(/[^\w]+/g, "");
    let unique = name, n = 2;
    while (used.has(unique)) unique = name.replace(/(\.[^.]*)?$/, " (" + n++ + ")$1");
    used.add(unique);
    try {
      let r;
      try { r = await timedFetch(rawFetch(), a.url, {}, 60000); }
      catch (e) { r = await netFetch(a.url); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length > MAX_CARRY_BYTES_STORE) throw new Error("larger than " + (MAX_CARRY_BYTES_STORE >> 20) + " MB");
      files.push([UPLOADS_DIR + "/" + unique, b]);
      ids.push(id);
    } catch (e) { notes.push("the attached file " + unique + " could not be read (" + (e.message || e) + ")"); }
  }
  if (files.length) {
    notes.push("the user's attached file" + (files.length > 1 ? "s were" : " was") + " saved to /workspace/" + UPLOADS_DIR + ": " +
      files.map(([p, b]) => p.slice(UPLOADS_DIR.length + 1) + " (" + fmtSize(b.length) + ")").join(", "));
  }
  return { files, ids };
}

function mergeFileLists(base, extra) {
  const m = new Map(base);
  for (const [p, b] of extra) m.set(p, b);
  return [...m];
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Each in-browser run is recorded (code and the start of its output) for the
// notebook export. The record has a size budget so it never crowds out files.
// It travels inline (it is small and changes every run), so its budget is a
// slice of the inline limit.
function addHistory(hist, entry, cfg) {
  const budget = Math.max(2048, Math.floor(cfg.limitKB * 1024 / 4));
  const list = (Array.isArray(hist) ? hist : []).concat([entry]);
  const size = () => new TextEncoder().encode(JSON.stringify(list)).length;
  if (size() > budget) { entry.code = entry.code.slice(0, 2000); entry.out = entry.out.slice(0, 600); }
  while (list.length > 1 && size() > budget) list.shift();
  return size() > budget ? hist || [] : list;
}

// A one-line summary of what the run changed in /workspace, so the model
// knows which files exist without listing them.
function workspaceChanges(before, after, notes) {
  const b = new Map(before.filter(([p]) => !isInternal(p)));
  const a = new Map(after.filter(([p]) => !isInternal(p)));
  const mentioned = notes.join(" ");
  const added = [], changed = [], removed = [];
  for (const [p, bytes] of a) {
    if (mentioned.includes(p)) continue;
    const o = b.get(p);
    if (!o) added.push(p + " (" + fmtSize(bytes.length) + ")");
    else if (!sameBytes(o, bytes)) changed.push(p + " (" + fmtSize(bytes.length) + ")");
  }
  for (const p of b.keys()) if (!a.has(p)) removed.push(p);
  const parts = [];
  const cap = (l) => l.slice(0, 12).join(", ") + (l.length > 12 ? ", ..." : "");
  if (added.length) parts.push("new " + cap(added));
  if (changed.length) parts.push("changed " + cap(changed));
  if (removed.length) parts.push("deleted " + cap(removed));
  return parts.length ? "files in /workspace: " + parts.join("; ") : null;
}

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------
async function run_code(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  try {
    return await runCodeInner(params || {}, userSettings || {}, resources || {}, ctx);
  } catch (e) {
    return finish("Code Runner failed before the code could finish: " + (e && e.message || e) + "\nRetry the call; if it fails again, try a simpler program.", ctx);
  }
}

async function runCodeInner(params, userSettings, resources, ctx) {
  const cfg = readSettings(userSettings);
  applyNetSettings(cfg);
  globalThis.__crNetLog = new Map();
  if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources.previousRunOutput));

  const language = normalizeLanguage(params.language);
  const code = typeof params.code === "string" ? params.code : params.code == null ? "" : String(params.code);
  if (!code.trim()) return finish("No code was provided. Put the complete program in `code`.", ctx);
  if (!language) return finish("Unsupported language \"" + params.language + "\". Supported: " + ALL_LANGS.join(", ") + ".", ctx);
  const stdin = params.stdin == null ? "" : String(params.stdin);
  const remoteOpts = { args: params.compiler_args, version: params.compiler_version };
  if (cfg.secrets.__tooShort) ctx.notes.push("secrets ignored because their values are shorter than 6 characters: " + cfg.secrets.__tooShort.join(", "));

  // Ruby with a specific version or flags runs on Compiler Explorer.
  if (!LOCAL_LANGS.includes(language) || (language === "ruby" && (params.compiler_version || params.compiler_args))) {
    // Remote languages never touch /workspace: the carried state passes through unchanged.
    if (Array.isArray(params.files) && params.files.length) ctx.notes.push("`files` are only written for the in-browser languages (python, javascript, typescript, sql, duckdb, r); remote programs get input through `stdin`");
    return finish(await runRemote(language, code, stdin, remoteOpts), ctx);
  }

  const timeoutS = Math.min(Math.max(Number(params.timeout) > 0 ? Number(params.timeout) : cfg.execTimeoutS, 5), 900);
  let restored = null;
  if (ctx.incoming) {
    try { restored = await restoreSnapshot(ctx.incoming, cfg); }
    catch (e) {
      ctx.notes.push("files from earlier calls are gone: " + (e.message || e) + ". /workspace started empty - recreate anything this code needs");
      ctx.incoming = null;
    }
  }
  let startFiles = restored ? restored.files : [];
  let att = restored ? restored.att || [] : [];
  let added = 0;
  if (cfg.importAttachments) {
    const imp = await importAttachments(resources, new Set(att), ctx.notes);
    startFiles = mergeFileLists(startFiles, imp.files);
    att = att.concat(imp.ids);
    added += imp.files.length;
  }
  const given = inlineFiles(params.files, ctx.notes);
  startFiles = mergeFileLists(startFiles, given);
  added += given.length;
  // Anything added here must survive even if the run itself fails or times out.
  if (added && cfg.carry) {
    const t = await buildTrailer({ files: startFiles, kv: restored ? restored.kv : {}, att, hist: restored ? restored.hist : [] }, cfg, []).catch(() => null);
    if (t) ctx.incoming = t;
  }

  const engine = createEngine({ noWorker: globalThis.__crNoWorker });
  try {
    await engine.ready();
    const init = await engine.call({
      op: "init",
      cfg: {
        corsProxy: cfg.corsProxy,
        noPublicProxies: !cfg.publicProxies,
        secrets: Object.fromEntries(secretEntries(cfg.secrets)),
        fetchTimeoutMs: cfg.fetchTimeoutMs,
        pyodideCdns: cdnCandidates(PYODIDE_CDNS, cfg.pyodideCdn),
        sqljsCdns: cdnCandidates(SQLJS_CDNS, cfg.sqljsCdn),
        babelCdns: BABEL_CDNS
      },
      files: startFiles,
      kv: restored ? restored.kv : {},
      hosts: hostHealthSnapshot()
    }, { timeoutMs: 60000 });
    if (!init.ok) return finish("Code Runner could not start: " + (init.error || "unknown error") + ". Retry the call.", ctx);

    let head = "", tail = "", dropped = 0;
    const onEvent = (m) => { if (m.ev === "out") head += m.s; else if (m.ev === "tail") { tail = m.s; dropped = m.dropped; } };
    const res = await engine.call({
      op: "run", lang: language, code, packages: params.packages, stdin,
      reset: params.reset === true || params.reset === "true", typecheck: params.typecheck === true || params.typecheck === "true",
      keepVars: cfg.keepVars,
      // Saved variables must not crowd real files out of the inline carry.
      stateBudget: cfg.bigWorkspace && (cfg.workspaceStore || cfg.publicStores) ? 20 * 1024 * 1024 : Math.max(4096, Math.floor(cfg.limitKB * 1024 / 3))
    },
      { onEvent, timeoutMs: RUNTIME_TIMEOUT_MS + 2 * SCRIPT_TIMEOUT_MS, execTimeoutMs: timeoutS * 1000 });
    if (res && res.tail != null) { tail = res.tail; dropped = res.dropped || 0; }
    const outputText = () => {
      if (!dropped) return head;
      const omitted = dropped - tail.length;
      return head + (omitted > 0 ? "\n\n[... " + omitted + " characters of output omitted ...]\n\n" : "") + tail;
    };

    if (res.timedOut) {
      const why = res.phase === "run"
        ? "stopped after the " + timeoutS + " s time limit (infinite loop, or too much work for one call)"
        : "stopped: the runtime did not finish loading in time (slow or blocked network)";
      return finish(outputText() + "\n\n(" + why + ". Changes to /workspace made during this call were discarded; files from before it are still there. Pass a larger `timeout`, or process less per call.)", ctx);
    }
    if (res.crashed) {
      return finish(outputText() + "\n\n(" + res.error + ". Changes to /workspace made during this call were discarded. Process the data in smaller pieces.)", ctx);
    }
    if (res.runtimeUnavailable && language === "r") {
      const wb = await wbRun(R_WANDBOX.compiler, R_WANDBOX.wbLang, code, stdin, null, remoteOpts);
      if (wb.text == null) return finish("Could not run R: " + res.runtimeUnavailable + "; the Wandbox fallback failed too (" + wb.unavailable + "). Retry later, or use python.", ctx);
      ctx.notes.push(res.runtimeUnavailable + ", so this ran on Wandbox instead: no /workspace files, no extra packages, variables not kept");
      return finish(wb.text, ctx);
    }
    if (res.runtimeUnavailable && language === "ruby") {
      ctx.notes.push(res.runtimeUnavailable + ", so this ran on Compiler Explorer instead: no /workspace files");
      return finish(await runRemote("ruby", code, stdin, remoteOpts), ctx);
    }
    if (res.runtimeUnavailable) return finish("Could not run " + language + ": " + res.runtimeUnavailable, ctx);

    for (const [h, why] of res.netLog || []) netNote(h, why);
    mergeHosts(res.hosts);
    let out = outputText();
    if (res.error) out = out.replace(/\s+$/, "") + (out.trim() ? "\n" : "") + res.error;
    for (const n of res.notes || []) ctx.notes.push(n);

    if (!cfg.carry) return finish(out, ctx, null);
    const snap = await engine.call({ op: "snapshot" }, { timeoutMs: 60000 });
    if (!snap.ok) {
      ctx.notes.push("the workspace could not be saved for the next call (" + (snap.error || "snapshot failed") + ")");
      return finish(out, ctx);
    }
    const change = workspaceChanges(startFiles, snap.files || [], ctx.notes);
    if (change) ctx.notes.push(change);
    const shown = redactSecrets(out, cfg.secrets);
    const entry = { t: Date.now(), lang: language, code: redactSecrets(code.slice(0, 20000), cfg.secrets), out: shown.length > 4000 ? shown.slice(0, 3000) + "\n...\n" + shown.slice(-900) : shown };
    const hist = addHistory(restored ? restored.hist : [], entry, cfg);
    const trailer = await buildTrailer({ ...snap, att, hist }, cfg, ctx.notes);
    return finish(out, ctx, trailer);
  } finally {
    engine.terminate();
  }
}

// ---------------------------------------------------------------------------
// serve_file: render a /workspace file for the user (render_markdown output).
// The carried state passes through in an invisible HTML comment.
// ---------------------------------------------------------------------------
const MIME_BY_EXT = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", geojson: "application/json", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  toml: "text/plain", ini: "text/plain", html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", py: "text/x-python", sql: "text/plain",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  sqlite: "application/x-sqlite3", db: "application/x-sqlite3", parquet: "application/octet-stream",
  bin: "application/octet-stream"
};
const FENCE_BY_EXT = { json: "json", geojson: "json", md: "markdown", csv: "csv", py: "python", js: "javascript", ts: "typescript", html: "html", css: "css", xml: "xml", yaml: "yaml", yml: "yaml", sql: "sql", toml: "toml" };

function extOf(name) { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i + 1).toLowerCase() : ""; }
function guessMime(name) { return MIME_BY_EXT[extOf(name)] || "application/octet-stream"; }
function relPath(path) {
  path = String(path == null ? "" : path).trim().replace(/\\/g, "/");
  if (path.startsWith(WORKDIR + "/")) path = path.slice(WORKDIR.length + 1);
  return path.replace(/^\/+/, "").replace(/^(\.\/)+/, "");
}
function mdEscape(s) { return String(s).replace(/([\\`*_\[\]()<>])/g, "\\$1"); }

function serveFinish(md, ctx) {
  md = defuseTrailers(md);
  return ctx.incoming ? md + "\n\n<!--[[cr-state:" + ctx.incoming + "]]-->" : md;
}

async function serve_file(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  try {
    const cfg = readSettings(userSettings);
    applyNetSettings(cfg);
    if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
    params = params || {};
    const path = params.path || params.file || params.filename;
    if (!path) return serveFinish("**serve_file:** no `path` was given. Pass the path of a file in /workspace, e.g. `report.csv`.", ctx);
    const rel = relPath(path);

    let snap = null;
    if (ctx.incoming) {
      try { snap = await restoreSnapshot(ctx.incoming, cfg); }
      catch (e) { return serveFinish("**serve_file:** the workspace could not be loaded (" + (e.message || e) + "). Recreate `" + rel + "` with run_code, then call serve_file right after.", ctx); }
    }
    const hit = snap && snap.files.find(([p]) => p === rel);
    if (!hit) {
      const names = snap ? snap.files.map(([p]) => p).filter((p) => !isInternal(p)) : [];
      return serveFinish("**serve_file:** `" + rel + "` is not in /workspace. " +
        (names.length ? "Files available: " + names.slice(0, 40).map((n) => "`" + n + "`").join(", ") + "."
                      : "/workspace is empty - create the file with run_code first, in the call right before serve_file."), ctx);
    }
    const bytes = hit[1];
    const name = String(params.filename || rel.split("/").pop() || "file");
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(params.mime || "")) ? String(params.mime).toLowerCase() : guessMime(name);
    const kb = Math.max(1, Math.ceil(bytes.length / 1024));
    const size = kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    if (bytes.length > SERVE_MAX_BYTES) {
      return serveFinish("**serve_file:** `" + rel + "` is " + size + ", too large to embed in the chat (limit " + (SERVE_MAX_BYTES >> 20) + " MB). Compress it (zip) or reduce it with run_code first.", ctx);
    }
    const dataURI = "data:" + mime + ";base64," + bytesToBase64(bytes);
    const link = "[Download " + mdEscape(name) + " (" + size + ")](" + dataURI + ")";
    const mode = String(params.as || "auto").toLowerCase();
    const isImage = /^image\//.test(mime);
    const isText = /^text\//.test(mime) || /^application\/(json|xml)$/.test(mime);

    let md;
    if (mode === "link") md = link;
    else if (mode === "image" || (mode === "auto" && isImage)) md = "![" + mdEscape(name) + "](" + dataURI + ")\n\n" + link;
    else if (mode === "text" || (mode === "auto" && isText && bytes.length <= 64 * 1024)) {
      const text = new TextDecoder().decode(bytes);
      const fence = text.includes("```") ? "~~~~" : "```";
      md = fence + (FENCE_BY_EXT[extOf(name)] || "") + "\n" + text.replace(/\s+$/, "") + "\n" + fence + "\n\n" + link;
    } else md = link;
    return serveFinish(md, ctx);
  } catch (e) {
    return serveFinish("**serve_file failed:** " + (e && e.message || e) + ". Retry, or recreate the file with run_code.", ctx);
  }
}

// ---------------------------------------------------------------------------
// Browser bridge (browser_run, browser_tabs)
// ---------------------------------------------------------------------------
// These two functions reach OUT of the sandboxed plugin iframe to a small
// companion Chrome extension (extension/ folder of this repository), which the
// user loads unpacked. The extension injects a content script into this very
// frame; we talk to it with window.postMessage and it drives chrome.tabs /
// chrome.scripting on our behalf. With no extension present the ping times out
// and we return install instructions instead of hanging.

const BROWSER_PING_MS = 800;
const BROWSER_CALL_MS = 20000;

function browserBridgeCall(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const id = "crb" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const onMsg = (e) => {
      const d = e && e.data;
      if (!d || d.__crbRes !== true || d.id !== id) return;
      settled = true;
      try { removeEventListener("message", onMsg); } catch (x) {}
      resolve(d.response || { ok: false, error: "empty response from the bridge" });
    };
    try { addEventListener("message", onMsg); } catch (x) { return resolve({ ok: false, error: "no window messaging in this runtime" }); }
    try { postMessage({ __crbReq: true, id, request }, "*"); }
    catch (x) { try { removeEventListener("message", onMsg); } catch (y) {} return resolve({ ok: false, error: "could not post to the bridge: " + (x && x.message || x) }); }
    setTimeout(() => {
      if (settled) return;
      try { removeEventListener("message", onMsg); } catch (x) {}
      resolve({ ok: false, error: "__timeout" });
    }, timeoutMs || BROWSER_CALL_MS);
  });
}

const BROWSER_INSTALL_HINT =
  "The Code Runner browser bridge extension is not responding, so tabs cannot be reached.\n" +
  "One-time setup (Chrome/Chromium, desktop):\n" +
  "1. Get this plugin's repository and open chrome://extensions .\n" +
  "2. Turn on \"Developer mode\" (top right).\n" +
  "3. Click \"Load unpacked\" and select the extension/ folder.\n" +
  "4. Make sure the extension is enabled, then reload the TypingMind tab and try again.\n" +
  "Note: it is Chrome-only and works on desktop, not mobile.";

async function browserReady(ctx) {
  const pong = await browserBridgeCall({ op: "ping" }, BROWSER_PING_MS);
  if (pong && pong.ok) return true;
  return false;
}

function browserFinish(md, ctx) {
  // Like serve_file: these tools never touch /workspace, so carry the incoming
  // state trailer straight through so interleaving them does not lose files.
  // Page text and console output are untrusted: defuse any fake state marker.
  md = defuseTrailers(md);
  return ctx.incoming ? md + "\n\n[[cr-state:" + ctx.incoming + "]]" : md;
}

function browserPrelude(userSettings, resources) {
  const ctx = { incoming: null };
  try {
    const cfg = readSettings(userSettings || {});
    if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
  } catch (e) {}
  return ctx;
}

async function browser_run(params, userSettings, resources) {
  const ctx = browserPrelude(userSettings, resources);
  try {
    params = params || {};
    const code = typeof params.code === "string" ? params.code : params.code == null ? "" : String(params.code);
    if (!code.trim()) return browserFinish("**browser_run:** no `code` was given. Pass JavaScript to run in the tab, e.g. `return document.title;`.", ctx);
    if (!(await browserReady(ctx))) return browserFinish(BROWSER_INSTALL_HINT, ctx);

    const timeoutMs = Math.min(Math.max((Number(params.timeout) || 15) * 1000, 1000), 120000);
    const req = { op: "run", code, timeoutMs };
    if (params.tabId != null) req.tabId = Number(params.tabId);

    const r = await browserBridgeCall(req, timeoutMs + 4000);
    if (r.error === "__timeout") return browserFinish("**browser_run:** the tab did not answer in time. The script may be running an infinite loop, or the tab is busy. Try a smaller script or a larger `timeout`.", ctx);
    if (!r.ok) return browserFinish("**browser_run failed:** " + (r.error || "unknown error") + ".", ctx);

    let out = "tab " + r.tabId;
    out += "\n\nresult: " + (r.result === undefined ? "undefined" : r.result);
    if (r.logs && r.logs.length) out += "\n\nconsole:\n" + r.logs.join("\n");
    if (r.error) out += "\n\nerror: " + r.error;
    return browserFinish(out, ctx);
  } catch (e) {
    return browserFinish("**browser_run failed:** " + (e && e.message || e) + ".", ctx);
  }
}

async function browser_tabs(params, userSettings, resources) {
  const ctx = browserPrelude(userSettings, resources);
  try {
    params = params || {};
    const action = String(params.action || "list").toLowerCase();
    const map = { list: "tabs.list", activate: "tabs.activate", open: "tabs.open", close: "tabs.close", reload: "tabs.reload", navigate: "tabs.navigate" };
    const op = map[action];
    if (!op) return browserFinish("**browser_tabs:** unknown action \"" + params.action + "\". Use one of: " + Object.keys(map).join(", ") + ".", ctx);
    if (!(await browserReady(ctx))) return browserFinish(BROWSER_INSTALL_HINT, ctx);

    const req = { op };
    if (params.tabId != null) req.tabId = Number(params.tabId);
    if (params.url != null) req.url = String(params.url);
    if (params.active != null) req.active = !!params.active;
    if (params.allWindows != null) req.allWindows = !!params.allWindows;

    const r = await browserBridgeCall(req, BROWSER_CALL_MS);
    if (r.error === "__timeout") return browserFinish("**browser_tabs:** the extension did not answer in time. Reload the TypingMind tab and try again.", ctx);
    if (!r.ok) return browserFinish("**browser_tabs failed:** " + (r.error || "unknown error") + ".", ctx);

    if (op === "tabs.list") {
      const rows = (r.tabs || []).map((t) => "#" + t.id + (t.active ? " *" : "  ") + " " + (t.title || "(untitled)") + "  -  " + t.url);
      return browserFinish(rows.length ? "Open tabs (id, * = active):\n" + rows.join("\n") : "No tabs found.", ctx);
    }
    if (op === "tabs.close") return browserFinish("Closed tab " + r.closed + ".", ctx);
    if (op === "tabs.reload") return browserFinish("Reloaded tab " + r.tab + ".", ctx);
    const t = r.tab || {};
    return browserFinish((action === "open" ? "Opened" : action === "navigate" ? "Navigated" : "Activated") + " tab #" + t.id + ": " + (t.title || t.url || ""), ctx);
  } catch (e) {
    return browserFinish("**browser_tabs failed:** " + (e && e.message || e) + ".", ctx);
  }
}

// ---------------------------------------------------------------------------
// manage_files: list, delete, rename or clear /workspace without running code.
// ---------------------------------------------------------------------------
function globToRegex(g) {
  return new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$");
}

function savedStateSummary(files) {
  const has = (p) => files.some(([f]) => f === p || f.startsWith(p + "/"));
  const out = [];
  if (has(PY_SESSION_REL)) out.push("Python variables");
  if (has(".cr/session.RData")) out.push("R variables");
  if (has(".cr/duck")) out.push("DuckDB tables");
  const shared = files.map(([f]) => /^\.cr\/tables\/(.+)\.csv$/.exec(f)).filter(Boolean).map((m) => m[1]);
  if (shared.length) out.push("shared tables " + shared.join(", "));

  return out;
}

// The recorded runs as a Jupyter notebook (Python cells run as code, other
// languages as annotated code blocks) or as Markdown.
function buildNotebook(history, format) {
  const lines = (t) => String(t).split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
  const fence = (lang, body) => { const f = String(body).includes("```") ? "~~~~" : "```"; return f + lang + "\n" + String(body).replace(/\s+$/, "") + "\n" + f; };
  const names = { python: "Python", javascript: "JavaScript", typescript: "TypeScript", sql: "SQL (SQLite)", duckdb: "DuckDB", r: "R", ruby: "Ruby" };
  if (format === "markdown") {
    const parts = ["# Code Runner session", ""];
    history.forEach((h, i) => {
      parts.push("## " + (i + 1) + ". " + (names[h.lang] || h.lang) + (h.t ? " (" + new Date(h.t).toISOString().slice(0, 16).replace("T", " ") + " UTC)" : ""), "",
        fence(h.lang === "duckdb" ? "sql" : h.lang, h.code), "");
      if (h.out) parts.push("Output:", "", fence("", h.out), "");
    });
    return parts.join("\n");
  }
  const cells = [{ cell_type: "markdown", id: "cr-title", metadata: {}, source: lines("# Code Runner session\n\nExported from TypingMind. Python cells can be re-run; other languages are kept as annotated code blocks.") }];
  history.forEach((h, i) => {
    if (h.lang === "python") {
      cells.push({ cell_type: "code", id: "cr-" + i, execution_count: i + 1, metadata: {}, source: lines(h.code),
        outputs: h.out ? [{ output_type: "stream", name: "stdout", text: lines(h.out) }] : [] });
    } else {
      cells.push({ cell_type: "markdown", id: "cr-" + i, metadata: {},
        source: lines("**" + (names[h.lang] || h.lang) + "**\n\n" + fence(h.lang === "duckdb" ? "sql" : h.lang, h.code) + (h.out ? "\n\nOutput:\n\n" + fence("", h.out) : "")) });
    }
  });
  return JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
    cells
  }, null, 1);
}

async function manage_files(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  try {
    params = params || {};
    const cfg = readSettings(userSettings || {});
    applyNetSettings(cfg);
    globalThis.__crNetLog = new Map();
    if (!cfg.carry) return finish("Persisting /workspace between calls is turned off in the plugin settings, so there are no saved files to manage.", ctx, null);
    ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
    let snap = { files: [], kv: {}, att: [] };
    if (ctx.incoming) {
      try { snap = await restoreSnapshot(ctx.incoming, cfg); }
      catch (e) { ctx.incoming = null; return finish("The saved workspace could not be loaded (" + (e.message || e) + "). /workspace is empty.", ctx, null); }
    }
    let files = snap.files.slice(), att = snap.att || [];
    if (cfg.importAttachments) {
      const imp = await importAttachments(resources, new Set(att), ctx.notes);
      files = mergeFileLists(files, imp.files);
      att = att.concat(imp.ids);
    }
    const action = String(params.action || "list").toLowerCase();
    let kv = snap.kv || {}, text = "";
    const visible = () => files.filter(([p]) => !isInternal(p));

    if (action === "delete") {
      const pats = [].concat(params.paths || params.path || []).map(String).filter(Boolean);
      if (!pats.length) return finish("manage_files delete: pass `paths`, e.g. [\"old.csv\", \"tmp/*\", \"out/\"].", ctx);
      const removed = [], missing = [];
      for (const raw of pats) {
        const rel = relPath(raw);
        const re = /[*?]/.test(rel) ? globToRegex(rel) : null;
        const dir = rel.endsWith("/") ? rel : rel + "/";
        const hit = files.filter(([p]) => !isInternal(p) && (re ? re.test(p) : p === rel || p.startsWith(dir)));
        if (!hit.length) { missing.push(raw); continue; }
        for (const [p] of hit) removed.push(p);
        files = files.filter(([p]) => !hit.some(([h]) => h === p));
      }
      text = (removed.length ? "Deleted " + removed.length + " file" + (removed.length === 1 ? "" : "s") + ": " + removed.slice(0, 30).join(", ") + (removed.length > 30 ? ", ..." : "") + "." : "Nothing was deleted.") +
        (missing.length ? " Not found: " + missing.join(", ") + "." : "");
    } else if (action === "rename" || action === "move") {
      const from = relPath(params.from || params.path || "").replace(/\/$/, ""), to = safeRel(params.to || "");
      if (!from || !to || isInternal(from)) return finish("manage_files rename: pass `from` and `to` (relative paths in /workspace).", ctx);
      const dir = from + "/";
      const hit = files.filter(([p]) => p === from || p.startsWith(dir));
      const dest = (p) => (p === from ? to : to.replace(/\/$/, "") + "/" + p.slice(dir.length));
      const taken = hit.map(([p]) => dest(p)).filter((d) => files.some(([q]) => q === d && !hit.some(([h]) => h === q)));
      if (!hit.length) text = "`" + from + "` is not in /workspace.";
      else if (taken.length) text = "Not renamed: " + taken.slice(0, 10).join(", ") + " already exist" + (taken.length === 1 ? "s" : "") + ". Delete or rename " + (taken.length === 1 ? "it" : "them") + " first.";
      else {
        files = files.map(([p, b]) => [p === from ? to : p.startsWith(dir) ? to.replace(/\/$/, "") + "/" + p.slice(dir.length) : p, b]);
        files = [...new Map(files)];
        text = "Renamed " + from + " -> " + to + (hit.length > 1 ? " (" + hit.length + " files)" : "") + ".";
      }
    } else if (action === "clear") {
      const keepVars = params.keep_variables === true || params.keep_variables === "true";
      const n = visible().length;
      files = keepVars ? files.filter(([p]) => isInternal(p)) : [];
      if (!keepVars) kv = {};
      text = "Cleared /workspace (" + n + " file" + (n === 1 ? "" : "s") + ")" + (keepVars ? "; saved variables kept." : ", saved Python/R variables, DuckDB tables and JavaScript storage.");
    } else if (action === "reset_variables") {
      files = files.filter(([p]) => !isInternal(p));
      text = "Saved Python/R variables and DuckDB tables were cleared; files are kept.";
    } else if (action === "export_notebook") {
      const list = snap.hist || [];
      if (!list.length) return finish("There are no recorded runs to export yet (runs in the in-browser languages are recorded; remote languages are not).", ctx);
      const format = String(params.format || "ipynb").toLowerCase() === "markdown" ? "markdown" : "ipynb";
      const out = safeRel(params.path || (format === "markdown" ? "notebook.md" : "notebook.ipynb"));
      if (!out) return finish("manage_files export_notebook: `path` must be a relative path in /workspace.", ctx);
      files = mergeFileLists(files, [[out, new TextEncoder().encode(buildNotebook(list, format))]]);
      text = "Wrote " + out + " with " + list.length + " run" + (list.length === 1 ? "" : "s") + ". Call serve_file to give it to the user, or preview_file to show it.";
    } else if (action !== "list") {
      return finish("Unknown action \"" + action + "\". Use list, delete, rename, clear, reset_variables or export_notebook.", ctx);
    }

    const rows = visible().sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const total = rows.reduce((n, [, b]) => n + b.length, 0);
    const listing = rows.length
      ? "/workspace (" + rows.length + " file" + (rows.length === 1 ? "" : "s") + ", " + fmtSize(total) + "):\n" +
        rows.slice(0, 200).map(([p, b]) => "  " + p + "  " + fmtSize(b.length)).join("\n") + (rows.length > 200 ? "\n  ... " + (rows.length - 200) + " more" : "")
      : "/workspace is empty.";
    const saved = savedStateSummary(files);
    const keys = Object.keys(kv);
    if (snap.hist && snap.hist.length) saved.push(snap.hist.length + " recorded runs for export_notebook");
    const extra = [saved.length ? "saved between calls: " + saved.join(", ") : "", keys.length ? "JavaScript storage keys: " + keys.slice(0, 20).join(", ") : ""].filter(Boolean);
    const out = (text ? text + "\n\n" : "") + listing + (extra.length ? "\n(" + extra.join("; ") + ")" : "");
    if (action === "list" && files === snap.files) return finish(out, ctx);
    const trailer = await buildTrailer({ files, kv, att, hist: action === "clear" && !(params.keep_variables === true || params.keep_variables === "true") ? [] : snap.hist }, cfg, ctx.notes);
    return finish(out, ctx, trailer);
  } catch (e) {
    return finish("manage_files failed: " + (e && e.message || e), ctx);
  }
}

// ---------------------------------------------------------------------------
// preview_file: an interactive view of a /workspace file (render_html output):
// sortable, filterable tables for CSV/TSV/JSON/XLSX, live HTML pages, audio and
// video players, rendered Markdown, images and PDFs.
// ---------------------------------------------------------------------------
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

function previewKind(name, mime, as) {
  const ext = extOf(name);
  if (as && as !== "auto") return as;
  if (["csv", "tsv"].includes(ext)) return "table";
  if (["xlsx", "xls", "ods", "xlsm"].includes(ext)) return "sheet";
  if (ext === "parquet") return "parquet";
  if (["sqlite", "sqlite3", "db"].includes(ext)) return "sqlite";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "ipynb") return "notebook";
  if (ext === "json" || ext === "geojson" || ext === "jsonl" || ext === "ndjson") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "pdf") return "pdf";
  if (/^image\//.test(mime)) return "image";
  if (/^audio\//.test(mime)) return "audio";
  if (/^video\//.test(mime)) return "video";
  if (/^text\//.test(mime) || /^application\/(json|xml)$/.test(mime) || ["py", "js", "ts", "sql", "toml", "ini", "log", "yaml", "yml", "r", "txt"].includes(ext)) return "text";
  return "download";
}

function previewHtml(name, mime, kind, bytes) {
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const data = JSON.stringify({ name, mime, kind, b64: bytesToBase64(bytes) }).replace(/</g, "\\u003c");
  // String.raw: the page script's own escapes (\n, \t in regexes and strings) must reach it as written.
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d0d7de;--head:#f6f8fa;--hi:#fff8c5;--acc:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--head:#161b22;--hi:#3b2e00;--acc:#4493f8}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}header b{font-size:15px;word-break:break-all}.mut{color:var(--mut);font-size:12px}
input[type=search]{flex:1;min-width:160px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.wrap{max-height:70vh;overflow:auto;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:max-content;min-width:100%;font-size:13px}th,td{padding:4px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
th{position:sticky;top:0;background:var(--head);cursor:pointer;user-select:none}th:hover{color:var(--acc)}td.num{text-align:right;font-variant-numeric:tabular-nums}tr:hover td{background:var(--hi)}
pre{margin:0;padding:10px;overflow:auto;max-height:75vh;border:1px solid var(--line);border-radius:6px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
img,video{max-width:100%;border-radius:6px}audio{width:100%}iframe,embed{width:100%;height:75vh;border:1px solid var(--line);border-radius:6px;background:#fff}
.md{max-width:900px}.md table{width:auto}.md pre{max-height:none}a{color:var(--acc)}button{padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--head);color:var(--fg);cursor:pointer}
</style></head><body><header><b id="t"></b><span class="mut" id="m"></span></header><main id="v">Loading...</main>
<script id="d" type="application/json">${data}</script>
<script>
(async () => {
const D = JSON.parse(document.getElementById("d").textContent);
const bin = atob(D.b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const blobUrl = () => URL.createObjectURL(new Blob([bytes], { type: D.mime }));
const text = () => new TextDecoder().decode(bytes);
const v = document.getElementById("v"), m = document.getElementById("m");
document.getElementById("t").textContent = D.name;
const size = bytes.length < 1024 ? bytes.length + " B" : bytes.length < 1048576 ? Math.ceil(bytes.length / 1024) + " KB" : (bytes.length / 1048576).toFixed(1) + " MB";
m.textContent = size;
const el = (tag, props, kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids || []) e.append(k); return e; };
const dl = () => el("a", { href: blobUrl(), download: D.name, textContent: "Download " + D.name });
const load = (src) => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src)); document.head.append(s); });

function parseDelimited(src) {
  const first = src.split(/\r?\n/, 1)[0];
  const cands = ["\t", ",", ";", "|"];
  const d = D.name.toLowerCase().endsWith(".tsv") ? "\t" : cands.map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"' && cur === "") q = true;
    else if (c === d) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function table(head, rows, note) {
  const LIMIT = 2000;
  let sortCol = -1, dir = 1, filter = "";
  const isNum = head.map((_, c) => { let n = 0, t = 0; for (const r of rows.slice(0, 200)) { const x = r[c]; if (x === "" || x == null) continue; t++; if (!isNaN(Number(String(x).replace(/,/g, "")))) n++; } return t > 0 && n / t > 0.9; });
  const search = el("input", { type: "search", placeholder: "Filter " + rows.length.toLocaleString() + " rows..." });
  const info = el("span", { className: "mut info" });
  const wrap = el("div", { className: "wrap" });
  const hdr = document.querySelector("header"); hdr.append(search, info);
  function render() {
    let list = filter ? rows.filter((r) => r.some((x) => String(x).toLowerCase().includes(filter))) : rows.slice();
    if (sortCol >= 0) list.sort((a, b) => { let x = a[sortCol], y = b[sortCol]; if (isNum[sortCol]) { x = Number(String(x).replace(/,/g, "")); y = Number(String(y).replace(/,/g, "")); x = isNaN(x) ? -Infinity : x; y = isNaN(y) ? -Infinity : y; return (x - y) * dir; } return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir; });
    const t = el("table"), th = el("tr");
    head.forEach((h, c) => th.append(el("th", { textContent: h + (sortCol === c ? (dir > 0 ? " ▲" : " ▼") : ""), title: "Sort by " + h, onclick: () => { dir = sortCol === c ? -dir : 1; sortCol = c; render(); } })));
    t.append(el("thead", {}, [th]));
    const tb = el("tbody");
    for (const r of list.slice(0, LIMIT)) { const tr = el("tr"); head.forEach((_, c) => { const x = r[c] == null ? "" : String(r[c]); tr.append(el("td", { textContent: x, title: x.length > 40 ? x : "", className: isNum[c] ? "num" : "" })); }); tb.append(tr); }
    t.append(tb); wrap.replaceChildren(t);
    info.textContent = (filter ? list.length.toLocaleString() + " of " : "") + rows.length.toLocaleString() + " rows · " + head.length + " columns" + (list.length > LIMIT ? " · first " + LIMIT + " shown" : "") + (note ? " · " + note : "");
  }
  search.oninput = () => { filter = search.value.trim().toLowerCase(); render(); };
  render(); v.replaceChildren(wrap);
}

function objectsTable(list) {
  const head = [...new Set(list.flatMap((o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : ["value"])))];
  table(head, list.map((o) => head.map((h) => { const x = o && typeof o === "object" && !Array.isArray(o) ? o[h] : o; return x !== null && typeof x === "object" ? JSON.stringify(x) : x; })));
}

try {
  if (D.kind === "table") { const rows = parseDelimited(text()); if (!rows.length) v.textContent = "(empty file)"; else table(rows[0], rows.slice(1)); }
  else if (D.kind === "sheet") {
    await load("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    const wb = XLSX.read(bytes, { type: "array" });
    let current = wb.SheetNames[0];
    const formulas = el("input", { type: "checkbox", title: "Show formulas" });
    const rowsOf = (ws) => {
      if (!formulas.checked) return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      if (!ws["!ref"]) return [];
      const r = XLSX.utils.decode_range(ws["!ref"]), out = [];
      for (let R = r.s.r; R <= r.e.r; R++) { const row = []; for (let C = r.s.c; C <= r.e.c; C++) { const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]; row.push(!c ? "" : c.f ? "=" + c.f : c.w != null ? c.w : c.v); } out.push(row); }
      return out;
    };
    const show = (n) => { current = n; const rows = rowsOf(wb.Sheets[n]); document.querySelectorAll("header input[type=search],header .info").forEach((e) => e.remove()); if (!rows.length) v.textContent = "(empty sheet)"; else table(rows[0].map(String), rows.slice(1), "sheet " + n); };
    formulas.onchange = () => show(current);
    if (wb.SheetNames.length > 1) { const sel = el("select", { onchange: () => show(sel.value) }, wb.SheetNames.map((n) => el("option", { value: n, textContent: n }))); document.querySelector("header").append(sel); }
    document.querySelector("header").append(el("label", { className: "mut" }, [formulas, " formulas"]));
    show(current);
  }
  else if (D.kind === "parquet") {
    const { parquetReadObjects } = await import("https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm");
    const rows = await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    if (!rows.length) v.textContent = "(no rows)"; else objectsTable(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x instanceof Date ? x.toISOString() : x]))));
  }
  else if (D.kind === "sqlite") {
    await load("https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.js");
    const SQL = await initSqlJs({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/" + f });
    const db = new SQL.Database(bytes);
    const names = (db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")[0] || { values: [] }).values.map((r) => r[0]);
    if (!names.length) v.textContent = "(no tables)";
    else {
      const show = (n) => {
        document.querySelectorAll("header input[type=search], header .info").forEach((e) => e.remove());
        const count = db.exec('SELECT count(*) FROM "' + n.replace(/"/g, '""') + '"')[0].values[0][0];
        const r = db.exec('SELECT * FROM "' + n.replace(/"/g, '""') + '" LIMIT 5000')[0];
        if (!r) { v.textContent = "(" + n + " is empty)"; return; }
        table(r.columns, r.values.map((row) => row.map((x) => (x instanceof Uint8Array ? "<blob " + x.length + " bytes>" : x))), "table " + n + (count > 5000 ? " \u00b7 first 5000 of " + count : ""));
      };
      if (names.length > 1) { const sel = el("select", { onchange: () => show(sel.value) }, names.map((n) => el("option", { value: n, textContent: n }))); document.querySelector("header").append(sel); }
      show(names[0]);
    }
  }
  else if (D.kind === "docx") {
    await load("https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js");
    const r = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const d = el("div", { className: "md" }); d.innerHTML = r.value; d.querySelectorAll("script").forEach((s) => s.remove());
    v.replaceChildren(d, el("p", {}, [dl()]));
  }
  else if (D.kind === "pptx") {
    await load("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const box = el("div", { className: "md" });
    for (const [i, f] of slides.entries()) {
      const xml = new DOMParser().parseFromString(await zip.file(f).async("string"), "application/xml");
      const paras = [...xml.getElementsByTagName("a:p")].map((p) => [...p.getElementsByTagName("a:t")].map((t) => t.textContent).join("")).filter((t) => t.trim());
      box.append(el("h3", { textContent: "Slide " + (i + 1) }), el("div", {}, paras.map((t, j) => el(j === 0 ? "p" : "li", { textContent: t }))));
    }
    v.replaceChildren(box, el("p", {}, [dl()]));
  }
  else if (D.kind === "notebook") {
    const nb = JSON.parse(text());
    try { await load("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"); } catch (e) {}
    const src = (x) => (Array.isArray(x) ? x.join("") : String(x || ""));
    const box = el("div", { className: "md" });
    for (const c of nb.cells || []) {
      if (c.cell_type === "markdown") { const d = el("div"); d.innerHTML = typeof marked !== "undefined" ? marked.parse(src(c.source)) : ""; if (typeof marked === "undefined") d.textContent = src(c.source); d.querySelectorAll("script").forEach((s) => s.remove()); box.append(d); }
      else if (c.cell_type === "code") {
        box.append(el("pre", { textContent: src(c.source) }));
        for (const o of c.outputs || []) {
          const data = o.data || {};
          if (data["image/png"]) box.append(el("img", { src: "data:image/png;base64," + src(data["image/png"]).replace(/\s+/g, "") }));
          else { const t = o.text || data["text/plain"] || (o.output_type === "error" ? (o.ename + ": " + o.evalue) : ""); if (t) box.append(el("pre", { textContent: src(t), style: "opacity:.8" })); }
        }
      }
    }
    v.replaceChildren(box);
  }
  else if (D.kind === "json") {
    const t = text(); let val;
    try { val = JSON.parse(t); } catch (e) { val = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    const arr = Array.isArray(val) ? val : val && Array.isArray(val.features) ? val.features.map((f) => ({ ...(f.properties || {}), geometry: f.geometry && f.geometry.type })) : null;
    if (arr && arr.length && arr.every((o) => o !== null && typeof o === "object")) objectsTable(arr);
    else v.replaceChildren(el("pre", { textContent: JSON.stringify(val, null, 2) }));
  }
  else if (D.kind === "html") { const f = el("iframe", { sandbox: "allow-scripts allow-popups allow-forms allow-modals" }); f.srcdoc = text(); v.replaceChildren(f); }
  else if (D.kind === "markdown") {
    try { await load("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"); const d = el("div", { className: "md" }); d.innerHTML = marked.parse(text()); d.querySelectorAll("script").forEach((s) => s.remove()); v.replaceChildren(d); }
    catch (e) { v.replaceChildren(el("pre", { textContent: text() })); }
  }
  else if (D.kind === "image") v.replaceChildren(el("img", { src: blobUrl(), alt: D.name }));
  else if (D.kind === "audio") v.replaceChildren(el("audio", { controls: true, src: blobUrl() }));
  else if (D.kind === "video") v.replaceChildren(el("video", { controls: true, src: blobUrl() }));
  else if (D.kind === "pdf") v.replaceChildren(el("embed", { src: blobUrl(), type: "application/pdf" }), el("p", {}, [dl()]));
  else if (D.kind === "text") v.replaceChildren(el("pre", { textContent: text() }));
  else v.replaceChildren(el("p", {}, ["No inline preview for this file type. ", dl()]));
} catch (e) {
  v.replaceChildren(el("p", { textContent: "Could not preview: " + (e.message || e) + " " }), dl());
}
})();
</script></body></html>`;
}

async function preview_file(params, userSettings, resources) {
  const ctx = { notes: [], incoming: null };
  const page = (body) => {
    const html = defuseTrailers(body);
    return ctx.incoming ? html + "\n<!--[[cr-state:" + ctx.incoming + "]]-->" : html;
  };
  const msg = (t) => page("<!doctype html><meta charset=\"utf-8\"><body style=\"font:14px system-ui,sans-serif;padding:12px\">" + String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</body>");
  try {
    params = params || {};
    const cfg = readSettings(userSettings || {});
    applyNetSettings(cfg);
    if (cfg.carry) ctx.incoming = extractTrailer(previousOutputText(resources && resources.previousRunOutput));
    const path = params.path || params.file || params.filename;
    if (!path) return msg("preview_file: no path was given.");
    const rel = relPath(path);
    let snap = null;
    if (ctx.incoming) {
      try { snap = await restoreSnapshot(ctx.incoming, cfg); }
      catch (e) { return msg("The workspace could not be loaded (" + (e.message || e) + "). Recreate " + rel + " with run_code, then preview it."); }
    }
    const hit = snap && snap.files.find(([p]) => p === rel);
    if (!hit) {
      const names = snap ? snap.files.map(([p]) => p).filter((p) => !isInternal(p)) : [];
      return msg(rel + " is not in /workspace." + (names.length ? " Files: " + names.slice(0, 40).join(", ") : " /workspace is empty."));
    }
    const bytes = hit[1];
    if (bytes.length > PREVIEW_MAX_BYTES) return msg(rel + " is " + fmtSize(bytes.length) + ", too large to preview (limit " + (PREVIEW_MAX_BYTES >> 20) + " MB). Use serve_file for a download link, or preview a smaller extract.");
    const name = rel.split("/").pop() || rel;
    const mime = guessMime(name);
    const as = String(params.as || "auto").toLowerCase();
    const kind = previewKind(name, mime, ["auto", "table", "sheet", "json", "html", "markdown", "text", "image", "audio", "video", "pdf", "parquet", "sqlite", "docx", "pptx", "notebook", "download"].includes(as) ? as : "auto");
    return page(previewHtml(rel, mime, kind, bytes));
  } catch (e) {
    return msg("preview_file failed: " + (e && e.message || e));
  }
}
