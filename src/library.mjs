import path from 'node:path';
import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { boundedJson, describeSource, isCredentialProperty } from './wallpaper-engine.mjs';
import { runFile } from './platform.mjs';

const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);
const keyOf = value => path.resolve(value).toLowerCase();
const inside = (root, value) => { const relative = path.relative(root, value); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Steam's quoted KeyValues format, including both old and current libraryfolders.
// Interpret only its two quoting escapes; Windows paths must retain backslashes.
export function parseVdf(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('STEAM_VDF_SIZE_INVALID');
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\{|\}|\/\/[^\r\n]*|[^\s{}"]+/g) || [];
  let offset = 0;
  const value = token => token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token;
  const object = (nested = false, depth = 0) => {
    if (depth > 16) throw new Error('STEAM_VDF_DEPTH_INVALID');
    const result = Object.create(null);
    while (offset < tokens.length) {
      let token = tokens[offset++];
      if (token.startsWith('//')) continue;
      if (token === '}') { if (!nested) throw new Error('STEAM_VDF_INVALID'); return result; }
      if (token === '{') throw new Error('STEAM_VDF_INVALID');
      const key = value(token);
      while (tokens[offset]?.startsWith('//')) offset++;
      token = tokens[offset++];
      if (!token || token === '}') throw new Error('STEAM_VDF_INVALID');
      result[key] = token === '{' ? object(true, depth + 1) : value(token);
    }
    if (nested) throw new Error('STEAM_VDF_INVALID');
    return result;
  };
  return object();
}

export async function discoverSteamLibraries({ steamRoots, run = runFile } = {}) {
  let roots = steamRoots;
  if (!roots) {
    roots = [];
    if (process.platform === 'win32') {
      try {
        const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 4000 });
        const match = stdout.match(/SteamPath\s+REG_SZ\s+([^\r\n]+)/i);
        if (match) roots.push(match[1].trim());
      } catch { /* Standard locations remain useful when Steam has no HKCU entry. */ }
      for (const directory of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (directory) roots.push(path.join(directory, 'Steam'));
    }
  }
  const libraries = new Map(), errors = [];
  const add = async directory => {
    if (!validPath(directory)) return;
    try { const resolved = await realpath(directory); if ((await stat(resolved)).isDirectory()) libraries.set(keyOf(resolved), resolved); } catch { /* absent library */ }
  };
  for (const root of roots) await add(root);
  for (const root of [...libraries.values()]) {
    try {
      const config = await boundedText(path.join(root, 'steamapps', 'libraryfolders.vdf'), 2 * 1024 * 1024);
      const folders = parseVdf(config).libraryfolders || {};
      for (const [index, entry] of Object.entries(folders)) if (/^\d+$/.test(index)) await add(typeof entry === 'string' ? entry : entry.path);
    } catch (error) { if (error.code !== 'ENOENT') errors.push({ directory: root, code: 'STEAM_LIBRARY_METADATA_INVALID' }); }
  }
  return { steamLibraries: [...libraries.values()], errors };
}

async function boundedText(file, maximum) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) throw new Error('METADATA_SIZE_INVALID');
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}

export function propertyDefinitions(metadata) {
  const output = Object.create(null);
  for (const [key, raw] of Object.entries(metadata?.general?.properties || {}).slice(0, 256)) {
    if (!/^[a-z0-9_]{1,128}$/i.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || isCredentialProperty(key) || !raw || typeof raw !== 'object') continue;
    if (!['slider', 'bool', 'color', 'combo', 'textinput', 'file', 'directory'].includes(raw.type)) continue;
    const scalar = value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x08]/.test(value));
    const fileProperty = ['file', 'directory'].includes(raw.type), value = fileProperty && raw.value === undefined ? '' : raw.value;
    if (!scalar(value) || (fileProperty && (typeof value !== 'string' || /[\x00-\x1f]/.test(value)))) continue;
    const definition = { type: raw.type, text: String(raw.text || key).slice(0, 256), value };
    if (fileProperty && ['image', 'video'].includes(raw.filetype || raw.fileType)) definition.filetype = raw.filetype || raw.fileType;
    if (raw.type === 'directory') definition.mode = raw.mode === 'fetchall' ? 'fetchall' : 'ondemand';
    for (const field of ['min', 'max', 'step', 'index', 'order', 'precision']) if (typeof raw[field] === 'number' && Number.isFinite(raw[field])) definition[field] = raw[field];
    if (raw.type === 'combo') definition.options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 128).filter(option => option && scalar(option.value)).map(option => ({ label: String(option.label || option.value).slice(0, 256), value: option.value }));
    if (raw.condition) definition.condition = String(raw.condition).slice(0, 512); // Display metadata, never evaluated as code.
    output[key] = definition;
  }
  return output;
}

export const describeLibrarySource = describeSource;

async function projectItem(file, origin) {
  const source = await describeLibrarySource(file), metadata = await boundedJson(source.project);
  let preview = null;
  if (typeof metadata.preview === 'string' && !path.isAbsolute(metadata.preview)) {
    try { const candidate = await realpath(path.resolve(source.root, metadata.preview)); if (inside(source.root, candidate) && (await stat(candidate)).isFile() && /\.(png|jpe?g|gif|webp)$/i.test(candidate)) preview = candidate; } catch { /* No thumbnail is valid metadata too. */ }
  }
  // Include the full project identity: Workshop IDs can be repeated across libraries.
  const id = createHash('sha256').update(keyOf(source.project)).digest('hex').slice(0, 24);
  return { ...source, id, title: String(metadata.title || path.basename(source.root)).slice(0, 256), preview,
    origin, workshopId: origin === 'workshop' ? path.basename(source.root) : null,
    properties: propertyDefinitions(metadata), nativePlayback: { state: 'unverified', code: 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE' } };
}

export async function scanLibrary({ steamRoots, installDirs = [], executable, run = runFile, maxProjects = 20000 } = {}) {
  const discovered = await discoverSteamLibraries({ steamRoots, run });
  const errors = [...discovered.errors], installations = new Map(), projects = new Map();
  const addInstallation = async directory => {
    if (!validPath(directory)) return;
    try { const full = await realpath(directory); if ((await stat(full)).isDirectory()) installations.set(keyOf(full), full); } catch { /* Not installed in this library. */ }
  };
  if (validPath(executable)) await addInstallation(path.dirname(executable));
  for (const directory of installDirs) await addInstallation(directory);
  for (const library of discovered.steamLibraries) {
    await addInstallation(path.join(library, 'steamapps', 'common', 'wallpaper_engine'));
    try {
      const manifest = parseVdf(await boundedText(path.join(library, 'steamapps', 'appmanifest_431960.acf'), 1024 * 1024));
      const directory = manifest.AppState?.installdir;
      if (typeof directory === 'string' && directory && !/[\\/]|\.\./.test(directory)) await addInstallation(path.join(library, 'steamapps', 'common', directory));
    } catch (error) { if (error.code !== 'ENOENT') errors.push({ directory: library, code: 'WE_MANIFEST_INVALID' }); }
  }
  const scan = async (directory, origin, remaining) => {
    if (projects.size >= maxProjects) return;
    let full, entries;
    try { full = await realpath(directory); entries = await readdir(full, { withFileTypes: true }); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) errors.push({ directory, code: 'LIBRARY_DIRECTORY_UNREADABLE' }); return; }
    const project = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'project.json');
    if (project) {
      const file = path.join(full, project.name), key = keyOf(file);
      if (!projects.has(key)) {
        try { projects.set(key, await projectItem(file, origin)); } catch (error) { errors.push({ project: file, code: /^[A-Z_]+$/.test(error.message) ? error.message : 'LIBRARY_PROJECT_INVALID' }); }
      }
      return;
    }
    if (remaining < 1) return;
    // Do not follow directory junctions/symlinks into arbitrary filesystem trees.
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path.join(full, entry.name), origin, remaining - 1);
  };
  for (const library of discovered.steamLibraries) await scan(path.join(library, 'steamapps', 'workshop', 'content', '431960'), 'workshop', 1);
  for (const directory of installations.values()) {
    await scan(path.join(directory, 'projects', 'myprojects'), 'local', 3);
    await scan(path.join(directory, 'projects', 'defaultprojects'), 'built-in', 2);
  }
  if (projects.size >= maxProjects) errors.push({ code: 'LIBRARY_PROJECT_LIMIT_REACHED' });
  return { items: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title)), installations: [...installations.values()], steamLibraries: discovered.steamLibraries, errors };
}

export class WallpaperLibrary {
  constructor(options = {}) { this.options = options; this.items = []; this.errors = []; this.installations = []; this.steamLibraries = []; }
  async refresh(options = {}) { Object.assign(this, await scanLibrary({ ...this.options, ...options })); this.refreshedAt = new Date().toISOString(); return this.list(); }
  list({ search = '', type = '' } = {}) { const query = String(search).trim().toLowerCase(); return this.items.filter(item => (!type || type === 'all' || item.type === type) && (!query || `${item.title}\n${item.workshopId || ''}`.toLowerCase().includes(query))); }
  get(id) { return this.items.find(item => item.id === id) || null; }
  async source(id, properties = {}) {
    const item = this.get(id); if (!item) throw new Error('LIBRARY_ITEM_NOT_FOUND');
    const source = await describeLibrarySource(item.project);
    source.id = item.id; source.title = item.title;
    source.properties = Object.fromEntries(Object.entries(properties).filter(([key]) => Object.hasOwn(item.properties, key)));
    source.fingerprint = createHash('sha256').update(source.fingerprint + JSON.stringify(source.properties)).digest('hex');
    return source;
  }
}
