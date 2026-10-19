import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, HOST, nativeProbe, runFile, NativeFrames } from '../src/platform.mjs';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { Presentation } from '../src/presentation.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { SettingsStore } from '../src/config.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { IsolatedPlayer } from '../src/isolated-player.mjs';

// Short actual-Codex failure acceptance. Only a fresh empty profile and the
// exact target/port launched here are accessed. No existing chats or inputs.
const evidence = path.join(ROOT, '.local-evidence', `closeout-ui-${randomBytes(8).toString('hex')}`);
await mkdir(evidence);
const port = 19360, before = await nativeProbe(), workers = new Set(), runtimes = new Set();
const report = { started: new Date().toISOString(), actualCodex: true, cases: [], events: [], success: false, existingChatAccessed: false, messagesSent: false };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const settingsFile = path.join(process.env.LOCALAPPDATA, 'CodexWallpaperBridge/settings.json');
const userSettings = await readFile(settingsFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const desktopFile = path.join(path.dirname(before.wallpaperEngine.path), 'config.json');
const desktop = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v?.general?.wallpaperconfig).map(([key, v]) => [key,
  { selected: v.general.wallpaperconfig.selectedwallpapers, audio: v.general.videoaudiooutput, properties: v.wproperties }]));
const desktopBefore = desktop(JSON.parse(await readFile(desktopFile, 'utf8')));
const adapter = JSON.parse(await readFile(path.join(ROOT, 'config/adapter.json'), 'utf8'));
const helper = path.join(evidence, 'CodexWindowProbe.exe'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, stamp, client, coordinator, targetId, frames = 0;
const log = { async event(level, module, code, data) { report.events.push({ level, module, code, ...data }); }, async failure() {} };
const presentation = new Presentation(adapter, log, { discover: async requested => {
  assert.equal(requested, port); return (await listTargets(port)).filter(target => target.id === targetId);
} });
const player = new IsolatedPlayer({ executable: before.wallpaperEngine.path,
  launch: (...args) => { const worker = spawn(...args); workers.add(worker); return worker; },
});
const stage = player.stage;
player.stage = async (...args) => { const runtime = await stage(...args); runtimes.add(runtime.root); return runtime; };
const presentFrame = presentation.frame.bind(presentation);
presentation.frame = async (...args) => { await presentFrame(...args); frames++; };
const structural = `({root:!!document.querySelector(${JSON.stringify(adapter.selectors.root)}),main:!!document.querySelector(${JSON.stringify(adapter.selectors.main)}),composer:!!document.querySelector(${JSON.stringify(adapter.selectors.composer)})})`;
const appearance = `(() => ({nodes:Object.fromEntries(Object.entries(${JSON.stringify(adapter.selectors)}).map(([key,selector])=>[key,[...document.querySelectorAll(selector)].map(node=>{const s=getComputedStyle(node);return {style:node.getAttribute('style'),...(s.opacity==='0'?{}:{background:s.backgroundColor,image:s.backgroundImage,color:s.color,font:s.font}),pointer:s.pointerEvents,opacity:s.opacity}})])),bodyStyle:document.body.getAttribute('style'),htmlStyle:document.documentElement.getAttribute('style')}))()`;
let baseline;
async function pump(predicate, seconds = 35) {
  const deadline = Date.now() + seconds * 1000;
  do { await coordinator.tick(); if (predicate()) return; await delay(20); } while (Date.now() < deadline);
  throw new Error(`CLOSEOUT_STATE_TIMEOUT:${coordinator.state}:${coordinator.code}`);
}
async function screenshot(name) {
  const image = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(image.data, 'base64'));
}
async function inputCheck() {
  assert.equal(await client.evaluate(`(() => {const f=document.querySelector(${JSON.stringify(adapter.selectors.composer)})?.querySelector('[contenteditable="true"],textarea');if(!f)return 'unavailable';if(f.value||f.textContent)return 'nonempty';f.focus();return 'empty'})()`), 'empty');
  const marker = `cwb-closeout-${randomBytes(4).toString('hex')}`;
  await client.call('Input.insertText', { text: marker });
  assert.equal(await client.evaluate(`(() => {const f=document.activeElement;return (f.value||f.textContent)===${JSON.stringify(marker)}})()`), true);
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  assert.equal(await client.evaluate(`(() => {const f=document.activeElement;return !(f.value||f.textContent)})()`), true);
}
async function restored(name) {
  await delay(150);
  const owned = await client.evaluate(`({canvas:document.querySelectorAll('[data-cwb-owned]').length,runtime:!!window.__codexWallpaperBridgeV1})`);
  await screenshot(name);
  assert.deepEqual(owned, { canvas: 0, runtime: false });
  assert.deepEqual(await client.evaluate(appearance), baseline);
  assert.ok(Object.values(await client.evaluate(structural)).every(Boolean));
  await inputCheck(); await screenshot(name);
  report.cases.push({ name, passed: true, originalStylesRestored: true, ownedNodes: 0, inputInsertAndClear: true, screenshot: `${name}.png`, state: coordinator.state });
}
async function activate() {
  await coordinator.applySettings({ ...coordinator.store.value, enabled: true });
  coordinator.lastHeartbeat = 0; const previous = frames;
  await pump(() => coordinator.state === 'Active' && frames >= previous + 2);
  assert.equal(await client.evaluate(`document.querySelectorAll('canvas[data-cwb-owned="v1"]').length`), 1);
  let colored = false;
  for (const deadline = Date.now() + 15000; !colored && Date.now() < deadline;) {
    await coordinator.tick(); await delay(50);
    colored = await client.evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');if(!c)return false;const s=new OffscreenCanvas(8,8),ctx=s.getContext('2d');ctx.drawImage(c,0,0,8,8);const p=ctx.getImageData(0,0,8,8).data;for(let i=0;i<p.length;i+=4)if(p[i]+p[i+1]+p[i+2]>80)return true;return false})()`);
  }
  assert.equal(colored, true, 'The authored source must have visible nonblack content before a failure is injected.');
}
try {
  assert.ok(before.codexInstall && before.wallpaperEngine?.running);
  assert.ok(!before.codex.some(app => app.endpoints.includes(port)));
  // A live all-window controller could also attach to this test's empty shell.
  await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if(Get-Process -Name CodexWallpaperBridge -ErrorAction SilentlyContinue){exit 9}"], { windowsHide: true, timeout: 5000 });
  await runFile(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, path.join(ROOT, 'scripts/experiments/CodexWindowProbe.cs')], { windowsHide: true, timeout: 15000 });
  report.desktop = JSON.parse((await runFile(helper, ['--desktop-state'], { windowsHide: true, timeout: 5000 })).stdout);
  assert.ok(report.desktop.interactiveDesktopAvailable);
  const profile = path.join(evidence, 'empty-profile'); await mkdir(profile);
  child = spawn(before.codexInstall, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { windowsHide: true, stdio: 'ignore' });
  for (const deadline = Date.now() + 45000; !client && Date.now() < deadline;) {
    if (!stamp) try { stamp = JSON.parse((await runFile(helper, [String(child.pid), '--owned-stamp'], { windowsHide: true, timeout: 5000 })).stdout); } catch {}
    const app = (await nativeProbe()).codex.find(app => app.pid === child.pid && app.endpoints.includes(port));
    if (app && stamp) {
      report.codexVersion = app.version;
      const native = JSON.parse((await runFile(helper, [String(child.pid), '--owned-windows', stamp.started], { windowsHide: true, timeout: 5000 })).stdout);
      for (const window of native.windows) await runFile(helper, [String(child.pid), '--owned-window', window.hwnd, stamp.started, '--visible'], { windowsHide: true, timeout: 5000 });
      for (const target of await listTargets(port)) {
        const candidate = await new CdpClient(target.webSocketDebuggerUrl).connect();
        if (Object.values(await candidate.evaluate(structural)).every(Boolean) && await candidate.evaluate('!document.hidden')) { client = candidate; targetId = target.id; break; }
        candidate.close();
      }
    }
    if (!client) await delay(250);
  }
  assert.ok(client && stamp, 'OWNED_EMPTY_CODEX_REQUIRED');
  await delay(2000); baseline = await client.evaluate(appearance);
  await writeFile(path.join(evidence, 'appearance-before.json'), JSON.stringify(baseline, null, 2));
  await screenshot('before');
  const projectRoot = path.join(evidence, 'authored-web'); await mkdir(projectRoot);
  const project = path.join(projectRoot, 'project.json'), resource = path.join(projectRoot, 'index.html');
  await writeFile(project, JSON.stringify({ title: 'Bridge owned failure fixture', type: 'web', file: 'index.html' }));
  await writeFile(resource, '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#186f91}div{width:40vw;height:60vh;background:#eaaf45;animation:move 2s infinite alternate}@keyframes move{to{transform:translateX(50vw)}}</style><div></div>');
  const store = new SettingsStore(path.join(evidence, 'service-data')); await store.load();
  await store.save({ ...store.value, selectedWallpaper: project });
  coordinator = new Coordinator({ settings: store, wallpaper: new WallpaperEngine(), presentation, player, frames: new NativeFrames(), log,
    probe: async () => ({ ...before, codex: [{ pid: child.pid, version: report.codexVersion, endpoints: [port] }] }) });
  await activate(); await screenshot('active');
  await rename(resource, `${resource}.unavailable`);
  await pump(() => coordinator.state === 'Recovering'); await restored('missing-material');
  await rename(`${resource}.unavailable`, resource);
  await coordinator.restore();
  player.host = path.join(evidence, 'nonexistent-owned-host.exe');
  await coordinator.applySettings({ ...store.value, enabled: true }); coordinator.lastHeartbeat = 0;
  await pump(() => coordinator.state === 'Recovering'); await restored('player-start-failure');
  await coordinator.restore(); player.host = HOST;
  await activate(); assert.ok(player.worker?.pid);
  const crashed = player.worker; crashed.kill();
  while (crashed.exitCode === null && crashed.signalCode == null) await delay(20);
  await pump(() => coordinator.state === 'Recovering'); await restored('player-crash');
  await coordinator.restore(); await activate(); await coordinator.restore(); await restored('user-stop');
  await activate(); await coordinator.stop(); await restored('bridge-exit');
  report.reenabledAfterFailureAndStop = true;
  report.success = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  try { await coordinator?.stop(); } catch (error) { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; }
  client?.close();
  if (child && stamp) {
    report.ownedCodexCleanup = JSON.parse((await runFile(helper, [String(child.pid), '--owned-terminate-tree', stamp.nativeStarted, stamp.nativeExecutable], { windowsHide: true, timeout: 15000 })).stdout);
  }
  const after = await nativeProbe();
  report.userProcessesRetained = before.codex.every(app => after.codex.some(current => current.pid === app.pid)) && before.wallpaperEngine.pid === after.wallpaperEngine?.pid;
  const settingsAfter = await readFile(settingsFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  report.userSettingsUnchanged = userSettings === null ? settingsAfter === null : settingsAfter !== null && digest(userSettings) === digest(settingsAfter);
  report.desktopUnchanged = JSON.stringify(desktopBefore) === JSON.stringify(desktop(JSON.parse(await readFile(desktopFile, 'utf8'))));
  report.remainingWorkers = [...workers].filter(worker => worker.exitCode === null && worker.signalCode == null).map(worker => worker.pid);
  report.remainingRuntimes = [];
  for (const root of runtimes) if (await access(root).then(() => true, () => false)) report.remainingRuntimes.push(root);
  if (!report.userProcessesRetained || !report.userSettingsUnchanged || !report.desktopUnchanged || report.remainingWorkers.length || report.remainingRuntimes.length) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, cases: report.cases.map(row => row.name), failure: report.failure, cleanupFailure: report.cleanupFailure }));
}
