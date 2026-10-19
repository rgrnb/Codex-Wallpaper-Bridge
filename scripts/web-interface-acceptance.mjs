import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebBackend } from '../src/web-backend.mjs';

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.local-evidence', `web-interface-${randomBytes(8).toString('hex')}`);
await mkdir(path.join(evidence, 'pictures'), { recursive: true });
await writeFile(path.join(evidence, 'pictures', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>');
const metadata = { type: 'web', file: 'index.html', general: { properties: {
  photo: { type: 'file', value: 'pictures/a.svg' }, random: { type: 'directory', mode: 'ondemand', value: 'pictures', filetype: 'image' },
  all: { type: 'directory', mode: 'fetchall', value: 'pictures', filetype: 'image' },
} } };
await writeFile(path.join(evidence, 'project.json'), JSON.stringify(metadata));
await writeFile(path.join(evidence, 'index.html'), `<!doctype html><html><body style="margin:0;background:#121821"><img id="photo"><img id="random"><div id="background" style="width:30px;height:30px"></div><script>
window.proof={general:[],paused:[],directories:[],removed:[],clicks:0,moves:0,audioCalls:0,left:0,right:0,mediaCalls:0};
window.wallpaperPropertyListener={applyUserProperties(p){photo.src='file:///'+p.photo.value; background.style.backgroundImage="url('file:///"+p.photo.value+"')"; fetch('file:///'+p.photo.value).then(r=>r.text()).then(t=>proof.fetched=t.includes('<svg'));},applyGeneralProperties(p){proof.general.push(p);},setPaused(p){proof.paused.push(p);},userDirectoryFilesAddedOrChanged(k,v){proof.directories.push(v.length);},userDirectoryFilesRemoved(k,v){proof.removed.push(v.length);}};
window.wallpaperRequestRandomFileForProperty('random',(key,file)=>{document.getElementById('random').src='file:///'+file;proof.randomCallback=key==='random'&&file.endsWith('/a.svg');});
window.wallpaperRegisterAudioListener(a=>{proof.audioCalls++;const l=Math.max(...a.slice(0,64)),r=Math.max(...a.slice(64));if(l>proof.left){proof.left=l;proof.leftBin=a.indexOf(l);}if(r>proof.right){proof.right=r;proof.rightBin=a.indexOf(r,64)-64;}});
window.wallpaperRegisterMediaStatusListener(e=>{proof.mediaCalls++;proof.mediaEnabled=e.enabled;});
window.wallpaperRegisterMediaPropertiesListener(e=>{proof.mediaPropertiesSeen=true;});
document.addEventListener('mousemove',e=>{proof.moves++;proof.position=[e.clientX,e.clientY];});
document.addEventListener('click',e=>{proof.clicks++;proof.button=e.button;document.body.style.backgroundColor='rgb(40, 80, 120)';});
</script></body></html>`);
const helper = path.join(root, 'build', 'BridgeWebIntegration.exe'); await access(helper);
const backend = new WebBackend({ helperPath: helper }), source = { type: 'web', root: evidence, resource: path.join(evidence, 'index.html'),
  project: path.join(evidence, 'project.json'), fingerprint: `authored-web-${Date.now()}`, properties: {} };
const policy = { fps: 30, maxWidth: 640, jpegQuality: 70, paused: false };
const evaluate = async expression => (await backend.pipe.call('Runtime.evaluate', { expression, returnByValue: true }, backend.session)).result?.value;
const report = { fixture: 'authored-only', startedAt: new Date().toISOString(), checks: {} }; let player;
try {
  for (let i = 0; i < 40; i++) { await backend.capture(source, policy); const diagnostic = backend.integration?.diagnostics();
    if (diagnostic?.audio?.ready && diagnostic?.media?.ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const initial = await evaluate('({photo:photo.complete&&photo.naturalWidth===12,random:document.getElementById("random").complete&&document.getElementById("random").naturalWidth===12,background:getComputedStyle(background).backgroundImage.includes("http://127.0.0.1"),fetched:proof.fetched,randomCallback:proof.randomCallback,directories:proof.directories,general:proof.general,mediaEnabled:proof.mediaEnabled,mediaPropertiesSeen:proof.mediaPropertiesSeen})');
  assert.equal(initial.photo, true); assert.equal(initial.random, true); assert.equal(initial.background, true); assert.equal(initial.fetched, true);
  assert.equal(initial.randomCallback, true); assert.deepEqual(initial.directories, [1]); assert.equal(initial.general[0].videoaudiooutput, false);
  assert.equal(initial.mediaEnabled, true); assert.equal(initial.mediaPropertiesSeen, true);
  report.checks.initialInterfaces = true;
  await backend.pointer({ type: 'click', x: .5, y: .6 }, { current: () => true });
  let pointer = await evaluate('({clicks:proof.clicks,button:proof.button,position:proof.position})'); assert.equal(pointer.clicks, 1); assert.equal(pointer.button, 0);
  assert.ok(Math.abs(pointer.position[0] - 319.5) < 1); assert.ok(Math.abs(pointer.position[1] - 215.4) < 1);
  assert.equal(await backend.pointer({ type: 'click', x: .5, y: .5 }, { current: () => false }), false);
  await backend.configure({ ...policy, fps: 15, paused: true }); assert.equal(await backend.pointer({ type: 'click', x: .5, y: .5 }), false);
  const pause = await evaluate('({clicks:proof.clicks,last:proof.paused.at(-1),fps:proof.general.at(-1).fps})');
  assert.deepEqual(pause, { clicks: 1, last: true, fps: 15 }); await backend.configure(policy); report.checks.pointerPauseAndGuard = true;
  await writeFile(path.join(evidence, 'pictures', 'b.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"></svg>');
  await new Promise(resolve => setTimeout(resolve, 1100)); await backend.capture(source, policy);
  assert.deepEqual(await evaluate('proof.directories'), [1, 1]); report.checks.directoryUpdate = true;
  const fixtureSource = path.join(root, 'scripts', 'experiments', 'fixtures', 'WebAudioFixture.cs'), fixtureExecutable = path.join(evidence, 'WebAudioFixture.exe');
  await run(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:exe', '/optimize+', `/out:${fixtureExecutable}`, fixtureSource], { windowsHide: true });
  player = spawn(fixtureExecutable, [], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const session = JSON.parse((await run(helper, ['--sessions', String(player.pid)], { windowsHide: true })).stdout);
  for (let i = 0; i < 35; i++) { await backend.capture(source, policy); await new Promise(resolve => setTimeout(resolve, 70)); }
  const audio = await evaluate('({calls:proof.audioCalls,left:proof.left,right:proof.right,leftBin:proof.leftBin,rightBin:proof.rightBin})');
  assert.ok(audio.calls > 10); assert.ok(audio.left > .002, JSON.stringify(audio)); assert.ok(audio.right > .002, JSON.stringify(audio));
  assert.ok(audio.leftBin >= 25 && audio.leftBin <= 31, JSON.stringify(audio)); assert.ok(audio.rightBin >= 46 && audio.rightBin <= 52, JSON.stringify(audio));
  assert.ok(backend.integration.diagnostics().audio.sampleFrames > 1000);
  assert.ok(session.queried && session.sessions.some(row => row.pid === player.pid));
  report.audio = { ...audio, diagnostics: backend.integration.diagnostics().audio, fixtureSessions: session.sessions.map(({ state, mute, volume, peak }) => ({ state, mute, volume, peak })) };
  report.checks.realStereoLoopback = true; report.checks.readOnlyFixtureSessionQuery = true;
  report.media = { ready: backend.integration.diagnostics().media.ready, callbacks: await evaluate('proof.mediaCalls'), userMetadataRecorded: false };
  report.processMutedAtCreation = backend.child.spawnargs.includes('--mute-audio'); assert.equal(report.processMutedAtCreation, true);
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.message; throw error; }
finally {
  if (player && player.exitCode === null) player.kill();
  await backend.stop(); report.stoppedAt = new Date().toISOString(); report.cleanup = { browserStopped: !backend.child, integrationStopped: !backend.integration };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks: report.checks, evidence: path.join(evidence, 'result.json'), error: report.error }));
}
