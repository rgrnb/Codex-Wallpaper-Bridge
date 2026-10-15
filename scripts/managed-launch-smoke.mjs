import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HOST, ROOT, nativeProbe, runFile } from '../src/platform.mjs';

const before = await nativeProbe(), port = 19337, token = randomBytes(32).toString('hex'), nonce = randomBytes(16).toString('hex');
assert.ok(!before.codex.some(app => app.endpoints?.includes(port)), 'Test port already belongs to another instance.');
const requested = path.join(ROOT, '.local-evidence', `managed-launch-${nonce}`); await mkdir(requested);
const data = await realpath(requested), env = { ...process.env, BRIDGE_DATA_DIR: data, BRIDGE_CONTROL_TOKEN: token, BRIDGE_UPDATE_NONCE: nonce };
const tray = spawn(HOST, ['--background'], { windowsHide: true, stdio: 'ignore', env });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ready = false, owned;
const report = { independentLaunch: false, survivesBridgeExit: false, existingCodexStopped: false };
try {
  let health;
  for (let n = 0; n < 150 && !health; n++) {
    try { health = JSON.parse(await readFile(path.join(data, 'updates', `health-${nonce}.json`), 'utf8')); } catch { }
    if (!health) await delay(200);
  }
  assert.ok(health?.healthy, 'The newly launched test tray must become ready.'); ready = true;
  const base = `http://127.0.0.1:${health.controlPort}`, headers = { 'X-Bridge-Token': token, 'Content-Type': 'application/json' };
  const status = await (await fetch(base + '/status', { headers })).json();
  const configured = await fetch(base + '/settings', { method: 'POST', headers, body: JSON.stringify({ ...status.settings, cdpPort: port }) });
  assert.equal(configured.status, 200);
  const launched = await fetch(base + '/launch', { method: 'POST', headers, body: '{}' });
  assert.equal(launched.status, 200, await launched.text());
  for (let n = 0; n < 40 && !owned; n++) {
    owned = (await nativeProbe()).codex.find(app => app.endpoints?.includes(port) && !before.codex.some(old => old.pid === app.pid));
    if (!owned) await delay(200);
  }
  assert.ok(owned); report.independentLaunch = true;
  await runFile(HOST, ['--signal-stop'], { windowsHide: true, timeout: 10000 });
  for (let n = 0; n < 50 && tray.exitCode === null; n++) await delay(200);
  assert.equal(tray.exitCode, 0); process.kill(owned.pid, 0); report.survivesBridgeExit = true;
  for (const app of before.codex) process.kill(app.pid, 0);
} finally {
  if (ready && tray.exitCode === null) await runFile(HOST, ['--signal-stop'], { windowsHide: true, timeout: 10000 }).catch(() => {});
  if (tray.exitCode === null) tray.kill();
  // Only the independently launched, explicitly identified test instance is closed.
  if (owned) { try { process.kill(owned.pid); } catch { } }
  await writeFile(path.join(data, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
