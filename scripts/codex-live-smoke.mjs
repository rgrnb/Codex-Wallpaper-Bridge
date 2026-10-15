import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, nativeProbe } from '../src/platform.mjs';
import { listTargets, CdpClient } from '../src/cdp.mjs';
const before = await nativeProbe(), executable = before.codexInstall;
if (!executable) throw new Error('CODEX_NOT_INSTALLED');
const profile = path.join(ROOT, '.local-evidence', `codex-test-profile-${randomBytes(8).toString('hex')}`); await mkdir(profile);
const port = 19336;
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
  { windowsHide: true, stdio: 'ignore' });
const report = { independentProcess: false, endpoint: false, structure: null, currentChatAccessed: false, existingCodexStopped: false };
let client;
try {
  let target;
  for (let n = 0; n < 50; n++) {
    await new Promise(r => setTimeout(r, 200));
    const apps = await nativeProbe();
    const owned = apps.codex.find(a => a.pid === child.pid && a.endpoints?.includes(port));
    if (owned) { report.independentProcess = true; const targets = await listTargets(port); if (targets.length) { target = targets[0]; break; } }
    if (child.exitCode !== null) break;
  }
  if (target) {
    report.endpoint = true; client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    // Structural booleans only: no text, input values, history, cookies, storage, tokens, or page screenshots.
    const deadline = Date.now() + 30000;
    do {
      report.structure = await client.evaluate(`({root:!!document.querySelector('#root'),main:!!document.querySelector('main'),
        sidebar:!!document.querySelector('aside.app-shell-left-panel'),composer:!!document.querySelector('.composer-surface-chrome,[class*="_ComposerLayoutRoot_"],[data-composer-surface-variant]')})`);
      if (report.structure.main && report.structure.sidebar && report.structure.composer) break;
      await new Promise(r => setTimeout(r, 500));
    } while (Date.now() < deadline && child.exitCode === null);
  }
} finally {
  client?.close();
  // Only the newly launched process is closed. Existing official Codex processes are never terminated.
  if (child.exitCode === null) child.kill();
  await writeFile(path.join(ROOT, '.local-evidence', 'codex-live-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
