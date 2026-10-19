import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, readdir, symlink, unlink, rmdir, rm, realpath, stat } from 'node:fs/promises';
import { HOST, NativeFrames } from './platform.mjs';
import { boundedJson, describeSource, isCredentialProperty } from './wallpaper-engine.mjs';
import { propertyDefinitions } from './library.mjs';
import { CdpClient } from './cdp.mjs';
import { stagePrivateScene, removePrivateScene, sceneViewLocation } from './private-scene.mjs';

const ENGINE_SHA256 = '40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const SCENE_LIBRARIES = ['resourceutil64.dll', 'scenescript64.dll', 'FreeImage64.dll', 'assimp-vc143-mt64.dll', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'steam_api64.dll', 'CUESDK.x64_2017.dll', 'cloneextensions64.dll', 'steam_appid.txt',
  'winrtutil64.exe', 'mediaextensions64.dll'];
const WEB_LIBRARIES = ['webwallpaper64.exe', 'edgewallpaper64.exe', 'winrtutil64.exe', 'mediaextensions64.dll', 'libcef.dll', 'chrome_elf.dll',
  'libEGL.dll', 'libGLESv2.dll', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin'];
const verifiedEngines = new Map();
function renderSettings(policy, preview, properties) {
  const bounded = (value, fallback, low, high) => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : fallback)));
  const width = bounded(policy.maxWidth, 1280, 320, 3840), height = bounded(policy.height, width * 9 / 16, 180, 2160);
  // Automatic load adjustment throttles frame delivery. Keep the private engine
  // at the user's ceiling so transient overload does not restart the scene.
  const fps = bounded(policy.autoAdjusted ? policy.fps * 2 : policy.fps, 60, 1, 120);
  return { width, height, fps, key: JSON.stringify([width, height, fps, preview,
    Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))]) };
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

function nativeWebFile(url) {
  const page = new URL(url);
  if (page.protocol !== 'file:' || page.hostname || page.username || page.password) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
  return { page, file: fileURLToPath(page) };
}
function nativeWebCandidate(target, port, sourceFile) {
  try {
    const { file } = nativeWebFile(target.url), socket = new URL(target.webSocketDebuggerUrl);
    // A route is only a discovery candidate. The connected document must still
    // prove its original navigation was the exact authored source file.
    return target.type === 'page' && /^[a-z0-9_-]{1,128}$/i.test(target.id) && samePath(path.dirname(file), path.dirname(sourceFile)) &&
      socket.protocol === 'ws:' && socket.hostname === '127.0.0.1' &&
      Number(socket.port) === port && !socket.username && !socket.password && !socket.search && !socket.hash && socket.pathname === `/devtools/page/${target.id}`;
  } catch { return false; }
}
export function validateNativeWebTarget(target, port, sourceFile) {
  try {
    const { page, file } = nativeWebFile(target.url);
    return nativeWebCandidate(target, port, sourceFile) && !page.search && !page.hash && samePath(file, sourceFile);
  } catch { return false; }
}
export function validateNativeWebDocument(target, port, sourceFile, document) {
  try {
    const initial = nativeWebFile(document.navigationUrl), current = nativeWebFile(document.url);
    return nativeWebCandidate(target, port, sourceFile) && !initial.page.search && !initial.page.hash && samePath(initial.file, sourceFile) &&
      samePath(path.dirname(current.file), path.dirname(sourceFile)) && document.frameUrl === document.url &&
      typeof document.frameId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(document.frameId) &&
      typeof document.loaderId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(document.loaderId);
  } catch { return false; }
}
async function nativeWebDocument(client, proof) {
  const tree = await client.call('Page.getFrameTree', {});
  const frame = tree?.frameTree?.frame;
  if (proof && (proof.frameId !== frame?.id || proof.loaderId !== frame?.loaderId)) return {};
  // The author's default world can replace performance methods. Read the
  // browser-backed document origin in a private world, bound to this loader.
  const world = proof?.contextId ? { executionContextId: proof.contextId } : await client.call('Page.createIsolatedWorld', {
    frameId: frame?.id, worldName: `CodexWallpaperBridge.DocumentProof.${randomUUID()}`,
  });
  if (!Number.isInteger(world.executionContextId) || world.executionContextId < 1) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
  const response = await client.call('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true,
    expression: `({url:location.href,navigationUrl:performance.getEntriesByType('navigation').length===1?performance.getEntriesByType('navigation')[0].name:null,width:innerWidth,height:innerHeight})` });
  if (response.exceptionDetails) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
  const state = response.result?.value;
  return { ...state, frameId: frame?.id, loaderId: frame?.loaderId,
    contextId: world.executionContextId, frameUrl: frame?.url ? frame.url + (!frame.url.includes('#') ? frame.urlFragment || '' : '') : undefined };
}

export async function inspectIsolatedEngine(executable) {
  try {
    if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'wallpaper64.exe') throw new Error();
    const file = await realpath(executable), info = await stat(file), key = `${file}:${info.size}:${info.mtimeMs}`;
    if (!verifiedEngines.has(key)) verifiedEngines.set(key, digest(await readFile(file)) === ENGINE_SHA256);
    if (!verifiedEngines.get(key)) return { safe: false, code: 'ISOLATED_ENGINE_VERSION_UNVERIFIED' };
    return { safe: true, code: 'ISOLATED_ENGINE_OUTPUT_DISABLED', executable: file, sha256: ENGINE_SHA256, version: '2.8.0.42' };
  } catch { return { safe: false, code: 'ISOLATED_ENGINE_UNAVAILABLE' }; }
}

export async function inspectIsolatedSource(source, executable) {
  if (!['scene', 'web', 'video'].includes(source?.type)) return { safe: false, code: 'APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE' };
  try {
    const canonical = await describeSource(source.project);
    if (canonical.type !== source.type || !samePath(canonical.resource, source.resource) || !samePath(canonical.root, source.root)) throw new Error();
    const engine = await inspectIsolatedEngine(executable);
    return engine.safe ? { safe: true, code: engine.code, evidence: 'A separate engine is created with private audio-output-disabled configuration before process resume.' } : engine;
  } catch { return { safe: false, code: 'ISOLATED_SOURCE_IDENTITY_INVALID' }; }
}

export function privateEngineConfiguration({ source, properties, username, runtime, fps = 60, webDebugPort }) {
  const file = source.resource.replaceAll('\\', '/'), values = { ...properties, volume: 0 };
  return { '?installdirectory': runtime.replaceAll('\\', '/'), [username]: { version: 5,
    general: { user: { hasshownwelcomedialog: true, autostart: false, autostartscheduler: false, overridewallpaper: false, overridelockscreen: false,
      videoaudiooutput: false, fps: Math.max(1, Math.min(120, Math.round(fps))), playbackfocus: 'run', playbackmaximized: 'run', playbackfullscreen: 'run',
      ...(source.type === 'web' && Number.isInteger(webDebugPort) ? { cefcommandline: ` --remote-debugging-port=${webDebugPort} --remote-debugging-address=127.0.0.1` } : {}),
      playbackonbattery: 'run', playbacksleep: 'run', playbackaudio: 'run', safemode: false, plugins: {}, mediaintegration: true,
      msaa: 'x2', resolution: 'full', postprocessing: 'ultra', reflection: true, shadows: 'ultra', volumetrics: 'ultra', preset: 'ultra' },
      wallpaperconfig: { selectedwallpapers: { Monitor0: { file } } },
      wallpaperconfigscreensaver: { sameaswallpaper: false, selectedwallpapers: { Monitor0: { file } } } },
    wproperties: { [file]: { Monitor0: values } } } };
}

export async function stagePrivateEngine(source, { executable, policy = {}, properties = source.properties || {} } = {}) {
  const safety = await inspectIsolatedSource(source, executable);
  if (!safety.safe) throw new Error(safety.code);
  const engine = await inspectIsolatedEngine(executable), installed = path.dirname(engine.executable), token = randomUUID();
  const temporary = await realpath(os.tmpdir()), root = path.join(temporary, `cwb-runtime-${token}`);
  const scenePlan = source.type === 'scene' ? await sceneViewLocation(source, { installed, token }) : null;
  await mkdir(root);
  const marker = { token, type: source.type, engineHash: engine.sha256, installedEngine: engine.executable, resource: source.resource };
  if (source.type === 'scene') {
    marker.originalResource = source.resource;
    // Persist cleanup ownership before creating any source references. The
    // separate view keeps PROJECT shader writes outside the original source.
    marker.sceneRuntime = scenePlan;
  }
  const markerFile = path.join(root, '.bridge-isolated.json'); let initialized = false;
  try {
    await writeFile(markerFile, JSON.stringify(marker)); initialized = true;
    if (source.type === 'scene') {
      marker.sceneRuntime = await stagePrivateScene(source, { installed, token });
      marker.resource = marker.sceneRuntime.resource;
      await writeFile(markerFile, JSON.stringify(marker));
    }
    await mkdir(path.join(root, 'bin'));
    await copyFile(engine.executable, path.join(root, 'wallpaper64.exe'));
    for (const file of [...SCENE_LIBRARIES, ...(source.type === 'web' ? WEB_LIBRARIES : [])]) {
      try { await copyFile(path.join(installed, 'bin', file), path.join(root, 'bin', file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (source.type === 'web') {
      await mkdir(path.join(root, 'bin', 'locales'));
      for (const entry of await readdir(path.join(installed, 'bin', 'locales'), { withFileTypes: true }))
        if (entry.isFile() && /\.pak$/i.test(entry.name)) await copyFile(path.join(installed, 'bin', 'locales', entry.name), path.join(root, 'bin', 'locales', entry.name));
    }
    for (const folder of ['assets', 'locale']) await symlink(path.join(installed, folder), path.join(root, folder), 'junction');
    const definitions = propertyDefinitions(await boundedJson(source.project)), values = {};
    for (const [key, value] of Object.entries(properties)) {
      const definition = definitions[key];
      if (!definition || isCredentialProperty(key) || typeof value !== typeof definition.value) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      values[key] = value;
    }
    await writeFile(path.join(root, 'config.json'), JSON.stringify(privateEngineConfiguration({ source: { ...source, resource: marker.resource }, properties: values,
      username: os.userInfo().username, runtime: root, fps: policy.fps || 60, webDebugPort: policy.nativeWebDebugPort })));
    return { root, token, ...marker };
  } catch (error) {
    if (initialized) {
      try { await removePrivateEngine({ root, token }); }
      catch { error.isolatedRuntime = { root, token }; }
    }
    else if (samePath(path.dirname(root), temporary) && path.basename(root) === `cwb-runtime-${token}` && samePath(await realpath(root), root)) {
      // No links or child files exist before the marker is durable.
      await unlink(markerFile).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
      await rmdir(root);
    }
    throw error;
  }
}

export async function removePrivateEngine({ root, token }) {
  if (!/^[a-f0-9-]{36}$/.test(token) || path.basename(root) !== `cwb-runtime-${token}` || !samePath(path.dirname(root), await realpath(os.tmpdir()))) throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
  if (!samePath(await realpath(root), root)) throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
  const marker = await boundedJson(path.join(root, '.bridge-isolated.json'));
  if (marker.token !== token) throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
  if (marker.sceneRuntime) {
    const scene = marker.sceneRuntime;
    if (marker.type !== 'scene' || typeof marker.installedEngine !== 'string' || !path.isAbsolute(marker.installedEngine) ||
        scene.token !== token || typeof scene.root !== 'string')
      throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
    const installed = path.dirname(marker.installedEngine);
    if (scene.sourceRoot) {
      const expected = await sceneViewLocation({ type: 'scene', root: scene.sourceRoot, project: scene.sourceProject, resource: scene.sourceResource }, { installed, token });
      if (!samePath(scene.root, expected.root) || typeof marker.originalResource !== 'string' || !samePath(scene.sourceResource, marker.originalResource) || !samePath(scene.installed, installed))
        throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
    } else if (!samePath(scene.root, path.join(installed, '.bridge-scene-runtime', token))) throw new Error('ISOLATED_CLEANUP_SCOPE_INVALID');
    await removePrivateScene(scene);
  }
  // Remove references first. Recursive removal cannot walk installed resources.
  for (const folder of ['assets', 'locale']) await unlink(path.join(root, folder)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) { if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; await delay(100); }
  }
}

class IsolatedHostPipe {
  constructor(child) {
    this.child = child; this.pending = null; this.sequence = 0; this.buffer = '';
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 65536) { this.reject(new Error('ISOLATED_PROTOCOL_TOO_LARGE')); return; }
      for (let at; (at = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, at).replace(/^\uFEFF/, ''); this.buffer = this.buffer.slice(at + 1);
        const pending = this.pending;
        try {
          const row = JSON.parse(line);
          if (!pending || row.id !== pending.id) throw new Error('ISOLATED_PROTOCOL_INVALID');
          this.pending = null; clearTimeout(pending.timer);
          row.error ? pending.reject(new Error(row.error)) : pending.resolve(row.result);
        } catch (error) { this.reject(error); }
      }
    });
    child.stdin.on('error', () => this.reject(new Error('ISOLATED_HOST_CLOSED')));
    child.once('error', () => this.reject(new Error('ISOLATED_HOST_START_FAILED')));
    child.once('exit', () => this.reject(new Error('ISOLATED_HOST_CLOSED')));
  }
  reject(error) { const pending = this.pending; this.pending = null; if (pending) { clearTimeout(pending.timer); pending.reject(error); } }
  call(action, parameters, timeout = 5000) {
    if (this.pending) return Promise.reject(new Error('ISOLATED_BACKPRESSURE'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => this.reject(new Error('ISOLATED_HOST_TIMEOUT')), timeout);
      this.pending = { id, timer, resolve, reject };
      this.child.stdin.write(JSON.stringify({ id, action, ...parameters }) + '\n');
    });
  }
}

export class IsolatedPlayer {
  constructor({ executable = '', frames = new NativeFrames(), host = HOST, launch = spawn, stage = stagePrivateEngine, cleanup = removePrivateEngine } = {}) {
    Object.assign(this, { executable, frames, host, launch, stage, cleanup }); this.queue = Promise.resolve(); this.source = this.surface = this.runtime = this.worker = this.pipe = null;
    this.lifecycle = 0;
    this.backend = 'wallpaper-engine-isolated';
  }
  serial(action) { const result = this.queue.then(action, action); this.queue = result.catch(() => {}); return result; }
  inspect(source) { return inspectIsolatedSource(source, this.executable); }
  status() { return this.serial(async () => this.pipe ? this.pipe.call('surface', { token: this.runtime.token }) : null); }
  start(source, options = {}) { const epoch = this.lifecycle; return this.serial(() => this._start(source, options, epoch)); }
  async _start(source, { policy = {}, properties = source.properties || {}, preview = false } = {}, epoch = this.lifecycle) {
    const current = () => epoch === this.lifecycle;
    if (!current()) throw new Error('ISOLATED_CANCELLED');
    const render = renderSettings(policy, preview, properties);
    if (this.source?.fingerprint === source.fingerprint && this.renderKey === render.key && this.worker?.exitCode === null && this.surface) return this.surface;
    const safety = await this.inspect(source); this.audioSafety = safety;
    if (!current()) throw new Error('ISOLATED_CANCELLED');
    if (!safety.safe) throw new Error(safety.code);
    await this._stop();
    try {
      if (!current()) throw new Error('ISOLATED_CANCELLED');
      const webDebugPort = source.type === 'web' ? await availablePort() : undefined;
      this.runtime = await this.stage(source, { executable: this.executable, policy: { ...policy, fps: render.fps, nativeWebDebugPort: webDebugPort }, properties });
      if (!current()) throw new Error('ISOLATED_CANCELLED');
      this.runtime.webDebugPort = webDebugPort;
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(?:SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|USERNAME|USERDOMAIN|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
      this.worker = this.launch(this.host, ['--isolated-we'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
      this.pipe = new IsolatedHostPipe(this.worker);
      this.starting = true;
      const surface = await this.pipe.call('start', { root: this.runtime.root, token: this.runtime.token, type: source.type, width: render.width, height: render.height, preview }, 25000);
      this.starting = false;
      if (!current()) throw new Error('ISOLATED_CANCELLED');
      if (!surface?.isolated || surface.isolated.token !== this.runtime.token || surface.type !== source.type ||
          !samePath(surface.isolated.enginePath, path.join(this.runtime.root, 'wallpaper64.exe')) || surface.audioConfiguration !== 'private-engine-output-disabled') throw new Error('ISOLATED_START_IDENTITY_INVALID');
      this.source = source; this.surface = surface; this.renderKey = render.key; return surface;
    } catch (error) {
      if (!this.runtime && error.isolatedRuntime) this.runtime = error.isolatedRuntime;
      await this._stop().catch(() => {}); throw error;
    }
  }
  capture(source, policy = {}) { const epoch = this.lifecycle; return this.serial(async () => {
    if (this.source && this.worker && (this.worker.exitCode !== null || this.worker.signalCode != null)) {
      await this._stop(); throw new Error('ISOLATED_HOST_CLOSED');
    }
    const surface = await this._start(source, { policy }, epoch);
    try { return await this.frames.capture(surface, policy); } catch (error) { await this._stop().catch(() => {}); throw error; }
  }); }
  async webInputClient() {
    const port = this.runtime.webDebugPort;
    const endpoint = await this.pipe.call('input-endpoint', { token: this.runtime.token, port });
    if (!endpoint?.verified || endpoint.port !== port || !Number.isInteger(endpoint.pid) || endpoint.pid < 1) throw new Error('ISOLATED_INPUT_ENDPOINT_UNAVAILABLE');
    if (this.webClient && this.webEndpointPid === endpoint.pid && this.webClient.ws?.readyState === WebSocket.OPEN) return this.webClient;
    this.webClient?.close(); this.webClient = null;
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 262144) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
    const reader = response.body.getReader(); let size = 0, body = '';
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 262144) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE'); body += new TextDecoder().decode(value); } }
    finally { await reader.cancel(); }
    const rows = JSON.parse(body);
    if (!Array.isArray(rows)) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
    const targets = rows.filter(row => nativeWebCandidate(row, port, this.source.resource));
    if (targets.length !== 1) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
    const client = await new CdpClient(targets[0].webSocketDebuggerUrl, { timeout: 2000 }).connect();
    try {
      const document = await nativeWebDocument(client);
      if (!validateNativeWebDocument(targets[0], port, this.source.resource, document)) throw new Error('ISOLATED_INPUT_TARGET_UNAVAILABLE');
      this.webDocument = { target: targets[0], frameId: document.frameId, loaderId: document.loaderId, contextId: document.contextId };
    } catch (error) { client.close(); throw error; }
    this.webClient = client;
    this.webEndpointPid = endpoint.pid;
    return this.webClient;
  }
  pointer(event, { current = () => true } = {}) {
    const token = this.runtime?.token, fingerprint = this.source?.fingerprint, epoch = this.lifecycle;
    const valid = () => current() && epoch === this.lifecycle && token === this.runtime?.token && fingerprint === this.source?.fingerprint;
    return this.serial(async () => {
    if (!valid()) return false;
    if (!this.surface || !this.source || this.worker?.exitCode !== null || !['move', 'click'].includes(event.type) || !Number.isFinite(event.x) || !Number.isFinite(event.y) || event.x < 0 || event.x > 1 || event.y < 0 || event.y > 1) return false;
    if (this.source.type === 'scene') {
      if (!this.frames.child) return false;
      await this.frames.pointer(this.surface, event);
      if (!valid()) return false;
      await this.pipe.call('pointer', { token: this.runtime.token, type: event.type, x: event.x, y: event.y }); return true;
    }
    if (this.source.type === 'web') {
      const client = await this.webInputClient();
      if (!valid()) return false;
      const document = this.webDocument, state = await nativeWebDocument(client, document);
      if (!document || !validateNativeWebDocument(document.target, this.runtime.webDebugPort, this.source.resource, state) ||
          state.frameId !== document.frameId || state.loaderId !== document.loaderId || !Number.isFinite(state.width) ||
          !Number.isFinite(state.height) || state.width < 1 || state.height < 1 || !valid()) {
        client.close(); if (this.webClient === client) this.webClient = this.webDocument = null; return false;
      }
      const x = event.x * (state.width - 1), y = event.y * (state.height - 1);
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      if (event.type === 'click' && valid()) {
        try { await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); }
        finally {
          // A rejected acknowledgment can still mean the press was delivered.
          await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        }
      }
      return true;
    }
    await this.pipe.call('pointer', { token: this.runtime.token, type: event.type, x: event.x, y: event.y }); return true;
  }); }
  async _stop() {
    this.starting = false;
    this.webClient?.close(); this.webClient = this.webDocument = null; this.webEndpointPid = null;
    this.frames.stop(); this.source = this.surface = this.renderKey = null;
    const worker = this.worker, pipe = this.pipe, runtime = this.runtime;
    if (worker) {
      if (worker.exitCode === null) {
        await pipe.call('stop', { token: runtime.token }, 2000).catch(() => {}); worker.stdin.end();
        for (let attempt = 0; worker.exitCode === null && attempt < 50; attempt++) await delay(50);
        if (worker.exitCode === null) worker.kill();
      }
      for (let attempt = 0; worker.exitCode === null && attempt < 20; attempt++) await delay(50);
      if (worker.exitCode === null && worker.signalCode == null) throw new Error('ISOLATED_STOP_TIMEOUT');
    }
    this.worker = this.pipe = null;
    if (runtime) {
      try { await this.cleanup(runtime); this.runtime = null; }
      catch (error) { this.runtime = runtime; throw error; }
    }
  }
  stop() {
    this.lifecycle++;
    // EOF closes the host Job even while its first renderer is still loading.
    if (this.starting) { this.worker?.stdin.end(); this.pipe?.reject(new Error('ISOLATED_CANCELLED')); }
    this.frames.stop();
    return this.serial(() => this._stop());
  }
}
