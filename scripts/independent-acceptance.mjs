import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, nativeProbe, runFile, NativeFrames } from '../src/platform.mjs';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { SettingsStore, effectivePolicy } from '../src/config.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { IsolatedPlayer, stagePrivateEngine } from '../src/isolated-player.mjs';
import { IndependentApplicationPlayer, PowerShellApplicationAdapter } from '../src/independent-application.mjs';
import { Presentation } from '../src/presentation.mjs';
import { WebBackend } from '../src/web-backend.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { ProcessSampler } from '../src/metrics.mjs';
import { WallpaperLibrary } from '../src/library.mjs';
import { verifyIndependentEndurance } from './independent-endurance.mjs';
import { verifyWindowCoverage } from './window-coverage.mjs';
import { measureHelperInterval, runtimeCleanupEvidence, cleanupProcessLedger } from './independent-evidence.mjs';
import { sourceSnapshot, snapshotSummary, compareSnapshots } from './library-playback-acceptance.mjs';

// Acceptance uses new, empty official profiles and an exact PID/port allowlist.
// It never attaches to the user's Bridge-managed 9336 window or changes a
// desktop wallpaper, WE global setting, or official application file.
const ports = [19344, 19346], children = [], clients = [], events = [], ownedWindows = [], ownedProcesses = [];
const acceptedTargets = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const enduranceSeconds = Number(process.env.BRIDGE_ACCEPTANCE_SECONDS || 0);
assert.ok(enduranceSeconds === 0 || (Number.isInteger(enduranceSeconds) && enduranceSeconds >= 120 && enduranceSeconds <= 3600), 'BRIDGE_ACCEPTANCE_SECONDS must be an integer from 120 to 3600.');
// A live all-window controller would also attach to these newly spawned ports.
// Refuse that collision; the explicit environment wrapper restores the running
// user's Bridge after stopping it for isolation during this test.
try {
  const livePid = Number(await readFile(path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge', 'instance.lock'), 'utf8'));
  if (!Number.isInteger(livePid) || livePid < 1) throw new Error('LIVE_BRIDGE_LOCK_INVALID');
  try { process.kill(livePid, 0); throw new Error('LIVE_BRIDGE_MUST_BE_STOPPED_FOR_ISOLATION'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const before = await nativeProbe();
assert.ok(before.codexInstall && before.wallpaperEngine?.running, 'Installed Codex and running WE are required.');
for (const port of ports) {
  assert.ok(!before.codex.some(app => app.endpoints.includes(port)), 'Acceptance port is already owned.');
  await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
const evidence = path.join(ROOT, '.local-evidence', `independent-acceptance-${randomBytes(8).toString('hex')}`);
await mkdir(evidence);
const adapter = JSON.parse(await readFile(path.join(ROOT, 'config/adapter.json'), 'utf8'));
const config = path.join(path.dirname(before.wallpaperEngine.path), 'config.json');
const desktop = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v?.general?.wallpaperconfig).map(([key, value]) => [key,
  { selection: value.general.wallpaperconfig.selectedwallpapers, audio: value.general.videoaudiooutput,
    properties: Object.fromEntries(Object.entries(value.wproperties || {}).map(([file, locations]) => [file, Object.fromEntries(Object.entries(locations).filter(([location]) => /^Monitor\d+$/.test(location)))]).filter(([, values]) => Object.keys(values).length)) }]));
const originalDesktop = desktop(JSON.parse(await readFile(config, 'utf8')));
const report = { started: new Date().toISOString(), windows: 2, versions: [], sourceResults: [], performance: [], events,
  existingUserWindowAccessed: false, messagesSent: false, sourcePixelsSaved: false, completePrdAccepted: false, limitations: [] };
const log = { debug: false, async event(_level, _module, code, data = {}) { if (code === 'STATE_CHANGED' || code === 'PROJECT_UNSUPPORTED') events.push({ code, ...data }); }, async failure() {} };
const presentation = new Presentation(adapter, log, { discover: async port => { assert.ok(ports.includes(port)); const targets = await listTargets(port); return acceptedTargets.has(port) ? targets.filter(target => target.id === acceptedTargets.get(port)) : targets; },
  connect: async target => { assert.ok(ports.includes(Number(new URL(target.webSocketDebuggerUrl).port))); return new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect(); } });
const helperPids = new Set(), ownedWorkers = new Set(), ownedRuntimes = new Map();
const sourceBaselines = new Map(), stagedSources = [];
const trackWorker = child => { if (child?.pid) { helperPids.add(child.pid); ownedWorkers.add(child); } };
const trackRuntime = (backend, runtime) => {
  if (runtime?.root && runtime?.token) ownedRuntimes.set(runtime.root, { backend, root: runtime.root, token: runtime.token });
  if (runtime?.sceneRuntime?.root && runtime.sceneRuntime.token)
    ownedRuntimes.set(runtime.sceneRuntime.root, { backend: 'private-scene-project-view', root: runtime.sceneRuntime.root, token: runtime.sceneRuntime.token });
};
const launchOwned = (...args) => { const child = spawn(...args); trackWorker(child); return child; };
const player = new IsolatedPlayer({ executable: before.wallpaperEngine.path, launch: launchOwned,
  stage: async (...args) => {
    try { const runtime = await stagePrivateEngine(...args); stagedSources.push({ root: runtime.root, source: args[0]?.project, at: Date.now() }); trackRuntime('wallpaper-engine-isolated', runtime); return runtime; }
    catch (error) { trackRuntime('wallpaper-engine-isolated', error.isolatedRuntime); throw error; }
  } }),
  application = new IndependentApplicationPlayer({ adapter: new PowerShellApplicationAdapter({ launch: launchOwned }) }),
  web = new WebBackend(), frames = new NativeFrames();
for (const capture of [player.frames, frames]) {
  const start = capture.start.bind(capture);
  capture.start = () => { start(); trackWorker(capture.child); };
}
function recordOwnedResources() {
  for (const child of [player.worker, player.frames.child, frames.child, web.child, application.adapter.child]) trackWorker(child);
  trackRuntime(player.backend, player.runtime); trackRuntime(application.backend, application.runtime);
}
const store = new SettingsStore(path.join(evidence, 'service-data')); await store.load();
let coordinator, helper, frameDeliveries = 0;
const originalFrame = presentation.frame.bind(presentation), sourceHashes = new Set();
presentation.frame = async (frame, generation) => { frameDeliveries++; sourceHashes.add(createHash('sha256').update(frame.jpeg).digest('hex')); return originalFrame(frame, generation); };
const structural = `({root:!!document.querySelector(${JSON.stringify(adapter.selectors.root)}),main:!!document.querySelector(${JSON.stringify(adapter.selectors.main)}),composer:!!document.querySelector(${JSON.stringify(adapter.selectors.composer)})})`;
const signature = `(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');if(!c)return null;const s=new OffscreenCanvas(64,36),ctx=s.getContext('2d');ctx.drawImage(c,0,0,64,36);const p=ctx.getImageData(0,0,64,36).data;let h=2166136261;for(let i=0;i<p.length;i++)h=Math.imul(h^p[i],16777619);return h>>>0;})()`;
async function pump(milliseconds, predicate = () => false) { const deadline = Date.now() + milliseconds; do { recordOwnedResources(); await coordinator.tick(); recordOwnedResources(); if (predicate()) return true; await delay(10); } while (Date.now() < deadline); recordOwnedResources(); return predicate(); }
async function sampleAll(sampler, pids) {
  const rows = [], unique = [...new Set(pids)];
  for (let index = 0; index < unique.length; index += 8) rows.push(...(await sampler.collect(unique.slice(index, index + 8))).counters);
  return rows;
}
async function ownCommand(index, ...args) {
  const child = children[index]; assert.ok(child && child.exitCode === null && !before.codex.some(app => app.pid === child.pid));
  return runFile(helper, [String(child.pid), ...args.map(String)], { windowsHide: true, timeout: 6000 });
}
async function ownGeometry(index, ...args) {
  const owner = ownedWindows[index]; assert.ok(owner, 'An exact PID/start-time/HWND mapping is required before manipulating a window.');
  return ownCommand(index, '--owned-window', owner.hwnd, owner.started, ...args);
}
async function terminateOwned(index) {
  const child = children[index], identity = ownedProcesses[index];
  if (!child || child.exitCode !== null || child.signalCode !== null) return { alreadyExited: true, pid: child?.pid };
  if (!identity) {
    // Node retains the original Windows process handle for its spawned child.
    // Never substitute a PID-based kill when startup failed before attribution.
    const requested = child.kill();
    return { pid: child.pid, spawnHandleFallback: true, requested };
  }
  assert.ok(/^\d{16,20}$/.test(identity.nativeStarted) && path.isAbsolute(identity.nativeExecutable), 'The original native process proof is required for tree cleanup.');
  return JSON.parse((await runFile(helper, [String(identity.pid), '--owned-terminate-tree', identity.nativeStarted, identity.nativeExecutable],
    { windowsHide: true, timeout: 12000 })).stdout);
}
async function mapOwnedRenderer(index, width, height) {
  const stamp = ownedProcesses[index]; assert.ok(stamp, 'A process identity must be recorded immediately after launch.');
  const inventory = JSON.parse((await ownCommand(index, '--owned-windows', stamp.started)).stdout);
  const candidates = inventory.windows.filter(window => window.visible && !window.iconic);
  assert.equal(candidates.length, 1, 'Exactly one naturally visible owned native shell is required.');
  const candidate = candidates[0], initialClient = clients[index], pooled = new Map(); let renderers = [];
  const viewport = '({visible:!document.hidden,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})';
  await ownCommand(index, '--owned-window', candidate.hwnd, stamp.started, '--visible');
  // A hidden auxiliary page can expose the shell contract before the visible
  // main page finishes booting. Rediscover until a visible page is ready;
  // capture its viewport BEFORE the causal resize instead of guessing a title.
  const visibleDeadline = Date.now() + 45000;
  while (Date.now() < visibleDeadline) {
    renderers = [];
    for (const target of await listTargets(ports[index])) {
      let client = pooled.get(target.id)?.client;
      if (!client) {
        client = target.webSocketDebuggerUrl === initialClient.url ? initialClient : await new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect();
        pooled.set(target.id, { client, target });
      }
      if (Object.values(await client.evaluate(structural)).every(Boolean)) renderers.push({ client, target, previous: await client.evaluate(viewport) });
    }
    if (renderers.some(renderer => renderer.previous.visible)) break;
    await delay(200);
  }
  if (!renderers.some(renderer => renderer.previous.visible)) {
    report.visibleRendererReadiness = renderers.map(renderer => ({ target: renderer.target.id, previous: renderer.previous }));
    for (const renderer of pooled.values()) if (renderer.client !== initialClient) renderer.client.close();
    throw new Error('OWNED_VISIBLE_RENDERER_NOT_READY');
  }
  // Electron does not necessarily propagate document.title to its native title.
  // Prove attribution by resizing the sole visible owned HWND, then matching
  // this CDP page's changed viewport to that HWND's physical client rectangle.
  await ownCommand(index, '--owned-window', candidate.hwnd, stamp.started, 10 + index * (width + 15), 50, width, height);
  await ownCommand(index, '--owned-window', candidate.hwnd, stamp.started, '--visible');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const native = JSON.parse((await ownCommand(index, '--owned-windows', stamp.started)).stdout).windows.find(window => window.hwnd === candidate.hwnd);
    const matches = [];
    for (const renderer of renderers) {
      const current = await renderer.client.evaluate(viewport), previous = renderer.previous;
      if (native && current.visible && (current.width !== previous.width || current.height !== previous.height) &&
          Math.abs(current.width * current.dpr - native.clientWidth) <= 2 && Math.abs(current.height * current.dpr - native.clientHeight) <= 2) {
        matches.push({ renderer, current, previous });
      }
    }
    if (matches.length === 1) {
        const { renderer, current, previous } = matches[0];
        clients[index] = renderer.client; acceptedTargets.set(ports[index], renderer.target.id);
        for (const other of pooled.values()) if (other.client !== renderer.client) other.client.close();
        if (initialClient !== renderer.client && !renderers.some(row => row.client === initialClient)) initialClient.close();
        return { pid: stamp.pid, started: stamp.started, nativeStarted: stamp.nativeStarted, nativeExecutable: stamp.nativeExecutable, hwnd: candidate.hwnd, target: renderer.target.id, readyTargetCandidates: renderers.length,
          mappedBy: 'unique visible owned HWND + causal viewport/client-rectangle resize', initiallyVisible: candidate.visible, previousViewport: previous, viewport: current, nativeClient: native };
    }
    await delay(150);
  }
  report.unmappedNativeWindows = JSON.parse((await ownCommand(index, '--owned-windows', stamp.started)).stdout);
  report.unmappedViewport = await Promise.all(renderers.map(async row => ({ target: row.target.id, previous: row.previous, current: await row.client.evaluate(viewport) })));
  for (const renderer of pooled.values()) if (renderer.client !== initialClient) renderer.client.close();
  throw new Error('OWNED_RENDERER_HWND_UNMAPPED');
}
try {
  helper = path.join(evidence, 'CodexWindowProbe.exe');
  await runFile(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, path.join(ROOT, 'scripts/experiments/CodexWindowProbe.cs')], { windowsHide: true, timeout: 15000 });
  report.desktop = JSON.parse((await runFile(helper, ['--desktop-state'], { windowsHide: true, timeout: 5000 })).stdout);
  assert.ok(report.desktop.interactiveDesktopAvailable, 'INTERACTIVE_DESKTOP_REQUIRED');
  console.error('Independent acceptance: ordinary desktop confirmed; launching owned test windows.');
  for (let index = 0; index < ports.length; index++) {
    const port = ports[index], profile = path.join(evidence, `profile-${port}`); await mkdir(profile);
    const child = spawn(before.codexInstall, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { windowsHide: false, stdio: 'ignore' });
    children.push(child); assert.ok(!before.codex.some(app => app.pid === child.pid));
    let ready = false; const deadline = Date.now() + 45000;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      if (!ownedProcesses[index]) {
        try {
          const stamp = JSON.parse((await ownCommand(index, '--owned-stamp')).stdout);
          assert.equal(path.resolve(stamp.executable).toLowerCase(), path.resolve(before.codexInstall).toLowerCase());
          assert.ok(/^\d{16,20}$/.test(stamp.nativeStarted) && path.isAbsolute(stamp.nativeExecutable), 'Native cleanup identity must be captured immediately after launch.');
          ownedProcesses[index] = stamp;
        } catch (error) { if (Date.now() + 300 >= deadline) throw error; await delay(150); continue; }
      }
      const app = (await nativeProbe()).codex.find(app => app.pid === child.pid && app.endpoints.includes(port));
      if (app) {
        let targets = [];
        try { targets = await listTargets(port); }
        catch { report.startupDiscoveryRetries = (report.startupDiscoveryRetries || 0) + 1; }
        for (const target of targets) {
          const client = new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 });
          try {
            await client.connect();
            if (Object.values(await client.evaluate(structural)).every(Boolean)) { clients.push(client); report.versions.push(app.version); ready = true; break; }
          } catch { report.startupTargetRetries = (report.startupTargetRetries || 0) + 1; }
          client.close();
        }
      }
      if (!ready) await delay(300);
    }
    assert.ok(ready, `Owned Codex ${port} must expose its empty shell.`);
  }
  const screen = await clients[0].evaluate('({width:screen.availWidth*devicePixelRatio,height:screen.availHeight*devicePixelRatio,dpr:devicePixelRatio})'); report.screen = screen;
  const width = Math.floor((screen.width - 50) / 2), height = Math.min(1050, Math.round(screen.height - 100));
  report.ownedNativeWindows = [];
  for (let index = 0; index < children.length; index++) {
    ownedWindows.push(await mapOwnedRenderer(index, width, height));
    await ownGeometry(index, 10 + index * (width + 15), 50, width, height);
    await ownGeometry(index, '--visible');
    report.ownedNativeWindows.push({ normalLaunch: true, index, ...ownedWindows[index] });
  }
  await delay(1200);
  report.actualRendererVisibility = await Promise.all(clients.map(client => client.evaluate('({visible:!document.hidden,width:innerWidth,height:innerHeight})')));
  assert.ok(report.actualRendererVisibility.every(window => window.visible), 'OWNED_RENDERER_MUST_BE_NATURALLY_VISIBLE');
  console.error('Independent acceptance: both physical HWNDs mapped to visible renderer viewports.');
  if (process.env.BRIDGE_ACCEPTANCE_COVERAGE === '1') {
    console.error('Independent acceptance: checking text-free composed wallpaper coverage.');
    await verifyWindowCoverage({ clients, adapter, payload: await readFile(path.join(ROOT, 'src/renderer.js'), 'utf8'),
      ownGeometry, width, height, report,
      checkpoint: () => writeFile(path.join(evidence, 'coverage-progress.json'), JSON.stringify(report.windowCoverage, null, 2)) });
  }
  const owned = new Set(children.map(child => child.pid));
  coordinator = new Coordinator({ settings: store, wallpaper: new WallpaperEngine(), presentation, frames, web, player, application, log,
    capabilities: JSON.parse(await readFile(path.join(ROOT, 'config/wallpaper-engine.json'), 'utf8')),
    probe: async () => { const apps = await nativeProbe(); return { ...apps, codex: apps.codex.filter(app => owned.has(app.pid)).map(app => ({ ...app, endpoints: app.endpoints.filter(port => ports.includes(port)) })) }; } });
  const sources = [
    ['video', path.join(path.dirname(before.wallpaperEngine.path), '../../workshop/content/431960/2648290826/project.json')],
    ['scene', path.join(path.dirname(before.wallpaperEngine.path), 'projects/defaultprojects/shimmering_particles/project.json')],
    ['web', path.join(ROOT, 'scripts/experiments/fixtures/web/project.json')],
    ['packed-scene', path.join(path.dirname(before.wallpaperEngine.path), '../../workshop/content/431960/3354827805/project.json')],
    ['application', path.join(path.dirname(before.wallpaperEngine.path), 'projects/defaultprojects/sheep/project.json')],
  ];
  if (process.env.BRIDGE_ACCEPTANCE_CROSS_VOLUME === '1') {
    const sourceRoot = path.join(evidence, 'authored-cross-volume-scene'); await mkdir(sourceRoot);
    const template = JSON.parse(await readFile(path.join(ROOT, 'scripts/experiments/fixtures/scene-pointer/scene.json'), 'utf8'));
    template.objects[0].color.script = "'use strict';let ticks=0;export function update(value){ticks++;return new Vec3((ticks%127)/127,((ticks*3)%127)/127,0.2);}";
    await writeFile(path.join(sourceRoot, 'scene.json'), JSON.stringify(template), { flag: 'wx' });
    const project = path.join(sourceRoot, 'project.json');
    await writeFile(project, JSON.stringify({ title: 'Bridge authored cross-volume animation', type: 'scene', file: 'scene.json' }), { flag: 'wx' });
    const sourceVolume = (await stat(sourceRoot)).dev, engineVolume = (await stat(path.dirname(before.wallpaperEngine.path))).dev;
    assert.notEqual(sourceVolume, engineVolume, 'CROSS_VOLUME_FIXTURE_REQUIRES_DISTINCT_VOLUMES');
    report.crossVolumeFixture = { project, sourceVolume, engineVolume, generatedFromAuthoredJsonOnly: true };
    sources.push(['cross-volume-scene', project]);
  }
  const library = new WallpaperLibrary(); await library.refresh({ executable: before.wallpaperEngine.path });
  assert.equal(library.errors.length, 0, 'Source preservation inventory must be complete.');
  const videos = library.list({ type: 'video' });
  for (const project of [...sources.map(([, project]) => project), ...videos.map(video => video.project)]) {
    const root = path.dirname(path.resolve(project));
    if (!sourceBaselines.has(root)) sourceBaselines.set(root, await sourceSnapshot(root));
  }
  report.sourceBaselines = [...sourceBaselines.values()].map(snapshotSummary);
  await writeFile(path.join(evidence, 'source-baselines.json'), JSON.stringify([...sourceBaselines.values()], null, 2));
  for (const [type, project] of sources) {
    console.error(`Independent acceptance: testing ${type}.`);
    sourceHashes.clear(); const startDeliveries = frameDeliveries, stagesBefore = stagedSources.length;
    await coordinator.applySettings({ ...store.value, enabled: true, autoAdjust: false, fpsLimit: 60, allowCandidateAdapter: true, selectedWallpaper: path.resolve(project) });
    const ready = await pump(45000, () => coordinator.state === 'Active' && presentation.windows.size === 2 && [...presentation.windows.values()].every(window => window.visible && window.generation === coordinator.generation));
    report.rendererReadiness = await Promise.all(clients.map(client => client.evaluate(`({visible:!document.hidden,width:innerWidth,height:innerHeight,ping:window.__codexWallpaperBridgeV1?.ping()})`)));
    assert.ok(ready, `${type}: ${coordinator.state}/${coordinator.code}; windows=${presentation.windows.size}; visible=${presentation.visibleCount}`);
    const stableGeneration = coordinator.generation;
    const hashes = [[], []];
    for (let index = 0; index < 6; index++) { await pump(260); for (let window = 0; window < clients.length; window++) hashes[window].push(await clients[window].evaluate(signature)); }
    const result = { type, backend: coordinator.backend, generation: coordinator.generation, rendererGenerations: [...presentation.windows.values()].map(window => window.generation),
      nativeSources: player.surface || application.session ? 1 : 0, sourceFrames: frameDeliveries - startDeliveries, differentSourceFrames: sourceHashes.size,
      playback: await Promise.all(clients.map(client => client.evaluate('window.__codexWallpaperBridgeV1.ping().playback'))),
      windowSignatures: hashes, changingPerWindow: hashes.map(values => new Set(values).size),
      nativeStarts: stagedSources.length - stagesBefore, resourceRevision: coordinator.wallpaper.resourceRevision,
      frameTransport: [...presentation.windows.values()].map(window => window.frameFetch?.ready ? 'devtools-binary-response' : type === 'video' ? 'original-file-decoder' : 'legacy-data-arguments'),
      stableGeneration: coordinator.generation === stableGeneration,
      desktopUnchanged: JSON.stringify(originalDesktop) === JSON.stringify(desktop(JSON.parse(await readFile(config, 'utf8')))) };
    report.sourceResults.push(result); assert.ok(result.changingPerWindow.every(count => count > 1));
    assert.ok(result.frameTransport.every(transport => transport === (type === 'video' ? 'original-file-decoder' : 'devtools-binary-response')));
    assert.equal(result.stableGeneration, true, `${type}: source generation must remain stable`);
    if (['scene', 'packed-scene', 'cross-volume-scene', 'web'].includes(type)) assert.equal(result.nativeStarts, 1, `${type}: exactly one private engine start`);
    if (type === 'cross-volume-scene') {
      result.privateView = { root: player.runtime.sceneRuntime.root, crossVolumeEngine: player.runtime.sceneRuntime.crossVolumeEngine, copiedMediaBytes: player.runtime.sceneRuntime.copiedMediaBytes };
      assert.equal(result.privateView.crossVolumeEngine, true); assert.equal(result.privateView.copiedMediaBytes, 0);
    }
    assert.equal(result.nativeSources, type === 'video' ? 0 : 1); assert.equal(result.desktopUnchanged, true);
    assert.equal(result.backend, type === 'video' ? 'chromium-muted-video' : type === 'application' ? 'independent-owned-application' : 'wallpaper-engine-isolated');
    if (type === 'scene') {
      await ownGeometry(0, 10, 50, Math.max(600, width - 130), Math.max(500, height - 110)); await pump(1000);
      report.resize = await clients[0].evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,canvasWidth:c.width,canvasHeight:c.height}})()`);
      assert.equal(report.resize.canvasWidth, Math.round(report.resize.width * report.resize.dpr)); assert.equal(report.resize.canvasHeight, Math.round(report.resize.height * report.resize.dpr));
      await ownGeometry(0, 10, 50, width, height); await pump(500);
      const state = JSON.parse((await ownGeometry(0, '--minimize')).stdout); await pump(500); await presentation.heartbeat();
      report.minimize = [...presentation.windows.values()].map(window => window.visible); assert.ok(report.minimize.some(value => !value));
      await ownGeometry(0, '--restore', state.show === 3 ? 3 : 9, state.hwnd, state.started); await ownGeometry(0, '--visible'); await pump(800); await presentation.heartbeat();
      report.resume = [...presentation.windows.values()].map(window => window.visible); assert.ok(report.resume.every(Boolean));
      for (let index = 0; index < clients.length; index++) {
        // Retain only our background pixels, never foreground app/sidebar text.
        const pixels = await clients[index].evaluate(`document.querySelector('canvas[data-cwb-owned="v1"]')?.toDataURL('image/png').split(',')[1]`);
        assert.ok(typeof pixels === 'string' && pixels.length > 0);
        await writeFile(path.join(evidence, `scene-window-${index + 1}.png`), Buffer.from(pixels, 'base64'));
        report.sourcePixelsSaved = true;
        report.savedPixelScope = 'owned-background-canvas-only';
      }
      for (const requested of [30, 60, 120]) {
        const beforePolicyFrames = frameDeliveries;
        await coordinator.applySettings({ ...store.value, fpsLimit: requested, autoAdjust: false });
        assert.ok(await pump(30000, () => coordinator.state === 'Active' && player.surface && player.worker &&
          frameDeliveries > beforePolicyFrames), `PERFORMANCE_SOURCE_NOT_READY:${requested}`);
        await presentation.heartbeat();
        const helpers = new ProcessSampler({ details: true, scope: 'capture-and-browser-only' });
        const roots = () => [player.worker?.pid, player.frames.child?.pid, frames.child?.pid, web.child?.pid, application.adapter.child?.pid].filter(pid => Number.isInteger(pid) && pid > 0);
        const measured = await measureHelperInterval({ sampler: helpers, roots, run: async () => {
          const start = Date.now(), startFrames = frameDeliveries, cpu = process.cpuUsage();
          await pump(3200);
          return { elapsed: Date.now() - start, used: process.cpuUsage(cpu), delivered: frameDeliveries - startFrames };
        } });
        const { elapsed, used, delivered } = measured.result;
        await presentation.heartbeat();
        assert.ok(Number.isFinite(measured.sample.cpu), 'HELPER_CPU_REQUIRES_TWO_COMPARABLE_SAMPLES');
        report.performance.push({ requestedFps: requested, effectiveFps: effectivePolicy(store.value, 2, false, coordinator.apps?.displayRefreshHz).fps,
          measuredDeliveryFps: delivered * 1000 / elapsed, rendererFps: [...presentation.windows.values()].map(window => window.fps),
          nodeCpuSingleCorePercent: (used.user + used.system) / (elapsed * 10), nodeRssBytes: process.memoryUsage().rss,
          captureHelpers: measured.sample, helperBaseline: measured.baseline, helperBaselineRoots: measured.baselineRoots,
          helperSampledRoots: measured.sampledRoots, durationMs: elapsed });
      }
    }
  }
  if (enduranceSeconds) {
    await verifyIndependentEndurance({ seconds: enduranceSeconds, videos,
      sources, coordinator, presentation, player, application, frames, web, clients, children, ownGeometry, width, height, pump, signature, evidence, report });
  }
  report.input = [];
  for (const client of clients) {
    const focused = await client.evaluate(`(() => {const root=document.querySelector(${JSON.stringify(adapter.selectors.composer)}),field=root?.querySelector('[contenteditable="true"],textarea');if(!field)return 'unavailable';if(field.value||field.textContent)return 'nonempty';field.focus();return 'empty'})()`);
    if (focused !== 'empty') { report.input.push({ available: focused !== 'unavailable', skippedExistingDraft: focused === 'nonempty' }); continue; }
    const marker = `Bridge acceptance ${randomBytes(8).toString('hex')}`;
    await client.call('Input.insertText', { text: marker });
    const inserted = await client.evaluate(`(() => {const root=document.querySelector(${JSON.stringify(adapter.selectors.composer)}),field=root?.querySelector('[contenteditable="true"],textarea');return field===document.activeElement&&(field?.value||field?.textContent||'')===${JSON.stringify(marker)}})()`);
    assert.equal(inserted, true, 'Only a previously empty owned test composer may receive the exact marker.');
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }); await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' }); await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    const cleared = await client.evaluate(`(() => {const root=document.querySelector(${JSON.stringify(adapter.selectors.composer)}),field=root?.querySelector('[contenteditable="true"],textarea');return !(field?.value||field?.textContent)})()`);
    report.input.push({ available: true, inserted, cleared, sent: false }); assert.equal(cleared, true);
  }
  if (enduranceSeconds) {
    const generation = coordinator.generation, closing = children[1];
    assert.ok(!before.codex.some(app => app.pid === closing.pid));
    report.closedOwnedTree = await terminateOwned(1);
    clients.pop().close();
    const continued = await pump(15000, () => coordinator.state === 'Active' && presentation.windows.size === 1 && presentation.visibleCount === 1);
    assert.ok(continued, 'CLOSE_ONE_WINDOW_MUST_PRESERVE_OTHER');
    assert.equal(coordinator.generation, generation);
    const first = await clients[0].evaluate(signature); await pump(1000); const last = await clients[0].evaluate(signature);
    assert.notEqual(first, last);
    report.windowClosure = { closedPid: closing.pid, remainingPid: children[0].pid, generation,
      generationRetained: true, remainingCanvasChanged: true, remainingWindows: presentation.windows.size };
  }
  report.success = true;
} catch (error) { report.failure = { code: error.message, output: error.stdout || undefined, stack: String(error.stack).split('\n').slice(0, 4) }; throw error; }
finally {
  recordOwnedResources();
  const cleanupSampler = new ProcessSampler({ details: true });
  const history = [...report.performance.flatMap(sample => [...sample.helperBaseline.counters, ...sample.captureHelpers.counters]),
    ...(report.endurance?.samples || []).flatMap(sample => [...sample.codexTree.counters, ...sample.activeHelpers.counters])];
  const ownedProcessRows = await cleanupProcessLedger({ sampler: cleanupSampler, workers: ownedWorkers, history })
    .catch(error => { report.cleanupSnapshotError = error.message; return new Map(history.map(row => [`${row.pid}:${row.identity}`, row])); });
  const ownedCleanupRows = [...ownedProcessRows.values()];
  await coordinator?.stop().catch(error => { report.cleanupError = error.message; });
  if (!coordinator) { await player.stop().catch(() => {}); await application.stop().catch(() => {}); await web.stop().catch(() => {}); frames.stop(); await presentation.restore().catch(() => {}); }
  report.restoredOwnedNodes = await Promise.all(clients.map(client => client.evaluate('document.querySelectorAll("[data-cwb-owned]").length').catch(() => null)));
  clients.forEach(client => client.close());
  report.terminatedOwnedTrees = [];
  for (let index = 0; index < children.length; index++) {
    try { report.terminatedOwnedTrees.push(await terminateOwned(index)); }
    catch (error) { report.cleanupError ||= error.message;
      let diagnostic;try {diagnostic=JSON.parse(error.stdout);}catch{}
      report.terminatedOwnedTrees.push({ pid: children[index].pid, error: error.message, diagnostic, stdout: error.stdout || undefined, stderr: error.stderr || undefined }); }
  }
  await delay(1000);
  const after = await nativeProbe(); report.cleanup = { ownedRootPids: children.map(child => child.pid), ownedRootsAlive: after.codex.filter(app => children.some(child => child.pid === app.pid)).map(app => app.pid),
    nativeOpened: !!player.surface || !!application.session || !!player.runtime || !!application.runtime ||
      [...ownedWorkers].some(child => child.exitCode === null && child.signalCode === null),
    retainedBackendState: { isolatedSurface: !!player.surface, applicationSession: !!application.session, isolatedRuntime: player.runtime?.root || null,
      applicationRuntime: application.runtime?.root || null, isolatedWorker: player.worker?.pid || null, applicationWorker: application.adapter.child?.pid || null },
    desktopUnchanged: JSON.stringify(originalDesktop) === JSON.stringify(desktop(JSON.parse(await readFile(config, 'utf8')))), userPidsRetained: before.codex.every(app => after.codex.some(current => current.pid === app.pid)) };
  let remainingHelpers = [];
  if (ownedCleanupRows.length) {
    const deadline = Date.now() + 8000;
    do {
      const current = await sampleAll(cleanupSampler, ownedCleanupRows.map(row => row.pid));
      remainingHelpers = current.filter(row => ownedProcessRows.has(`${row.pid}:${row.identity}`));
      if (!remainingHelpers.length && [...ownedWorkers].every(child => child.exitCode !== null || child.signalCode !== null)) break;
      await delay(300);
    } while (Date.now() < deadline);
  }
  report.cleanup.runtimeDirectories = await runtimeCleanupEvidence([...ownedRuntimes.values()]);
  report.stagedSources = stagedSources;
  report.sourcePreservation = [];
  for (const [root, baseline] of sourceBaselines) {
    try {
      const afterSource = await sourceSnapshot(root);
      report.sourcePreservation.push({ root, before: snapshotSummary(baseline), after: snapshotSummary(afterSource), changes: compareSnapshots(baseline, afterSource) });
    } catch (error) { report.sourcePreservation.push({ root, error: error.message }); }
  }
  report.cleanup.workerExits = [...ownedWorkers].map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
    exited: child.exitCode !== null || child.signalCode !== null }));
  report.cleanup.nativeOpened = !!player.surface || !!application.session || !!player.runtime || !!application.runtime || report.cleanup.workerExits.some(worker => !worker.exited);
  report.cleanup.ownedHelperPids = [...helperPids]; report.cleanup.measuredProcessIdentities = ownedCleanupRows.length; report.cleanup.remainingHelpers = remainingHelpers;
  const cleanupPassed = !report.cleanupError && !report.cleanupSnapshotError && !report.cleanup.ownedRootsAlive.length && !report.cleanup.nativeOpened &&
    !remainingHelpers.length && report.cleanup.runtimeDirectories.every(runtime => runtime.exists === false) && report.cleanup.workerExits.every(worker => worker.exited) &&
    report.cleanup.desktopUnchanged && report.cleanup.userPidsRetained && report.restoredOwnedNodes.every(count => count === 0) &&
    report.sourcePreservation.every(row => row.changes?.contentUnchanged && row.changes?.metadataUnchanged);
  if (report.success && !cleanupPassed) { report.success = false; report.failure = { code: 'INDEPENDENT_CLEANUP_FAILED' }; }
  report.limitations.push('Single physical display: cross-monitor DPI movement and existing conversation layout remain unverified. Native engine support is restricted to the reviewed version; independent Application support is restricted to the reviewed Sheep.');
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success || false, failure: report.failure, sources: report.sourceResults.map(result => ({ type: result.type, backend: result.backend, changingPerWindow: result.changingPerWindow })), performance: report.performance, cleanup: report.cleanup }));
  if (!cleanupPassed && !report.failure) throw new Error('INDEPENDENT_CLEANUP_FAILED');
  if (report.failure?.code === 'INDEPENDENT_CLEANUP_FAILED') process.exitCode = 1;
}
