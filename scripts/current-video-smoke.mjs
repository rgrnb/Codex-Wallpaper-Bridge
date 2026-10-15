import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { nativeProbe } from '../src/platform.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
const { chromium } = await import(process.env.BRIDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.BRIDGE_PLAYWRIGHT_MODULE).href : 'playwright');
const observer = new WallpaperEngine({ username: os.userInfo().username });
let source;
try { source = (await observer.observe((await nativeProbe()).wallpaperEngine, { monitor: 0 })).source; }
finally { observer.close(); }
assert.equal(source?.type, 'video');
assert.ok(source.size <= 256 * 1024 * 1024);
const mime = path.extname(source.resource).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4';
const browser = await chromium.launch({ headless: true, ...(process.env.BRIDGE_BROWSER_PATH ? { executablePath: process.env.BRIDGE_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  await page.setContent('<html><body><div id="root"><main></main></div></body></html>');
  await page.evaluate(() => {
    window.bridgeTestAudio = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() { window.bridgeTestAudio.push({ muted: this.muted, defaultMuted: this.defaultMuted, volume: this.volume }); return original.call(this); };
  });
  await page.evaluate(await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8'));
  await page.evaluate(() => window.__codexWallpaperBridgeV1.install({ effects: { opacity: 0.35, blur: 0, brightness: 0.85, contrast: 1 },
    policy: { fps: 15, pixelBudget: 921600 } }, { root: '#root', main: 'main' }));
  await page.evaluate(({ size, mime }) => window.__codexWallpaperBridgeV1.begin(1, size, mime), { size: source.size, mime });
  const file = await open(source.resource, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024); let offset = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset); if (!bytesRead) break;
      assert.equal(await page.evaluate(encoded => window.__codexWallpaperBridgeV1.append(1, encoded), buffer.subarray(0, bytesRead).toString('base64')), true);
      offset += bytesRead;
    }
  } finally { await file.close(); }
  assert.equal(await page.evaluate(() => window.__codexWallpaperBridgeV1.commit(1)), true);
  await page.waitForTimeout(300);
  const audio = await page.evaluate(() => window.bridgeTestAudio);
  assert.ok(audio.length > 0); assert.ok(audio.every(a => a.muted && a.defaultMuted && a.volume === 0));
  const ping = await page.evaluate(() => window.__codexWallpaperBridgeV1.ping()); assert.equal(ping.generation, 1); assert.ok(ping.fps > 0);
  await page.evaluate(() => window.__codexWallpaperBridgeV1.restore()); assert.equal(await page.locator('[data-cwb-owned]').count(), 0);
  console.log(JSON.stringify({ result: 'passed', source: source.id, type: source.type, bytes: source.size,
    muted: true, sourceMethod: 'WallpaperEngine-current-source', fixture: 'isolated Edge page', actualCodexAccepted: false, wallpaperCopiesSaved: 0 }));
} finally { await browser.close(); }
