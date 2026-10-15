import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, HOST, nativeProbe, NativeFrames, startupRegistration, runFile } from './platform.mjs';
import { SettingsStore, atomicJson } from './config.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { WallpaperEngine } from './wallpaper-engine.mjs';
import { Presentation } from './presentation.mjs';
import { Coordinator } from './coordinator.mjs';
import { startControl } from './control.mjs';
import { UpdateManager } from './updates.mjs';
import { WebBackend } from './web-backend.mjs';
import { ProcessSampler } from './metrics.mjs';

if (process.argv.includes('--probe')) {
  const apps = await nativeProbe();
  const wallpaper = new WallpaperEngine({ username: os.userInfo().username });
  let source;
  try { source = await wallpaper.observe(apps.wallpaperEngine, { monitor: 0 }); }
  finally { wallpaper.close(); }
  console.log(JSON.stringify({ ...apps, wallpaper: source ? { running: source.running, sourceMethod: source.sourceMethod,
    id: source.source?.id, type: source.source?.type, bytes: source.source?.size } : null }, null, 2));
} else {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  const requestedData = process.env.BRIDGE_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexWallpaperBridge');
  await mkdir(requestedData, { recursive: true }); const data = await realpath(requestedData);
  const lockPath = path.join(data, 'instance.lock');
  async function acquire() {
    try { const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); return lock; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('INSTANCE_LOCK_INVALID');
      try { process.kill(pid, 0); throw new Error('BRIDGE_ALREADY_RUNNING'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await unlink(lockPath); return acquire();
    }
  }
  const lock = await acquire(), store = new SettingsStore(data), log = new Diagnostics(data);
  await store.load(); log.debug = store.value.debug;
  const initialApps = await nativeProbe();
  if (typeof initialApps.startupEnabled === 'boolean' && initialApps.startupEnabled !== store.value.startup)
    await store.save({ ...store.value, startup: initialApps.startupEnabled });
  const adapter = JSON.parse(await readFile(path.join(ROOT, 'config', 'adapter.json'), 'utf8'));
  const capabilities = JSON.parse(await readFile(path.join(ROOT, 'config', 'wallpaper-engine.json'), 'utf8'));
  const coordinator = new Coordinator({ settings: store, log, probe: nativeProbe, capabilities,
    wallpaper: new WallpaperEngine({ username: os.userInfo().username }),
    presentation: new Presentation(adapter, log), frames: new NativeFrames(), web: new WebBackend(), processSampler: new ProcessSampler() });
  coordinator.apps = initialApps; coordinator.lastProbe = Date.now();
  const version = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  coordinator.version = version;
  const bundledTrust = JSON.parse(await readFile(path.join(ROOT, 'config', 'updates.json'), 'utf8'));
  let trust = bundledTrust;
  try { const file = await readFile(path.join(data, 'update-trust.json'), 'utf8');
    if (file.length > 16384) throw new Error('TRUST_TOO_LARGE'); trust = { ...bundledTrust, ...JSON.parse(file) };
  } catch (error) { if (error.code !== 'ENOENT') await log.event('error', 'update', 'UPDATE_TRUST_INVALID'); }
  coordinator.updater = new UpdateManager(trust, data);
  const updateTimer = setInterval(() => { void coordinator.updater.check(version); }, 60000); updateTimer.unref();
  void coordinator.updater.check(version);
  const token = process.env.BRIDGE_CONTROL_TOKEN || randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('CONTROL_TOKEN_INVALID');
  let exiting = false, interval;
  async function exit() {
    if (exiting) return; exiting = true; clearInterval(interval); clearInterval(updateTimer);
    const hard = setTimeout(() => process.exit(1), 8000); hard.unref();
    await coordinator.stop(); server.close(); await lock.close(); await unlink(lockPath).catch(() => {});
    process.exit(0);
  }
  const server = await startControl({ token, coordinator, onExit: exit,
    onStartup: startupRegistration,
    onExport: () => log.export(path.join(data, 'diagnostics.json'), coordinator.snapshot()),
    onUpdateCheck: () => coordinator.updater.check(version, true),
    onUpdateInstall: async () => {
      try { await coordinator.updater.install(true, path.dirname(HOST)); }
      catch (error) {
        await coordinator.restore();
        await log.failure('update', 'UPDATE_PREPARATION_FAILED', error);
        throw error;
      }
    },
    onLaunch: async () => {
      const apps = await nativeProbe();
      if (apps.codex?.some(app => app.endpoints?.includes(store.value.cdpPort))) return;
      if (!apps.codexInstall) throw new Error('CODEX_INSTALL_NOT_FOUND');
      // Own profile; no authentication/config copies or provider changes.
      await runFile(HOST, ['--start-codex', apps.codexInstall, path.join(data, 'codex-profile'), String(store.value.cdpPort)],
        { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    },
  });
  process.on('SIGINT', exit); process.on('SIGTERM', exit);
  process.on('uncaughtException', async () => { await log.event('error', 'lifecycle', 'UNHANDLED_FAILURE'); await exit(); });
  process.on('unhandledRejection', async () => { await log.event('error', 'lifecycle', 'UNHANDLED_FAILURE'); await exit(); });
  interval = setInterval(() => {
    if (process.env.BRIDGE_PARENT_PID) {
      try { process.kill(Number(process.env.BRIDGE_PARENT_PID), 0); } catch { void exit(); return; }
    }
    void coordinator.tick();
  }, 50);
  // The capability token is never sent to stdout or persisted. Native host provides it via environment.
  console.log(JSON.stringify({ ready: true, port: server.address().port, version }));
  if (!process.env.BRIDGE_CONTROL_TOKEN) console.error('Headless mode: use the native tray application for settings.');
  await log.event('info', 'lifecycle', 'STARTED', { version });
  await coordinator.tick();
  const nonce = process.env.BRIDGE_UPDATE_NONCE;
  if (nonce && /^[a-f0-9]{32}$/.test(nonce)) {
    const health = () => {
      if (['Recovering', 'Incompatible', 'Stopped'].includes(coordinator.state)) return false;
      return !store.value.enabled || coordinator.state === 'Active' || coordinator.state === 'WaitingForApps';
    };
    for (let attempt = 0; attempt < 60 && !health(); attempt++) await new Promise(r => setTimeout(r, 500));
    await atomicJson(path.join(data, 'updates', `health-${nonce}.json`), { nonce, version, healthy: health(), controlPort: server.address().port });
  }
}
