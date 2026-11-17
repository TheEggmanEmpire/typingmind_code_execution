// REA as part of the main MCP endpoint, against a real local REA install and the
// real sandbox. Needs the managed runtime at ~/.local/share/rea/runtime (or
// REA_TEST_RUNTIME); skipped with a reason when it is missing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const runtime = process.env.REA_TEST_RUNTIME || path.join(os.homedir(), '.local/share/rea/runtime');
const reaNode = path.join(runtime, 'node_modules/node/bin/node');
const reaScript = path.join(runtime, 'node_modules/rea-agents/scripts/rea.mjs');
const node = fs.existsSync(reaNode) ? reaNode : process.execPath;
const missing = !fs.existsSync(reaScript) ? `local REA install not found at ${reaScript}` : null;
const opts = missing ? { skip: missing } : {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-test-'));
const KEY = 'rea-test-key-0123456789abcdef';
let proc, log = '';

function start(port, extra = {}) {
  const p = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: data, MCP_API_KEY: KEY, PUBLIC_URL: 'http://127.0.0.1:' + port, REA_COMMAND: `${node} ${reaScript} mcp`, REA_IDLE_MIN: '1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => (log += d)); p.stderr.on('data', d => (log += d));
  return p;
}
async function up(port) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + log);
}
async function client(port, user = 'rea-test') {
  const c = new Client({ name: 'rea-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + KEY, 'X-User-ID': user } } }));
  return c;
}
const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const port = 21000 + Math.floor(Math.random() * 20000);

before(async () => { if (!missing) { proc = start(port); await up(port); } });
after(() => { proc && proc.kill('SIGTERM'); fs.rmSync(data, { recursive: true, force: true }); });

test('compact mode: two REA tools next to the Code Runner tools, and a small tool list', opts, async () => {
  const c = await client(port);
  const { tools } = await c.listTools();
  const names = tools.map(t => t.name);
  assert.deepEqual(names.filter(n => n.startsWith('rea_')), ['rea_find', 'rea_call']);
  assert.equal(tools.length, 14);
  assert.ok(JSON.stringify(tools).length < 40000, 'tool list is ' + JSON.stringify(tools).length + ' characters');
  assert.match(c.getInstructions() || '', /rea_find/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/rea/mcp`)).status, 404);   // no second endpoint
});

test('rea_find lists, searches and shows one tool\'s schema', opts, async () => {
  const c = await client(port);
  let r = await c.callTool({ name: 'rea_find', arguments: {} }, undefined, { timeout: 120000 });
  assert.match(textOf(r), /REA offers 1\d\d tools/, log.slice(-1500));
  assert.match(textOf(r), /- analyze_javascript_application: /);
  assert.ok(textOf(r).length < 40000);
  r = await c.callTool({ name: 'rea_find', arguments: { query: 'javascript application' } });
  assert.match(textOf(r), /analyze_javascript_application/);
  r = await c.callTool({ name: 'rea_find', arguments: { tool: 'analyze_javascript_application' } });
  assert.match(textOf(r), /input_path/);
  r = await c.callTool({ name: 'rea_find', arguments: { tool: 'nope_tool' } });
  assert.ok(r.isError);
});

test('rea_call analyses a file the code wrote into the same workspace', opts, async () => {
  const c = await client(port);
  await c.callTool({ name: 'run_code', arguments: { language: 'bash', code: "mkdir -p app && printf 'export function hi(){return 1}\\n' > app/index.js && printf '{\"name\":\"demo\",\"main\":\"index.js\"}' > app/package.json" } });
  const r = await c.callTool({ name: 'rea_call', arguments: { tool: 'analyze_javascript_application', arguments: { input_path: 'app' } } }, undefined, { timeout: 120000 });
  assert.ok(!r.isError, textOf(r).slice(0, 1500));
  // A relative path resolved inside the workspace proves where REA runs.
  assert.match(textOf(r), /rea-test-main-[0-9a-f]+\/app/);
  assert.equal(r.structuredContent, undefined);
});

test('a huge REA result comes back short, with the full text in a workspace file', opts, async () => {
  const c = await client(port);
  // binary_session without arguments dumps every capability: several hundred KB.
  const r = await c.callTool({ name: 'rea_call', arguments: { tool: 'binary_session', arguments: {} } }, undefined, { timeout: 120000 });
  const t = textOf(r);
  assert.ok(t.length < 22000, 'result is ' + t.length + ' characters');
  assert.equal(r.structuredContent, undefined);
  const m = /saved as (rea\/binary_session-[\w-]+\.json)/.exec(t);
  assert.ok(m, t.slice(-600));
  const size = await c.callTool({ name: 'run_code', arguments: { language: 'python', code: `import json,os\nd=json.load(open('${m[1]}'))\nprint(os.path.getsize('${m[1]}'), type(d).__name__)` } });
  assert.match(textOf(size), /^\d{5,} dict/m, textOf(size));
  // A direct call by REA's own tool name still works and is capped too.
  const direct = await c.callTool({ name: 'binary_session', arguments: {} }, undefined, { timeout: 120000 });
  assert.ok(textOf(direct).length < 22000);
  const bad = await c.callTool({ name: 'rea_call', arguments: { tool: 'binary_session', arguments: { action: 'x' } } });
  assert.ok(bad.isError);
  assert.match(textOf(bad), /rea_find/);
});

test('each user gets a REA process of their own', opts, async () => {
  const other = await client(port, 'rea-other');
  const r = await other.callTool({ name: 'rea_call', arguments: { tool: 'analyze_javascript_application', arguments: { input_path: 'app' } } }, undefined, { timeout: 120000 });
  // The other user's workspace has no app/ folder.
  assert.ok(r.isError || /not|no such|missing|exist/i.test(textOf(r)), textOf(r).slice(0, 500));
});

test('REA_TOOLS=full lists every REA tool without output schemas', opts, async () => {
  const p3 = port + 2;
  const full = start(p3, { REA_TOOLS: 'full', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rea-full-')) });
  try {
    await up(p3);
    const { tools } = await (await client(p3)).listTools();
    assert.ok(tools.length > 100 && tools.some(t => t.name === 'analyze_javascript_application'));
    assert.ok(tools.every(t => t.outputSchema === undefined));
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  } finally { full.kill('SIGTERM'); }
});

test('with REA switched off only the Code Runner tools are listed', opts, async () => {
  const p2 = port + 1;
  const off = start(p2, { REA: '0', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rea-off-')) });
  try {
    await up(p2);
    const c = await client(p2);
    assert.equal((await c.listTools()).tools.length, 12);
    const r = await c.callTool({ name: 'rea_call', arguments: { tool: 'binary_session' } });
    assert.ok(r.isError);
  } finally { off.kill('SIGTERM'); }
});
