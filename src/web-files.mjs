import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';

const IMAGES = new Set(['.jpeg', '.jpg', '.png', '.pnga', '.bmp', '.gif', '.svg', '.webp']);
const VIDEOS = new Set(['.webm', '.ogg', '.ogv', '.mp4', '.m4v']);
const contains = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Only user-selected file/directory properties may grant access outside the
// project. A wallpaper-authored absolute default cannot grant that access.
export class WebFiles {
  constructor() { this.files = new Map(); this.properties = {}; this.directories = new Map(); this.byPath = new Map(); }
  async prepare(source, definitions) {
    const root = await realpath(source.root); this.properties = structuredClone(definitions);
    for (const [key, property] of Object.entries(this.properties)) {
      if (!property || typeof property !== 'object') continue;
      const selected = Object.hasOwn(source.properties || {}, key);
      if (selected) property.value = source.properties[key];
      if (!['file', 'directory'].includes(property.type) || !property.value) continue;
      if (typeof property.value !== 'string' || property.value.length > 4096 || /[\0\r\n]/.test(property.value)) throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE');
      let file;
      try { file = await realpath(path.resolve(root, property.value)); } catch { throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE'); }
      if (!selected && !contains(root, file)) throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE');
      property.value = file.replaceAll('\\', '/');
      if (property.type === 'file') {
        if (!(await stat(file)).isFile()) throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE');
        this.add(file, file);
      } else {
        if (!(await stat(file)).isDirectory()) throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE');
        this.directories.set(key, { path: file, mode: property.mode === 'fetchall' ? 'fetchall' : 'ondemand',
          type: String(property.filetype || property.fileType || '').toLowerCase(), files: new Map() });
      }
    }
    await this.refresh(); return this.properties;
  }
  add(file, guard) {
    let id = this.byPath.get(file);
    if (!id) { id = randomBytes(16).toString('hex'); this.byPath.set(file, id); this.files.set(id, { file, guard }); }
    return id;
  }
  async refresh() {
    const events = [];
    for (const [key, directory] of this.directories) {
      let entries; try { entries = await readdir(directory.path, { withFileTypes: true }); } catch { throw new Error('WEB_PROPERTY_FILE_UNAVAILABLE'); }
      if (entries.length > 4096) throw new Error('WEB_PROPERTY_DIRECTORY_TOO_LARGE');
      const next = new Map();
      for (const entry of entries) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!(directory.type === 'image' ? IMAGES : directory.type === 'video' ? VIDEOS : new Set([...IMAGES, ...VIDEOS])).has(extension)) continue;
        const candidate = path.join(directory.path, entry.name);
        let file, info; try { file = await realpath(candidate); info = await stat(file); } catch { continue; }
        if (!contains(directory.path, file) || !info.isFile()) continue;
        if (next.size >= 2048) throw new Error('WEB_PROPERTY_DIRECTORY_TOO_LARGE');
        next.set(file, `${info.size}:${info.mtimeMs}`); this.add(file, directory.path);
      }
      if (directory.mode === 'fetchall') {
        const changed = [...next].filter(([file, stamp]) => directory.files.get(file) !== stamp).map(([file]) => file.replaceAll('\\', '/'));
        const removed = [...directory.files.keys()].filter(file => !next.has(file)).map(file => file.replaceAll('\\', '/'));
        if (changed.length) events.push({ key, changed });
        if (removed.length) events.push({ key, removed });
      }
      for (const file of directory.files.keys()) if (!next.has(file)) { const id = this.byPath.get(file); this.byPath.delete(file); this.files.delete(id); }
      directory.files = next;
    }
    return events;
  }
  random(key) {
    const directory = this.directories.get(key);
    if (!directory || directory.mode !== 'ondemand') return '';
    const files = [...directory.files.keys()]; return files.length ? files[randomInt(files.length)].replaceAll('\\', '/') : '';
  }
  aliases(baseUrl) {
    return Object.fromEntries([...this.files].map(([id, value]) => [value.file.replaceAll('\\', '/').replace(/^\//, '').toLowerCase(), `${baseUrl}~cwb-file/${id}/${encodeURIComponent(path.basename(value.file))}`]));
  }
  initialDirectories() {
    return [...this.directories].filter(([, value]) => value.mode === 'fetchall').map(([key, value]) => ({ key, changed: [...value.files.keys()].map(file => file.replaceAll('\\', '/')) }));
  }
  async resolve(id) {
    const authorized = this.files.get(id); if (!authorized) return null;
    try {
      const actual = await realpath(authorized.file);
      // Revalidate junctions/symlinks at request time rather than trusting the scan.
      if (actual !== authorized.file || !contains(authorized.guard, actual)) return null;
      return actual;
    } catch { return null; }
  }
}
