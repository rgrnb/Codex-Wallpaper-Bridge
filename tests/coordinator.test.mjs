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
test('missing apps wait; presentation failure restores Codex with bounded backoff (AT-11/17)', async () => {
  const f = fixture(); f.app.codex = []; await f.c.tick(); assert.equal(f.c.state, 'WaitingForApps');
  const before = f.restoreCount();
  for (let i = 0; i < 7; i++) await f.c.fail(new Error('FRAME_CAPTURE_UNSUPPORTED'));
  assert.equal(f.c.state, 'Recovering'); assert.equal(f.c.retryAt, Infinity); assert.equal(f.restoreCount(), before + 7);
});
test('unknown required types use explicit fallback rather than successful video status (AT-04/26)', async () => {
  const f = fixture(); f.c.wallpaper.observe = async () => ({ source: { type: 'scene', fingerprint: 'scene' } });
  await f.c.tick(); assert.equal(f.c.state, 'Incompatible'); assert.match(f.c.code, /SCENE/);
  assert.equal(f.deferred.length, 0); assert.ok(f.restoreCount() > 0);
});

test('production video uses original native media rather than a re-encoded frame backend', async () => {
  const f = fixture();
  // A verified silent source used to enter WE capture while other videos used
  // direct decoding, making the same video much slower just because it is safe.
  f.c.nativeFingerprint = 'a'; f.c.nativeSafety = { safe: true };
  f.c.player = { async capture() { assert.fail('Silent video must use the original decoder too.'); }, async stop() {} };
  f.c.web = { async capture() { throw new Error('Video must not enter JPEG capture.'); }, async stop() {} };
  await f.c.tick(); assert.equal(f.deferred.length, 1); f.deferred.shift()(); await flush();
  assert.deepEqual(f.committed, ['a']); assert.equal(f.c.state, 'Active');
  assert.equal(f.c.backend, 'chromium-muted-video');
});

test('late shared-backend frames cannot reapply after user restore', async () => {
  const f = fixture(); let complete, delivered = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'web', fingerprint: 'web', resource: 'index.html' } });
  f.c.web = { capture() { return new Promise(resolve => { complete = resolve; }); }, async stop() {} };
  f.c.presentation.frame = async () => { delivered++; };
  await f.c.tick(); await f.c.restore(); complete({ jpeg: 'obsolete' }); await flush();
  assert.equal(delivered, 0); assert.equal(f.c.state, 'Disabled');
});

test('independent Scene never captures the desktop renderer, and failed mute validation restores Codex', async () => {
  const f = fixture(); let captures = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'scene', fingerprint: 'unverified-scene' } });
  f.app.wallpaperEngine.surfaces = [{ hwnd: '1', type: 'scene' }];
  f.c.player = { async capture() { captures++; }, async stop() {} };
  await f.c.tick(); await flush();
  assert.equal(f.c.state, 'Incompatible'); assert.equal(f.c.code, 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE');
  assert.equal(captures, 0); assert.equal(f.restoreCount(), 1);
});

test('a Scene on another volume waits for a changed selection without launching or retrying a renderer', async () => {
  const f = fixture(); let inspected = 0;
  f.c.wallpaper.observe = async () => ({ source: { type: 'scene', fingerprint: 'other-volume' } });
  f.c.player = { async inspect() { inspected++; return { safe: false, code: 'SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED' }; },
    async capture() { assert.fail('A refused Scene cannot allocate a renderer.'); }, async stop() {} };
  await f.c.tick(); assert.equal(f.c.state, 'Incompatible');
  assert.equal(f.c.code, 'SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED'); assert.equal(f.c.retryAt, Infinity);
  f.advance(); await f.c.tick(); assert.equal(inspected, 1); assert.equal(f.restoreCount(), 1);
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
  await f.c.tick(); await flush(); assert.equal(f.c.state, 'Incompatible'); assert.equal(f.restoreCount(), 1);
  f.advance(); await f.c.tick(); assert.equal(captures, 1);
});

test('Restore wins when detection, heartbeat, source observation or attach is already pending', async () => {
  for (const phase of ['probe', 'heartbeat', 'observe', 'configure', 'reconcile']) {
    const f = fixture(); let resume, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { resume = resolve; });
    let held = false, captures = 0, frames = 0;
    const hold = original => async (...args) => {
      if (!held) { held = true; entered(); await pending; }
      return original(...args);
    };
    if (phase === 'probe') f.c.probe = hold(f.c.probe);
    else if (phase === 'observe') f.c.wallpaper.observe = hold(f.c.wallpaper.observe);
    else f.c.presentation[phase] = hold(f.c.presentation[phase]);
    f.c.wallpaper.observe = ((original) => async (...args) => ({ ...await original(...args), source: { type: 'web', fingerprint: 'web' } }))(f.c.wallpaper.observe);
    f.c.web = { async capture() { captures++; return { jpeg: 'frame' }; }, async stop() {} };
    f.c.presentation.frame = async () => { frames++; };
    f.c.presentation.restore = async () => { f.c.presentation.windows.clear(); };
    const running = f.c.tick(); await reached;
    await f.c.restore(); resume(); await running; await flush();
    assert.equal(f.c.store.value.enabled, false, phase);
    assert.equal(f.c.state, 'Disabled', phase);
    assert.equal(f.c.presentation.windows.size, 0, phase);
    assert.equal(captures, 0, phase); assert.equal(frames, 0, phase);
  }
});

test('switching a native Video/Web source to a compatibility backend or empty selection closes the old player', async () => {
  for (const previousType of ['video', 'web']) {
    for (const clear of [false, true]) {
      const f = fixture(); let stopped = 0;
      f.c.source = { type: previousType, fingerprint: 'old-native-source', resource: 'old-resource' };
      f.c.player = { async stop() { stopped++; }, async capture() { assert.fail('New video is the compatibility fixture.'); } };
      f.c.web = { async stop() {} };
      if (clear) f.c.wallpaper.observe = async () => ({ source: null });
      await f.c.tick(); assert.equal(stopped, 1, `${previousType}, clear=${clear}`);
      assert.equal(f.restoreCount(), clear ? 1 : 0, 'An empty selection restores Codex; a valid replacement may transition.');
      if (!clear) { f.deferred.shift()(); await flush(); assert.equal(f.c.state, 'Active'); }
      else assert.equal(f.c.state, 'WaitingForApps');
    }
  }
});
