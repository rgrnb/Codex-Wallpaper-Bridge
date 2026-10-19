import path from 'node:path';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { runFile, nativeProbe, NativeFrames, HOST } from './platform.mjs';
import { boundedJson, describeSource } from './wallpaper-engine.mjs';
import { propertyDefinitions } from './library.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const STOCK_SCENE_TREE = '1f4cc4f912979e96164049094d5495ca83ca77809400b992a039132d80fc282b';
const WEB_FIXTURE = '1294903baa570d021da8058de8bb087b650a8071f40b16241c4491a79a92b249';
const WEB_FIXTURE_PROJECT = 'dd95ec1c8b10af869d24769d5287181056d8c06f67f99d7c8cc6320659df3911';
const blocked = (detail = 'No atomic per-window mute is available for this source.') => ({ safe: false, code: 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE', detail });

// Parse only container metadata, not mdat payload. A video stream with no sound
// handler cannot create an audible track. Unknown/malformed containers fail shut.
export async function inspectMp4Audio(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat(); let inspected = 0;
    const read = async (position, length) => {
      if (length < 0 || inspected + length > 8 * 1024 * 1024 || position + length > size) throw new Error('MP4_METADATA_INVALID');
      inspected += length;
      const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error('MP4_METADATA_INVALID');
      return buffer;
    };
    const boxes = async (begin, end) => {
      const result = [];
      for (let offset = begin, count = 0; offset < end; count++) {
        if (count > 10000 || end - offset < 8) throw new Error('MP4_METADATA_INVALID');
        const header = await read(offset, 8); let length = header.readUInt32BE(), headerLength = 8;
        if (length === 1) { const extended = await read(offset + 8, 8); const large = extended.readBigUInt64BE(); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4_METADATA_INVALID'); length = Number(large); headerLength = 16; }
        if (length === 0) length = end - offset;
        if (length < headerLength || offset + length > end) throw new Error('MP4_METADATA_INVALID');
        result.push({ type: header.toString('ascii', 4, 8), start: offset + headerLength, end: offset + length }); offset += length;
      }
      return result;
    };
    const root = await boxes(0, size), movies = root.filter(box => box.type === 'moov');
    if (movies.length !== 1 || !root.some(box => box.type === 'ftyp')) return blocked('Unrecognized MP4 movie layout.');
    const movie = await boxes(movies[0].start, movies[0].end), tracks = movie.filter(box => box.type === 'trak'), handlers = [];
    if (!tracks.length || movie.some(box => ['mvex', 'rmra'].includes(box.type))) return blocked('Fragmented/reference MP4 needs separate verification.');
    for (const track of tracks) {
      const children = await boxes(track.start, track.end), media = children.filter(box => box.type === 'mdia');
      if (children.some(box => ['tref'].includes(box.type)) || media.length !== 1) return blocked('Unrecognized MP4 track structure.');
      const mediaBoxes = await boxes(media[0].start, media[0].end), handler = mediaBoxes.filter(box => box.type === 'hdlr');
      if (handler.length !== 1 || handler[0].end - handler[0].start < 12) return blocked('MP4 track handler is missing.');
      const bytes = await read(handler[0].start, 12); handlers.push(bytes.toString('ascii', 8, 12));
    }
    return handlers.includes('vide') && handlers.every(type => type === 'vide')
      ? { safe: true, code: 'NATIVE_SILENT_VIDEO_VERIFIED', evidence: 'MP4 track handlers contain video only.', handlers }
      : blocked(handlers.includes('soun') ? 'Video contains an audio track; native startup cannot be independently muted atomically.' : 'Unknown MP4 track type.');
  } catch { return blocked('MP4 audio metadata could not be verified.'); } finally { await handle.close(); }
}

export async function sourceTreeDigest(root) {
  const files = []; let totalBytes = 0;
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('NATIVE_SOURCE_TREE_UNVERIFIED');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name !== 'preview.jpg') {
        if (files.length >= 512) throw new Error('NATIVE_SOURCE_TREE_UNVERIFIED');
        const info = await stat(file); totalBytes += info.size;
        if (totalBytes > 16 * 1024 * 1024) throw new Error('NATIVE_SOURCE_TREE_UNVERIFIED');
        files.push(file);
      }
    }
  };
  await visit(root);
  const hash = createHash('sha256');
  for (const file of files.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b), 'en'))) {
    hash.update(path.relative(root, file).split(path.sep).join('/') + '\0'); hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

export async function inspectNativeAudio(source) {
  if (!source?.resource || !source?.project || !source?.root) return blocked();
  try {
    const canonical = await describeSource(source.project);
    if (canonical.type !== source.type || path.resolve(canonical.resource) !== path.resolve(source.resource) || path.resolve(canonical.root) !== path.resolve(source.root)) return blocked('The source does not match its project metadata.');
  } catch { return blocked('The native project could not be validated.'); }
  if (source.type === 'video' && /\.(mp4|m4v|mov)$/i.test(source.resource)) return inspectMp4Audio(source.resource);
  if (source.type === 'scene' && path.extname(source.resource).toLowerCase() === '.json') {
    try {
      if (await sourceTreeDigest(source.root) === STOCK_SCENE_TREE) return { safe: true, code: 'NATIVE_SILENT_STOCK_SCENE_VERIFIED', evidence: 'Exact reviewed Shimmering Particles project tree, WE 2.8.0.42.' };
    } catch { /* A changed/packed scene must never inherit the stock proof. */ }
  }
  if (source.type === 'web') {
    try {
      const info = await stat(source.resource);
      if (info.size <= 256 * 1024 && digest(await readFile(source.resource)) === WEB_FIXTURE && digest(await readFile(source.project)) === WEB_FIXTURE_PROJECT)
        return { safe: true, code: 'NATIVE_SILENT_WEB_FIXTURE_VERIFIED', evidence: 'Exact reviewed self-contained Canvas fixture; no audio or external resources.' };
    } catch { /* General Web scripts can synthesize audio even without audio assets. */ }
  }
  return blocked(source.type === 'scene' ? 'This Scene package has no verified independent mute path. Desktop/global mute is prohibited.' : undefined);
}

// This helper only finds and parks a unique Bridge-created pop-out. The title,
// owner PID, executable path and render class must all match. It never reparents
// a desktop wallpaper, minimizes another window, or captures a monitor.
const WINDOW_HELPER = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class CwbIndependentSurface {
  delegate bool Visit(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visitor, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visit visitor, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int length);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
  [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr window,int index,IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  static string Text(IntPtr window,bool title){var text=new StringBuilder(512);if(title)GetWindowText(window,text,512);else GetClassName(window,text,512);return text.ToString();}
  public static Dictionary<string,object> Find(int owner,string executable,string title,string type,int width,int height,bool preview) {
    if(!title.StartsWith("CodexBridgeNative-"))throw new Exception("NATIVE_WINDOW_TITLE_INVALID");
    using(var process=Process.GetProcessById(owner))if(!String.Equals(Path.GetFullPath(process.MainModule.FileName),Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase))throw new Exception("NATIVE_WINDOW_OWNER_INVALID");
    for(int attempt=0;attempt<60;attempt++){
      var tops=new List<IntPtr>();
      EnumWindows(delegate(IntPtr window,IntPtr p){uint pid;GetWindowThreadProcessId(window,out pid);if(pid==owner&&Text(window,true)==title&&Text(window,false)=="WPEOverlappedWallpaper")tops.Add(window);return true;},IntPtr.Zero);
      if(tops.Count>1)throw new Exception("NATIVE_WINDOW_AMBIGUOUS");
      if(tops.Count==1){
        var children=new List<IntPtr>();string expected=type=="scene"?"WPEDesktopDX11Window":type=="web"?"WPEDesktopCEFWindow":"WPEVideoWallpaper";
        EnumChildWindows(tops[0],delegate(IntPtr window,IntPtr p){uint pid;GetWindowThreadProcessId(window,out pid);if(pid==owner&&Text(window,false)==expected)children.Add(window);return true;},IntPtr.Zero);
        if(children.Count==1){
          int old=GetWindowLong(tops[0],-20);if(!preview)SetWindowLongPtr(tops[0],-20,new IntPtr((old|0x08000080)&~0x00040000));
          // A visible offscreen window preserves rendering; SW_HIDE/minimize do not.
          if(!SetWindowPos(tops[0],preview?IntPtr.Zero:new IntPtr(1),preview?100:-10000,preview?100:-10000,width,height,0x30))throw new Exception("NATIVE_WINDOW_PARK_FAILED");
          Thread.Sleep(100);
          Rect rect;if(!GetClientRect(children[0],out rect)||rect.Right<1||rect.Bottom<1)throw new Exception("NATIVE_WINDOW_SIZE_INVALID");
          return new Dictionary<string,object>{{"hwnd",children[0].ToInt64().ToString()},{"pid",owner},{"type",type},{"className",expected},{"width",rect.Right},{"height",rect.Bottom},{"parentHwnd",tops[0].ToInt64().ToString()},{"windowTitle",title}};
        }
      }
      Thread.Sleep(100);
    }
    throw new Exception("NATIVE_WINDOW_NOT_FOUND");
  }
}`;

export async function findNativeSurface({ executable, pid, title, type, width, height, preview = false, run = runFile }) {
  const input = Buffer.from(JSON.stringify({ executable, pid, title, type, width, height, preview }), 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${WINDOW_HELPER}\n'@\n$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json\n[CwbIndependentSurface]::Find([int]$p.pid,[string]$p.executable,[string]$p.title,[string]$p.type,[int]$p.width,[int]$p.height,[bool]$p.preview)|ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12000, maxBuffer: 65536 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export class NativePlayer {
  constructor({ executable = '', run = runFile, probe = nativeProbe, frames = new NativeFrames(), findSurface = findNativeSurface, lease } = {}) {
    this.executable = executable; this.run = run; this.probe = probe; this.frames = frames; this.findSurface = findSurface;
    this.title = `CodexBridgeNative-${randomUUID()}`; this.surface = null; this.source = null; this.queue = Promise.resolve();
    this.sessions = 0;
    this.lease = lease || (async (app, title) => {
      const { stdout } = await this.run(HOST, ['--start-native-lease', String(process.pid), String(app.pid), this.executable, title], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
      const result = JSON.parse(stdout); if (!Number.isInteger(result.pid) || result.pid < 1) throw new Error('NATIVE_LEASE_START_FAILED'); return result.pid;
    });
  }
  serial(action) { const operation = this.queue.then(action, action); this.queue = operation.catch(() => {}); return operation; }
  command(args) {
    const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
    // WE parses RAW~ delimiters from the native command line itself; ordinary
    // argv escaping inserts backslashes into the JSON and makes it invalid.
    return this.run(this.executable, args.map(value => String(value).startsWith('RAW~(') ? value : quote(value)),
      { cwd: path.dirname(this.executable), windowsVerbatimArguments: true, windowsHide: true, timeout: 7000, maxBuffer: 65536 });
  }
  async ensureEngine() {
    let app = (await this.probe()).wallpaperEngine;
    if (!this.executable && app?.path) this.executable = app.path;
    if (!path.isAbsolute(this.executable) || !/^wallpaper(?:32|64)\.exe$/i.test(path.basename(this.executable))) throw new Error('WE_EXECUTABLE_INVALID');
    if (!app?.running) {
      // Start the existing installation with its saved desktop choice. No
      // monitor-targeted open command or desktop configuration write is issued.
      await this.run(HOST, ['--start-we', this.executable], { windowsHide: true, timeout: 7000, maxBuffer: 8192 });
      for (let attempt = 0; attempt < 12 && !app?.running; attempt++) { await delay(350); app = (await this.probe()).wallpaperEngine; }
    }
    if (!app?.running || path.resolve(app.path).toLowerCase() !== path.resolve(this.executable).toLowerCase()) throw new Error('WE_NATIVE_PROCESS_UNAVAILABLE');
    return app;
  }
  async _start(source, { properties = source?.properties || {}, policy = {}, preview = false } = {}) {
    if (this.source?.fingerprint === source?.fingerprint && this.surface) return this.surface;
    const safety = await inspectNativeAudio(source); this.audioSafety = safety;
    if (!safety.safe) {
      if (this.source?.resource === source?.resource) await this._stop().catch(() => {});
      const error = new Error(safety.code); error.detail = safety.detail; throw error;
    }
    const app = await this.ensureEngine();
    if (this.surface || this.opened) await this._stop();
    if (this.sessions++) this.title = `CodexBridgeNative-${randomUUID()}`;
    const width = Math.max(320, Math.min(1920, Math.round(policy.maxWidth || 1280))), height = Math.max(180, Math.min(2160, Math.round(policy.height || width * 9 / 16)));
    try {
      this.leasePid = await this.lease(app, this.title);
      this.opened = true; this.openedOwner = { pid: app.pid, executable: this.executable };
      await this.command(['-control', 'openWallpaper', '-file', source.type === 'video' ? source.resource : source.project,
        '-playInWindow', this.title, '-width', String(width), '-height', String(height), '-x', '-10000', '-y', '-10000', ...(preview ? [] : ['-borderless'])]);
      this.surface = await this.findSurface({ executable: this.executable, pid: app.pid, title: this.title, type: source.type, width, height, preview, run: this.run });
      if (source.type !== 'scene') this.surface = { ...this.surface, hwnd: this.surface.parentHwnd, nativeTitle: this.title };
      this.source = source;
      await this._applyProperties(properties);
      return this.surface;
    } catch (error) { await this._stop().catch(() => {}); throw error; }
  }
  start(source, options = {}) { return this.serial(() => this._start(source, options)); }
  async _applyProperties(properties) {
    if (!this.source || !this.surface) throw new Error('NATIVE_PLAYER_NOT_RUNNING');
    const definitions = propertyDefinitions(await boundedJson(this.source.project)), values = {};
    for (const [key, value] of Object.entries(properties || {})) {
      const definition = definitions[key]; if (!definition) continue;
      if (definition.type === 'bool' && typeof value === 'boolean') values[key] = value;
      if (definition.type === 'slider' && typeof value === 'number' && Number.isFinite(value)) values[key] = Math.max(definition.min ?? -1e6, Math.min(definition.max ?? 1e6, value));
      if (['color', 'textinput', 'combo'].includes(definition.type) && typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value)) values[key] = value;
    }
    const json = JSON.stringify(values);
    if (/\)~END|RAW~\(/i.test(json)) throw new Error('NATIVE_PROPERTY_VALUE_INVALID');
    if (Object.keys(values).length) await this.command(['-control', 'applyProperties', '-location', this.title, '-properties', `RAW~(${json})~END`]);
  }
  applyProperties(properties) { return this.serial(() => this._applyProperties(properties)); }
  capture(source, policy = {}) { return this.serial(async () => {
    const surface = await this._start(source, { properties: source.properties, policy });
    try { return await this.frames.capture(surface, policy); }
    catch (error) { await this._stop().catch(() => {}); throw error; }
  }); }
  async _stop() {
    this.frames.stop(); this.surface = null; this.source = null;
    if (this.opened) {
      const app = (await this.probe()).wallpaperEngine;
      // A control invocation can start WE. Closing a vanished source must not
      // relaunch it or send stale commands to a replacement desktop instance.
      if (app?.running && app.pid === this.openedOwner?.pid &&
          path.resolve(app.path).toLowerCase() === path.resolve(this.openedOwner.executable).toLowerCase())
        await this.command(['-control', 'closeWallpaper', '-location', this.title]);
      this.opened = false; this.openedOwner = null;
    }
  }
  stop() { return this.serial(() => this._stop()); }
}
