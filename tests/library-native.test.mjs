import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseVdf, WallpaperLibrary, propertyDefinitions } from '../src/library.mjs';
import { NativePlayer, inspectMp4Audio, inspectNativeAudio } from '../src/native-player.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';

const temporary = prefix => mkdtemp(path.join(os.tmpdir(), prefix));
async function project(root, name, metadata, files = {}) {
  const directory = path.join(root, name); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'project.json'), JSON.stringify(metadata));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
  return path.join(directory, 'project.json');
}
function box(type, content = Buffer.alloc(0)) { const buffer = Buffer.alloc(8 + content.length); buffer.writeUInt32BE(buffer.length); buffer.write(type, 4, 'ascii'); content.copy(buffer, 8); return buffer; }
function movie(handlers = ['vide']) {
  const tracks = handlers.map(type => { const handler = Buffer.alloc(12); handler.write(type, 8, 'ascii'); return box('trak', box('mdia', box('hdlr', handler))); });
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', Buffer.concat(tracks)), box('mdat', Buffer.alloc(8))]);
}

test('Steam KeyValues recognizes old/new library paths, comments and nested manifests', () => {
  const parsed = parseVdf('"libraryfolders" { // test\n "0" "D:\\\\Steam" "1" { "path" "E:\\\\Games" "apps" { "431960" "1" } } }');
  assert.equal(parsed.libraryfolders['0'], 'D:\\Steam');
  assert.equal(parsed.libraryfolders['1'].path, 'E:\\Games');
  assert.equal(parsed.libraryfolders['1'].apps['431960'], '1');
  assert.throws(() => parseVdf('"libraryfolders" { "0"'), /INVALID/);
  assert.throws(() => parseVdf('}'), /INVALID/);
});

test('library scans all Steam libraries, packed scenes, custom installs and local projects read-only', async () => {
  const root = await temporary('cwb-library-'), primary = path.join(root, 'Steam'), secondary = path.join(root, 'Games');
  await mkdir(path.join(primary, 'steamapps'), { recursive: true }); await mkdir(path.join(secondary, 'steamapps'), { recursive: true });
  const vdf = `"libraryfolders" { "0" { "path" ${JSON.stringify(primary)} } "1" { "path" ${JSON.stringify(secondary)} } }`;
  await writeFile(path.join(primary, 'steamapps', 'libraryfolders.vdf'), vdf);
  await writeFile(path.join(secondary, 'steamapps', 'appmanifest_431960.acf'), '"AppState" { "installdir" "Wallpaper Engine Custom" }');
  const workshop = path.join(secondary, 'steamapps/workshop/content/431960');
  const scene = await project(workshop, '123', { type: 'Scene', title: 'Particle Scene', file: 'scene.json', preview: 'cover.jpg', general: { properties: { glow: { type: 'slider', value: 2, min: 0, max: 5 }, api_token: { type: 'textinput', value: 'secret' } } } }, { 'scene.pkg': 'package', 'cover.jpg': 'cover' });
  await project(path.join(primary, 'steamapps/workshop/content/431960'), '456', { type: 'video', title: 'Silent Video', file: 'clip.mp4' }, { 'clip.mp4': movie() });
  await project(path.join(secondary, 'steamapps/common/Wallpaper Engine Custom/projects/myprojects/category'), 'web', { type: 'web', title: 'My Web', file: 'index.html', preview: '../../outside.jpg' }, { 'index.html': '<div>Hello</div>' });
  const before = await readFile(scene, 'utf8'), library = new WallpaperLibrary({ steamRoots: [primary] });
  const all = await library.refresh(); assert.equal(all.length, 3); assert.equal(library.errors.length, 0);
  assert.equal(library.steamLibraries.length, 2); assert.ok(library.installations.some(value => value.endsWith('Wallpaper Engine Custom')));
  const selected = library.list({ type: 'scene', search: 'particle' }); assert.equal(selected.length, 1); assert.equal(selected[0].packed, true);
  assert.equal(selected[0].properties.glow.max, 5); assert.equal(selected[0].properties.api_token, undefined); assert.ok(selected[0].preview.endsWith('cover.jpg'));
  const source = await library.source(selected[0].id, { glow: 3, unknown: true }); assert.deepEqual(source.properties, { glow: 3 }); assert.equal(source.id, selected[0].id);
  assert.equal(library.list({ type: 'web' })[0].preview, null); assert.equal(library.get('missing'), null);
  assert.equal(await readFile(scene, 'utf8'), before); assert.equal(selected[0].nativePlayback.code, 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE');
  const ids = all.map(item => item.id); assert.deepEqual((await library.refresh()).map(item => item.id), ids);
});

test('published scene fallback never hides a metadata traversal', async () => {
  const root = await temporary('cwb-scene-');
  const file = await project(root, 'project', { type: 'scene', file: '../missing.json' }, { 'scene.pkg': 'package' });
  await assert.rejects(describeSource(file), /OUTSIDE_PROJECT/);
});

test('property definitions retain bounded controls and exclude credentials and executable code', () => {
  const output = propertyDefinitions({ general: { properties: { mode: { type: 'combo', value: 'a', options: [{ label: 'A', value: 'a' }], condition: 'x.value' }, callback: { type: 'script', value: 'code' }, token: { type: 'textinput', value: 'secret' }, position: { type: 'slider', value: Infinity } } } });
  assert.deepEqual(Object.keys(output), ['mode']); assert.equal(output.mode.options[0].label, 'A'); assert.equal(output.mode.condition, 'x.value');
});

test('native MP4 startup admits complete video-only metadata and rejects audio, unknown and damaged files', async () => {
  const root = await temporary('cwb-audio-');
  for (const [name, data, safe] of [['silent.mp4', movie(), true], ['audio.mp4', movie(['vide', 'soun']), false], ['unknown.mp4', movie(['vide', 'text']), false], ['empty.mp4', movie([]), false], ['broken.mp4', Buffer.from('invalid'), false]]) {
    const file = path.join(root, name); await writeFile(file, data); assert.equal((await inspectMp4Audio(file)).safe, safe, name);
  }
  const file = path.join(root, 'oversized-box.mp4'), buffer = Buffer.alloc(8); buffer.writeUInt32BE(1000); buffer.write('ftyp', 4); await writeFile(file, buffer); assert.equal((await inspectMp4Audio(file)).safe, false);
});

test('native player cannot accept a caller-supplied mute proof for arbitrary Scene/Web', async () => {
  const root = await temporary('cwb-native-guard-');
  const file = await project(root, 'scene', { type: 'scene', file: 'scene.json' }, { 'scene.json': '{}' });
  const source = { ...await describeSource(file), nativeMuteVerified: true, nativeAudioProof: { safe: true } };
  const calls = [], player = new NativePlayer({ executable: path.join(root, 'wallpaper64.exe'), run: async (...args) => { calls.push(args); }, frames: { stop() {} } });
  assert.equal((await inspectNativeAudio(source)).safe, false);
  await assert.rejects(player.start(source), /NATIVE_INDEPENDENT_MUTE_UNAVAILABLE/); assert.equal(calls.length, 0);
  await player.stop(); assert.equal(calls.length, 0);
});

test('native lifecycle isolates its title, reuses one renderer and closes only that window', async () => {
  const root = await temporary('cwb-native-lifecycle-'), executable = path.join(root, 'wallpaper64.exe');
  const file = await project(root, 'video', { type: 'video', file: 'clip.mp4', general: { properties: { glow: { type: 'slider', value: 1, min: 0, max: 5 } } } }, { 'clip.mp4': movie() });
  const source = await describeSource(file), commands = [], requests = [], frame = { jpeg: 'frame', width: 640, height: 360 };
  const player = new NativePlayer({ executable, lease: async () => null, run: async (file, args, options) => { commands.push({ file, args, options }); return { stdout: '' }; },
    probe: async () => ({ wallpaperEngine: { running: true, pid: 123, path: executable } }),
    findSurface: async options => { requests.push(options); return { hwnd: '1', parentHwnd: '2', pid: 123, type: 'video' }; },
    frames: { capture: async surface => { assert.equal(surface.hwnd, '2'); assert.equal(surface.nativeTitle, player.title); return frame; }, stop() {} } });
  assert.equal(await player.capture(source, { maxWidth: 640, fps: 30 }), frame);
  assert.equal(await player.capture(source, { maxWidth: 640, fps: 30 }), frame); assert.equal(requests.length, 1);
  await player.applyProperties({ glow: 100, unsupported: true });
  const update = commands.find(command => command.args.some(value => value.includes('applyProperties')));
  assert.ok(update.args.includes('RAW~({"glow":5})~END')); assert.equal(update.options.windowsVerbatimArguments, true);
  assert.ok(update.args.join(' ').includes(`"-location" "${player.title}"`));
  await player.stop(); const close = commands.at(-1); assert.ok(close.args.join(' ').includes(`"closeWallpaper" "-location" "${player.title}"`));
  assert.ok(commands.every(command => !command.args.some(value => /^"(?:mute|unmute|stop|pause|play|openProfile)"$/.test(value))));
  assert.equal(player.surface, null); assert.equal(player.opened, false);
});

test('native preparation failure releases a partially opened popout with a scoped close', async () => {
  const root = await temporary('cwb-native-failure-'), executable = path.join(root, 'wallpaper64.exe');
  const file = await project(root, 'video', { type: 'video', file: 'clip.mp4' }, { 'clip.mp4': movie() });
  const commands = [], player = new NativePlayer({ executable, lease: async () => null, run: async (_file, args) => { commands.push(args.join(' ')); return { stdout: '' }; },
    probe: async () => ({ wallpaperEngine: { running: true, pid: 123, path: executable } }),
    findSurface: async () => { throw new Error('NATIVE_WINDOW_NOT_FOUND'); }, frames: { stop() {} } });
  await assert.rejects(player.start(await describeSource(file)), /NATIVE_WINDOW_NOT_FOUND/);
  assert.equal(commands.length, 2); assert.ok(commands[1].includes(`"closeWallpaper" "-location" "${player.title}"`)); assert.equal(player.opened, false);
});

test('stopping a source after WE exits or restarts cannot relaunch or control the desktop instance', async () => {
  for (const replacement of [null, { running: true, pid: 456 }]) {
    const root = await temporary('cwb-native-owner-'), executable = path.join(root, 'wallpaper64.exe');
    const file = await project(root, 'video', { type: 'video', file: 'clip.mp4' }, { 'clip.mp4': movie() });
    const commands = []; let app = { running: true, pid: 123, path: executable };
    const player = new NativePlayer({ executable, lease: async () => null,
      run: async (_file, args) => { commands.push(args); return { stdout: '' }; }, probe: async () => ({ wallpaperEngine: app }),
      findSurface: async () => ({ hwnd: '1', parentHwnd: '2', pid: 123, type: 'video' }), frames: { stop() {} } });
    await player.start(await describeSource(file));
    app = replacement ? { ...replacement, path: executable } : null;
    await player.stop();
    assert.equal(commands.length, 1, 'Only the original scoped open is permitted.');
    assert.equal(player.opened, false); assert.equal(player.surface, null);
  }
});
