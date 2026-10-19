import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, link, unlink, rename, lstat, utimes, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SourceWatch, projectMetadata } from '../src/source-watch.mjs';
import { WallpaperEngine, describeSource } from '../src/wallpaper-engine.mjs';
import { stagePrivateScene, removePrivateScene } from '../src/private-scene.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Expected watcher notification'); await pause(20); }
}
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cwb-source-watch-')), root = path.join(base, 'source');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{"type":"scene","file":"scene.json"}');
  await writeFile(path.join(root, 'scene.json'), '{"objects":[]}');
  await writeFile(path.join(root, 'nested', 'asset.txt'), 'original asset');
  return { base, root, selectedWallpaper: path.join(root, 'project.json') };
}
function fakeWatcher() {
  const handlers = [];
  return { handlers, watchRoot: (_root, _options, notify) => {
    const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; };
    handlers.push({ notify, watcher }); return watcher;
  } };
}

test('metadata ignores hardlink churn but detects same-size/time atomic replacement and never follows junctions', async t => {
  const f = await fixture(t), file = path.join(f.root, 'nested', 'asset.txt'), alias = path.join(f.base, 'asset-link');
  const baseline = await projectMetadata(f.root);
  await link(file, alias); assert.equal(await projectMetadata(f.root), baseline);
  await unlink(alias); assert.equal(await projectMetadata(f.root), baseline);
  const old = await lstat(file), replacement = path.join(f.base, 'replacement');
  await writeFile(replacement, 'replaced asset'); await utimes(replacement, old.atime, old.mtime);
  await rename(replacement, file); assert.notEqual(await projectMetadata(f.root), baseline);
  const outside = path.join(f.base, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await projectMetadata(f.root); await writeFile(path.join(outside, 'private'), 'not a project resource');
  assert.equal(await projectMetadata(f.root), before);
  await assert.rejects(projectMetadata(f.root, { limit: 2 }), /METADATA_TOO_LARGE/);
});

test('real recursive watch keeps staged/unlinked Scene fingerprints stable and detects nested edits, additions, removal and replacement', async t => {
  const f = await fixture(t), observer = new WallpaperEngine(); t.after(() => observer.close());
  const installed = path.join(f.base, 'engine'); await mkdir(installed);
  const first = (await observer.observe(null, f)).source;
  assert.equal(observer.watcher.baseline, await projectMetadata(f.root));
  const view = await stagePrivateScene(first, { installed });
  try {
    await pause(250);
    const staged = (await observer.observe(null, f)).source;
    assert.equal(staged.fingerprint, first.fingerprint); assert.equal(observer.resourceRevision, 0);
  } finally { await removePrivateScene(view); }
  await pause(250);
  assert.equal((await observer.observe(null, f)).source.fingerprint, first.fingerprint);
  assert.equal(observer.resourceRevision, 0);
  const asset = path.join(f.root, 'nested', 'asset.txt'), added = path.join(f.root, 'nested', 'added.txt');
  let previous = first.fingerprint;
  for (const mutate of [() => writeFile(asset, 'edited material'), () => writeFile(added, 'new material'), () => unlink(added),
    async () => { const file = path.join(f.base, 'replacement'); await writeFile(file, 'atomic material'); await rename(file, asset); }]) {
    const revision = observer.resourceRevision; await mutate(); await until(() => observer.resourceRevision > revision);
    const next = (await observer.observe(null, f)).source.fingerprint;
    assert.notEqual(next, previous); previous = next; assert.equal(observer.dirty, false);
  }
});

test('notifications are coalesced and unchanged polling does not walk the project tree', async t => {
  const f = await fixture(t), fake = fakeWatcher(); let scans = 0;
  const observer = new WallpaperEngine({ watchOptions: { ...fake, snapshot: async root => { scans++; return projectMetadata(root); } } });
  t.after(() => observer.close()); await observer.observe(null, f);
  for (let i = 0; i < 6; i++) await observer.observe(null, f);
  assert.equal(scans, 1);
  for (let i = 0; i < 30; i++) fake.handlers[0].notify();
  await until(() => scans > 1); await pause(30);
  assert.equal(scans, 2); assert.equal(observer.resourceRevision, 0);
});

test('baseline completes before exposing a stageable source', async t => {
  const f = await fixture(t), blocked = gate(), entered = gate(); let completed = false;
  const observer = new WallpaperEngine({ watchOptions: { ...fakeWatcher(), snapshot: async root => { entered.release(); await blocked.promise; return projectMetadata(root); } } });
  t.after(() => observer.close());
  const pending = observer.observe(null, f).then(value => { completed = true; return value; });
  await entered.promise; assert.equal(completed, false); blocked.release(); assert.ok((await pending).source);
});

test('event during describe I/O remains dirty and the next observation sees the new nested resource revision', async t => {
  const f = await fixture(t), fake = fakeWatcher(), blocked = gate(), entered = gate(); let hold = false;
  const observer = new WallpaperEngine({ watchOptions: fake, describe: async (...args) => {
    const result = await describeSource(...args);
    if (hold) { hold = false; entered.release(); await blocked.promise; }
    return result;
  } }); t.after(() => observer.close());
  const first = (await observer.observe(null, f)).source;
  // Hold the final read, after the revision/dirty generation has been captured.
  let calls = 0; const original = observer.describe;
  observer.describe = (...args) => { if (++calls === 2) hold = true; return original(...args); };
  const pending = observer.observe(null, f); await entered.promise;
  await writeFile(path.join(f.root, 'nested', 'asset.txt'), 'changed while observing'); fake.handlers[0].notify();
  await observer.watcher.refresh(); blocked.release(); await pending;
  assert.equal(observer.dirty, true);
  const next = await observer.observe(null, f); assert.notEqual(next.source.fingerprint, first.fingerprint); assert.equal(observer.dirty, false);
});

test('event during a metadata scan is not acknowledged by the older snapshot', async t => {
  const f = await fixture(t), fake = fakeWatcher(), blocked = gate(), entered = gate(); let hold = false, changes = 0;
  const watcher = new SourceWatch(f.root, { ...fake, changed: () => changes++, snapshot: async root => {
    const snapshot = await projectMetadata(root); if (hold) { hold = false; entered.release(); await blocked.promise; } return snapshot;
  } }); t.after(() => watcher.close()); await watcher.ready();
  hold = true; fake.handlers[0].notify(); const pending = watcher.refresh(); await entered.promise;
  await writeFile(path.join(f.root, 'nested', 'asset.txt'), 'changed during scan'); fake.handlers[0].notify();
  blocked.release(); await pending; assert.equal(watcher.pending, true);
  await watcher.ready(); assert.equal(changes, 1); assert.equal(watcher.pending, false);
});

test('late events and in-flight scans from a replaced or closed source cannot mutate current state', async t => {
  const a = await fixture(t), b = await fixture(t), fake = fakeWatcher(), blocked = gate(), entered = gate(); let hold = false;
  const observer = new WallpaperEngine({ watchOptions: { ...fake, snapshot: async root => {
    const next = await projectMetadata(root); if (hold) { hold = false; entered.release(); await blocked.promise; } return next;
  } } }); t.after(() => observer.close());
  await observer.observe(null, a); const old = observer.watcher;
  await writeFile(path.join(a.root, 'nested', 'asset.txt'), 'late original'); hold = true;
  const pending = old.refresh(); await entered.promise;
  await observer.observe(null, b); const revision = observer.resourceRevision;
  blocked.release(); await pending; fake.handlers[0].notify();
  assert.equal(observer.resourceRevision, revision); assert.equal(observer.dirty, false);
  observer.close(); fake.handlers[1].notify(); fake.handlers[1].watcher.emit('error', new Error('late error'));
  assert.equal(observer.resourceRevision, revision); assert.equal(observer.dirty, false);
});

test('watch failures and asynchronous scan failures retain bounded polling and dirty state without unhandled rejections', async t => {
  const f = await fixture(t), fake = fakeWatcher(); let now = 0, fail = false;
  const observer = new WallpaperEngine({ clock: () => now, watchOptions: { ...fake, snapshot: root => {
    if (fail) throw new Error('transient-metadata-failure'); return projectMetadata(root);
  } } }); t.after(() => observer.close()); const first = await observer.observe(null, f);
  fail = true; fake.handlers[0].notify(); await pause(150); assert.equal(observer.dirty, true);
  await assert.rejects(observer.observe(null, f), /transient-metadata-failure/);
  fail = false; await observer.observe(null, f); assert.equal(observer.dirty, false);
  fake.handlers[0].watcher.emit('error', new Error('watch unavailable')); await observer.observe(null, f);
  await writeFile(path.join(f.root, 'nested', 'asset.txt'), 'polling fallback'); now += 3001;
  assert.notEqual((await observer.observe(null, f)).source.fingerprint, first.source.fingerprint);
  assert.equal(await readFile(path.join(f.root, 'nested', 'asset.txt'), 'utf8'), 'polling fallback');
});
