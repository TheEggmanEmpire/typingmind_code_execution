import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(server, 'sandbox/crbox');
const pyDir = path.join(server, 'py');
const helper = path.join(pyDir, 'wsfs.py');
const systemPaths = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc', '/opt'];
const nodePrefix = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };
const uniqueExisting = paths => [...new Set(paths)].filter(exists);
let initialized = false, initializing;
let state = offReport('Sandbox has not been initialized.');
let bwrapPath = null, netNamespace = false;
const groups = new WeakMap();

function offReport(note) {
  return { mode: 'off', layers: { uid: false, rlimits: false, noNewPrivs: false, landlock: 0, seccomp: false, namespaces: false }, networkOff: false, notes: [note] };
}
function environment(ws, extra = {}) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ws.dir, TMPDIR: ws.tmp, LANG: 'C.UTF-8', WORKSPACE: ws.dir, USER: 'runner', ...extra };
}
function beneath(base, file) {
  const rel = path.relative(base, file);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel));
}
function workingDir(ws, input) {
  const base = fs.realpathSync(ws.dir);
  const p = input?.startsWith('/workspace/') ? path.resolve(base, input.slice(11)) : input === '/workspace' ? base : path.resolve(base, input || '.');
  if (!beneath(base, p) || !beneath(base, fs.realpathSync(p))) throw Object.assign(new Error('Working directory must be inside the workspace.'), { code: 'EACCES' });
  return p;
}
function number(value, fallback, name, min = 1) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name} limit.`);
  return String(n);
}

// All argv construction lives here: outer crbox does limits/session/UID before
// bwrap; the inner crbox applies Landlock then seccomp AFTER namespace creation.
// With no working bwrap, the same operations live in a single crbox invocation.
function command(ws, argv, opts, report, useNetNamespace = netNamespace) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('Expected a program and string arguments.');
  const cwd = workingDir(ws, opts.cwd);
  if (report.mode === 'off') return { argv, cwd, detached: true };
  // opts.readOnly: extra absolute paths the program may read (e.g. a tool installed outside /usr).
  const extraRo = uniqueExisting((opts.readOnly || []).filter(p => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0')).map(p => path.resolve(p)));
  const limits = opts.limits || {};
  const outer = [launcher, '--rlimit-fsize', number(limits.fileMb, config.maxFileMb, 'file size'), '--rlimit-nofile', number(limits.files, 1024, 'open files'), '--rlimit-core', '0', '--setsid'];
  // RLIMIT_NPROC counts every process of the unix user. It is a per-workspace
  // limit only when the workspace has a user of its own (root mode); for a
  // shared user it would count the server and everything else and block forks.
  if (report.mode === 'root') outer.push('--rlimit-nproc', number(limits.procs, config.maxProcs, 'process'));
  if (limits.cpuS !== undefined) outer.push('--rlimit-cpu', number(limits.cpuS, 0, 'CPU'));
  if (report.mode === 'root') outer.push('--gid', number(ws.gid, 0, 'gid', 0), '--uid', number(ws.uid, 0, 'uid'));
  const networkOff = (opts.network || config.network) === 'off';
  const inner = ['--chdir', cwd];
  if (report.layers.landlock) {
    inner.push('--landlock');
    let ro = [...systemPaths, '/sys/devices/system/cpu', '/dev', pyDir, nodePrefix, ...extraRo];
    if (report.layers.namespaces) ro.push('/proc');
    else {
      // A broad /proc rule would let a same-UID sandbox read the server environ.
      // /proc/self resolves in crbox, immediately before exec. Forked children
      // consequently lose their own proc entries; report this compatibility cost.
      ro.push('/proc/self', '/proc/cpuinfo', '/proc/meminfo', '/proc/stat', '/proc/uptime', '/proc/loadavg', '/proc/version', '/proc/filesystems', '/proc/sys/kernel/random');
    }
    for (const p of uniqueExisting(ro)) inner.push('--ro', p);
    for (const p of uniqueExisting([ws.dir, ws.tmp, '/dev/null', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/tty', '/dev/shm'])) inner.push('--rw', p);
    if (report.layers.namespaces) inner.push('--rw', '/workspace');
  }
  if (report.layers.seccomp) inner.push('--seccomp');
  if (networkOff && report.layers.seccomp) inner.push('--no-net');
  if (report.layers.namespaces) {
    const b = [bwrapPath, '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--cap-drop', 'ALL'];
    if (networkOff && useNetNamespace) b.push('--unshare-net');
    for (const p of uniqueExisting([...systemPaths, pyDir, nodePrefix, launcher, ...extraRo])) b.push('--ro-bind', p, p);
    b.push('--proc', '/proc', '--dev', '/dev');
    if (exists('/sys/devices/system/cpu')) b.push('--ro-bind', '/sys/devices/system/cpu', '/sys/devices/system/cpu');
    b.push('--bind', ws.dir, ws.dir, '--bind', ws.tmp, ws.tmp, '--bind', ws.dir, '/workspace', '--chdir', cwd, '--remount-ro', '/', '--', launcher, ...inner, '--', ...argv);
    return { argv: [...outer, '--', ...b], cwd: server, detached: false };
  }
  return { argv: [...outer, ...inner, '--', ...argv], cwd: server, detached: false };
}
function probeRun(cmd, ws) {
  return spawnSync(cmd.argv[0], cmd.argv.slice(1), { cwd: cmd.cwd, env: environment(ws), stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 64 * 1024 });
}
function success(r) { return !r.error && r.status === 0; }

export function sandboxReport() { return structuredClone(state); }
export async function initSandbox() {
  if (initializing) return initializing;
  initializing = Promise.resolve().then(() => {
    let probeDir;
    try {
      if (config.sandbox === 'off') {
        state = offReport('WARNING: SANDBOX=off. Code runs directly as the server user; secrets, other workspaces and host resources are not isolated.');
        return sandboxReport();
      }
      if (!exists(launcher)) {
        const compiled = spawnSync('sh', [path.join(server, 'sandbox/build.sh')], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
        if (!success(compiled)) throw new Error('crbox is missing and compilation failed (install gcc or build it in the image).');
      }
      const p = spawnSync(launcher, ['--probe'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
      if (!success(p)) throw new Error('crbox capability probe failed.');
      const caps = JSON.parse(p.stdout);
      if (!caps.nnp) throw new Error('crbox cannot enable no_new_privs.');
      const root = typeof process.getuid === 'function' && process.getuid() === 0;
      if (root && !caps.setuid) throw new Error('Root cannot irreversibly drop to a workspace UID.');
      state = { mode: root ? 'root' : 'user', layers: { uid: root, rlimits: true, noNewPrivs: true, landlock: Number(caps.landlock) || 0, seccomp: caps.seccomp === true, namespaces: false }, networkOff: caps.seccomp === true, notes: [] };
      const found = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, timeout: 1000 });
      if (success(found)) bwrapPath = found.stdout.trim();
      probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crbox-probe-'));
      fs.chmodSync(probeDir, 0o711);
      const ws = { dir: path.join(probeDir, 'workspace'), tmp: path.join(probeDir, 'tmp'), uid: root ? config.uidBase : process.getuid(), gid: root ? config.uidBase : process.getgid() };
      for (const d of [ws.dir, ws.tmp]) { fs.mkdirSync(d, { mode: 0o700 }); if (root) fs.chownSync(d, ws.uid, ws.gid); }
      const opts = { network: 'open' };
      if (bwrapPath) {
        const withNs = { ...state, layers: { ...state.layers, namespaces: true } };
        if (success(probeRun(command(ws, ['/bin/true'], opts, withNs, false), ws))) {
          state = withNs;
          netNamespace = success(probeRun(command(ws, ['/bin/true'], { network: 'off' }, withNs, true), ws));
        } else state.notes.push('Bubblewrap is installed but the complete UID/namespace/Landlock/seccomp chain failed; namespaces are unavailable.');
      } else state.notes.push('Bubblewrap is not installed; namespaces are unavailable.');
      if (!success(probeRun(command(ws, ['/bin/true'], opts, state), ws))) throw new Error('crbox cannot execute the complete selected sandbox chain.');
      state.networkOff = state.layers.seccomp || netNamespace;
      state.notes.push('Shared-kernel defence in depth, not a VM. Memory and aggregate disk use are not bounded by per-job cgroups; file/CPU/process limits are not full resource isolation.');
      if (!root) state.notes.push(state.layers.namespaces ? 'Non-root user mode: no separate workspace UIDs. PID/mount namespaces confine process visibility and files, but this is not a separate host identity; host Unix services may remain reachable.' : 'Non-root user mode: no separate workspace UIDs. Same-UID signalling and non-filesystem IPC can reach sibling jobs and the server.');
      if (!state.layers.namespaces && state.layers.landlock) state.notes.push('Without PID namespaces, /proc is limited to selected system files and the original process; forked children cannot access their own /proc/self.');
      if (!state.layers.landlock && !state.layers.namespaces) state.notes.push('WARNING: No filesystem sandbox. Code can read server files and other workspaces wherever Unix permissions permit.');
      if (!state.layers.seccomp) state.notes.push('WARNING: seccomp unavailable; dangerous syscalls and process-group escape are not filtered.');
      if (!netNamespace) state.notes.push(state.layers.seccomp ? 'Network off denies non-Unix socket creation with seccomp; existing Unix services/proxies and received socket FDs remain possible without a network namespace.' : 'WARNING: Network off cannot be enforced on this host.');
      if (!state.layers.namespaces) state.notes.push('/dev/shm is shared and Unix sockets may reach host services; Landlock is not complete IPC isolation.');
      return sandboxReport();
    } catch (e) {
      // Fail closed: without a working sandbox nothing runs. SANDBOX=off is the
      // only way to run code unprotected, and it has to be chosen by the operator.
      state = { ...offReport(`Sandbox unavailable: ${e.message} Code execution is refused. Fix the cause, or set SANDBOX=off to run code without isolation.`), refuse: true };
      return sandboxReport();
    } finally {
      initialized = true;
      if (probeDir) { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {} }
    }
  });
  return initializing;
}

export function spawnInWorkspace(ws, argv, opts = {}) {
  if (!initialized) throw new Error('Call initSandbox() before running code.');
  if (state.refuse) throw new Error(state.notes[0]);
  const cmd = command(ws, argv, opts, state);
  const child = spawn(cmd.argv[0], cmd.argv.slice(1), { cwd: cmd.cwd, env: environment(ws, opts.env), detached: cmd.detached, stdio: [opts.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  groups.set(child, { pgid: child.pid, root: state.mode === 'root' });
  return child;
}
export function killTree(child, signal = 'SIGKILL') {
  const record = groups.get(child);
  const pgid = record?.pgid || child?.pid;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return;
  if (record?.root) {
    // Match the job PGID, never the workspace UID: its Python kernel persists.
    // Signal children before the group leader so a namespace keeper can reap.
    let ids = [];
    try { ids = fs.readdirSync('/proc'); } catch {}
    for (const entry of ids) {
      if (!/^\d+$/.test(entry) || Number(entry) === pgid) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pgid) process.kill(Number(entry), signal);
      } catch {}
    }
  }
  try { process.kill(-pgid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  // Covers a kill requested before crbox has had time to establish its session.
  if (child.exitCode === null && child.signalCode === null) { try { child.kill(signal); } catch {} }
}

function safeRel(input) {
  if (typeof input !== 'string' || input.includes('\0') || !input) return null;
  let p = input;
  if (p.startsWith('/workspace/')) p = p.slice(11).replace(/^\/+/, '');
  else if (path.posix.isAbsolute(p)) return null;
  if (p.split('/').some(part => part === '..')) return null;
  p = path.posix.normalize(p);
  return p === '.' || p === '' || p === '/' ? null : p.replace(/\/$/, '');
}
function accessError(message = 'Path must stay inside the workspace.') { return Object.assign(new Error(message), { code: 'EACCES' }); }
async function request(ws, payload, bytes) {
  await initSandbox();
  const child = spawnInWorkspace(ws, ['python3', '-I', '-B', helper], { network: 'off', limits: { cpuS: 10, procs: config.maxProcs, files: 128, fileMb: config.maxFileMb } });
  const maxReply = (payload.op === 'read' ? payload.maxBytes : 32 * 1024 * 1024) + 65536;
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0, stderr = '', settled = false;
    const fail = e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
    const timer = setTimeout(() => { killTree(child); fail(Object.assign(new Error('Workspace file operation timed out.'), { code: 'ETIMEDOUT' })); }, 30000);
    timer.unref();
    child.on('error', fail);
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') fail(e); });
    child.stderr.on('data', b => { if (stderr.length < 8192) stderr += b.toString(); });
    child.stdout.on('data', b => {
      total += b.length;
      if (total > maxReply) { killTree(child); fail(Object.assign(new Error('Workspace reply exceeded the size limit.'), { code: 'ETOOBIG' })); }
      else chunks.push(b);
    });
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timer);
      try {
        const all = Buffer.concat(chunks), newline = all.indexOf(10);
        if (newline < 0) throw new Error(stderr.trim() || `Workspace helper exited (${code}).`);
        const reply = JSON.parse(all.subarray(0, newline).toString());
        if (!reply.ok) throw Object.assign(new Error(reply.error || 'Workspace file operation failed.'), { code: reply.code || 'EACCES' });
        if (code !== 0) throw new Error(stderr.trim() || `Workspace helper exited (${code}).`);
        settled = true;
        if (payload.op === 'read') { const data = all.subarray(newline + 1); if (data.length !== reply.size) throw new Error('Incomplete workspace read.'); resolve(data); }
        else resolve(reply.result);
      } catch(e) { settled = true; reject(e); }
    });
    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end(bytes);
  });
}
const checked = p => { const rel = safeRel(p); if (!rel) throw accessError(); return rel; };
export const wsfs = {
  safeRel,
  async read(ws, rel, { maxBytes = config.serveMaxBytes } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Object.assign(new Error('Invalid read size limit.'), { code: 'ETOOBIG' });
    return request(ws, { op: 'read', path: checked(rel), maxBytes });
  },
  async write(ws, rel, buffer) { const data = Buffer.from(buffer); return request(ws, { op: 'write', path: checked(rel), size: data.length }, data); },
  async list(ws) { return request(ws, { op: 'list' }); },
  async stat(ws, rel) { return request(ws, { op: 'stat', path: checked(rel) }); },
  async remove(ws, rel) { return request(ws, { op: 'remove', path: checked(rel) }); },
  async rename(ws, from, to) { return request(ws, { op: 'rename', path: checked(from), to: checked(to) }); },
  async clear(ws) { return request(ws, { op: 'clear' }); },
  async usage(ws) { return request(ws, { op: 'usage' }); }
};
