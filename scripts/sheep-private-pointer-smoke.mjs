import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { IndependentApplicationPlayer, PowerShellApplicationAdapter } from '../src/independent-application.mjs';
import { applicationTree } from '../src/silent-unity-application.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const engine = (await nativeProbe()).wallpaperEngine;
assert.ok(engine?.running);
const source = await describeSource(path.join(path.dirname(engine.path), 'projects/defaultprojects/sheep/project.json'));
const originalTree = await applicationTree(source.root), config = path.join(path.dirname(engine.path), 'config.json');
const configHash = digest(await readFile(config));
const evidence = path.join(ROOT, '.local-evidence', `sheep-private-pointer-${randomUUID()}`);
await mkdir(evidence);
const report = { started: new Date().toISOString(), success: false, frames: [], pointers: [],
  scope: 'Reviewed PE i386 Sheep; actual hidden owned window, dedicated pointer polling helper. Observe visible sheep after spawn-stone clicks. Source tree and original desktop configuration must stay unchanged.' };
const adapter = new PowerShellApplicationAdapter(), originalPointer = adapter.pointer.bind(adapter);
if(process.env.BRIDGE_APP_WM_ONLY==='1'){const originalStart=adapter.start.bind(adapter);adapter.start=specification=>{const copy={...specification};delete copy.reviewedPointer;return originalStart(copy);};report.inputMode='diagnostic-window-messages-only';}
adapter.pointer = async (...args) => { const result = await originalPointer(...args); report.pointers.push(result); return result; };
const originalCapture=adapter.capture.bind(adapter);let initialCapture=0;
adapter.capture=async (...args)=>{const result=await originalCapture(...args);if(initialCapture++<3){await writeFile(path.join(evidence,`loading-${initialCapture}.jpg`),Buffer.from(result.jpeg,'base64'));(report.loadingFrames??=[]).push({...result,jpeg:undefined});}
  if(process.env.BRIDGE_APP_DPI_PROBE&&initialCapture===15){const identity=player.session;report.dpiProbe=JSON.parse((await runFile(process.env.BRIDGE_APP_DPI_PROBE,[String(identity.pid),identity.startTime,identity.executable,identity.session,player.surface.hwnd,path.join(evidence,'dpi-probe')],{windowsHide:true,timeout:10000})).stdout);}return result;};
const player = new IndependentApplicationPlayer({ adapter }), policy = { maxWidth: 640, height: 360, jpegQuality: 95 };
const python = process.env.BRIDGE_PYTHON || 'python';
const desktopProbe=path.join(evidence,'DesktopProbe.exe'),inputProbe=path.join(evidence,'ApplicationInputProbe.exe');
let runtime;
async function sample(phase) {
  const frame = await player.capture(source, policy), file = path.join(evidence, `${String(report.frames.length).padStart(2, '0')}-${phase}.jpg`);
  await writeFile(file, Buffer.from(frame.jpeg, 'base64'));
  const script = `from PIL import Image
import sys,json
im=Image.open(sys.argv[1]).convert('RGB');w,h=im.size
pixels=im.crop((int(w*.2),int(h*.45),int(w*.8),int(h*.9))).getdata()
print(json.dumps({'whitePasturePixels':sum(1 for r,g,b in pixels if min(r,g,b)>205 and max(r,g,b)-min(r,g,b)<45),'width':w,'height':h}))`;
  const pixels = JSON.parse((await runFile(python, ['-c', script, file], { windowsHide: true, timeout: 10000 })).stdout);
  const row = { phase, file: path.basename(file), sha256: digest(Buffer.from(frame.jpeg, 'base64')), ...pixels };
  report.frames.push(row); return row;
}
try {
  const compiler=path.win32.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  await runFile(compiler,['/nologo','/target:exe','/platform:x64',`/out:${desktopProbe}`,path.join(ROOT,'scripts/experiments/CodexWindowProbe.cs')],{windowsHide:true,timeout:20000});
  report.desktop=JSON.parse((await runFile(desktopProbe,['--desktop-state'],{windowsHide:true,timeout:5000})).stdout);
  assert.equal(report.desktop.interactiveDesktopAvailable,true,'Ordinary interactive desktop required before launching Sheep; use the authorized independent-environment wrapper for a screen-saver desktop.');
  await runFile(compiler,['/nologo','/target:exe','/platform:x86','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',`/out:${inputProbe}`,path.join(ROOT,'scripts/experiments/ApplicationDpiCaptureProbe.cs')],{windowsHide:true,timeout:20000});
  async function inputState(){return JSON.parse((await runFile(inputProbe,['--input-state'],{windowsHide:true,timeout:5000})).stdout);}
  await player.start(source, { policy }); runtime = player.runtime;
  report.surface = player.surface; report.identity = player.session;
  for (let index = 0; index < 3; index++) { await sample('before'); await pause(200); }
  for (let index = 0; index < 5; index++) {
    const before=await inputState();
    assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.71 }), true);
    const after=await inputState();(report.physicalInput??=[]).push({before,after});
    assert.deepEqual(after,before,'Forwarded private input must preserve the physical cursor and foreground window.');
    await pause(300); await sample('after');
  }
  const before = Math.max(...report.frames.filter(row => row.phase === 'before').map(row => row.whitePasturePixels));
  const after = Math.max(...report.frames.filter(row => row.phase === 'after').map(row => row.whitePasturePixels));
  report.spawnObservation = { beforeMaximum: before, afterMaximum: after, addedWhitePixels: after - before };
  assert.ok(after - before >= 120, 'Private polling must visibly spawn sheep; queued input alone is insufficient.');
  report.success = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  try { await player.stop(); report.cleaned = true; }
  catch (error) { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; }
  report.runtimeRemoved = !runtime || await stat(runtime.root).then(() => false, error => error.code === 'ENOENT');
  report.sourceUnchanged = (await applicationTree(source.root)).hash === originalTree.hash;
  report.originalConfigUnchanged = digest(await readFile(config)) === configHash;
  if (!report.runtimeRemoved || !report.sourceUnchanged || !report.originalConfigUnchanged) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, failure: report.failure?.message, observation: report.spawnObservation,
    pointers: report.pointers, cleaned: report.cleaned, sourceUnchanged: report.sourceUnchanged, originalConfigUnchanged: report.originalConfigUnchanged }));
}
