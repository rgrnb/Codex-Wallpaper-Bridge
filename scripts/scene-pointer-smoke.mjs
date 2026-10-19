import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sourceSnapshot, snapshotSummary, compareSnapshots, sceneCacheEvidence } from './library-playback-acceptance.mjs';

// An authored SceneScript image encodes its real observed cursor position in
// red/green and real cursorDown/cursorClick callbacks in blue. Message-send
// success alone cannot satisfy these assertions. No system input is injected.
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.local-evidence', `scene-pointer-${randomUUID()}`);
await mkdir(path.join(evidence, 'helper'), { recursive: true });
for (const file of ['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll'])
  await copyFile(path.join(process.env.BRIDGE_POINTER_BUILD || path.join(root, 'build'), file), path.join(evidence, 'helper', file));
process.env.BRIDGE_NATIVE_HOST = path.join(evidence, 'helper', 'CodexWallpaperBridge.exe');
const { IsolatedPlayer } = await import('../src/isolated-player.mjs');
const { describeSource } = await import('../src/wallpaper-engine.mjs');
const engine = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const installedConfig = path.join(path.dirname(engine), 'config.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const originalConfigHash = hash(await readFile(installedConfig));
// Only the two authored JSON documents are generated on the engine volume.
// Existing repository/user caches and all original media remain untouched.
const crossVolume = process.env.BRIDGE_SCENE_CROSS_VOLUME === '1';
const fixtureToken = randomUUID(), fixtureBase = crossVolume ? path.join(evidence, 'authored-sources') : path.join(path.dirname(engine), '.bridge-scene-fixtures'), fixtureRoot = path.join(fixtureBase, fixtureToken);
await mkdir(fixtureBase, { recursive: true });
assert.ok(!(await lstat(fixtureBase)).isSymbolicLink() && path.resolve(await realpath(fixtureBase)).toLowerCase() === path.resolve(fixtureBase).toLowerCase(), 'Fixture base must be a real private directory.');
await mkdir(fixtureRoot);
const fixtureOrigin = { token: fixtureToken, root: fixtureRoot, evidence, generatedFromAuthoredJsonOnly: true, files: [] };
for (const name of ['project.json', 'scene.json']) {
  const template = path.join(root, 'scripts', 'experiments', 'fixtures', 'scene-pointer', name), file = path.join(fixtureRoot, name), bytes = await readFile(template);
  await writeFile(file, bytes, { flag: 'wx' }); fixtureOrigin.files.push({ template, file, bytes: bytes.length, sha256: hash(bytes) });
}
await writeFile(path.join(evidence, 'fixture-origin.json'), JSON.stringify(fixtureOrigin, null, 2));
await writeFile(path.join(fixtureBase, `${fixtureToken}.owner.json`), JSON.stringify(fixtureOrigin, null, 2), { flag: 'wx' });
const source = await describeSource(path.join(fixtureRoot, 'project.json'));
if (crossVolume) assert.notEqual((await stat(source.root)).dev, (await stat(path.dirname(engine))).dev, 'The cross-volume fixture requires physically distinct volumes.');
const sourceBefore = await sourceSnapshot(source.root);
await writeFile(path.join(evidence, 'source-before.json'), JSON.stringify(sourceBefore, null, 2));
assert.equal(sourceBefore.fileCount, 2, 'The fresh authored source must contain only its two JSON documents.');
const player = new IsolatedPlayer({ executable: engine });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const report = { started: new Date().toISOString(), success: false, scope: 'Authored SceneScript through real private Wallpaper Engine renderer; no system pointer/focus change.',
  mechanism: 'verified-private-process-input-virtualization-and-owned-window-messages', samples: [], actualCodex: false,
  fixtureOrigin, sourceMetadataBefore: snapshotSummary(sourceBefore), firstSourceCacheAbsent: !sourceBefore.rows.some(row => /(?:^|\/)blobs[^/]*\//i.test(row.path)) };
let runtime;
const interrupt = () => { report.interrupted = true; player.stop().catch(error => { report.interruptCleanupFailure = error.stack; }); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const deadline = setTimeout(() => { report.timedOut = true; interrupt(); }, 45000);
const checkActive = () => { if (report.interrupted) throw new Error('SCENE_FIXTURE_CANCELLED'); };
report.helperSha256 = {};
for (const file of ['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll'])
  report.helperSha256[file] = hash(await readFile(path.join(evidence, 'helper', file)));
const python = process.env.BRIDGE_PYTHON || 'python';
const policy = { maxWidth: 640, height: 360, fps: 30, jpegQuality: 95 };
async function sendPointer(event) {
  checkActive();
  if(!process.argv.includes('--supplement-messages'))return player.pointer(event);
  await player.frames.pointer(player.surface,event);
  await player.pipe.call('pointer',{token:player.runtime.token,type:event.type,x:event.x,y:event.y});return true;
}
async function sample(name) {
  checkActive();
  let frame;
  for (let index = 0; index < 3; index++) { frame = await player.capture(source, policy); await delay(80); }
  assert.ok(frame?.jpeg); const file = path.join(evidence, `${name}.jpg`); await writeFile(file, Buffer.from(frame.jpeg, 'base64'));
  const result = await run(python, ['-c', 'from PIL import Image;import json,sys;im=Image.open(sys.argv[1]).convert("RGB");print(json.dumps({"rgb":im.getpixel((im.width//2,im.height//2)),"size":im.size}))', file], { windowsHide: true, timeout: 5000 });
  const value = { name, ...JSON.parse(result.stdout), sequence: frame.sequence }; report.samples.push(value); return value.rgb;
}
try {
  report.surface = await player.start(source, { policy });
  runtime = player.runtime;
  assert.ok(runtime?.sceneRuntime?.root, 'Scene must use the registered private project view.');
  report.runtimeIdentity = { root: runtime.root, token: runtime.token, sceneRoot: runtime.sceneRuntime.root };
  await delay(1000); await sample('baseline');
  assert.equal(await sendPointer({ type: 'move', x: 0.2, y: 0.8 }), true); await delay(180);
  const lowHigh = await sample('move-low-high');
  assert.equal(await sendPointer({ type: 'move', x: 0.8, y: 0.2 }), true); await delay(180);
  const highLow = await sample('move-high-low');
  report.cursorPositionObserved = highLow[0] - lowHigh[0] > 50 && lowHigh[1] - highLow[1] > 50;
  assert.equal(await sendPointer({ type: 'click', x: 0.5, y: 0.5 }), true); await delay(180);
  const clicked = await sample('click');
  // Blue = .1 + .15 * polled + .25 * (down % 2) + .45 * (click % 2).
  // Only a real polled button plus both callbacks can exceed 220/255.
  report.buttonPollingObserved = report.cursorDownObserved = report.clickObserved = clicked[2] > 220;
  assert.equal(report.cursorPositionObserved, true, 'SceneScript must observe changed pointer coordinates.');
  assert.equal(report.clickObserved, true, 'SceneScript must observe button polling, cursorDown and cursorClick.');
  assert.equal(await sendPointer({ type: 'click', x: 0.5, y: 0.5 }), true); await delay(180);
  const clickedAgain = await sample('second-click');
  assert.equal(await sendPointer({ type: 'click', x: 0.5, y: 0.5 }), true); await delay(180);
  const clickedThird = await sample('third-click');
  report.repeatedClicksObserved = clickedAgain[2] > 45 && clickedAgain[2] < 90 && clickedThird[2] > 220;
  assert.equal(report.repeatedClicksObserved, true, 'SceneScript must observe distinct down/up edges on repeated clicks.');
  report.success = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  clearTimeout(deadline);
  runtime ||= player.runtime;
  if (runtime?.sceneRuntime) {
    try {
      report.privateShaderCache = await sceneCacheEvidence(runtime.sceneRuntime);
      await writeFile(path.join(evidence, 'private-shader-cache.json'), JSON.stringify(report.privateShaderCache, null, 2));
      report.firstPrivateShaderCompilationObserved = report.firstSourceCacheAbsent && report.privateShaderCache.files.length > 0;
      if (!report.firstPrivateShaderCompilationObserved) { report.success = false; report.cacheFailure = 'No first compiled shader was observed in the new private project view.'; }
    } catch (error) { report.success = false; report.cacheFailure = error.stack; }
  }
  if (player.runtime) {
    report.logs = {};
    for (const file of ['log.txt', 'bin/debug.log']) try { report.logs[file] = (await readFile(path.join(player.runtime.root, file), 'utf8')).slice(-18000); } catch {}
  }
  try { await player.stop(); report.cleaned = true; } catch (error) { report.success = false; report.cleanupFailure = error.stack; process.exitCode = 1; }
  const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  report.privateRuntimeRemoved = !runtime || !(await exists(runtime.root));
  report.privateSceneRuntimeRemoved = !runtime?.sceneRuntime || !(await exists(runtime.sceneRuntime.root));
  const sourceAfter = await sourceSnapshot(source.root); await writeFile(path.join(evidence, 'source-after.json'), JSON.stringify(sourceAfter, null, 2));
  report.sourceMetadataAfter = snapshotSummary(sourceAfter); report.sourceChanges = compareSnapshots(sourceBefore, sourceAfter);
  report.originalSourceMetadataUnchanged = report.sourceChanges.metadataUnchanged; report.originalSourceContentUnchanged = report.sourceChanges.contentUnchanged;
  report.authoredTemplatesUnchanged = (await Promise.all(fixtureOrigin.files.map(async item => hash(await readFile(item.template)) === item.sha256))).every(Boolean);
  report.originalConfigUnchanged = hash(await readFile(installedConfig)) === originalConfigHash;
  if (!report.originalConfigUnchanged || !report.originalSourceMetadataUnchanged || !report.originalSourceContentUnchanged || !report.authoredTemplatesUnchanged ||
      !report.privateRuntimeRemoved || !report.privateSceneRuntimeRemoved || report.interrupted) report.success = false;
  if (!report.success) process.exitCode = 1;
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  report.finished = new Date().toISOString(); await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }));
}
