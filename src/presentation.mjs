import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CdpClient, listTargets } from './cdp.mjs';
import { PointerEvents } from './pointer-events.mjs';
import { FrameFetch } from './frame-fetch.mjs';
const KEY = 'window.__codexWallpaperBridgeV1';
const RUNTIME_VERSION = 5;
const call = (method, ...args) => `${KEY}?.${method}(${args.map(a => JSON.stringify(a)).join(',')})`;
const FRAME_FUNCTION = 'function(generation, jpeg) { return this.__codexWallpaperBridgeV1?.frame(generation, jpeg); }';
const FRAME_FETCH_FUNCTION = 'function(generation, ticket) { return this.__codexWallpaperBridgeV1?.frameFromUrl(generation, ticket); }';
export class Presentation {
  constructor(adapter, diagnostics, { discover = listTargets, connect = async target => new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect() } = {}) {
    this.adapter = adapter; this.log = diagnostics; this.windows = new Map(); this.pending = new Map(); this.generation = 0; this.lifecycle = 0;
    this.discover = discover; this.connect = connect;
    this.pointerBinding = `__cwbPointer${randomBytes(12).toString('hex')}`;
    this.pointerMode = { enabled: false, generation: -1, token: randomBytes(16).toString('hex') };
    this.pointerEvents = new PointerEvents();
  }
  async attachPointer(key, window) {
    const socket = window.client.ws;
    if (!socket?.addEventListener) return;
    const listener = event => {
      // Runtime events other than our random owned binding are not retained.
      if (typeof event.data !== 'string' || event.data.length > 2048) return;
      let row; try { row = JSON.parse(event.data); } catch { return; }
      if (row.method !== 'Runtime.bindingCalled' || row.params?.name !== this.pointerBinding || this.windows.get(key) !== window) return;
      this.pointerEvents.accept(key, row.params.payload, { ...this.pointerMode, visible: window.visible && window.generation === this.pointerMode.generation });
    };
    socket.addEventListener('message', listener);
    window.detachPointer = () => { socket.removeEventListener('message', listener); window.pointerAvailable = false; this.pointerEvents.remove(key); };
    try {
      await window.client.call('Runtime.addBinding', { name: this.pointerBinding });
      if (this.windows.get(key) !== window) { window.detachPointer(); return; }
      window.pointerAvailable = true;
      await window.client.evaluate(call('pointerMode', { ...this.pointerMode, binding: this.pointerBinding }));
    } catch {
      window.detachPointer();
      void this.log.event('info', 'pointer', 'POINTER_FORWARDING_UNAVAILABLE', { code: 'BINDING_UNAVAILABLE' });
    }
  }
  async setPointerMode({ enabled = false, generation = -1 } = {}) {
    enabled = enabled === true && Number.isSafeInteger(generation) && generation >= 0;
    if (this.pointerMode.enabled === enabled && this.pointerMode.generation === generation) return;
    this.pointerMode = { enabled, generation, token: randomBytes(16).toString('hex') };
    this.pointerEvents.clear();
    const mode = { ...this.pointerMode, binding: this.pointerBinding };
    await Promise.all([...this.windows.entries()].map(async ([key, window]) => {
      if (!window.pointerAvailable) return;
      try { await window.client.evaluate(call('pointerMode', mode)); }
      catch (error) { await this.connectionFailure(key, window, error); }
    }));
  }
  drainPointers(generation) {
    if (!this.pointerMode.enabled || generation !== this.pointerMode.generation) { this.pointerEvents.clear(); return []; }
    return this.pointerEvents.drain(generation, key => {
      const window = this.windows.get(key);
      return !!(window?.pointerAvailable && window.visible && window.generation === generation);
    });
  }
  async reconcile(endpoints, version, allowCandidate) {
    const lifecycle = this.lifecycle;
    const descriptions = endpoints.map(item => typeof item === 'number' ? { port: item, version } : item);
    const known = descriptions.every(item => this.adapter.verifiedVersions.includes(item.version));
    for (const item of descriptions) if (!this.adapter.verifiedVersions.includes(item.version) &&
      (!allowCandidate || !new RegExp(this.adapter.candidateVersionPattern).test(item.version))) throw new Error('CODEX_ADAPTER_UNVERIFIED');
    const targets = [];
    for (const { port } of descriptions) {
      // A closing process can lose its listener between native discovery and
      // this request. Other live windows must continue rendering.
      try { for (const t of await this.discover(port)) targets.push({ ...t, key: `${port}:${t.id}` }); }
      catch { void this.log.event('info', 'codex', 'WINDOW_DISCOVERY_RETRY', { code: 'ENDPOINT_UNAVAILABLE' }); }
    }
    const live = new Set(targets.map(t => t.key));
    for (const [key, w] of this.windows) if (!live.has(key)) { w.detachPointer?.(); await w.frameFetch?.stop(); w.client.close(); this.windows.delete(key); }
    for (const key of this.pending.keys()) if (!live.has(key)) this.pending.delete(key);
    for (const target of targets) {
      if (this.windows.has(target.key)) continue;
      if (Date.now() < (this.pending.get(target.key)?.retryAt || 0)) continue;
      let client;
      try {
        client = await this.connect(target);
        if (lifecycle !== this.lifecycle) { client.close(); break; }
        // Auxiliary/startup pages can share index.html with the main shell.
        // Check only the contract before adding any runtime; one unready page
        // must not detach other compatible windows.
        const structure = await client.evaluate(`({compatible:!!(document.querySelector(${JSON.stringify(this.adapter.selectors.root)}) &&
          document.querySelector(${JSON.stringify(this.adapter.selectors.main)})),ready:document.readyState==='complete'})`);
        if (!structure.compatible) {
          this.pending.set(target.key, { retryAt: Date.now() + 3000, incompatible: !!structure.ready }); client.close(); continue;
        }
        const payload = await readFile(fileURLToPath(new URL('./renderer.js', import.meta.url)), 'utf8');
        // Controller takeover is one synchronous renderer task. The compositor
        // cannot present the gap between disposing a legacy runtime and drawing
        // its last complete frame into the replacement's single canvas.
        const result = await client.evaluate(`(() => {
          const previous = ${KEY}; let snapshot;
          if (previous && previous.runtimeVersion !== ${RUNTIME_VERSION}) {
            const canvas = document.querySelector('canvas[data-cwb-owned="v1"]');
            if (canvas?.width && canvas?.height) {
              snapshot = document.createElement('canvas');
              snapshot.width = canvas.width; snapshot.height = canvas.height;
              snapshot.getContext('2d').drawImage(canvas, 0, 0);
            }
            previous.restore();
          }
          ${payload}
          const result = ${call('install', this.options, this.adapter.selectors)};
          if (snapshot && result?.compatible && !${KEY}.adoptSnapshot(snapshot)) throw new Error('VIDEO_SNAPSHOT_ADOPT_FAILED');
          return result;
        })()`);
        if (lifecycle !== this.lifecycle) { await client.evaluate(call('restore')).catch(() => {}); client.close(); break; }
        if (!result?.compatible) throw new Error('CODEX_STRUCTURE_INCOMPATIBLE');
        const window = { client, target, generation: -1, visible: result.visible, fps: null, pending: false };
        this.windows.set(target.key, window);
        await this.attachPointer(target.key, window);
        this.pending.delete(target.key);
      } catch (e) {
        await client?.evaluate(call('restore')).catch(() => {}); client?.close();
        if (lifecycle !== this.lifecycle) break;
        this.pending.set(target.key, { retryAt: Date.now() + 3000, incompatible: e.message === 'CODEX_STRUCTURE_INCOMPATIBLE' });
        void this.log.event('info', 'codex', 'WINDOW_ATTACH_RETRY', { code: 'WINDOW_NOT_READY' });
      }
    }
    return { count: this.windows.size, pending: this.pending.size, incompatible: [...this.pending.values()].some(p => p.incompatible), verified: known };
  }
  async configure(options) {
    this.options = options;
    await Promise.all([...this.windows.entries()].map(async ([key, w]) => {
      try { await w.client.evaluate(call('configure', options)); }
      catch (error) { await this.connectionFailure(key, w, error); }
    }));
  }
  async connectionFailure(key, w, error) {
    if (!/^CDP_(?:CLOSED|TIMEOUT|SEND_FAILED|-\d+)$/.test(error.message)) throw error;
    w.detachPointer?.(); await w.frameFetch?.stop(); await w.client.evaluate(call('restore')).catch(() => {}); w.client.close();
    if (this.windows.get(key) === w) this.windows.delete(key);
    void this.log.event('info', 'codex', 'WINDOW_RECONNECT', { code: 'WINDOW_DETACHED' });
  }
  async invalidate(generation) {
    this.generation = generation;
    await this.setPointerMode({ enabled: false, generation });
    await Promise.all([...this.windows.entries()].map(async ([key, w]) => {
      try { w.frameFetch?.invalidate(); await w.client.evaluate(call('invalidate', generation)); }
      catch (error) { await this.connectionFailure(key, w, error); }
    }));
  }
  async video(source, generation, current) {
    for (const [key, w] of this.windows) {
      try {
      if (!w.visible || w.generation === generation || !current()) continue;
      // Bind only our own hidden input to the authoritative current resource.
      // Chromium streams the original File through a Blob URL: no whole-file
      // copy, HTTP CSP changes, re-encoding, or per-frame CDP data.
      const result = await w.client.call('Runtime.evaluate', { expression: call('prepareFile', generation, source.size), returnByValue: false });
      const objectId = result.result?.objectId;
      if (result.exceptionDetails || !objectId) throw new Error('VIDEO_NATIVE_FILE_PREPARE_FAILED');
      try {
        if (!current()) return false;
        await w.client.call('DOM.setFileInputFiles', { objectId, files: [source.resource] });
      } finally { await w.client.call('Runtime.releaseObject', { objectId }).catch(() => {}); }
      const info = await stat(source.resource);
      if (`${info.size}:${info.mtimeMs}` !== source.stamp.split(':').slice(0, 2).join(':')) throw new Error('SOURCE_CHANGED_DURING_TRANSFER');
      if (!current()) return false;
      if (!await w.client.evaluate(call('commitFile', generation))) { if (!current()) return false; throw new Error('VIDEO_COMMIT_FAILED'); }
      w.generation = generation;
      } catch (error) { await this.connectionFailure(key, w, error); }
    }
    return current();
  }
  async frame(frame, generation) {
    await Promise.all([...this.windows.entries()].map(async ([key, w]) => {
      if (!w.visible || w.pending) return;
      w.pending = true;
      try {
        // Native clients use a bounded binary response rather than putting a
        // JPEG string in the renderer's evaluated function arguments.
        const binary = !!w.target?.webSocketDebuggerUrl && !!w.client.ws?.addEventListener;
        if (binary && !w.frameFetch) w.frameFetch = new FrameFetch(w.client, { current: () => this.windows.get(key) === w });
        const data = binary ? await w.frameFetch.offer(frame, generation) : frame.jpeg;
        if (binary && this.windows.get(key) !== w) return;
        if (!w.frameObjectId) {
          const global = await w.client.call('Runtime.evaluate', { expression: 'globalThis', returnByValue: false });
          if (global.exceptionDetails || !global.result?.objectId) throw new Error('FRAME_OBJECT_UNAVAILABLE');
          w.frameObjectId = global.result.objectId;
        }
        // Keep large frame bytes out of evaluated script source, avoiding
        // repeated parsing and temporary source-string allocation each frame.
        const result = await w.client.call('Runtime.callFunctionOn', { objectId: w.frameObjectId, functionDeclaration: binary ? FRAME_FETCH_FUNCTION : FRAME_FUNCTION,
          arguments: [{ value: generation }, { value: data }], awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error('FRAME_DECODE_FAILED');
        if (result.result?.value) w.generation = generation;
      }
      catch (error) { await this.connectionFailure(key, w, error); }
      finally { w.pending = false; }
    }));
  }
  async heartbeat() {
    await Promise.all([...this.windows.entries()].map(async ([key, w]) => {
      try {
        const result = await w.client.evaluate(call('ping'));
        if (!result?.installed || !result.compatible) throw new Error('RENDERER_DETACHED');
        w.visible = result.visible; w.fps = result.fps; w.playback = result.playback;
      } catch (error) {
        w.detachPointer?.();
        await w.frameFetch?.stop();
        await w.client.evaluate(call('restore')).catch(() => {});
        w.client.close(); this.windows.delete(key);
        void this.log.event('info', 'codex', 'WINDOW_RECONNECT', { code: 'WINDOW_DETACHED' });
      }
    }));
  }
  async restore() {
    this.lifecycle++;
    this.pointerMode = { enabled: false, generation: -1, token: randomBytes(16).toString('hex') }; this.pointerEvents.clear();
    await Promise.all([...this.windows.values()].map(async w => {
      w.detachPointer?.();
      await w.frameFetch?.stop();
      await w.client.evaluate(call('restore')).catch(() => {}); w.client.close();
    })); this.windows.clear(); this.pending.clear();
  }
  get visibleCount() { return [...this.windows.values()].filter(w => w.visible).length; }
}
