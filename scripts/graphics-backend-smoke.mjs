import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { applicationSurfaces, NativeFrames, ROOT, runFile } from '../src/platform.mjs';
const executable = path.join(ROOT, '.local-evidence', 'BridgeGraphicsFixture.exe');
await runFile(process.env.BRIDGE_GCC_PATH || 'gcc.exe', ['-municode', '-mwindows', '-O2', '-o', executable,
  path.join(ROOT, 'scripts', 'experiments', 'GraphicsFixture.c'), '-ld3d11', '-ldxgi', '-ldxguid'], { windowsHide: true, timeout: 30000 });
const child = spawn(executable, process.argv.slice(2).filter(arg => ['--blt','--float'].includes(arg)), { windowsHide: true, stdio: 'ignore' }), helper = new NativeFrames();
try {
  let surfaces = [];
  for (let n = 0; n < 30 && !surfaces.length; n++) { await new Promise(r => setTimeout(r, 100)); surfaces = await applicationSurfaces(executable, process.pid, { fixture: true }); }
  assert.equal(surfaces.length, 1);
  const hashes = [];
  for (let n = 0; n < 4; n++) {
    const frame = await helper.capture({ ...surfaces[0], type: 'scene' }, { maxWidth: 640, jpegQuality: 70, fps: 15 });
    hashes.push(createHash('sha256').update(frame.jpeg).digest('hex')); await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(new Set(hashes).size > 1);
  // A fast producer must retain one unread snapshot instead of overwriting the
  // shared image during a slow consumer's copy. Sequence belongs to the copied
  // pixels, even if a newer frame is published while JPEG encoding completes.
  const previous = await helper.capture({ ...surfaces[0], type: 'scene' }, { maxWidth: 640, jpegQuality: 70, fps: 120 });
  await new Promise(r => setTimeout(r, 500));
  const next = await helper.capture({ ...surfaces[0], type: 'scene' }, { maxWidth: 640, jpegQuality: 70, fps: 120 });
  assert.equal(next.sequence - previous.sequence, 2, 'Only one unread frame may be published while the consumer waits.');
  const unloaded = async () => {
    for (let n = 0; n < 12; n++) {
      await new Promise(r => setTimeout(r, 250));
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `@((Get-Process -Id ${child.pid}).Modules | Where-Object { $_.ModuleName -eq 'BridgeGraphicsHook.dll' }).Count`], { windowsHide: true, timeout: 5000 });
      if (stdout.trim() === '0') return true;
    }
    return false;
  };
  helper.stop(); assert.equal(await unloaded(), true, 'Normal stop must unload hooks while the source stays alive.');
  await helper.capture({ ...surfaces[0], type: 'scene' }, { maxWidth: 640, jpegQuality: 70, fps: 15 });
  helper.child.kill(); assert.equal(await unloaded(), true, 'Owner failure must unload hooks while the source stays alive.');
  assert.equal(child.exitCode, null);
  console.log(JSON.stringify({ backend: 'D3D11-shared-memory', swap: process.argv.includes('--blt') ? 'blt' : 'flip',
    texture: process.argv.includes('--float') ? 'RGBA16-float-linear-to-SDR' : 'BGRA8',
    source: 'controlled synthetic executable', changingFrames: true, cleanStopAndOwnerDeathUnload: true,
    wallpaperResourcesSaved: false, actualWallpaperEngineAccepted: false }));
} finally { helper.stop(); await new Promise(r => setTimeout(r, 300)); child.kill(); }
