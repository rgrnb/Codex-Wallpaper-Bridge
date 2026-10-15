import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyManifest, UpdateManager, ActivationTransaction } from '../src/updates.mjs';
test('signed releases reject corruption, wrong origin, expiry and missing trust (AT-25)', () => {
  const keys = generateKeyPairSync('ed25519'), now = Date.now();
  const config = { publicKeyPem: keys.publicKey, manifestUrl: 'https://releases.example/manifest.json', maxArchiveBytes: 1024 };
  const payload = { schemaVersion: 1, version: '0.2.0', bytes: 10, sha256: 'a'.repeat(64), url: 'https://releases.example/app.zip',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
  const envelope = value => { const payload = JSON.stringify(value); return { payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') }; };
  assert.equal(verifyManifest(envelope(payload), config, '0.1.0', now).version, '0.2.0');
  const corrupt = envelope(payload); corrupt.payload += ' '; assert.throws(() => verifyManifest(corrupt, config, '0.1.0', now), /SIGNATURE/);
  assert.throws(() => verifyManifest(envelope({ ...payload, url: 'https://attacker.example/app.zip' }), config, '0.1.0', now), /URL/);
  assert.throws(() => verifyManifest(envelope({ ...payload, expiresAt: '2000-01-01' }), config, '0.1.0', now), /EXPIRED/);
  assert.throws(() => verifyManifest(envelope(payload), {}, '0.1.0', now), /TRUST/);
});
test('update staging requires confirmation and verifies exact archive bytes (AT-24/25)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-update-'));
  const bytes = Buffer.from('fixture archive'); let requests = 0;
  const m = new UpdateManager({ maxArchiveBytes: 1024 }, root, { fetcher: async () => { requests++; return new Response(bytes); } });
  m.candidate = { version: '0.2.0', bytes: bytes.length, url: 'https://release.example/app.zip',
    sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() };
  m.status = 'AwaitingConfirmation'; await assert.rejects(m.stage(false), /CONFIRMATION/); assert.equal(requests, 0);
  assert.deepEqual(await readFile(await m.stage(true)), bytes);
});
test('failed health check rolls back previous version and settings, disabling background (AT-25)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-activation-')), settings = path.join(root, 'settings.json');
  await writeFile(settings, '{"enabled":true}'); let disabled = false;
  const transaction = new ActivationTransaction(root);
  await assert.rejects(transaction.activate({ previous: '0.1.0', next: '0.2.0', settingsFile: settings,
    healthCheck: async () => { await writeFile(settings, 'corrupt migration'); return false; }, disableBackground: async () => { disabled = true; } }), /HEALTH/);
  assert.equal((JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8'))).version, '0.1.0');
  assert.equal(await readFile(settings, 'utf8'), '{"enabled":true}'); assert.equal(disabled, true);
});

test('offline checking backs off without archive downloads, and staging disk failure leaves settings usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-update-failure-')); let requests = 0;
  const config = { manifestUrl: 'https://release.example/manifest.json', publicKeyPem: 'fixture', checkIntervalHours: 24 };
  const offline = new UpdateManager(config, root, { fetcher: async () => { requests++; throw new Error('offline'); } });
  await offline.check(); await offline.check(); assert.equal(requests, 1); assert.equal(offline.status, 'CheckFailed');
  const blocked = path.join(root, 'not-a-directory'); await writeFile(blocked, 'authored fixture');
  const archive = Buffer.from('authored archive'), staging = new UpdateManager(config, blocked, { fetcher: async () => new Response(archive) });
  staging.candidate = { version: '0.2.0', bytes: archive.length, url: 'https://release.example/archive.zip',
    sha256: createHash('sha256').update(archive).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() };
  staging.status = 'AwaitingConfirmation'; await assert.rejects(staging.stage(true));
  assert.equal(staging.status, 'AwaitingConfirmation'); assert.equal(await readFile(blocked, 'utf8'), 'authored fixture');
});
