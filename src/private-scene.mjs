import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { boundedJson, describeSource } from './wallpaper-engine.mjs';

const BASE = '.bridge-scene-runtime', MARKER = '.bridge-scene.json', PROFILE = 'scene-project-hardlink-view-v1';
const MAX_FILES = 8192, MAX_DIRECTORIES = 2048, MAX_DEPTH = 24, MAX_BYTES = 64n * 1024n ** 3n;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invalid = (code = 'SCENE_VIEW_CLEANUP_SCOPE_INVALID') => { throw new Error(code); };
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const sameIdentity = (info, expected) => expected && String(info.dev) === expected.dev && String(info.ino) === expected.ino;
const contains = (parent, file) => { const relative = path.relative(parent, file); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' &&
    !/[\\/<>:"|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function safeRelative(value) {
  return typeof value === 'string' && !value.includes('\\') && !path.isAbsolute(value) && value.length <= 4096 && value.split('/').every(safeName);
}
function absoluteSpelling(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value) &&
    value.split(/[\\/]/).every(part => part !== '.' && part !== '..') && !/[. ]$/.test(value);
}
async function canonicalDirectory(directory, code) {
  if (!absoluteSpelling(directory)) invalid(code);
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(directory), directory) || info.ino === 0n) invalid(code);
  return info;
}
const cachePath = relative => /^shaders\/blobs[^/]*(?:\/|$)/i.test(relative);
const cacheRoot = relative => /^shaders\/blobs[^/]*$/i.test(relative);

async function inventory(sourceRoot, volume) {
  const files = [], directories = [], cacheRoots = [], names = new Set(); let bytes = 0n, count = 0;
  const visit = async (directory, prefix = '', depth = 0) => {
    if (depth > MAX_DEPTH || ++count > MAX_DIRECTORIES) invalid('SCENE_VIEW_SOURCE_LIMIT');
    const folder = await canonicalDirectory(directory, 'SCENE_VIEW_SOURCE_ALIAS_UNVERIFIED');
    if (folder.dev !== volume) invalid('SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!safeName(entry.name)) invalid('SCENE_VIEW_SOURCE_PATH_UNVERIFIED');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, folded = relative.toLowerCase();
      if (names.has(folded) || (!prefix && folded === MARKER)) invalid('SCENE_VIEW_SOURCE_PATH_UNVERIFIED');
      names.add(folded);
      const original = path.join(sourceRoot, relative), info = await lstat(original, { bigint: true });
      if (info.isSymbolicLink() || !same(await realpath(original), original)) invalid('SCENE_VIEW_SOURCE_LINK_UNVERIFIED');
      if (info.dev !== volume) invalid('SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED');
      if (info.isDirectory()) {
        if (cacheRoot(relative)) cacheRoots.push(relative);
        if (!cachePath(relative) || cacheRoot(relative)) directories.push(relative);
        // Inspect excluded cache trees too, without referring to or copying any
        // of their files. A source junction must never escape this audit.
        await visit(original, relative, depth + 1);
      } else if (info.isFile()) {
        if (cacheRoot(relative)) invalid('SCENE_VIEW_SOURCE_CACHE_LAYOUT_INVALID');
        if (++files.total > MAX_FILES) invalid('SCENE_VIEW_SOURCE_LIMIT');
        bytes += info.size; if (bytes > MAX_BYTES) invalid('SCENE_VIEW_SOURCE_LIMIT');
        if (!cachePath(relative)) files.push({ relative, original, ...identity(info), size: String(info.size), modifiedNs: String(info.mtimeNs) });
      } else invalid('SCENE_VIEW_SOURCE_TYPE_UNVERIFIED');
    }
  };
  files.total = 0; await visit(sourceRoot);
  const shaderDirectory = directories.find(relative => relative.toLowerCase() === 'shaders') || 'shaders';
  if ([...names].some(name => name === 'shaders') && !directories.some(relative => relative.toLowerCase() === 'shaders')) invalid('SCENE_VIEW_SOURCE_CACHE_LAYOUT_INVALID');
  if (!directories.includes(shaderDirectory)) directories.push(shaderDirectory);
  if (!cacheRoots.some(relative => relative.toLowerCase() === 'shaders/blobssm40')) cacheRoots.push(`${shaderDirectory}/blobsSM40`);
  for (const relative of cacheRoots) if (!directories.includes(relative)) directories.push(relative);
  // The synthetic cache directories are part of the same cleanup manifest
  // budget. Reject before creating a view whose own marker could not pass.
  if (directories.length > MAX_DIRECTORIES) invalid('SCENE_VIEW_SOURCE_LIMIT');
  directories.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  files.sort((a, b) => a.relative.localeCompare(b.relative)); cacheRoots.sort();
  return { references: [...files], directories, cacheRoots, sourceBytes: String(bytes) };
}

// Caller first verifies the installed engine with inspectIsolatedEngine. Every
// project directory is private; media is referenced only through file hardlinks.
// No source attributes, ACLs, metadata files or cache entries are modified.
export async function sceneViewLocation(source, { installed, token } = {}) {
  if (source?.type !== 'scene' || !UUID.test(token) || !absoluteSpelling(installed)) invalid('SCENE_VIEW_SOURCE_INVALID');
  const installedInfo = await canonicalDirectory(installed, 'SCENE_VIEW_INSTALLED_ALIAS_UNVERIFIED');
  const sourceInfo = await canonicalDirectory(source.root, 'SCENE_VIEW_SOURCE_ALIAS_UNVERIFIED');
  // Hardlinks stay on the source volume. For a separate Steam/library volume,
  // use a private sibling view; never link a source directory or copy media.
  const anchor = sourceInfo.dev === installedInfo.dev ? installed : path.dirname(source.root);
  const anchorInfo = await canonicalDirectory(anchor, 'SCENE_VIEW_BASE_ALIAS_UNVERIFIED');
  if (anchorInfo.dev !== sourceInfo.dev) invalid('SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED');
  const root = path.join(anchor, BASE, token);
  if (contains(source.root, path.dirname(root)) || contains(path.dirname(root), source.root)) invalid('SCENE_VIEW_SOURCE_OVERLAP');
  return { root, token, installed, anchor, sourceRoot: source.root, sourceProject: source.project, sourceResource: source.resource,
    crossVolumeEngine: sourceInfo.dev !== installedInfo.dev };
}

export async function stagePrivateScene(source, { installed, token = randomUUID(), linkFile = link } = {}) {
  const planned = await sceneViewLocation(source, { installed, token });
  const sourceInfo = await canonicalDirectory(source.root, 'SCENE_VIEW_SOURCE_ALIAS_UNVERIFIED');
  const canonical = await describeSource(source.project);
  if (canonical.type !== 'scene' || !same(canonical.root, source.root) || !same(canonical.project, source.project) || !same(canonical.resource, source.resource)
    || !absoluteSpelling(source.project) || !absoluteSpelling(source.resource)) invalid('SCENE_VIEW_SOURCE_INVALID');
  const root = planned.root, base = path.dirname(root);
  if (contains(source.root, base) || contains(base, source.root)) invalid('SCENE_VIEW_SOURCE_OVERLAP');
  const tree = await inventory(source.root, sourceInfo.dev);
  const resourceRelative = path.relative(source.root, source.resource).split(path.sep).join('/'), projectRelative = path.relative(source.root, source.project).split(path.sep).join('/');
  if (![resourceRelative, projectRelative].every(relative => tree.references.some(item => item.relative === relative))) invalid('SCENE_VIEW_SOURCE_INVALID');
  await mkdir(base, { recursive: true });
  const baseInfo = await canonicalDirectory(base, 'SCENE_VIEW_BASE_ALIAS_UNVERIFIED');
  await mkdir(root);
  const rootInfo = await canonicalDirectory(root, 'SCENE_VIEW_RUNTIME_ALIAS_UNVERIFIED');
  const runtime = { ...planned,
    project: path.join(root, projectRelative), resource: path.join(root, resourceRelative), copiedMediaBytes: 0, referencedFiles: tree.references.length, cacheRoots: tree.cacheRoots };
  const marker = { profile: PROFILE, token, installed, sourceRoot: source.root, sourceProject: source.project, sourceResource: source.resource,
    rootIdentity: identity(rootInfo), baseIdentity: identity(baseInfo), ...tree };
  try { await writeFile(path.join(root, MARKER), JSON.stringify(marker), { flag: 'wx' }); }
  catch (failure) {
    // No references exist until the complete cleanup intent is durable.
    try { await unlink(path.join(root, MARKER)).catch(error => { if (error.code !== 'ENOENT') throw error; }); await rmdir(root); }
    catch (cleanupFailure) { failure.sceneRuntime = runtime; failure.cleanupFailure = cleanupFailure; }
    throw failure;
  }
  try {
    for (const relative of tree.directories) await mkdir(path.join(root, relative));
    for (const reference of tree.references) {
      const original = await lstat(reference.original, { bigint: true });
      if (!sameIdentity(original, reference) || original.size !== BigInt(reference.size) || original.mtimeNs !== BigInt(reference.modifiedNs)
        || original.isSymbolicLink() || !same(await realpath(reference.original), reference.original)) invalid('SCENE_VIEW_SOURCE_CHANGED');
      await linkFile(reference.original, path.join(root, reference.relative));
    }
    await verifyPrivateScene(runtime); return runtime;
  } catch (failure) {
    try { await removePrivateScene(runtime); }
    catch (cleanupFailure) { failure.sceneRuntime = runtime; failure.cleanupFailure = cleanupFailure; }
    throw failure;
  }
}

async function location(runtime) {
  const { root, token } = runtime || {};
  if (!absoluteSpelling(root) || typeof token !== 'string' || !UUID.test(token) || path.basename(root) !== token || path.basename(path.dirname(root)) !== BASE) invalid();
  const anchor = path.dirname(path.dirname(root)), installed = runtime.installed || anchor;
  await canonicalDirectory(anchor, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
  await canonicalDirectory(installed, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
  const base = path.dirname(root);
  try { await canonicalDirectory(base, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID'); }
  catch (failure) { if (failure.code === 'ENOENT') return { missing: true }; throw failure; }
  try { await canonicalDirectory(root, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID'); }
  catch (failure) { if (failure.code === 'ENOENT') return { missing: true }; throw failure; }
  return { root, token, installed, base };
}

function validateMarker(marker, scoped) {
  if (marker?.profile !== PROFILE || marker.token !== scoped.token || !same(marker.installed, scoped.installed) || !absoluteSpelling(marker.sourceRoot)
    || !absoluteSpelling(marker.sourceProject) || !absoluteSpelling(marker.sourceResource) || !same(path.dirname(marker.sourceProject), marker.sourceRoot)
    || !contains(marker.sourceRoot, marker.sourceResource) || contains(marker.sourceRoot, scoped.base) || contains(scoped.base, marker.sourceRoot)
    || !Array.isArray(marker.references) || marker.references.length > MAX_FILES || !Array.isArray(marker.directories) || marker.directories.length > MAX_DIRECTORIES
    || !Array.isArray(marker.cacheRoots) || !marker.cacheRoots.length || marker.cacheRoots.length > MAX_DIRECTORIES) invalid();
  const names = new Set([MARKER]), directories = new Set();
  for (const relative of marker.directories) {
    if (!safeRelative(relative) || names.has(relative.toLowerCase())) invalid();
    names.add(relative.toLowerCase()); directories.add(relative.toLowerCase());
  }
  const caches = new Set();
  for (const relative of marker.cacheRoots) {
    if (!safeRelative(relative) || !cacheRoot(relative) || !directories.has(relative.toLowerCase()) || caches.has(relative.toLowerCase())) invalid();
    caches.add(relative.toLowerCase());
  }
  if (!caches.has('shaders/blobssm40')) invalid();
  for (const reference of marker.references) {
    if (!reference || !safeRelative(reference.relative) || cachePath(reference.relative) || names.has(reference.relative.toLowerCase()) ||
      !same(reference.original, path.join(marker.sourceRoot, reference.relative)) || !/^\d+$/.test(reference.dev) || !/^[1-9]\d*$/.test(reference.ino) ||
      !/^\d+$/.test(reference.size) || !/^\d+$/.test(reference.modifiedNs)) invalid();
    names.add(reference.relative.toLowerCase());
  }
  for (const relative of [...marker.directories, ...marker.references.map(item => item.relative)]) {
    const parent = path.posix.dirname(relative);
    if (parent !== '.' && !directories.has(parent.toLowerCase())) invalid();
  }
  if (!marker.references.some(item => same(item.original, marker.sourceProject)) || !marker.references.some(item => same(item.original, marker.sourceResource))) invalid();
}

async function privateCache(file, info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 9n || info.size > 64n * 1024n ** 2n || !/^[a-f0-9]{40}\.dxs$/i.test(path.basename(file))) invalid();
  const handle = await open(file, 'r');
  try { const header = Buffer.alloc(9); const { bytesRead } = await handle.read(header, 0, 9, 0); if (bytesRead !== 9 || header.toString('ascii') !== 'SHDV0069\0') invalid(); }
  finally { await handle.close(); }
}

async function audit(runtime, allowMissing) {
  const scoped = await location(runtime); if (scoped.missing) return scoped;
  const markerFile = path.join(scoped.root, MARKER), markerInfo = await lstat(markerFile, { bigint: true });
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1n || markerInfo.size > 8n * 1024n ** 2n) invalid();
  const marker = await boundedJson(markerFile, 8 * 1024 * 1024); validateMarker(marker, scoped);
  const expected = await sceneViewLocation({ type: 'scene', root: marker.sourceRoot, project: marker.sourceProject, resource: marker.sourceResource },
    { installed: scoped.installed, token: scoped.token });
  if (!same(expected.root, scoped.root)) invalid();
  const rootInfo = await canonicalDirectory(scoped.root, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID'), baseInfo = await canonicalDirectory(scoped.base, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
  if (!sameIdentity(rootInfo, marker.rootIdentity) || !sameIdentity(baseInfo, marker.baseIdentity)) invalid();
  const originalRoot = await canonicalDirectory(marker.sourceRoot, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
  if (originalRoot.dev !== rootInfo.dev) invalid();
  const references = new Map(marker.references.map(item => [item.relative.toLowerCase(), item])), directories = new Set(marker.directories.map(relative => relative.toLowerCase()));
  const seen = new Set(), cacheFiles = []; let cacheBytes = 0n;
  const visit = async (folder, prefix = '') => {
    await canonicalDirectory(folder, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, folded = relative.toLowerCase(), file = path.join(scoped.root, relative);
      if (!safeRelative(relative) || seen.has(folded)) invalid(); seen.add(folded);
      const info = await lstat(file, { bigint: true });
      if (info.isSymbolicLink() || !same(await realpath(file), file)) invalid();
      if (folded === MARKER) { if (prefix || !sameIdentity(info, identity(markerInfo))) invalid(); continue; }
      if (info.isDirectory()) {
        if (!directories.has(folded)) invalid(); await visit(file, relative); continue;
      }
      const reference = references.get(folded);
      if (reference) {
        const original = await lstat(reference.original, { bigint: true });
        if (!info.isFile() || original.isSymbolicLink() || !original.isFile() || !same(await realpath(reference.original), reference.original) ||
          !sameIdentity(info, reference) || !sameIdentity(original, reference)) invalid();
        if (!allowMissing && (original.size !== BigInt(reference.size) || original.mtimeNs !== BigInt(reference.modifiedNs))) invalid('SCENE_VIEW_SOURCE_CHANGED');
      } else if (marker.cacheRoots.some(cache => path.posix.dirname(relative).toLowerCase() === cache.toLowerCase())) {
        await privateCache(file, info); cacheBytes += info.size;
        if (cacheFiles.length >= MAX_FILES || cacheBytes > 512n * 1024n ** 2n) invalid(); cacheFiles.push(relative);
      } else invalid();
    }
  };
  await visit(scoped.root);
  if (!allowMissing && [...references.keys(), ...directories].some(relative => !seen.has(relative))) invalid();
  return { ...scoped, marker, cacheFiles };
}

export async function verifyPrivateScene(runtime) { return audit(runtime, false); }

// Validate the complete view before unlinking anything. Only unlink is used for
// hardlinks: recursive fs.rm can chmod read-only files and thereby change their
// original source inode. Empty private directories are then removed bottom-up.
export async function removePrivateScene(runtime) {
  const checked = await audit(runtime, true); if (checked.missing) return;
  const { root, marker } = checked;
  const removeFile = async (relative, reference) => {
    const file = path.join(root, relative);
    for (let attempt = 0; ; attempt++) {
      try {
        await canonicalDirectory(path.dirname(file), 'SCENE_VIEW_CLEANUP_SCOPE_INVALID');
        const info = await lstat(file, { bigint: true });
        if (info.isSymbolicLink() || !info.isFile() || !same(await realpath(file), file)) invalid();
        if (reference ? !sameIdentity(info, reference) : info.nlink !== 1n) invalid();
        await unlink(file); return;
      } catch (failure) {
        if (failure.code === 'ENOENT') return;
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(failure.code)) throw failure;
        await delay(100);
      }
    }
  };
  for (const reference of marker.references) await removeFile(reference.relative, reference);
  for (const relative of checked.cacheFiles) await removeFile(relative);
  for (const relative of [...marker.directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const directory = path.join(root, relative);
    try { await canonicalDirectory(directory, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID'); await rmdir(directory); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  await removeFile(MARKER); await canonicalDirectory(root, 'SCENE_VIEW_CLEANUP_SCOPE_INVALID'); await rmdir(root);
  await rmdir(path.dirname(root)).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure; });
}
