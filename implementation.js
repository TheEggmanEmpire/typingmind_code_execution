const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/";
const SQLJS_CDN   = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/";

const CE = {
  "c":       { id: "cg142",              lang: "c"       },
  "c++":     { id: "g142",               lang: "c++"     },
  "rust":    { id: "r1820",              lang: "rust"    },
  "go":      { id: "gl194",              lang: "go"      },
  "ruby":    { id: "ruby405",            lang: "ruby"    },
  "java":    { id: "java904",            lang: "java"    },
  "csharp":  { id: "dotnet90csharpmono", lang: "csharp"  },
  "haskell": { id: "ghc984",             lang: "haskell" },
  "lua":     { id: "lua550",             lang: "lua"     }
};

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

async function getPyodide() {
  if (globalThis.__py) return globalThis.__py;
  if (!globalThis.__pyLoading) {
    globalThis.__pyLoading = (async () => {
      if (!globalThis.loadPyodide) await loadScript(PYODIDE_CDN + "pyodide.js");
      globalThis.__py = await globalThis.loadPyodide({ indexURL: PYODIDE_CDN });
      return globalThis.__py;
    })();
  }
  return globalThis.__pyLoading;
}

async function runPython(code, packages) {
  const py = await getPyodide();
  try { await py.loadPackagesFromImports(code); } catch (e) {}
  if (Array.isArray(packages) && packages.length) {
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    for (const p of packages) await micropip.install(p);
  }
  const out = [];
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => out.push(s) });
  let v;
  try { v = await py.runPythonAsync(code); }
  catch (e) { return "Python error:\n" + (e.message || e); }
  if (v !== undefined && v !== null) out.push(String(v));
  return out.join("\n").trim();
}

async function runJavaScript(code) {
  const out = [];
  const log = (...a) => out.push(a.map((x) =>
    typeof x === "object" ? JSON.stringify(x) : String(x)).join(" "));
  try {
    const fn = new Function("console", "return (async () => {" + code + "\n})()");
    const v = await fn({ log, info: log, warn: log, error: log });
    if (v !== undefined) out.push(String(v));
  } catch (e) { return "JavaScript error:\n" + (e.message || e); }
  return out.join("\n").trim();
}

async function runSQL(code) {
  if (!globalThis.__sqljs) {
    if (!globalThis.initSqlJs) await loadScript(SQLJS_CDN + "sql-wasm.js");
    globalThis.__sqljs = await globalThis.initSqlJs({ locateFile: (f) => SQLJS_CDN + f });
  }
  const db = new globalThis.__sqljs.Database();
  try {
    const res = db.exec(code);
    if (!res.length) return "(statement ran, no rows returned)";
    return res.map((r) =>
      [r.columns.join(" | "), r.values.map((v) => v.join(" | ")).join("\n")].join("\n")
    ).join("\n\n");
  } catch (e) { return "SQL error:\n" + (e.message || e); }
  finally { db.close(); }
}

async function runRemote(language, code) {
  const c = CE[language];
  if (!c) throw new Error("Unsupported language: " + language);
  const r = await fetch("https://godbolt.org/api/compiler/" + c.id + "/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      source: code,
      lang: c.lang,
      options: {
        userArguments: "",
        executeParameters: { args: [], stdin: "" },
        compilerOptions: { executorRequest: true },
        filters: { execute: true }
      }
    })
  });
  if (!r.ok) throw new Error("Compiler Explorer returned HTTP " + r.status);
  const d = await r.json();
  const strip = (t) => String(t).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const txt = (a) => (a || []).map((x) => strip(x.text)).join("\n");
  const output = [txt(d.stdout), txt(d.stderr), txt(d.buildResult && d.buildResult.stderr)]
    .filter((s) => s && s.trim()).join("\n").trim();
  return output || "(compiled and ran, no output)";
}

async function run_code(params) {
  const { language, code, packages } = params;
  if (!code || !code.trim()) throw new Error("No code was provided.");
  let out;
  switch (language) {
    case "python":     out = await runPython(code, packages); break;
    case "javascript": out = await runJavaScript(code);       break;
    case "sql":        out = await runSQL(code);              break;
    default:           out = await runRemote(language, code);
  }
  return out && out.length ? out : "(no output - did you print the result?)";
}
