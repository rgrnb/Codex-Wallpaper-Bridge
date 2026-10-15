import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeProbe, NativeFrames } from '../src/platform.mjs';
const apps = await nativeProbe();
assert.equal(apps.schemaVersion, 1);
for (const app of apps.codex) assert.ok(app.version === 'unavailable' || /^26\./.test(app.version));
const surface = apps.wallpaperEngine?.surfaces?.[0];
if (!surface) throw new Error('No eligible live Wallpaper Engine renderer surface for native experiment.');
const helper = new NativeFrames();
try {
  const hashes = [];
  for (let i = 0; i < 3; i++) {
    const frame = await helper.capture(surface, { maxWidth: 960, jpegQuality: 65 });
    const bytes = Buffer.from(frame.jpeg, 'base64'); assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(JSON.stringify({ backend: 'WGC-owned-renderer', type: surface.type,
    frameCount: hashes.length, changingFrames: new Set(hashes).size > 1, pixelsSavedToDisk: false }));
  await assert.rejects(helper.capture({ hwnd: '1', pid: 1 }, { maxWidth: 960, jpegQuality: 65 }), /OWNER_INVALID/);
} finally { helper.stop(); }
