import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IsolatedPlayer } from '../src/isolated-player.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { ROOT, nativeProbe } from '../src/platform.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const engine = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const project = path.resolve(process.argv[2] || path.join(path.dirname(engine), 'projects', 'defaultprojects', 'shimmering_particles', 'project.json'));
const evidence = path.join(ROOT, '.local-evidence', `isolated-native-${randomUUID()}`);
await mkdir(evidence, { recursive: true });
const before = hash(await readFile(path.join(path.dirname(engine), 'config.json')));
const player = new IsolatedPlayer({ executable: engine });
const report = { started: new Date().toISOString(), success: false, evidence, frames: [], noWallpaperResourcesCopied: true, audioOutputMeasurement: 'not-yet-measured' };
try {
  const source = await describeSource(project);
  report.source = { type: source.type, packed: source.packed, id: source.id };
  report.safety = await player.inspect(source); assert.equal(report.safety.safe, true);
  const surface = await player.start(source, { policy: { maxWidth: 640, fps: 30, jpegQuality: 78 } });
  report.surface = surface;
  const config = JSON.parse(await readFile(path.join(player.runtime.root, 'config.json')));
  report.startupAudioDisabled = Object.values(config).some(p => p?.general?.user?.videoaudiooutput === false);
  assert.equal(report.startupAudioDisabled, true);
  await delay(1200);
  for (let index = 0; index < 8; index++) {
    const frame = await player.capture(source, { maxWidth: 640, fps: 30, jpegQuality: 78 });
    assert.ok(frame?.jpeg && frame.width > 0);
    report.frames.push({ sha256: hash(frame.jpeg), width: frame.width, height: frame.height, sequence: frame.sequence });
    await delay(100);
  }
  report.dynamic = new Set(report.frames.map(frame => frame.sha256)).size > 1;
  assert.equal(report.dynamic, true);
  await player.pointer({ type: 'move', x: 0.25, y: 0.75 });
  report.pointerDelivered = true;
  const probe = await nativeProbe();
  report.desktopEngineNotReplaced = probe.wallpaperEngine?.path === engine;
  assert.equal(report.desktopEngineNotReplaced, true);
  report.success = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  if (player.runtime) {
    report.runtimeLogs = {};
    for (const file of ['log.txt', 'bin/webwallpaperlog.txt', 'bin/wallpaperuilog.txt', 'bin/debug.log'])
      try { report.runtimeLogs[file] = (await readFile(path.join(player.runtime.root, file), 'utf8')).slice(-12000); } catch {}
  }
  try { await player.stop(); report.cleaned = true; } catch (error) { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; }
  report.originalConfigUnchanged = hash(await readFile(path.join(path.dirname(engine), 'config.json'))) === before;
  if (!report.originalConfigUnchanged) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
