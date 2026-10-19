import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../src/coordinator.mjs';
import { validateSettings } from '../src/config.mjs';
import { IsolatedPlayer } from '../src/isolated-player.mjs';
import { IndependentApplicationPlayer, PowerShellApplicationAdapter } from '../src/independent-application.mjs';

test('a reused PID in the instance record is only queried, never terminated or unlinked', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const acquire = source.slice(source.indexOf('  async function acquire()'), source.indexOf('  const lock = await acquire()'));
  const calls = [];
  await assert.rejects(runInNewContext(`${acquire}; acquire()`, {
    lockPath: 'owned-fixture-lock', open: async () => { throw Object.assign(new Error(), { code: 'EEXIST' }); },
    readFile: async () => '12345', unlink: async () => assert.fail('A live unrelated PID must not be removed.'),
    process: { kill: (pid, signal) => calls.push({ pid, signal }) },
  }), /BRIDGE_ALREADY_RUNNING/);
  assert.deepEqual(calls, [{ pid: 12345, signal: 0 }]);
});

test('overlapping settings saves stay ordered and keep ticks blocked until the newest save finishes', async () => {
  let firstRelease, firstEntered, secondRelease, secondEntered, active = 0, maximum = 0;
  const first = new Promise(resolve => { firstEntered = resolve; }), second = new Promise(resolve => { secondEntered = resolve; });
  const store = { value: validateSettings({ enabled: true }), async save(value) {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => { if (value.fpsLimit === 30) { firstRelease = resolve; firstEntered(); } else { secondRelease = resolve; secondEntered(); } });
    this.value = validateSettings(value); active--;
  } };
  const coordinator = new Coordinator({ settings: store, presentation: { windows: new Map() }, log: {} });
  const older = coordinator.applySettings({ ...store.value, fpsLimit: 30 }); await first;
  const newer = coordinator.applySettings({ ...store.value, fpsLimit: 120 });
  firstRelease(); await older; await second;
  assert.equal(coordinator.changingSettings, true); assert.equal(maximum, 1);
  secondRelease(); await newer;
  assert.equal(coordinator.changingSettings, false); assert.equal(store.value.fpsLimit, 120);
});

test('stop restores presentation and tries every backend even when one cleanup times out', async () => {
  const calls = [];
  const coordinator = new Coordinator({ wallpaper: { close() {} }, frames: { stop() {} },
    presentation: { async restore() { calls.push('restore'); } },
    web: { async stop() { calls.push('web'); throw new Error('STOP_TIMEOUT'); } },
    player: { async stop() { calls.push('player'); } }, application: { async stop() { calls.push('application'); } },
    log: { async event() {} } });
  await assert.rejects(coordinator.stop(), /OWNED_CLEANUP_PENDING/);
  assert.deepEqual(calls, ['restore', 'web', 'player', 'application']); assert.equal(coordinator.state, 'Recovering');
});

test('a failed application stop retains its process identity and runtime until a successful retry', async () => {
  let timedOut = true; const removed = [], identity = { pid: 42, startTime: '12345678901234567' }, runtime = { token: 'fixture' };
  const player = new IndependentApplicationPlayer({ adapter: { async stop(value) { assert.equal(value, identity); if (timedOut) throw new Error('APPLICATION_WORKER_STOP_TIMEOUT'); } },
    removeRuntime: async value => removed.push(value) });
  player.session = identity; player.runtime = runtime;
  await assert.rejects(player.stop(), /STOP_TIMEOUT/); assert.equal(player.session, identity); assert.equal(player.runtime, runtime); assert.deepEqual(removed, []);
  timedOut = false; await player.stop(); assert.deepEqual(removed, [runtime]); assert.equal(player.runtime, null); assert.equal(player.session, null);
});

test('an unkillable isolated worker reports timeout and retains runtime; a later exit permits cleanup', async () => {
  const runtime = { token: 'fixture' }, removed = [];
  const worker = { exitCode: null, stdin: { end() {} }, kill() { return false; } };
  const player = new IsolatedPlayer({ frames: { stop() {} }, cleanup: async value => removed.push(value) });
  player.worker = worker; player.pipe = { async call() {} }; player.runtime = runtime;
  await assert.rejects(player.stop(), /ISOLATED_STOP_TIMEOUT/);
  assert.equal(player.worker, worker); assert.equal(player.runtime, runtime); assert.deepEqual(removed, []);
  worker.exitCode = 0; await player.stop(); assert.equal(player.worker, null); assert.equal(player.runtime, null); assert.deepEqual(removed, [runtime]);
});

test('application worker termination timeout stays visible and prevents a replacement worker', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false });
  const adapter = new PowerShellApplicationAdapter({ launch: () => child }); adapter.open();
  // Keep the fixture alive while production timers remain unref'ed.
  const keepAlive = delay(3200);
  await assert.rejects(adapter.abort(), /APPLICATION_WORKER_STOP_TIMEOUT/);
  assert.equal(adapter.stoppingChild, child); assert.throws(() => adapter.open(), /STOP_PENDING/);
  child.exitCode = 0; child.emit('exit', 0); await adapter.stop(null); assert.equal(adapter.stoppingChild, null); await keepAlive;
});

test('an exited isolated host restores through failure before the next retry can launch a replacement', async () => {
  let staged = 0, removed = 0;
  const player = new IsolatedPlayer({ frames: { stop() {} }, stage: async () => { staged++; }, cleanup: async () => { removed++; } });
  player.source = { fingerprint: 'fixture' }; player.worker = { exitCode: 1 }; player.runtime = { token: 'fixture' };
  await assert.rejects(player.capture(player.source), /ISOLATED_HOST_CLOSED/);
  assert.equal(staged, 0); assert.equal(removed, 1); assert.equal(player.worker, null);
});
