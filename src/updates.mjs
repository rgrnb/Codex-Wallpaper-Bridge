import { verify, createHash, randomBytes, createPublicKey } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, copyFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './config.mjs';
import { runFile, HOST } from './platform.mjs';

export function versionParts(version) {
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('UPDATE_VERSION_INVALID');
  return version.split('.').map(Number);
}
export function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
// Envelope signs exact UTF-8 payload bytes, so JSON canonicalization is unnecessary.
export function verifyManifest(envelope, config, current, now = Date.now(), allowCurrent = false) {
  if (!config.publicKeyPem || !config.manifestUrl) throw new Error('UPDATE_TRUST_NOT_CONFIGURED');
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 16384 ||
      typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('UPDATE_ENVELOPE_INVALID');
  if (!verify(null, Buffer.from(envelope.payload, 'utf8'), config.publicKeyPem, Buffer.from(envelope.signature, 'base64')))
    throw new Error('UPDATE_SIGNATURE_INVALID');
  const payload = JSON.parse(envelope.payload);
  if (payload.schemaVersion !== 1 || (!newer(payload.version, current) && !allowCurrent) ||
      !Number.isInteger(payload.bytes) || payload.bytes < 1 || payload.bytes > config.maxArchiveBytes ||
      !/^[a-f0-9]{64}$/.test(payload.sha256)) throw new Error('UPDATE_MANIFEST_INVALID');
  const url = new URL(payload.url), origin = new URL(config.manifestUrl);
  if (url.protocol !== 'https:' || origin.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password || url.hash)
    throw new Error('UPDATE_URL_INVALID');
  if (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= now ||
      !Number.isFinite(Date.parse(payload.issuedAt)) || Date.parse(payload.issuedAt) > now + 300000)
    throw new Error('UPDATE_MANIFEST_EXPIRED');
  return payload;
}
export async function boundedDownload(url, max, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('UPDATE_NETWORK_FAILED');
  const chunks = []; let bytes = 0;
  const reader = response.body.getReader();
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    bytes += value.length; if (bytes > max) throw new Error('UPDATE_DOWNLOAD_TOO_LARGE'); chunks.push(value);
  } } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export class UpdateManager {
  constructor(config, root, { fetcher = fetch, clock = Date.now } = {}) {
    this.config = config; this.root = path.join(root, 'updates'); this.fetcher = fetcher; this.clock = clock;
    this.nextCheck = 0; this.status = config.manifestUrl && config.publicKeyPem ? 'Idle' : 'NotConfigured'; this.candidate = null;
  }
  async configure({ manifestUrl, publicKeyPem }) {
    if (typeof manifestUrl !== 'string' || manifestUrl.length > 2048 || typeof publicKeyPem !== 'string' || publicKeyPem.length > 8192) throw new Error('UPDATE_TRUST_INVALID');
    if (!/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END PUBLIC KEY-----\s*$/.test(publicKeyPem)) throw new Error('UPDATE_PUBLIC_KEY_REQUIRED');
    const url = new URL(manifestUrl), key = createPublicKey(publicKeyPem);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || key.asymmetricKeyType !== 'ed25519') throw new Error('UPDATE_TRUST_INVALID');
    this.config = { ...this.config, manifestUrl: url.href, publicKeyPem: key.export({ format: 'pem', type: 'spki' }) };
    await atomicJson(path.join(path.dirname(this.root), 'update-trust.json'), this.config);
    this.candidate = null; this.status = 'Idle'; this.nextCheck = 0;
  }
  async check(current = '0.1.0', force = false) {
    if (['Downloading', 'Installing'].includes(this.status)) return;
    if (force) this.nextCheck = 0;
    if (this.status === 'NotConfigured' || this.clock() < this.nextCheck) return;
    this.nextCheck = this.clock() + this.config.checkIntervalHours * 3600000;
    try {
      const bytes = await boundedDownload(this.config.manifestUrl, 32768, this.fetcher);
      const envelope = JSON.parse(bytes.toString('utf8'));
      const candidate = verifyManifest(envelope, this.config, current, this.clock(), true);
      this.candidate = newer(candidate.version, current) ? candidate : null;
      this.status = this.candidate ? 'AwaitingConfirmation' : 'UpToDate'; this.code = '';
    } catch (error) { this.status = 'CheckFailed'; this.code = error.message.startsWith('UPDATE_') ? error.message : 'UPDATE_CHECK_FAILED'; }
  }
  async stage(confirmed) {
    if (confirmed !== true || !this.candidate || this.status !== 'AwaitingConfirmation') throw new Error('UPDATE_CONFIRMATION_REQUIRED');
    const manifest = this.candidate;
    if (Date.parse(manifest.expiresAt) <= this.clock()) throw new Error('UPDATE_MANIFEST_EXPIRED');
    this.status = 'Downloading';
    try {
      const archive = await boundedDownload(manifest.url, manifest.bytes, this.fetcher);
      if (archive.length !== manifest.bytes || createHash('sha256').update(archive).digest('hex') !== manifest.sha256)
        throw new Error('UPDATE_ARCHIVE_INVALID');
      await mkdir(this.root, { recursive: true });
      this.root = await realpath(this.root);
      const file = path.join(this.root, `${manifest.version}.zip`);
      await writeFile(`${file}.tmp`, archive, { mode: 0o600 }); await rename(`${file}.tmp`, file);
      await atomicJson(path.join(this.root, 'staged.json'), { schemaVersion: 1, version: manifest.version, sha256: manifest.sha256 });
      this.status = 'Staged'; return file;
    } catch (error) { this.status = 'AwaitingConfirmation'; throw error; }
  }
  async install(confirmed, installRoot) {
    if (confirmed !== true) throw new Error('UPDATE_CONFIRMATION_REQUIRED');
    const expected = path.join(process.env.LOCALAPPDATA, 'Programs', 'CodexWallpaperBridge');
    if ((await realpath(installRoot)).toLowerCase() !== (await realpath(expected)).toLowerCase()) throw new Error('UPDATE_INSTALLED_BUILD_REQUIRED');
    if (await readFile(path.join(installRoot, '.bridge-owned'), 'utf8') !== 'CodexWallpaperBridge/1') throw new Error('UPDATE_INSTALL_IDENTITY');
    await this.stage(true);
    const nonce = randomBytes(16).toString('hex'), job = path.join(this.root, `job-${nonce}.json`);
    // A separate runtime can survive replacing the installed files.
    try {
      for (const [from, to] of [['node.exe', 'worker-node.exe'], ['BridgeArchive.exe', 'BridgeArchive.exe'], ['src/update-worker.mjs', 'update-worker.mjs']])
        await copyFile(path.join(installRoot, from), path.join(this.root, to));
      await atomicJson(job, { version: this.candidate.version, sha256: this.candidate.sha256, nonce });
      await runFile(HOST, ['--start-update', job], { windowsHide: true, timeout: 10000 });
      this.status = 'Installing';
    } catch (error) { this.status = 'AwaitingConfirmation'; throw error; }
  }
}
// Version-directory activation primitive. Installer/health-check integration is a release gate.
// Keep preferences outside version directories. Recover interrupted activations on next launch.
export class ActivationTransaction {
  constructor(root) { this.root = root; this.journal = path.join(root, 'activation.json'); }
  async activate({ previous, next, settingsFile, healthCheck, disableBackground }) {
    versionParts(next); if (previous !== null) versionParts(previous);
    const backup = path.join(this.root, 'settings.previous.json');
    await mkdir(this.root, { recursive: true });
    await copyFile(settingsFile, backup);
    await atomicJson(this.journal, { schemaVersion: 1, previous, next, phase: 'staged', backup });
    try {
      await atomicJson(path.join(this.root, 'active.json'), { version: next });
      await atomicJson(this.journal, { schemaVersion: 1, previous, next, phase: 'activating', backup });
      if (!await healthCheck(next)) throw new Error('UPDATE_HEALTH_CHECK_FAILED');
      await atomicJson(this.journal, { schemaVersion: 1, previous, next, phase: 'committed', backup });
    } catch (error) { await this.rollback(settingsFile, disableBackground); throw error; }
  }
  async rollback(settingsFile, disableBackground) {
    const record = JSON.parse(await readFile(this.journal, 'utf8'));
    if (record.schemaVersion !== 1 || record.backup !== path.join(this.root, 'settings.previous.json')) throw new Error('UPDATE_RECOVERY_RECORD_INVALID');
    if (record.previous !== null) versionParts(record.previous);
    if (record.previous) await atomicJson(path.join(this.root, 'active.json'), { version: record.previous });
    else await rm(path.join(this.root, 'active.json'), { force: true });
    await copyFile(record.backup, settingsFile); await disableBackground();
    await atomicJson(this.journal, { ...record, phase: 'rolledBack' });
  }
}
