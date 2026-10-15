import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeProbe, ROOT, NativeFrames } from '../../src/platform.mjs';

// Deliberately a diagnostic only: never enables the bridge or changes a monitor.
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const app = (await nativeProbe()).wallpaperEngine;
assert.ok(app?.running, 'Wallpaper Engine must already be running.');
assert.ok(process.argv.slice(2).every(value => ['--scene-stock', '--offscreen', '--graphics'].includes(value)), 'Only the authored Web fixture or stock Scene probe is allowed.');
const type = process.argv.includes('--scene-stock') ? 'scene' : 'web';
const offscreen = process.argv.includes('--offscreen');
const mode = offscreen ? 'offscreen' : 'cli-position';
const name = `CodexBridgeProbe-${randomUUID()}`;
const config = path.join(path.dirname(app.path), 'config.json');
const before = JSON.parse(await readFile(config, 'utf8'));
const selection = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v?.general?.wallpaperconfig)
  .map(([key, value]) => [key, value.general.wallpaperconfig.selectedwallpapers]));
const command = args => run(app.path, args, { cwd: path.dirname(app.path), windowsHide: true, timeout: 5000 });
const probe = args => run(path.join(ROOT, '.local-evidence', 'CaptureProbe.exe'), args,
  { windowsHide: true, timeout: 12000, maxBuffer: 65536 });
const result = { time: new Date().toISOString(), weVersion: app.version, type, fixture: type === 'web' ? 'synthetic-silent' : 'stock-shimmering-particles',
  actualCodexAccepted: false, pixelsSavedToDisk: false, cases: [] };
try {
  const project = type === 'web' ? fileURLToPath(new URL('./fixtures/web/project.json', import.meta.url))
    : path.join(path.dirname(app.path), 'projects', 'defaultprojects', 'shimmering_particles', 'project.json');
  await command(['-control', 'openWallpaper', '-file', project, '-playInWindow', name,
    '-width', '320', '-height', '180', '-x', '-10000', '-y', '-10000', '-borderless']);
  await delay(1800);
  if (offscreen) {
    const moved = JSON.parse((await probe(['--move-offscreen', String(app.pid), name])).stdout);
    assert.ok(moved.bounds.right < 0 && moved.bounds.bottom < 0, 'Probe must actually be moved offscreen.');
    await delay(400);
  }
  result.windows = (await probe(['--inspect', String(app.pid)])).stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (process.argv.includes('--graphics')) {
    const candidates = (await nativeProbe()).wallpaperEngine.surfaces.filter(s => s.type === 'scene');
    assert.equal(candidates.length, 1); const helper = new NativeFrames();
    try {
      const frames = [];
      for (let n = 0; n < 4; n++) {
        const frame = await helper.capture(candidates[0], { maxWidth: 640, jpegQuality: 70, fps: 15 });
        frames.push({ sha256: (await import('node:crypto')).createHash('sha256').update(frame.jpeg).digest('hex') });
        await delay(180);
      }
      result.cases.push({ mode: 'graphics-popout', frames, dynamic: new Set(frames.map(f => f.sha256)).size > 1 });
    } finally { helper.stop(); await delay(500); }
  } else {
  try {
    const capture = await probe(['--capture', String(app.pid), name]);
    const frames = capture.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    result.cases.push({ mode, frames, dynamic: frames.length === 4 && frames.every(frame => frame.sha256)
      && new Set(frames.map(frame => frame.sha256)).size > 1 });
  } catch (error) {
    result.cases.push({ mode, output: error.stdout?.trim() || error.message });
  }
  }
} finally {
  await command(['-control', 'closeWallpaper', '-location', name]);
  await delay(500);
  try { await probe(['--capture', String(app.pid), name]); result.closed = false; }
  catch (error) { result.closed = error.stdout?.includes('PROBE_WINDOW_NOT_UNIQUE:0') === true; }
  result.monitorSelectionUnchanged = JSON.stringify(selection(before)) === JSON.stringify(selection(JSON.parse(await readFile(config, 'utf8'))));
  console.log(JSON.stringify(result, null, 2));
  await writeFile(path.join(ROOT, '.local-evidence', `popout-probe-${type}-${mode}.json`), JSON.stringify(result, null, 2));
  assert.equal(result.closed, true, 'Unique probe window must be closed.');
  assert.equal(result.monitorSelectionUnchanged, true, 'Monitor selection must remain unchanged.');
  if (result.cases.length) assert.equal(result.cases[0].dynamic, true, 'Four changing frames are required; creation/metadata alone is not a pass.');
}
