// Acceptance wrapper: temporarily relocate the complete existing preferences
// directory by rename. No existing file content is opened, copied or deleted.
import assert from 'node:assert/strict';
import { access, realpath, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, runFile } from '../src/platform.mjs';
const exists = file => access(file).then(() => true, () => false);
const data = path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge');
const programs = path.join(process.env.LOCALAPPDATA, 'Programs');
for (const file of [path.join(programs, 'CodexWallpaperBridge'), path.join(programs, 'CodexWallpaperBridge.Launcher.exe')])
  assert.equal(await exists(file), false, 'Existing installation must be preserved.');
const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "@(Get-Process -Name CodexWallpaperBridge -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 5000 });
assert.equal(stdout.trim(), '0', 'Exit Bridge before relocating preferences.');
const nonce = randomUUID().replaceAll('-', ''), root = path.join(ROOT, '.local-evidence', `data-preservation-${nonce}`);
await mkdir(root);
let physical, backup, output;
if (await exists(data)) {
  physical = await realpath(data); backup = `${physical}.acceptance-backup-${nonce}`; output = `${physical}.acceptance-output-${nonce}`;
  assert.equal(path.basename(physical), 'CodexWallpaperBridge');
  assert.equal(path.dirname(physical), path.dirname(backup));
  await writeFile(path.join(root, 'restore-journal.json'), JSON.stringify({ physical, backup, output, phase: 'before-rename' }));
  await rename(physical, backup);
}
try {
  const result = await runFile(process.execPath, [path.join(ROOT, 'scripts', 'install-update-smoke.mjs')],
    { windowsHide: true, timeout: 360000, maxBuffer: 16384 });
  process.stdout.write(result.stdout);
} finally {
  if (backup) {
    // The child script stops/uninstalls its own application in its finally block.
    if (await exists(data)) {
      const generated = await realpath(data); assert.equal(generated.toLowerCase(), physical.toLowerCase()); await rename(generated, output);
    }
    await rename(backup, physical);
    await writeFile(path.join(root, 'restore-journal.json'), JSON.stringify({ physical, output, phase: 'original-restored' }));
    console.log(JSON.stringify({ existingPreferencesRestored: true, existingContentsRead: false }));
  }
}
