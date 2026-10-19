import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../src/platform.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { stagePrivateScene, removePrivateScene } from '../src/private-scene.mjs';
import { sourceSnapshot, compareSnapshots } from './library-playback-acceptance.mjs';

const evidence = path.join(ROOT, '.local-evidence', `source-watch-fixed-${randomUUID()}`);
await mkdir(evidence);
const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'cwb-watch-fixed-'));
const root = path.join(taskRoot, 'source'), installed = path.join(taskRoot, 'engine'), events = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observer = new WallpaperEngine({ watchOptions: { watchRoot: (directory, options, notify) => watch(directory, options, (event, file) => {
  events.push({ event, file: String(file), at: new Date().toISOString() }); notify();
}) } });
const report = { success: false, taskRoot, realRendererStarted: false, events, steps: [] }; let view;
try {
  await mkdir(path.join(root, 'nested'), { recursive: true }); await mkdir(installed);
  await writeFile(path.join(root, 'project.json'), '{"type":"scene","file":"scene.json"}');
  await writeFile(path.join(root, 'scene.json'), '{"objects":[]}');
  await writeFile(path.join(root, 'nested', 'asset.txt'), 'authored fixture');
  const settings = { selectedWallpaper: path.join(root, 'project.json') };
  const observe = async name => {
    await pause(300); const first = await observer.observe(null, settings);
    await pause(150); const settled = await observer.observe(null, settings);
    assert.equal(settled.source.fingerprint, first.source.fingerprint, `${name}: second settled observation`);
    const row = { name, fingerprint: settled.source.fingerprint, revision: observer.resourceRevision, dirty: observer.dirty };
    report.steps.push(row); return row;
  };
  const baseline = await observe('baseline'), original = await sourceSnapshot(root);
  view = await stagePrivateScene((await observer.observe(null, settings)).source, { installed });
  const staged = await observe('hardlink-staged'); assert.equal(staged.fingerprint, baseline.fingerprint);
  report.sourceDuringLinks = compareSnapshots(original, await sourceSnapshot(root));
  await removePrivateScene(view); view = null;
  const unlinked = await observe('hardlink-unlinked'); assert.equal(unlinked.fingerprint, baseline.fingerprint);
  report.sourceAfterUnlink = compareSnapshots(original, await sourceSnapshot(root));
  assert.ok(report.sourceDuringLinks.contentUnchanged && report.sourceDuringLinks.metadataUnchanged);
  assert.ok(report.sourceAfterUnlink.contentUnchanged && report.sourceAfterUnlink.metadataUnchanged);
  assert.equal(observer.resourceRevision, baseline.revision);
  await writeFile(path.join(root, 'nested', 'asset.txt'), 'real nested edit');
  assert.notEqual((await observe('nested-edit')).fingerprint, baseline.fingerprint);
  assert.ok(events.length > 0); report.success = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  observer.close(); if (view) await removePrivateScene(view);
  assert.ok(path.resolve(taskRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(taskRoot, { recursive: true, force: true }); report.fixtureRemoved = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }));
}
