// Standalone worker copied outside the install directory before activation.
import { readFile, writeFile, rename, copyFile, lstat, realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
const run = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
const jobFile = process.argv[2];
const data = await realpath(path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge'));
const target = path.join(await realpath(path.join(process.env.LOCALAPPDATA, 'Programs')), 'CodexWallpaperBridge');
const journal = path.join(data, 'updates', 'activation.json');
const settings = path.join(data, 'settings.json');
async function atomic(file, value) { await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.tmp`, file); }
async function plain(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = await lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (stat?.isSymbolicLink()) throw new Error('UPDATE_PATH_REDIRECTED');
    if (path.dirname(current) === current) break;
  }
}
async function move(from, to) {
  for (let n = 0; ; n++) try { return await rename(from, to); }
  catch (error) { if (n >= 60 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await sleep(250); }
}
async function launch(root, nonce) {
  const child = spawn(path.join(root, 'CodexWallpaperBridge.exe'), ['--background'], { detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, BRIDGE_UPDATE_NONCE: nonce || '' } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  return child;
}
let record, lease, activated = false, moved = false;
try {
  if (!jobFile || path.dirname(path.resolve(jobFile)) !== path.join(data, 'updates')) throw new Error('UPDATE_JOB_INVALID');
  await plain(jobFile); await plain(target);
  lease = spawn(path.join(path.dirname(jobFile), 'BridgeArchive.exe'), ['--lease'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UPDATE_INSTALL_BUSY')), 5000);
    lease.once('error', () => { clearTimeout(timer); reject(new Error('UPDATE_LEASE_FAILED')); });
    lease.once('exit', () => { clearTimeout(timer); reject(new Error('UPDATE_INSTALL_BUSY')); });
    lease.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().trim() === 'ready' ? resolve() : reject(new Error('UPDATE_LEASE_FAILED')); });
  });
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  if (!/^[a-f0-9]{32}$/.test(job.nonce) || !/^\d+\.\d+\.\d+$/.test(job.version) || !/^[a-f0-9]{64}$/.test(job.sha256)) throw new Error('UPDATE_JOB_INVALID');
  if (await readFile(path.join(target, '.bridge-owned'), 'utf8') !== 'CodexWallpaperBridge/1') throw new Error('UPDATE_INSTALL_IDENTITY');
  const archive = path.join(data, 'updates', `${job.version}.zip`); await plain(archive);
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== job.sha256) throw new Error('UPDATE_HASH_INVALID');
  const stage = `${target}.update-${job.nonce}`, backup = `${target}.previous-${job.nonce}`;
  await plain(stage); await plain(backup);
  record = { schemaVersion: 2, phase: 'preparing', workerPid: process.pid, version: job.version, nonce: job.nonce, target, stage, backup };
  await atomic(journal, record);
  await run(path.join(path.dirname(jobFile), 'BridgeArchive.exe'), [archive, stage, job.sha256], { windowsHide: true, timeout: 60000 });
  if (JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8')).version !== job.version) throw new Error('UPDATE_VERSION_MISMATCH');
  // New packages ship a versioned uninstaller. Preserve it; only legacy
  // archives without that entry inherit the previous install's tool.
  await copyFile(path.join(target, 'Uninstall.exe'), path.join(stage, 'Uninstall.exe'), constants.COPYFILE_EXCL)
    .catch(error => { if (error.code !== 'EEXIST') throw error; });
  // User-added files stay in the retained original directory. Do not open or
  // duplicate their contents while preparing a release. Rollback restores that
  // directory; uninstall removes only inventoried product files from backups.
  await copyFile(settings, path.join(data, 'updates', 'settings.previous.json'));
  await run(path.join(target, 'CodexWallpaperBridge.exe'), ['--signal-stop'], { windowsHide: true, timeout: 5000 });
  // Wait for old tray/service to finish restoring foreground appearance before swapping files.
  await sleep(1200);
  record.phase = 'prepared'; await atomic(journal, record);
  await move(target, backup); moved = true;
  await move(stage, target); activated = true;
  record.phase = 'activating'; await atomic(journal, record);
  const nextProcess = await launch(target, job.nonce);
  let healthy = false;
  for (let n = 0; n < 120; n++) {
    if (nextProcess.exitCode !== null) throw new Error('UPDATE_NEW_PROCESS_EXITED');
    const health = await readFile(path.join(data, 'updates', `health-${job.nonce}.json`), 'utf8').then(JSON.parse).catch(() => null);
    if (health?.nonce === job.nonce && health.version === job.version && health.healthy === true) { healthy = true; break; }
    await sleep(500);
  }
  if (!healthy) throw new Error('UPDATE_HEALTH_CHECK_FAILED');
  await run(path.join(process.env.SystemRoot, 'System32', 'reg.exe'), ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexWallpaperBridge',
    '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', job.version, '/f'], { windowsHide: true, timeout: 5000 });
  record.phase = 'committed'; await atomic(journal, record);
} catch (error) {
  if (record) {
  if (activated) { await run(path.join(target, 'CodexWallpaperBridge.exe'), ['--signal-stop'], { windowsHide: true, timeout: 5000 }).catch(() => {}); await sleep(1200); }
  try {
    if (activated) await move(target, `${record.stage}.failed`);
    if (moved) await move(record.backup, target);
    if (moved) {
      const previous = JSON.parse(await readFile(path.join(data, 'updates', 'settings.previous.json'), 'utf8')); previous.enabled = false;
      await atomic(settings, previous); await launch(target);
      const previousVersion = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version;
      if (/^\d+\.\d+\.\d+$/.test(previousVersion)) await run(path.join(process.env.SystemRoot, 'System32', 'reg.exe'),
        ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexWallpaperBridge', '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', previousVersion, '/f'], { windowsHide: true, timeout: 5000 });
    }
    await atomic(journal, { ...record, phase: 'rolledBack', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_ACTIVATION_FAILED' });
  } catch { await atomic(journal, { ...record, phase: 'recoveryRequired', code: 'UPDATE_RECOVERY_REQUIRED' }); }
  }
  process.exitCode = 1;
} finally {
  if (lease) { lease.stdin.on('error', () => {}); lease.stdin.end(); }
}
