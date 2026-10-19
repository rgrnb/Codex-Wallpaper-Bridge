import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { stagePrivateScene, removePrivateScene, verifyPrivateScene } from '../src/private-scene.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { compareSnapshots, sourceSnapshot } from '../scripts/library-playback-acceptance.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cwb-private-scene-')), installed = path.join(base, 'engine'), sourceRoot = path.join(base, 'source');
  t.after(async () => {
    assert.ok(path.basename(base).startsWith('cwb-private-scene-'));
    // Files are test-owned. Production cleanup never changes attributes.
    await chmod(path.join(sourceRoot, 'media', 'image.bin'), 0o666).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  await mkdir(installed); await mkdir(path.join(sourceRoot, 'media'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.json' }));
  await writeFile(path.join(sourceRoot, 'scene.json'), '{"objects":[]}'); await writeFile(path.join(sourceRoot, 'media', 'image.bin'), 'original image');
  return { base, installed, sourceRoot, source: await describeSource(path.join(sourceRoot, 'project.json')), token: randomUUID() };
}
const markerFile = view => path.join(view.root, '.bridge-scene.json');

test('the first compiled shader is private while every original source byte and modification time stays unchanged', async t => {
  const f = await fixture(t), cache = path.join(f.sourceRoot, 'shaders', 'blobsSM40');
  await mkdir(cache, { recursive: true }); await writeFile(path.join(cache, `${'a'.repeat(40)}.dxs`), 'old source cache');
  const before = await sourceSnapshot(f.sourceRoot), view = await stagePrivateScene(f.source, f);
  assert.equal(view.copiedMediaBytes, 0); assert.equal(view.referencedFiles, 3);
  assert.deepEqual(await readdir(path.join(view.root, 'shaders', 'blobsSM40')), []);
  const original = await lstat(path.join(f.sourceRoot, 'media', 'image.bin'), { bigint: true }), staged = await lstat(path.join(view.root, 'media', 'image.bin'), { bigint: true });
  assert.equal(staged.ino, original.ino); assert.equal(staged.dev, original.dev);
  for (const directory of ['media', 'shaders', 'shaders/blobsSM40']) assert.equal((await lstat(path.join(view.root, directory))).isSymbolicLink(), false);
  const generated = `shaders/blobsSM40/${'b'.repeat(40)}.dxs`; await writeFile(path.join(view.root, generated), Buffer.from('SHDV0069\0private shader'));
  assert.deepEqual((await verifyPrivateScene(view)).cacheFiles, [generated]);
  await removePrivateScene({ root: view.root, token: view.token }); await removePrivateScene({ root: view.root, token: view.token });
  assert.equal(await lstat(view.root).then(() => true, error => error.code !== 'ENOENT'), false);
  const after = await sourceSnapshot(f.sourceRoot), changes = compareSnapshots(before, after);
  assert.equal(changes.contentUnchanged, true); assert.equal(changes.metadataUnchanged, true);
});

test('failed reference creation cleans only its registered partial view', async t => {
  const f = await fixture(t); let count = 0;
  await assert.rejects(stagePrivateScene(f.source, { ...f, linkFile: async (from, to) => { if (++count === 2) throw new Error('fixture-link-failure'); await link(from, to); } }), /fixture-link-failure/);
  const root = path.join(f.installed, '.bridge-scene-runtime', f.token);
  assert.equal(await lstat(root).then(() => true, error => error.code !== 'ENOENT'), false);
  assert.equal(await readFile(path.join(f.sourceRoot, 'media', 'image.bin'), 'utf8'), 'original image');
  assert.equal((await lstat(path.join(f.sourceRoot, 'media', 'image.bin'))).nlink, 1);
});

test('source junctions and root aliases are rejected before staging', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'preserve'), 'outside');
  await symlink(outside, path.join(f.sourceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stagePrivateScene(f.source, f), /SCENE_VIEW_SOURCE_LINK_UNVERIFIED/);
  await unlink(path.join(f.sourceRoot, 'escape'));
  const alias = path.join(f.base, 'alias'); await symlink(f.sourceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stagePrivateScene({ ...f.source, root: alias, project: path.join(alias, 'project.json'), resource: path.join(alias, 'scene.json') }, f), /SCENE_VIEW_SOURCE_ALIAS_UNVERIFIED/);
});

test('cleanup validates the complete view before unlinking any source reference', async t => {
  const f = await fixture(t), view = await stagePrivateScene(f.source, f), original = path.join(f.sourceRoot, 'media', 'image.bin');
  await link(original, path.join(view.root, 'unregistered.bin'));
  await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  assert.equal((await lstat(original)).nlink, 3); assert.equal(await readFile(path.join(view.root, 'project.json'), 'utf8'), await readFile(f.source.project, 'utf8'));
  await unlink(path.join(view.root, 'unregistered.bin')); await removePrivateScene(view);
});

test('private shader caches cannot smuggle junctions, ordinary hardlinks, bad headers or arbitrary filenames', async t => {
  for (const attack of ['junction', 'hardlink', 'header', 'name']) {
    const f = await fixture(t), view = await stagePrivateScene(f.source, f), cache = path.join(view.root, 'shaders', 'blobsSM40'), file = path.join(cache, `${'c'.repeat(40)}.dxs`);
    if (attack === 'junction') await symlink(f.sourceRoot, file, process.platform === 'win32' ? 'junction' : 'dir');
    if (attack === 'hardlink') await link(path.join(f.sourceRoot, 'media', 'image.bin'), file);
    if (attack === 'header') await writeFile(file, 'unrecognized data');
    if (attack === 'name') await writeFile(path.join(cache, 'unregistered.log'), 'SHDV0069\0data');
    await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
    assert.equal(await readFile(path.join(view.root, 'media', 'image.bin'), 'utf8'), 'original image');
    await unlink(attack === 'name' ? path.join(cache, 'unregistered.log') : file); await removePrivateScene(view);
  }
});

test('redirected runtime directories and replaced hardlinks are rejected without touching outside data', async t => {
  const f = await fixture(t), view = await stagePrivateScene(f.source, f), media = path.join(view.root, 'media'), moved = path.join(f.base, 'moved');
  await rename(media, moved); await symlink(f.sourceRoot, media, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(path.join(f.sourceRoot, 'media', 'image.bin'), 'utf8'), 'original image');
  await unlink(media); await rename(moved, media);
  await unlink(path.join(media, 'image.bin')); await writeFile(path.join(media, 'image.bin'), 'replacement');
  await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  await unlink(path.join(media, 'image.bin')); await link(path.join(f.sourceRoot, 'media', 'image.bin'), path.join(media, 'image.bin')); await removePrivateScene(view);
});

test('duplicate, traversal and Windows alias references cannot redirect cleanup', async t => {
  const f = await fixture(t), view = await stagePrivateScene(f.source, f), marker = JSON.parse(await readFile(markerFile(view), 'utf8'));
  for (const relative of ['media/../scene.json', 'media/image.bin.', 'media/image.bin ', 'media/image.bin:stream', 'media/IMAGE.BIN', 'media/CON']) {
    const altered = structuredClone(marker); altered.references.push({ ...altered.references[0], relative, original: path.join(f.sourceRoot, relative) });
    await writeFile(markerFile(view), JSON.stringify(altered)); await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
    assert.equal(await readFile(path.join(view.root, 'scene.json'), 'utf8'), '{"objects":[]}');
  }
  await writeFile(markerFile(view), JSON.stringify(marker)); await removePrivateScene(view);
});

test('cleanup refuses aliased base/root, and an absent legitimate view is idempotent', async t => {
  const f = await fixture(t), view = await stagePrivateScene(f.source, f), alias = path.join(f.installed, '.bridge-scene-runtime', randomUUID());
  await symlink(view.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removePrivateScene({ root: alias, token: path.basename(alias) }), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  await unlink(alias); await removePrivateScene(view);
  await removePrivateScene({ root: view.root, token: view.token });
  const outside = path.join(f.base, 'outside'); await mkdir(outside);
  await symlink(outside, path.dirname(view.root), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removePrivateScene({ root: view.root, token: view.token }), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
});

test('read-only hardlinks are unlinked without chmod of the original inode', async t => {
  const f = await fixture(t), original = path.join(f.sourceRoot, 'media', 'image.bin'); await chmod(original, 0o444);
  const before = await lstat(original, { bigint: true }), view = await stagePrivateScene(f.source, f); await removePrivateScene(view);
  const after = await lstat(original, { bigint: true });
  assert.equal(after.mode, before.mode); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.nlink, 1n);
  assert.equal(await lstat(view.root).then(() => true, error => error.code !== 'ENOENT'), false);
  assert.equal(await readFile(original, 'utf8'), 'original image');
});

test('synthetic cache directories cannot exceed the manifest budget after source inventory', async t => {
  const f = await fixture(t);
  // 2047 source directories (including existing media) fit the source walk,
  // but two synthetic cache directories would exceed the 2048 view limit.
  for (let index = 0; index < 2046; index++) await mkdir(path.join(f.sourceRoot, `directory-${index}`));
  await assert.rejects(stagePrivateScene(f.source, f), /SCENE_VIEW_SOURCE_LIMIT/);
  assert.equal(await lstat(path.join(f.installed, '.bridge-scene-runtime')).then(() => true, error => error.code !== 'ENOENT'), false);
  assert.equal((await lstat(path.join(f.sourceRoot, 'media', 'image.bin'))).nlink, 1);
});

test('a separate source volume uses a private sibling hardlink view with strict cleanup ownership', async t => {
  const f = await fixture(t), evidence = fileURLToPath(new URL('../.local-evidence/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  if ((await lstat(evidence)).dev === (await lstat(f.installed)).dev) return t.skip('Requires two local filesystem volumes.');
  const authored = await mkdtemp(path.join(evidence, 'cross-volume-scene-test-'));
  t.after(async () => { assert.equal(path.dirname(authored), path.resolve(evidence)); await rm(authored, { recursive: true, force: true }); });
  const sourceRoot = path.join(authored, 'source'); await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.json' }));
  await writeFile(path.join(sourceRoot, 'scene.json'), '{"objects":[]}');
  const source = await describeSource(path.join(sourceRoot, 'project.json')), before = await sourceSnapshot(sourceRoot);
  const view = await stagePrivateScene(source, { installed: f.installed });
  assert.equal(view.crossVolumeEngine, true); assert.equal(view.copiedMediaBytes, 0);
  assert.equal(path.dirname(path.dirname(view.root)), authored);
  const original = await lstat(source.resource, { bigint: true }), reference = await lstat(view.resource, { bigint: true });
  assert.equal(reference.dev, original.dev); assert.equal(reference.ino, original.ino);
  assert.notEqual(reference.dev, (await lstat(f.installed, { bigint: true })).dev);
  await writeFile(path.join(view.root, 'shaders/blobsSM40', `${'f'.repeat(40)}.dxs`), Buffer.from('SHDV0069\0private cross-volume cache'));
  const marker = await readFile(markerFile(view), 'utf8'), forged = JSON.parse(marker); forged.installed = authored;
  await writeFile(markerFile(view), JSON.stringify(forged));
  await assert.rejects(removePrivateScene(view), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  await writeFile(markerFile(view), marker);
  await assert.rejects(removePrivateScene({ root: view.root, token: view.token }), /SCENE_VIEW_CLEANUP_SCOPE_INVALID/);
  await verifyPrivateScene(view); await removePrivateScene(view); await removePrivateScene(view);
  assert.deepEqual(compareSnapshots(before, await sourceSnapshot(sourceRoot)), { contentUnchanged: true, metadataUnchanged: true, added: [], removed: [], changed: [] });
});
