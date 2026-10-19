import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, validateSettings, effectivePolicy, SettingsStore } from '../src/config.mjs';
import { selectedFromConfig, describeSource, WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { sanitize, Diagnostics } from '../src/diagnostics.mjs';
import { validateTarget } from '../src/cdp.mjs';
import { startControl } from '../src/control.mjs';

test('settings reject corrupted/unknown input and preserve source when effects change (AT-14)', () => {
  assert.equal(validateSettings({}).enabled, false); assert.equal(validateSettings({}).startup, false);
  for (const input of [{ fpsLimit: 121 }, { enabled: 1 }, { effects: { blur: -1 } }, { effects: { opacity: NaN } },
    { performance: 'constructor' }, { schemaVersion: 2 }, { execute: 'anything' }, { effects: { extra: 1 } },
    { effects: [] }, JSON.parse('{"__proto__":{}}')])
    assert.throws(() => validateSettings(input));
  const next = validateSettings({ effects: { opacity: 0.7 } }); assert.equal(next.monitor, 0); assert.equal(next.effects.blur, 0);
});
test('all three profiles cap output, aggregate windows, pause and resume (AT-13/29)', () => {
  const performance = effectivePolicy(validateSettings({ performance: 'performance' }), 1);
  const quality = effectivePolicy(validateSettings({ performance: 'quality', fpsLimit: 60 }), 1);
  assert.equal(performance.fps, 30); assert.equal(quality.fps, 60);
  assert.equal(effectivePolicy(validateSettings({}), 0).paused, true);
  assert.equal(effectivePolicy(validateSettings({}), 4).fps, 60);
  assert.equal(effectivePolicy(validateSettings({}), 1, true).autoAdjusted, true);
  const original = effectivePolicy(validateSettings({}), 1), adjusted = effectivePolicy(validateSettings({}), 4, true);
  for (const key of ['maxWidth', 'jpegQuality', 'pixelBudget']) assert.equal(adjusted[key], original[key], 'Automatic load adjustment must preserve visual quality.');
});

test('independent profiles and 120/automatic ceilings persist without changing source or desktop settings', async () => {
  const s = validateSettings({ fpsLimit: 120, wallpaperProfiles: { fixture: { display: { zoom: 2, positionX: 0.2, positionY: 0.8 }, properties: { speed: 1.5 } } } });
  assert.equal(effectivePolicy(s, 2).fps, 120);
  assert.equal(effectivePolicy({ ...s, fpsLimit: 0 }, 2, false, 144).fps, 120);
  assert.equal(effectivePolicy({ ...s, fpsLimit: 0 }, 2, true, 60).fps, 30);
  for (const wallpaperProfiles of [{ fixture: { display: { zoom: 0.9 } } }, { fixture: { display: { positionX: 1.1 } } },
    JSON.parse('{"__proto__":{"properties":{}}}'), { fixture: { properties: { speed: {} } } }])
    assert.throws(() => validateSettings({ wallpaperProfiles }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-independent-'));
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'video', file: 'clip.mp4' }));
  await writeFile(path.join(root, 'clip.mp4'), 'authored fixture');
  let queries = 0;
  const observer = new WallpaperEngine({ query: async () => { queries++; throw new Error('Desktop must never be queried'); } });
  try {
    assert.equal((await observer.observe({ running: true }, validateSettings({}))).source, null);
    const settings = validateSettings({ selectedWallpaper: path.join(root, 'project.json') });
    const first = await observer.observe(null, settings);
    const second = await observer.observe({ running: true, pid: 99 }, { ...settings, monitor: 9 });
    assert.equal(first.sourceMethod, 'independent-library'); assert.equal(first.source.fingerprint, second.source.fingerprint);
    assert.equal(queries, 0);
    const store = new SettingsStore(path.join(root, 'settings')); await store.load(); await store.save({ ...s, selectedWallpaper: settings.selectedWallpaper });
    assert.deepEqual((await new SettingsStore(path.join(root, 'settings')).load()).wallpaperProfiles, s.wallpaperProfiles);
  } finally { observer.close(); }
});
test('atomic settings persist and leave an earlier valid backup (AT-14)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-settings-')), store = new SettingsStore(root);
  await store.load(); await store.save({ ...store.value, effects: { ...store.value.effects, contrast: 1.4 } });
  assert.equal((await new SettingsStore(root).load()).effects.contrast, 1.4);
  assert.equal(JSON.parse(await readFile(`${store.file}.previous`, 'utf8')).effects.contrast, 1);
  assert.equal((await readdir(root)).filter(x => x.endsWith('.tmp')).length, 0);
});
test('WE current monitor selection does not walk history or guess ambiguous profiles (AT-05)', () => {
  const config = { user: { general: { wallpaperconfig: { selectedwallpapers: { Monitor0: { file: 'C:/project/current.mp4' }, Monitor1: { file: 'C:/project/other.mp4' } } } } } };
  assert.equal(selectedFromConfig(config, 0), 'C:/project/current.mp4');
  assert.equal(selectedFromConfig(config, 1), 'C:/project/other.mp4');
  assert.throws(() => selectedFromConfig({ ...config, another: config.user }, 0), /AMBIGUOUS/);
  assert.equal(selectedFromConfig({ ...config, another: config.user }, 0, 'USER'), 'C:/project/current.mp4');
});
test('source metadata/resource changes produce new identity; traversal is rejected (AT-06/10)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-wallpaper-'));
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'video', file: 'clip.mp4' }));
  await writeFile(path.join(root, 'clip.mp4'), Buffer.from('synthetic-fixture'));
  const a = await describeSource(path.join(root, 'clip.mp4')), b = await describeSource(path.join(root, 'clip.mp4'), 1);
  assert.notEqual(a.fingerprint, b.fingerprint); assert.equal(a.type, 'video');
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file: '../outside.html' }));
  await assert.rejects(describeSource(path.join(root, 'clip.mp4')));
});
test('CDP only admits exact local app pages and same-port sockets (AT-23/26)', () => {
  const good = { type: 'page', id: 'abc123', url: 'app://-/index.html#/task', webSocketDebuggerUrl: 'ws://127.0.0.1:9336/devtools/page/abc123' };
  assert.equal(validateTarget(good, 9336), true);
  for (const patch of [{ url: 'https://example.com' }, { url: 'app://-/browser.html' },
    { webSocketDebuggerUrl: 'ws://192.168.1.2:9336/devtools/page/abc123' },
    { webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/abc123' }, { id: '../evil' }])
    assert.equal(validateTarget({ ...good, ...patch }, 9336), false);
});
test('logs allow operational fields only and rotate within bounds (AT-22/23)', async () => {
  assert.deepEqual(sanitize({ chat: 'private', token: 'sk-private', code: 'C:\\Users\\someone\\private.txt', fps: 15 }), { code: '<path>', fps: 15 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-logs-')); let now = 0;
  const logs = new Diagnostics(root, { maxBytes: 450, retained: 2, clock: () => ++now });
  for (let i = 0; i < 20; i++) await logs.event('info', 'test', `EVENT_${i}`, { generation: i, chat: 'secret fixture' });
  const names = await readdir(path.join(root, 'logs')); assert.ok(names.length <= 3);
  const exported = path.join(root, 'diagnostics.json'); await logs.export(exported, { state: 'Active', resource: 'private path' });
  const text = await readFile(exported, 'utf8'); assert.ok(!text.includes('secret fixture')); assert.ok(!text.includes('private path'));
  await logs.event('error', 'test', 'STABLE_EVENT', { code: 'CONTEXT_REASON' });
  const row = JSON.parse((await readFile(path.join(root, 'logs', 'bridge.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(row.eventCode, 'STABLE_EVENT'); assert.equal(row.code, 'CONTEXT_REASON');
});
test('control rejects unauthenticated requests and browser origins (AT-24/security)', async t => {
  const token = 'a'.repeat(64), coordinator = { snapshot: () => ({ state: 'Disabled' }) };
  const server = await startControl({ token, coordinator }); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/status`)).status, 403);
  assert.equal((await fetch(`${base}/status`, { headers: { 'X-Bridge-Token': token, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${base}/status`, { headers: { 'X-Bridge-Token': token } })).status, 200);
});

test('wallpaper mutations cannot race an installing update', async t => {
  const token = 'b'.repeat(64); let actions = 0;
  const server = await startControl({ token, coordinator: { updater: { status: 'Installing' } },
    onSelect: async () => { actions++; }, onPreview: async () => { actions++; }, onWallpaperConfigure: async () => { actions++; } });
  t.after(() => server.close());
  for (const route of ['select', 'preview', 'configure']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/wallpaper/${route}`, { method: 'POST',
      headers: { 'X-Bridge-Token': token, 'Content-Type': 'application/json' }, body: '{"id":"fixture"}' });
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'UPDATE_IN_PROGRESS');
  }
  assert.equal(actions, 0);
});
