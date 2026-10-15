import { mkdir, stat, rename, appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const allowed = new Set(['state', 'code', 'eventCode', 'type', 'id', 'generation', 'windowCount', 'attempt', 'delayMs', 'fps',
  'cpu', 'memory', 'gpu', 'decoding', 'version', 'adapter', 'durationMs', 'status', 'backend', 'sourceMethod', 'metric']);
export function sanitize(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowed.has(key)).map(([key, value]) => {
    if (typeof value === 'string') value = value.replace(/(?:[A-Z]:[\\/]|\\\\)[^\s"<>]*/gi, '<path>')
      .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]+/gi, '<redacted>').slice(0, 180);
    if (!['string', 'boolean', 'number'].includes(typeof value) && value !== null) value = 'unavailable';
    return [key, value];
  }));
}
export function safeStack(error) {
  // Keep only our module and line/column locations, never exception messages or argument values.
  return String(error?.stack || '').split('\n').slice(1, 13).map(line => {
    const match = line.match(/(?:[\\/])([a-z0-9-]+\.(?:mjs|js|cs)):(\d+):(\d+)/i);
    return match ? `${match[1]}:${match[2]}:${match[3]}` : '<external-frame>';
  });
}
export class Diagnostics {
  constructor(root, { maxBytes = 1024 * 1024, retained = 4, clock = Date.now } = {}) {
    this.root = path.join(root, 'logs'); this.maxBytes = maxBytes; this.retained = retained;
    this.session = randomUUID(); this.seen = new Map(); this.clock = clock; this.queue = Promise.resolve();
    this.debug = false;
  }
  event(level, module, code, data = {}) {
    if (level === 'debug' && !this.debug) return Promise.resolve();
    const safe = sanitize(data), key = `${level}:${module}:${code}:${JSON.stringify(safe)}`, now = this.clock();
    if (this.seen.has(key) && now - this.seen.get(key) < 30000) return Promise.resolve();
    this.seen.set(key, now);
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value);
    const row = JSON.stringify({ timestamp: new Date(now).toISOString(), level, module, eventCode: code, code,
      correlationId: this.session, ...safe }) + '\n';
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true });
      const current = path.join(this.root, 'bridge.jsonl');
      const size = await stat(current).then(s => s.size).catch(() => 0);
      if (size + Buffer.byteLength(row) > this.maxBytes) {
        for (let i = this.retained - 1; i >= 1; i--)
          await rename(path.join(this.root, `bridge.${i}.jsonl`), path.join(this.root, `bridge.${i + 1}.jsonl`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rename(current, path.join(this.root, 'bridge.1.jsonl')).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await appendFile(current, row, { mode: 0o600 });
    });
    // Logging failure must never stop recovery or local operation.
    return this.queue.catch(() => {});
  }
  async failure(module, code, error, data = {}) {
    await this.event('error', module, code, data);
    if (this.debug) await this.event('debug', module, 'STACK_LOCATIONS', { status: safeStack(error).join(' > ') });
  }
  async export(file, snapshot) {
    await this.queue.catch(() => {});
    const names = await readdir(this.root).catch(() => []), logs = [];
    for (const name of names.filter(n => /^bridge(?:\.[1-4])?\.jsonl$/.test(n))) {
      const content = await readFile(path.join(this.root, name), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        try { const e = JSON.parse(line); logs.push({ ...sanitize(e), timestamp: e.timestamp,
          level: e.level, module: e.module, eventCode: e.eventCode || e.code }); } catch { /* discard damaged records */ }
      }
    }
    const source = snapshot.source;
    await writeFile(file, JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(),
      status: sanitize(snapshot), source: source ? { id: source.id, type: source.type, sourceMethod: source.sourceMethod,
        resource: source.resource ? `<project>/${path.basename(source.resource)}` : 'hidden-in-normal-mode' } : null,
      adapter: sanitize(snapshot.adapter), policy: snapshot.policy, retry: snapshot.retry,
      windows: snapshot.windows, modules: snapshot.modules,
      apps: { codex: snapshot.apps?.codex?.map(app => ({ version: app.version, connectionCount: app.endpoints?.length || 0 })),
        wallpaperEngine: snapshot.apps?.wallpaperEngine }, updates: snapshot.updates,
      metrics: { ...snapshot.metrics, gpu: snapshot.metrics?.gpu ?? 'unavailable', decoding: snapshot.metrics?.decoding ?? 'unavailable' }, logs }, null, 2), { mode: 0o600 });
  }
}
