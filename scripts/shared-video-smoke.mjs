import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { WebBackend } from '../src/web-backend.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { nativeProbe } from '../src/platform.mjs';

const observer = new WallpaperEngine({ username: os.userInfo().username }), backend = new WebBackend();
try {
  const app = (await nativeProbe()).wallpaperEngine;
  const source = (await observer.observeDesktop(app, { monitor: 0 })).source;
  assert.equal(source.type, 'video', 'Select a Video wallpaper before this read-only test.');
  const hashes = [], policy = { fps: 15, maxWidth: 640, jpegQuality: 70, paused: false };
  for (let n = 0; n < 4; n++) {
    let frame;
    for (let attempt = 0; attempt < 100 && !frame; attempt++) {
      frame = await backend.capture(source, policy);
      if (!frame) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(frame?.jpeg); assert.equal(frame.muted, true);
    assert.ok(frame.width > 0 && frame.height > 0);
    hashes.push(createHash('sha256').update(frame.jpeg).digest('hex'));
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(new Set(hashes).size > 1);
  const decoder = backend.child.pid;
  await backend.configure({ ...policy, paused: true });
  await backend.capture(source, { ...policy, maxWidth: 960 });
  assert.equal(backend.child.pid, decoder, 'Resize/resume must retain the shared decoder.');
  const after = (await observer.observeDesktop(app, { monitor: 0 })).source;
  assert.equal(after.fingerprint, source.fingerprint);
  console.log(JSON.stringify({ result: 'passed', backend: 'shared-range-video', bytes: source.size,
    changingFrames: true, mutedAtStartupAndPlayback: true, decoderReused: true,
    desktopStateUnchanged: true, wallpaperCopies: 0, actualCodexAccepted: false }));
} finally { observer.close(); await backend.stop(); }
