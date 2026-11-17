#!/usr/bin/env node
// Real extension + HTTP/WebSocket + disposable Chromium profile. No everyday
// browser is touched. Uses ws for DevTools; no Playwright install is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const ROOT = process.env.CR_BRIDGE_ROOT || path.resolve(__dirname, '..');
const { WebSocket } = require(path.join(ROOT, 'server/node_modules/ws'));
const EXT = process.env.CR_BRIDGE_EXTENSION || path.join(ROOT, 'extension');
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a,b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of builds) for (const suffix of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
    const file = path.join(cache, d, suffix);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  for (const name of ['chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch {}
  }
  throw new Error('Chromium is unavailable; set CHROME to a Chrome for Testing executable.');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
async function cdp(url) {
  const ws = new WebSocket(url); await once(ws, 'open');
  let id = 0; const pending = new Map();
  ws.on('message', raw => {
    const msg = JSON.parse(raw); const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  });
  ws.on('error', () => {});
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timed out: ' + method)); }, 15_000);
    pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id:n, method, params }));
  });
  return { close: () => ws.close(), call, async evaluate(expression) {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description);
    return r.result?.value;
  } };
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-remote-e2e-'));
  const profile = path.join(tmp, 'profile'), ext = path.join(tmp, 'extension');
  fs.cpSync(EXT, ext, { recursive:true }); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(ext, 'config.json'), JSON.stringify({ trustedHosts:['localhost'] }));
  process.env.DATA_DIR = path.join(tmp, 'data');
  const bridge = await import(pathToFileURL(path.join(ROOT, 'server/src/bridge.js')));
  const server = http.createServer(async (req,res) => {
    if (await bridge.handleBridgeHttp(req,res,new URL(req.url,'http://localhost'))) return;
    if (req.url === '/fixture.html') { res.writeHead(200,{'content-type':'text/html'}); res.end(fs.readFileSync(path.join(ROOT,'test/fixture.html'))); }
    else { res.writeHead(200,{'content-type':'text/html'}); res.end('<!doctype html><title>Remote test chat</title><p>Chat test</p>'); }
  });
  bridge.attachBridge(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let chrome, sw, browser;
  let passed = 0;
  const step = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('PASS ' + name); });
  try {
    chrome = spawn(findChrome(), ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',
      '--user-data-dir='+profile, '--disable-extensions-except='+ext, '--load-extension='+ext,base+'/chat'], { stdio:'ignore' });
    const portFile = path.join(profile,'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 'Chromium DevTools endpoint');
    const debugPort = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    const targets = () => fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json());
    const extensionId = require('node:crypto').createHash('sha256').update(ext).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>'abcdefghijklmnop'[parseInt(c,16)]);
    const worker = await until(async () => (await targets()).find(t => t.type==='service_worker' && t.url.startsWith('chrome-extension://'+extensionId+'/')), 'extension service worker');
    sw = await cdp(worker.webSocketDebuggerUrl);
    await sw.call('Runtime.enable');
    await until(() => sw.evaluate("typeof chrome !== 'undefined' && !!chrome.storage?.local"), 'extension storage API');
    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r=>r.json());
    browser = await cdp(version.webSocketDebuggerUrl);
    let paired;
    await step('pair over HTTP, preseed trusted extension storage, then connect', async () => {
      const {code} = bridge.createPairingCode('remote-e2e');
      const r = await fetch(base+'/bridge/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,name:'E2E Chrome',version:'0.5.1'})});
      assert.equal(r.status,200); paired = await r.json();
      // Never print this expression: it contains the new device credential.
      await sw.evaluate(`chrome.storage.local.set(${JSON.stringify({remoteLink:{url:base,...paired},remoteEnabled:true,remoteAuthRejected:false,remoteScripts:true,remoteConfirmRisky:true})})`);
      await until(() => bridge.bridgeStatus('remote-e2e').connected, 'paired socket');
    });
    const request = req => bridge.bridgeCall('remote-e2e',req,20_000);
    await step('remote ping uses paired authority', async () => {
      assert.deepEqual(await request({op:'ping'}),{ok:true,version:'0.5.1',trusted:true,remote:true});
    });
    let tab;
    await step('tabs.list and page.state elements on the real fixture', async () => {
      const opened = await request({op:'tabs.open',url:base+'/fixture.html',active:true}); assert.equal(opened.ok,true,opened.error); tab=opened.tab.id;
      const list=await request({op:'tabs.list'}); assert.equal(list.ok,true); assert.ok(list.tabs.some(t=>t.id===tab));
      const state=await request({op:'page.state',tabId:tab,mode:'elements'}); assert.equal(state.ok,true,state.error); assert.match(state.text,/\[\d+\]<button>Go<\/button>/);
    });
    await step('page.act clicks a real button and reads the result', async () => {
      const state=await request({op:'page.state',tabId:tab}); const index=Number(/\[(\d+)\]<button>Go<\/button>/.exec(state.text)[1]);
      const acted=await request({op:'page.act',tabId:tab,actions:[{action:'click',index}]}); assert.equal(acted.done,true,JSON.stringify(acted)); assert.match(acted.state.text,/clicked 1/);
    });
    await step('local risky guard overrides confirmRisky false', async () => {
      const state=await request({op:'page.state',tabId:tab}); const index=Number(/\[(\d+)\]<button>Delete account<\/button>/.exec(state.text)[1]);
      const acted=await request({op:'page.act',tabId:tab,confirmRisky:false,actions:[{action:'click',index}]}); assert.equal(acted.done,false); assert.match(acted.stopped.reason,/delete/i);
    });
    await step('locally blocked site defeats a permissive server policy', async () => {
      await sw.evaluate(`chrome.storage.local.set({remoteBlock:['127.0.0.1']})`); await sleep(100);
      const state=await request({op:'page.state',tabId:tab,policy:{allow:['127.0.0.1'],block:[]}}); assert.equal(state.ok,false); assert.equal(state.code,'policy');
      const list=await request({op:'tabs.list'}); assert.ok(!list.tabs.some(t=>t.id===tab));
      await sw.evaluate(`chrome.storage.local.set({remoteBlock:[]})`); await sleep(100);
    });
    await step('both non-empty allow lists must permit the site', async () => {
      await sw.evaluate(`chrome.storage.local.set({remoteAllow:['example.com']})`); await sleep(100);
      const state=await request({op:'page.state',tabId:tab,policy:{allow:['127.0.0.1']}}); assert.equal(state.code,'policy');
      await sw.evaluate(`chrome.storage.local.set({remoteAllow:[]})`); await sleep(100);
    });
    await step('script toggle blocks browser_run and executable URL navigation', async () => {
      await sw.evaluate(`chrome.storage.local.set({remoteScripts:false})`); await sleep(100);
      assert.equal((await request({op:'run',tabId:tab,code:'return 2'})).code,'scripts-disabled');
      assert.equal((await request({op:'tabs.navigate',tabId:tab,url:'javascript:document.title="bad"'})).code,'policy');
    });
    await step('remote chat hosts mark and skip the active chat tab', async () => {
      await sw.evaluate(`chrome.storage.local.set({remoteChatHosts:['localhost']})`); await sleep(100);
      const opened=await request({op:'tabs.open',url:base.replace('127.0.0.1','localhost')+'/chat',active:true}); assert.equal(opened.ok,true,opened.error);
      const list=await request({op:'tabs.list'}); assert.equal(list.tabs.find(t=>t.id===opened.tab.id).chat,true);
      const state=await request({op:'page.state'}); assert.equal(state.tabId,tab);
    });
    await step('options page loads and reports the live connection', async () => {
      const extensionId=new URL(worker.url).host;
      const {targetId}=await browser.call('Target.createTarget',{url:`chrome-extension://${extensionId}/options.html`});
      const target=await until(async ()=>(await targets()).find(t=>t.id===targetId),'options page');
      const page=await cdp(target.webSocketDebuggerUrl);
      try { await until(async ()=>/Connected to .* as remote-e2e since/.test(await page.evaluate(`(document.getElementById('connection') || {}).textContent || ''`)), 'options connection status'); }
      finally { page.close(); }
    });
    await step('master switch disconnects; enabling reconnects once', async () => {
      await sw.evaluate(`chrome.storage.local.set({remoteEnabled:false})`);
      await until(()=>!bridge.bridgeStatus('remote-e2e').connected,'disabled socket');
      assert.equal((await request({op:'ping'})).code,'offline');
      await sw.evaluate(`chrome.storage.local.set({remoteEnabled:true})`);
      await until(()=>bridge.bridgeStatus('remote-e2e').connected,'enabled socket');
      assert.equal(bridge.bridgeStatus('remote-e2e').devices.length,1);
    });
    await step('revocation stops retries and shows pair again', async () => {
      bridge.revokeDevices('remote-e2e');
      await until(()=>sw.evaluate(`chrome.storage.local.get('remoteAuthRejected').then(s=>s.remoteAuthRejected===true)`),'auth rejection persisted');
      const status=await sw.evaluate(`chrome.storage.session.get('remoteStatus').then(s=>s.remoteStatus)`); assert.equal(status.connected,false); assert.match(status.lastError,/pair again/i);
    });
    console.log(`\n${passed} remote Chromium checks passed.`);
  } finally {
    sw?.close(); browser?.close();
    if (chrome && chrome.exitCode===null) { chrome.kill('SIGTERM'); await Promise.race([once(chrome,'exit'),sleep(3000)]); if (chrome.exitCode===null) { chrome.kill('SIGKILL'); await once(chrome,'exit'); } }
    await new Promise(r=>server.close(r));
    fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
