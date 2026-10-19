import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { projectServer, WebBackend } from '../src/web-backend.mjs';
import { SettingsStore } from '../src/config.mjs';
import { propertiesFromConfig, WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { UpdateManager } from '../src/updates.mjs';

test('Web source server confines files and ranges to one capability and project root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-test-')), project = path.join(root, 'project');
  await mkdir(project); await writeFile(path.join(project, 'index.html'), 'abcdef'); await writeFile(path.join(root, 'private.txt'), 'outside-root');
  const host = await projectServer(project, path.join(project, 'index.html'));
  try {
    const head = await fetch(host.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal(await (await fetch(host.url, { headers: { Range: 'bytes=1-3' } })).text(), 'bcd');
    assert.equal((await fetch(host.url, { headers: { Range: 'bytes=100-200' } })).status, 416);
    assert.equal((await fetch(host.url.replace(/\/[^/]+$/, '/%2e%2e%2fprivate.txt'))).status, 404);
    assert.equal((await fetch(new URL('/index.html', host.url))).status, 404);
    assert.equal((await fetch(host.url, { method: 'POST' })).status, 404);
    await symlink(root, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(host.url.replace(/\/[^/]+$/, '/escape/private.txt'))).status, 404);
  } finally { host.server.closeAllConnections(); await new Promise(r => host.server.close(r)); }
});
test('fresh settings are persisted and corrupted state recovers disabled from the prior valid state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-recovery-test-')), store = new SettingsStore(root);
  await store.load(); assert.equal(JSON.parse(await readFile(store.file, 'utf8')).enabled, false);
  await store.save({ ...store.value, enabled: true, effects: { ...store.value.effects, opacity: 0.73 } });
  await store.save({ ...store.value, fpsLimit: 30 });
  await writeFile(store.file, '{broken'); const recovered = new SettingsStore(root); await recovered.load();
  assert.equal(recovered.recovered, true); assert.equal(recovered.value.enabled, false); assert.equal(recovered.value.effects.opacity, 0.73);
});
test('current wallpaper property lookup is scoped to profile, exact resource and source monitor', () => {
  const config = { owner: { general: { wallpaperconfig: { selectedwallpapers: {} } },
    wproperties: { 'D:/wallpapers/a/index.html': { Monitor0: { rate: 2, enabled: true, apiKey: 'never-forwarded', access_token: 'never-forwarded', invalid: { secret: 'not-forwarded' } }, Monitor1: { rate: 5 } } } } };
  assert.deepEqual(propertiesFromConfig(config, 'd:\\wallpapers\\a\\index.html', 1, 'OWNER'), { rate: 5 });
  assert.deepEqual(propertiesFromConfig(config, 'd:/wallpapers/a/index.html', 0, 'owner'), { rate: 2, enabled: true });
  assert.deepEqual(propertiesFromConfig(config, 'd:/wallpapers/b/index.html', 0, 'owner'), {});
});
test('a signed current-version feed reports up-to-date without offering a downgrade', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-feed-test-')), keys = generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ schemaVersion: 1, version: '0.1.0', bytes: 10, sha256: 'a'.repeat(64), url: 'https://releases.test/archive.zip',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  const manifest = JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') });
  const manager = new UpdateManager({ manifestUrl: 'https://releases.test/manifest.json', publicKeyPem: keys.publicKey, maxArchiveBytes: 1024, checkIntervalHours: 24 }, root,
    { fetcher: async () => new Response(manifest) });
  await manager.check('0.1.0'); assert.equal(manager.status, 'UpToDate'); assert.equal(manager.candidate, null);
  await manager.check('0.2.0', true); assert.equal(manager.status, 'UpToDate'); await assert.rejects(manager.stage(true), /CONFIRMATION/);
});

test('WE CLI failure backs off without becoming permanent after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-cli-recovery-')), project = path.join(root, 'project');
  await mkdir(project); const resource = path.join(project, 'clip.mp4'); await writeFile(resource, 'authored');
  await writeFile(path.join(project, 'project.json'), JSON.stringify({ type: 'video', file: 'clip.mp4' }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ owner: { general: { wallpaperconfig: {
    selectedwallpapers: { Monitor0: { file: resource } } } } } }));
  let calls = 0, fail = true, now = 1000;
  const observer = new WallpaperEngine({ username: 'owner', clock: () => now, query: async () => {
    calls++; if (fail) throw new Error('WE_QUERY_TIMEOUT'); return resource;
  } });
  const app = { running: true, path: path.join(root, 'wallpaper64.exe'), pid: 1 };
  try {
    assert.equal((await observer.observeDesktop(app, { monitor: 0 })).sourceMethod, 'config-fallback');
    now += 1000; fail = false; await observer.observeDesktop(app, { monitor: 0 }); assert.equal(calls, 1);
    now += 30000; assert.equal((await observer.observeDesktop(app, { monitor: 0 })).sourceMethod, 'cli'); assert.equal(calls, 2);
    fail = true; await observer.observeDesktop(app, { monitor: 0 }); fail = false;
    assert.equal((await observer.observeDesktop({ ...app, pid: 2 }, { monitor: 0 })).sourceMethod, 'cli'); assert.equal(calls, 4);
  } finally { observer.close(); }
});

test('a project-controlled failure value cannot escape into diagnostic error messages', async () => {
  const web = new WebBackend(); web.current='fixture'; web.configure=async()=>{};web.stop=async()=>{};
  web.pipe={async call(){return {result:{value:{ready:'complete',unsupported:'PRIVATE_PROJECT_VALUE'}}};}};
  await assert.rejects(web.capture({fingerprint:'fixture'},{}),error=>error.message==='WEB_PROJECT_INTERFACE_UNSUPPORTED');
});
