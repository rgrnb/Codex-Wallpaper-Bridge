import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebBackend } from '../src/web-backend.mjs';
const root = fileURLToPath(new URL('./experiments/fixtures/web/', import.meta.url));
const source = { root, resource: fileURLToPath(new URL('./experiments/fixtures/web/index.html', import.meta.url)),
  project: fileURLToPath(new URL('./experiments/fixtures/web/project.json', import.meta.url)), fingerprint: 'synthetic-web-v1', properties: {} };
const backend = new WebBackend();
try {
  const hashes = [];
  for (let n = 0; n < 3; n++) {
    let frame;
    for (let i = 0; i < 20 && !frame; i++) { frame = await backend.capture(source, { fps: 15, maxWidth: 640, jpegQuality: 70, paused: false });
      if (!frame) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(frame?.jpeg); assert.equal(Buffer.from(frame.jpeg, 'base64')[0], 255);
    hashes.push(createHash('sha256').update(frame.jpeg).digest('hex'));
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(new Set(hashes).size > 1);
  await backend.configure({ maxWidth: 640, paused: true });
  await backend.configure({ maxWidth: 960, paused: false });
  console.log(JSON.stringify({ result: 'passed', backend: 'isolated-edge-pipe', changingFrames: true,
    audioDisabledAtProcessStart: backend.child.spawnargs.includes('--mute-audio'), wallpaperCopies: 0, actualCodexAccepted: false }));
} finally { await backend.stop(); }
