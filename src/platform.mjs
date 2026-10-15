import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { access } from 'node:fs/promises';
export const runFile = promisify(execFile);
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOST = process.env.BRIDGE_NATIVE_HOST || path.join(ROOT, 'build', 'CodexWallpaperBridge.exe');
export async function nativeProbe() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  await access(HOST);
  const { stdout } = await runFile(HOST, ['--probe'], { windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
export async function startupRegistration(enabled) {
  await runFile(HOST, ['--startup', enabled ? 'enable' : 'disable'], { windowsHide: true, timeout: 10000 });
}
export async function queryCurrent(executable, monitor) {
  const { stdout } = await runFile(HOST, ['--we-current', executable, String(monitor)], { windowsHide: true, timeout: 9000, maxBuffer: 32768 });
  return JSON.parse(stdout).file;
}
export async function applicationSurfaces(executable, ownerPid, { fixture = false } = {}) {
  if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new Error('APPLICATION_OWNER_REQUIRED');
  const { stdout } = await runFile(HOST, [fixture ? '--fixture-surfaces' : '--application-surfaces', executable, String(ownerPid)], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
export class NativeFrames {
  constructor() { this.child = null; this.pending = null; this.buffer = ''; }
  start() {
    if (this.child) return;
    const child = this.child = spawn(HOST, ['--frames'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.stop(); return; }
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const row = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      const pending = this.pending; this.pending = null;
      if (!pending) return;
      clearTimeout(pending.timer);
      try { const result = JSON.parse(row); result.error ? pending.reject(new Error(result.error)) : pending.resolve(result); }
      catch { pending.reject(new Error('FRAME_PROTOCOL_ERROR')); }
    });
    child.on('error', () => { if (this.child === child) this.stop(); });
    child.on('exit', () => { if (this.child === child) this.stop(); });
  }
  capture(surface, policy) {
    if (this.pending) return Promise.reject(new Error('FRAME_BACKPRESSURE'));
    this.start();
    return new Promise((resolve, reject) => {
      const graphics = surface.type === 'scene';
      const timer = setTimeout(() => this.stop(), graphics ? 12000 : 3000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ hwnd: surface.hwnd, pid: surface.pid,
        ...(surface.sourceFile ? { sourceFile: surface.sourceFile } : {}),
        ...(surface.wePid ? { wePid: surface.wePid } : {}), ...(surface.fixtureOwnerPid ? { fixtureOwnerPid: surface.fixtureOwnerPid } : {}),
        graphics, fps: policy.fps || 15, maxWidth: policy.maxWidth, quality: policy.jpegQuality }) + '\n', error => { if (error) this.stop(); });
    });
  }
  stop() {
    const p = this.pending; this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(new Error('FRAME_HELPER_STOPPED')); }
    const child = this.child; this.child = null; this.buffer = '';
    if (child) {
      child.removeAllListeners('exit'); child.stdin.on('error', () => {}); child.stdin.end();
      // Native graphics teardown allows five seconds for its detours to drain.
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 6500); timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}
