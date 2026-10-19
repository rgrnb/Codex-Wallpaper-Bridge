import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/platform.mjs';
import { Presentation } from '../src/presentation.mjs';
import { DEFAULTS } from '../src/config.mjs';

// Supplementary renderer integration test. Real browser CDP and File-backed
// original-codec decoding; authored pages/media only. This is deliberately not
// recorded as actual Codex, a physical multi-window or cross-monitor acceptance.
const moduleName = process.env.BRIDGE_PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright');
const evidence = path.join(ROOT, '.local-evidence', `renderer-lifecycle-${randomBytes(8).toString('hex')}`);
await mkdir(evidence);
const report = { started: new Date().toISOString(), actualCodex: false, physicalWindowTest: false,
  scope: 'Two headless Chromium renderer contexts with authored HTML and audio/video fixtures; real CDP File-backed decode and lifecycle.', checks: [], samples: [] };
const durationSeconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || 120);
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 600);
const browser = await chromium.launch({ headless: true, ...(process.env.BRIDGE_BROWSER_PATH ? { executablePath: process.env.BRIDGE_BROWSER_PATH } : {}) });
const pages = new Map(), contexts = [], sessions = new Set(); let nextId = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = `<!DOCTYPE html><style>html,body{margin:0;height:100%;background:#182030;color:#eee;font:16px system-ui}#root{height:100vh;display:flex}aside{width:180px;background:#263448}main{flex:1;display:flex;flex-direction:column;padding:20px;box-sizing:border-box}header{height:40px;background:#263448}.composer{margin-top:auto;padding:20px;background:#263448}input{width:70%}</style><div id="root"><aside>Owned test sidebar</aside><main><header>Owned renderer fixture</header><p>No conversation data.</p><div class="composer"><input aria-label="Authored input"><button>Record click</button></div></main></div>`;
const selectors = { root: '#root', main: 'main', sidebar: 'aside', header: 'header', composer: '.composer', surfaces: '.thread' };
const adapter = { id: 'authored-browser-fixture', verifiedVersions: ['fixture'], selectors };
const log = { async event(_level, _module, code, data) { if (code === 'WINDOW_RECONNECT') report.checks.push({ code, ...data }); } };
const presentation = new Presentation(adapter, log, {
  discover: async port => { assert.equal(port, 19380); return [...pages.keys()].map(id => ({ id })); },
  connect: async target => {
    assert.ok(pages.has(target.id)); const page = pages.get(target.id), session = await page.context().newCDPSession(page); sessions.add(session);
    return {
      async call(method, params = {}) { return session.send(method, params); },
      async evaluate(expression) {
        const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
          const code = result.exceptionDetails.exception?.description?.match(/^Error: ((?:VIDEO|SOURCE|STRUCTURE|DISPOSED)[A-Z0-9_]*)\b/);
          throw new Error(code ? code[1] : 'RENDERER_EVALUATION_FAILED');
        }
        return result.result?.value;
      },
      close() { sessions.delete(session); session.detach().catch(() => {}); },
    };
  },
});
async function preparePage(page) {
  await page.setContent(html);
  await page.evaluate(() => {
    window.__fixture = { videos: [], createdUrls: [], revokedUrls: [], inputEvents: 0, clicks: 0 };
    const original = document.createElement.bind(document);
    document.createElement = function (tag, ...args) { const node = original(tag, ...args); if (String(tag).toLowerCase() === 'video') window.__fixture.videos.push(node); return node; };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); window.__fixture.createdUrls.push(url); return url; };
    URL.revokeObjectURL = value => { window.__fixture.revokedUrls.push(value); revoke(value); };
    for (const type of ['input', 'change']) document.addEventListener(type, event => { if (event.target?.type === 'file') window.__fixture.inputEvents++; }, true);
    document.querySelector('button').onclick = () => window.__fixture.clicks++;
  });
}
async function addPage(dpr = 1) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr }); contexts.push(context);
  const page = await context.newPage(); await preparePage(page); const id = `authored-${++nextId}`; pages.set(id, page); return { id, page };
}
async function source(name, bytes) {
  const resource = path.join(evidence, name); await writeFile(resource, bytes); const info = await stat(resource);
  return { resource, size: info.size, stamp: `${info.size}:${info.mtimeMs}:authored`, type: 'video' };
}
const signature = () => {
  const canvas = document.querySelector('canvas[data-cwb-owned="v1"]'); if (!canvas) return null;
  const sample = new OffscreenCanvas(64, 36), ctx = sample.getContext('2d'); ctx.drawImage(canvas, 0, 0, 64, 36);
  const pixels = ctx.getImageData(0, 0, 64, 36).data; let hash = 2166136261;
  for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619); return hash >>> 0;
};
async function state(page) {
  return page.evaluate(() => {
    const fixture = window.__fixture, ping = window.__codexWallpaperBridgeV1?.ping(), active = fixture.videos.filter(video => video.src);
    return { ping, oneCanvas: document.querySelectorAll('canvas[data-cwb-owned="v1"]').length === 1,
      inputEvents: fixture.inputEvents, activeVideos: active.length, allVideosMuted: fixture.videos.every(video => video.muted && video.defaultMuted && video.volume === 0),
      retainedObjectUrls: fixture.createdUrls.length - fixture.revokedUrls.length, activePlaying: active.map(video => !video.paused) };
  });
}
const options = { effects: DEFAULTS.effects, policy: { fps: 60, pixelBudget: 2073600, paused: false } };
try {
  report.browserVersion = browser.version();
  const first = await addPage(1), second = await addPage(1.5);
  const bytes = await first.page.evaluate(async () => {
    const canvas = new OffscreenCanvas(640, 360); // Author through a DOM canvas for captureStream.
    const capture = document.createElement('canvas'); capture.width = canvas.width; capture.height = canvas.height;
    const ctx = capture.getContext('2d'), stream = capture.captureStream(60);
    const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await audio.resume(); stream.addTrack(destination.stream.getAudioTracks()[0]);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1500000 }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data); const stopped = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start();
    const started = performance.now();
    await new Promise(resolve => { const paint = now => { const elapsed = now - started; ctx.fillStyle = `hsl(${elapsed / 8 % 360} 80% 35%)`; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillRect((elapsed / 4) % 640, 80, 80, 200); if (elapsed < 2000) requestAnimationFrame(paint); else resolve(); }; requestAnimationFrame(paint); });
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audio.close();
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  const video = await source('authored-audio-video.webm', Buffer.from(bytes)), invalid = await source('invalid.webm', Buffer.from('authored invalid video fixture'));
  report.authoredSource = { width: 640, height: 360, requestedFps: 60, hasAudioTrack: true, bytes: video.size };
  await presentation.configure(options); await presentation.reconcile([19380], 'fixture', false); assert.equal(presentation.windows.size, 2);
  await presentation.invalidate(1); assert.equal(await presentation.video(video, 1, () => true), true); await delay(700);
  const signatures = [new Set(), new Set()];
  for (let n = 0; n < 7; n++) { await delay(170); signatures[0].add(await first.page.evaluate(signature)); signatures[1].add(await second.page.evaluate(signature)); }
  report.initialPlayback = await Promise.all([...pages.values()].map(state)); report.canvasChanges = signatures.map(values => values.size);
  assert.ok(report.canvasChanges.every(changes => changes > 1));
  assert.ok(report.initialPlayback.every(value => value.ping.visible && value.ping.playback.nativeFile && value.allVideosMuted && value.activeVideos === 1 && value.inputEvents === 0 && value.oneCanvas));
  await second.page.setViewportSize({ width: 760, height: 820 }); await delay(300);
  report.resize = await second.page.evaluate(() => { const canvas = document.querySelector('canvas[data-cwb-owned="v1"]'); return { width: canvas.width, height: canvas.height, dpr: devicePixelRatio }; });
  assert.deepEqual(report.resize, { width: 1140, height: 1230, dpr: 1.5 });
  await first.page.getByRole('textbox').fill('Authored input remains usable'); await first.page.getByRole('button').click();
  assert.equal(await first.page.getByRole('textbox').inputValue(), 'Authored input remains usable'); assert.equal(await first.page.evaluate(() => window.__fixture.clicks), 1);
  report.inputAndClick = true;
  await presentation.invalidate(2); await presentation.video(video, 2, () => true);
  report.crossfade = await second.page.evaluate(() => window.__codexWallpaperBridgeV1.ping().transitioning); await delay(450);
  assert.equal((await state(second.page)).retainedObjectUrls, 1);
  await presentation.invalidate(3); await assert.rejects(presentation.video(invalid, 3, () => true), /VIDEO_DECODE_FAILED/);
  report.failedReplacement = await Promise.all([...pages.values()].map(state));
  assert.ok(report.failedReplacement.every(value => value.oneCanvas && value.ping.generation === 2 && value.retainedObjectUrls === 1));
  await presentation.invalidate(4); await presentation.video(video, 4, () => true); await delay(450);
  await first.page.reload(); await preparePage(first.page); await presentation.heartbeat(); await presentation.reconcile([19380], 'fixture', false);
  await presentation.video(video, 4, () => true); assert.equal(presentation.windows.size, 2); assert.equal((await state(first.page)).ping.generation, 4); report.reloadReconnected = true;
  pages.delete(second.id); await second.page.close(); await presentation.reconcile([19380], 'fixture', false); assert.equal(presentation.windows.size, 1);
  const replacement = await addPage(1.25); await presentation.reconcile([19380], 'fixture', false); await presentation.video(video, 4, () => true);
  assert.equal(presentation.windows.size, 2); assert.equal((await state(replacement.page)).ping.generation, 4); report.closeAndNewRenderer = true;
  const started = Date.now();
  while (Date.now() - started < durationSeconds * 1000) {
    await delay(3000); await presentation.heartbeat();
    const values = await Promise.all([...pages.values()].map(state));
    assert.ok(values.every(value => value.oneCanvas && value.ping.generation === 4 && value.ping.playback.nativeFile && value.activeVideos === 1 && value.allVideosMuted && value.retainedObjectUrls === 1));
    report.samples.push({ seconds: (Date.now() - started) / 1000, fps: [...presentation.windows.values()].map(window => window.fps),
      playback: values.map(value => value.ping.playback), nodeRss: process.memoryUsage().rss });
  }
  report.durationSeconds = (Date.now() - started) / 1000;
  await presentation.restore(); report.restored = await Promise.all([...pages.values()].map(page => page.evaluate(() => ({ ownedNodes: document.querySelectorAll('[data-cwb-owned="v1"]').length,
    runtime: !!window.__codexWallpaperBridgeV1, retainedObjectUrls: window.__fixture.createdUrls.length - window.__fixture.revokedUrls.length,
    playingVideos: window.__fixture.videos.filter(video => !video.paused).length }))));
  assert.ok(report.restored.every(value => value.ownedNodes === 0 && !value.runtime && value.retainedObjectUrls === 0 && value.playingVideos === 0));
  report.success = true;
} catch (error) { report.failure = { code: error.message, stack: String(error.stack).split('\n').slice(0, 5) }; throw error; }
finally {
  await presentation.restore(); for (const session of sessions) await session.detach().catch(() => {}); await browser.close();
  report.finished = new Date().toISOString(); await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success || false, failure: report.failure, canvasChanges: report.canvasChanges,
    durationSeconds: report.durationSeconds, actualCodex: false, physicalWindowTest: false, lastSample: report.samples.at(-1) }));
}
