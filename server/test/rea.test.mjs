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

test('one tool list holds the Code Runner tools and REA\'s', opts, async () => {
  const c = await client(port);
  const { tools } = await c.listTools();
  const names = tools.map(t => t.name);
  assert.ok(names.includes('run_code') && names.includes('browser_state'));
  assert.ok(names.includes('analyze_javascript_application'), 'REA tools missing:\n' + log.slice(-1500));
  assert.ok(tools.length > 100, 'only ' + tools.length + ' tools');
  assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  assert.match(c.getInstructions() || '', /REA/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/rea/mcp`)).status, 404);   // no second endpoint
});

test('a REA tool analyses a file the code wrote into the same workspace', opts, async () => {
  const c = await client(port);
  await c.callTool({ name: 'run_code', arguments: { language: 'bash', code: "mkdir -p app && printf 'export function hi(){return 1}\\n' > app/index.js && printf '{\"name\":\"demo\",\"main\":\"index.js\"}' > app/package.json" } });
  const r = await c.callTool({ name: 'analyze_javascript_application', arguments: { input_path: 'app' } }, undefined, { timeout: 120000 });
  assert.ok(!r.isError, textOf(r).slice(0, 1500));
  const body = JSON.parse(r.content[0].text);
  // A relative path resolved inside the workspace proves where REA runs.
  assert.match(body.normalized_result.input_path, /rea-test-main-[0-9a-f]+\/app$/);
});

test('each user gets a REA process of their own; an unknown tool is an error, not a crash', opts, async () => {
  const other = await client(port, 'rea-other');
  const r = await other.callTool({ name: 'analyze_javascript_application', arguments: { input_path: 'app' } }, undefined, { timeout: 120000 });
  // The other user's workspace has no app/ folder.
  assert.ok(r.isError || /not|no such|missing|exist/i.test(textOf(r)), textOf(r).slice(0, 500));
  const bad = await other.callTool({ name: 'no_such_tool_anywhere', arguments: {} });
  assert.ok(bad.isError);
});

test('with REA switched off only the Code Runner tools are listed', opts, async () => {
  const p2 = port + 1;
  const off = start(p2, { REA: '0', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rea-off-')) });
  try {
    await up(p2);
    const c = await client(p2);
    assert.equal((await c.listTools()).tools.length, 12);
    const r = await c.callTool({ name: 'analyze_javascript_application', arguments: {} });
    assert.ok(r.isError);
  } finally { off.kill('SIGTERM'); }
});
