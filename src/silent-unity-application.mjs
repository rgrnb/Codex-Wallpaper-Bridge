import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, copyFile, realpath, stat, lstat, link, symlink, unlink, rmdir, rm } from 'node:fs/promises';
import { describeSource, boundedJson } from './wallpaper-engine.mjs';

const TREE = 'e09a40b06aafadf8e5d9603a5ca0884ce953b1ad550724044ef3a52e3b414d4a';
const CONFIGURATION = '9091f68a16523f81f1653c996676d58dbb92eea9d0340242ad05366220905c43';
const MUTED_CONFIGURATION = '581fb0d10cfdccd925e7b7b43813ce98c1bc7a2b17c249279f9f9f5f2b3985f7';
const PROFILE = 'unity-2017.2-reviewed-sheep';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deny = detail => ({ safe: false, code: 'APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE', detail });

export async function applicationTree(root) {
  const files = []; let bytes = 0, directories = 0;
  const visit = async (directory, depth = 0) => {
    if (++directories > 256 || depth > 12) throw new Error('APPLICATION_SOURCE_SIZE_UNVERIFIED');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('APPLICATION_SOURCE_LINK_UNVERIFIED');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) {
        if (files.length >= 256) throw new Error('APPLICATION_SOURCE_SIZE_UNVERIFIED');
        const info = await stat(file); bytes += info.size;
        if (bytes > 64 * 1024 * 1024) throw new Error('APPLICATION_SOURCE_SIZE_UNVERIFIED');
        files.push({ file, relative: path.relative(root, file).split(path.sep).join('/'), size: info.size });
      } else throw new Error('APPLICATION_SOURCE_TYPE_UNVERIFIED');
    }
  };
  await visit(root); files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const hash = createHash('sha256');
  for (const file of files) { const content = await readFile(file.file); file.sha256 = digest(content); hash.update(file.relative + '\0'); hash.update(content); }
  return { hash: hash.digest('hex'), bytes, files };
}

// Scope is a single immutable, reviewed Unity application, not every Unity EXE.
// Its AudioManager serialized configuration disables the audio subsystem before
// the application starts; no post-launch process/global mute operation exists.
export async function inspectSilentUnityApplication(source) {
  if (source?.type !== 'application') return deny('The source is not an application.');
  try {
    const canonical = await describeSource(source.project);
    if (canonical.type !== 'application' || !same(canonical.resource, source.resource) || !same(canonical.root, source.root)
      || path.basename(canonical.resource).toLowerCase() !== 'sheep.exe') return deny('The application identity is unverified.');
    const tree = await applicationTree(canonical.root);
    if (tree.hash !== TREE) return deny('This application does not match the complete reviewed Sheep source tree.');
    return { safe: true, code: 'APPLICATION_UNITY_AUDIO_DISABLED_PRESTART', profile: PROFILE, treeHash: TREE,
      evidence: 'Exact reviewed Sheep/Unity 2017.2 source. A private AudioManager configuration sets m_DisableAudio before process creation.',
      arguments: ['-popupwindow', '-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '720', '-nolog'] };
  } catch { return deny('The complete application source tree could not be verified.'); }
}

export async function stageSilentUnityApplication(source, audio, policy = {}) {
  if (audio?.profile !== PROFILE || !(await inspectSilentUnityApplication(source)).safe) throw new Error('APPLICATION_SOURCE_PROFILE_INVALID');
  const installed = path.dirname(path.dirname(path.dirname(source.root)));
  if (path.basename(path.dirname(source.root)).toLowerCase() !== 'defaultprojects' || path.basename(path.dirname(path.dirname(source.root))).toLowerCase() !== 'projects')
    throw new Error('APPLICATION_RUNTIME_LOCATION_UNSUPPORTED');
  const base = path.join(installed, '.bridge-application-runtime'), token = randomUUID(), root = path.join(base, token);
  const before = await applicationTree(source.root);
  if (before.hash !== TREE) throw new Error('APPLICATION_SOURCE_CHANGED');
  try {
    await mkdir(base, { recursive: true });
    if (!same(await realpath(base), base)) throw new Error();
    await mkdir(root);
  } catch { throw new Error('APPLICATION_RUNTIME_DIRECTORY_UNWRITABLE'); }
  const marker = { token, sourceRoot: source.root, sourceFile: source.resource, profile: PROFILE, originalTree: TREE, references: [] };
  try { await writeFile(path.join(root, '.bridge-application.json'), JSON.stringify(marker), { flag: 'wx' }); }
  catch (failure) {
    try { await rmdir(root); }
    catch (cleanupFailure) { failure.runtime = { root, token }; failure.cleanupFailure = cleanupFailure; }
    throw failure;
  }
  try {
    // These are executable code, not wallpaper media. The one configuration
    // copy is 48,436 bytes and changes exactly m_DisableAudio at byte 6424.
    for (const file of ['sheep.exe', 'UnityPlayer.dll']) await copyFile(path.join(source.root, file), path.join(root, file));
    await mkdir(path.join(root, 'sheep_Data'));
    const originalConfiguration = await readFile(path.join(source.root, 'sheep_Data', 'globalgamemanagers'));
    if (originalConfiguration.length !== 48436 || digest(originalConfiguration) !== CONFIGURATION || originalConfiguration[6424] !== 0) throw new Error('APPLICATION_AUDIO_CONFIGURATION_UNVERIFIED');
    const muted = Buffer.from(originalConfiguration); muted[6424] = 1;
    if (digest(muted) !== MUTED_CONFIGURATION) throw new Error('APPLICATION_AUDIO_CONFIGURATION_UNVERIFIED');
    await writeFile(path.join(root, 'sheep_Data', 'globalgamemanagers'), muted);
    for (const entry of await readdir(path.join(source.root, 'sheep_Data'), { withFileTypes: true })) {
      if (entry.name === 'globalgamemanagers') continue;
      const relative = path.join('sheep_Data', entry.name), from = path.join(source.root, relative), to = path.join(root, relative);
      // Persist the cleanup intent before adding any reference to original
      // assets. An interrupted link/write must never leave an untracked link.
      marker.references.push({ relative, directory: entry.isDirectory() });
      await writeFile(path.join(root, '.bridge-application.json'), JSON.stringify(marker));
      if (entry.isDirectory()) await symlink(from, to, 'junction');
      else if (entry.isFile()) await link(from, to);
      else throw new Error('APPLICATION_SOURCE_TYPE_UNVERIFIED');
    }
    for (const file of before.files.filter(file => ['sheep.exe', 'UnityPlayer.dll'].includes(file.relative)))
      if (digest(await readFile(path.join(root, file.relative))) !== file.sha256) throw new Error('APPLICATION_CODE_COPY_CHANGED');
    if ((await applicationTree(source.root)).hash !== TREE) throw new Error('APPLICATION_SOURCE_CHANGED');
    const width = Math.max(320, Math.min(1920, Math.round(policy.maxWidth || 1280))), height = Math.max(180, Math.min(2160, Math.round(policy.height || width * 9 / 16)));
    return { root, token, executable: path.join(root, 'sheep.exe'), sourceFile: source.resource, marker,
      arguments: ['-popupwindow', '-screen-fullscreen', '0', '-screen-width', String(width), '-screen-height', String(height), '-nolog'],
      copiedConfigurationBytes: 48436, copiedMediaBytes: 0 };
  } catch (failure) {
    try { await removeSilentUnityApplication({ root, token }); }
    catch (cleanupFailure) { failure.runtime = { root, token }; failure.cleanupFailure = cleanupFailure; }
    throw failure;
  }
}

export async function removeSilentUnityApplication({ root, token }) {
  const invalid = () => { throw new Error('APPLICATION_CLEANUP_SCOPE_INVALID'); };
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)
    || path.basename(root) !== token || path.basename(path.dirname(root)) !== '.bridge-application-runtime') invalid();
  try { if (!same(await realpath(root), root)) invalid(); }
  catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
  const marker = await boundedJson(path.join(root, '.bridge-application.json'));
  if (marker.token !== token || marker.profile !== PROFILE || marker.originalTree !== TREE
    || typeof marker.sourceRoot !== 'string' || !path.isAbsolute(marker.sourceRoot) || typeof marker.sourceFile !== 'string'
    || !same(marker.sourceFile, path.join(marker.sourceRoot, 'sheep.exe'))
    || !same(path.dirname(path.dirname(path.dirname(marker.sourceRoot))), path.dirname(path.dirname(root)))
    || !Array.isArray(marker.references) || marker.references.length > 256) invalid();
  const names = new Set();
  for (const item of marker.references) {
    if (!item || typeof item.relative !== 'string' || typeof item.directory !== 'boolean'
      || !/^sheep_Data[\\/][^\\/<>:"|?*\x00-\x1f]+$/.test(item.relative)) invalid();
    const name = item.relative.slice(11).toLowerCase();
    if (name === '.' || name === '..' || /[. ]$/.test(name) || name === 'globalgamemanagers' || names.has(name)) invalid();
    names.add(name);
  }
  // Validate the entire layout before touching anything. Recursive removal is
  // then restricted to private code/config files after all asset links go away.
  const privateFile = async file => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid();
  };
  const privateDriverLogs = async directory => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name !== 'umdlogs' || !entry.isDirectory() || entry.isSymbolicLink()) invalid();
      const logs = path.join(directory, entry.name), files = await readdir(logs, { withFileTypes: true });
      if (files.length > 256) invalid();
      for (const file of files) await privateFile(path.join(logs, file.name));
    }
  };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'sheep_Data') { if (!entry.isDirectory() || entry.isSymbolicLink()) invalid(); }
    else if (['.bridge-application.json', 'sheep.exe', 'UnityPlayer.dll'].includes(entry.name)) await privateFile(path.join(root, entry.name));
    // NVIDIA creates this private runtime-local diagnostics directory even
    // with Unity logging disabled. It must contain only private regular files.
    else if (entry.name === 'NVIDIA Corporation') await privateDriverLogs(path.join(root, entry.name));
    else invalid();
  }
  let dataEntries = [];
  try { dataEntries = await readdir(path.join(root, 'sheep_Data'), { withFileTypes: true }); }
  catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  for (const entry of dataEntries) {
    const file = path.join(root, 'sheep_Data', entry.name);
    if (entry.name === 'globalgamemanagers') await privateFile(file);
    else {
      const reference = marker.references.find(item => item.relative.slice(11).toLowerCase() === entry.name.toLowerCase());
      if (!reference) invalid();
      const original = path.join(marker.sourceRoot, 'sheep_Data', entry.name), info = await lstat(file, { bigint: true });
      if (reference.directory) {
        if (!info.isSymbolicLink() || !same(await realpath(file), original)) invalid();
      } else {
        const sourceInfo = await lstat(original, { bigint: true });
        if (!info.isFile() || !sourceInfo.isFile() || info.dev !== sourceInfo.dev || info.ino !== sourceInfo.ino) invalid();
      }
    }
  }
  for (const item of marker.references) {
    // Unlink directory junctions and hardlinks first. No chmod/attribute changes
    // are made to hardlinks, since those would alter the installed original.
    for (let attempt = 0; ; attempt++) {
      try { await unlink(path.join(root, item.relative)); break; }
      catch (failure) {
        if (failure.code === 'ENOENT') break;
        if (attempt >= 30 || !['EPERM', 'EBUSY', 'EACCES'].includes(failure.code)) throw failure;
        await delay(100);
      }
    }
  }
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch (failure) { if (attempt >= 30 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(failure.code)) throw failure; await delay(100); }
  }
  if ((await applicationTree(marker.sourceRoot)).hash !== TREE) throw new Error('APPLICATION_ORIGINAL_SOURCE_CHANGED');
  await rmdir(path.dirname(root)).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure; });
}
