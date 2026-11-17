// REA proxy (/rea/mcp) against a real local REA install, under the real sandbox.
// Needs the managed runtime at ~/.local/share/rea/runtime (or REA_TEST_RUNTIME);
// skipped with a reason when it is missing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const runtime = process.env.REA_TEST_RUNTIME || path.join(os.homedir(), '.local/share/rea/runtime');
const reaNode = path.join(runtime, 'node_modules/node/bin/node');
const reaScript = path.join(runtime, 'node_modules/rea-agents/scripts/rea.mjs');
const node = fs.existsSync(reaNode) ? reaNode : process.execPath;
const missing = !fs.existsSync(reaScript) ? `local REA install not found at ${reaScript}` : null;
const opts = missing ? { skip: missing } : {};

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-test-'));
fs.chmodSync(data, 0o711);
process.env.DATA_DIR = data;
process.env.ALLOW_NO_AUTH = '1';
process.env.REA_COMMAND = `${node} ${reaScript} mcp`;
// Non-root mode: RLIMIT_NPROC counts every task of this unix user, so the default
// 256 fails on a busy desktop. Stay below the hard limit (above it crbox refuses).
if (!process.env.MAX_PROCS) {
  const hard = spawnSync('sh', ['-c', 'ulimit -Hu'], { encoding: 'utf8' }).stdout.trim();
  process.env.MAX_PROCS = String(/^\d+$/.test(hard) ? Math.min(Number(hard) - 1, 20000) : 20000);
}

let rea, sandbox, sessions, config, server, base;

async function rpc(msg, workspace = 'main', user = 'rea-test') {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-user-id': user, 'x-workspace': workspace },
    body: JSON.stringify(msg)
  });
  const text = await r.text();
  const messages = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return { status: r.status, messages, last: messages.length ? messages[messages.length - 1] : JSON.parse(text) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; }

before(async () => {
  if (missing) return;
  ({ config } = await import('../src/config.js'));
  sandbox = await import('../src/sandbox.js');
  sessions = await import('../src/sessions.js');
  rea = await import('../src/rea.js');
  await sandbox.initSandbox();
  server = http.createServer((req, res) => rea.handleReaMcp(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/rea/mcp`;
  const ws = sessions.getWorkspace('rea-test', 'main');
  fs.mkdirSync(path.join(ws.dir, 'app'));
  fs.writeFileSync(path.join(ws.dir, 'app/package.json'), '{"name":"demo","version":"1.0.0","main":"main.js"}');
  fs.writeFileSync(path.join(ws.dir, 'app/main.js'), 'import fs from "node:fs";\nexport function hello() { return fs.readFileSync("x"); }\n');
});
after(async () => {
  if (rea) await rea.shutdownRea();
  if (server) server.close();
  fs.rmSync(data, { recursive: true, force: true });
});

test('runs under the real sandbox', opts, () => {
  const rep = sandbox.sandboxReport();
  assert.notEqual(rep.mode, 'off', JSON.stringify(rep.notes));
  console.log('# sandbox', rep.mode, JSON.stringify(rep.layers));
});

test('initialize forwards REA capabilities and instructions', opts, async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const result = r.last.result;
  assert.ok(result, JSON.stringify(r.last));
  assert.ok(result.capabilities.tools);
  assert.equal(result.capabilities.tools.listChanged, undefined);
  assert.match(result.serverInfo.name, /rea/);
  assert.ok(typeof result.instructions === 'string' && result.instructions.length > 10);
});

test('tools/list through HTTP returns REA tools and is cached per child', opts, async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = r.last.result.tools;
  assert.ok(tools.length > 50, `only ${tools.length} tools`);
  assert.ok(tools.some(t => t.name === 'analyze_javascript_application'));
  const entry = rea.__test.children.get(sessions.getWorkspace('rea-test', 'main').id);
  assert.equal(entry.tools.length, tools.length);
});

test('tools/call runs a static analysis on a workspace file (cwd = workspace)', opts, async () => {
  const ws = sessions.getWorkspace('rea-test', 'main');
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analyze_javascript_application', arguments: { input_path: 'app' }, _meta: { progressToken: 'p1' } } });
  const result = r.last.result;
  assert.ok(result && !result.isError, JSON.stringify(r.last).slice(0, 2000));
  const body = JSON.parse(result.content[0].text);
  // A relative path resolved inside the workspace proves the child's cwd.
  assert.equal(fs.realpathSync(body.normalized_result.input_path), fs.realpathSync(path.join(ws.dir, 'app')));
  assert.ok(fs.statSync(path.join(ws.dir, '.cr/rea/cache')).isDirectory(), 'XDG dirs live in .cr/rea');
});

test('unknown tool comes back as a tool error, not a crash', opts, async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.ok(r.last.result?.isError || r.last.error, JSON.stringify(r.last));
});

test('a second workspace gets its own REA process', opts, async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'other');
  assert.ok(r.last.result.tools.length > 50);
  const a = rea.__test.children.get(sessions.getWorkspace('rea-test', 'main').id);
  const b = rea.__test.children.get(sessions.getWorkspace('rea-test', 'other').id);
  assert.ok(a && b && a !== b);
  assert.notEqual(a.child.pid, b.child.pid);
  assert.equal(rea.reaReport().running, 2);
});

test('an idle REA process is stopped', opts, async () => {
  const id = sessions.getWorkspace('rea-test', 'idle').id;
  rea.__test.setIdleMs(500);
  try {
    await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'idle');
    const entry = rea.__test.children.get(id);
    assert.ok(entry);
    const pid = entry.child.pid;
    assert.ok(await until(() => !rea.__test.children.has(id) && entry.closed && !alive(pid), 10000), 'idle child still running');
    // The next call starts a fresh one.
    const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, 'idle');
    assert.ok(r.last.result.tools.length > 50);
    assert.notEqual(rea.__test.children.get(id).child.pid, pid);
  } finally { rea.__test.setIdleMs(config.reaIdleMin * 60000); }
});

test('disabled or missing REA answers a clear JSON-RPC error', opts, async () => {
  const saved = { rea: config.rea, cmd: config.reaCommand };
  try {
    config.rea = false; rea.__test.reset();
    let r = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    assert.equal(r.last.id, 8);
    assert.match(r.last.error.message, /REA is not available.*REA=0.*WITH_REA=1/s);
    assert.equal(rea.reaAvailable(), false);
    config.rea = true; config.reaCommand = ['/nonexistent/rea', 'mcp']; rea.__test.reset();
    r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    assert.match(r.last.error.message, /not found.*REA_COMMAND/s);
  } finally { config.rea = saved.rea; config.reaCommand = saved.cmd; rea.__test.reset(); }
  assert.equal(rea.reaAvailable(), true);
});

test('shutdown stops every REA process', opts, async () => {
  const pids = [...rea.__test.children.values()].map(e => e.child.pid);
  assert.ok(pids.length >= 1);
  await rea.shutdownRea();
  assert.equal(rea.__test.children.size, 0);
  assert.ok(await until(() => pids.every(p => !alive(p)), 5000));
});
