import test from 'node:test';
import assert from 'node:assert/strict';
import { legacy } from '../src/legacy.js';
test('legacy previews, languages and notebook', () => {
  assert.match(legacy.previewHtml('tiny.csv','text/csv','table',Buffer.from('a,b\n1,2')), /<!doctype html>/i);
  assert.equal(legacy.previewKind('x.csv','text/csv','auto'),'table');
  assert.equal(legacy.guessMime('x.png'),'image/png');
  assert.ok(legacy.ALL_LANGS.includes('python') && legacy.ALL_LANGS.includes('rust'));
  const n=JSON.parse(legacy.buildNotebook([{language:'python',code:'1+1',output:'2',time:Date.now()}],'ipynb'));
  assert.equal(n.nbformat,4); assert.equal(n.cells[1].cell_type,'code');
  assert.equal(typeof legacy.runRemote,'function');
});
test('remote C hello world', {skip:process.env.NET_TESTS !== '1'}, async()=> {
  assert.match(await legacy.runRemote('c','#include <stdio.h>\nint main(){puts("hello");}', '', {}),/hello/);
});
