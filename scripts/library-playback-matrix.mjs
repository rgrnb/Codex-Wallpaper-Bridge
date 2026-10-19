import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Run through independent-environment.ps1 -BridgeNotRunning -TestScript
// scripts/library-playback-matrix.mjs. Runner arguments remain inside this
// bounded orchestrator. BRIDGE_MATRIX_RESUME can select this orchestrator's
// previous evidence directory; a saved explicit pause is never cleared here.
const root = fileURLToPath(new URL('../', import.meta.url));
const helpers = ['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll', 'BridgeApplicationInput.dll', 'BridgeApplicationInputHook32.dll', 'BridgeWebIntegration.exe'];
const sources = ['package.json', 'src/isolated-player.mjs', 'src/private-scene.mjs', 'src/independent-application.mjs',
  'src/silent-unity-application.mjs', 'src/independent-application-worker.ps1', 'src/library.mjs', 'src/platform.mjs',
  'src/cdp.mjs', 'src/wallpaper-engine.mjs', 'scripts/library-playback-acceptance.mjs'];
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const resume = process.env.BRIDGE_MATRIX_RESUME;
const evidence = resume ? path.resolve(resume) : path.join(root, '.local-evidence', `library-playback-matrix-${randomUUID()}`);
await mkdir(path.join(evidence, 'helper'), { recursive: true });
const reportFile = path.join(evidence, 'result.json'), pauseFile = path.join(evidence, 'pause.request.json');
let report = resume ? JSON.parse(await readFile(reportFile, 'utf8')) : { schemaVersion: 1, evidence, started: new Date().toISOString(),
  success: false, expectedProjects: 32, actualCodex: false, helperSha256: {}, sourceSha256: {}, batches: [] };
assert.equal(report.schemaVersion, 1);
if (!resume) {
  for (const name of helpers) {
    const source = path.join(root, 'build', name), destination = path.join(evidence, 'helper', name), before = await digest(source);
    await copyFile(source, destination); assert.equal(await digest(destination), before, `Changed helper snapshot: ${name}`); report.helperSha256[name] = before;
  }
  for (const source of sources) report.sourceSha256[source] = await digest(path.join(root, source));
}
let writes = Promise.resolve();
async function atomicWrite(bytes) {
  const temporary = `${reportFile}.${randomUUID()}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(temporary, bytes); break; }
    catch (error) { if (attempt >= 10 || !['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }
  }
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, reportFile); return; }
    catch (error) { if (attempt >= 10 || !['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }
  }
}
const persist = () => { const bytes = JSON.stringify(report, null, 2); writes = writes.catch(() => {}).then(() => atomicWrite(bytes)); return writes; };
let child = null, stopReason = null, checkingPause = false;
const requestPause = reason => {
  if (stopReason) return; stopReason = reason; report.stopRequested = { reason, at: new Date().toISOString() }; persist().catch(() => {});
  if (child?.connected) child.send({ action: 'pause' });
};
const onInterrupt = () => requestPause('SIGINT'), onTerminate = () => requestPause('SIGTERM');
process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
const checkPause = async () => {
  if (checkingPause || stopReason) return; checkingPause = true;
  try { if (await stat(pauseFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) requestPause('pause.request.json'); }
  catch (error) { requestPause(`pause-check-failed:${error.code || error.message}`); }
  finally { checkingPause = false; }
};
const timer = setInterval(checkPause, 100);
async function verifyFrozenInputs() {
  for (const name of helpers) assert.equal(await digest(path.join(evidence, 'helper', name)), report.helperSha256[name], `Frozen helper changed: ${name}`);
  for (const source of sources) assert.equal(await digest(path.join(root, source)), report.sourceSha256[source], `Renderer source changed: ${source}`);
}
async function batch() {
  const row = { index: report.batches.length + 1, started: new Date().toISOString() }; report.batches.push(row); await persist();
  const parameters = ['scripts/library-playback-acceptance.mjs', '--types=scene,web,application'];
  if (report.runnerEvidence) parameters.push(`--resume=${report.runnerEvidence}`);
  child = spawn(process.execPath, parameters, { cwd: root, windowsHide: true,
    env: { ...process.env, BRIDGE_POINTER_BUILD: path.join(evidence, 'helper') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let buffer = '', stderr = '';
  const consume = chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); if (!line) continue;
      console.log(line);
      try { const item = JSON.parse(line); if (item.evidence && item.pauseFile) report.runnerEvidence = item.evidence; } catch {}
    }
  };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', consume);
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const owned = child;
  row.exitCode = await new Promise((resolve, reject) => { owned.once('error', reject); owned.once('exit', resolve); }); child = null;
  row.stderr = stderr; row.finished = new Date().toISOString();
  assert.ok(report.runnerEvidence, `Runner did not establish an evidence checkpoint: ${stderr}`);
  const current = JSON.parse(await readFile(path.join(report.runnerEvidence, 'result.json'), 'utf8')), session = current.sessions.at(-1);
  row.executed = session.executed; row.reused = session.reusedCount; row.completed = current.completedProjects; row.selected = current.selectedProjects;
  row.stopRequested = current.stopRequested || null; row.failure = current.failure || null;
  const latest = new Map(current.results.map(item => [path.resolve(item.project).toLowerCase(), item]));
  row.failedProjects = [...latest.values()].filter(item => !item.success).map(item => ({ title: item.title, project: item.project, failure: item.failure,
    cleanupFailure: item.cleanupFailure, originalSourceMetadataUnchanged: item.originalSourceMetadataUnchanged,
    originalSourceContentUnchanged: item.originalSourceContentUnchanged, privateRuntimeRemoved: item.privateRuntimeRemoved,
    privateSceneRuntimeRemoved: item.privateSceneRuntimeRemoved, originalConfigUnchanged: item.originalConfigUnchanged }));
  report.inventory = current.inventory; report.completedProjects = current.completedProjects; report.selectedProjects = current.selectedProjects;
  await persist(); console.log(JSON.stringify({ matrixEvidence: evidence, batch: row.index, executed: row.executed, reused: row.reused,
    completed: row.completed, selected: row.selected, stop: row.stopRequested?.reason, failedProjects: row.failedProjects }));
  assert.equal(current.selectedProjects, report.expectedProjects, 'Library selection changed; retain this checkpoint and inspect the inventory.');
  if (row.failedProjects.length) throw new Error('MATRIX_PROJECT_FAILED');
  if (current.success) { report.success = true; return true; }
  if (stopReason || current.stopRequested?.reason !== 'project-count-bound') throw new Error(`MATRIX_STOPPED:${stopReason || current.stopRequested?.reason || current.failure || 'unknown'}`);
  assert.ok(session.executed > 0, 'The bounded batch made no progress.'); return false;
}
try {
  await checkPause(); await persist(); console.log(JSON.stringify({ matrixEvidence: evidence, pauseFile, helperSha256: report.helperSha256 }));
  for (let index = 0; index < 12; index++) {
    if (stopReason) break; await verifyFrozenInputs(); if (await batch()) break;
  }
  if (!report.success && !stopReason) throw new Error('MATRIX_BATCH_LIMIT');
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  clearInterval(timer); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  report.finished = new Date().toISOString(); if (stopReason) report.success = false; await persist();
  console.log(JSON.stringify({ matrixEvidence: evidence, runnerEvidence: report.runnerEvidence, success: report.success,
    completedProjects: report.completedProjects, selectedProjects: report.selectedProjects, failure: report.failure, stopReason }));
  if (!report.success) process.exitCode = 1;
}
