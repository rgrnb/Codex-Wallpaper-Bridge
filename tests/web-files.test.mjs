import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebFiles } from '../src/web-files.mjs';
import { projectServer, WebBackend } from '../src/web-backend.mjs';

test('Web file grants require a user selection outside the project and never follow a replaced symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-files-'));
  try {
    const project = path.join(root, 'project'), external = path.join(root, 'selected'); await mkdir(project); await mkdir(external);
    const image = path.join(external, 'selected.png'); await writeFile(image, 'user-selected-image');
    const definitions = { photo: { type: 'file', value: image } };
    await assert.rejects(new WebFiles().prepare({ root: project, properties: {} }, definitions), /WEB_PROPERTY_FILE_UNAVAILABLE/);
    const files = new WebFiles(); await files.prepare({ root: project, properties: { photo: image } }, definitions);
    await writeFile(path.join(project, 'index.html'), 'authored');
    const host = await projectServer(project, path.join(project, 'index.html'), files);
    try {
      const url = Object.values(files.aliases(host.baseUrl))[0];
      assert.equal(await (await fetch(url)).text(), 'user-selected-image');
      assert.equal((await fetch(url.replace(/~cwb-file\/[a-f0-9]+/, '~cwb-file/' + '0'.repeat(32)))).status, 404);
      const other = path.join(root, 'not-selected'); await mkdir(other); await writeFile(path.join(other, 'selected.png'), 'private');
      await rename(external, external + '-original'); await symlink(other, external, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal((await fetch(url)).status, 404);
    } finally { host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('random directories return real filtered files and fetchall emits added, changed and removed paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-directory-'));
  try {
    await mkdir(path.join(root, 'pictures')); const image = path.join(root, 'pictures', 'a.png'); await writeFile(image, 'image');
    await writeFile(path.join(root, 'pictures', 'secret.txt'), 'never-listed');
    const files = new WebFiles();
    await files.prepare({ root, properties: {} }, {
      random: { type: 'directory', value: 'pictures', mode: 'ondemand', filetype: 'image' },
      all: { type: 'directory', value: 'pictures', mode: 'fetchall', filetype: 'image' },
    });
    assert.equal(files.random('random'), image.replaceAll('\\', '/')); assert.equal(files.random('unknown'), '');
    assert.deepEqual(files.initialDirectories(), [{ key: 'all', changed: [image.replaceAll('\\', '/')] }]);
    assert.deepEqual(await files.refresh(), []);
    await writeFile(image, 'changed-image'); assert.deepEqual(await files.refresh(), [{ key: 'all', changed: [image.replaceAll('\\', '/')] }]);
    await rm(image); assert.deepEqual(await files.refresh(), [{ key: 'all', removed: [image.replaceAll('\\', '/')] }]);
    assert.equal(files.random('random'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Web pointer uses source coordinates and refuses invalid, paused or stopped targets', async () => {
  const calls = [], backend = new WebBackend(); backend.pipe = { async call(method, params, session) { calls.push({ method, params, session }); } };
  backend.current = 'fixture'; backend.ready = true; backend.sourceType = 'web'; backend.session = 'own-session'; backend.width = 640; backend.height = 360;
  assert.equal(await backend.pointer({ type: 'click', x: 1, y: .5 }), true);
  assert.deepEqual(calls.map(row => row.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(calls[0].params.x, 639); assert.equal(calls[0].params.y, 179.5); assert.ok(calls.every(row => row.session === 'own-session'));
  const before = calls.length;
  for (const event of [{ type: 'click', x: -1, y: .5 }, { type: 'right', x: 0, y: 0 }, { type: 'move', x: NaN, y: 0 }]) assert.equal(await backend.pointer(event), false);
  backend.paused = true; assert.equal(await backend.pointer({ type: 'click', x: .5, y: .5 }), false);
  backend.paused = false; backend.ready = false; assert.equal(await backend.pointer({ type: 'move', x: .5, y: .5 }), false);
  assert.equal(calls.length, before);
});

test('stop during a pending Web start prevents a later browser, server or helper allocation', async () => {
  const backend = new WebBackend();
  const capture = backend.capture({ fingerprint: 'fixture', type: 'web', project: 'never-read.json' }, {});
  await backend.stop(); await assert.rejects(capture, /WEB_BROWSER_CANCELLED/);
  assert.equal(backend.child, null); assert.equal(backend.host, null); assert.equal(backend.integration, null); assert.equal(backend.current, null);
});
