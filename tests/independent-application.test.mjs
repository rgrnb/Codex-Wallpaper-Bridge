import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { IndependentApplicationPlayer, PowerShellApplicationAdapter, inspectApplicationAudio, applicationRenderPolicy, applicationEnvironment } from '../src/independent-application.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-independent-application-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cwb-independent-application-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project.json');
  await writeFile(project, JSON.stringify({ type: 'application', file: 'wallpaper.exe' }));
  await writeFile(path.join(root, 'wallpaper.exe'), 'mock executable');
  const source = await describeSource(project), calls = [];
  const adapter = {
    async start(specification) { calls.push(['start', specification]); return { session: specification.session, pid: 123, startTime: '638962300000000000', executable: specification.executable }; },
    async surface(identity) { calls.push(['surface', identity]); return { hwnd: '1234', pid: identity.pid, startTime: identity.startTime, session: identity.session,
      sourceFile: identity.executable, type: 'application', backend: 'independent-owned-application', width: 640, height: 360 }; },
    async capture(identity) { calls.push(['capture', identity]); return { jpeg: 'authored-frame', width: 640, height: 360 }; },
    async stop(identity) { calls.push(['stop', identity]); },
  };
  return { root, source, calls, adapter };
}

test('application playback rejects unverified audio before starting any external process', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter });
  assert.equal((await inspectApplicationAudio()).safe, false);
  await assert.rejects(player.start({ ...f.source, nativeMuteVerified: true, audioSafety: { safe: true } }), /APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE/);
  assert.deepEqual(f.calls, []);
});

test('application session revalidates canonical project identity rather than accepting a supplied executable', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await writeFile(path.join(f.root, 'other.exe'), 'other mock executable');
  await assert.rejects(player.start({ ...f.source, resource: path.join(f.root, 'other.exe') }), /APPLICATION_SOURCE_IDENTITY_INVALID/);
  assert.deepEqual(f.calls, []);
});

test('only the trusted verifier can supply bounded launch arguments', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true, arguments: ['--offscreen'] }) });
  await player.start({ ...f.source, arguments: ['untrusted'] });
  assert.deepEqual(f.calls.find(([kind]) => kind === 'start')[1].arguments, ['--offscreen']);
  await player.stop();
  const denied = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true, arguments: ['bad\nargument'] }) });
  const before = f.calls.length;
  await assert.rejects(denied.start(f.source), /APPLICATION_ARGUMENTS_INVALID/);
  assert.equal(f.calls.length, before);
});

test('frames reuse exactly one process session and stop carries its immutable identity', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  assert.equal((await player.capture(f.source)).jpeg, 'authored-frame');
  assert.equal((await player.capture(f.source)).jpeg, 'authored-frame');
  assert.equal(f.calls.filter(([kind]) => kind === 'start').length, 1);
  const session = player.session;
  assert.ok(Object.isFrozen(session));
  await player.stop();
  assert.equal(f.calls.at(-1)[1], session);
  assert.equal(player.session, null);
});

test('session identity mismatch closes a possibly allocated worker job', async t => {
  const f = await fixture(t);
  f.adapter.start = async specification => ({ session: specification.session, pid: 123, startTime: '638962300000000000', executable: path.join(f.root, 'other.exe') });
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await assert.rejects(player.start(f.source), /APPLICATION_SESSION_IDENTITY_INVALID/);
  assert.equal(f.calls.at(-1)[0], 'stop');
  assert.equal(player.session, null);
});

test('window preparation failures release the exact newly created session', async t => {
  const f = await fixture(t); f.adapter.surface = async () => { throw new Error('APPLICATION_WINDOW_AMBIGUOUS'); };
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await assert.rejects(player.start(f.source), /APPLICATION_WINDOW_AMBIGUOUS/);
  assert.equal(f.calls.at(-1)[0], 'stop'); assert.equal(f.calls.at(-1)[1].pid, 123);
});

test('a rejected replacement preserves the previous owned application session', async t => {
  const f = await fixture(t); let safe = true;
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe }) });
  await player.start(f.source); const prior = player.session, before = f.calls.length;
  safe = false;
  await assert.rejects(player.start({ ...f.source, fingerprint: 'replacement' }), /APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE/);
  assert.equal(player.session, prior); assert.equal(f.calls.length, before);
  await player.stop();
});

test('serialized replacements cannot race captures into the next process session', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await Promise.all([player.capture(f.source), player.capture({ ...f.source, fingerprint: 'second' })]);
  const starts = f.calls.filter(([kind]) => kind === 'start'), captures = f.calls.filter(([kind]) => kind === 'capture');
  assert.equal(starts.length, 2); assert.equal(captures.length, 2);
  assert.notEqual(starts[0][1].session, starts[1][1].session);
  assert.equal(captures[0][1].session, starts[0][1].session); assert.equal(captures[1][1].session, starts[1][1].session);
  await player.stop();
});

test('active application frame reuse avoids full source hashing while a new fingerprint revalidates', async t => {
  const f = await fixture(t); let verifications = 0;
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => { verifications++; return { safe: true }; } });
  await player.capture(f.source); await player.capture(f.source); await player.capture(f.source);
  assert.equal(verifications, 1);
  await player.capture({ ...f.source, fingerprint: 'resource-watcher-change' });
  assert.equal(verifications, 2);
  await player.stop();
});

test('application pointer drops stale generations, invalid coordinates and requests after stop', async t => {
  const f = await fixture(t); const forwarded = [];
  f.adapter.pointer = async (identity, event) => { forwarded.push({ identity, event }); };
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start(f.source);
  assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.5 }, { current: () => false }), false);
  assert.equal(await player.pointer({ type: 'click', x: -1, y: 0.5 }), false);
  assert.equal(await player.pointer({ type: 'key', x: 0.5, y: 0.5 }), false);
  assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.5 }), true);
  assert.equal(forwarded.length, 1);
  const replacement = player.start({ ...f.source, fingerprint: 'replacement' });
  const stale = player.pointer({ type: 'click', x: 0.5, y: 0.5 });
  await replacement; assert.equal(await stale, false); assert.equal(forwarded.length, 1);
  await player.stop(); assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.5 }), false);
});

test('a capture failure releases the exact process session instead of retaining an idle renderer', async t => {
  const f = await fixture(t); f.adapter.capture = async () => { throw new Error('APPLICATION_FRAME_OWNER_INVALID'); };
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await assert.rejects(player.capture(f.source), /APPLICATION_FRAME_OWNER_INVALID/);
  assert.equal(player.session, null); assert.equal(f.calls.at(-1)[0], 'stop'); assert.equal(f.calls.at(-1)[1].pid, 123);
});

test('application launch reuse follows effective size while FPS and JPEG quality remain capture policy', async t => {
  const f = await fixture(t), captures = [];
  f.adapter.capture = async (identity, policy) => { captures.push({ identity, policy }); return { jpeg: 'frame' }; };
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.capture(f.source, { maxWidth: 960.2, fps: 60, jpegQuality: 78 });
  const first = player.session;
  await player.capture(f.source, { maxWidth: 960.4, height: 540.1, fps: 30, jpegQuality: 88 });
  assert.equal(player.session, first); assert.equal(captures.at(-1).policy.jpegQuality, 88);
  await player.capture(f.source, { maxWidth: 1280, fps: 30, jpegQuality: 88 });
  assert.notEqual(player.session, first);
  assert.equal(f.calls.filter(([kind]) => kind === 'start').length, 2);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'start').map(([, call]) => [call.policy.maxWidth, call.policy.height]), [[960, 540], [1280, 720]]);
  await player.stop();
});

test('nonfinite sizing values cannot reach Unity launch arguments or native allocation policy', () => {
  assert.deepEqual(applicationRenderPolicy({ maxWidth: Infinity, height: NaN, jpegQuality: -1 }), { maxWidth: 1280, height: 720, jpegQuality: 75 });
  assert.deepEqual(applicationRenderPolicy({ maxWidth: 10000, height: 10000, jpegQuality: 100 }), { maxWidth: 1920, height: 2160, jpegQuality: 95 });
});

test('stop invalidates a pending start and queued pointer before window preparation resumes', async t => {
  const f = await fixture(t); let release, started;
  const reachedStart = new Promise(resolve => { started = resolve; });
  f.adapter.start = specification => new Promise(resolve => { started(); release = () => resolve({ session: specification.session, pid: 123,
    startTime: '638962300000000000', executable: specification.executable }); });
  f.adapter.pointer = async () => { throw new Error('Cancelled input must not be delivered'); };
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  const starting = player.start(f.source); await reachedStart;
  const pointer = player.pointer({ type: 'click', x: 0.5, y: 0.5 }), stopping = player.stop();
  release();
  await assert.rejects(starting, /APPLICATION_START_CANCELLED/);
  assert.equal(await pointer, false); await stopping;
  assert.equal(f.calls.some(([kind]) => kind === 'surface'), false); assert.equal(player.session, null);
  assert.ok(f.calls.some(([kind, identity]) => kind === 'stop' && identity?.pid === 123));
});

test('stop invalidates an in-flight capture and the next visible capture can start normally', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start(f.source);
  let release, captured; const reachedCapture = new Promise(resolve => { captured = resolve; });
  f.adapter.capture = () => new Promise(resolve => { captured(); release = () => resolve({ jpeg: 'obsolete-frame' }); });
  const capture = player.capture(f.source); await reachedCapture; const stopped = player.stop(); release();
  await assert.rejects(capture, /APPLICATION_START_CANCELLED/); await stopped;
  f.adapter.capture = async () => ({ jpeg: 'new-visible-frame' });
  assert.equal((await player.capture(f.source)).jpeg, 'new-visible-frame');
  await player.stop();
});

test('a reused fingerprint cannot substitute another executable or source type', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start(f.source); const owned = player.session;
  await assert.rejects(player.start({ ...f.source, type: 'video' }), /APPLICATION_SOURCE_TYPE_INVALID/);
  await assert.rejects(player.start({ ...f.source, resource: path.join(f.root, 'other.exe') }), /APPLICATION_SOURCE_IDENTITY_INVALID/);
  assert.equal(player.session, owned); await player.stop();
});

test('a surface reply must belong to the exact started application session', async t => {
  const f = await fixture(t), surface = f.adapter.surface;
  for (const wrong of [{ pid: 999 }, { startTime: '638962300000000001' }, { sourceFile: path.join(f.root, 'other.exe') }, { hwnd: '0' }, { width: 100000 }]) {
    f.adapter.surface = async (...args) => ({ ...await surface(...args), ...wrong });
    const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
    await assert.rejects(player.start(f.source), /APPLICATION_SURFACE_IDENTITY_INVALID/); assert.equal(player.session, null);
  }
});

test('a prepared first frame is replaced when the caller changes JPEG quality', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start(f.source, { policy: { maxWidth: 640, height: 360, jpegQuality: 75 } });
  player.preparedFrame = { jpeg: 'prepared-lower-quality' }; player.preparedFramePolicy = applicationRenderPolicy({ maxWidth: 640, height: 360, jpegQuality: 75 });
  assert.equal((await player.capture(f.source, { maxWidth: 640, height: 360, jpegQuality: 88 })).jpeg, 'authored-frame');
  await player.stop();
});

test('preview mode never reuses a hidden application window', async t => {
  const f = await fixture(t), player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start(f.source); const hidden = player.session;
  await player.start(f.source, { preview: true });
  assert.notEqual(player.session, hidden); assert.equal(f.calls.filter(([kind]) => kind === 'start').at(-1)[1].preview, true);
  await player.stop();
});

test('application worker inherits only OS runtime environment fields', () => {
  assert.deepEqual(applicationEnvironment({ SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', USERNAME: 'fixture', USERDOMAIN: 'fixture-domain',
    OPENAI_API_KEY: 'test-secret', AWS_SECRET_ACCESS_KEY: 'test-secret', BRIDGE_CONTROL_TOKEN: 'test-secret', BRIDGE_DATA_DIR: 'private-user-data',
    NODE_OPTIONS: '--require unreviewed.js', PYTHONPATH: 'unreviewed-code', SECRET: 'test-secret' }), {
    SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', USERNAME: 'fixture', USERDOMAIN: 'fixture-domain' });
});

function workerFixture() {
  const child = new EventEmitter(); child.pid = 9876; child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.exitCode = 1; child.emit('exit', 1); return true; };
  const adapter = new PowerShellApplicationAdapter({ launch: () => child });
  return { child, adapter };
}

test('an interrupted worker request is cancelled immediately and stop awaits actual worker exit', async () => {
  const { child, adapter } = workerFixture();
  const starting = adapter.start({ session: 'test-pending-request' });
  const rejected = assert.rejects(starting, /APPLICATION_WORKER_STOPPED/);
  let finished = false; const stopped = adapter.stop(null).then(() => { finished = true; });
  await rejected; await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.pending, null); assert.equal(adapter.child, null); assert.equal(finished, false);
  child.exitCode = 0; child.emit('exit', 0); await stopped;
  assert.equal(finished, true);
});

test('player stop interrupts a pending worker startup instead of waiting for the startup timeout', async t => {
  const f = await fixture(t), { child, adapter } = workerFixture();
  const player = new IndependentApplicationPlayer({ adapter, verifyAudio: async () => ({ safe: true }) });
  const starting = player.start(f.source), rejected = assert.rejects(starting, /APPLICATION_WORKER_STOPPED/);
  while (!adapter.pending) await new Promise(resolve => setImmediate(resolve));
  const stopped = player.stop();
  assert.equal(adapter.pending, null);
  child.exitCode = 0; child.emit('exit', 0);
  await rejected; await stopped; assert.equal(player.session, null);
});

test('a cleanup failure preserves its runtime identity and the next stop retries it', async t => {
  const f = await fixture(t), runtime = { root: path.join(f.root, 'private-runtime'), token: 'owned-token' }, removals = [];
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }),
    removeRuntime: async value => { removals.push(value); if (removals.length === 1) throw new Error('APPLICATION_CLEANUP_TEMPORARILY_LOCKED'); } });
  await player.start(f.source); player.runtime = runtime;
  await assert.rejects(player.stop(), /APPLICATION_CLEANUP_TEMPORARILY_LOCKED/);
  assert.equal(player.runtime, runtime); assert.equal(player.session, null);
  await player.stop(); assert.equal(player.runtime, null); assert.deepEqual(removals, [runtime, runtime]);
});

test('a staging failure transfers retained cleanup ownership to the player without replacing the original error', async t => {
  const f = await fixture(t), runtime = { root: path.join(f.root, 'private-runtime'), token: 'owned-token' };
  const stageFailure = new Error('APPLICATION_CODE_COPY_CHANGED'); stageFailure.runtime = runtime;
  let locked = true;
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true, profile: 'trusted-test-profile' }),
    stageRuntime: async () => { throw stageFailure; }, removeRuntime: async value => { assert.equal(value, runtime); if (locked) throw new Error('APPLICATION_CLEANUP_TEMPORARILY_LOCKED'); } });
  await assert.rejects(player.start(f.source), failure => {
    assert.ok(failure instanceof AggregateError); assert.equal(failure.errors[0], stageFailure);
    assert.match(failure.message, /APPLICATION_CODE_COPY_CHANGED/); assert.match(failure.message, /APPLICATION_CLEANUP_TEMPORARILY_LOCKED/); return true;
  });
  assert.equal(player.runtime, runtime); assert.equal(f.calls.some(([kind]) => kind === 'start'), false);
  locked = false; await player.stop(); assert.equal(player.runtime, null);
});

test('project-supplied pointer flags cannot authorize native input virtualization', async t => {
  const f = await fixture(t);
  const player = new IndependentApplicationPlayer({ adapter: f.adapter, verifyAudio: async () => ({ safe: true }) });
  await player.start({ ...f.source, profile: 'unity-2017.2-reviewed-sheep',
    reviewedPointer: { profile: 'unity-2017.2-reviewed-sheep', runtimeToken: 'project-chosen-token' } });
  assert.equal(Object.hasOwn(f.calls.find(([kind]) => kind === 'start')[1], 'reviewedPointer'), false);
  await player.stop();
});

test('reviewed native pointer proof comes only from the trusted staged runtime', async t => {
  const f = await fixture(t), runtime = { executable: f.source.resource, token: 'trusted-runtime-token', root: f.root };
  f.adapter.capture = async () => ({ jpeg: 'authored-visible-frame', width: 640, height: 360, visibleContent: true });
  const player = new IndependentApplicationPlayer({ adapter: f.adapter,
    verifyAudio: async () => ({ safe: true, profile: 'unity-2017.2-reviewed-sheep' }),
    stageRuntime: async () => runtime, removeRuntime: async () => {} });
  await player.start({ ...f.source, reviewedPointer: { runtimeToken: 'untrusted-project-token' } });
  assert.deepEqual(f.calls.find(([kind]) => kind === 'start')[1].reviewedPointer,
    { profile: 'unity-2017.2-reviewed-sheep', runtimeToken: runtime.token });
  await player.stop();
});
