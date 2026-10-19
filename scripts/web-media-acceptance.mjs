import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebBackend } from '../src/web-backend.mjs';
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.local-evidence', `web-media-${randomBytes(8).toString('hex')}`); await mkdir(evidence, { recursive: true });
const framework = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319'), metadata = path.join(process.env.WINDIR, 'System32', 'WinMetadata');
const executable = path.join(evidence, 'WebMediaFixture.exe');
await run(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/optimize+', `/out:${executable}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
  ...['System.Runtime.WindowsRuntime.dll', 'System.Runtime.dll'].map(name => `/reference:${path.join(framework, name)}`),
  ...['Windows.Foundation.winmd', 'Windows.Media.winmd', 'Windows.Storage.winmd'].map(name => `/reference:${path.join(metadata, name)}`),
  path.join(root, 'scripts', 'experiments', 'fixtures', 'WebMediaFixture.cs')], { windowsHide: true });
await writeFile(path.join(evidence, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html' }));
await writeFile(path.join(evidence, 'index.html'), `<!doctype html><html><body><script>
window.proof={titles:[],playback:[],timelines:[],thumbnail:[]};
wallpaperRegisterMediaPropertiesListener(e=>{if(e.title?.startsWith('CWB authored'))proof.titles.push({title:e.title,artist:e.artist,album:e.albumTitle,type:e.contentType});});
wallpaperRegisterMediaPlaybackListener(e=>{proof.playback.push(e.state);});
wallpaperRegisterMediaTimelineListener(e=>{proof.timelines.push(e);});
wallpaperRegisterMediaThumbnailListener(e=>{if(e.thumbnail)proof.thumbnail.push({data:e.thumbnail.startsWith('data:image/png;base64,'),color:e.primaryColor,contrast:e.highContrastColor});});
</script></body></html>`);
const source = { type: 'web', root: evidence, resource: path.join(evidence, 'index.html'), project: path.join(evidence, 'project.json'), fingerprint: 'authored-media-' + Date.now(), properties: {} };
const backend = new WebBackend({ helperPath: path.join(root, 'build', 'BridgeWebIntegration.exe') });
const policy = { fps: 15, maxWidth: 640, jpegQuality: 70, paused: false }, report = { fixture: 'own-hidden-SMTC-window', userMetadataRecorded: false }; let fixture;
try {
  fixture = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('MEDIA_FIXTURE_START_TIMEOUT')), 5000);
    fixture.stdout.once('data', () => { clearTimeout(timer); resolve(); }); fixture.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('MEDIA_FIXTURE_FAILED_' + code)); }); });
  for (let i = 0; i < 45; i++) { await backend.capture(source, policy); await new Promise(resolve => setTimeout(resolve, 110)); }
  const proof = (await backend.pipe.call('Runtime.evaluate', { expression: 'proof', returnByValue: true }, backend.session)).result.value;
  report.proof = proof;
  assert.ok(proof.titles.some(row => row.title === 'CWB authored title' && row.artist === 'CWB authored artist' && row.album === 'CWB authored album' && row.type === 'music'), JSON.stringify(proof));
  assert.ok(proof.titles.some(row => row.title === 'CWB authored title changed'));
  assert.ok(proof.playback.includes(1)); assert.ok(proof.playback.includes(2));
  assert.ok(proof.timelines.some(row => row.position >= 12 && row.position <= 20 && row.duration === 120));
  assert.ok(proof.thumbnail.some(row => row.data && row.color === '#3C50C8' && row.contrast === '#FFFFFF'));
  report.result = 'passed'; report.proof = proof;
} catch (error) { report.result = 'failed'; report.error = error.message; throw error; }
finally {
  if (fixture && fixture.exitCode === null) fixture.kill(); await backend.stop(); report.cleanup = { browserStopped: !backend.child, integrationStopped: !backend.integration };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, error: report.error, evidence: path.join(evidence, 'result.json') }));
}
