import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {config} from "./config.js";
import {legacy} from "./legacy.js";
import * as sandbox from "./sandbox.js";

let box = sandbox;
export function __setSandbox(mod) { box = mod; }
const pyDir = fileURLToPath(new URL('../py/', import.meta.url));
const jobs = new Map(), kernels = new Map(), lostKernels = new Set(), secretBanks = new Map();
const LOG_LIMIT = 5 * 1024 * 1024;
let stopping = false;
const descriptors = {
  python: {bin:'python3', version:['--version']},
  javascript: {bin:process.execPath, version:['--version']},
  typescript: {bin:process.execPath, version:['--version']},
  bash: {bin:'bash', extension:'sh'},
  sql: {bin:'python3'}, duckdb: {bin:'python3'},
  c: {bin:'gcc',extension:'c',compile:['-O2','-std=c17']},
  'c++': {bin:'g++',extension:'cpp',compile:['-O2','-std=c++20']},
  go: {bin:'go',extension:'go',compile:['build']},
  rust: {bin:'rustc',extension:'rs',compile:['-O']},
  java: {bin:'java',extension:'java'}, ruby:{bin:'ruby',extension:'rb'},
  php:{bin:'php',extension:'php'}, lua:{bin:'lua',extension:'lua'},
  perl:{bin:'perl',extension:'pl'}, r:{bin:'Rscript',extension:'R'}
};
const installed = {};
for (const [language,d] of Object.entries(descriptors)) {
  const probe = path.isAbsolute(d.bin) ? {status:0,stdout:d.bin} : spawnSync('which',[d.bin],{encoding:'utf8',timeout:3000});
  if(probe.status!==0) continue;
  d.executable=probe.stdout.trim();
  // A rustup proxy depends on the server HOME. Resolve it once so workspace
  // HOME stays scrubbed and the compiler itself is launched directly.
  if(language==='rust') {
    try {
      const real=fs.realpathSync(d.executable);
      if(path.basename(real)==='rustup') {
        const toolchain=spawnSync(real,['which','rustc'],{encoding:'utf8',timeout:3000});
        if(toolchain.status===0) d.executable=toolchain.stdout.trim();
      }
    } catch {}
  }
  const v=spawnSync(d.executable,d.version || (language==='java' ? ['-version'] : ['--version']),{encoding:'utf8',timeout:3000});
  installed[language]=String(v.stdout || v.stderr || 'installed').split('\n')[0].trim() || 'installed';
}
if(installed.duckdb && spawnSync(descriptors.duckdb.executable,['-c','import duckdb'],{timeout:5000}).status!==0) delete installed.duckdb;
export function localLanguages() { return {...installed}; }
export function allLanguages() { return [...new Set([...legacy.ALL_LANGS,...Object.keys(descriptors)])]; }
function languageOf(value) {
  const s=String(value || '').toLowerCase().trim();
  return ({sh:'bash',shell:'bash',zsh:'bash',node:'javascript',py:'python',cpp:'c++',cxx:'c++',cc:'c++'})[s] || legacy.normalizeLanguage(s) || (descriptors[s] ? s : null);
}
function secretPairs(secrets) {
  const pairs=[];
  for(const [name,value] of Object.entries(secrets || {})) {
    if(typeof value!=='string' || !value) continue;
    const forms=new Set([value,Buffer.from(value).toString('base64')]);
    try {const encoded=encodeURIComponent(value);forms.add(encoded);forms.add(encoded.replace(/%20/g,'+'));} catch {}
    for(const form of forms) pairs.push([form,name]);
  }
  return pairs.sort((a,b)=>b[0].length-a[0].length);
}
function replaceSecrets(text,pairs) {
  // One replacement pass prevents a later secret from rewriting a replacement label.
  if(!pairs.length) return String(text);
  const escaped=pairs.map(([s])=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const names=new Map(pairs);
  return String(text).replace(new RegExp(escaped.join('|'),'g'),m=>'[secret '+names.get(m)+']');
}
export function redact(text,secrets) { return replaceSecrets(text,secretPairs(secrets)); }
class StreamRedactor {
  constructor(pairs) { this.pairs=pairs; this.pending=''; this.keep=Math.max(1,...pairs.map(([s])=>s.length))-1; }
  push(text,final=false) {
    this.pending+=String(text);
    let keep=0;
    if(!final) for(const [form] of this.pairs) for(let n=1;n<form.length && n<=this.pending.length;n++) {
      if(this.pending.endsWith(form.slice(0,n))) keep=Math.max(keep,n);
    }
    let cut=this.pending.length-keep;
    if(!final) for(const [s] of this.pairs) {
      let p=this.pending.indexOf(s);
      while(p>=0 && p<cut) { if(p+s.length>cut) { cut=p; break; } p=this.pending.indexOf(s,p+s.length); }
    }
    const out=replaceSecrets(this.pending.slice(0,cut),this.pairs);
    this.pending=this.pending.slice(cut);return out;
  }
}
function workspaceJobs(ws) {
  if(jobs.has(ws.id)) return jobs.get(ws.id);
  const map=new Map(); jobs.set(ws.id,map);
  // Logs and metadata survive a server restart. An old running process is no
  // longer controllable by this server, so it is reported as interrupted.
  const directory=path.join(ws.tmp,'jobs');
  try { for(const filename of fs.readdirSync(directory)) {
    if(!/^j[\da-f]+\.json$/.test(filename)) continue;
    try {
      const item=JSON.parse(readPrivate(directory,filename,128*1024));
      if(item.id+'.json'!==filename) continue;
      if(item.state==='running') { item.state='failed';item.ended=Date.now();item.interrupted=true;delete item.output; }
      map.set(item.id,{...item,ws,recovered:true,finished:true});
    } catch {}
  } } catch {}
  return map;
}
function publicJob(j) { return Object.fromEntries(['id','language','state','started','ended','exitCode','label'].map(k=>[k,j[k]??null])); }
export function listJobs(ws) { return [...workspaceJobs(ws).values()].map(publicJob); }
function snapshot(j,since=0) {
  if(j.recovered) {
    if(j.output) return snapshot({...j,...j.output,recovered:false},since);
    let value=''; try { value=readPrivate(path.join(j.ws.tmp,'jobs'),j.id+'.log',LOG_LIMIT); } catch {}
    if(j.interrupted) value+='\nServer restarted; this job was interrupted. Its saved output is above.\n';
    const head=value.slice(0,config.outputHead),tail=value.length>config.outputHead?value.slice(Math.max(config.outputHead,value.length-config.outputTail)):'';
    return snapshot({head,tail,total:value.length},since);
  }
  since=Math.max(0,Number(since)||0);
  const tailStart=j.total-j.tail.length;
  let text='';
  if(since<j.head.length) text+=j.head.slice(since);
  const gap=Math.max(0,tailStart-Math.max(since,j.head.length));
  if(gap) text+='\n['+gap+' characters dropped in the middle]\n';
  if(j.tail.length) text+=j.tail.slice(Math.max(0,since-tailStart));
  return {text,next:j.total};
}
function writeOutput(j,text) {
  if(!text) return;
  j.total+=text.length;
  if(j.head.length<config.outputHead) {
    const n=Math.min(config.outputHead-j.head.length,text.length);j.head+=text.slice(0,n);text=text.slice(n);
  }
  if(text) j.tail=(j.tail+text).slice(-config.outputTail);
}
function emitRaw(j,text) {
  if(!text) return;
  writeOutput(j,text);
  if(j.logFd!==undefined && j.logBytes<LOG_LIMIT) {
    let b=Buffer.from(text);b=b.subarray(0,LOG_LIMIT-j.logBytes);
    try {fs.writeSync(j.logFd,b);j.logBytes+=b.length;} catch {}
  }
  if(typeof j.hooks.onOutput==='function') {
    j.notify+=text;
    if(!j.notifyTimer) {
      const delay=Math.max(0,250-(Date.now()-j.lastNotify));
      j.notifyTimer=setTimeout(()=>flushNotify(j),delay);
    }
  }
}
function flushNotify(j) {
  clearTimeout(j.notifyTimer);j.notifyTimer=null;
  if(j.notify) {const text=j.notify;j.notify='';j.lastNotify=Date.now();try {Promise.resolve(j.hooks.onOutput(text)).catch(()=>{});} catch {} }
}
function append(j,text) { if(!j.finished) emitRaw(j,j.redactor.push(text)); }
function note(j,text) { append(j,'\n'+text+'\n'); }
function openDirectory(directory) {
  return fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
}
function inDirectory(directory,callback) {
  const fd=openDirectory(directory);
  try {return callback('/proc/self/fd/'+fd);} finally {fs.closeSync(fd);}
}
function readPrivate(directory,name,maxBytes) {
  return inDirectory(directory,base=>{
    const fd=fs.openSync(base+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      const info=fs.fstatSync(fd);
      if(!info.isFile() || info.nlink!==1) throw new Error('Expected a regular job file.');
      const size=Math.min(info.size,maxBytes);
      const bytes=Buffer.alloc(size);let used=0,n;
      while(used<size && (n=fs.readSync(fd,bytes,used,size-used,null))>0) used+=n;
      return bytes.subarray(0,used).toString('utf8');
    } finally {fs.closeSync(fd);}
  });
}
async function privateFile(j,name,contents) {
  // Hold the parent directory open: code can rename or symlink its tmp paths,
  // but it cannot redirect a privileged write through this descriptor.
  inDirectory(j.runDir,base=>{
    const fd=fs.openSync(base+'/'+name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,contents);if(process.getuid?.()===0) fs.fchownSync(fd,j.ws.uid,j.ws.gid);} finally {fs.closeSync(fd);}
  });
  return path.join(j.runDir,name);
}
function persistJob(j) {
  try {
    // A descriptor held from creation cannot be redirected by workspace code.
    if(j.metaFd!==undefined) {fs.ftruncateSync(j.metaFd,0);fs.writeSync(j.metaFd,JSON.stringify({...publicJob(j),output:j.finished?{head:j.head,tail:j.tail,total:j.total}:undefined}),0,'utf8');}
  } catch {}
}
async function finish(j,exitCode) {
  if(j.finishing || j.finished) return j.done;
  j.finishing=true;clearTimeout(j.timeoutTimer);clearTimeout(j.killTimer);
  try {
    if(j.cancelReason) {j.state=j.cancelReason;note(j,j.cancelReason==='timeout' ? 'Run timed out after '+j.timeout+' s.' : 'Job killed.');}
    else j.state=exitCode===0?'done':'failed';
    j.exitCode=j.cancelReason==='timeout'?124:j.cancelReason==='killed'?137:exitCode;
    const after=await box.wsfs.list(j.ws);
    const before=new Map((j.before || after).filter(f=>!f.path.startsWith('.cr/')).map(f=>[f.path,f]));
    const created=[],changed=[],deleted=[];
    for(const f of after.filter(f=>!f.path.startsWith('.cr/'))) {
      const previous=before.get(f.path);
      if(!previous) created.push(f.path+' ('+legacy.fmtSize(f.size)+')');
      else if(previous.size!==f.size || previous.mtime!==f.mtime) changed.push(f.path);
      before.delete(f.path);
    }
    deleted.push(...before.keys());
    const parts=[];
    if(created.length) parts.push('Files created: '+created.join('; '));
    if(changed.length) parts.push((parts.length?'changed: ':'Files changed: ')+changed.join('; '));
    if(deleted.length) parts.push((parts.length?'deleted: ':'Files deleted: ')+deleted.join('; '));
    if(parts.length) note(j,parts.join('; '));
    const preview=snapshot(j).text+j.redactor.pending;
    if(/ENOENT|FileNotFoundError|No such file or directory/.test(preview)) {
      const files=after.filter(f=>!f.path.startsWith('.cr/')).slice(0,40).map(f=>f.path);
      note(j,files.length?'/workspace contains: '+files.join(', '):'/workspace is empty. Write the file first or pass it in files.');
    }
  } catch(e) {note(j,'Could not list workspace files: '+e.message);}
  emitRaw(j,j.redactor.push('',true));
  if(j.notify && j.lastNotify && Date.now()-j.lastNotify<250) await new Promise(resolve=>setTimeout(resolve,250-(Date.now()-j.lastNotify)));
  flushNotify(j);
  j.ended=Date.now();j.finished=true;j.finishing=false;
  persistJob(j);
  for(const key of ['logFd','metaFd']) if(j[key]!==undefined) {try {fs.closeSync(j[key]);} catch {} delete j[key];}
  try {
    if(j.recordHistory!==false) {j.ws.meta.history ||= [];
    j.ws.meta.history.push({language:j.language,code:replaceSecrets(j.params.code,j.pairs),output:snapshot(j).text.slice(0,2000),time:j.started});
    j.ws.meta.history=j.ws.meta.history.slice(-200);j.ws.saveMeta();}
  } catch {}
  // The run's scratch folder (scripts, compiled programs) is done with, unless a
  // live Python session was started from it and still needs its files. Removed
  // as the workspace's own user: the folder's contents are the code's to plant.
  if(j.runDir && ![...kernels.values()].some(k=>k.home===j.runDir && !k.closed)) {
    try {const rm=box.spawnInWorkspace(j.ws,['rm','-rf','--',j.runDir],{stdin:'ignore',network:'off'});rm.on('error',()=>{});rm.stdout?.resume();rm.stderr?.resume();} catch {}
  }
  // Finished jobs retain only the bounded output and public status.
  j.params={};j.secrets={};j.pairs=[];j.hooks={};j.kernel=null;
  j.resolve();
}
function abortJob(j,reason) {
  if(j.finished || j.finishing || j.cancelReason) return;
  j.cancelReason=reason;
  if(j.kernel && j.kernel.busy===j.id) {
    try {frame(j.kernel.requests,{op:'interrupt',id:j.id});} catch {}
    j.killTimer=setTimeout(()=>{
      if(j.finished) return;
      lostKernels.add(j.ws.id);kernels.delete(j.ws.id);box.killTree(j.kernel.child,'SIGKILL');
      void finish(j,reason==='timeout'?124:137);
    },3000);
  } else {
    if(j.child) {box.killTree(j.child,'SIGKILL');return;}
    if(j.preparing) return;
    // Covers cancellation during file preparation or a remote HTTP request.
    void finish(j,reason==='timeout'?124:137);
  }
}
export function killJob(ws,id) {
  const j=workspaceJobs(ws).get(id);if(!j || j.finished || j.finishing) return false;abortJob(j,'killed');return true;
}
async function waitFor(promise,ms) {
  let timer;
  try {await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(resolve,Math.max(0,ms));})]);} finally {clearTimeout(timer);}
}
export async function jobOutput(ws,id,{waitMs=0,since=0}={}) {
  const j=workspaceJobs(ws).get(id);if(!j) throw new Error('No job '+id+'. Use job action list to see jobs.');
  if(!j.finished) await waitFor(j.done,Math.min(45000,Math.max(0,waitMs)));
  return {job:publicJob(j),...snapshot(j,since)};
}
function frame(stream,object) {
  const b=Buffer.from(JSON.stringify(object));const header=Buffer.alloc(4);header.writeUInt32BE(b.length);
  stream.write(Buffer.concat([header,b]));
}
function parseFrames(stream,receive,fail) {
  let data=Buffer.alloc(0);
  stream.on('data',chunk=>{
    data=Buffer.concat([data,chunk]);
    while(data.length>=4) {
      const size=data.readUInt32BE(0);
      if(size>64*1024*1024) {fail(new Error('Python control frame is too large. Reset the kernel.'));return;}
      if(data.length<size+4) return;
      const payload=data.subarray(4,size+4);data=data.subarray(4+size);
      try {receive(JSON.parse(payload.toString('utf8')));} catch(e) {fail(e);}
    }
  });
}
function pipEnv(ws) {return {PIP_USER:'1',PYTHONUSERBASE:path.join(ws.dir,'.cr','pyuser'),PYTHONUNBUFFERED:'1',MPLBACKEND:'Agg'};}
async function ensureKernel(j) {
  if(j.cancelReason) throw new Error('Job cancelled.');
  let k=kernels.get(j.ws.id);
  if(k?.stopping) {await k.stopping;k=null;}
  if(k && !k.closed) {clearTimeout(k.idleTimer);return k;}
  const kernelFile=await privateFile(j,'kernel.py',await fsp.readFile(path.join(pyDir,'kernel.py')));
  await privateFile(j,'helpers.py',await fsp.readFile(path.join(pyDir,'helpers.py')));
  const chartFile=await privateFile(j,'chart.html',legacy.CHART_HTML);
  if(j.cancelReason) throw new Error('Job cancelled.');
  // The sandbox launcher closes every descriptor above 2, so requests go in on
  // stdin and events come back on stderr, each line marked with a prefix that is
  // random per kernel (user output never carries it by accident).
  const controlPrefix='__CR_'+crypto.randomBytes(24).toString('hex')+'__';
  const child=box.spawnInWorkspace(j.ws,[descriptors.python.executable,'-u',kernelFile],{
    env:{...pipEnv(j.ws),CR_CHART_HTML:chartFile,CR_CONTROL_STDIO:'1',CR_CONTROL_PREFIX:controlPrefix},stdin:'pipe'
  });
  k={child,ws:j.ws,pending:new Map(),busy:j.id,closed:false,requests:child.stdin,home:j.runDir};kernels.set(j.ws.id,k);
  k.ready=new Promise((resolve,reject)=>{k.readyResolve=resolve;k.readyReject=reject;});
  k.exited=new Promise(resolve=>{k.exitResolve=resolve;});
  const startupTimer=setTimeout(()=>{box.killTree(child);k.readyReject(new Error('Python kernel did not start within 15 s.'));},15000);
  k.ready.then(()=>clearTimeout(startupTimer),()=>clearTimeout(startupTimer));
  const fail=e=>{
    k.readyReject(e);
    for(const [id,p] of k.pending) {p.reject(e);k.pending.delete(id);}
  };
  k.requests.on('error',fail);
  const receive=event=>{
    if(event.type==='ready') {k.readyResolve(event);return;}
    const pending=k.pending.get(event.id);
    if(!pending) return;
    if(event.type==='output') append(pending.job,event.text);
    else if(event.type==='missing') note(pending.job,'Hint: pass packages: ["'+(legacy.PY_PIP_ALIASES[event.module]||event.module)+'"] to install it.');
    else if(event.type==='done' || event.type==='saved') {k.pending.delete(event.id);pending.resolve(event);}
  };
  if(controlPrefix) {
    let pending='';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',text=>{
      pending+=text;let newline;
      while((newline=pending.indexOf('\n'))>=0) {
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        if(line.startsWith(controlPrefix)) {
          try {receive(JSON.parse(Buffer.from(line.slice(controlPrefix.length),'base64').toString('utf8')));} catch(e) {fail(e);}
        } else append(workspaceJobs(k.ws).get(k.busy)||j,line+'\n');
      }
    });
  } else {child.stdio[4].on('error',fail);parseFrames(child.stdio[4],receive,fail);}
  child.stdout?.on('data',chunk=>{const job=workspaceJobs(k.ws).get(k.busy);if(job) append(job,chunk.toString());});
  if(!controlPrefix) child.stderr?.on('data',chunk=>{const job=workspaceJobs(k.ws).get(k.busy)||j;if(job) append(job,chunk.toString());});
  child.once('error',fail);
  child.once('close',(code,signal)=>{
    k.closed=true;clearTimeout(k.idleTimer);k.exitResolve();
    if(kernels.get(j.ws.id)===k) kernels.delete(j.ws.id);
    // The session is over: its scratch folder can go (as the workspace's own user).
    if(k.home) {try {const rm=box.spawnInWorkspace(k.ws,['rm','-rf','--',k.home],{stdin:'ignore',network:'off'});rm.on('error',()=>{});rm.stdout?.resume();rm.stderr?.resume();} catch {}}
    if(k.busy && !k.saving) lostKernels.add(j.ws.id);
    fail(new Error('Python kernel stopped'+(signal?' ('+signal+')':' (exit '+code+')')+'. Variables were lost; the next run starts a fresh kernel.'));
  });
  j.kernel=k;
  await k.ready;return k;
}
function kernelRequest(k,request,job) {
  return new Promise((resolve,reject)=>{
    k.pending.set(request.id,{resolve,reject,job});
    try {frame(k.requests,request);} catch(e) {k.pending.delete(request.id);reject(e);}
  });
}
async function pythonRun(j) {
  if(Array.isArray(j.params.packages) && j.params.packages.length) {
    const packages=j.params.packages.map(String);
    if(packages.some(p=>p.startsWith('-') || /[\r\n\0]/.test(p))) throw new Error('packages must contain package names or requirements, not pip options.');
    const result=await processRun(j,[descriptors.python.executable,'-m','pip','install','--user','--quiet',...packages],pipEnv(j.ws));
    if(result!==0 || j.cancelReason) return result;
  }
  const k=await ensureKernel(j);j.kernel=k;
  if(j.cancelReason) {k.busy=null;await stopKernel(j.ws);return 137;}
  k.busy=j.id;
  const ready=await k.ready;
  if(!k.reportedRestore) {
    if(ready.skipped?.length) note(j,'These Python variables could not be kept: '+ready.skipped.join(', ')+'. Recreate them.');
    k.reportedRestore=true;
  }
  if(lostKernels.delete(j.ws.id)) note(j,'The Python kernel was stopped. Variables were lost; this is a fresh kernel.');
  try {
    const result=await kernelRequest(k,{id:j.id,code:j.params.code,stdin:j.params.stdin||'',cwd:j.ws.dir,secrets:j.secrets},j);
    for(const s of result.notes||[]) note(j,s);
    return result.exitCode;
  } finally {
    k.busy=null;
    if(!k.closed && !stopping) {
      k.idleTimer=setTimeout(()=>{void stopKernel(j.ws).catch(()=>lostKernels.add(j.ws.id));},config.kernelIdleMin*60000);
      k.idleTimer.unref();
    }
  }
}
// Also exported for explicit idle save/restore tests and graceful lifecycle use.
export async function stopKernel(ws) {
  const k=kernels.get(ws.id);if(!k || k.closed) return [];
  if(k.stopping) return k.stopping;
  if(k.busy) throw new Error('python is busy with job '+k.busy);
  clearTimeout(k.idleTimer);k.saving=true;
  k.stopping=(async()=>{
    let saved;
    try {
      const result=kernelRequest(k,{op:'stop',id:'save-'+crypto.randomBytes(4).toString('hex')});
      await waitFor(result.then(r=>{saved=r;}),5000);
      if(!saved) throw new Error('Saving Python variables timed out.');
      if(saved.error) throw new Error(saved.error);
      await waitFor(k.exited,1000);
      return saved.skipped||[];
    } finally {if(!k.closed) box.killTree(k.child);if(kernels.get(ws.id)===k) kernels.delete(ws.id);}
  })();return k.stopping;
}
export async function resetWorkspaceState(ws) {
  for(const j of workspaceJobs(ws).values()) if(!j.finished && j.language==='python') {
    killJob(ws,j.id);await waitFor(j.done,4000);
  }
  await resetKernel(ws);
}
async function resetKernel(ws) {
  const k=kernels.get(ws.id);
  if(k) {clearTimeout(k.idleTimer);k.saving=true;box.killTree(k.child);await waitFor(k.exited,1000);kernels.delete(ws.id);}
  lostKernels.delete(ws.id);
  await box.wsfs.remove(ws,'.cr/session.pkl');
}
export async function shutdownRunner() {
  stopping=true;
  const active=[...jobs.values()].flatMap(m=>[...m.values()]).filter(j=>!j.finished);
  for(const j of active) killJob(j.ws,j.id);
  await Promise.all(active.map(j=>waitFor(j.done,4000)));
  await Promise.all([...kernels.values()].map(async k=>{try {await stopKernel(k.ws);}catch {box.killTree(k.child);}}));
  stopping=false;
}
function processRun(j,argv,extraEnv={}) {
  if(j.cancelReason || j.finished) return Promise.resolve(137);
  const child=box.spawnInWorkspace(j.ws,argv,{env:{...extraEnv,...j.secrets},stdin:'pipe'});j.child=child;
  return new Promise((resolve,reject)=>{
    const out=new TextDecoder(),err=new TextDecoder();
    child.stdout?.on('data',b=>append(j,out.decode(b,{stream:true})));
    child.stderr?.on('data',b=>append(j,err.decode(b,{stream:true})));
    child.stdin?.on('error',()=>{});child.stdin?.end(j.params.stdin||'');
    child.once('error',reject);
    child.once('close',(code,signal)=>{append(j,out.decode());append(j,err.decode());if(j.child===child) j.child=null;
      // Processes the run left in the background (nohup, &) end with it: nothing may outlive its job and its time limit.
      try {box.killTree(child);} catch {}
      resolve(code??(signal?128:1));});
  });
}
function compilerArgs(value) {
  if(Array.isArray(value)) return value.map(String);
  if(!value) return [];
  const result=[];let word='',quote=null,escape=false,has=false;
  for(const c of String(value)) {
    if(escape) {word+=c;escape=false;has=true;}
    else if(c==='\\' && quote!=="'") escape=true;
    else if(quote) {if(c===quote) quote=null;else word+=c;has=true;}
    else if(c==='"' || c==="'") {quote=c;has=true;}
    else if(/\s/.test(c)) {if(has) result.push(word);word='';has=false;}
    else {word+=c;has=true;}
  }
  if(quote || escape) throw new Error('compiler_args has an unfinished quote or escape.');
  if(has) result.push(word);return result;
}
function splitImports(code) {
  const tree=ts.createSourceFile('run.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let body=code;const imports=[];
  for(const node of [...tree.statements].reverse()) if(ts.isImportDeclaration(node)) {
    imports.unshift(code.slice(node.getStart(tree),node.end));
    body=body.slice(0,node.getStart(tree))+body.slice(node.getStart(tree),node.end).replace(/[^\n]/g,' ')+body.slice(node.end);
  }
  return {body,imports};
}
function typeErrors(code) {
  const {body,imports}=splitImports(code);
  const header='export {};\n'+imports.join('\n')+'\nasync function __main(): Promise<unknown> {\n';
  const name=path.join(pyDir,'__typecheck__.ts'),globals=path.join(pyDir,'__globals__.d.ts');
  const files=new Map([[name,header+body+'\n}\n'],[globals,legacy.TS_GLOBALS+'\ndeclare const console: {log(...v: any[]): void; error(...v: any[]): void};\ndeclare const process: any; declare const require: any; declare const Buffer: any;']]);
  const opts={strict:true,noEmit:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,skipLibCheck:true,types:[]};
  const host=ts.createCompilerHost(opts),original=host.getSourceFile;
  host.getSourceFile=(file,version,...args)=>files.has(file)?ts.createSourceFile(file,files.get(file),version,true):original.call(host,file,version,...args);
  const program=ts.createProgram([name,globals],opts,host);
  const offset=header.split('\n').length-1;
  return ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error && (!d.file || d.file.fileName===name)).map(d=>{
    const line=d.file && d.start!=null?Math.max(1,d.file.getLineAndCharacterOfPosition(d.start).line+1-offset):1;
    return 'line '+line+': TS'+d.code+': '+ts.flattenDiagnosticMessageText(d.messageText,'\n');
  });
}

// This function is serialized into each native Node module. Only code-visible
// configuration is embedded; server configuration and credentials never enter it.
async function nodePrelude(options) {
  const native=await import('node:fs');const io=native.promises;
  const path=await import('node:path');const {createRequire}=await import('node:module');
  globalThis.require=createRequire(path.join(process.cwd(),'package.json'));
  const resolve=p=>String(p).startsWith('/workspace/') ? path.join(process.cwd(),String(p).slice(11)) : p==='/workspace' ? process.cwd() : String(p);
  const bytes=async value=>{
    if(typeof value==='string' || Buffer.isBuffer(value)) return Buffer.from(value);
    if(value instanceof ArrayBuffer) return Buffer.from(value);
    if(ArrayBuffer.isView(value)) return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
    if(value instanceof Blob || value instanceof Response) return Buffer.from(await value.arrayBuffer());
    return Buffer.from(JSON.stringify(value,null,2));
  };
  const write=async(p,v,append=false)=>{p=resolve(p);const b=await bytes(v);await io.mkdir(path.dirname(p),{recursive:true});await (append?io.appendFile(p,b):io.writeFile(p,b));return append?(await io.stat(p)).size:b.length;};
  const list=async(directory='.')=>{
    const out=[];async function walk(d) {for(const e of await io.readdir(d,{withFileTypes:true})) {const p=path.join(d,e.name);if(e.isDirectory()) await walk(p);else if(e.isFile()) out.push({path:p.replace(/^\.\//,''),size:(await io.stat(p)).size});}}
    await walk(directory);return out;
  };
  globalThis.fs={
    readFile:async(p,e)=>{const b=await io.readFile(resolve(p));e=e && typeof e==='object'?e.encoding:e;return e===null || ['binary','buffer','bytes'].includes(e)?new Uint8Array(b):b.toString(e==='base64'?'base64':'utf8');},
    readJSON:async p=>JSON.parse(await io.readFile(resolve(p),'utf8')),
    writeFile:(p,v)=>write(p,v),appendFile:(p,v)=>write(p,v,true),
    readdir:(p='.')=>io.readdir(resolve(p)),exists:async p=>{try {await io.access(resolve(p));return true;}catch{return false;}},
    stat:async p=>{const s=await io.stat(resolve(p));return {size:s.size,isDir:s.isDirectory(),isFile:s.isFile(),mtime:s.mtime};},
    mkdir:async p=>{await io.mkdir(resolve(p),{recursive:true});return true;},
    rm:async(p,o)=>{await io.rm(resolve(p),o);return true;},unlink:async p=>{await io.unlink(resolve(p));return true;},
    rename:async(a,b)=>{await io.rename(resolve(a),resolve(b));return true;},copyFile:async(a,b)=>{await io.copyFile(resolve(a),resolve(b));return true;},list,
    download:async(url,name)=>{const r=await fetch(url);if(!r.ok) throw new Error('download failed: HTTP '+r.status);const p=name || decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download.bin';const size=await write(p,await r.arrayBuffer());return {path:p,size,contentType:r.headers.get('content-type')};}
  };
  globalThis.stdin=options.stdin;globalThis.sleep=ms=>new Promise(r=>setTimeout(r,ms));globalThis.env=process.env;
  const storagePath='.cr/storage.json';await io.mkdir('.cr',{recursive:true});
  let state={};try {state=JSON.parse(await io.readFile(storagePath,'utf8'));}catch{}
  const persist=()=>{native.writeFileSync(storagePath,JSON.stringify(state));};
  globalThis.storage={get:k=>state[k],set:(k,v)=>{state[k]=v;persist();return v;},delete:k=>{const had=Object.hasOwn(state,k);delete state[k];persist();return had;},keys:()=>Object.keys(state),has:k=>Object.hasOwn(state,k),clear:()=>{state={};persist();}};
  const tablePath=name=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('table names use letters, digits and _');return '.cr/tables/'+name+'.csv';};
  const tableList=()=>{try {return native.readdirSync('.cr/tables').filter(n=>n.endsWith('.csv')).map(n=>n.slice(0,-4)).sort();}catch{return [];}};
  const parseCsv=text=>{
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++) {const c=text[i];if(quoted) {if(c==='"') {if(text[i+1]==='"') {cell+='"';i++;}else quoted=false;}else cell+=c;}
      else if(c==='"' && !cell) quoted=true;
      else if(c===',') {row.push(cell);cell='';}
      else if(c==='\n'||c==='\r') {if(c==='\r' && text[i+1]==='\n') i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
    if(cell || row.length) {row.push(cell);rows.push(row);}const [head,...rest]=rows.filter(r=>r.length>1||r[0]!=='');
    return head?rest.map(row=>Object.fromEntries(head.map((k,i)=>{const v=row[i]??'';return [k,v!=='' && Number.isFinite(Number(v))?Number(v):v];}))):[];
  };
  globalThis.tables={list:tableList,get:name=>{const p=tablePath(name);if(!native.existsSync(p)) throw new Error('no shared table '+name+' (shared tables: '+(tableList().join(', ')||'none')+')');return parseCsv(native.readFileSync(p,'utf8'));},set:(name,rows)=>{
    const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];const cell=v=>{const s=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
    native.mkdirSync('.cr/tables',{recursive:true});native.writeFileSync(tablePath(name),[keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\n')+'\n');return name;
  }};
  globalThis.chart=async(rows,o={})=>{
    const data=Array.isArray(rows)?rows.slice(0,50000).map((r,i)=>r && typeof r==='object'?r:{x:i,y:r}):[];
    const opts={data,x:o.x||null,y:o.y||null,kind:o.kind||'line',title:o.title||'',color:o.color||null,bins:o.bins||null,spec:o.spec||null,height:o.height||null};
    const json=JSON.stringify(opts,(_,v)=>typeof v==='bigint'?Number(v):v).replace(/<\//g,'<\\/');
    await write(o.path||'chart.html',options.chart.replace('__OPTS__',()=>json));return o.path||'chart.html';
  };
}
async function nodeRun(j) {
  const {body,imports}=splitImports(j.params.code);
  if(j.language==='typescript' && j.params.typecheck) {
    const errors=typeErrors(j.params.code);
    if(errors.length) {append(j,'TypeScript errors:\n'+errors.join('\n')+'\n');return 1;}
  }
  const source=imports.join('\n')+'\nawait ('+nodePrelude.toString()+')('+JSON.stringify({stdin:j.params.stdin||'',chart:legacy.CHART_HTML})+');\n'+
    'try { const value = await (async () => {\n'+body+'\n})(); if (value !== undefined) console.log(value); } catch (e) { console.error(e?.stack || String(e)); process.exitCode = 1; }\n';
  // .mts is an ES module even outside a package.json and Node strips TS types.
  const script=await privateFile(j,j.language==='typescript'?'run.mts':'run.mjs',source);
  const resolver=await privateFile(j,'resolve.mjs',
    'import {registerHooks} from "node:module";\n'+
    'const entry='+JSON.stringify(pathToFileURL(script).href)+';\n'+
    'const workspace='+JSON.stringify(pathToFileURL(path.join(j.ws.dir,'__run__.mjs')).href)+';\n'+
    'registerHooks({resolve(specifier,context,nextResolve){ return nextResolve(specifier,context.parentURL===entry?{...context,parentURL:workspace}:context); }});\n');
  return processRun(j,[process.execPath,'--import',pathToFileURL(resolver).href,script]);
}
// A Python run that shares nothing with the live session: its own process, no
// kept variables, and it does not wait for (or disturb) a busy kernel. Used by
// schedules. Helpers, the echo of a last expression and figure saving work as in
// the session; top-level await does not.
const PYTHON_ONCE = String.raw`
import ast, builtins, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers
for _n in ('chart', 'share_table', 'get_table', 'list_tables', 'read_text'):
    setattr(builtins, _n, getattr(helpers, _n))
_src = open(sys.argv[1], encoding='utf-8').read()
_tree = ast.parse(_src, '<run>')
_last = ast.Expression(_tree.body.pop().value) if _tree.body and isinstance(_tree.body[-1], ast.Expr) else None
_g = {'__name__': '__main__', '__builtins__': builtins}
try:
    exec(compile(_tree, '<run>', 'exec'), _g)
    if _last is not None:
        _v = eval(compile(_last, '<run>', 'eval'), _g)
        if _v is not None:
            print(repr(_v))
finally:
    _plt = sys.modules.get('matplotlib.pyplot')
    if _plt is not None:
        _n = 1
        for _num in _plt.get_fignums():
            while os.path.exists('figure_%d.png' % _n):
                _n += 1
            _plt.figure(_num).savefig('figure_%d.png' % _n, bbox_inches='tight')
            print('(saved figure_%d.png)' % _n)
        _plt.close('all')
`;
async function pythonOnce(j) {
  await privateFile(j,'helpers.py',await fsp.readFile(path.join(pyDir,'helpers.py')));
  const chartFile=await privateFile(j,'chart.html',legacy.CHART_HTML);
  const driver=await privateFile(j,'once.py',PYTHON_ONCE);
  const code=await privateFile(j,'run.py',j.params.code);
  return processRun(j,[descriptors.python.executable,'-u',driver,code],{...pipEnv(j.ws),CR_CHART_HTML:chartFile});
}
async function localRun(j) {
  const d=descriptors[j.language];
  if(j.language==='python') return j.params.fresh ? pythonOnce(j) : pythonRun(j);
  if(j.language==='javascript'||j.language==='typescript') return nodeRun(j);
  if(j.language==='sql'||j.language==='duckdb') {
    const script=await privateFile(j,'sqlrun.py',await fsp.readFile(path.join(pyDir,'sqlrun.py')));
    const code=await privateFile(j,'run.sql',j.params.code);
    return processRun(j,[d.executable,script,j.language,code],pipEnv(j.ws));
  }
  let source=j.params.code;
  if(j.language==='r') {
    const chart=await privateFile(j,'chart.html',legacy.CHART_HTML);
    const helpers=legacy.R_HELPERS.replaceAll('"/tmp/cr_chart.html"',JSON.stringify(chart)).replaceAll('"/workspace/.cr/tables"','file.path(Sys.getenv("WORKSPACE"), ".cr/tables")');
    const plotPattern=path.join(j.runDir,'rplot_%d.png');
    source='dir.create(".cr",showWarnings=FALSE)\nif(file.exists(".cr/session.RData")) load(".cr/session.RData")\n'+
      'if(exists(".cr_libraries")) for(p in .cr_libraries) suppressPackageStartupMessages(require(p,character.only=TRUE,quietly=TRUE))\n'+helpers+'\n'+
      'readline <- local({ lines <- strsplit('+JSON.stringify(j.params.stdin||'')+', "\\n")[[1]]; i <- 0L; function(prompt="") {cat(prompt);i <<- i+1L;if(i>length(lines)) return(""); lines[[i]]} })\n'+
      'local({\n png('+JSON.stringify(plotPattern)+')\n'+
      'on.exit({\n dev.off(); .cr_libraries <<- sub("^package:", "", grep("^package:",search(),value=TRUE)); save.image(".cr/session.RData")\n'+
      'for(p in list.files('+JSON.stringify(j.runDir)+',pattern="^rplot_[0-9]+[.]png$",full.names=TRUE)) { n <- 1; while(file.exists(sprintf("rplot_%d.png",n))) n <- n+1; dest <- sprintf("rplot_%d.png",n); file.copy(p,dest);cat("R plot saved: ",dest,"\\n",sep="") }\n'+
      '},add=TRUE)\n'+
      'value <- withVisible(eval(parse(text='+JSON.stringify(j.params.code)+'),envir=.GlobalEnv)); if(value$visible) print(value$value)\n})\n';
  }
  const script=await privateFile(j,'Run.'+d.extension,source);
  if(!d.compile) return processRun(j,[d.executable,script]);
  const args=compilerArgs(j.params.compiler_args),exe=path.join(j.runDir,'program');
  let command;
  if(j.language==='go') command=[d.executable,'build',...args,'-o',exe,script];
  else {
    const defaults=d.compile.filter(a=>!a.startsWith('-std=') || !args.some(x=>x.startsWith('-std=')));
    command=[d.executable,...defaults,...args,script,'-o',exe];
  }
  const result=await processRun(j,command);
  if(result!==0 || j.cancelReason) return result;
  return processRun(j,[exe]);
}
async function execute(j) {
  try {
    await box.initSandbox();
    if(j.cancelReason) {j.preparing=false;await finish(j,137);return;}
    if(await box.wsfs.usage(j.ws)>config.quotaMb*1024*1024) throw new Error('Workspace quota exceeded ('+config.quotaMb+' MB). Use manage_files to delete files or clear the workspace before running again.');
    if(j.params.reset) await resetKernel(j.ws);
    j.before=await box.wsfs.list(j.ws);
    for(const file of j.params.files||[]) {
      const rel=box.wsfs.safeRel(file.path);
      if(!rel) throw new Error('Invalid file path '+file.path+'. Use a path inside /workspace.');
      await box.wsfs.write(j.ws,rel,Buffer.from(String(file.content??''),file.encoding==='base64'?'base64':'utf8'));
    }
    j.runDir=await fsp.mkdtemp(path.join(j.ws.tmp,'run-'));
    if(process.getuid?.()===0) await fsp.lchown(j.runDir,j.ws.uid,j.ws.gid);
    const logDir=path.join(j.ws.tmp,'jobs');await fsp.mkdir(logDir,{recursive:true});
    inDirectory(logDir,base=>{
      j.logFd=fs.openSync(base+'/'+j.id+'.log',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      j.metaFd=fs.openSync(base+'/'+j.id+'.json',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    });
    persistJob(j);
    j.preparing=false;
    if(j.cancelReason) {await finish(j,137);return;}
    let exitCode;
    const remote=j.params.compiler_version && (descriptors[j.language]?.compile || legacy.CE_LANGS[j.language] || j.language==='java') || !installed[j.language] && legacy.ALL_LANGS.includes(j.language) && (legacy.CE_LANGS[j.language] || legacy.WB_LANGS[j.language] || ['r','ruby'].includes(j.language));
    if(remote) {
      const text=await legacy.runRemote(j.language,j.params.code,j.params.stdin||'',{version:j.params.compiler_version,args:Array.isArray(j.params.compiler_args)?j.params.compiler_args.join(' '):j.params.compiler_args});
      append(j,text+'\n(ran remotely on '+(legacy.WB_LANGS[j.language]?'Wandbox':'Compiler Explorer')+': no files, no network)\n');
      exitCode=/^Could not |compilation failed|execution failed/i.test(text)?1:0;
    } else if(!installed[j.language] && !(j.language==='duckdb' && installed.python)) throw new Error(j.language+' is not installed on this server. Use one of: '+Object.keys(installed).join(', ')+'.');
    else exitCode=await localRun(j);
    await finish(j,exitCode);
  } catch(e) {append(j,String(e.message||e)+'\n');await finish(j,j.cancelReason==='timeout'?124:1);}
}
export async function runCode(ws,params,hooks={}) {
  const language=languageOf(params.language);
  if(!language) return {text:redact('Unsupported language "'+params.language+'". Supported: '+allLanguages().join(', ')+'.',{...config.codeSecrets,...params.secrets}),running:false,exitCode:1};
  if(typeof params.code!=='string') return {text:'code must be a string.',running:false,exitCode:1};
  if(stopping) return {text:'The server is shutting down. Retry after it restarts.',running:false,exitCode:1};
  const map=workspaceJobs(ws);
  // Only the live session is exclusive; a fresh (scheduled) Python run is its own process.
  const busy=[...map.values()].find(j=>!j.finished && j.language==='python' && !j.params?.fresh);
  if(language==='python' && busy && !params.fresh) return {text:'python is busy with job '+busy.id+'. Use the job tool to follow or kill it.',running:false,exitCode:1};
  if([...map.values()].filter(j=>!j.finished).length>=config.maxJobs) return {text:'Too many running jobs (limit '+config.maxJobs+'). Use the job tool to wait or kill a job.',running:false,exitCode:1};
  const seconds=Number(params.timeout ?? config.runTimeoutS);
  const timeout=Math.min(config.maxTimeoutS,Math.max(0.1,Number.isFinite(seconds)?seconds:config.runTimeoutS));
  const secrets={...config.codeSecrets,...params.secrets};
  const bank=secretBanks.get(ws.id)||new Map();for(const [form,name] of secretPairs(secrets)) bank.set(form,name);secretBanks.set(ws.id,bank);
  const pairs=[...bank].sort((a,b)=>b[0].length-a[0].length);
  const j={id:'j'+crypto.randomBytes(5).toString('hex'),ws,params,language,timeout,secrets,pairs,hooks,state:'running',started:Date.now(),ended:null,exitCode:null,
    label:replaceSecrets(params.code,pairs).slice(0,60),head:'',tail:'',total:0,notify:'',lastNotify:0,logBytes:0,redactor:new StreamRedactor(pairs),finished:false,preparing:true,recordHistory:params.record!==false};
  j.done=new Promise(resolve=>{j.resolve=resolve;});map.set(j.id,j);
  j.timeoutTimer=setTimeout(()=>abortJob(j,'timeout'),timeout*1000);
  void execute(j);
  if(!params.background) {
    await waitFor(j.done,Math.min(timeout,config.waitBudgetS)*1000);
    if(j.cancelReason) await waitFor(j.done,3500);
  }
  const text=snapshot(j).text;
  return {text:j.finished?text:text+'\n\nStill running as job '+j.id+' ... use the job tool (action output, wait up to 45 s per call) to follow it.',
    jobId:j.id,running:!j.finished,exitCode:j.exitCode};
}
