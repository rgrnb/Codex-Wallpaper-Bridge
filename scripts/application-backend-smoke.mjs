import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, nativeProbe, applicationSurfaces, NativeFrames } from '../src/platform.mjs';
const run = promisify(execFile), delay = ms => new Promise(r => setTimeout(r, ms));
const app = (await nativeProbe()).wallpaperEngine, name = `CodexBridgeProbe-${randomUUID()}`;
const root = path.join(ROOT, '.local-evidence', name), executable = path.join(root, 'BridgeApplicationFixture.exe');
await mkdir(root);
await run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`,
  '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', path.join(ROOT, 'scripts', 'experiments', 'ApplicationFixture.cs')], { windowsHide: true });
await writeFile(path.join(root, 'project.json'), JSON.stringify({ title: name, type: 'application', file: 'BridgeApplicationFixture.exe' }));
const config = path.join(path.dirname(app.path), 'config.json');
const selected = c => Object.fromEntries(Object.entries(c).filter(([, v]) => v?.general?.wallpaperconfig).map(([k, v]) => [k, v.general.wallpaperconfig.selectedwallpapers]));
const before = selected(JSON.parse(await readFile(config, 'utf8'))), helper = new NativeFrames();
const unrelated = spawn(executable, ['--offscreen'], { windowsHide: true, stdio: 'ignore' });
try {
  await run(app.path, ['-control', 'openWallpaper', '-file', path.join(root, 'project.json'), '-playInWindow', name, '-width', '640', '-height', '360'], { windowsHide: true });
  let surfaces = [];
  for (let n = 0; n < 30 && !surfaces.length; n++) { await delay(100); surfaces = await applicationSurfaces(executable, app.pid); }
  assert.equal(surfaces.length, 1, 'Exact selected executable must have one eligible window.');
  assert.notEqual(surfaces[0].pid, unrelated.pid, 'The same EXE outside WE ownership must be excluded.');
  const outside = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `([Diagnostics.Process]::GetProcessById(${unrelated.pid})).MainWindowHandle.ToInt64()`], { windowsHide: true, timeout: 5000 });
  assert.ok(Number(outside.stdout.trim()) > 0);
  await assert.rejects(helper.capture({ hwnd: outside.stdout.trim(), pid: unrelated.pid, type: 'application', sourceFile: executable, wePid: app.pid },
    { maxWidth: 640, jpegQuality: 70 }), /FRAME_OWNER_INVALID/);
  const hashes = [];
  for (let n = 0; n < 4; n++) {
    const frame = await helper.capture(surfaces[0], { maxWidth: 640, jpegQuality: 70 });
    hashes.push(createHash('sha256').update(frame.jpeg).digest('hex')); await delay(200);
  }
  assert.ok(new Set(hashes).size > 1, 'Application must produce changing frames.');
  console.log(JSON.stringify({ type: 'application', sample: 'authored WinForms wallpaper opened by WE', frames: 4,
    changingFrames: true, unrelatedSameExecutableExcluded: true, copiesSaved: 0, actualCodexAccepted: false }));
} finally {
  try {
    helper.stop(); await run(app.path, ['-control', 'closeWallpaper', '-location', name], { windowsHide: true });
    await delay(500);
    const remaining = await applicationSurfaces(executable, app.pid);
    assert.equal(remaining.length, 0, 'WE must close its owned fixture application.');
    assert.deepEqual(selected(JSON.parse(await readFile(config, 'utf8'))), before);
  } finally { if (unrelated.exitCode === null) unrelated.kill(); }
}
