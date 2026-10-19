import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, stat, realpath, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { boundedJson, isCredentialProperty } from './wallpaper-engine.mjs';
import { WebIntegration } from './web-integration.mjs';
import { WebFiles } from './web-files.mjs';
import { webBootstrap } from './web-runtime.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.pnga': 'image/png', '.ogv': 'video/ogg', '.m4v': 'video/mp4' };
const PROJECT_FAILURES = new Set(['WEB_AUDIO_VISUALIZER_UNAVAILABLE','WEB_MEDIA_INTERFACE_UNAVAILABLE',
  'WEB_RANDOM_FILE_INTERFACE_UNAVAILABLE','WEB_PROJECT_INTERFACE_UNSUPPORTED','VIDEO_DECODE_FAILED',
  'WEB_PROPERTY_FILE_UNAVAILABLE','WEB_PROPERTY_DIRECTORY_TOO_LARGE']);
export async function projectServer(root, entry, files = null) {
  const prefix = `/${randomBytes(24).toString('hex')}/`, absolute = await realpath(root);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!['GET', 'HEAD'].includes(request.method) || !/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) throw new Error();
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix)) throw new Error();
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (!relative || /[\0\\:]/.test(relative)) throw new Error();
      let file;
      if (relative.startsWith('~cwb-file/')) {
        const match = /^~cwb-file\/([a-f0-9]{32})\/[^/]+$/.exec(relative);
        file = match && files ? await files.resolve(match[1]) : null; if (!file) throw new Error();
      } else {
        file = await realpath(path.resolve(absolute, relative)); const check = path.relative(absolute, file);
        if (check === '..' || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) throw new Error();
      }
      const info = await stat(file); if (!info.isFile()) throw new Error();
      response.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      let start = 0, end = info.size - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!range) { response.writeHead(416).end(); return; }
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= info.size) { response.writeHead(416).end(); return; }
        response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (request.method === 'HEAD' || !info.size) { response.end(); return; }
      const stream = createReadStream(file, { start, end }); response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
  return { server, baseUrl, url: `${baseUrl}${path.relative(absolute, entry).split(path.sep).map(encodeURIComponent).join('/')}` };
}

class BrowserPipe {
  constructor(child) {
    this.child = child; this.next = 0; this.pending = new Map(); this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', text => {
      this.buffer += text;
      if (this.buffer.length > 16 * 1024 * 1024) { this.close(); return; }
      for (;;) {
        const at = this.buffer.indexOf('\0'); if (at < 0) break;
        const row = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        let result; try { result = JSON.parse(row); } catch { continue; }
        const pending = this.pending.get(result.id); if (!pending) continue;
        this.pending.delete(result.id); clearTimeout(pending.timer);
        if (result.error) pending.reject(new Error(`WEB_BROWSER_${pending.method.replace(/[^A-Z]/gi, '_').toUpperCase()}_${Math.abs(result.error.code || 0)}`)); else pending.resolve(result.result);
      }
    });
    child.once('exit', () => this.close()); child.once('error', () => this.close());
    child.stdio[3].on('error', () => this.close()); child.stdio[4].on('error', () => this.close());
  }
  call(method, params = {}, sessionId) {
    if (this.closed || this.pending.size > 8) return Promise.reject(new Error('WEB_BROWSER_CLOSED'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('WEB_BROWSER_TIMEOUT')); }, 15000);
      this.pending.set(id, { timer, resolve, reject, method });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) this.close(); });
    });
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('WEB_BROWSER_CLOSED')); }
    this.pending.clear();
  }
}

export class WebBackend {
  constructor({ browserPath, helperPath } = {}) { this.browserPath = browserPath; this.helperPath = helperPath; this.current = null; this.lifecycle = 0; }
  async start(source, policy) {
    const lifecycle = this.lifecycle + 1;
    await this.stop();
    const active = () => { if (this.lifecycle !== lifecycle) throw new Error('WEB_BROWSER_CANCELLED'); }; active();
    const metadata = source.type === 'video' ? null : await boundedJson(source.project);
    active();
    if (metadata && Object.keys(metadata.general?.properties || {}).some(isCredentialProperty)) throw new Error('WEB_CREDENTIAL_PROPERTY_UNSUPPORTED');
    let browser;
    for (const candidate of [this.browserPath, path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      try { await access(candidate); browser = candidate; break; } catch { }
    }
    active();
    if (!browser) throw new Error('WEB_EDGE_NOT_INSTALLED');
    if (metadata) {
      const files = new WebFiles(); await files.prepare(source, metadata.general?.properties || {}); active(); this.files = files;
      this.integration = new WebIntegration({ helperPath: this.helperPath }); this.filesRefreshAt = Date.now() + 1000;
    }
    const host = await projectServer(source.root, source.resource, this.files);
    if (this.lifecycle !== lifecycle) { host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve)); active(); }
    this.host = host;
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-profile-'));
    if (this.lifecycle !== lifecycle) { await rm(profile, { recursive: true, force: true }); active(); }
    this.profile = profile;
    // DevTools pipes are private child handles; no browser debugger is reachable over TCP.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
    this.child = spawn(browser, ['--headless=new', '--remote-debugging-pipe', '--mute-audio', '--incognito', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions',
      '--disable-gpu-shader-disk-cache', '--disk-cache-size=0', '--media-cache-size=0', `--user-data-dir=${this.profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env });
    const pipe = this.pipe = new BrowserPipe(this.child);
    const { browserContextId } = await pipe.call('Target.createBrowserContext', { disposeOnDetach: true }); active();
    const { targetId } = await pipe.call('Target.createTarget', { url: 'about:blank', browserContextId }); active();
    const { sessionId } = await pipe.call('Target.attachToTarget', { targetId, flatten: true }); active(); this.session = sessionId;
    await pipe.call('Page.enable', {}, sessionId);
    await pipe.call('Network.enable', {}, sessionId);
    await pipe.call('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await pipe.call('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId }); active();
    this.sourceType = source.type || 'web'; this.aspect = 16 / 9; this.readyDeadline = Date.now() + 15000;
    if (this.sourceType === 'video') {
      await this.configure(policy);
      active();
      // Range requests stream the selected resource. No full-file Blob, disk cache,
      // additional decoder per Codex window, or wallpaper-authored script is needed.
      const expression = `(() => {
        document.documentElement.style.cssText = 'background:black;overflow:hidden';
        document.body.style.cssText = 'margin:0;overflow:hidden';
        const video = document.createElement('video'); video.id = 'cwb-source';
        video.muted = true; video.defaultMuted = true; video.volume = 0;
        video.loop = true; video.playsInline = true; video.autoplay = true;
        video.style.cssText = 'display:block;width:100vw;height:100vh;object-fit:fill';
        video.src = ${JSON.stringify(this.host.url)}; document.body.append(video);
        video.play().catch(() => { window.__cwbVideoFailed = true; });
      })()`;
      await pipe.call('Runtime.evaluate', { expression }, sessionId); active();
      this.current = source.fingerprint; return;
    }
    const init = webBootstrap({ properties: this.files.properties, aliases: this.files.aliases(this.host.baseUrl),
      directories: this.files.initialDirectories(), policy: { fps: policy.fps, paused: !!policy.paused } });
    await pipe.call('Page.addScriptToEvaluateOnNewDocument', { source: init }, sessionId); active();
    await this.configure(policy);
    active(); await pipe.call('Page.navigate', { url: this.host.url }, sessionId); active();
    this.current = source.fingerprint;
  }
  async configure(policy) {
    const pipe = this.pipe, session = this.session; if (!pipe || !session) return;
    const fps = Number.isFinite(policy.fps) && policy.fps > 0 ? policy.fps : this.generalFps || 30;
    const aspect = this.aspect || 16 / 9;
    const width = Math.max(1, Math.round(Math.min(policy.maxWidth, policy.maxWidth * aspect)));
    const height = Math.max(1, Math.round(width / aspect));
    this.width = width; this.height = height;
    const size = `${width}:${height}`;
    if (size !== this.size) { await pipe.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session); if (this.pipe !== pipe) return; this.size = size; }
    if (this.sourceType === 'web' && this.ready && (fps !== this.generalFps || !!policy.paused !== !!this.paused)) {
      await this.deliver({ policy: { fps, paused: !!policy.paused } }); if (this.pipe !== pipe) return;
    }
    this.generalFps = fps;
    if (policy.paused && !this.paused && this.integration) {
      const integration = this.integration; this.integration = new WebIntegration({ helperPath: this.helperPath });
      this.audioSequence = this.mediaSequence = null; await integration.stop(); if (this.pipe !== pipe) return;
    }
    if (policy.paused !== this.paused && (policy.paused || this.paused === true))
      await pipe.call('Page.setWebLifecycleState', { state: policy.paused ? 'frozen' : 'active' }, session);
    if (this.pipe !== pipe) return;
    this.paused = policy.paused;
  }
  async capture(source, policy) {
    const lifecycle = this.current !== source.fingerprint ? this.lifecycle + 1 : this.lifecycle;
    const active = () => { if (this.lifecycle !== lifecycle) throw new Error('WEB_BROWSER_CANCELLED'); };
    try {
      if (this.current !== source.fingerprint) await this.start(source, policy);
      active(); await this.configure(policy); active();
      const pipe = this.pipe, session = this.session;
      const state = await pipe.call('Runtime.evaluate', { expression: this.sourceType === 'video' ?
        `(() => { const v = document.getElementById('cwb-source'); return {ready:v?.readyState >= 2 ? 'complete' : 'loading',
          unsupported:window.__cwbVideoFailed || v?.error ? 'VIDEO_DECODE_FAILED' : null,
          width:v?.videoWidth,height:v?.videoHeight,muted:v?.muted && v?.defaultMuted && v?.volume === 0,
          metrics:v?.getVideoPlaybackQuality ? {decodedFrames:v.getVideoPlaybackQuality().totalVideoFrames,
            droppedFrames:v.getVideoPlaybackQuality().droppedVideoFrames,readyState:v.readyState} : null}; })()` :
        `(() => {const value=window.__cwbUnsupported;return {ready:document.readyState,unsupported:value?
          (${JSON.stringify([...PROJECT_FAILURES])}.includes(value)?value:'WEB_PROJECT_INTERFACE_UNSUPPORTED'):null,
          requests:window.__cwbReadBridgeState?.()};})()`, returnByValue: true }, session);
      active();
      if (state.result?.value?.unsupported) throw new Error(PROJECT_FAILURES.has(state.result.value.unsupported) ? state.result.value.unsupported : 'WEB_PROJECT_INTERFACE_UNSUPPORTED');
      if (state.result?.value?.ready !== 'complete') {
        if (Date.now() > this.readyDeadline) throw new Error(this.sourceType === 'video' ? 'VIDEO_LOAD_TIMEOUT' : 'WEB_LOAD_TIMEOUT');
        return null;
      }
      this.ready = true;
      if (this.sourceType === 'video') {
        if (!state.result.value.muted) throw new Error('VIDEO_AUDIO_ISOLATION_FAILED');
        this.aspect = state.result.value.width / state.result.value.height;
        await this.configure(policy); active();
      } else if (this.sourceType === 'web' && this.integration) {
        const request = state.result.value.requests || {}, files = this.files, host = this.host;
        const payload = await this.integration.snapshot(request); active();
        if (payload.error) throw new Error(payload.error);
        if (Date.now() >= this.filesRefreshAt) {
          payload.directories = await files.refresh(); active(); payload.aliases = files.aliases(host.baseUrl); this.filesRefreshAt = Date.now() + 1000;
        }
        if (Array.isArray(request.random) && request.random.length) payload.random = request.random.slice(0, 32).filter(row =>
          row && Number.isSafeInteger(row.id) && typeof row.key === 'string' && row.key.length <= 128).map(row => ({ id: row.id, key: row.key, path: files.random(row.key) }));
        if (payload.audioSequence === this.audioSequence) delete payload.audio; else this.audioSequence = payload.audioSequence;
        if (payload.mediaSequence === this.mediaSequence) delete payload.media; else this.mediaSequence = payload.mediaSequence;
        if (payload.audio || payload.media || payload.random || payload.directories) { await this.deliver(payload); active(); }
      }
      const frame = await pipe.call('Page.captureScreenshot', { format: 'jpeg', quality: policy.jpegQuality, captureBeyondViewport: false }, session); active();
      if (frame.data.length > 6 * 1024 * 1024) throw new Error('WEB_FRAME_TOO_LARGE');
      return { jpeg: frame.data, ...(this.sourceType === 'video' ? { muted: true, width: state.result.value.width, height: state.result.value.height, metrics: state.result.value.metrics } : {}) };
    } catch (error) { if (this.lifecycle === lifecycle) await this.stop(); throw error; }
  }
  async deliver(value) {
    const pipe = this.pipe, session = this.session; if (!pipe || !session) return false;
    if (!this.contextObjectId) {
      const context = await pipe.call('Runtime.evaluate', { expression: 'globalThis', objectGroup: 'cwb-web-host' }, session);
      if (this.pipe !== pipe || this.session !== session) return false;
      this.contextObjectId = context.result?.objectId; if (!this.contextObjectId) throw new Error('WEB_BROWSER_CONTEXT_UNAVAILABLE');
    }
    await pipe.call('Runtime.callFunctionOn', { functionDeclaration: 'function(value){window.__cwbDeliverBridgeData?.(value);}',
      objectId: this.contextObjectId, arguments: [{ value }], returnByValue: true }, session);
    return this.pipe === pipe && this.session === session;
  }
  async pointer(event, { current = () => true } = {}) {
    if (!this.current || !this.ready || this.paused || this.sourceType !== 'web' || !this.pipe || !this.session ||
        !['move', 'click'].includes(event?.type) || !Number.isFinite(event.x) || !Number.isFinite(event.y) ||
        event.x < 0 || event.x > 1 || event.y < 0 || event.y > 1 || !current()) return false;
    const x = event.x * Math.max(0, this.width - 1), y = event.y * Math.max(0, this.height - 1), pipe = this.pipe, session = this.session;
    await pipe.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, session);
    if (event.type === 'click' && this.pipe === pipe && this.session === session && this.ready && !this.paused && current()) {
      await pipe.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, session);
      if (this.pipe === pipe && this.session === session && current()) await pipe.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, session);
    }
    return true;
  }
  async stop() {
    this.lifecycle++;
    this.current = null; this.size = null; this.paused = undefined; this.sourceType = null; this.ready = false;
    this.contextObjectId = null; this.audioSequence = this.mediaSequence = null; this.generalFps = undefined;
    const integration = this.integration, pipe = this.pipe, child = this.child, host = this.host, profile = this.profile;
    this.integration = this.pipe = this.child = this.host = this.profile = this.session = this.files = null;
    await integration?.stop();
    if (pipe) { await Promise.race([pipe.call('Browser.close').catch(() => {}), new Promise(r => setTimeout(r, 1000))]); pipe.close(); }
    if (child && child.exitCode === null) child.kill();
    host?.server.closeAllConnections(); host?.server.close();
    if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('cwb-web-profile-')) {
      for (let n = 0; n < 10; n++) {
        try { await rm(profile, { recursive: true, force: true }); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
      }
    }
  }
}
