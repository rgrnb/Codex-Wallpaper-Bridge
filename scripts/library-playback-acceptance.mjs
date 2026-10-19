import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Hidden private renderers only. Videos belong to the real Codex decode matrix.
// Resume: --resume=<evidence directory>. Reuse a different run: --reuse=<dir>.
// Fixed four-project/four-minute batches; --project-timeout-ms=45000 bounds each
// renderer. --project=<project.json> selects one precise source when diagnosing.
// Pause immediately: create <evidence>/pause.request.json, send IPC {action:'pause'},
// or SIGINT/SIGTERM. A pause stops the active owned Job and leaves the next row
// unstarted. Remove the sentinel deliberately before resuming that directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const policy = { maxWidth: 640, height: 360, fps: 30, jpegQuality: 95 };
const engine = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const producerFiles = ['src/isolated-player.mjs', 'src/private-scene.mjs', 'src/independent-application.mjs', 'src/silent-unity-application.mjs',
  'src/independent-application-worker.ps1', 'src/library.mjs', 'src/platform.mjs', 'src/cdp.mjs', 'src/wallpaper-engine.mjs'];

async function fileHash(file, signal) {
  const digest = createHash('sha256'), stream = createReadStream(file, { signal });
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

// Content and metadata are independent checks. Directory sizes and timestamps
// remain in the strict preservation digest; they are not mistaken for content.
// Source links are inventoried without following them or changing their targets.
export async function sourceSnapshot(directory, { signal } = {}) {
  const rows = [];
  async function visit(file) {
    signal?.throwIfAborted();
    const info = await lstat(file, { bigint: true });
    const row = { path: path.relative(directory, file).replaceAll('\\', '/') || '.', size: String(info.size), modifiedNs: String(info.mtimeNs),
      kind: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file' };
    if (row.kind === 'link') row.target = await readlink(file);
    if (row.kind === 'file') {
      row.contentSha256 = await fileHash(file, signal);
      const after = await lstat(file, { bigint: true });
      if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ino !== info.ino) throw new Error(`SOURCE_CHANGED_DURING_HASH:${row.path}`);
    }
    rows.push(row);
    if (row.kind === 'directory') {
      const entries = await readdir(file, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await visit(path.join(file, entry.name));
      const after = await lstat(file, { bigint: true });
      if (after.size !== info.size || after.mtimeNs !== info.mtimeNs) throw new Error(`SOURCE_CHANGED_DURING_HASH:${row.path}`);
    }
  }
  await visit(directory);
  const metadataRows = rows.map(({ contentSha256, ...row }) => row);
  const contentRows = rows.map(row => ({ path: row.path, kind: row.kind,
    ...(row.kind === 'file' ? { size: row.size, sha256: row.contentSha256 } : {}), ...(row.kind === 'link' ? { target: row.target } : {}) }));
  return { directory, metadataSha256: hash(JSON.stringify(metadataRows)), contentSha256: hash(JSON.stringify(contentRows)),
    legacyMetadataSha256: hash(JSON.stringify(metadataRows.filter(row => row.path !== '.'))), entries: rows.length - 1,
    fileCount: rows.filter(row => row.kind === 'file').length, totalFileBytes: rows.filter(row => row.kind === 'file').reduce((total, row) => total + BigInt(row.size), 0n).toString(), rows };
}
export function snapshotSummary({ rows, ...summary }) { return summary; }
export function compareSnapshots(before, after) {
  const previous = new Map(before.rows.map(row => [row.path, row])), current = new Map(after.rows.map(row => [row.path, row]));
  return { metadataUnchanged: before.metadataSha256 === after.metadataSha256, contentUnchanged: before.contentSha256 === after.contentSha256,
    added: after.rows.filter(row => !previous.has(row.path)), removed: before.rows.filter(row => !current.has(row.path)),
    changed: after.rows.flatMap(row => {
      const old = previous.get(row.path); if (!old) return [];
      const fields = ['kind', 'size', 'modifiedNs', 'target', 'contentSha256'].filter(field => old[field] !== row[field]);
      return fields.length ? [{ path: row.path, fields, before: old, after: row }] : [];
    }) };
}
export function reusableResult(candidate, snapshot, fingerprint) {
  return Boolean(fingerprint) && candidate?.success === true && candidate.cleaned === true && candidate.privateRuntimeRemoved === true &&
    (candidate.type !== 'scene' || candidate.privateSceneRuntimeRemoved === true) &&
    candidate.originalSourceMetadataUnchanged === true && candidate.originalSourceContentUnchanged === true && candidate.originalConfigUnchanged === true &&
    candidate.validationFingerprint === fingerprint && candidate.sourceMetadataAfter?.metadataSha256 === snapshot.metadataSha256 &&
    candidate.sourceMetadataAfter?.contentSha256 === snapshot.contentSha256;
}
export function playbackHelperFiles(type) {
  return ['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll', ...(type === 'application' ? ['BridgeApplicationInput.dll', 'BridgeApplicationInputHook32.dll'] : [])];
}
export function playbackFingerprint({ helperSha256, producerSha256, engineSha256, policy }, type) {
  const files = ['src/library.mjs', 'src/wallpaper-engine.mjs', ...(type === 'application'
    ? ['src/independent-application.mjs', 'src/silent-unity-application.mjs', 'src/independent-application-worker.ps1']
    : ['src/isolated-player.mjs', ...(type === 'scene' ? ['src/private-scene.mjs'] : []), 'src/platform.mjs', 'src/cdp.mjs'])];
  const helpers = playbackHelperFiles(type);
  if (!engineSha256 || !policy || files.some(file => !producerSha256?.[file]) || helpers.some(file => !helperSha256?.[file])) return null;
  return hash(JSON.stringify({ schema: 2, helperSha256: Object.fromEntries(helpers.map(file => [file, helperSha256[file]])), engineSha256, policy,
    producerSha256: Object.fromEntries(files.map(file => [file, producerSha256[file]])) }));
}
export async function sceneCacheEvidence(runtime) {
  const { verifyPrivateScene } = await import('../src/private-scene.mjs');
  const checked = await verifyPrivateScene(runtime);
  assert.ok(!checked.missing, 'The private Scene view must exist while its renderer is active.');
  return { root: checked.root, token: checked.token, markerProfile: checked.marker.profile,
    sourceRoot: checked.marker.sourceRoot, copiedMediaBytes: 0, files: await Promise.all(checked.cacheFiles.map(async relative => {
      const file = path.join(checked.root, relative), info = await lstat(file, { bigint: true });
      const sha256 = await fileHash(file), after = await lstat(file, { bigint: true });
      assert.ok(info.ino === after.ino && info.size === after.size && info.mtimeNs === after.mtimeNs, 'The private shader cache changed during evidence hashing.');
      return { relative, file, size: String(info.size), sha256 };
    })) };
}
// Early schema-2 rows fingerprinted all renderer types together. Their retained
// exact producer hashes permit narrowing that fingerprint without rendering a
// completed scene again merely because an unrelated Application worker changed.
export function reusableFromReport(candidate, snapshot, fingerprint, context) {
  if (reusableResult(candidate, snapshot, fingerprint)) return candidate;
  if (candidate?.validationFingerprint === context?.validationFingerprint && playbackFingerprint(context, candidate?.type) === fingerprint) {
    const normalized = { ...candidate, validationFingerprint: fingerprint, reusedFromFingerprint: candidate.validationFingerprint };
    if (reusableResult(normalized, snapshot, fingerprint)) return normalized;
  }
  return null;
}
export function createStopController({ onStop = () => {} } = {}) {
  let reason = null, active = null, stopping = Promise.resolve();
  return { get reason() { return reason; }, get stopping() { return stopping; },
    setActive(player) { active = player; if (reason && active) stopping = Promise.resolve(active.stop()); },
    clearActive(player) { if (active === player) active = null; },
    request(reasonText) { if (reason) return stopping; reason = reasonText; onStop(reason); if (active) stopping = Promise.resolve(active.stop()); return stopping; },
    check() { if (reason) throw new Error(`MATRIX_STOP_REQUESTED:${reason}`); } };
}
export async function runMatrixQueue({ items, shouldStop, execute }) {
  for (const item of items) { if (shouldStop()) break; await execute(item); }
}

const imageScript = `from PIL import Image,ImageStat,ImageChops
import json,sys
out=[]
for file in json.loads(sys.argv[1]):
 im=Image.open(file).convert('RGB');r,g,b=im.split();h=ImageChops.lighter(ImageChops.lighter(r,g),b).histogram();visible=sum(h[17:]);s=ImageStat.Stat(im)
 out.append({'file':file,'width':im.width,'height':im.height,'mean':s.mean,'deviation':s.stddev,'extrema':im.getextrema(),'visiblePixels':visible,'visibleFraction':visible/(im.width*im.height),'visible':visible>max(16,im.width*im.height*.0001)})
print(json.dumps(out))`;
async function imageStats(files) {
  const python = process.env.BRIDGE_PYTHON || 'python';
  return JSON.parse((await run(python, ['-c', imageScript, JSON.stringify(files)], { windowsHide: true, timeout: 10000 })).stdout);
}
async function compareImages(first, second) {
  const python = process.env.BRIDGE_PYTHON || 'python';
  const script = `from PIL import Image,ImageStat,ImageChops
import sys,json
a=Image.open(sys.argv[1]).convert('RGB').resize((64,36));b=Image.open(sys.argv[2]).convert('RGB').resize((64,36));print(json.dumps({'meanAbsoluteChannelError':sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3}))`;
  return JSON.parse((await run(python, ['-c', script, first, second], { windowsHide: true, timeout: 10000 })).stdout);
}
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
function numericArgument(name, fallback, low, high) {
  const value = argument(name); if (value === undefined) return fallback;
  const number = Number(value); assert.ok(Number.isInteger(number) && number >= low && number <= high, `Invalid --${name}`); return number;
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); return; }
    catch (error) { if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error; await delay(50 * (attempt + 1)); }
  }
}

// Read-only historical diagnosis. The old run did not retain manifest rows, so
// birth times are explicitly corroboration, never reconstructed before images.
async function diagnoseHistorical(directory) {
  const previous = JSON.parse(await readFile(path.join(path.resolve(directory), 'result.json'), 'utf8'));
  const evidence = path.join(root, '.local-evidence', `library-preservation-${randomUUID()}`); await mkdir(evidence);
  const observations = [];
  for (const result of previous.results.filter(row => !row.originalSourceMetadataUnchanged)) {
    const snapshot = await sourceSnapshot(path.dirname(result.project)), additionsDuringRun = [];
    for (const row of snapshot.rows) {
      const info = await lstat(path.join(snapshot.directory, row.path));
      if (info.birthtimeMs >= Date.parse(result.started) && info.birthtimeMs <= Date.parse(result.finished))
        additionsDuringRun.push({ ...row, created: info.birthtime.toISOString() });
    }
    const file = `${observations.length + 1}-current-source.json`; await atomicJson(path.join(evidence, file), snapshot);
    observations.push({ project: result.project, title: result.title, started: result.started, finished: result.finished,
      previousBefore: result.sourceMetadataBefore, previousAfter: result.sourceMetadataAfter,
      current: snapshotSummary(snapshot), manifest: file, additionsDuringRun,
      historicalFileCountDelta: result.sourceMetadataAfter.fileCount - result.sourceMetadataBefore.fileCount,
      inIntervalFileCount: additionsDuringRun.filter(row => row.kind === 'file').length });
  }
  const report = { actualPlayback: false, originalSourceWrites: false, evidence, historicalEvidence: path.resolve(directory), observations,
    limitation: 'Old evidence contains only metadata digests/counts. Exact previous rows cannot be recovered. Creation timestamps and matching count deltas corroborate source-local shader cache additions; the old failure remains a failure.' };
  await atomicJson(path.join(evidence, 'result.json'), report); console.log(JSON.stringify({ evidence, observations: observations.length }));
}

async function main() {
  if (argument('diagnose')) return diagnoseHistorical(argument('diagnose'));
  const maxProjects = 4, maxRunMs = 240000, captureTimeoutMs = 20000;
  const projectTimeoutMs = numericArgument('project-timeout-ms', 45000, 1000, 180000);
  const types = new Set((argument('types') || 'scene,web,application').split(',')), project = argument('project');
  assert.ok([...types].every(type => ['scene', 'web', 'application'].includes(type)), 'Only scene/web/application are captured here; video requires the real Codex native decode matrix.');
  const resume = argument('resume'), evidence = resume ? path.resolve(resume) : path.join(root, '.local-evidence', `library-playback-${randomUUID()}`);
  const reportFile = path.join(evidence, 'result.json'), pauseFile = path.join(evidence, 'pause.request.json');
  let report = resume ? JSON.parse(await readFile(reportFile, 'utf8')) : null;
  if (resume) {
    assert.equal(report.schemaVersion, 2, 'Legacy evidence is read-only. Use --reuse to reference it from a new checkpoint.');
    assert.ok(!report.active, 'An interrupted active Job has no completed cleanup checkpoint. Resolve its exact owned identity before resuming.');
  }
  await mkdir(path.join(evidence, 'helper'), { recursive: true });
  const helperSha256 = {};
  const helpers = new Set([...types].flatMap(playbackHelperFiles));
  for (const file of helpers) {
    const source = path.join(process.env.BRIDGE_POINTER_BUILD || path.join(root, 'build'), file), destination = path.join(evidence, 'helper', file);
    helperSha256[file] = await fileHash(source);
    if (resume) {
      assert.equal(report.helperSha256[file], helperSha256[file], 'Build changed: use a new run with --reuse instead of overwriting historical helpers.');
      assert.equal(await fileHash(destination), helperSha256[file], 'Historical helper fingerprint changed.');
    } else {
      await copyFile(source, destination);
      assert.equal(await fileHash(destination), helperSha256[file], 'Build changed while copying the helper snapshot.');
    }
  }
  const producerSha256 = Object.fromEntries(await Promise.all(producerFiles.map(async file => [file, await fileHash(path.join(root, file))])));
  const engineSha256 = await fileHash(engine);
  const validationFingerprint = hash(JSON.stringify({ schema: 2, helperSha256, producerSha256, engineSha256, policy }));
  const typeFingerprints = Object.fromEntries(['scene', 'web', 'application'].map(type => [type, playbackFingerprint({ helperSha256, producerSha256, engineSha256, policy }, type)]));
  process.env.BRIDGE_NATIVE_HOST = path.join(evidence, 'helper', 'CodexWallpaperBridge.exe');
  const { IsolatedPlayer } = await import('../src/isolated-player.mjs');
  const { IndependentApplicationPlayer } = await import('../src/independent-application.mjs');
  const { scanLibrary } = await import('../src/library.mjs');
  const { describeSource } = await import('../src/wallpaper-engine.mjs');
  const installedConfig = path.join(path.dirname(engine), 'config.json'), beforeConfig = await fileHash(installedConfig);
  const library = await scanLibrary({ executable: engine });
  const counts = Object.fromEntries(['scene', 'web', 'video', 'application'].map(type => [type, library.items.filter(item => item.type === type).length]));
  const selected = library.items.filter(item => types.has(item.type) && (!project || samePath(item.project, project)))
    .sort((a, b) => (a.type === 'application') - (b.type === 'application') || a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
  assert.ok(selected.length, 'The requested library playback selection is empty.');
  const prior = argument('reuse') ? JSON.parse(await readFile(path.join(path.resolve(argument('reuse')), 'result.json'), 'utf8')) : null;
  report ||= { schemaVersion: 2, started: new Date().toISOString(), success: false, actualCodex: false, evidence, helperSha256, producerSha256, engineSha256, validationFingerprint, policy, inventory: counts,
    metadataDefinition: 'Full sorted before/after manifests retain every path, size, nanosecond mtime, link target and streamed file SHA256. Strict metadata (including directories) and file content are both required unchanged; source links are never traversed.',
    videoScope: 'Video playback is deferred to the real Codex native decode matrix; no metadata scan is counted as video playback.',
    deferredVideos: library.items.filter(item => item.type === 'video').map(item => ({ title: item.title, project: item.project })), scanErrors: library.errors, results: [], sessions: [] };
  report.sessions.push({ started: new Date().toISOString(), maxProjects, maxRunMs, projectTimeoutMs, captureTimeoutMs, producerSha256, typeFingerprints, selection: selected.map(item => item.project) });
  const session = report.sessions.at(-1); session.validatedProjects = []; delete report.stopRequested; delete report.finished; delete report.failure;
  // Serialize checkpoints so pause notification and row completion cannot race.
  let writes = Promise.resolve();
  const persist = () => { const json = JSON.parse(JSON.stringify(report)); writes = writes.then(() => atomicJson(reportFile, json)); return writes; };
  const stop = createStopController({ onStop: reason => { report.stopRequested = { reason, at: new Date().toISOString() }; persist().catch(() => {}); } });
  const requestStop = reason => { stop.request(reason).catch(error => { report.stopFailure = error.stack; }); };
  const onInterrupt = () => requestStop('SIGINT'), onTerminate = () => requestStop('SIGTERM');
  const onMessage = message => { if (message?.action === 'pause') requestStop('explicit-pause'); };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('message', onMessage);
  let pauseProbeRunning = false;
  const pauseProbe = async () => {
    if (pauseProbeRunning || stop.reason) return; pauseProbeRunning = true;
    try { if (await exists(pauseFile)) requestStop('pause.request.json'); }
    catch (error) { requestStop(`pause-check-failed:${error.code || error.message}`); }
    finally { pauseProbeRunning = false; }
  };
  const pauseTimer = setInterval(pauseProbe, 100), runTimer = setTimeout(() => requestStop('run-time-bound'), maxRunMs);
  let executed = 0, reused = 0;
  try {
    await pauseProbe(); await persist(); console.log(JSON.stringify({ evidence, pauseFile, selected: selected.length, maxProjects, maxRunMs }));
    await runMatrixQueue({ items: selected, shouldStop: () => Boolean(stop.reason), execute: async item => {
      const source = await describeSource(item.project), beforeMetadata = await sourceSnapshot(source.root), fingerprint = typeFingerprints[source.type]; stop.check();
      const candidates = [...report.results].reverse().concat(prior?.results || []);
      let candidate, candidateEvidence;
      for (const context of [report, prior].filter(Boolean)) {
        for (const row of [...context.results].reverse()) {
          if (samePath(row.project, source.project)) candidate = reusableFromReport(row, beforeMetadata, fingerprint, context);
          if (candidate) { candidateEvidence = context.evidence; break; }
        }
        if (candidate) break;
      }
      if (candidate) {
        reused++; session.reused ||= []; session.reused.push({ project: item.project, evidence: candidate.evidence || candidateEvidence, finished: candidate.finished });
        session.validatedProjects.push(item.project);
        if (!report.results.some(row => row === candidate)) report.results.push({ ...candidate, evidence: candidate.evidence || candidateEvidence, reusedAt: new Date().toISOString() });
        await persist(); return;
      }
      if (executed >= maxProjects) { requestStop('project-count-bound'); return; }
      stop.check(); executed++;
      const directory = path.join(evidence, `${String(report.results.length + 1).padStart(2, '0')}-${item.id}-${randomUUID().slice(0, 8)}`); await mkdir(directory);
      const result = { title: item.title, project: source.project, type: source.type, started: new Date().toISOString(), success: false,
        validationFingerprint: fingerprint, frames: [], capturesWithoutImage: [], sourceMetadataBefore: snapshotSummary(beforeMetadata), projectSha256: await fileHash(source.project),
        sourceManifestBefore: path.relative(evidence, path.join(directory, 'source-before.json')) };
      const historical = candidates.find(row => samePath(row.project, source.project));
      if (historical) result.previousEvidence = { evidence: historical.evidence || prior?.evidence || evidence, success: historical.success,
        reused: false, reason: 'Source content/metadata or helper/renderer fingerprints are absent or do not match.' };
      await atomicJson(path.join(directory, 'source-before.json'), beforeMetadata);
      const player = source.type === 'application' ? new IndependentApplicationPlayer() : new IsolatedPlayer({ executable: engine });
      let runtime, sceneRuntime, timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; player.stop().catch(error => { result.timeoutCleanupFailure = error.stack; }); }, projectTimeoutMs);
      stop.setActive(player); report.active = { project: source.project, directory, started: result.started, stage: 'starting', attempt: result }; await persist();
      const check = () => { stop.check(); if (timedOut) throw new Error('MATRIX_PROJECT_TIMEOUT'); };
      try {
        check(); const surface = await player.start(source, { policy }); runtime = player.runtime; check();
        result.surface = surface; result.runtimeIdentity = runtime ? { root: runtime.root, token: runtime.token } : null;
        if (source.type === 'scene') {
          sceneRuntime = runtime?.sceneRuntime || (runtime?.sceneRoot ? { root: runtime.sceneRoot, token: runtime.token } : null);
          assert.ok(sceneRuntime?.root, 'Scene playback requires its registered private project view.');
          result.sceneRuntimeIdentity = { root: sceneRuntime.root, token: sceneRuntime.token };
        }
        report.active.stage = 'capturing'; report.active.runtimeIdentity = result.runtimeIdentity; await persist();
        const deadline = Date.now() + captureTimeoutMs; let visibleFrames = 0;
        do {
          check(); const frame = await player.capture(source, policy); check();
          // GPU loading/paused replies are observations, not a failed decoded
          // image assertion. Keep polling the same renderer within the deadline.
          if (!frame?.jpeg || !(frame.width > 0 && frame.height > 0)) {
            const { jpeg, ...status } = frame || {};
            result.capturesWithoutImage.push({ at: new Date().toISOString(), ...status }); await persist();
            await delay(150); continue;
          }
          const file = path.join(directory, `frame-${result.frames.length}.jpg`), bytes = Buffer.from(frame.jpeg, 'base64'); await writeFile(file, bytes);
          const pixels = (await imageStats([file]))[0]; check();
          result.frames.push({ file: path.relative(evidence, file), sha256: hash(bytes), width: frame.width, height: frame.height,
            sequence: frame.sequence ?? null, paused: frame.paused ?? null, backendVisibleContent: frame.visibleContent ?? null, pixels });
          await persist();
          if (pixels.visible) visibleFrames++;
          const sequences = result.frames.map(row => row.sequence).filter(sequence => Number.isInteger(sequence) && sequence > 0 && sequence % 2 === 0);
          if (result.frames.length >= 4 && visibleFrames >= 3 && (source.type !== 'scene' || new Set(sequences).size > 1)) break;
          await delay(250);
        } while (Date.now() < deadline);
        result.visibleContent = visibleFrames >= 3;
        result.changingPixels = new Set(result.frames.filter(frame => frame.pixels.visible).map(frame => frame.sha256)).size > 1;
        result.gpuSequenceAdvanced = new Set(result.frames.map(frame => frame.sequence).filter(sequence => Number.isInteger(sequence) && sequence > 0 && sequence % 2 === 0)).size > 1;
        assert.equal(result.visibleContent, true, 'No three visible decoded images appeared in the bounded capture window.');
        if (source.type === 'scene') assert.equal(result.gpuSequenceAdvanced, true, 'Scene GPU frame sequence must advance.');
        if (source.type === 'web') {
          const client = await player.webInputClient(); check();
          result.document = { ...player.webDocument, state: await client.evaluate(`({url:location.href,ready:document.readyState,navigationUrl:performance.getEntriesByType('navigation')[0]?.name,canvasCount:document.querySelectorAll('canvas').length})`) };
          const shot = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true }); check();
          const file = path.join(directory, 'compositor.png'); await writeFile(file, Buffer.from(shot.data, 'base64'));
          result.compositorPixels = (await imageStats([file]))[0];
          result.compositorComparison = await compareImages(path.join(evidence, result.frames.at(-1).file), file);
          assert.equal(result.compositorPixels.visible, true, 'The same verified document must have visible compositor content.');
          assert.ok(result.changingPixels || result.compositorComparison.meanAbsoluteChannelError < 20, 'Static GDI capture must agree with the verified page compositor.');
        }
        check(); result.playbackObservation = result.changingPixels ? 'visible-changing-frames' : 'visible-static-content'; result.success = true;
      } catch (error) { result.failure = error.stack; result.interrupted = Boolean(stop.reason); }
      finally {
        clearTimeout(timeout);
        if (player.runtime) {
          runtime ||= player.runtime; result.runtimeLogs = {};
          for (const file of ['log.txt', 'bin/webwallpaperlog.txt', 'bin/wallpaperuilog.txt', 'bin/debug.log'])
            try { result.runtimeLogs[file] = (await readFile(path.join(player.runtime.root, file), 'utf8')).slice(-12000); } catch {}
        }
        sceneRuntime ||= runtime?.sceneRuntime || (runtime?.sceneRoot ? { root: runtime.sceneRoot, token: runtime.token } : null);
        if (sceneRuntime) {
          result.sceneRuntimeIdentity ||= { root: sceneRuntime.root, token: sceneRuntime.token };
          try { result.privateShaderCache = await sceneCacheEvidence(sceneRuntime); await atomicJson(path.join(directory, 'private-shader-cache.json'), result.privateShaderCache); }
          catch (error) { result.privateShaderCacheFailure = error.stack; result.success = false; }
        }
        try { await player.stop(); result.cleaned = true; }
        catch (error) { result.cleanupFailure = error.stack; result.success = false; }
        stop.clearActive(player);
        result.privateRuntimeRemoved = !runtime || !(await exists(runtime.root));
        result.privateSceneRuntimeRemoved = !sceneRuntime || !(await exists(sceneRuntime.root));
        try {
          const afterMetadata = await sourceSnapshot(source.root);
          result.sourceMetadataAfter = snapshotSummary(afterMetadata); result.sourceManifestAfter = path.relative(evidence, path.join(directory, 'source-after.json'));
          await atomicJson(path.join(directory, 'source-after.json'), afterMetadata);
          result.sourceChanges = compareSnapshots(beforeMetadata, afterMetadata);
          result.originalSourceMetadataUnchanged = result.sourceChanges.metadataUnchanged && result.projectSha256 === await fileHash(source.project);
          result.originalSourceContentUnchanged = result.sourceChanges.contentUnchanged;
        } catch (error) { result.preservationFailure = error.stack; result.success = false; }
        result.originalConfigUnchanged = beforeConfig === await fileHash(installedConfig);
        if (!result.privateRuntimeRemoved || !result.privateSceneRuntimeRemoved || !result.originalSourceMetadataUnchanged || !result.originalSourceContentUnchanged || !result.originalConfigUnchanged || timedOut || stop.reason) result.success = false;
        result.timedOut = timedOut; result.finished = new Date().toISOString(); report.results.push(result); delete report.active; await persist();
        if (result.success) session.validatedProjects.push(item.project);
        console.log(JSON.stringify({ index: report.results.length, total: selected.length, title: result.title, type: result.type, success: result.success,
          observation: result.playbackObservation, frames: result.frames.length, capturesWithoutImage: result.capturesWithoutImage.length, gpuSequenceAdvanced: result.gpuSequenceAdvanced,
          failure: result.failure, cleaned: result.cleaned, privateRuntimeRemoved: result.privateRuntimeRemoved, privateSceneRuntimeRemoved: result.privateSceneRuntimeRemoved,
          privateShaderCacheFiles: result.privateShaderCache?.files.length, originalSourceMetadataUnchanged: result.originalSourceMetadataUnchanged,
          originalSourceContentUnchanged: result.originalSourceContentUnchanged, sourceAdded: result.sourceChanges?.added.map(row => row.path) }));
        // Preservation or cleanup failures require a fix before starting another
        // source. A broad matrix must not multiply source-local cache writes.
        if (!result.privateRuntimeRemoved || !result.privateSceneRuntimeRemoved || !result.cleaned) requestStop('cleanup-failed');
        if (!result.originalSourceMetadataUnchanged || !result.originalSourceContentUnchanged || !result.originalConfigUnchanged) requestStop('preservation-failed');
      }
    } });
  } catch (error) { if (!stop.reason) { report.failure = error.stack; requestStop('runner-failed'); } }
  finally {
    clearInterval(pauseTimer); clearTimeout(runTimer); await stop.stopping.catch(error => { report.stopFailure = error.stack; });
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); process.off('message', onMessage);
    report.originalConfigUnchanged = beforeConfig === await fileHash(installedConfig);
    session.finished = new Date().toISOString(); session.executed = executed; session.reusedCount = reused;
    session.stopRequested = report.stopRequested || null; session.failure = report.failure || null;
    report.completedProjects = selected.filter(item => session.validatedProjects.some(project => samePath(project, item.project))).length; report.selectedProjects = selected.length;
    report.success = report.completedProjects === selected.length && report.originalConfigUnchanged && !report.stopFailure && !report.failure;
    report.finished = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ evidence, success: report.success, inventory: counts, executed, reused, completedProjects: report.completedProjects,
      selectedProjects: selected.length, stopped: stop.reason, deferredVideos: report.deferredVideos.length }));
    if (!report.success) process.exitCode = 1;
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) await main();
