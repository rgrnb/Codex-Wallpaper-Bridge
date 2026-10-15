import { readFile, stat, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runFile, queryCurrent } from './platform.mjs';

export async function boundedJson(file, limit = 1024 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw new Error('METADATA_SIZE_INVALID');
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
export const isCredentialProperty = key => /api.?key|(?:access|refresh|auth)[_-]?token|password|secret|credential|bearer|(?:^|_)token$/i.test(key);
export function selectedFromConfig(config, monitor = 0, username = '') {
  const profiles = Object.entries(config).filter(([, v]) => v?.general?.wallpaperconfig?.selectedwallpapers);
  const selected = profiles.find(([k]) => k.toLowerCase() === username.toLowerCase()) ?? (profiles.length === 1 ? profiles[0] : null);
  if (!selected) throw new Error('WE_PROFILE_AMBIGUOUS');
  const entry = selected[1].general.wallpaperconfig.selectedwallpapers[`Monitor${monitor}`];
  if (!entry || typeof entry.file !== 'string' || !entry.file || /[\r\n\0]/.test(entry.file))
    throw new Error('WE_CURRENT_SOURCE_UNAVAILABLE');
  return entry.file;
}
export function propertiesFromConfig(config, resource, monitor, username) {
  const profiles = Object.entries(config).filter(([, v]) => v?.general?.wallpaperconfig?.selectedwallpapers);
  const profile = profiles.find(([k]) => k.toLowerCase() === username.toLowerCase()) ?? (profiles.length === 1 ? profiles[0] : null);
  if (!profile) throw new Error('WE_PROFILE_AMBIGUOUS');
  const normalize = s => s.replaceAll('\\', '/').toLowerCase();
  const values = Object.entries(profile[1].wproperties || {}).find(([key]) => normalize(key) === normalize(resource))?.[1]?.[`Monitor${monitor}`] || {};
  // Only bounded scalar wallpaper preferences are forwarded, never arbitrary commands.
  const properties = Object.fromEntries(Object.entries(values).filter(([key, value]) => /^[a-z0-9_]{1,128}$/i.test(key)
    && !isCredentialProperty(key) && !['__proto__', 'constructor', 'prototype'].includes(key)
    && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x08]/.test(value)))).slice(0, 256));
  return properties;
}
export async function describeSource(file, resourceRevision = 0) {
  if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw new Error('WE_SOURCE_PATH_INVALID');
  const full = await realpath(file), root = path.dirname(full);
  const metadataPath = path.join(root, 'project.json');
  const metadata = await boundedJson(metadataPath);
  const type = String(metadata.type || ({ '.exe': 'application', '.mp4': 'video', '.webm': 'video', '.html': 'web', '.pkg': 'scene' })[path.extname(metadata.file || '').toLowerCase()] || '').toLowerCase();
  if (!['video', 'scene', 'web', 'application'].includes(type)) throw new Error('WE_TYPE_UNRECOGNIZED');
  if (typeof metadata.file !== 'string' || path.isAbsolute(metadata.file) || /[\x00-\x1f]/.test(metadata.file))
    throw new Error('WE_PROJECT_RESOURCE_INVALID');
  const resource = await realpath(path.resolve(root, metadata.file));
  const relative = path.relative(root, resource);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('WE_RESOURCE_OUTSIDE_PROJECT');
  const [info, projectInfo] = await Promise.all([stat(resource), stat(metadataPath)]);
  if (!info.isFile()) throw new Error('WE_RESOURCE_NOT_FILE');
  const id = /^\d{1,20}$/.test(path.basename(root)) ? path.basename(root) : createHash('sha256').update(root).digest('hex').slice(0, 16);
  const fingerprint = createHash('sha256').update(JSON.stringify([id, type, resource, info.size, info.mtimeMs,
    projectInfo.mtimeMs, resourceRevision])).digest('hex');
  return { id, type, resource, project: metadataPath, root, size: info.size, fingerprint,
    stamp: `${info.size}:${info.mtimeMs}:${projectInfo.mtimeMs}` };
}
export class WallpaperEngine {
  constructor({ username = '', run = runFile, query = run === runFile ? queryCurrent : null, clock = Date.now } = {}) {
    this.username = username; this.run = run; this.watcher = null; this.configWatcher = null;
    this.resourceRevision = 0; this.watchedRoot = ''; this.configPath = ''; this.dirty = true; this.cliAvailable = null;
    this.query = query; this.clock = clock; this.cliRetryAt = 0;
  }
  async observe(app, settings) {
    if (this.closed) return { running: false };
    if (!app?.running) return { running: false };
    const executable = app.path;
    if (!/^wallpaper(?:32|64)\.exe$/i.test(path.basename(executable))) throw new Error('WE_EXECUTABLE_INVALID');
    const identity = `${app.pid}:${executable}`;
    if (identity !== this.processIdentity) { this.processIdentity = identity; this.cliAvailable = null; this.cliRetryAt = 0; }
    const configPath = path.join(path.dirname(executable), 'config.json');
    if (this.configPath !== configPath) {
      this.configWatcher?.close(); this.configPath = configPath;
      try { this.configWatcher = watch(path.dirname(configPath), (_, name) => {
        if (String(name).toLowerCase() === 'config.json') this.dirty = true;
      }); this.configWatcher.on('error', () => { this.dirty = true; }); } catch { /* polling remains */ }
    }
    let selected, sourceMethod = 'cli';
    try { if (this.cliAvailable === false && this.clock() < this.cliRetryAt) throw new Error('WE_CLI_BACKOFF');
      const { stdout } = this.query ? { stdout: await this.query(executable, settings.monitor) } : await this.run(executable, ['-control', 'getWallpaper', '-monitor', String(settings.monitor)],
        { windowsHide: true, timeout: 4000, maxBuffer: 8192, encoding: 'utf8' });
      selected = stdout.trim().replace(/^"(.*)"$/, '$1');
      if (!selected || selected.includes('\n') || !path.isAbsolute(selected)) selected = null;
      this.cliAvailable = !!selected;
    } catch (error) { selected = null; this.cliAvailable = false;
      if (error.message !== 'WE_CLI_BACKOFF') this.cliRetryAt = this.clock() + 30000;
    }
    if (!selected) {
      sourceMethod = 'config-fallback';
      selected = selectedFromConfig(await boundedJson(configPath, 8 * 1024 * 1024), settings.monitor, this.username);
    }
    const source = await describeSource(selected, this.resourceRevision);
    source.properties = propertiesFromConfig(await boundedJson(configPath, 8 * 1024 * 1024), source.resource, settings.monitor, this.username);
    source.fingerprint = createHash('sha256').update(source.fingerprint + JSON.stringify(Object.entries(source.properties).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    if (this.closed) return { running: false };
    if (source.root !== this.watchedRoot) {
      this.watcher?.close(); this.watchedRoot = source.root;
      try { this.watcher = watch(source.root, { recursive: true }, () => { this.resourceRevision++; this.dirty = true; });
        this.watcher.on('error', () => { this.dirty = true; }); } catch { /* metadata polling remains */ }
    }
    this.dirty = false;
    return { running: true, version: app.version || 'unavailable', sourceMethod, source };
  }
  close() { this.closed = true; this.watcher?.close(); this.configWatcher?.close(); }
}
