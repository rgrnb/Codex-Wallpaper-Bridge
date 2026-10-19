import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  IsolatedPlayer, inspectIsolatedSource, privateEngineConfiguration,
  removePrivateEngine, stagePrivateEngine, validateNativeWebTarget, validateNativeWebDocument,
} from '../src/isolated-player.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { validateSettings } from '../src/config.mjs';
import { stagePrivateScene } from '../src/private-scene.mjs';

const temporary = path.resolve(os.tmpdir());
async function fixture(t) {
  const root = await mkdtemp(path.join(temporary, 'cwb-isolated-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temporary);
    assert.ok(path.basename(root).startsWith('cwb-isolated-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>owned fixture</title>');
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html' }));
  return { root, source: await describeSource(path.join(root, 'project.json')) };
}
function ownedPlayer(type = 'web') {
  const sent = [];
  const player = new IsolatedPlayer({
    launch() { assert.fail('A pointer test must never launch an external process.'); },
    frames: { child: {}, async pointer(surface, event) { sent.push(['frames', surface, event]); }, stop() {} },
  });
  player.source = { type, fingerprint: 'first-source', resource: path.join(temporary, 'owned fixture', 'index.html') };
  player.runtime = { token: randomUUID(), webDebugPort: 9345 };
  player.worker = { exitCode: null };
  player.surface = { type, hwnd: '123', pid: 456 };
  const url = pathToFileURL(player.source.resource).href;
  player.webDocument = { target: { type: 'page', id: 'owned-target', url,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9345/devtools/page/owned-target' }, frameId: 'owned-frame', loaderId: 'owned-loader', contextId: 123 };
  player.pipe = { async call(action, parameters) { sent.push([action, parameters]); } };
  const client = {
    async evaluate() { return { url, navigationUrl: url, width: 640, height: 360 }; },
    async call(method, parameters) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'owned-frame', loaderId: 'owned-loader', url } } };
      if (method === 'Runtime.evaluate') {
        assert.equal(parameters.contextId, 123); assert.equal(parameters.returnByValue, true);
        return { result: { value: await client.evaluate() } };
      }
      sent.push([method, parameters]);
    },
    close() {},
  };
  player.webInputClient = async () => client;
  return { player, client, sent };
}
const point = { type: 'click', x: 0.5, y: 0.25 };
const dispatched = sent => sent.filter(([name]) => name === 'Input.dispatchMouseEvent').map(([, event]) => event);

function protocolPlayer(t, { holdStart = false } = {}) {
  const stages = [], cleaned = [], launches = [], starts = [], captures = [], workers = [];
  const source = { type: 'scene', resource: path.join(temporary, 'owned-fixture', 'scene.pkg'),
    fingerprint: 'owned-protocol-fixture', properties: { speed: 1 } };
  const player = new IsolatedPlayer({
    frames: { stop() {}, async capture(surface, policy) { captures.push({ surface, policy }); return { jpeg: 'owned fixture' }; } },
    async stage(selected, options) {
      const token = randomUUID(), runtime = { token, root: path.join(temporary, `cwb-runtime-${token}`) };
      stages.push({ selected, options, runtime }); return runtime;
    },
    async cleanup(runtime) { cleaned.push(runtime); },
    launch(executable, argumentsList, options) {
      launches.push({ executable, argumentsList, options });
      const worker = new EventEmitter(), runtime = stages.at(-1).runtime;
      worker.exitCode = null; worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
      const end = () => { if (worker.exitCode === null) { worker.exitCode = 0; worker.emit('exit', 0); } };
      let input = '';
      worker.stdin = new Writable({
        write(chunk, encoding, done) {
          input += chunk.toString();
          for (let at; (at = input.indexOf('\n')) >= 0;) {
            const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
            assert.equal(request.token, runtime.token);
            if (request.action === 'start') {
              starts.push(request); assert.equal(request.root, runtime.root);
              if (!holdStart) queueMicrotask(() => worker.stdout.write(JSON.stringify({ id: request.id, result: {
                type: request.type, width: request.width, height: request.height, hwnd: '123', pid: 456,
                isolated: { token: runtime.token, enginePath: path.join(runtime.root, 'wallpaper64.exe') },
                audioConfiguration: 'private-engine-output-disabled',
              } }) + '\n'));
            } else if (request.action === 'stop') queueMicrotask(() => {
              worker.stdout.write(JSON.stringify({ id: request.id, result: { stopped: true } }) + '\n'); end();
            });
            else assert.fail(`Unexpected protocol action ${request.action}`);
          }
          done();
        },
        final(done) { end(); done(); },
      });
      worker.kill = end; workers.push(worker); return worker;
    },
  });
  player.inspect = async () => ({ safe: true });
  t.after(() => player.stop());
  return { player, source, stages, cleaned, launches, starts, captures, workers };
}

test('private engine configuration disables audio and desktop overrides before any process starts', () => {
  for (const type of ['scene', 'web', 'video']) {
    const source = { type, resource: path.join(temporary, 'authored', 'wallpaper.file') };
    const config = privateEngineConfiguration({ source, properties: { volume: 100, speed: 2 }, username: 'fixture',
      runtime: path.join(temporary, 'private-runtime'), fps: 37, webDebugPort: 9345 });
    const user = config.fixture.general.user, file = source.resource.replaceAll('\\', '/');
    assert.equal(user.videoaudiooutput, false, type);
    for (const setting of ['autostart', 'autostartscheduler', 'overridewallpaper', 'overridelockscreen']) assert.equal(user[setting], false, setting);
    assert.equal(user.fps, 37);
    assert.deepEqual(config.fixture.wproperties[file].Monitor0, { volume: 0, speed: 2 });
    assert.equal(config.fixture.general.wallpaperconfigscreensaver.selectedwallpapers.Monitor0.file, file);
    if (type === 'web') assert.match(user.cefcommandline, /--remote-debugging-address=127\.0\.0\.1/);
    else assert.equal(user.cefcommandline, undefined);
  }
});

test('owned host reuse follows dimensions, user FPS, properties and preview mode across the real pipe protocol', async t => {
  const f = protocolPlayer(t), policy = { maxWidth: 1280, fps: 60 };
  const first = await f.player.start(f.source, { policy });
  assert.equal(first.width, 1280); assert.equal(first.height, 720);
  assert.equal(await f.player.start(f.source, { policy: { ...policy } }), first);
  await f.player.capture(f.source, policy);
  assert.equal(f.starts.length, 1); assert.equal(f.stages.length, 1); assert.equal(f.captures.length, 1);
  const larger = await f.player.start(f.source, { policy: { ...policy, maxWidth: 1920, height: 1200 } });
  assert.equal(larger.width, 1920); assert.equal(larger.height, 1200);
  assert.notEqual(larger.isolated.token, first.isolated.token);
  await f.player.start(f.source, { policy: { maxWidth: 1920, height: 1200, fps: 30 } });
  assert.equal(f.stages.at(-1).options.policy.fps, 30);
  await f.player.start(f.source, { policy: { maxWidth: 1920, height: 1200, fps: 30 }, preview: true });
  assert.equal(f.starts.at(-1).preview, true);
  await f.player.start(f.source, { policy: { maxWidth: 1920, height: 1200, fps: 30 }, preview: true, properties: { speed: 2 } });
  assert.deepEqual(f.stages.at(-1).options.properties, { speed: 2 });
  assert.equal(f.starts.length, 5);
  await f.player.stop();
  assert.equal(f.cleaned.length, 5); assert.ok(f.workers.every(worker => worker.exitCode === 0));
});

test('temporary load adjustment changes frame policy without restarting the private engine at the same user ceiling', async t => {
  const f = protocolPlayer(t), policy = { maxWidth: 1280, fps: 60, autoAdjusted: false };
  await f.player.capture(f.source, policy);
  await f.player.capture(f.source, { ...policy, fps: 30, autoAdjusted: true });
  await f.player.capture(f.source, policy);
  assert.equal(f.starts.length, 1); assert.equal(f.stages[0].options.policy.fps, 60);
  assert.deepEqual(f.captures.map(({ policy }) => policy.fps), [60, 30, 60]);
});

test('private host launch receives OS variables and excludes credentials, bridge tokens and runtime injection settings', async t => {
  const f = protocolPlayer(t), previous = process.env;
  process.env = { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', TEMP: temporary, USERNAME: 'fixture',
    OPENAI_API_KEY: 'synthetic-api-key', BRIDGE_CONTROL_TOKEN: 'synthetic-control-token', bridge_control_token: 'synthetic-case-token',
    BRIDGE_PARENT_PID: '123', BRIDGE_NATIVE_HOST: 'synthetic-private-path', NODE_OPTIONS: '--require synthetic-untrusted-code',
    HTTP_PROXY: 'http://synthetic-user:synthetic-password@127.0.0.1:1' };
  try { await f.player.start(f.source); } finally { process.env = previous; }
  const { env, windowsHide, stdio } = f.launches[0].options;
  assert.deepEqual(env, { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', TEMP: temporary, USERNAME: 'fixture' });
  assert.equal(windowsHide, true); assert.deepEqual(stdio, ['pipe', 'pipe', 'pipe']);
});

test('stop closes a host waiting for its first renderer and releases the exact staged runtime', async t => {
  const f = protocolPlayer(t, { holdStart: true });
  const starting = f.player.start(f.source);
  while (!f.starts.length) await new Promise(resolve => setImmediate(resolve));
  const stop = f.player.stop();
  await assert.rejects(starting, /ISOLATED_(?:CANCELLED|HOST_CLOSED)/); await stop;
  assert.equal(f.cleaned.length, 1); assert.equal(f.cleaned[0], f.stages[0].runtime);
  assert.equal(f.workers[0].exitCode, 0); assert.equal(f.player.surface, null);
});

test('a temporary cleanup failure keeps the exact runtime identity for a later stop retry', async t => {
  const f = protocolPlayer(t), attempts = [];
  await f.player.start(f.source);
  const runtime = f.stages[0].runtime;
  f.player.cleanup = async identity => {
    attempts.push(identity);
    if (attempts.length === 1) throw new Error('ISOLATED_CLEANUP_TEMPORARILY_LOCKED');
  };
  await assert.rejects(f.player.stop(), /ISOLATED_CLEANUP_TEMPORARILY_LOCKED/);
  assert.equal(f.workers[0].exitCode, 0);
  await f.player.stop();
  assert.deepEqual(attempts, [runtime, runtime]);
  assert.equal(f.player.runtime, null);
});

test('native Web target identity rejects unrelated files, remote hosts and altered debugger capabilities', () => {
  const resource = path.join(temporary, 'authored space', 'index.html'), port = 9345;
  const target = { id: 'owned-target', type: 'page', url: pathToFileURL(resource).href,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/owned-target` };
  assert.equal(validateNativeWebTarget(target, port, resource), true);
  for (const patch of [
    { type: 'iframe' }, { id: '../other' }, { id: 'different' },
    { url: pathToFileURL(path.join(temporary, 'other', 'index.html')).href },
    { url: target.url + '?token=authored' }, { url: target.url + '#other' },
    { url: 'https://example.invalid/index.html' }, { url: 'file://remote/share/index.html' },
    { webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/owned-target` },
    { webSocketDebuggerUrl: `ws://127.0.0.2:${port}/devtools/page/owned-target` },
    { webSocketDebuggerUrl: `ws://127.0.0.1:${port + 1}/devtools/page/owned-target` },
    { webSocketDebuggerUrl: `ws://user:secret@127.0.0.1:${port}/devtools/page/owned-target` },
    { webSocketDebuggerUrl: target.webSocketDebuggerUrl + '?authored' },
    { webSocketDebuggerUrl: target.webSocketDebuggerUrl + '#authored' },
    { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned-target` },
  ]) assert.equal(validateNativeWebTarget({ ...target, ...patch }, port, resource), false, JSON.stringify(patch));
});

test('native Web history routes require the exact initial document and current frame proof', () => {
  const source = path.join(temporary, 'authored route', 'index.html'), url = pathToFileURL(source).href;
  const route = pathToFileURL(path.join(path.dirname(source), 'circuit')).href;
  const target = { id: 'owned-route', type: 'page', url: route, webSocketDebuggerUrl: 'ws://127.0.0.1:9345/devtools/page/owned-route' };
  const document = { navigationUrl: url, url: route, frameUrl: route, frameId: 'owned-frame', loaderId: 'owned-loader' };
  assert.equal(validateNativeWebTarget(target, 9345, source), false, 'A same-directory route alone is never source proof.');
  assert.equal(validateNativeWebDocument(target, 9345, source, document), true);
  for (const patch of [
    { navigationUrl: route }, { navigationUrl: url + '?other' }, { navigationUrl: url + '#other' },
    { navigationUrl: pathToFileURL(path.join(path.dirname(source), 'unrelated.html')).href },
    { navigationUrl: 'https://example.invalid/index.html' }, { navigationUrl: null },
    { frameUrl: url }, { frameId: undefined }, { loaderId: undefined }, { loaderId: '' },
    { url: pathToFileURL(path.join(temporary, 'unrelated', 'circuit')).href },
  ]) assert.equal(validateNativeWebDocument(target, 9345, source, { ...document, ...patch }), false, JSON.stringify(patch));
  assert.equal(validateNativeWebDocument({ ...target, webSocketDebuggerUrl: target.webSocketDebuggerUrl.replace('9345', '9346') }, 9345, source, document), false);
});

test('new Web documents revoke the existing pointer connection even when reloading the same source URL', async () => {
  const { player, client, sent } = ownedPlayer();
  const call = client.call; let closed = 0;
  client.close = () => closed++;
  client.call = async (method, parameters) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'owned-frame', loaderId: 'new-document', url: pathToFileURL(player.source.resource).href } } }
    : call(method, parameters);
  assert.equal(await player.pointer(point), false);
  assert.equal(closed, 1); assert.deepEqual(dispatched(sent), []);
});

test('an authored same-document history route retains normalized Web pointer input', async () => {
  const { player, client, sent } = ownedPlayer();
  const source = pathToFileURL(player.source.resource).href, route = pathToFileURL(path.join(path.dirname(player.source.resource), 'circuit')).href;
  client.evaluate = async () => ({ url: route, navigationUrl: source, width: 640, height: 360 });
  const call = client.call;
  client.call = async (method, parameters) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'owned-frame', loaderId: 'owned-loader', url: route } } }
    : call(method, parameters);
  assert.equal(await player.pointer(point), true);
  assert.deepEqual(dispatched(sent).map(event => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('unverified engines and forged source identities have no process or active-session side effects', async t => {
  const { root, source } = await fixture(t), executable = path.join(root, 'wallpaper64.exe');
  await writeFile(executable, 'not the verified engine');
  let stopped = 0, launched = 0;
  const player = new IsolatedPlayer({ executable, launch() { launched++; assert.fail('Unverified engine must not launch.'); },
    frames: { stop() { stopped++; } } });
  const previous = { type: 'scene', fingerprint: 'owned-existing' }, surface = { hwnd: '123' };
  player.source = previous; player.surface = surface; player.worker = { exitCode: null };
  await assert.rejects(player.start(source), /ISOLATED_ENGINE_VERSION_UNVERIFIED/);
  assert.equal((await inspectIsolatedSource({ ...source, resource: path.join(root, 'other.html') }, executable)).code, 'ISOLATED_SOURCE_IDENTITY_INVALID');
  await assert.rejects(stagePrivateEngine({ ...source, type: 'application' }, { executable }), /APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE/);
  assert.equal(launched, 0); assert.equal(stopped, 0);
  assert.equal(player.source, previous); assert.equal(player.surface, surface);
});

test('private runtime cleanup detaches only its junctions and preserves referenced original resources', async t => {
  const { root: authored } = await fixture(t), token = randomUUID(), root = path.join(temporary, `cwb-runtime-${token}`);
  const links = ['assets', 'locale'];
  await mkdir(root);
  t.after(async () => {
    for (const name of links) await unlink(path.join(root, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    assert.equal(path.dirname(root), temporary); assert.equal(path.basename(root), `cwb-runtime-${token}`);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, '.bridge-isolated.json'), JSON.stringify({ token }));
  for (const name of links) await symlink(authored, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
  await removePrivateEngine({ root, token });
  await assert.rejects(access(root), { code: 'ENOENT' });
  assert.match(await readFile(path.join(authored, 'index.html'), 'utf8'), /owned fixture/);
});

test('cleanup refuses wrong markers and non-temporary runtime roots without deleting content', async t => {
  const { root: owner } = await fixture(t), token = randomUUID(), root = path.join(owner, `cwb-runtime-${token}`);
  await mkdir(root); await writeFile(path.join(root, '.bridge-isolated.json'), JSON.stringify({ token }));
  await assert.rejects(removePrivateEngine({ root, token }), /ISOLATED_CLEANUP_SCOPE_INVALID/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.bridge-isolated.json'), 'utf8')), { token });
  const wrongRoot = path.join(temporary, `cwb-runtime-${token}`);
  await mkdir(wrongRoot); await writeFile(path.join(wrongRoot, '.bridge-isolated.json'), JSON.stringify({ token: randomUUID() }));
  t.after(async () => { assert.equal(path.dirname(wrongRoot), temporary); await rm(wrongRoot, { recursive: true, force: true }); });
  await assert.rejects(removePrivateEngine({ root: wrongRoot, token }), /ISOLATED_CLEANUP_SCOPE_INVALID/);
  await access(path.join(wrongRoot, '.bridge-isolated.json'));
});

test('engine cleanup releases its private Scene hardlinks and cache without touching source files', async t => {
  const { root: owned } = await fixture(t), installed = path.join(owned, 'engine'), authored = path.join(owned, 'scene');
  await mkdir(installed); await mkdir(authored);
  await writeFile(path.join(authored, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.json' }));
  await writeFile(path.join(authored, 'scene.json'), '{"objects":[]}');
  const source = await describeSource(path.join(authored, 'project.json')), token = randomUUID();
  const scene = await stagePrivateScene(source, { installed, token }), root = path.join(temporary, `cwb-runtime-${token}`);
  await mkdir(root);
  t.after(async () => { assert.equal(path.dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, '.bridge-isolated.json'), JSON.stringify({ token, type: 'scene',
    installedEngine: path.join(installed, 'wallpaper64.exe'), originalResource: source.resource, resource: scene.resource, sceneRuntime: scene }));
  await writeFile(path.join(scene.root, 'shaders', 'blobsSM40', `${'c'.repeat(40)}.dxs`), Buffer.from('SHDV0069\0private compiled code'));
  await removePrivateEngine({ root, token });
  await assert.rejects(access(root), { code: 'ENOENT' });
  await assert.rejects(access(scene.root), { code: 'ENOENT' });
  assert.equal(await readFile(source.resource, 'utf8'), '{"objects":[]}');
  await assert.rejects(access(path.join(authored, 'shaders')), { code: 'ENOENT' });
});

test('a forged Scene cleanup pointer cannot remove an unrelated directory', async t => {
  const { root: outside } = await fixture(t), token = randomUUID(), root = path.join(temporary, `cwb-runtime-${token}`);
  await mkdir(root);
  t.after(async () => { assert.equal(path.dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, '.bridge-isolated.json'), JSON.stringify({ token, type: 'scene',
    installedEngine: path.join(outside, 'wallpaper64.exe'), sceneRuntime: { root: outside, token } }));
  await assert.rejects(removePrivateEngine({ root, token }), /ISOLATED_CLEANUP_SCOPE_INVALID/);
  await access(path.join(root, '.bridge-isolated.json'));
  assert.match(await readFile(path.join(outside, 'index.html'), 'utf8'), /owned fixture/);
});

test('pointer queues drop old sessions, revoked generations and invalid input before touching helpers', async () => {
  for (const type of ['scene', 'web']) {
    const { player, sent } = ownedPlayer(type);
    let release;
    const gate = player.serial(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const stale = player.pointer(point);
    player.runtime = { ...player.runtime, token: randomUUID() };
    release(); await gate; assert.equal(await stale, false, type);
    assert.equal(await player.pointer(point, { current: () => false }), false);
    for (const invalid of [{ ...point, x: NaN }, { ...point, y: Infinity }, { ...point, x: -0.1 }, { ...point, y: 1.1 }, { ...point, type: 'key' }])
      assert.equal(await player.pointer(invalid), false);
    assert.deepEqual(sent, []);
  }
});

test('native Web input rejects a navigated target and a lease revoked during client lookup', async () => {
  const { player, client, sent } = ownedPlayer();
  client.evaluate = async () => ({ matches: false, width: 640, height: 360 });
  assert.equal(await player.pointer(point), false);
  let valid = true;
  player.webInputClient = async () => { valid = false; return client; };
  assert.equal(await player.pointer(point, { current: () => valid }), false);
  assert.deepEqual(dispatched(sent), []);
});

test('a cached native Web connection still revalidates owned endpoint on every input', async () => {
  const { player, client, sent } = ownedPlayer();
  delete player.webInputClient;
  client.ws = { readyState: WebSocket.OPEN };
  player.webClient = client; player.webEndpointPid = 456;
  let verifications = 0, owned = true;
  player.pipe.call = async action => {
    assert.equal(action, 'input-endpoint'); verifications++;
    if (!owned) throw new Error('ISOLATED_INPUT_ENDPOINT_UNAVAILABLE');
    return { verified: true, port: player.runtime.webDebugPort, pid: 456 };
  };
  assert.equal(await player.pointer({ ...point, type: 'move' }), true);
  assert.equal(await player.pointer({ ...point, type: 'move' }), true);
  assert.equal(verifications, 2);
  owned = false;
  await assert.rejects(player.pointer(point), /ISOLATED_INPUT_ENDPOINT_UNAVAILABLE/);
  assert.equal(verifications, 3);
  assert.deepEqual(dispatched(sent).map(event => event.type), ['mouseMoved', 'mouseMoved']);
});

test('invalid native endpoint proofs cannot reuse a cached connection', async () => {
  for (const proof of [null, { verified: false, pid: 456, port: 9345 }, { verified: true, pid: 0, port: 9345 },
    { verified: true, pid: '456', port: 9345 }, { verified: true, pid: 456, port: 9346 }]) {
    const { player, client, sent } = ownedPlayer(); delete player.webInputClient;
    client.ws = { readyState: WebSocket.OPEN }; player.webClient = client; player.webEndpointPid = 456;
    player.pipe.call = async () => proof;
    await assert.rejects(player.pointer(point), /ISOLATED_INPUT_ENDPOINT_UNAVAILABLE/);
    assert.deepEqual(dispatched(sent), []);
  }
});

test('native Web click maps normalized coordinates and pairs press and release after lease expiration', async () => {
  const { player, client, sent } = ownedPlayer(); let valid = true;
  const original = client.call;
  client.call = async (method, parameters) => { const result = await original(method, parameters); if (parameters.type === 'mousePressed') valid = false; return result; };
  assert.equal(await player.pointer(point, { current: () => valid }), true);
  const events = dispatched(sent);
  assert.deepEqual(events.map(event => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(events.every(event => event.x === 319.5 && event.y === 89.75));
  assert.equal(events.at(-1).buttons, 0);
});

test('an ambiguous native Web press failure still attempts button release', async () => {
  const { player, client, sent } = ownedPlayer(), original = client.call;
  client.call = async (method, parameters) => {
    const result = await original(method, parameters);
    if (parameters.type === 'mousePressed') throw new Error('CDP_TIMEOUT');
    return result;
  };
  await assert.rejects(player.pointer(point), /CDP_TIMEOUT/);
  assert.deepEqual(dispatched(sent).map(event => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('requesting stop revokes input already waiting on client discovery', async () => {
  const { player, client, sent } = ownedPlayer(); let resume, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  player.webInputClient = async () => { reached(); await new Promise(resolve => { resume = resolve; }); return client; };
  // Keep this a lifecycle test without real processes or directories to remove.
  player._stop = async () => { player.surface = player.runtime = player.worker = player.source = null; };
  const pointer = player.pointer(point); await entered;
  const stop = player.stop(); resume();
  await pointer; await stop;
  assert.deepEqual(dispatched(sent), []);
});

test('stop cancels source inspection already in flight before staging or process launch', async () => {
  for (const operation of ['start', 'capture']) {
    const { player, sent } = ownedPlayer('scene'); let reached, resume;
    const entered = new Promise(resolve => { reached = resolve; });
    player.inspect = async () => { reached(); await new Promise(resolve => { resume = resolve; }); return { safe: true }; };
    player._stop = async () => { player.surface = player.runtime = player.worker = player.source = null; };
    const work = player[operation]({ type: 'scene', fingerprint: 'replacement' });
    await entered; const stop = player.stop(); resume();
    await assert.rejects(work, /ISOLATED_CANCELLED/); await stop;
    assert.deepEqual(sent, []); assert.equal(player.surface, null);
  }
});

test('a delayed first backend input cannot renew the age of later clicks in the same drained batch', async t => {
  let wallTime = 100000;
  t.mock.method(Date, 'now', () => wallTime);
  const source = { type: 'scene', fingerprint: 'owned-scene' }, accepted = [];
  const settings = { value: validateSettings({ enabled: true }) };
  const presentation = {
    adapter: {}, windows: new Map([['one', { generation: 0, visible: true }]]), visibleCount: 1,
    async heartbeat() {}, async configure() {}, async reconcile() {}, async frame() {}, async setPointerMode() {},
    drainPointers() { return [{ ...point, sequence: 1, receivedAt: 100000 }, { ...point, sequence: 2, receivedAt: 100000 }]; },
  };
  const player = {
    backend: 'wallpaper-engine-isolated', async inspect() { return { safe: true }; },
    async capture() { return { jpeg: 'owned fixture' }; },
    async pointer(event, { current }) {
      if (current()) accepted.push(event.sequence);
      if (event.sequence === 1) wallTime += 300;
    },
  };
  const coordinator = new Coordinator({ settings, presentation, player, frames: { stop() {} },
    wallpaper: { async observe() { return { source }; } },
    probe: async () => ({ codex: [{ version: 'fixture', endpoints: [9345] }] }),
    log: { async event() {} }, clock: () => wallTime });
  coordinator.source = source; coordinator.state = 'Active';
  await coordinator.tick();
  assert.deepEqual(accepted, [1]);
});
