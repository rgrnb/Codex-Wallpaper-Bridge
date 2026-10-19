import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProcessSampler } from '../src/metrics.mjs';

export function enduranceSources(videos, sources) {
  assert.ok(videos.length > 0);
  const required = type => { const source = sources.find(([kind]) => kind === type); assert.ok(source, `ENDURANCE_SOURCE_REQUIRED:${type}`); return source; };
  const scene = required('scene'), nativeWeb = required('web'), application = required('application'), sequence = [];
  const scenes = [scene, ...sources.filter(([type]) => type === 'cross-volume-scene')];
  for (let index = 0; index < videos.length; index++) {
    sequence.push(['video', videos[index].project], index % 2 ? nativeWeb : scenes[Math.floor(index / 2) % scenes.length]);
    if (index % 3 === 0) sequence.push(application);
  }
  sequence.push(application, nativeWeb, ['video', videos[0].project]);
  return sequence;
}

export async function verifyHiddenSourceLifecycle({ type, cycle, coordinator, player, application, ownGeometry, pump, ready, mutations }) {
  assert.ok(['scene', 'application'].includes(type));
  const identity = () => type === 'application' ? application?.session?.session : player.surface?.isolated?.token;
  const before = identity(); assert.ok(before, `ENDURANCE_${type.toUpperCase()}_IDENTITY_REQUIRED`);
  const placements = [];
  for (let index = 0; index < 2; index++) placements.push(JSON.parse((await ownGeometry(index, '--minimize')).stdout));
  assert.ok(await pump(12000, () => coordinator.state === 'Paused' && !player.surface && !application?.session &&
    !player.runtime && !application?.runtime), `ENDURANCE_${type.toUpperCase()}_ALL_HIDDEN_NOT_RELEASED`);
  mutations.push({ cycle, type, operation: 'both-minimized', sourceReleased: true, state: coordinator.state, identityBefore: before });
  for (let index = 0; index < 2; index++) {
    await ownGeometry(index, '--restore', placements[index].show === 3 ? 3 : 9, placements[index].hwnd, placements[index].started);
    await ownGeometry(index, '--visible');
  }
  assert.ok(await pump(45000, ready), `ENDURANCE_${type.toUpperCase()}_ALL_HIDDEN_RESUME_FAILED`);
  const after = identity();
  assert.ok(after && after !== before, `ENDURANCE_${type.toUpperCase()}_SOURCE_NOT_RECREATED`);
  mutations.push({ cycle, type, operation: 'both-restored', nativeRecreated: true, identityBefore: before, identityAfter: after });
}

// Called only by the exact-PID, empty-profile physical-window acceptance runner.
// No user window, conversation, global WE command or persisted user preference.
export async function verifyIndependentEndurance(context) {
  const { seconds, videos, sources, coordinator, presentation, player, application, frames, web, clients,
    children, ownGeometry, width, height, pump, signature, evidence, report } = context;
  assert.ok(Number.isInteger(seconds) && seconds >= 120 && seconds <= 3600);
  assert.ok(videos.length > 0);
  const result = report.endurance = { requestedSeconds: seconds, actualPhysicalWindows: 2,
    physicalDisplayCount: 1, samples: [], cycles: [], mutations: [], completed: false,
    tolerances: { nodeRssGrowthBytes: 128 * 1024 ** 2, comparableHandleGrowth: 'max(300, 10%)',
      comparablePrivateGrowthBytes: 'max(256 MiB, 20%)', rendererRoundTripP95Ms: 250 },
    scope: 'One physical display; isolated official Codex profiles; same-source early/late resource comparison; GPU counters unavailable.' };
  const sampler = new ProcessSampler({ details: true, scope: 'owned-codex-process-trees' });
  const helperSampler = new ProcessSampler({ details: true, scope: 'owned-active-capture-and-web-helpers' });
  // Exercise every installed Video and repeatedly create/release Scene, native
  // Web and the reviewed Sheep. Return to the initial Video for comparison.
  const sequence = enduranceSources(videos, sources), hiddenTypes = new Set();
  const slotMs = seconds * 1000 / sequence.length, started = Date.now(), roundTrips = [];
  const checkpoint = async () => writeFile(path.join(evidence, 'endurance-progress.json'), JSON.stringify({
    elapsedSeconds: (Date.now() - started) / 1000, ...result }, null, 2));
  const ready = () => coordinator.state === 'Active' && presentation.windows.size === 2 &&
    [...presentation.windows.values()].every(window => window.visible && window.generation === coordinator.generation);
  await sampler.collect(children.map(child => child.pid));
  for (let cycle = 0; cycle < sequence.length; cycle++) {
    const [type, project] = sequence[cycle], cycleAt = Date.now();
    const entry = { cycle, type, project: path.resolve(project), samples: [] }; result.cycles.push(entry);
    await coordinator.applySettings({ ...coordinator.store.value, fpsLimit: 60, autoAdjust: false, selectedWallpaper: path.resolve(project) });
    assert.ok(await pump(30000, ready), `ENDURANCE_SOURCE_NOT_READY:${cycle}:${coordinator.state}:${coordinator.code}`);
    await pump(800);
    if (['scene', 'application'].includes(type) && !hiddenTypes.has(type)) {
      await verifyHiddenSourceLifecycle({ type, cycle, coordinator, player, application, ownGeometry, pump, ready, mutations: result.mutations });
      hiddenTypes.add(type);
    }
    if (cycle > 0 && cycle % 4 === 0) {
      await ownGeometry(1, 25 + width, 65, Math.max(640, width - 170), Math.max(600, height - 130));
      await pump(1000);
      const geometry = await clients[1].evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,canvasWidth:c?.width,canvasHeight:c?.height}})()`);
      assert.equal(geometry.canvasWidth, Math.round(geometry.width * geometry.dpr));
      assert.equal(geometry.canvasHeight, Math.round(geometry.height * geometry.dpr));
      result.mutations.push({ cycle, operation: 'resize-physical-canvas', ...geometry });
      await ownGeometry(1, 25 + width, 50, width, height); await pump(500);
    }
    if (cycle === Math.floor(sequence.length / 2)) {
      const generation = coordinator.generation;
      await clients[0].call('Page.reload', { ignoreCache: false });
      await pump(1000); await presentation.heartbeat();
      assert.ok(await pump(30000, ready), 'ENDURANCE_RENDERER_RELOAD_FAILED');
      result.mutations.push({ cycle, operation: 'owned-page-reload', generationBefore: generation,
        generationAfter: coordinator.generation, otherWindowRetained: presentation.windows.size === 2 });
    }
    // Each source receives at least two spaced samples even when setup/restore
    // exceeds its nominal slot. Measure actual duration instead of assuming it.
    let samples = 0, previousWindows;
    do {
      await pump(Math.max(3000, Math.min(10000, slotMs / 3)));
      assert.ok(ready(), `ENDURANCE_INACTIVE:${cycle}:${coordinator.state}:${coordinator.code}`);
      const at = performance.now();
      const windows = await Promise.all(clients.map(async client => ({
        structure: await client.evaluate(`({ownedCanvases:document.querySelectorAll('canvas[data-cwb-owned="v1"]').length,inputFileElements:document.querySelectorAll('input[type="file"][data-cwb-owned]').length,ping:window.__codexWallpaperBridgeV1?.ping()})`),
        signature: await client.evaluate(signature),
        heap: await client.call('Runtime.getHeapUsage'),
        dom: await client.call('Memory.getDOMCounters'),
      })));
      const latencyMs = performance.now() - at; roundTrips.push(latencyMs);
      for (const window of windows) {
        assert.equal(window.structure.ownedCanvases, 1); assert.equal(window.structure.inputFileElements, 0);
        assert.equal(window.structure.ping?.visible, true); assert.equal(window.structure.ping?.generation, coordinator.generation);
        if (type === 'video') {
          const playback = window.structure.ping.playback;
          assert.ok(playback?.nativeFile && playback.muted && playback.defaultMuted && playback.volume === 0 && playback.sourceWidth > 0);
        }
      }
      if (previousWindows) assert.ok(windows.every((window, index) => window.signature !== previousWindows[index].signature ||
        (type === 'video' && window.structure.ping.playback.decodedFrames > previousWindows[index].structure.ping.playback.decodedFrames)), `ENDURANCE_FROZEN_CANVAS:${cycle}`);
      previousWindows = windows;
      const activeHelperPids = [player.worker?.pid, player.frames.child?.pid, frames.child?.pid, web.child?.pid, application?.adapter.child?.pid].filter(pid => Number.isInteger(pid) && pid > 0);
      const sample = { cycle, type, elapsedSeconds: (Date.now() - started) / 1000, latencyMs, windows,
        codexTree: await sampler.collect(children.map(child => child.pid)),
        activeHelpers: activeHelperPids.length ? await helperSampler.collect(activeHelperPids) :
          { scope: helperSampler.scope, cpu: null, memory: 0, privateBytes: 0, handles: 0, processes: 0, counters: [] },
        node: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, resources: process.getActiveResourcesInfo().sort() } };
      result.samples.push(sample); entry.samples.push(result.samples.length - 1); samples++;
      await checkpoint();
    } while (samples < 2 || Date.now() - cycleAt < slotMs);
    entry.durationSeconds = (Date.now() - cycleAt) / 1000;
    console.error(`Endurance ${cycle + 1}/${sequence.length}: ${type}, ${Math.round((Date.now() - started) / 1000)} s, two changing canvases; Node RSS ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MiB.`);
  }
  const first = result.samples.filter(sample => sample.cycle === 0).slice(-2);
  const last = result.samples.filter(sample => sample.cycle === sequence.length - 1).slice(-2);
  const key = row => `${row.pid}:${row.identity}`;
  const earlyRows = new Map(first.at(-1).codexTree.counters.map(row => [key(row), row]));
  const lateRows = new Map(last.at(-1).codexTree.counters.map(row => [key(row), row]));
  const common = new Set([...earlyRows.keys()].filter(id => lateRows.has(id)));
  const mean = (samples, metric) => samples.reduce((sum, sample) => sum + metric(sample), 0) / samples.length;
  const total = (sample, metric) => sample.codexTree.counters.filter(row => common.has(key(row))).reduce((sum, row) => sum + row[metric], 0);
  const earlyHandles = mean(first, sample => total(sample, 'handles'));
  const earlyPrivate = mean(first, sample => total(sample, 'privateBytes'));
  const latencies = [...roundTrips].sort((a, b) => a - b);
  result.summary = { durationSeconds: (Date.now() - started) / 1000, sourceSwitches: sequence.length,
    installedVideosExercised: videos.length, applicationCycles: result.cycles.filter(cycle => cycle.type === 'application').length,
    hiddenSourceTypesVerified: [...hiddenTypes], samples: result.samples.length,
    sameSourceEarlyLate: sequence[0][1] === sequence.at(-1)[1], commonProcessIdentities: common.size,
    comparableHandleGrowth: mean(last, sample => total(sample, 'handles')) - earlyHandles,
    comparablePrivateBytesGrowth: mean(last, sample => total(sample, 'privateBytes')) - earlyPrivate,
    rawPrivateBytesGrowth: mean(last, sample => sample.codexTree.privateBytes) - mean(first, sample => sample.codexTree.privateBytes),
    nodeRssGrowthBytes: mean(last, sample => sample.node.rss) - mean(first, sample => sample.node.rss),
    rendererRoundTripP95Ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
    newProcesses: [...lateRows].filter(([id]) => !earlyRows.has(id)).map(([, row]) => row),
    gpu: 'unavailable', longTermZeroLeakClaim: false };
  const summary = result.summary;
  assert.ok(common.size > 0); assert.ok(summary.durationSeconds >= seconds);
  assert.ok(summary.comparableHandleGrowth < Math.max(300, earlyHandles * 0.1), 'ENDURANCE_COMPARABLE_HANDLES_EXCEEDED');
  assert.ok(summary.comparablePrivateBytesGrowth < Math.max(256 * 1024 ** 2, earlyPrivate * 0.2), 'ENDURANCE_COMPARABLE_PRIVATE_BYTES_EXCEEDED');
  assert.ok(summary.nodeRssGrowthBytes < result.tolerances.nodeRssGrowthBytes, 'ENDURANCE_NODE_RSS_EXCEEDED');
  assert.ok(summary.rendererRoundTripP95Ms < result.tolerances.rendererRoundTripP95Ms, 'ENDURANCE_RENDERER_LATENCY_EXCEEDED');
  result.completed = true; await checkpoint();
}
