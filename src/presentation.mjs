import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CdpClient, listTargets } from './cdp.mjs';
const KEY = 'window.__codexWallpaperBridgeV1';
const call = (method, ...args) => `${KEY}?.${method}(${args.map(a => JSON.stringify(a)).join(',')})`;
export class Presentation {
  constructor(adapter, diagnostics, { discover = listTargets, connect = async target => new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect() } = {}) {
    this.adapter = adapter; this.log = diagnostics; this.windows = new Map(); this.pending = new Map(); this.generation = 0; this.lifecycle = 0;
    this.discover = discover; this.connect = connect;
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
    for (const [key, w] of this.windows) if (!live.has(key)) { w.client.close(); this.windows.delete(key); }
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
        await client.evaluate(payload);
        const result = await client.evaluate(call('install', this.options, this.adapter.selectors));
        if (lifecycle !== this.lifecycle) { await client.evaluate(call('restore')).catch(() => {}); client.close(); break; }
        if (!result?.compatible) throw new Error('CODEX_STRUCTURE_INCOMPATIBLE');
        this.windows.set(target.key, { client, generation: -1, visible: result.visible, fps: null, pending: false });
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
    await w.client.evaluate(call('restore')).catch(() => {}); w.client.close();
    if (this.windows.get(key) === w) this.windows.delete(key);
    void this.log.event('info', 'codex', 'WINDOW_RECONNECT', { code: 'WINDOW_DETACHED' });
  }
  async invalidate(generation) {
    this.generation = generation;
    await Promise.all([...this.windows.entries()].map(async ([key, w]) => {
      try { await w.client.evaluate(call('invalidate', generation)); }
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
      try { if (await w.client.evaluate(call('frame', generation, frame.jpeg))) w.generation = generation; }
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
        await w.client.evaluate(call('restore')).catch(() => {});
        w.client.close(); this.windows.delete(key);
        void this.log.event('info', 'codex', 'WINDOW_RECONNECT', { code: 'WINDOW_DETACHED' });
      }
    }));
  }
  async restore() {
    this.lifecycle++;
    await Promise.all([...this.windows.values()].map(async w => {
      await w.client.evaluate(call('restore')).catch(() => {}); w.client.close();
    })); this.windows.clear(); this.pending.clear();
  }
  get visibleCount() { return [...this.windows.values()].filter(w => w.visible).length; }
}
