// The result guard: whatever a tool returns, what leaves the server fits a chat.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
fs.chmodSync(data, 0o711);
process.env.DATA_DIR = data;
process.env.CALL_CEILING_S = '30';
let guard, ws, config;

before(async () => {
  ({ config } = await import('../src/config.js'));
  const sandbox = await import('../src/sandbox.js');
  await sandbox.initSandbox();
  ws = (await import('../src/sessions.js')).getWorkspace('guard', 'main');
  guard = await import('../src/guard.js');
});

test('a small result passes unchanged apart from structuredContent', async () => {
  const r = await guard.guardResult(ws, 't', { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 1 } });
  assert.deepEqual(r, { content: [{ type: 'text', text: 'hello' }] });
});

test('oversized text is shortened and the full text lands in the workspace', async () => {
  const big = 'A'.repeat(100000) + 'MIDDLE' + 'Z'.repeat(400000);
  const r = await guard.guardResult(ws, 'some tool/..', { content: [{ type: 'text', text: big }], structuredContent: { big } });
  const t = r.content[0].text;
  assert.ok(t.length < config.resultMaxChars + 600, 'is ' + t.length);
  assert.ok(t.startsWith('AAAA') && t.includes('ZZZZ'));
  const m = /saved as (results\/[\w.-]+\.txt)/.exec(t);
  assert.ok(m, t.slice(-400));
  assert.equal(fs.readFileSync(path.join(ws.dir, m[1]), 'utf8').length, big.length);
  assert.equal(r.structuredContent, undefined);
  assert.ok(JSON.stringify(r).length < 70000);
});

test('images beyond the budget are left out with a note; small ones stay', async () => {
  const small = { type: 'image', data: 'A'.repeat(1000), mimeType: 'image/png' };
  const huge = { type: 'image', data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/png' };
  const r = await guard.guardResult(ws, 't', { content: [{ type: 'text', text: 'shot' }, small, huge] });
  assert.equal(r.content.filter(c => c.type === 'image').length, 1);
  assert.match(r.content[0].text, /left out of this result/);
  assert.ok(JSON.stringify(r).length < 10000);
});

test('errors and broken results still give an answer', async () => {
  let r = await guard.guardedCall(ws, 't', async () => { throw new Error('boom'); });
  assert.ok(r.isError); assert.match(r.content[0].text, /boom/);
  r = await guard.guardedCall(ws, 't', async () => undefined);
  assert.ok(r.isError);
  r = await guard.guardedCall(ws, 't', async () => ({ content: [{ type: 'text', text: 'x'.repeat(500000) }], isError: true }));
  assert.ok(r.isError && r.content[0].text.length < 62000);
});

test('a call that never returns is answered at the ceiling', async () => {
  config.callCeilingS = 1;
  try {
    const r = await guard.guardedCall(ws, 'stuck', () => new Promise(() => {}));
    assert.ok(r.isError); assert.match(r.content[0].text, /no answer within 1 s/);
  } finally { config.callCeilingS = 30; }
});
