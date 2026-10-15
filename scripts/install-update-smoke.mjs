import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile, cp, readdir, unlink, rmdir, realpath, rename, copyFile } from 'node:fs/promises';
import { generateKeyPairSync, sign, randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT, runFile } from '../src/platform.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = path.join(process.env.LOCALAPPDATA, 'Programs', 'CodexWallpaperBridge');
const data = path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge');
const launcher = path.join(path.dirname(target), 'CodexWallpaperBridge.Launcher.exe');
const releaseVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const setup = path.join(ROOT, 'dist', `CodexWallpaperBridge-Setup-${releaseVersion}.exe`);
const exists = file => access(file).then(() => true, () => false);
// Never replace a pre-existing user installation/preferences for acceptance testing.
for (const file of [target, launcher]) assert.equal(await exists(file), false, 'Existing Bridge state must be preserved: ' + file);
if (await exists(data)) {
  const names=await readdir(data);
  assert.ok(names.every(name=>name==='instance.lock'||/^settings\.json\.\d+\.tmp$/.test(name)), 'Existing Bridge preferences must be preserved.');
  // A prior controlled startup timed out before committing any preferences; preserve its evidence in place.
}
const root = path.join(ROOT, '.local-evidence', `update-${randomBytes(8).toString('hex')}`); await mkdir(root);
const certificate = path.join(root, 'certificate.pem'), privateKey = path.join(root, 'tls-private.pem');
const tlsConfig = path.join(root, 'openssl.cnf'); await writeFile(tlsConfig, '[req]\ndistinguished_name=dn\n[dn]\n');
await runFile(process.env.BRIDGE_OPENSSL_PATH || 'openssl.exe', ['req', '-config', tlsConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', privateKey, '-out', certificate],
  { windowsHide: true, timeout: 30000 });
const keys = generateKeyPairSync('ed25519'), publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' });
let manifest, archive, version, installed = false, server, preservedDirectory;
const token = randomBytes(32).toString('hex');
async function waitFor(read, timeout = 30000) {
  const end = Date.now() + timeout; let result;
  while (Date.now() < end) { try { result = await read(); if (result) return result; } catch { } await sleep(200); }
  throw new Error('Acceptance condition timed out');
}
async function packageVersion(next, broken = false) {
  const app = path.join(root, next); await cp(path.join(ROOT, 'dist', 'app'), app, { recursive: true });
  const config = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8')); config.version = next;
  await writeFile(path.join(app, 'package.json'), JSON.stringify(config));
  if (broken) await writeFile(path.join(app, 'src', 'main.mjs'), "throw new Error('CONTROLLED_UPDATE_STARTUP_FAILURE');\n");
  const zip = path.join(root, `${next}.zip`);
  const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
  const zipScript = `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(app)},${psQuote(zip)},[IO.Compression.CompressionLevel]::Optimal,$false)`;
  await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(zipScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60000 });
  archive = await readFile(zip); version = next;
  const payload = JSON.stringify({ schemaVersion: 1, version, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'),
    url: `https://127.0.0.1:${server.address().port}/release.zip`, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  manifest = JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') });
}
async function stop() {
  await waitFor(async () => {
    await runFile(path.join(ROOT, 'build', 'CodexWallpaperBridge.exe'), ['--signal-stop'], { windowsHide: true, timeout: 5000 });
    await sleep(500);
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-Process -Name CodexWallpaperBridge -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 5000 });
    return stdout.trim() === '0';
  }, 30000);
}
async function launch() {
  const nonce = randomBytes(16).toString('hex');
  const child = spawn(launcher, ['--background'], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    PATH: path.join(process.env.SystemRoot, 'System32'), BRIDGE_CONTROL_TOKEN: token, BRIDGE_UPDATE_NONCE: nonce, NODE_EXTRA_CA_CERTS: certificate } });
  child.unref();
  const health = await waitFor(() => readFile(path.join(data, 'updates', `health-${nonce}.json`), 'utf8').then(JSON.parse),45000);
  assert.equal(health.healthy, true, JSON.stringify(health)); return `http://127.0.0.1:${health.controlPort}`;
}
async function action(base, route, body = {}) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'X-Bridge-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
const report = { installation: false, signedActivation: false, failedActivationRollback: false, uninstallPreservesUnknown: false };
try {
  server = https.createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, (request, response) => {
    if (request.url === '/manifest.json') { response.setHeader('Content-Type', 'application/json'); response.end(manifest); }
    else if (request.url === '/release.zip') response.end(archive); else response.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await packageVersion('0.1.1');
  await runFile(setup, ['--install-silent'], { windowsHide: true, timeout: 60000 }); installed = true;
  assert.equal(await readFile(path.join(target, '.bridge-owned'), 'utf8'), 'CodexWallpaperBridge/1'); report.installation = true;
  await writeFile(path.join(target, 'user-owned-test.txt'), 'controlled-preservation-fixture');
  let base = await launch();
  const headers = { 'X-Bridge-Token': token };
  const status = await (await fetch(base + '/status', { headers })).json();
  assert.equal(status.settings.enabled, false); assert.equal(status.settings.startup, false);
  await action(base, '/settings', { ...status.settings, startup: true });
  let probe = JSON.parse((await runFile(path.join(target, 'CodexWallpaperBridge.exe'), ['--probe'], { windowsHide: true, timeout: 10000 })).stdout);
  assert.equal(probe.startupEnabled, true);
  await action(base, '/settings', { ...status.settings, startup: false });
  probe = JSON.parse((await runFile(path.join(target, 'CodexWallpaperBridge.exe'), ['--probe'], { windowsHide: true, timeout: 10000 })).stdout);
  assert.equal(probe.startupEnabled, false); report.optInStartupRoundTrip = true; report.developerToolsRemovedFromPath = true;
  await action(base, '/settings', { ...status.settings, effects: { ...status.settings.effects, opacity: 0.42 } });
  await action(base, '/updates/configure', { confirmed: true, manifestUrl: `https://127.0.0.1:${server.address().port}/manifest.json`, publicKeyPem });
  await action(base, '/updates/install', { confirmed: true, version: '0.1.1' });
  const committed = await waitFor(async () => { const j = JSON.parse(await readFile(path.join(data, 'updates', 'activation.json'), 'utf8')); return j.phase === 'committed' && j.version === '0.1.1' && j; }, 90000);
  preservedDirectory = committed.backup;
  assert.equal(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version, '0.1.1');
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).effects.opacity, 0.42);
  assert.equal(await exists(path.join(target, 'user-owned-test.txt')), false, 'Unknown user contents must never be copied into an update.');
  assert.equal(await readFile(path.join(preservedDirectory, 'user-owned-test.txt'), 'utf8'), 'controlled-preservation-fixture'); report.signedActivation = true;
  await stop(); base = await launch(); await packageVersion('0.1.2', true);
  await action(base, '/updates/check'); await action(base, '/updates/install', { confirmed: true, version: '0.1.2' });
  const rolledBack = await waitFor(async () => { const j = JSON.parse(await readFile(path.join(data, 'updates', 'activation.json'), 'utf8')); return j.phase === 'rolledBack' && j.version === '0.1.2' && j; }, 90000);
  assert.equal(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version, '0.1.1');
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).enabled, false);
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).effects.opacity, 0.42); report.failedActivationRollback = true;
  // Reconstruct an interrupted swap using only the previous test's owned signed
  // failed version. The stable launcher must recover before running that version.
  await stop();
  const physicalTarget = await realpath(target), programs = await realpath(path.dirname(target));
  const interruptedNonce = randomBytes(16).toString('hex'), stage = `${physicalTarget}.update-${interruptedNonce}`, backup = `${physicalTarget}.previous-${interruptedNonce}`;
  const failed = `${rolledBack.stage}.failed`;
  for (const location of [physicalTarget, failed, stage, backup]) assert.equal(path.dirname(path.resolve(location)).toLowerCase(), programs.toLowerCase());
  assert.equal(await readFile(path.join(failed, '.bridge-owned'), 'utf8'), 'CodexWallpaperBridge/1');
  await copyFile(path.join(data, 'settings.json'), path.join(data, 'updates', 'settings.previous.json'));
  await rename(physicalTarget, backup); await rename(failed, physicalTarget);
  await writeFile(path.join(data, 'updates', 'activation.json'), JSON.stringify({ schemaVersion: 2, phase: 'activating', workerPid: 0,
    version: '0.1.2', nonce: interruptedNonce, target: physicalTarget, stage, backup }));
  await launch();
  assert.equal(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version, '0.1.1');
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).enabled, false);
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).effects.opacity, 0.42);
  assert.equal(JSON.parse(await readFile(path.join(data, 'updates', 'activation.json'), 'utf8')).code, 'UPDATE_INTERRUPTED_ROLLED_BACK');
  report.interruptedActivationRecovery = true;
} finally {
  await stop().catch(() => {});
  if (installed) {
    await runFile(setup, ['--remove-installed-silent'], { windowsHide: true, timeout: 30000 });
    assert.equal(await exists(path.join(target, 'node.exe')), false); assert.equal(await exists(launcher), false);
    const fixtureDirectory = preservedDirectory || target;
    assert.equal(await readFile(path.join(fixtureDirectory, 'user-owned-test.txt'), 'utf8'), 'controlled-preservation-fixture'); report.uninstallPreservesUnknown = true;
    await unlink(path.join(fixtureDirectory, 'user-owned-test.txt')); await rmdir(fixtureDirectory).catch(() => {});
    // Remove this scenario's local feed trust; no previous Bridge preferences existed at entry.
    await unlink(path.join(data, 'update-trust.json')).catch(() => {});
  }
  server?.closeAllConnections(); server?.close();
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
