import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { IndependentApplicationPlayer } from '../src/independent-application.mjs';
import { applicationTree } from '../src/silent-unity-application.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const engine = (await nativeProbe()).wallpaperEngine;
assert.ok(engine?.running);
const source = await describeSource(path.join(path.dirname(engine.path), 'projects/defaultprojects/sheep/project.json'));
const originalTree = await applicationTree(source.root), config = path.join(path.dirname(engine.path), 'config.json');
const configHash = digest(await readFile(config));
const evidence = path.join(ROOT, '.local-evidence', `sheep-interaction-${randomUUID()}`);
await mkdir(evidence);
const player = new IndependentApplicationPlayer(), policy = { maxWidth: 640, height: 360, jpegQuality: 95 };
const report = { started: new Date().toISOString(), success: false, frames: [],
  scope: 'Reviewed original Sheep, hidden owned process, actual window messages; count white sheep pixels in pasture after clicking the authored spawn stone. No system cursor or foreground manipulation.' };
const python = process.env.BRIDGE_PYTHON || 'python';
let runtime;
async function sample(phase) {
  const frame = await player.capture(source, policy);
  const file = path.join(evidence, `${String(report.frames.length).padStart(2, '0')}-${phase}.jpg`);
  await writeFile(file, Buffer.from(frame.jpeg, 'base64'));
  const script = `from PIL import Image
import sys,json
im=Image.open(sys.argv[1]).convert('RGB');w,h=im.size
pixels=im.crop((int(w*.2),int(h*.45),int(w*.8),int(h*.9))).getdata()
print(json.dumps({'whitePasturePixels':sum(1 for r,g,b in pixels if min(r,g,b)>205 and max(r,g,b)-min(r,g,b)<45),'width':w,'height':h}))`;
  const pixels = JSON.parse((await runFile(python, ['-c', script, file], { windowsHide: true, timeout: 10000 })).stdout);
  const row = { phase, file: path.basename(file), sha256: digest(Buffer.from(frame.jpeg, 'base64')), ...pixels };
  report.frames.push(row); return row;
}
try {
  await player.start(source, { policy }); runtime = player.runtime;
  report.surface = player.surface; report.identity = player.session;
  for (let index = 0; index < 3; index++) { await sample('before'); await pause(200); }
  for (let index = 0; index < 5; index++) {
    assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.71 }), true);
    await pause(250); await sample('after');
  }
  const before = Math.max(...report.frames.filter(row => row.phase === 'before').map(row => row.whitePasturePixels));
  const after = Math.max(...report.frames.filter(row => row.phase === 'after').map(row => row.whitePasturePixels));
  report.spawnObservation = { beforeMaximum: before, afterMaximum: after, addedWhitePixels: after - before };
  assert.ok(after - before >= 120, 'Clicking the spawn stone must visibly add sheep; queued messages alone do not prove Unity interaction.');
  report.success = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  try { await player.stop(); report.cleaned = true; }
  catch (error) { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; }
  report.runtimeRemoved = !runtime || await stat(runtime.root).then(() => false, error => error.code === 'ENOENT');
  report.sourceUnchanged = (await applicationTree(source.root)).hash === originalTree.hash;
  report.originalConfigUnchanged = digest(await readFile(config)) === configHash;
  if (!report.runtimeRemoved || !report.sourceUnchanged || !report.originalConfigUnchanged) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, failure: report.failure?.message, observation: report.spawnObservation,
    cleaned: report.cleaned, sourceUnchanged: report.sourceUnchanged, originalConfigUnchanged: report.originalConfigUnchanged }));
}
