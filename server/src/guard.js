// The last check before any tool result leaves the server, whatever tool made it.
//
// A chat client sends each tool result back to the model. A result that is too
// big does not fail loudly: the client drops the turn and the chat just stops.
// Every tool has limits of its own, but one forgotten path is enough, so the
// budget is enforced here once, for all of them (including REA's):
//   - text beyond the budget is saved to a workspace file and returned shortened
//   - images beyond the budget are left out (they are in the workspace already)
//   - structuredContent, a second copy of the same data, is not sent
// Each call also writes one log line (tool, time, size; never content), so a
// stalled chat can be explained from the server log.

import { config } from "./config.js";
import { wsfs } from "./sandbox.js";

const kb = (n) => (n < 10240 ? (n / 1024).toFixed(1) : Math.round(n / 1024)) + " KB";

export async function guardResult(ws, tool, result) {
  if (!result || !Array.isArray(result.content)) return { content: [{ type: "text", text: "The tool returned nothing." }], isError: true };
  const notes = [];
  let imageBudget = config.resultImageMaxBytes;
  const parts = [];
  for (const c of result.content) {
    if (c && c.type === "text") parts.push(String(c.text == null ? "" : c.text));
  }
  let body = parts.join("\n\n");
  const media = [];
  for (const c of result.content) {
    if (!c || c.type === "text") continue;
    const size = typeof c.data === "string" ? Math.floor(c.data.length * 0.75) : JSON.stringify(c).length;
    if (size > imageBudget) { notes.push("(" + (c.type === "image" ? "An image" : "An attachment") + " of " + kb(size) + " was left out of this result to keep it small enough for the chat. Use serve_file to show the file to the user.)"); continue; }
    imageBudget -= size;
    media.push(c);
  }
  const max = config.resultMaxChars;
  if (body.length > max) {
    const rel = "results/" + String(tool).replace(/[^A-Za-z0-9_-]/g, "_") + "-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".txt";
    let saved;
    try { await wsfs.write(ws, rel, Buffer.from(body, "utf8")); saved = "The full text is saved as " + rel + " in the workspace: read the parts you need with run_code, or ask for less."; }
    catch (e) { saved = "The full text could not be saved (" + (e && e.message || e) + "); ask for less."; }
    const head = Math.floor(max * 0.75), tail = max - head, total = body.length;
    body = body.slice(0, head) + "\n\n... [" + (total - max) + " characters left out] ...\n\n" + body.slice(-tail);
    notes.push("(This result had " + total + " characters; the middle was left out. " + saved + ")");
  }
  if (notes.length) body += (body ? "\n\n" : "") + notes.join("\n");
  const out = { content: [{ type: "text", text: body }, ...media] };
  if (result.isError) out.isError = true;
  return out;
}

// Runs one tool call to an answer, always: an error or a handler that never
// returns becomes a readable tool error instead of a hanging request.
export async function guardedCall(ws, tool, run) {
  const started = Date.now();
  let result, timer, note = "";
  try {
    result = await Promise.race([
      run(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("no answer within " + config.callCeilingS + " s"), { ceiling: true })), config.callCeilingS * 1000); timer.unref(); })
    ]);
  } catch (e) {
    note = e && e.ceiling ? " ceiling" : " threw";
    result = { content: [{ type: "text", text: "**" + tool + " failed:** " + String(e && e.message || e).slice(0, 2000) + (e && e.ceiling ? ". The call was given up on; a run it started may still be going (see the job tool)." : ".") }], isError: true };
  } finally { clearTimeout(timer); }
  let before = 0;
  try { before = JSON.stringify(result).length; } catch (e) {}
  const out = await guardResult(ws, tool, result).catch((e) => ({ content: [{ type: "text", text: "**" + tool + " failed:** the result could not be prepared (" + String(e && e.message || e).slice(0, 300) + ")." }], isError: true }));
  const after = JSON.stringify(out).length;
  console.log("tool " + tool + " ws=" + ws.id + " " + (Date.now() - started) + "ms " + after + "B" + (before > after + 64 ? " (cut from " + before + "B)" : "") + (out.isError ? " error" : "") + note);
  return out;
}
