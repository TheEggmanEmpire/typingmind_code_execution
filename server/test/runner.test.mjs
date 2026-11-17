import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'cr-runner-test-'));
process.env.DATA_DIR=root;
const {config}=await import('../src/config.js');
config.waitBudgetS=10;
const {getWorkspace}=await import('../src/sessions.js');
const runner=await import('../src/runner.js');
if(process.env.SANDBOX_TEST_STUB==='1') runner.__setSandbox(await import('./_sandbox_stub.mjs'));
const {runCode,jobOutput,listJobs,killJob,shutdownRunner,resetWorkspaceState,stopKernel}=runner;
const ws=getWorkspace('test','main');
const run=(language,code,extra={})=>runCode(ws,{language,code,...extra});
after(async()=>{await shutdownRunner(); await fs.rm(root,{recursive:true,force:true});});
test('Python persistent namespace, expressions, await and stdin',async()=>{
  assert.equal((await run('python','x = 41')).exitCode,0);
  assert.match((await run('python','x+1')).text,/42/);
  assert.match((await run('python','import asyncio\nawait asyncio.sleep(0.01)\n"awaited"')).text,/awaited/);
  assert.match((await run('python','input()+input()', {stdin:'a\nb\n'})).text,/ab/);
});
test('Python tracebacks contain user lines without kernel frames',async()=>{
  const r=await run('python','def bad():\n    return 1/0\nbad()');
  assert.equal(r.exitCode,1); assert.match(r.text,/ZeroDivisionError/); assert.match(r.text,/<run>.*line 2/); assert.doesNotMatch(r.text,/kernel.py.*line/);
});
test('Python native fd and subprocess output',async()=>{
  const r=await run('python','import os, subprocess\nprint("first")\nos.write(1, b"native\\n")\nsubprocess.run(["echo", "child"])\nprint("last")');
  assert.match(r.text,/first\nnative\nchild\nlast/);
});
test('Python matplotlib figures',async t=>{
  const probe=await run('python','import matplotlib');
  if(probe.exitCode!==0 && /ModuleNotFoundError/.test(probe.text)) return t.skip('matplotlib is not installed in the workspace interpreter');
  const r=await run('python','import matplotlib.pyplot as plt\nplt.plot([1,2])'); assert.match(r.text,/figure_\d+\.png/);
});
test('Python interrupt timeout and subsequent run',async()=>{
  await run('python','survivor = 909');
  const t=Date.now(); const r=await run('python','while True: pass',{timeout:1});
  assert.match(r.text,/timed out|timeout/i); assert.ok(Date.now()-t<5500); assert.match((await run('python','3+4')).text,/7/);assert.match((await run('python','survivor')).text,/909/);
});
test('Python reset and idle save/restore data functions classes imports',async()=>{
  await run('python','answer = 73\nimport math\ndef f(x):\n    return x+answer\nclass Box:\n    def value(self):\n        return answer\nbox=Box()\nhandle=open("temporary.txt", "w")');
  await stopKernel(ws);
  const r=await run('python','(answer, f(1), box.value(), math.sqrt(9))');
  assert.match(r.text,/73, 74, 73, 3.0/); assert.match(r.text,/handle/);
  await run('python','None',{reset:true}); assert.match((await run('python','answer')).text,/NameError/);
});
test('Python output cap',async()=>{const r=await run('python','print("x"*100000)');assert.ok(r.text.length<42000);assert.match(r.text,/60001 characters dropped/);});
test('JavaScript return, await and storage',async()=>{
  assert.match((await run('javascript','await sleep(10); return 42')).text,/42/);
  await run('javascript','storage.set("hello", {v:17})'); assert.match((await run('javascript','return storage.get("hello").v')).text,/17/);
});
test('JavaScript fs and Python share real files',async()=>{
  assert.match((await run('javascript','await fs.writeFile("shared.txt","from node"); return await fs.readFile("shared.txt")')).text,/Files created: shared.txt/);
  assert.match((await run('python','read_text("shared.txt")')).text,/from node/);
  assert.match((await run('javascript','return require("node:path").basename("a/b")')).text,/b/);
});
test('TypeScript native stripping and strict errors',async()=>{
  assert.match((await run('typescript','const x: number = 5; return x*2')).text,/10/);
  const r=await run('typescript','const x: number = "bad";\nawait fs.writeFile("should-not-exist", "bad");',{typecheck:true});assert.match(r.text,/line 1: TS2322/);assert.equal(r.exitCode,1);
});
test('bash and sqlite with multiple statements and shared db',async()=>{
  assert.match((await run('bash','printf "hello %s" "$WORKSPACE"')).text,/hello/);
  const r=await run('sql',"create table t (n int, s text); insert into t values (7,'a;b'); select * from t;");assert.match(r.text,/n\s+\| s/);assert.match(r.text,/7\s+\| a;b/);
  assert.match((await run('python','import sqlite3\nsqlite3.connect("data.sqlite").execute("select n from t").fetchone()')).text,/7/);
});
test('C stdin',{skip:spawnSync('which',['gcc']).status!==0},async()=>{
  const r=await run('c','#include <stdio.h>\nint main(){int n;scanf("%d",&n);printf("hello %d\\n",n);}',{stdin:'21'});assert.match(r.text,/hello 21/);assert.equal(r.exitCode,0);
});
test('jobs survive wait budget and can be followed',async()=>{
  config.waitBudgetS=1;const r=await run('python','import time\nprint("start",flush=True)\ntime.sleep(4)\nprint("end")');config.waitBudgetS=10;
  assert.equal(r.running,true);assert.ok(r.jobId);assert.match(r.text,/start/);
  const out=await jobOutput(ws,r.jobId,{waitMs:6000});assert.equal(out.job.state,'done');assert.match(out.text,/end/);
});
test('kill job and Python busy refusal',async()=>{
  const r=await run('python','import time\ntime.sleep(20)',{background:true});
  assert.match((await run('python','1')).text,/python is busy with job/);
  assert.equal(killJob(ws,r.jobId),true);await jobOutput(ws,r.jobId,{waitMs:5000});assert.equal(listJobs(ws).find(j=>j.id===r.jobId).state,'killed');
});
test('secrets redacted including encoded forms, log and split chunks',async()=>{
  const value='secret_xyz_92837';const r=await run('javascript','console.log(env.TEST_TOKEN); console.log(Buffer.from(env.TEST_TOKEN).toString("base64")); process.stdout.write(env.TEST_TOKEN.slice(0,6)); await sleep(300); process.stdout.write(env.TEST_TOKEN.slice(6));',{secrets:{TEST_TOKEN:value}});
  assert.doesNotMatch(r.text,new RegExp(value));assert.doesNotMatch(r.text,new RegExp(Buffer.from(value).toString('base64')));assert.match(r.text,/\[secret TEST_TOKEN\]/);
  const log=await fs.readFile(path.join(ws.tmp,'jobs',r.jobId+'.log'),'utf8');assert.doesNotMatch(log,new RegExp(value));
});
test('stream output before completion',async()=>{
  const chunks=[];let finished=false;const p=runCode(ws,{language:'python',code:'import time\nprint("early",flush=True)\ntime.sleep(1.2)\nprint("late",flush=True)'},{onOutput:s=>{assert.equal(finished,false);chunks.push(s);}});
  await new Promise(r=>setTimeout(r,600));assert.match(chunks.join(''),/early/);await p;finished=true;
});
test('JS import uses native fs; compatibility tables/charts survive Python',async()=>{
  const r=await run('javascript','import fs from "node:fs"; fs.writeFileSync("native.txt", "native"); tables.set("demo", [{a:1,b:"x,y"},{a:2,b:"z"}]); return await chart(tables.get("demo"),{x:"a",y:"a",path:"chart.html"})');
  assert.equal(r.exitCode,0);assert.match(r.text,/chart.html/);
  assert.match((await run('python','list_tables()')).text,/demo/);
  assert.match((await run('python','chart([1,2,3], path="python-chart.html")')).text,/python-chart.html/);
});
test('Python request env clears old secrets and hints use PyPI aliases',async()=>{
  const r=await run('python','import os\nprint(os.environ["TEMP_KEY"])',{secrets:{TEMP_KEY:'secret-with/slash?value'}});assert.match(r.text,/\[secret TEMP_KEY\]/);
  assert.match((await run('python','os.environ.get("TEMP_KEY", "removed")')).text,/removed/);
  assert.match((await run('python','import no_such_test_module')).text,/packages: \["no_such_test_module"\]/);
});
test('file diffs and missing-file messages are actionable',async()=>{
  const w=getWorkspace('test','diff');
  const r=await runCode(w,{language:'bash',code:'printf changed > old.txt; rm gone.txt; printf new > new.txt',files:[{path:'old.txt',content:'old'},{path:'gone.txt',content:'remove'}]});
  assert.equal((r.text.match(/Files created:/g)||[]).length,1);assert.match(r.text,/new.txt/);assert.doesNotMatch(r.text,/\.cr\//);
  const missing=await runCode(w,{language:'python',code:'open("missing.csv")'});assert.match(missing.text,/workspace contains: .*new.txt/);
});
test('output offsets follow growing jobs without duplicating prior text',async()=>{
  const r=await run('bash','echo once; sleep 1; echo twice',{background:true});
  await new Promise(resolve=>setTimeout(resolve,400));
  const first=await jobOutput(ws,r.jobId);assert.match(first.text,/once/);
  const last=await jobOutput(ws,r.jobId,{since:first.next,waitMs:3000});assert.match(last.text,/twice/);assert.doesNotMatch(last.text,/once/);
});
test('Python hard interrupt fallback loses state and next run recovers',async()=>{
  await run('python','kept_until_killed = 10');
  const start=Date.now();const result=await run('python','import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True: pass',{timeout:1});
  assert.match(result.text,/timed out/);assert.ok(Date.now()-start<6000);
  assert.match((await run('python','print("fresh")')).text,/Variables were lost/);
});
test('max jobs and quota refuse new work',async()=>{
  const w=getWorkspace('test','limits');const oldMax=config.maxJobs;config.maxJobs=1;
  const r=await runCode(w,{language:'bash',code:'sleep 3',background:true});
  assert.match((await runCode(w,{language:'bash',code:'echo fail'})).text,/Too many running jobs/);
  killJob(w,r.jobId);await jobOutput(w,r.jobId,{waitMs:4000});config.maxJobs=oldMax;
  const oldQuota=config.quotaMb;config.quotaMb=0;
  await fs.writeFile(path.join(w.dir,'large'),'x');
  assert.match((await runCode(w,{language:'bash',code:'echo fail'})).text,/quota exceeded.*manage_files/);config.quotaMb=oldQuota;
});
test('log is durable, bounded at 5 MB, and recovered by a new runner instance',async()=>{
  const r=await run('javascript','process.stdout.write("L".repeat(6*1024*1024));');
  assert.equal((await fs.stat(path.join(ws.tmp,'jobs',r.jobId+'.log'))).size,5*1024*1024);
  const recovered=await import('../src/runner.js?restart='+Date.now());
  const out=await recovered.jobOutput(ws,r.jobId);assert.equal(out.job.state,'done');assert.match(out.text,/^LLL/);assert.ok(out.text.length<42000);
});
test('DuckDB shared views and persisted tables',{skip:!runner.localLanguages().duckdb},async()=>{
  const r=await run('duckdb','CREATE TABLE stored AS SELECT * FROM demo; SELECT * FROM stored;');assert.match(r.text,/x,y/);
  assert.match((await run('duckdb','SELECT count(*) AS n FROM stored;')).text,/2/);
});
test('R state and chart helper',{skip:!runner.localLanguages().r},async()=>{
  await run('r','answer <- 42');assert.match((await run('r','print(answer); chart(data.frame(x=c(1,2),y=c(2,3)),path="rchart.html")')).text,/42/);
});
test('other local runtimes execute when installed',async t=>{
  const samples={
    'c++':'#include <iostream>\nint main(){std::cout << "local-ok";}',
    rust:'fn main(){println!("local-ok");}',
    go:'package main\nimport "fmt"\nfunc main(){fmt.Println("local-ok")}',
    java:'class Run {public static void main(String[] args){System.out.println("local-ok");}}',
    ruby:'puts "local-ok"',php:'<?php echo "local-ok";',lua:'print("local-ok")',perl:'print "local-ok\\n";'
  };
  for(const [lang,code] of Object.entries(samples)) await t.test(lang,{skip:!runner.localLanguages()[lang]},async subtest=>{
    const r=await run(lang,code);
    if(r.exitCode===126 && /execvp: (No such file or directory|Permission denied)/.test(r.text)) return subtest.skip('runtime is installed outside paths accessible to the sandbox');
    assert.equal(r.exitCode,0,r.text);assert.match(r.text,/local-ok/);
  });
});
test('Python lambda source survives idle save',async()=>{
  await run('python','offset = 11\nplus = lambda x: x+offset');await stopKernel(ws);
  assert.match((await run('python','plus(2)')).text,/13/);
});
test('Python main guard and a package added after kernel startup',async()=>{
  assert.match((await run('python','if __name__ == "__main__":\n    print("main guard works")')).text,/main guard works/);
  await run('python','import site, pathlib\np = pathlib.Path(site.getusersitepackages())\np.mkdir(parents=True, exist_ok=True)\n(p / "late_package.py").write_text("value = 818")');
  assert.match((await run('python','import late_package\nlate_package.value')).text,/818/);
});
test('recovered job logs cannot follow a planted symlink',async()=>{
  const w=getWorkspace('test','log-links');const dir=path.join(w.tmp,'jobs');await fs.mkdir(dir,{recursive:true});
  const outside=path.join(root,'outside.txt');await fs.writeFile(outside,'must-not-be-read');
  await fs.writeFile(path.join(dir,'jabc123.json'),JSON.stringify({id:'jabc123',language:'bash',state:'done',started:Date.now(),ended:Date.now(),exitCode:0,label:'old job'}));
  await fs.symlink(outside,path.join(dir,'jabc123.log'));
  const recovered=await import('../src/runner.js?links='+Date.now());const out=await recovered.jobOutput(w,'jabc123');assert.doesNotMatch(out.text,/must-not-be-read/);
});
test('Node imports resolve relative files and native packages from the workspace',async()=>{
  const files=[{path:'local-module.mjs',content:'export default 517;'},
    {path:'node_modules/local-fixture/package.json',content:'{"name":"local-fixture","type":"module","exports":"./index.js"}'},
    {path:'node_modules/local-fixture/index.js',content:'export const number=23;'}];
  const r=await run('javascript','import {number} from "local-fixture"; const local=await import("./local-module.mjs"); return local.default+number',{files});
  assert.equal(r.exitCode,0,r.text);assert.match(r.text,/540/);
});
test('missing DuckDB module gives the native package installation hint',{skip:!!runner.localLanguages().duckdb},async()=>{
  const r=await run('duckdb','SELECT 1');assert.equal(r.exitCode,1);assert.match(r.text,/install the duckdb Python package/);
});
test('secret redaction includes URL form encoding and regexp characters',()=>{
  const secret='alpha b/c?d.*';const text=[secret,encodeURIComponent(secret),encodeURIComponent(secret).replace(/%20/g,'+'),Buffer.from(secret).toString('base64')].join('\n');
  assert.equal(runner.redact(text,{API_KEY:secret}),'[secret API_KEY]\n'.repeat(3)+'[secret API_KEY]');
});
