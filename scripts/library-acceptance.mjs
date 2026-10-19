import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, nativeProbe } from '../src/platform.mjs';
import { WallpaperLibrary } from '../src/library.mjs';
import { inspectNativeAudio, NativePlayer } from '../src/native-player.mjs';

// Read-only installed-library matrix. Playback belongs to the physical-window
// runner. A rejected native source must fail before ANY external side effect.
const evidence = path.join(ROOT, '.local-evidence', `library-acceptance-${randomBytes(8).toString('hex')}`);
await mkdir(evidence, { recursive: true });
const report = { started: new Date().toISOString(), checks: [], success: false,
  scope: 'Real installed metadata and production native startup guard; no playback, desktop commands, source copies or writes.' };
const metadata = async file => { const info = await stat(file); return { size: info.size, mtimeMs: info.mtimeMs,
  sha256: createHash('sha256').update(await readFile(file)).digest('hex') }; };
try {
  const apps = await nativeProbe(), library = new WallpaperLibrary();
  await library.refresh({ executable: apps.wallpaperEngine?.path });
  assert.equal(library.errors.length, 0); assert.ok(library.items.length > 0);
  for (const item of library.items) {
    const before = await metadata(item.project), safety = await inspectNativeAudio(item);
    const check = { id: item.id, type: item.type, origin: item.origin, resourceExtension: path.extname(item.resource),
      nativeSafety: safety, nativePlaybackAttempted: false, backgroundRoute: item.type === 'video' ? 'chromium-muted-video' :
        safety.safe ? 'wallpaper-engine-window' : item.type === 'web' ? 'isolated-muted-web' : 'unsupported' };
    if (!safety.safe) {
      let calls = 0;
      const forbidden = async () => { calls++; throw new Error('LIBRARY_UNEXPECTED_NATIVE_SIDE_EFFECT'); };
      const player = new NativePlayer({ executable: apps.wallpaperEngine?.path,
        run: forbidden, probe: forbidden, findSurface: forbidden, lease: forbidden });
      await assert.rejects(player.start(item), { message: 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE' });
      assert.equal(calls, 0); assert.ok(!player.opened && !player.surface);
      check.blockedBeforeExternalSideEffects = true;
    }
    assert.deepEqual(await metadata(item.project), before);
    check.metadataUnchanged = true; report.checks.push(check);
  }
  report.summary = { count: library.items.length,
    byType: Object.fromEntries(['scene', 'video', 'web', 'application'].map(type => [type, report.checks.filter(check => check.type === type).length])),
    packedScenes: report.checks.filter(check => check.type === 'scene' && check.resourceExtension === '.pkg').length,
    nativeVerified: report.checks.filter(check => check.nativeSafety.safe).length,
    nativeRejectedBeforeSideEffects: report.checks.filter(check => check.blockedBeforeExternalSideEffects).length,
    unsupportedScenes: report.checks.filter(check => check.type === 'scene' && check.backgroundRoute === 'unsupported').length };
  report.success = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  report.finished = new Date().toISOString(); await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, summary: report.summary, failure: report.failure }));
}
