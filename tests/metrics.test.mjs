import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSampler } from '../src/metrics.mjs';

test('process CPU sampling uses counter deltas and excludes recycled PID history', async () => {
  let now = 0, identity = 'first', cpuMs = 10;
  const sampler = new ProcessSampler({ clock: () => now, run: async () => ({ stdout: JSON.stringify([
    { pid: 42, identity, cpuMs, memory: 1024, privateBytes: 2048, handles: 5 }
  ]) }) });
  assert.equal((await sampler.collect([42])).cpu, null);
  now = 1000; cpuMs = 510; const measured = await sampler.collect([42]);
  assert.equal(measured.cpu, 0.5); assert.equal(measured.memory, 1024); assert.equal(measured.handles, 5);
  now = 2000; identity = 'recycled'; cpuMs = 99999;
  assert.equal((await sampler.collect([42])).cpu, null);
});
