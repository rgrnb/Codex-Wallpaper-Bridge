import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from '../src/platform.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { IndependentApplicationPlayer, PowerShellApplicationAdapter } from '../src/independent-application.mjs';

const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.join(ROOT, '.local-evidence', `application-independent-${randomUUID()}`);
const executable = path.join(root, 'BridgeApplicationFixture.exe');
await mkdir(root, { recursive: true });
await run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`,
  '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', path.join(ROOT, 'scripts', 'experiments', 'fixtures', 'IndependentApplicationFixture.cs')], { windowsHide: true });
await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'application', file: path.basename(executable), title: 'Authored silent independent fixture' }));
const source = await describeSource(path.join(root, 'project.json')), expectedHash = digest(await readFile(executable));
const pointerReport = path.join(root, 'pointer.jsonl');
const messageTrace = path.join(root, 'messages.jsonl');
const verifyAudio = async candidate => ({ safe: candidate.resource === executable && digest(await readFile(candidate.resource)) === expectedHash,
  evidence: 'Authored reviewed WinForms drawing fixture: no audio, external commands, network or user data.', arguments: ['--offscreen', '--report', pointerReport, '--trace', messageTrace] });
const adapter = new PowerShellApplicationAdapter(), player = new IndependentApplicationPlayer({ adapter, verifyAudio });
const unrelated = spawn(executable, ['--offscreen'], { windowsHide: true, stdio: 'ignore' });
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid) { for (let attempt = 0; attempt < 50; attempt++) { if (!running(pid)) return; await delay(100); } throw new Error(`Owned fixture remained alive: ${pid}`); }
const result = { started: new Date().toISOString(), fixture: true, actualApplicationAccepted: false, arbitraryApplicationAudioIsolated: false };
const snapshot = async name => {
  const file = path.join(root, `${name}.json`); await run(executable, ['--snapshot', file], { windowsHide: true, timeout: 5000 });
  return JSON.parse(await readFile(file, 'utf8'));
};
try {
  result.inputBefore = await snapshot('input-before');
  const frames = [];
  for (let sample = 0; sample < 5; sample++) { result.stage = `sample-${sample}`; frames.push(digest((await player.capture(source, { maxWidth: 640, jpegQuality: 75 })).jpeg)); await delay(150); }
  assert.ok(new Set(frames).size > 1, 'The independent owned fixture must animate.');
  const identity = player.session;
  result.identity = identity; result.surface = player.surface;
  assert.notEqual(identity.pid, unrelated.pid);
  result.stage = 'pointer-move';
  assert.equal(await player.pointer({ type: 'move', x: 0.25, y: 0.75 }), true);
  let moveReceived = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { moveReceived = (await readFile(pointerReport, 'utf8')).trim().split('\n').map(JSON.parse).some(row => row.type === 'move' && Math.abs(row.x / (row.width - 1) - 0.25) < 0.01); } catch {}
    if (moveReceived) break; await delay(100);
  }
  assert.ok(moveReceived, 'The first queued move must actually reach the authored application before the next event.');
  result.stage = 'pointer-click';
  assert.equal(await player.pointer({ type: 'click', x: 0.6, y: 0.4 }), true);
  let received = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    try { received = (await readFile(pointerReport, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch {}
    if (received.some(row => row.type === 'up')) break; await delay(100);
  }
  assert.ok(received.some(row => row.type === 'move' && Math.abs(row.x / (row.width - 1) - 0.25) < 0.01 && Math.abs(row.y / (row.height - 1) - 0.75) < 0.01));
  for (const type of ['down', 'up']) assert.ok(received.some(row => row.type === type && Math.abs(row.x / (row.width - 1) - 0.6) < 0.01 && Math.abs(row.y / (row.height - 1) - 0.4) < 0.01));
  result.pointerWindowMessagesActuallyReceived = received;
  result.stage = 'repeated-pointer'; result.repeatedClicks = 0;
  for (let click = 0; click < 8; click++) {
    await player.pointer({ type: 'click', x: 0.6, y: 0.4 });
    let completed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const rows = (await readFile(pointerReport, 'utf8')).trim().split('\n').map(JSON.parse);
      if (rows.filter(row => row.type === 'up').length >= click + 2) { completed = true; break; }
      await delay(100);
    }
    assert.ok(completed, `Repeated click ${click + 1} must finish its actual release handler.`); result.repeatedClicks++;
  }
  result.inputAfter = await snapshot('input-after');
  assert.deepEqual(result.inputAfter, result.inputBefore, 'Forwarding must preserve physical cursor and foreground HWND.');
  result.foregroundAndCursorUnchanged = true;
  result.pointerScope = 'Authored application receives move/down/up at mapped client coordinates. This does not prove third-party Unity Input or Raw Input semantics.';
  result.stage = 'guards';
  await assert.rejects(adapter.surface({ ...identity, pid: unrelated.pid }, {}), /APPLICATION_SESSION_IDENTITY_INVALID/);
  await assert.rejects(adapter.capture({ ...identity, session: randomUUID() }, {}), /APPLICATION_SESSION_IDENTITY_INVALID/);
  await assert.rejects(adapter.capture({ ...identity, startTime: '638962300000000001' }, {}), /APPLICATION_SESSION_IDENTITY_INVALID/);
  result.stage = 'normal-stop'; await player.stop(); await gone(identity.pid);
  assert.ok(running(unrelated.pid), 'Same-executable unrelated process must remain untouched.');
  result.changingFrames = true; result.identityGuards = ['pid', 'start-time', 'session']; result.unrelatedRetained = true;
  const crashAdapter = new PowerShellApplicationAdapter(), crashPlayer = new IndependentApplicationPlayer({ adapter: crashAdapter, verifyAudio });
  try {
    result.stage = 'worker-death'; await crashPlayer.start(source); const owned = crashPlayer.session.pid;
    crashAdapter.child.kill(); await gone(owned);
    result.workerDeathCleansJob = true;
  } finally { await crashPlayer.stop().catch(() => {}); }
  result.passed = true;
} catch (failure) {
  result.failure = { message: failure.message, stack: failure.stack }; process.exitCode = 1;
  try { result.pointerWindowMessagesActuallyReceived = (await readFile(pointerReport, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  try { result.messageTrace = (await readFile(messageTrace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  try { result.fixtureException = await readFile(`${messageTrace}.failure.txt`, 'utf8'); } catch {}
} finally {
  await player.stop().catch(failure => { result.cleanupFailure = failure.message; process.exitCode = 1; });
  if (unrelated.exitCode === null) unrelated.kill();
  result.finished = new Date().toISOString();
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ passed: result.passed || false, stage: result.stage, repeatedClicks: result.repeatedClicks,
  foregroundAndCursorUnchanged: result.foregroundAndCursorUnchanged, failure: result.failure?.message,
  evidence: path.join(root, 'result.json') }));
