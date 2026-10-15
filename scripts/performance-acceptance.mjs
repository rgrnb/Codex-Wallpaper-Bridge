import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ProcessSampler } from '../src/metrics.mjs';
import { PROFILES } from '../src/config.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
export async function measureBaseline(children) {
  const sampler = new ProcessSampler({ details: true, scope: 'owned-codex-process-trees' }), roots = children.map(child => child.pid);
  await sampler.collect(roots); await delay(15000);
  return sampler.collect(roots);
}

// Only bridge-owned canvases, authored input and process counters are inspected.
// This is a bounded engineering endurance run, not a claim about every GPU/codec.
export async function verifyPerformance({ checks, children, presentation, options, report, seconds = 120, focusTestWindow, minimizeTestWindow, resumeTestWindow }) {
  const sampler = new ProcessSampler({ details: true, scope: 'owned-codex-process-trees' }), roots = children.map(child => child.pid), samples = [], modes = [];
  report.performance = { windows: checks.length, source: '3840x2160 original video / native decoder', modes, samples, partial: true };
  await sampler.collect(roots);
  for (const name of ['performance', 'balanced', 'quality']) {
    await focusTestWindow?.();
    const policy = { ...PROFILES[name], paused: false };
    await presentation.configure({ ...options, policy }); await delay(1500); await presentation.heartbeat();
    const fps = [];
    for (let i = 0; i < 4; i++) {
      await delay(1500); await presentation.heartbeat();
      fps.push([...presentation.windows.values()].map(window => window.fps));
    }
    const playback = [...presentation.windows.values()].map(window => window.playback);
    assert.ok(playback.every(value => value.nativeFile && value.sourceWidth === 3840 && value.sourceHeight === 2160));
    assert.ok(fps.flat().every(value => value >= policy.fps * 0.65 && value <= policy.fps * 1.18), `Measured ${name} FPS outside the declared test tolerance: ${JSON.stringify(fps)}`);
    modes.push({ name, targetFps: policy.fps, fps, playback, processTree: await sampler.collect(roots) });
  }
  if (minimizeTestWindow && resumeTestWindow) {
    await minimizeTestWindow(); await delay(2500); await presentation.heartbeat();
    assert.equal([...presentation.windows.values()][0].visible, false);
    await resumeTestWindow(); await delay(1500); await presentation.heartbeat();
    assert.equal([...presentation.windows.values()][0].visible, true); report.minimizeResume = true;
  }
  await presentation.configure(options); await delay(5000); await presentation.heartbeat();
  const start = Date.now(), latencies = [];
  while (Date.now() - start < seconds * 1000) {
    await delay(3000); await presentation.heartbeat();
    assert.equal(presentation.windows.size, checks.length);
    const windows = [...presentation.windows.values()].map(window => ({ fps: window.fps, visible: window.visible, playback: window.playback }));
    assert.ok(windows.every(window => window.playback?.nativeFile));
    const at = performance.now();
    assert.ok(await checks[0].client.evaluate("!!document.querySelector('canvas[data-cwb-owned=\"v1\"]')"));
    latencies.push(performance.now() - at);
    samples.push({ seconds: Math.round((Date.now() - start) / 1000), processTree: await sampler.collect(roots), windows,
      bridgeNode: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, resources: process.getActiveResourcesInfo().sort() } });
  }
  const early = samples.slice(0, Math.max(1, Math.floor(samples.length / 3))), late = samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
  const mean = (rows, key) => rows.reduce((sum, row) => sum + row.processTree[key], 0) / rows.length;
  const memoryGrowth = mean(late, 'privateBytes') - mean(early, 'privateBytes'), handlesGrowth = mean(late, 'handles') - mean(early, 'handles');
  const identity = counter => `${counter.pid}:${counter.identity}`;
  const startCounters = new Map(samples[0].processTree.counters.map(counter => [identity(counter), counter]));
  const endCounters = new Map(samples.at(-1).processTree.counters.map(counter => [identity(counter), counter]));
  const commonKeys = new Set([...startCounters.keys()].filter(key => endCounters.has(key)));
  const meanCommonHandles = rows => rows.reduce((sum, row) => sum + row.processTree.counters.filter(counter => commonKeys.has(identity(counter))).reduce((total,counter)=>total+counter.handles,0),0)/rows.length;
  const comparableHandleGrowth = meanCommonHandles(late)-meanCommonHandles(early);
  const newProcesses = [...endCounters.entries()].filter(([key]) => !startCounters.has(key)).map(([,counter]) => counter);
  report.performance = { windows: checks.length, source: '3840x2160 original video / native decoder', modes, partial: false,
    durationSeconds: Math.round((Date.now() - start) / 1000), privateBytesGrowth: memoryGrowth, handlesGrowth, comparableHandleGrowth, newProcesses,
    rendererRoundTripP95Ms: percentile(latencies, 0.95), samples,
    visibleSamples: samples.filter(row => row.windows.some(window => window.visible)).length,
    pausedSamples: samples.filter(row => row.windows.every(window => !window.visible)).length,
    gpu: 'unavailable', spatialQualityReduced: false };
  // Reference-system tolerances account for independent Codex background work.
  // They are engineering gates, not historical PRD numbers or a zero-leak proof.
  assert.ok(memoryGrowth < Math.max(128 * 1024 * 1024, mean(early, 'privateBytes') * 0.15), `Unbounded private-byte growth: ${memoryGrowth}`);
  // Compare the same process identities. Raw totals include independent Codex
  // child creation; keep that total and every new child visible in the report.
  assert.ok(comparableHandleGrowth < Math.max(150, meanCommonHandles(early) * 0.05), `Comparable process handle growth: ${comparableHandleGrowth}`);
  assert.ok(samples.at(-1).bridgeNode.rss - samples[0].bridgeNode.rss < 32*1024*1024, 'Bridge Node RSS growth exceeded the reference-system tolerance.');
  assert.ok(percentile(latencies, 0.95) < 250, 'Renderer responsiveness p95 must remain below 250 ms on the reference system.');
}
