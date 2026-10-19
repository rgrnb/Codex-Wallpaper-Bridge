import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, link, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { applicationTree, inspectSilentUnityApplication, removeSilentUnityApplication } from '../src/silent-unity-application.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-unity-audit-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cwb-unity-audit-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('a Sheep filename, AudioManager-shaped bytes and caller proof cannot inherit the reviewed profile', async t => {
  const root = await directory(t);
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'application', file: 'sheep.exe' }));
  await writeFile(path.join(root, 'sheep.exe'), 'unreviewed executable');
  await mkdir(path.join(root, 'sheep_Data'));
  await writeFile(path.join(root, 'sheep_Data', 'globalgamemanagers'), Buffer.alloc(48436));
  const source = { ...await describeSource(path.join(root, 'project.json')), audioSafety: { safe: true }, nativeMuteVerified: true };
  assert.equal((await inspectSilentUnityApplication(source)).safe, false);
});

test('the complete application audit accounts for every file and detects content changes', async t => {
  const root = await directory(t);
  await mkdir(path.join(root, 'subdirectory'));
  await writeFile(path.join(root, 'z'), 'last'); await writeFile(path.join(root, 'subdirectory', 'a'), 'first');
  const first = await applicationTree(root), repeated = await applicationTree(root);
  assert.equal(first.hash, repeated.hash); assert.equal(first.files.length, 2);
  await writeFile(path.join(root, 'subdirectory', 'a'), 'changed');
  assert.notEqual((await applicationTree(root)).hash, first.hash);
});

test('the source audit rejects directory junctions rather than blessing external content', async t => {
  const root = await directory(t), outside = await directory(t);
  await writeFile(path.join(outside, 'external'), 'must not be followed');
  await symlink(outside, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applicationTree(root), /APPLICATION_SOURCE_LINK_UNVERIFIED/);
});

test('application cleanup refuses an unowned directory before changing its files', async t => {
  const root = await directory(t), file = path.join(root, 'preserve'); await writeFile(file, 'original');
  await assert.rejects(removeSilentUnityApplication({ root, token: 'not-a-session' }), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(file, 'utf8'), 'original');
});

async function cleanupFixture(t) {
  const base = await directory(t), sourceRoot = path.join(base, 'projects', 'defaultprojects', 'sheep'), token = randomUUID();
  const root = path.join(base, '.bridge-application-runtime', token);
  await mkdir(path.join(sourceRoot, 'sheep_Data'), { recursive: true }); await mkdir(path.join(root, 'sheep_Data'), { recursive: true });
  const original = path.join(sourceRoot, 'sheep_Data', 'asset'), reference = path.join(root, 'sheep_Data', 'asset');
  await writeFile(original, 'original media'); await link(original, reference);
  const marker = { token, sourceRoot, sourceFile: path.join(sourceRoot, 'sheep.exe'), profile: 'unity-2017.2-reviewed-sheep',
    originalTree: 'e09a40b06aafadf8e5d9603a5ca0884ce953b1ad550724044ef3a52e3b414d4a', references: [{ relative: 'sheep_Data/asset', directory: false }] };
  const save = () => writeFile(path.join(root, '.bridge-application.json'), JSON.stringify(marker));
  await save();
  return { base, root, token, marker, original, reference, save };
}

test('cleanup validates every reference before unlinking any original asset', async t => {
  const f = await cleanupFixture(t);
  f.marker.references.push({ relative: 'sheep_Data/..', directory: true }); await f.save();
  await assert.rejects(removeSilentUnityApplication(f), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(f.reference, 'utf8'), 'original media'); assert.equal((await lstat(f.original)).nlink, 2);
});

test('cleanup rejects duplicate references and Windows path aliases', async t => {
  const f = await cleanupFixture(t);
  for (const relative of ['sheep_Data/ASSET', 'sheep_Data/.', 'sheep_Data/asset.', 'sheep_Data/asset ', 'sheep_Data/asset:stream']) {
    f.marker.references = [{ relative: 'sheep_Data/asset', directory: false }, { relative, directory: false }]; await f.save();
    await assert.rejects(removeSilentUnityApplication(f), /APPLICATION_CLEANUP_SCOPE_INVALID/);
    assert.equal(await readFile(f.reference, 'utf8'), 'original media');
  }
});

test('cleanup refuses an unregistered hardlink before recursive removal can change source attributes', async t => {
  const f = await cleanupFixture(t);
  await link(f.original, path.join(f.root, 'sheep.exe'));
  await assert.rejects(removeSilentUnityApplication(f), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal((await lstat(f.original)).nlink, 3); assert.equal(await readFile(f.original, 'utf8'), 'original media');
});

test('cleanup refuses a directory reference redirected outside the reviewed source', async t => {
  const f = await cleanupFixture(t), outside = await directory(t);
  await writeFile(path.join(outside, 'preserve'), 'outside data');
  await symlink(outside, path.join(f.root, 'sheep_Data', 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
  f.marker.references.push({ relative: 'sheep_Data/redirected', directory: true }); await f.save();
  await assert.rejects(removeSilentUnityApplication(f), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(path.join(outside, 'preserve'), 'utf8'), 'outside data');
  assert.equal(await readFile(f.reference, 'utf8'), 'original media');
});

test('cleanup refuses a junction used as the runtime root', async t => {
  const f = await cleanupFixture(t), alias = path.join(f.base, '.bridge-application-runtime', randomUUID());
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeSilentUnityApplication({ root: alias, token: path.basename(alias) }), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(f.reference, 'utf8'), 'original media');
});

test('driver diagnostics cannot smuggle outside junctions or original hardlinks into runtime cleanup', async t => {
  const f = await cleanupFixture(t), outside = await directory(t), driver = path.join(f.root, 'NVIDIA Corporation');
  await symlink(outside, driver, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeSilentUnityApplication(f), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(f.reference, 'utf8'), 'original media');
  const other = await cleanupFixture(t), logs = path.join(other.root, 'NVIDIA Corporation', 'umdlogs');
  await mkdir(logs, { recursive: true }); await link(other.original, path.join(logs, 'driver.log'));
  await assert.rejects(removeSilentUnityApplication(other), /APPLICATION_CLEANUP_SCOPE_INVALID/);
  assert.equal(await readFile(other.reference, 'utf8'), 'original media');
});
