import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { IndependentApplicationPlayer } from '../src/independent-application.mjs';
import { applicationTree } from '../src/silent-unity-application.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { ROOT, runFile, nativeProbe } from '../src/platform.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = value => createHash('sha256').update(value).digest('hex');
const project = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\projects\\defaultprojects\\sheep\\project.json';
const source = await describeSource(project), before = await applicationTree(source.root), engine = (await nativeProbe()).wallpaperEngine;
const config = path.join(path.dirname(engine.path), 'config.json'), originalConfigHash = hash(await readFile(config));
const helper = path.join(ROOT, 'build', 'BridgeWebIntegration.exe');
const sessions = async pids => JSON.parse((await runFile(helper, ['--sessions', pids.join(',')], { windowsHide: true, timeout: 5000 })).stdout);
const desktopBefore = await sessions([engine.pid]), player = new IndependentApplicationPlayer();
const evidence = path.join(ROOT, '.local-evidence', `sheep-application-${randomUUID()}`);
await mkdir(evidence, { recursive: true });
const report = { success: false, started: new Date().toISOString(), originalTree: before.hash, copiedMediaBytes: 0, frames: [], audioSamples: [] };
try {
  await player.start(source, { policy: { maxWidth: 640, height: 360 } });
  report.process = player.session; report.surface = player.surface;
  const original = await readFile(path.join(source.root, 'sheep_Data', 'globalgamemanagers'));
  const modified = await readFile(path.join(player.runtime.root, 'sheep_Data', 'globalgamemanagers'));
  const differences = [...original.keys()].filter(index => original[index] !== modified[index]);
  assert.deepEqual(differences, [6424]); assert.equal(modified[6424], 1); report.configurationDifference = differences;
  for (let index = 0; index < 12; index++) {
    const frame = await player.capture(source, { maxWidth: 640, height: 360, jpegQuality: 80 });
    report.frames.push(hash(frame.jpeg));
    if (index === 5) await writeFile(path.join(evidence, 'frame.jpg'), Buffer.from(frame.jpeg, 'base64'));
    const audio = await sessions([engine.pid, player.session.pid]);
    assert.ok(audio.sessions.filter(row => row.pid === player.session.pid).every(row => row.peak === 0));
    for (const baseline of desktopBefore.sessions) {
      const current = audio.sessions.find(row => row.pid === baseline.pid && row.deviceIndex === baseline.deviceIndex);
      if (current) assert.ok(current.mute === baseline.mute && current.volume === baseline.volume);
    }
    report.audioSamples.push(audio); await delay(200);
  }
  report.changingFrames = new Set(report.frames).size > 1;
  report.success = report.changingFrames;
  if (!report.success) process.exitCode = 1;
} catch (failure) { report.failure = failure.message; process.exitCode = 1; }
finally {
  await player.stop().catch(failure => { report.cleanupFailure = failure.message; process.exitCode = 1; report.success = false; });
  report.finalTree = (await applicationTree(source.root)).hash;
  report.originalConfigUnchanged = hash(await readFile(config)) === originalConfigHash;
  report.originalFilesUnchanged = report.finalTree === before.hash;
  if (!report.originalConfigUnchanged || !report.originalFilesUnchanged) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, failure: report.failure, changingFrames: report.changingFrames,
    audioSamples: report.audioSamples.length, originalConfigUnchanged: report.originalConfigUnchanged, originalFilesUnchanged: report.originalFilesUnchanged, cleanupFailure: report.cleanupFailure }));
}
