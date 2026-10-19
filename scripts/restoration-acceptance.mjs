import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, nativeProbe } from '../src/platform.mjs';
import { listTargets, CdpClient } from '../src/cdp.mjs';

// Read-only restoration check against the user's configured local Codex port.
// Reads operational canvas counters/structure only; no text, screenshot, input,
// navigation, window activation or preference change.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = path.join(ROOT, '.local-evidence', `restoration-acceptance-${randomBytes(8).toString('hex')}`);
await mkdir(evidence, { recursive: true });
const settingsFile = path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge/settings.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalBytes = await readFile(settingsFile), settings = JSON.parse(originalBytes);
const report = { started: new Date().toISOString(), success: false, screenshotsSaved: false, inputSent: false, samples: [] };
let client;
try {
  assert.equal(settings.enabled, true, 'The original user profile must have enabled background for this check.');
  const adapter = JSON.parse(await readFile(path.join(ROOT, 'config/adapter.json'), 'utf8'));
  const apps = await nativeProbe(); report.userAppPids = apps.codex.filter(app => app.endpoints.includes(settings.cdpPort)).map(app => app.pid);
  assert.ok(report.userAppPids.length > 0 && apps.wallpaperEngine?.running);
  const deadline = Date.now() + 45000;
  while (!client && Date.now() < deadline) {
    for (const target of await listTargets(settings.cdpPort)) {
      const connection = await new CdpClient(target.webSocketDebuggerUrl).connect();
      const structural = await connection.evaluate(`({root:!!document.querySelector(${JSON.stringify(adapter.selectors.root)}),main:!!document.querySelector(${JSON.stringify(adapter.selectors.main)}),composer:!!document.querySelector(${JSON.stringify(adapter.selectors.composer)}),installed:!!window.__codexWallpaperBridgeV1})`);
      if (Object.values(structural).every(Boolean)) { client = connection; report.structure = structural; break; }
      connection.close();
    }
    if (!client) await delay(500);
  }
  assert.ok(client, 'LIVE_BACKGROUND_NOT_RESTORED');
  for (let index = 0; index < 8; index++) {
    const sample = await client.evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');return {canvases:document.querySelectorAll('canvas[data-cwb-owned="v1"]').length,inputFileElements:document.querySelectorAll('input[type="file"][data-cwb-owned]').length,canvasWidth:c?.width,canvasHeight:c?.height,viewportWidth:innerWidth,viewportHeight:innerHeight,dpr:devicePixelRatio,ping:window.__codexWallpaperBridgeV1?.ping()}})()`);
    assert.equal(sample.canvases, 1); assert.equal(sample.inputFileElements, 0);
    assert.equal(sample.ping?.installed, true);
    if (sample.ping.playback) assert.ok(sample.ping.playback.nativeFile && sample.ping.playback.muted && sample.ping.playback.defaultMuted && sample.ping.playback.volume === 0);
    report.samples.push(sample); await delay(500);
  }
  const first = report.samples[0], last = report.samples.at(-1);
  if (last.ping.playback && last.ping.visible) assert.ok(last.ping.playback.decodedFrames > first.ping.playback.decodedFrames);
  report.settingsUnchanged = hash(originalBytes) === hash(await readFile(settingsFile));
  assert.equal(report.settingsUnchanged, true);
  report.summary = { oneCanvas: true, settingsUnchanged: true, wallpaperEnginePid: apps.wallpaperEngine.pid,
    visible: last.ping.visible, runtimeVersion: last.ping.runtimeVersion, physicalCanvas: [last.canvasWidth, last.canvasHeight],
    sourceDimensions: last.ping.playback ? [last.ping.playback.sourceWidth, last.ping.playback.sourceHeight] : null,
    muted: last.ping.playback ? last.ping.playback.muted && last.ping.playback.volume === 0 : null,
    decodedFramesDelta: last.ping.playback ? last.ping.playback.decodedFrames - first.ping.playback.decodedFrames : null };
  report.success = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  client?.close(); report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, summary: report.summary, failure: report.failure }));
}
