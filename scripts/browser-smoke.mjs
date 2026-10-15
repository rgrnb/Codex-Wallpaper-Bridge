import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const moduleName = process.env.BRIDGE_PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BRIDGE_BROWSER_PATH ? { executablePath: process.env.BRIDGE_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  await page.setContent(`<!DOCTYPE html><html><head><style>
  html,body{margin:0;height:100%;font:16px system-ui;color:#eee;background:#10131c}
  #root{height:100%;display:flex;background:#10131c}aside{width:245px;padding:26px;background:#1b2030;box-sizing:border-box}
  main{flex:1;padding:44px;background:#10131c;display:flex;flex-direction:column}h1{font-size:32px;margin:8px 0}
  .composer{margin-top:auto;padding:20px;background:#1b2030;border:1px solid #777;border-radius:14px}
  input{color:inherit;background:transparent;border:0;width:80%;font:inherit}button{padding:8px 14px}
  </style></head><body><div id="root"><aside><b>BRIDGE / TEST</b><p>Native sidebar fixture</p><p>Projects</p></aside>
  <main><p>RENDERER VERIFICATION</p><h1>One wallpaper. One continuous surface.</h1><p>Synthetic content; no Codex conversation data.</p>
  <div class="composer"><input aria-label="Input" placeholder="Type to verify interaction"><button id="send">Send</button></div></main></div></body></html>`);
  const before = await page.locator('input').boundingBox();
  const payload = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
  const selectors = { root: '#root', main: 'main', sidebar: 'aside', header: 'header', composer: '.composer', surfaces: '.thread' };
  const options = { effects: { opacity: 0.75, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 15, pixelBudget: 2073600 } };
  await page.evaluate(payload);
  assert.equal((await page.evaluate(({ options, selectors }) => window.__codexWallpaperBridgeV1.install(options, selectors), { options, selectors })).compatible, true);
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 900); g.addColorStop(0, '#18434e'); g.addColorStop(0.5, '#895345'); g.addColorStop(1, '#33294e');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 900); x.strokeStyle = '#dba870'; x.lineWidth = 4;
    for (let i = 0; i < 12; i++) { x.beginPath(); x.arc(1000, 450, 50 + i * 48, 0, Math.PI * 2); x.stroke(); }
    return c.toDataURL('image/jpeg').split(',')[1];
  });
  assert.equal(await page.evaluate(jpeg => window.__codexWallpaperBridgeV1.frame(1, jpeg), jpeg), true);
  assert.equal(await page.evaluate(() => window.__codexWallpaperBridgeV1.frame(0, '')), false);
  assert.deepEqual(await page.locator('input').boundingBox(), before);
  await page.getByRole('textbox').fill('typing remains functional');
  await page.locator('#send').evaluate(node => { node.onclick = () => node.dataset.clicked = 'yes'; });
  await page.locator('#send').click(); assert.equal(await page.locator('#send').getAttribute('data-clicked'), 'yes');
  const computed = await page.locator('canvas[data-cwb-owned]').evaluate(c => ({ pointer: getComputedStyle(c).pointerEvents,
    width: c.width, height: c.height, corners: [c.getContext('2d').getImageData(0, 0, 1, 1).data[3], c.getContext('2d').getImageData(c.width - 1, c.height - 1, 1, 1).data[3]] }));
  assert.equal(computed.pointer, 'none'); assert.deepEqual(computed.corners, [255, 255]);
  await mkdir('.local-evidence', { recursive: true }); await page.screenshot({ path: '.local-evidence/renderer-synthetic.png' });
  await page.setViewportSize({ width: 780, height: 900 }); await page.waitForTimeout(150);
  assert.equal((await page.locator('canvas[data-cwb-owned]').evaluate(c => c.width)), 780);
  // Exercise an actual muted, animated WebM decode/transfer/first-frame commit entirely in memory.
  const video = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d');
    const stream = c.captureStream(0), track=stream.getVideoTracks()[0], recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start();
    for (let i = 0; i < 12; i++) { x.fillStyle = `hsl(${i * 30} 70% 45%)`; x.fillRect(0, 0, c.width, c.height); track.requestFrame(); await new Promise(r => setTimeout(r, 100)); }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  assert.ok(video.length > 500, 'The authored MediaRecorder fixture must contain video frames.');
  await page.evaluate(({ bytes }) => {
    const api = window.__codexWallpaperBridgeV1; api.begin(2, bytes.length, 'video/webm');
    api.append(2, btoa(String.fromCharCode(...bytes)));
  }, { bytes: video });
  assert.equal(await page.evaluate(() => window.__codexWallpaperBridgeV1.commit(2)), true);
  await page.waitForTimeout(200); assert.equal((await page.evaluate(() => window.__codexWallpaperBridgeV1.ping())).generation, 2);
  assert.equal(await page.evaluate(() => window.__codexWallpaperBridgeV1.restore()), true);
  assert.equal(await page.locator('[data-cwb-owned]').count(), 0);
  assert.equal(await page.locator('main').evaluate(m => getComputedStyle(m).backgroundColor), 'rgb(16, 19, 28)');
  assert.equal(await page.getByRole('textbox').inputValue(), 'typing remains functional');
  // Reapply after exact restoration, then abandon the controller heartbeat.
  // The live page must restore itself without any official-state backup writes.
  await page.evaluate(payload);
  await page.evaluate(({ options, selectors }) => window.__codexWallpaperBridgeV1.install(options, selectors), { options, selectors });
  await page.evaluate(jpeg => window.__codexWallpaperBridgeV1.frame(3, jpeg), jpeg);
  await page.evaluate(() => window.__codexWallpaperBridgeV1.ping());
  await page.waitForFunction(() => !window.__codexWallpaperBridgeV1, undefined, { timeout: 22000 });
  assert.equal(await page.locator('[data-cwb-owned]').count(), 0);
  assert.equal(await page.getByRole('textbox').inputValue(), 'typing remains functional');
  // Isolated authored pages cover physical-pixel/DPI and light/dark styles.
  for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor });
    const sample = await context.newPage();
    for (const light of [false, true]) {
      await sample.setContent(`<style>html,body{margin:0;background:${light ? 'white' : '#10131c'};color:${light ? 'black' : 'white'};font:16px system-ui}#root{width:100vw;height:100vh;display:flex}aside{width:180px}main{flex:1}.composer{height:60px}</style><div id="root"><aside>Owned sidebar</aside><main>Owned text<div class="composer"><input value="owned fixture"></div></main></div>`);
      const beforeStyle = await sample.locator('main').evaluate(node => { const s=getComputedStyle(node),r=node.getBoundingClientRect();return [s.fontFamily,s.fontSize,s.color,r.x,r.y,r.width,r.height]; });
      await sample.evaluate(payload);
      await sample.evaluate(({ options, selectors }) => window.__codexWallpaperBridgeV1.install(options, selectors), { options, selectors });
      await sample.evaluate(jpeg => window.__codexWallpaperBridgeV1.frame(1, jpeg), jpeg);
      const size = await sample.locator('canvas[data-cwb-owned]').evaluate(canvas => [canvas.width,canvas.height]);
      assert.deepEqual(size, [640 * deviceScaleFactor, 480 * deviceScaleFactor]);
      await sample.getByRole('textbox').fill('DPI input remains usable');
      assert.deepEqual(await sample.locator('main').evaluate(node => { const s=getComputedStyle(node),r=node.getBoundingClientRect();return [s.fontFamily,s.fontSize,s.color,r.x,r.y,r.width,r.height]; }), beforeStyle);
      await sample.evaluate(() => window.__codexWallpaperBridgeV1.restore());
    }
    await context.close();
  }
  console.log('Browser smoke passed: continuous Cover, resize, real WebM, generation fencing, input/click, restoration and controller-death lease; light/dark at emulated DPR 1/1.25/1.5/2. Synthetic fixtures only.');
} finally { await browser.close(); }
