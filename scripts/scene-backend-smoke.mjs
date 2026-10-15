import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { nativeProbe, NativeFrames, runFile, ROOT } from '../src/platform.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
const observer = new WallpaperEngine({ username: os.userInfo().username }), frames = new NativeFrames();
const app = (await nativeProbe()).wallpaperEngine;
const previous = (await observer.observe(app, { monitor: 0 })).source;
const delay = ms => new Promise(r => setTimeout(r, ms));
const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const command = args => runFile(app.path, args.map(quote), { windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 });
const result = { type: 'scene', sample: 'WE stock Shimmering Particles', frames: [], originalRestored: false };
const toggleDesktop = () => runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Shell.Application).ToggleDesktop()'], { windowsHide: true, timeout: 5000 });
let toggled = false;
try {
  await command(['-control', 'openWallpaper', '-file', path.join(path.dirname(app.path), 'projects', 'defaultprojects', 'shimmering_particles', 'project.json'), '-monitor', '0']);
  await delay(1400);
  if (process.argv.includes('--show-desktop')) { await toggleDesktop(); toggled = true; await delay(500); }
  const current = await nativeProbe();
  result.surfaces = current.wallpaperEngine.surfaces;
  const surface = result.surfaces.find(s => s.type === 'scene'); assert.ok(surface, 'A live owned Scene renderer is required.');
  if (process.argv.includes('--promote')) {
    try { result.promotion = (await runFile(path.join(ROOT, '.local-evidence', 'CaptureProbe.exe'), ['--promote-selected-scene', String(app.pid)], { windowsHide: true, timeout: 12000 })).stdout; }
    catch (error) { result.promotion = error.stdout || error.message; }
    console.log(JSON.stringify({ promotion: result.promotion })); returnAfterPromotion();
  }
  for (let n = 0; n < 4; n++) {
    const frame = await frames.capture(surface, { maxWidth: 640, jpegQuality: 70 });
    if(frame.paused){result.sourceNotSubmittingFrames=true;throw new Error('SCENE_LIVE_VALIDATION_NEEDS_RENDERING_SOURCE');}
    result.frames.push(createHash('sha256').update(frame.jpeg).digest('hex')); await delay(200);
  }
  result.changingFrames = new Set(result.frames).size > 1;
  assert.ok(result.changingFrames, 'Four static/black frames do not prove Scene dynamic support.');
} finally {
  frames.stop();
  await command(['-control', 'openWallpaper', '-file', previous.resource, '-monitor', '0']);
  if (Object.keys(previous.properties || {}).length) await runFile(app.path,
    [quote('-control'), quote('applyProperties'), quote('-properties'), `RAW~(${JSON.stringify(previous.properties)})~END`, quote('-monitor'), quote('0')],
    { windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 });
  await delay(500);
  const restored = (await observer.observe(app, { monitor: 0 })).source;
  result.originalRestored = restored.resource.toLowerCase() === previous.resource.toLowerCase();
  observer.close();
  if (toggled) await toggleDesktop();
  await writeFile(path.join(ROOT, '.local-evidence', 'scene-backend-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); assert.ok(result.originalRestored);
}
function returnAfterPromotion() { throw new Error('PROMOTION_EXPERIMENT_COMPLETE'); }
