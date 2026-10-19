import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { enduranceSources, verifyHiddenSourceLifecycle } from '../scripts/independent-endurance.mjs';
import { measureHelperInterval, runtimeCleanupEvidence, cleanupProcessLedger } from '../scripts/independent-evidence.mjs';
import { ProcessSampler } from '../src/metrics.mjs';

const run = promisify(execFile), temporary = path.resolve(os.tmpdir());
async function fixture(t, cleanups = []) {
  const root = await mkdtemp(path.join(temporary, 'cwb-acceptance-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temporary);
    assert.ok(path.basename(root).startsWith('cwb-acceptance-test-'));
    // Test hooks run in registration order. Drain process observers before
    // removing mapped executables, including when an assertion fails early.
    try { for (const cleanup of cleanups) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  return root;
}

test('endurance includes every installed video and repeated reviewed application sessions between equal initial/final sources', () => {
  const videos = [1, 2, 3, 4].map(index => ({ project: `video-${index}` }));
  const sources = [['scene', 'scene-project'], ['web', 'web-project'], ['application', 'reviewed-sheep']];
  const sequence = enduranceSources(videos, sources);
  assert.deepEqual(sequence[0], ['video', 'video-1']); assert.deepEqual(sequence.at(-1), sequence[0]);
  for (const video of videos) assert.ok(sequence.some(([type, project]) => type === 'video' && project === video.project));
  assert.ok(sequence.filter(([type]) => type === 'application').length >= 2);
  assert.ok(sequence.some(([type]) => type === 'scene')); assert.ok(sequence.some(([type]) => type === 'web'));
  assert.throws(() => enduranceSources(videos, sources.slice(0, 2)), /ENDURANCE_SOURCE_REQUIRED:application/);
});

test('endurance alternates separate-volume Scene and installed Scene without dropping videos or Web', () => {
  const videos = Array.from({ length: 9 }, (_, index) => ({ project: `video-${index}` }));
  const sequence = enduranceSources(videos, [['scene', 'installed'], ['cross-volume-scene', 'separate-volume'], ['web', 'native-web'], ['application', 'reviewed-sheep']]);
  assert.equal(sequence.filter(([type]) => type === 'cross-volume-scene').length, 2);
  assert.equal(sequence.filter(([type]) => type === 'scene').length, 3);
  assert.equal(sequence.filter(([type]) => type === 'video').length, 10);
  assert.deepEqual(sequence.at(-1), sequence[0]);
});

function hiddenFixture(type, { reuseIdentity = false, leakRuntime = false } = {}) {
  const coordinator = { state: 'Active' }, player = { surface: null, runtime: null }, application = { session: null, runtime: null };
  const create = identity => {
    coordinator.state = 'Active';
    if (type === 'scene') { player.surface = { isolated: { token: identity } }; player.runtime = { token: identity }; }
    else { application.session = { session: identity }; application.runtime = { token: identity }; }
  };
  create('original-owned-identity');
  const minimized = new Set(), visible = new Set(), commands = [], mutations = [];
  return { coordinator, player, application, mutations, commands, type, cycle: 3,
    ready: () => coordinator.state === 'Active',
    async ownGeometry(index, action, ...argumentsList) {
      commands.push({ index, action, argumentsList });
      if (action === '--minimize') {
        minimized.add(index);
        if (minimized.size === 2) {
          coordinator.state = 'Paused'; player.surface = null; application.session = null;
          if (!leakRuntime) { player.runtime = null; application.runtime = null; }
        }
        return { stdout: JSON.stringify({ show: index ? 3 : 1, hwnd: `fixture-${index}`, started: 'original-start' }) };
      }
      if (action === '--visible') { visible.add(index); if (visible.size === 2) create(reuseIdentity ? 'original-owned-identity' : 'new-owned-identity'); }
      return { stdout: '{}' };
    },
    async pump(milliseconds, predicate) { return predicate(); },
  };
}

test('both-hidden acceptance proves new Scene and application identities rather than an empty-session condition', async () => {
  for (const type of ['scene', 'application']) {
    const context = hiddenFixture(type); await verifyHiddenSourceLifecycle(context);
    assert.equal(context.mutations.length, 2);
    assert.equal(context.mutations[0].type, type); assert.equal(context.mutations[0].sourceReleased, true);
    assert.notEqual(context.mutations[1].identityBefore, context.mutations[1].identityAfter);
    assert.deepEqual(context.commands.filter(command => command.action === '--restore').map(command => command.argumentsList),
      [[9, 'fixture-0', 'original-start'], [3, 'fixture-1', 'original-start']]);
    await assert.rejects(verifyHiddenSourceLifecycle(hiddenFixture(type, { reuseIdentity: true })), /SOURCE_NOT_RECREATED/);
    await assert.rejects(verifyHiddenSourceLifecycle(hiddenFixture(type, { leakRuntime: true })), /ALL_HIDDEN_NOT_RELEASED/);
  }
});

test('performance evidence obtains a CPU delta from the same sampler before and after the measured interval', async () => {
  let now = 1000, cpuMs = 10; const order = [];
  const sampler = new ProcessSampler({ clock: () => now, details: true, run: async (_host, argumentsList) => {
    assert.deepEqual(argumentsList, ['--metrics', '123']); order.push(`sample:${now}`);
    return { stdout: JSON.stringify([{ pid: 123, identity: 'same-owned-start', cpuMs, memory: 10, privateBytes: 20, handles: 3 }]) };
  } });
  const measured = await measureHelperInterval({ sampler, roots: () => [123], run: async () => { order.push('measured-work'); now = 2000; cpuMs = 260; return 'result'; } });
  assert.deepEqual(order, ['sample:1000', 'measured-work', 'sample:2000']);
  assert.equal(measured.baseline.cpu, null); assert.equal(measured.sample.cpu, 0.25); assert.equal(measured.result, 'result');
});

test('performance evidence rejects an absent helper baseline before invoking native metrics or measured work', async () => {
  let called = false;
  await assert.rejects(measureHelperInterval({ roots: () => [], sampler: { collect() { called = true; } }, run() { called = true; } }), /HELPER_BASELINE_REQUIRES_LIVE_ROOT/);
  assert.equal(called, false);
});

test('runtime cleanup evidence distinguishes retained directories from removed resources without deleting files', async t => {
  const root = await fixture(t), existing = path.join(root, 'runtime'), absent = path.join(root, 'already-removed');
  await mkdir(existing); await writeFile(path.join(existing, 'sentinel'), 'preserve');
  const evidence = await runtimeCleanupEvidence([{ backend: 'scene', root: existing, token: 'first' }, { backend: 'application', root: absent, token: 'second' }]);
  assert.equal(evidence[0].exists, true); assert.equal(evidence[0].directory, true); assert.equal(evidence[1].exists, false);
  assert.equal((await runtimeCleanupEvidence([{ root: path.join(existing, 'sentinel') }]))[0].exists, true);
});

test('cleanup keeps the original PID/start identity and never samples a recycled PID from an exited helper', async () => {
  const history = [{ pid: 41584, identity: 'original-helper-start', name: 'CodexWallpaperBridge' }];
  const ledger = await cleanupProcessLedger({ history, workers: [{ pid: 41584, exitCode: 0, signalCode: null }],
    sampler: { collect() { assert.fail('An exited helper PID may now belong to an unrelated user process.'); } } });
  assert.equal(ledger.has('41584:original-helper-start'), true);
  assert.equal(ledger.has('41584:recycled-conhost-start'), false);
});

test('cleanup binds new descendant identities only to a still-live original child and rejects an exit during sampling', async () => {
  const child = { pid: 123, exitCode: null, signalCode: null };
  const sample = { counters: [{ pid: 123, identity: 'owned-root' }, { pid: 456, identity: 'owned-descendant' }] };
  const owned = await cleanupProcessLedger({ workers: [child], sampler: { async collect(roots) { assert.deepEqual(roots, [123]); return sample; } } });
  assert.equal(owned.size, 2);
  const afterExit = await cleanupProcessLedger({ workers: [child], sampler: { async collect() { child.exitCode = 0; return { counters: [{ pid: 123, identity: 'unrelated-new-start' }] }; } } });
  assert.equal(afterExit.size, 0);
  child.exitCode = null;
  await assert.rejects(cleanupProcessLedger({ workers: [child], sampler: { async collect() { return { counters: [] }; } } }), /OWNED_HELPER_IDENTITY_UNAVAILABLE/);
});

test('environment settings checks support absent configuration and detect creation, modification or removal', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), probe = path.join(root, 'settings-test.ps1');
  await writeFile(probe, `param([string]$EnvironmentScript, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($EnvironmentScript, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-AcceptanceFileHash','Get-AcceptanceSettingsBaseline','Test-AcceptanceSettingsUnchanged')) {
  $function = $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  if ($function.Count -ne 1) { throw 'Expected one settings function.' }
  . ([scriptblock]::Create($function[0].Extent.Text))
}
$file = Join-Path $FixtureRoot 'settings.json'; $backup = Join-Path $FixtureRoot 'settings.backup.json'
$missing = Get-AcceptanceSettingsBaseline $file $backup
$result = [ordered]@{ missingAccepted = -not $missing.exists; unchangedAbsence = (Test-AcceptanceSettingsUnchanged $file $missing); noBackupCreated = -not (Test-Path -LiteralPath $backup) }
[IO.File]::WriteAllBytes($file, [byte[]]@(0,1,255,13,10))
$result.creationDetected = -not (Test-AcceptanceSettingsUnchanged $file $missing)
$present = Get-AcceptanceSettingsBaseline $file $backup
$result.presentUnchanged = Test-AcceptanceSettingsUnchanged $file $present
$result.backupExact = (Get-AcceptanceFileHash $backup) -eq (Get-AcceptanceFileHash $file)
[IO.File]::WriteAllText($file, 'modified fixture')
$result.modificationDetected = -not (Test-AcceptanceSettingsUnchanged $file $present)
Remove-Item -LiteralPath $file
$result.removalDetected = -not (Test-AcceptanceSettingsUnchanged $file $present)
$result | ConvertTo-Json -Compress
`);
  const environment = fileURLToPath(new URL('../scripts/independent-environment.ps1', import.meta.url));
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', probe, '-EnvironmentScript', environment, '-FixtureRoot', root], { windowsHide: true, timeout: 15000 });
  const result = JSON.parse(stdout); assert.equal(Object.keys(result).length, 8);
  assert.ok(Object.values(result).every(value => value === true), JSON.stringify(result));
});

test('owned process termination helper compiles without launching a target or GUI', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = fileURLToPath(new URL('../scripts/experiments/CodexWindowProbe.cs', import.meta.url));
  await run(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', `/out:${path.join(root, 'CodexWindowProbe.exe')}`, source], { windowsHide: true, timeout: 15000 });
});

test('native cleanup proof rejects an altered stamp and terminates only the authored owned root and child', { skip: process.platform !== 'win32' }, async t => {
  const cleanups = [], root = await fixture(t, cleanups), directory = path.join(root, 'WindowsApps', 'OpenAI.Codex_AuthoredFixture', 'app');
  await mkdir(directory, { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const helper = path.join(root, 'CodexWindowProbe.exe'), executable = path.join(directory, 'ChatGPT.exe'), source = path.join(root, 'AuthoredOwnedTree.cs');
  await writeFile(source, `using System;using System.Diagnostics;class AuthoredOwnedTree{static void Main(string[] args){if(args.Length>0){Console.ReadLine();return;}using(var child=Process.Start(new ProcessStartInfo(typeof(AuthoredOwnedTree).Assembly.Location,"child"){UseShellExecute=false,RedirectStandardInput=true,CreateNoWindow=true})){try{Console.WriteLine(child.Id);Console.Out.Flush();Console.ReadLine();}finally{if(!child.HasExited)child.Kill();}}}}`);
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, fileURLToPath(new URL('../scripts/experiments/CodexWindowProbe.cs', import.meta.url))], { windowsHide: true, timeout: 15000 });
  await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`, source], { windowsHide: true, timeout: 15000 });
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('exit', resolve));
  cleanups.push(async () => { child.stdin.end(); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } });
  const descendant = await new Promise((resolve, reject) => { let text = ''; child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(Number(text.trim())); }); child.once('error', reject); });
  assert.ok(Number.isInteger(descendant) && descendant > 0);
  const identity = JSON.parse((await run(helper, [String(child.pid), '--owned-stamp'], { windowsHide: true, timeout: 5000 })).stdout);
  assert.match(identity.started, /^\d{16,20}$/); assert.match(identity.nativeStarted, /^\d{16,20}$/);
  assert.equal(path.resolve(identity.nativeExecutable).toLowerCase(), path.resolve(executable).toLowerCase());
  await assert.rejects(run(helper, [String(child.pid), '--owned-terminate-tree', String(BigInt(identity.nativeStarted) + 1n), identity.nativeExecutable], { windowsHide: true, timeout: 5000 }), error => {
    const diagnostic = JSON.parse(error.stdout); assert.equal(diagnostic.code, 'OWNED_PROCESS_IDENTITY_INVALID');
    assert.equal(diagnostic.actual.nativeStarted, identity.nativeStarted); assert.notEqual(diagnostic.expected.nativeStarted, identity.nativeStarted); return true;
  });
  process.kill(child.pid, 0); process.kill(descendant, 0);
  const result = JSON.parse((await run(helper, [String(child.pid), '--owned-terminate-tree', identity.nativeStarted, identity.nativeExecutable], { windowsHide: true, timeout: 10000 })).stdout);
  assert.equal(result.identityVerified, true); assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.processes.map(row => row.pid).sort((a, b) => a - b), [child.pid, descendant].sort((a, b) => a - b));
  assert.ok(result.processes.every(row => row.exited)); await closed;
});

test('outside-package descendants are only observed; natural exit passes and a retained process fails without being terminated', { skip: process.platform !== 'win32' }, async t => {
  const cleanups = [], root = await fixture(t, cleanups), directory = path.join(root, 'WindowsApps', 'OpenAI.Codex_AuthoredFixture', 'app');
  await mkdir(directory, { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const helper = path.join(root, 'CodexWindowProbe.exe'), executable = path.join(directory, 'ChatGPT.exe');
  const source = path.join(root, 'OutsideOwnedTree.cs'), outside = path.join(root, 'OutsideFixture.exe');
  await writeFile(source, `using System;using System.Diagnostics;using System.Threading;class OutsideOwnedTree{static void Main(string[] args){if(args[0]=="external"){if(args[1]=="retained")Thread.Sleep(9000);else Console.ReadLine();return;}using(var child=Process.Start(new ProcessStartInfo(args[1],"external "+args[0]){UseShellExecute=false,RedirectStandardInput=true,CreateNoWindow=true})){Console.WriteLine(child.Id);Console.Out.Flush();Console.ReadLine();}}}`);
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, fileURLToPath(new URL('../scripts/experiments/CodexWindowProbe.cs', import.meta.url))], { windowsHide: true, timeout: 15000 });
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, source], { windowsHide: true, timeout: 15000 });
  await copyFile(executable, outside);
  for (const mode of ['natural', 'retained']) {
    const child = spawn(executable, [mode, outside], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise(resolve => child.once('exit', resolve));
    let descendant;
    cleanups.push(async () => {
      child.stdin.end(); await closed;
      if (!descendant) return;
      const deadline = Date.now() + 12000;
      while (true) {
        try { process.kill(descendant, 0); }
        catch (error) { assert.equal(error.code, 'ESRCH'); return; }
        assert.ok(Date.now() < deadline, 'The authored outside process must exit naturally before fixture removal.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    descendant = await new Promise((resolve, reject) => { let text = ''; child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(Number(text.trim())); }); child.once('error', reject); });
    const identity = JSON.parse((await run(helper, [String(child.pid), '--owned-stamp'], { windowsHide: true, timeout: 5000 })).stdout);
    let result;
    try { result = JSON.parse((await run(helper, [String(child.pid), '--owned-terminate-tree', identity.nativeStarted, identity.nativeExecutable], { windowsHide: true, timeout: 12000 })).stdout); }
    catch (error) { assert.equal(mode, 'retained'); assert.equal(error.code, 8); result = JSON.parse(error.stdout); }
    assert.equal(result.skipped.length, 0); assert.ok(result.observedOutside.some(row => row.pid === descendant));
    assert.ok(result.observedOutside.every(row => row.action === 'observe-natural-exit-only'));
    const observed = result.processes.find(row => row.pid === descendant);
    assert.equal(observed.action, 'observe-natural-exit-only'); assert.equal(observed.exited, mode === 'natural');
    assert.equal(path.resolve(observed.executable).toLowerCase(), path.resolve(outside).toLowerCase());
    if (mode === 'retained') {
      process.kill(descendant, 0); // Still alive: the helper did not cross its termination fence.
      const deadline = Date.now() + 5000;
      while (true) { try { process.kill(descendant, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await closed;
  }
});
