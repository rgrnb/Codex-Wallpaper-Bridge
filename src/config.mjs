import { mkdir, readFile, rename, writeFile, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  schemaVersion: 1, enabled: false, startup: false, performance: 'balanced', autoAdjust: true,
  fpsLimit: 60, effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 },
  debug: false, monitor: 0, wallpaperEnginePath: '', cdpPort: 9336,
  selectedWallpaper: '', wallpaperProfiles: {},
  experimentalWindowFrames: false, allowCandidateAdapter: false,
});
export const PROFILES = Object.freeze({
  performance: { fps: 30, maxWidth: 960, jpegQuality: 65, pixelBudget: 921600 },
  balanced: { fps: 120, maxWidth: 1280, jpegQuality: 78, pixelBudget: 2073600 },
  quality: { fps: 120, maxWidth: 1920, jpegQuality: 88, pixelBudget: 3686400 },
});
function number(value, min, max, name, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`INVALID_SETTING:${name}`);
  return value;
}
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_SETTINGS');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`UNKNOWN_SETTING:${key}`);
  if (input.effects !== undefined && (!input.effects || typeof input.effects !== 'object' || Array.isArray(input.effects)))
    throw new Error('INVALID_SETTING:effects');
  const s = { ...DEFAULTS, ...input, effects: { ...DEFAULTS.effects, ...input.effects } };
  if (s.schemaVersion !== 1) throw new Error('UNSUPPORTED_SETTINGS_SCHEMA');
  for (const key of ['enabled', 'startup', 'autoAdjust', 'debug', 'experimentalWindowFrames', 'allowCandidateAdapter'])
    if (typeof s[key] !== 'boolean') throw new Error(`INVALID_SETTING:${key}`);
  if (!Object.hasOwn(PROFILES, s.performance)) throw new Error('INVALID_SETTING:performance');
  number(s.fpsLimit, 0, 120, 'fpsLimit', true);
  number(s.monitor, 0, 31, 'monitor', true);
  number(s.cdpPort, 1024, 65535, 'cdpPort', true);
  if (typeof s.wallpaperEnginePath !== 'string' || s.wallpaperEnginePath.length > 1024 || /[\x00-\x1f]/.test(s.wallpaperEnginePath))
    throw new Error('INVALID_SETTING:wallpaperEnginePath');
  if (typeof s.selectedWallpaper !== 'string' || s.selectedWallpaper.length > 2048 || /[\x00-\x1f]/.test(s.selectedWallpaper) ||
      (s.selectedWallpaper && (!path.isAbsolute(s.selectedWallpaper) || path.basename(s.selectedWallpaper).toLowerCase() !== 'project.json')))
    throw new Error('INVALID_SETTING:selectedWallpaper');
  if (!s.wallpaperProfiles || typeof s.wallpaperProfiles !== 'object' || Array.isArray(s.wallpaperProfiles) || Object.keys(s.wallpaperProfiles).length > 512)
    throw new Error('INVALID_SETTING:wallpaperProfiles');
  s.wallpaperProfiles = Object.fromEntries(Object.entries(s.wallpaperProfiles).map(([id, profile]) => {
    if (!/^[a-z0-9_-]{1,128}$/i.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !profile || typeof profile !== 'object' || Array.isArray(profile) ||
        Object.keys(profile).some(key => !['display', 'properties'].includes(key))) throw new Error('INVALID_WALLPAPER_PROFILE');
    const display = { zoom: 1, positionX: 0.5, positionY: 0.5, ...profile.display };
    if (Object.keys(display).some(key => !['zoom', 'positionX', 'positionY'].includes(key))) throw new Error('INVALID_DISPLAY_SETTING');
    number(display.zoom, 1, 4, 'zoom'); number(display.positionX, 0, 1, 'positionX'); number(display.positionY, 0, 1, 'positionY');
    const properties = profile.properties ?? {};
    if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 256) throw new Error('INVALID_WALLPAPER_PROPERTIES');
    for (const [key, value] of Object.entries(properties)) if (!/^[a-z0-9_]{1,128}$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !(['boolean', 'number', 'string'].includes(typeof value)) || (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && (value.length > 4096 || /[\x00-\x08]/.test(value)))) throw new Error('INVALID_WALLPAPER_PROPERTY');
    return [id, { display, properties: { ...properties } }];
  }));
  for (const key of Object.keys(s.effects)) if (!Object.hasOwn(DEFAULTS.effects, key)) throw new Error(`UNKNOWN_EFFECT:${key}`);
  number(s.effects.opacity, 0, 1, 'opacity'); number(s.effects.blur, 0, 30, 'blur');
  number(s.effects.brightness, 0.1, 2, 'brightness'); number(s.effects.contrast, 0.1, 2, 'contrast');
  return s;
}
export function effectivePolicy(s, visibleWindows = 1, overloaded = false, displayHz = 60) {
  const p = PROFILES[s.performance];
  // Source decoding/capture is shared or handled natively in each renderer.
  // Window count alone is not evidence of overload and must not make playback
  // stutter. Keep spatial/encoding quality fixed; react to measured load only.
  const adjustment = s.autoAdjust && overloaded ? 2 : 1;
  const ceiling = s.fpsLimit === 0 ? Math.min(120, Math.max(30, displayHz || 60)) : s.fpsLimit;
  return { ...p, fps: Math.max(1, Math.floor(Math.min(ceiling, p.fps) / adjustment)),
    paused: visibleWindows === 0, autoAdjusted: adjustment > 1 };
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  // MSIX AppData redirection can put the logical target and a temporary filename on
  // different volumes. Resolve the existing directory before creating either name.
  file = path.join(await realpath(path.dirname(file)), path.basename(file));
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); break; }
    catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(500, 20 * 2 ** attempt)));
    }
  }
}
export class SettingsStore {
  constructor(root) { this.file = path.join(root, 'settings.json'); this.value = validateSettings({}); }
  async load() {
    try { this.value = validateSettings(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') await atomicJson(this.file, this.value); else {
      try { this.value = validateSettings(JSON.parse(await readFile(`${this.file}.previous`, 'utf8'))); }
      catch { this.value = validateSettings({}); }
      this.value.enabled = false; this.recovered = true;
      await atomicJson(this.file, this.value);
    } }
    return this.value;
  }
  async save(input) {
    const next = validateSettings(input);
    await atomicJson(`${this.file}.previous`, this.value);
    await atomicJson(this.file, next); this.value = next; return next;
  }
}
