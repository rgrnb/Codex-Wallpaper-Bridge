import { lstat } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Use one sampler across both readings. A first reading alone has no CPU delta.
export async function measureHelperInterval({ sampler, roots, run }) {
  const baselineRoots = roots();
  assert.ok(baselineRoots.some(pid => Number.isInteger(pid) && pid > 0), 'HELPER_BASELINE_REQUIRES_LIVE_ROOT');
  const baseline = await sampler.collect(baselineRoots);
  const result = await run();
  const sampledRoots = roots();
  assert.ok(sampledRoots.some(pid => Number.isInteger(pid) && pid > 0), 'HELPER_SAMPLE_REQUIRES_LIVE_ROOT');
  const sample = await sampler.collect(sampledRoots);
  return { baselineRoots, sampledRoots, baseline, sample, result };
}

export async function runtimeCleanupEvidence(runtimes) {
  return Promise.all(runtimes.map(async runtime => {
    try {
      const info = await lstat(runtime.root);
      return { ...runtime, exists: true, directory: info.isDirectory(), reference: info.isSymbolicLink() };
    } catch (error) {
      if (error.code !== 'ENOENT') return { ...runtime, exists: null, error: error.code || 'RUNTIME_INSPECTION_FAILED' };
      return { ...runtime, exists: false };
    }
  }));
}

// A historical PID is not ownership. Keep identities from actual live-source
// measurements, and sample only original ChildProcess handles still alive.
export async function cleanupProcessLedger({ sampler, workers, history = [] }) {
  const live = child => child.exitCode === null && child.signalCode === null;
  const rows = [...history];
  for (const child of workers) {
    if (!live(child)) continue;
    const sample = await sampler.collect([child.pid]);
    // On Windows the original process handle prevents PID reuse until its exit
    // callback. Recheck after I/O before admitting this root and descendants.
    if (!live(child)) continue;
    if (!sample.counters?.some(row => row.pid === child.pid)) throw new Error('OWNED_HELPER_IDENTITY_UNAVAILABLE');
    rows.push(...sample.counters);
  }
  return new Map(rows.map(row => [`${row.pid}:${row.identity}`, row]));
}
