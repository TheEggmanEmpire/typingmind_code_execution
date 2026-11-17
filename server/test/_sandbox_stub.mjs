import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
export async function initSandbox() {}
export function spawnInWorkspace(ws, argv, opts = {}) {
  return spawn(argv[0], argv.slice(1), { cwd: opts.cwd || ws.dir, detached: true,
    env: { PATH: process.env.PATH, HOME: ws.dir, TMPDIR: ws.tmp, LANG: 'C.UTF-8', WORKSPACE: ws.dir, ...opts.env },
    stdio: opts.stdio || [opts.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}
export function killTree(child, signal = 'SIGKILL') { try { process.kill(-child.pid, signal); } catch {} }
const rel = p => String(p).replace(/^\/workspace\/?/, '').replace(/^\.\//, '');
export const wsfs = {
  safeRel(p) { p = rel(p); return p && !path.isAbsolute(p) && !p.split('/').includes('..') ? p : null; },
  async write(ws,p,b) { const f=path.join(ws.dir,rel(p)); await fs.mkdir(path.dirname(f),{recursive:true}); await fs.writeFile(f,b); },
  async read(ws,p) { return fs.readFile(path.join(ws.dir,rel(p))); },
  async remove(ws,p) { await fs.rm(path.join(ws.dir,rel(p)),{recursive:true,force:true}); },
  async list(ws) { const out=[]; async function walk(d) { for(const e of await fs.readdir(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) await walk(p); else if(e.isFile()) { const s=await fs.stat(p); out.push({path:path.relative(ws.dir,p),size:s.size,mtime:s.mtimeMs}); } } } await walk(ws.dir); return out.sort((a,b)=>a.path.localeCompare(b.path)); },
  async usage(ws) { return (await this.list(ws)).reduce((n,x)=>n+x.size,0); }
};
