import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crbox-test-'));
fs.chmodSync(data, 0o711);
process.env.DATA_DIR = data;
process.env.SANDBOX_TEST_SECRET = 'parent-secret-must-stay-private';
let api, ws, report;
function capture(child, input) {
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
    child.stdin?.end(input);
  });
}
const run = (argv, opts) => capture(api.spawnInWorkspace(ws, argv, opts));
const python = (code, opts) => run(['python3', '-c', code], opts);
function groupMembers(pgid) {
  const result = [];
  for(const name of fs.readdirSync('/proc')) {
    if(!/^\d+$/.test(name)) continue;
    try {const text=fs.readFileSync(`/proc/${name}/stat`,'utf8'); const fields=text.slice(text.lastIndexOf(')')+2).split(' '); if(Number(fields[2])===pgid) result.push({pid:Number(name),state:fields[0]});} catch {}
  }
  return result;
}
function ok(r) { assert.equal(r.code, 0, r.err || r.out); return r.out; }
const have = p => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', p]).status === 0;

before(async () => {
  api = await import('../src/sandbox.js');
  report = await api.initSandbox();
  ws = (await import('../src/sessions.js')).getWorkspace('sandbox-test', 'main');
});
after(() => fs.rmSync(data, { recursive: true, force: true }));

test('launcher compiles cleanly and probes real capabilities', () => {
  const built = spawnSync('sh', [path.join(root, 'sandbox/build.sh')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const r = spawnSync(path.join(root, 'sandbox/crbox'), ['--probe'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(typeof p.landlock, 'number');
  for (const k of ['seccomp', 'root', 'setuid', 'nnp']) assert.equal(typeof p[k], 'boolean');
});
test('launcher closes inherited descriptors above stderr and disables core dumps', () => {
  const fd = fs.openSync(path.join(data,'inherited-file'),'w+');
  try {
    const r=spawnSync(path.join(root,'sandbox/crbox'),['--','/usr/bin/python3','-c','import os,resource,errno; assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)\ntry: os.fstat(3); raise SystemExit("inherited descriptor leaked")\nexcept OSError as e: assert e.errno==errno.EBADF'],{encoding:'utf8',stdio:['ignore','pipe','pipe',fd]});
    assert.equal(r.status,0,r.stderr || r.stdout);
  } finally {fs.closeSync(fd);}
});
test('initialization is idempotent and returns an honest report', async () => {
  assert.deepEqual(await api.initSandbox(), report);
  assert.deepEqual(api.sandboxReport(), report);
  assert.ok(['root', 'user', 'off'].includes(report.mode));
  assert.equal(typeof report.networkOff, 'boolean');
});
test('workspace writable and child environment explicitly scrubbed', async () => {
  const env = JSON.parse(ok(await python('import os,json;open("local.txt","w").write("ok");print(json.dumps(dict(os.environ)))', { env: { EXPLICIT: 'given' } })));
  assert.equal(env.SANDBOX_TEST_SECRET, undefined);
  assert.equal(env.EXPLICIT, 'given');
  assert.equal(env.HOME, ws.dir);
  assert.equal(env.TMPDIR, ws.tmp);
  assert.equal(env.USER, 'runner');
  assert.equal(fs.readFileSync(path.join(ws.dir, 'local.txt'), 'utf8'), 'ok');
});
test('cannot write outside workspace or read server private paths', async t => {
  if (!(report.layers.landlock || report.layers.namespaces)) return t.skip('No Landlock or working bubblewrap on this kernel');
  const secret = path.join(data, 'private'); fs.writeFileSync(secret, 'private');
  const r = await python(`import os\nfor p,m in [(${JSON.stringify(secret)},'r'),('/tmp/outside-crbox','w'),(${JSON.stringify(path.join(root, 'src/config.js'))},'r')]:\n try: open(p,m); raise SystemExit('unexpected access '+p)\n except OSError: pass\nprint('denied')`);
  assert.equal(ok(r).trim(), 'denied');
});
test('parent process environment is inaccessible', async t => {
  if (!(report.layers.landlock || report.layers.namespaces || report.layers.uid)) return t.skip('No filesystem or UID boundary; report warns about same-UID processes');
  const r = await python(`try:\n open('/proc/${process.pid}/environ','rb').read(); raise SystemExit('parent environ readable')\nexcept OSError: print('denied')`);
  assert.equal(ok(r).trim(), 'denied');
});
test('seccomp rejects unshare and ptrace', async t => {
  if (!report.layers.seccomp) return t.skip('seccomp unavailable');
  const r = await python('import ctypes,errno; c=ctypes.CDLL(None,use_errno=True); assert c.unshare(0x10000000)==-1; assert ctypes.get_errno()==errno.EPERM; assert c.ptrace(0,0,0,0)==-1; assert ctypes.get_errno()==errno.EPERM; print("denied")');
  assert.equal(ok(r).trim(), 'denied');
  if (have('unshare')) assert.notEqual((await run(['unshare', '-U', 'true'])).code, 0);
});
test('common runtimes, compiler, threads and multiprocessing work', async t => {
  ok(await python('print("python")'));
  ok(await run([process.execPath, '-e', 'console.log("node")']));
  if (have('git')) ok(await run(['git', '--version']));
  if (have('gcc')) {
    await api.wsfs.write(ws, 'hello.c', Buffer.from('int main(void) { return 0; }\n'));
    ok(await run(['gcc', 'hello.c', '-o', 'hello']));
    ok(await run(['./hello']));
  } else t.diagnostic('gcc absent; compiler subcheck omitted');
  ok(await python('import threading; ts=[threading.Thread(target=lambda:None) for _ in range(50)]; [t.start() for t in ts]; [t.join() for t in ts]'));
  ok(await python('from multiprocessing import Pool\nwith Pool(3) as p: assert p.map(abs,[-1,-2,-3])==[1,2,3]'));
});
test('network off rejects Internet sockets, open permits them, Unix sockets work', async t => {
  if (!report.networkOff) return t.skip('Neither seccomp nor network namespaces available');
  ok(await python('import socket,errno\nfor family in [socket.AF_INET,socket.AF_INET6,socket.AF_PACKET,socket.AF_NETLINK]:\n try: socket.socket(family); raise SystemExit("network socket allowed")\n except OSError as e: assert e.errno in [errno.EACCES,errno.EPERM,errno.EAFNOSUPPORT]\nsocket.socket(socket.AF_UNIX)', { network: 'off' }));
  ok(await python('import socket; socket.socket(socket.AF_INET)', { network: 'open' }));
});
test('file size limit rejects oversized writes', async t => {
  if (!report.layers.rlimits) return t.skip('launcher unavailable or sandbox explicitly off');
  const r = await python('open("too-large","wb").write(b"x"*(2*1024*1024))', { limits: { fileMb: 1 } });
  assert.ok(r.code !== 0 || r.signal, JSON.stringify(r));
  assert.ok(fs.statSync(path.join(ws.dir, 'too-large')).size <= 1024 * 1024);
});
test('safe relative paths reject traversal, outside absolute paths, empty and NUL', () => {
  for (const p of ['../x','x/../y','/etc/passwd','','.','/workspace','x\0y']) assert.equal(api.wsfs.safeRel(p), null, p);
  for (const p of ['x','./x','/workspace/x','/workspace//x']) assert.equal(api.wsfs.safeRel(p), 'x');
});
test('wsfs round trip is binary safe, bounded and supports 5 MB', async () => {
  const b = Buffer.alloc(5 * 1024 * 1024); for(let i=0;i<b.length;i++) b[i]=i%256;
  await api.wsfs.write(ws, 'nested/binary', b);
  assert.deepEqual(await api.wsfs.read(ws, 'nested/binary', { maxBytes: b.length }), b);
  await assert.rejects(api.wsfs.read(ws, 'nested/binary', { maxBytes: 12 }), { code: 'ETOOBIG' });
  const stat = await api.wsfs.stat(ws, 'nested/binary'); assert.equal(stat.size, b.length); assert.equal(stat.dir, false);
  assert.equal(await api.wsfs.stat(ws, 'missing'), null);
  assert.ok((await api.wsfs.list(ws)).some(f => f.path === 'nested/binary' && f.size === b.length && f.mtime > 0));
  await api.wsfs.rename(ws, 'nested/binary', 'renamed');
  assert.ok(await api.wsfs.usage(ws) >= b.length);
  await api.wsfs.remove(ws, 'renamed');
  await api.wsfs.remove(ws, 'absent-parent/absent-file');
  await api.wsfs.remove(ws, 'already-absent');
  await api.wsfs.write(ws, 'sort/x', Buffer.from('x'));
  await api.wsfs.write(ws, 'sort.txt', Buffer.from('x'));
  const sortedPaths = (await api.wsfs.list(ws)).map(f => f.path);
  assert.deepEqual(sortedPaths, [...sortedPaths].sort());
  assert.equal(await api.wsfs.stat(ws, 'renamed'), null);
  for (const p of ['../x','/etc/passwd']) await assert.rejects(api.wsfs.read(ws,p), { code:'EACCES' });
  await assert.rejects(api.wsfs.remove(ws,''), { code:'EACCES' });
  await assert.rejects(api.wsfs.read(ws,'nested'), { code:'EISDIR' });
});
test('wsfs refuses escaping symlinks for reads and writes and lists links', async () => {
  ok(await python('import os; os.symlink("/etc/passwd","escape-link"); os.symlink("/etc","escape-dir")'));
  for(const p of ['escape-link','escape-dir/passwd']) {
    await assert.rejects(api.wsfs.read(ws,p), { code:'EACCES' });
    await assert.rejects(api.wsfs.write(ws,p,Buffer.from('no')), { code:'EACCES' });
  }
  const list = await api.wsfs.list(ws);
  assert.ok(list.some(f => f.path==='escape-link' && f.link));
  assert.ok(!list.some(f => f.path.startsWith('escape-dir/')));
  await api.wsfs.remove(ws, 'escape-link');
  await api.wsfs.remove(ws, 'escape-dir');
});
test('killTree terminates shell and every child in its process group', async () => {
  const child = api.spawnInWorkspace(ws,['bash','-c','sleep 100 & echo $!; sleep 100']);
  let done; const line = new Promise(r => {done=r;}); child.stdout.once('data',b=>done(b.toString()));
  const completed = capture(child); const pid = Number((await line).trim());
  assert.ok(pid>0); api.killTree(child);
  const result = await completed; assert.ok(result.signal || result.code !== 0);
  for(let i=0;i<30 && groupMembers(child.pid).some(p=>p.state!=='Z');i++) await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(groupMembers(child.pid).filter(p=>p.state!=='Z'), [], 'process-group member survived');
});
test('seccomp prevents process-group escape and killTree preserves other jobs', async t => {
  if (!report.layers.seccomp) return t.skip('seccomp unavailable; process-group escape cannot be prevented');
  ok(await python('import os,errno\nfor f in [os.setsid, lambda: os.setpgid(0,0)]:\n try: f(); raise SystemExit("escaped process group")\n except OSError as e: assert e.errno==errno.EPERM'));
  const survivor = api.spawnInWorkspace(ws,['python3','-u','-c','import time; print("ready"); time.sleep(100)']);
  const completed = capture(survivor);
  try {
    await new Promise((resolve,reject)=>{survivor.stdout.once('data',resolve);survivor.once('error',reject);});
    const victim = api.spawnInWorkspace(ws,['bash','-c','sleep 100']); const killed = capture(victim);
    api.killTree(victim); await killed;
    assert.equal(survivor.exitCode,null); assert.equal(survivor.signalCode,null); process.kill(survivor.pid,0);
  } finally { api.killTree(survivor); await completed; }
});
test('root mode drops to the workspace UID and cannot regain root', async t => {
  if (report.mode !== 'root') return t.skip('Requires a root server with working setuid; this host runs as a non-root user');
  const r = await python(`import os,errno; assert os.getuid()==${ws.uid}; assert os.getgid()==${ws.gid}\ntry: os.setuid(0); raise SystemExit('regained root')\nexcept OSError as e: assert e.errno==errno.EPERM`);
  ok(r);
});
test('Landlock alone protects data and parent proc entries without bubblewrap', async t => {
  if (!report.layers.landlock) return t.skip('Landlock is unavailable');
  const args = ['--landlock', '--seccomp', '--chdir', ws.dir];
  for (const p of ['/usr','/bin','/lib','/lib64','/etc','/proc/self','/proc/cpuinfo']) if(fs.existsSync(p)) args.push('--ro',p);
  args.push('--rw', ws.dir, '--rw', ws.tmp, '--', '/usr/bin/python3', '-c', `import os\nfor p in ['/proc/${process.pid}/environ',${JSON.stringify(path.join(root,'src/config.js'))}]:\n try: open(p,'rb'); raise SystemExit('unexpected access '+p)\n except OSError: pass\nopen('landlock-only','w').write('ok'); open('/proc/self/stat').read()`);
  const r = spawnSync(path.join(root,'sandbox/crbox'), args, {encoding:'utf8', env:{PATH:'/usr/bin:/bin'}});
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
test('explicit off mode still confines helper paths and scrubs the environment', () => {
  const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
    const {initSandbox,spawnInWorkspace,wsfs}=await import(${JSON.stringify(path.join(root,'src/sandbox.js'))});
    assert.equal((await initSandbox()).mode,'off');
    const ws={dir:${JSON.stringify(ws.dir)},tmp:${JSON.stringify(ws.tmp)}};
    await wsfs.write(ws,'off-file',Buffer.from([0,255,1])); assert.deepEqual(await wsfs.read(ws,'off-file'),Buffer.from([0,255,1]));
    fs.symlinkSync('/etc/passwd',ws.dir+'/off-link');
    await assert.rejects(wsfs.read(ws,'off-link'),{code:'EACCES'}); await assert.rejects(wsfs.write(ws,'off-link',Buffer.from('no')),{code:'EACCES'});
    await assert.rejects(wsfs.read(ws,'../private'),{code:'EACCES'});
    const child=spawnInWorkspace(ws,['/usr/bin/env']); let out=''; child.stdout.on('data',b=>out+=b); child.stdin.end();
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)}); assert.ok(!out.includes('SANDBOX_TEST_SECRET='));`;
  const r = spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,SANDBOX:'off'},timeout:10000});
  assert.equal(r.status,0,r.stderr || r.stdout);
});
test('clear empties content without deleting workspace root', async () => {
  await api.wsfs.clear(ws); assert.deepEqual(await api.wsfs.list(ws), []); assert.ok(fs.statSync(ws.dir).isDirectory());
});
