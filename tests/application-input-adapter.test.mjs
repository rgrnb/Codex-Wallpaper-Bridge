import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PowerShellApplicationAdapter } from '../src/independent-application.mjs';

async function launchCase(specification) {
  const calls = [], child = new EventEmitter();
  Object.assign(child, { pid: 9876, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.stdin.on('data', bytes => {
    const request = JSON.parse(bytes.toString());
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { started: true } }) + '\n'));
  });
  const graphicsHost = path.resolve('trusted-native', 'CodexWallpaperBridge.exe');
  const adapter = new PowerShellApplicationAdapter({ graphicsHost, launch: (...args) => { calls.push(args); return child; } });
  try { assert.deepEqual(await adapter.start(specification), { started: true }); }
  finally { child.exitCode = 0; child.emit('exit', 0); await adapter.abort(); }
  return { calls, graphicsHost };
}

test('reviewed Sheep input uses the x86 OS worker and adjacent trusted AnyCPU assembly', async () => {
  const { calls, graphicsHost } = await launchCase({ reviewedPointer: {
    profile: 'unity-2017.2-reviewed-sheep', runtimeToken: '12345678-1234-1234-1234-123456789abc' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\\SysWOW64\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0][1].at(-2), '-GraphicsHost');
  assert.equal(calls[0][1].at(-1), path.join(path.dirname(graphicsHost), 'BridgeApplicationInput.dll'));
  assert.equal(calls[0][2].windowsHide, true);
});

test('generic and unknown-profile applications keep the ordinary window-message worker', async () => {
  for (const specification of [{}, { reviewedPointer: { profile: 'unknown-unity', runtimeToken: 'caller-value' } }]) {
    const { calls, graphicsHost } = await launchCase(specification);
    assert.equal(calls[0][0], 'powershell.exe');
    assert.equal(calls[0][1].at(-1), graphicsHost);
  }
});
