import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, stat, realpath, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { boundedJson, isCredentialProperty } from './wallpaper-engine.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm' };
const PROJECT_FAILURES = new Set(['WEB_AUDIO_VISUALIZER_UNAVAILABLE','WEB_MEDIA_INTERFACE_UNAVAILABLE',
  'WEB_RANDOM_FILE_INTERFACE_UNAVAILABLE','WEB_PROJECT_INTERFACE_UNSUPPORTED','VIDEO_DECODE_FAILED']);
export async function projectServer(root, entry) {
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
      const file = await realpath(path.resolve(absolute, relative)), check = path.relative(absolute, file);
      if (check === '..' || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) throw new Error();
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
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}${path.relative(absolute, entry).split(path.sep).map(encodeURIComponent).join('/')}` };
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
  constructor({ browserPath } = {}) { this.browserPath = browserPath; this.current = null; }
  async start(source, policy) {
    await this.stop();
    const metadata = source.type === 'video' ? null : await boundedJson(source.project);
    if (metadata && Object.keys(metadata.general?.properties || {}).some(isCredentialProperty)) throw new Error('WEB_CREDENTIAL_PROPERTY_UNSUPPORTED');
    let browser;
    for (const candidate of [this.browserPath, path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      try { await access(candidate); browser = candidate; break; } catch { }
    }
    if (!browser) throw new Error('WEB_EDGE_NOT_INSTALLED');
    this.host = await projectServer(source.root, source.resource);
    this.profile = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-profile-'));
    // DevTools pipes are private child handles; no browser debugger is reachable over TCP.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
    this.child = spawn(browser, ['--headless=new', '--remote-debugging-pipe', '--mute-audio', '--incognito', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions',
      '--disable-gpu-shader-disk-cache', '--disk-cache-size=0', '--media-cache-size=0', `--user-data-dir=${this.profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env });
    this.pipe = new BrowserPipe(this.child);
    const { browserContextId } = await this.pipe.call('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.pipe.call('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.pipe.call('Target.attachToTarget', { targetId, flatten: true }); this.session = sessionId;
    await this.pipe.call('Page.enable', {}, sessionId);
    await this.pipe.call('Network.enable', {}, sessionId);
    await this.pipe.call('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await this.pipe.call('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
    this.sourceType = source.type || 'web'; this.aspect = 16 / 9; this.readyDeadline = Date.now() + 15000;
    if (this.sourceType === 'video') {
      await this.configure(policy);
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
      await this.pipe.call('Runtime.evaluate', { expression }, sessionId);
      this.current = source.fingerprint; return;
    }
    const properties = structuredClone(metadata.general?.properties || {});
    for (const [key, value] of Object.entries(source.properties || {})) if (Object.hasOwn(properties, key)) properties[key].value = value;
    const init = `(() => {
      window.wallpaperOnVideoEnded = () => {};
      window.wallpaperRegisterAudioListener = () => { window.__cwbUnsupported = 'WEB_AUDIO_VISUALIZER_UNAVAILABLE'; };
      window.wallpaperRegisterMediaPropertiesListener = () => { window.__cwbUnsupported = 'WEB_MEDIA_INTERFACE_UNAVAILABLE'; };
      window.wallpaperRequestRandomFileForProperty = () => { window.__cwbUnsupported = 'WEB_RANDOM_FILE_INTERFACE_UNAVAILABLE'; };
      window.wallpaperQuery = ({onFailure} = {}) => onFailure?.(1, 'Interface unavailable in Bridge');
      const values = ${JSON.stringify(properties)};
      window.addEventListener('load', () => {
        window.wallpaperPropertyListener?.applyUserProperties?.(values);
        window.wallpaperPropertyListener?.applyGeneralProperties?.({fps:${policy.fps},videoaudiooutput:false});
      }, {once:true});
    })();`;
    await this.pipe.call('Page.addScriptToEvaluateOnNewDocument', { source: init }, sessionId);
    await this.configure(policy);
    await this.pipe.call('Page.navigate', { url: this.host.url }, sessionId);
    this.current = source.fingerprint;
  }
  async configure(policy) {
    const aspect = this.aspect || 16 / 9;
    const width = Math.max(1, Math.round(Math.min(policy.maxWidth, policy.maxWidth * aspect)));
    const height = Math.max(1, Math.round(width / aspect));
    const size = `${width}:${height}`;
    if (size !== this.size) { await this.pipe.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, this.session); this.size = size; }
    if (policy.paused !== this.paused && (policy.paused || this.paused === true))
      await this.pipe.call('Page.setWebLifecycleState', { state: policy.paused ? 'frozen' : 'active' }, this.session);
    this.paused = policy.paused;
  }
  async capture(source, policy) {
    try {
      if (this.current !== source.fingerprint) await this.start(source, policy);
      await this.configure(policy);
      const state = await this.pipe.call('Runtime.evaluate', { expression: this.sourceType === 'video' ?
        `(() => { const v = document.getElementById('cwb-source'); return {ready:v?.readyState >= 2 ? 'complete' : 'loading',
          unsupported:window.__cwbVideoFailed || v?.error ? 'VIDEO_DECODE_FAILED' : null,
          width:v?.videoWidth,height:v?.videoHeight,muted:v?.muted && v?.defaultMuted && v?.volume === 0,
          metrics:v?.getVideoPlaybackQuality ? {decodedFrames:v.getVideoPlaybackQuality().totalVideoFrames,
            droppedFrames:v.getVideoPlaybackQuality().droppedVideoFrames,readyState:v.readyState} : null}; })()` :
        `(() => {const value=window.__cwbUnsupported;return {ready:document.readyState,unsupported:value?
          (${JSON.stringify([...PROJECT_FAILURES])}.includes(value)?value:'WEB_PROJECT_INTERFACE_UNSUPPORTED'):null};})()`, returnByValue: true }, this.session);
      if (state.result?.value?.unsupported) throw new Error(PROJECT_FAILURES.has(state.result.value.unsupported) ? state.result.value.unsupported : 'WEB_PROJECT_INTERFACE_UNSUPPORTED');
      if (state.result?.value?.ready !== 'complete') {
        if (Date.now() > this.readyDeadline) throw new Error(this.sourceType === 'video' ? 'VIDEO_LOAD_TIMEOUT' : 'WEB_LOAD_TIMEOUT');
        return null;
      }
      if (this.sourceType === 'video') {
        if (!state.result.value.muted) throw new Error('VIDEO_AUDIO_ISOLATION_FAILED');
        this.aspect = state.result.value.width / state.result.value.height;
        await this.configure(policy);
      }
      const frame = await this.pipe.call('Page.captureScreenshot', { format: 'jpeg', quality: policy.jpegQuality, captureBeyondViewport: false }, this.session);
      if (frame.data.length > 6 * 1024 * 1024) throw new Error('WEB_FRAME_TOO_LARGE');
      return { jpeg: frame.data, ...(this.sourceType === 'video' ? { muted: true, width: state.result.value.width, height: state.result.value.height, metrics: state.result.value.metrics } : {}) };
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.current = null; this.size = null; this.paused = undefined; this.sourceType = null;
    const pipe = this.pipe, child = this.child; this.pipe = this.child = null;
    if (pipe) { await Promise.race([pipe.call('Browser.close').catch(() => {}), new Promise(r => setTimeout(r, 1000))]); pipe.close(); }
    if (child && child.exitCode === null) child.kill();
    this.host?.server.closeAllConnections(); this.host?.server.close(); this.host = null;
    const profile = this.profile; this.profile = null;
    if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('cwb-web-profile-')) {
      for (let n = 0; n < 10; n++) {
        try { await rm(profile, { recursive: true, force: true }); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
      }
    }
  }
}
