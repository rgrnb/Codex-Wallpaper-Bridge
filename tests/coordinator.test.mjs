import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator.mjs';
import { validateSettings } from '../src/config.mjs';
function fixture() {
  let now = 100000, source = { id: 'a', type: 'video', fingerprint: 'a', resource: 'clip.mp4' };
  const app = { codex: [{ version: '26.1007.1', endpoints: [9336] }], wallpaperEngine: { running: true } };
  let restoreCount = 0; const committed = [], deferred = [];
  const window = { generation: -1, visible: true };
  const presentation = { adapter: {}, windows: new Map([['one', window]]), visibleCount: 1,
    async invalidate() {}, async configure() {}, async heartbeat() {}, async reconcile() {},
    async restore() { restoreCount++; },
    video(source, generation, current) { return new Promise(resolve => deferred.push(() => {
      if (current()) { committed.push(source.id); window.generation = generation; resolve(true); } else resolve(false);
    })); },
  };
  const c = new Coordinator({ settings: { value: validateSettings({ enabled: true }), async save(s) { this.value = validateSettings(s); } },
    wallpaper: { dirty: false, async observe() { return { source, sourceMethod: 'fixture' }; }, close() {} },
    presentation, frames: { stop() {} }, probe: async () => app,
    log: { event: async () => {} }, clock: () => now });
  return { c, deferred, committed, app, restoreCount: () => restoreCount,
    advance: () => { now += 6000; }, select: id => { source = { ...source, id, fingerprint: id }; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('rapid A/B/C changes never commit stale asynchronous loads (AT-07)', async () => {
  const f = fixture(); await f.c.tick();
  f.select('b'); f.advance(); await f.c.tick();
  f.select('c'); f.advance(); await f.c.tick();
  f.deferred.shift()(); await flush(); assert.deepEqual(f.committed, []);
  await f.c.tick(); f.deferred.shift()(); await flush(); assert.deepEqual(f.committed, ['c']); assert.equal(f.c.state, 'Active');
});
test('user disable survives reconnect and cancels pending presentation (AT-17/18)', async () => {
  const f = fixture(); await f.c.tick(); await f.c.applySettings({ ...f.c.store.value, enabled: false });
  f.deferred.shift()(); await flush(); f.advance(); await f.c.tick();
  assert.deepEqual(f.committed, []); assert.equal(f.c.state, 'Disabled'); assert.ok(f.restoreCount() > 0);
});
test('missing apps wait; presentation failure restores with bounded backoff (AT-11/17)', async () => {
  const f = fixture(); f.app.codex = []; await f.c.tick(); assert.equal(f.c.state, 'WaitingForApps');
  const before = f.restoreCount();
  for (let i = 0; i < 7; i++) await f.c.fail(new Error('FRAME_CAPTURE_UNSUPPORTED'));
  assert.equal(f.c.state, 'Recovering'); assert.equal(f.c.retryAt, Infinity); assert.equal(f.restoreCount() - before, 7);
});
test('unknown required types use explicit fallback rather than successful video status (AT-04/26)', async () => {
  const f = fixture(); f.c.wallpaper.observe = async () => ({ source: { type: 'scene', fingerprint: 'scene' } });
  await f.c.tick(); assert.equal(f.c.state, 'Incompatible'); assert.match(f.c.code, /SCENE/);
  assert.equal(f.deferred.length, 0); assert.ok(f.restoreCount() > 0);
});

test('production video uses original native media rather than a re-encoded frame backend', async () => {
  const f = fixture();
  f.c.web = { async capture() { throw new Error('Video must not enter JPEG capture.'); }, async stop() {} };
  await f.c.tick(); assert.equal(f.deferred.length, 1); f.deferred.shift()(); await flush();
  assert.deepEqual(f.committed, ['a']); assert.equal(f.c.state, 'Active');
});

test('late shared-backend frames cannot reapply after user restore', async () => {
  const f = fixture(); let complete, delivered = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'web', fingerprint: 'web', resource: 'index.html' } });
  f.c.web = { capture() { return new Promise(resolve => { complete = resolve; }); }, async stop() {} };
  f.c.presentation.frame = async () => { delivered++; };
  await f.c.tick(); await f.c.restore(); complete({ jpeg: 'obsolete' }); await flush();
  assert.equal(delivered, 0); assert.equal(f.c.state, 'Disabled');
});

test('a Scene source that precedes its renderer waits and attaches after native discovery', async () => {
  const f = fixture(); let delivered = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'scene', fingerprint: 'scene' } });
  f.c.capabilities = { automaticSceneVersions: ['2.8.0.42'], sceneWindowClass: 'WPEDesktopDX11Window' };
  f.app.wallpaperEngine.version = '2.8.0.42'; f.app.wallpaperEngine.surfaces = [];
  f.c.frames.capture = async () => ({ jpeg: 'authored', sequence: 1 });
  f.c.presentation.frame = async () => { delivered++; };
  await f.c.tick(); assert.equal(f.c.state, 'LoadingWallpaper'); assert.equal(f.restoreCount(), 0);
  f.app.wallpaperEngine.surfaces = [{ hwnd: '1', pid: 42, type: 'scene', className: 'WPEDesktopDX11Window' }];
  f.advance(); await f.c.tick(); await flush();
  assert.equal(f.c.state, 'Active'); assert.equal(f.c.code, 'SCENE_EXISTING_RENDERER'); assert.equal(delivered, 1);
});

test('leaving Web or a native renderer releases its backend while the old canvas can remain for transition', async () => {
  for (const previous of ['web', 'scene', 'application']) {
    const f = fixture(); let released = 0;
    f.c.source = { type: previous, fingerprint: previous, resource: 'previous-source' };
    if (previous === 'web') f.c.web = { async stop() { released++; } };
    else f.c.frames.stop = () => { released++; };
    await f.c.tick(); assert.equal(released, 1); assert.equal(f.restoreCount(), 0);
    f.deferred.shift()(); await flush(); assert.equal(f.c.state, 'Active');
  }
});

test('all-hidden video windows defer decoding and resume with the newest source', async () => {
  const f = fixture(); f.c.presentation.visibleCount = 0;
  await f.c.tick(); assert.equal(f.c.state, 'Paused'); assert.equal(f.deferred.length, 0);
  f.select('newest'); f.advance(); await f.c.tick(); assert.equal(f.deferred.length, 0);
  f.c.presentation.visibleCount = 1; f.advance(); await f.c.tick(); f.deferred.shift()(); await flush();
  assert.deepEqual(f.committed, ['newest']); assert.equal(f.c.state, 'Active');
});

test('an unsupported Web interface waits for changed compatibility instead of retrying the same project', async () => {
  const f = fixture(); let captures = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'web', fingerprint: 'web', resource: 'index.html' } });
  f.c.web = { async capture() { captures++; throw new Error('WEB_AUDIO_VISUALIZER_UNAVAILABLE'); }, async stop() {} };
  await f.c.tick(); await flush(); assert.equal(f.c.state, 'Incompatible'); assert.ok(f.restoreCount() > 0);
  f.advance(); await f.c.tick(); assert.equal(captures, 1);
});
