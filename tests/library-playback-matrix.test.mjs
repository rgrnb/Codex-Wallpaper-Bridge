import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { compareSnapshots, createStopController, playbackFingerprint, reusableFromReport, reusableResult, runMatrixQueue, sourceSnapshot } from '../scripts/library-playback-acceptance.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cwb-matrix-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('source manifest detects source-local shader additions and retains exact content hashes', async t => {
  const directory = await fixture(t); await writeFile(path.join(directory, 'project.json'), '{"type":"scene"}');
  const before = await sourceSnapshot(directory);
  await mkdir(path.join(directory, 'shaders', 'blobsSM40'), { recursive: true });
  await writeFile(path.join(directory, 'shaders', 'blobsSM40', 'new.dxs'), 'compiled shader');
  const after = await sourceSnapshot(directory), difference = compareSnapshots(before, after);
  assert.equal(difference.metadataUnchanged, false); assert.equal(difference.contentUnchanged, false);
  assert.deepEqual(difference.added.map(row => row.path), ['shaders', 'shaders/blobsSM40', 'shaders/blobsSM40/new.dxs']);
  assert.match(difference.added.at(-1).contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(difference.changed.find(row => row.path === 'project.json'), undefined);
});

test('content digest excludes directory allocation and mtime but strict preservation still fails', async t => {
  const directory = await fixture(t); await writeFile(path.join(directory, 'asset.bin'), 'asset');
  const before = await sourceSnapshot(directory);
  await utimes(directory, new Date(1700000000000), new Date(1700000000000));
  const after = await sourceSnapshot(directory), difference = compareSnapshots(before, after);
  assert.equal(difference.metadataUnchanged, false); assert.equal(difference.contentUnchanged, true);
  assert.deepEqual(difference.changed.map(row => row.path), ['.']);
});

test('equal-size source edits are detected by content digest', async t => {
  const directory = await fixture(t), file = path.join(directory, 'asset.bin'); await writeFile(file, 'aaaa');
  const before = await sourceSnapshot(directory); await writeFile(file, 'bbbb');
  const after = await sourceSnapshot(directory), difference = compareSnapshots(before, after);
  assert.equal(before.totalFileBytes, after.totalFileBytes); assert.equal(difference.contentUnchanged, false);
  assert.ok(difference.changed[0].fields.includes('contentSha256'));
});

test('source junctions are recorded without traversing external media', async t => {
  const directory = await fixture(t), target = await fixture(t); await writeFile(path.join(target, 'private.bin'), 'private');
  await symlink(target, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await sourceSnapshot(directory); await writeFile(path.join(target, 'private.bin'), 'other content');
  const after = await sourceSnapshot(directory);
  assert.equal(before.rows.length, 2); assert.equal(before.rows[1].kind, 'link'); assert.ok(before.rows[1].target);
  assert.equal(before.contentSha256, after.contentSha256); assert.equal(before.metadataSha256, after.metadataSha256);
});

test('resume requires source content, metadata, helper/renderer fingerprint and complete cleanup', () => {
  const snapshot = { metadataSha256: 'metadata', contentSha256: 'content' };
  const passed = { success: true, cleaned: true, privateRuntimeRemoved: true, originalSourceMetadataUnchanged: true,
    originalSourceContentUnchanged: true, originalConfigUnchanged: true, validationFingerprint: 'producer', sourceMetadataAfter: snapshot };
  assert.equal(reusableResult(passed, snapshot, 'producer'), true);
  assert.equal(reusableResult(passed, snapshot, 'changed-helper-or-source'), false);
  assert.equal(reusableResult(passed, { ...snapshot, contentSha256: 'changed-content' }, 'producer'), false);
  assert.equal(reusableResult(passed, { ...snapshot, metadataSha256: 'changed-mtime' }, 'producer'), false);
  assert.equal(reusableResult({ ...passed, privateRuntimeRemoved: false }, snapshot, 'producer'), false);
  assert.equal(reusableResult({ ...passed, validationFingerprint: null }, snapshot, null), false);
  assert.equal(reusableResult({ ...passed, type: 'scene', privateSceneRuntimeRemoved: false }, snapshot, 'producer'), false);
  assert.equal(reusableResult({ success: true, sourceMetadataAfter: { sha256: 'legacy' } }, snapshot, 'producer'), false);
});

test('explicit pause stops the active host before waiting, checkpoints once, and never starts the next project', async () => {
  const started = [], stopped = [], checkpoints = [];
  let entered, release;
  const active = new Promise(resolve => { entered = resolve; });
  const currentCapture = new Promise(resolve => { release = resolve; });
  const controller = createStopController({ onStop: reason => checkpoints.push(reason) });
  const queue = runMatrixQueue({ items: ['current', 'next'], shouldStop: () => Boolean(controller.reason), execute: async item => {
    started.push(item);
    const player = { stop() { stopped.push(item); release(); return Promise.resolve(); } };
    controller.setActive(player); entered(); await currentCapture;
    assert.throws(() => controller.check(), /MATRIX_STOP_REQUESTED/); controller.clearActive(player);
  } });
  await active;
  const stopping = controller.request('explicit-pause');
  assert.deepEqual(stopped, ['current']);
  await stopping; await queue;
  await controller.request('second-pause');
  assert.deepEqual(started, ['current']); assert.deepEqual(stopped, ['current']); assert.deepEqual(checkpoints, ['explicit-pause']);
});

test('a completed scene is reusable after an unrelated Application worker edit, while changed scene source invalidates it', () => {
  const producerSha256 = Object.fromEntries(['library.mjs', 'wallpaper-engine.mjs', 'isolated-player.mjs', 'private-scene.mjs', 'platform.mjs', 'cdp.mjs',
    'independent-application.mjs', 'silent-unity-application.mjs', 'independent-application-worker.ps1'].map(name => [`src/${name}`, `hash:${name}`]));
  const previous = { helperSha256: Object.fromEntries(['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll', 'BridgeApplicationInput.dll', 'BridgeApplicationInputHook32.dll'].map(file => [file, `helper:${file}`])),
    producerSha256, engineSha256: 'engine', policy: { fps: 30 }, validationFingerprint: 'old-whole-report' };
  const current = { ...previous, producerSha256: { ...producerSha256, 'src/independent-application-worker.ps1': 'edited-worker' } };
  const snapshot = { contentSha256: 'content', metadataSha256: 'metadata' };
  const candidate = { type: 'scene', validationFingerprint: previous.validationFingerprint, success: true, cleaned: true,
    privateRuntimeRemoved: true, privateSceneRuntimeRemoved: true, originalSourceMetadataUnchanged: true, originalSourceContentUnchanged: true, originalConfigUnchanged: true, sourceMetadataAfter: snapshot };
  assert.equal(playbackFingerprint(previous, 'scene'), playbackFingerprint(current, 'scene'));
  assert.notEqual(playbackFingerprint(previous, 'application'), playbackFingerprint(current, 'application'));
  assert.ok(reusableFromReport(candidate, snapshot, playbackFingerprint(current, 'scene'), previous));
  current.producerSha256['src/isolated-player.mjs'] = 'edited-scene-stage';
  assert.equal(reusableFromReport(candidate, snapshot, playbackFingerprint(current, 'scene'), previous), null);
});

test('Application-only helper changes preserve Scene/Web evidence while private Scene module changes invalidate Scene evidence', () => {
  const producerSha256 = Object.fromEntries(['library.mjs', 'wallpaper-engine.mjs', 'isolated-player.mjs', 'private-scene.mjs', 'platform.mjs', 'cdp.mjs',
    'independent-application.mjs', 'silent-unity-application.mjs', 'independent-application-worker.ps1'].map(name => [`src/${name}`, `hash:${name}`]));
  const context = { helperSha256: Object.fromEntries(['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll', 'BridgeApplicationInput.dll', 'BridgeApplicationInputHook32.dll'].map(file => [file, `helper:${file}`])),
    producerSha256, engineSha256: 'engine', policy: { fps: 30 } };
  const before = Object.fromEntries(['scene', 'web', 'application'].map(type => [type, playbackFingerprint(context, type)]));
  assert.ok(Object.values(before).every(value => /^[a-f0-9]{64}$/.test(value)));
  context.helperSha256['BridgeApplicationInputHook32.dll'] = 'changed-32bit-input-helper';
  assert.equal(playbackFingerprint(context, 'scene'), before.scene); assert.equal(playbackFingerprint(context, 'web'), before.web);
  assert.notEqual(playbackFingerprint(context, 'application'), before.application);
  context.producerSha256['src/private-scene.mjs'] = 'changed-view-staging';
  assert.notEqual(playbackFingerprint(context, 'scene'), before.scene); assert.equal(playbackFingerprint(context, 'web'), before.web);
  delete context.helperSha256['BridgeApplicationInputHook32.dll'];
  assert.equal(playbackFingerprint(context, 'application'), null); assert.ok(playbackFingerprint(context, 'scene'));
});

test('a paused checkpoint starts no host', async () => {
  const started = [], controller = createStopController(); await controller.request('saved-pause');
  await runMatrixQueue({ items: ['one', 'two'], shouldStop: () => Boolean(controller.reason), execute: async item => started.push(item) });
  assert.deepEqual(started, []);
});
