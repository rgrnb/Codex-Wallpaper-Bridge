import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { screenshotPixel, sampleComposedPixels } from '../scripts/window-coverage.mjs';

function png({ width = 1, height = 1, type = 2, filter = 0, rgb = [230, 40, 24] } = {}) {
  const chunk = (name, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(name, 4); data.copy(b, 8); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = type;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([filter, ...rgb, ...(type === 6 ? [255] : [])]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('text-free compositor samples decode bounded Chromium RGB/RGBA PNGs with every PNG filter', () => {
  for (const type of [2, 6]) for (let filter = 0; filter <= 4; filter++) assert.deepEqual(screenshotPixel(png({ type, filter })), [230, 40, 24]);
});

test('compositor sample decoder rejects full screenshots, truncated images and unsupported formats', () => {
  for (const data of [png({ width: 1200 }), png({ type: 3 }), png({ filter: 5 }), png().slice(0, 40), Buffer.alloc(20000).toString('base64')])
    assert.throws(() => screenshotPixel(data));
});

test('composed pixel capture serializes shared viewport mutations and stops on capture failure', async () => {
  let active = 0, maximumActive = 0;
  const calls = [], candidates = { main: [{ x: 10, y: 20 }, { x: 30, y: 40 }], sidebar: [{ x: 5, y: 6 }] };
  const client = { async evaluate() {}, async call(method, parameters) {
    maximumActive = Math.max(maximumActive, ++active); calls.push({ method, parameters });
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { data: png() };
  } };
  const result = await sampleComposedPixels(client, candidates);
  assert.equal(maximumActive, 1);
  assert.deepEqual(result.main.map(row => row.rgb), [[230, 40, 24], [230, 40, 24]]);
  assert.deepEqual(result.sidebar[0], { x: 5, y: 6, rgb: [230, 40, 24] });
  assert.equal(calls.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
  assert.ok(calls.filter(row => row.method === 'Page.captureScreenshot').every(row => row.parameters.captureBeyondViewport === false &&
    row.parameters.clip.width === 1 && row.parameters.clip.height === 1 && row.parameters.clip.scale === 1));
  let attempts = 0;
  let cleared = false;
  await assert.rejects(sampleComposedPixels({ async call(method) { if (method === 'Emulation.clearDeviceMetricsOverride') { cleared = true; return {}; }
    attempts++; throw new Error('CAPTURE_FAILED'); } }, candidates), /CAPTURE_FAILED/);
  assert.equal(attempts, 1);
  assert.equal(cleared, true);
});
