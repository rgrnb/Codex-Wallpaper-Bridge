import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { Presentation } from '../src/presentation.mjs';
import { WebBackend } from '../src/web-backend.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { DEFAULTS, PROFILES } from '../src/config.mjs';
import { verifyLiveTypes } from './live-type-acceptance.mjs';
import { measureBaseline, verifyPerformance } from './performance-acceptance.mjs';

const before = await nativeProbe(), adapter = JSON.parse(await readFile(path.join(ROOT, 'config', 'adapter.json'), 'utf8'));
assert.ok(before.codexInstall);
const requestedCount = Number(process.argv.find(arg => arg.startsWith('--windows='))?.split('=')[1] || (process.argv.includes('--single') ? 1 : 2));
assert.ok([1, 2, 4].includes(requestedCount));
const ports = Array.from({ length: requestedCount }, (_, index) => 19336 + index * 2);
assert.ok(before.codex.every(app => app.endpoints.every(port => !ports.includes(port))));
const evidence = path.join(ROOT, '.local-evidence', `codex-acceptance-${randomBytes(8).toString('hex')}`); await mkdir(evidence);
const observer = new WallpaperEngine({ username: os.userInfo().username }), browser = new WebBackend();
const presentation = new Presentation(adapter, { async event() {} });
const children = [], checks = [], delay = ms => new Promise(r => setTimeout(r, ms));
const windowRestores = [];
let geometryHelper;
const report = { actualCodex: true, currentChatAccessed: false, existingCodexStopped: false,
  completePrdAccepted: false, versions: [], windows: 0 };
const structural = `({root:!!document.querySelector(${JSON.stringify(adapter.selectors.root)}),
  main:!!document.querySelector(${JSON.stringify(adapter.selectors.main)}),
  sidebar:!!document.querySelector(${JSON.stringify(adapter.selectors.sidebar)}),
  composer:!!document.querySelector(${JSON.stringify(adapter.selectors.composer)})})`;
const layout = `(() => Object.fromEntries(Object.entries(${JSON.stringify(adapter.selectors)}).map(([key,selector]) => {
  const node=document.querySelector(selector);if(!node)return [key,null];const s=getComputedStyle(node),r=node.getBoundingClientRect();
  return [key,[s.fontFamily,s.fontSize,s.fontWeight,s.display,s.position,...[r.x,r.y,r.width,r.height].map(v=>Math.round(v))]];
})))()`;
let originalSource;
try {
  originalSource = (await observer.observeDesktop(before.wallpaperEngine, { monitor: 0 })).source;
  assert.equal(originalSource.type, 'video', 'This acceptance slice requires the current Video source.');
  const endpoints = [];
  for (let index = 0; index < ports.length; index++) {
    const port = ports[index], profile = path.join(evidence, `profile-${port}`); await mkdir(profile);
    const child = spawn(before.codexInstall, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
      { windowsHide: true, stdio: 'ignore' }); children.push(child);
    const deadline = Date.now() + 45000;
    let check;
    while (Date.now() < deadline && child.exitCode === null) {
      const app = (await nativeProbe()).codex.find(app => app.pid === child.pid && app.endpoints.includes(port));
      if (app) {
        const targets = await listTargets(port);
        for (const target of targets) {
          const client = await new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect();
          const structure = await client.evaluate(structural);
          report.lastStructure = structure;
          if (!Object.values(structure).every(Boolean)) report.adapterStructure = await client.evaluate(`({
            mainClass:document.querySelector('main')?.className,
            composerClass:document.querySelector('.composer-surface-chrome,[class*="_ComposerLayoutRoot_"],[data-composer-surface-variant]')?.className,
            composerAttributeNames:document.querySelector('.composer-surface-chrome,[class*="_ComposerLayoutRoot_"],[data-composer-surface-variant]')?.getAttributeNames()
          })`);
          if (Object.values(structure).every(Boolean)) { check = { client, version: app.version }; break; }
          client.close();
        }
        if (check) break;
      }
      await delay(400);
    }
    assert.ok(check, 'Actual Codex shell must finish loading with all required regions.'); checks.push(check);
    await check.client.evaluate('document.fonts.ready.then(() => true)');
    endpoints.push({ port, version: check.version }); report.versions.push(check.version);
  }
  // Fully occluded Electron windows can report hidden and should pause. Arrange
  // the owned test windows side by side before testing visible-window delivery.
  report.phase = 'arrange-owned-windows';
  geometryHelper = path.join(evidence, 'CodexWindowProbe.exe');
  await runFile(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64',
    `/out:${geometryHelper}`, path.join(ROOT, 'scripts', 'experiments', 'CodexWindowProbe.cs')], { windowsHide: true, timeout: 15000 });
  const screen = await checks[0].client.evaluate('({width:screen.availWidth*devicePixelRatio,height:screen.availHeight*devicePixelRatio})');
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index], width = Math.floor((screen.width - 30) / checks.length) - 10;
    assert.ok(!before.codex.some(app => app.pid === children[index].pid));
    await runFile(geometryHelper, [String(children[index].pid), String(10 + index * (width + 10)), '40', String(width), String(Math.min(1050, Math.round(screen.height - 80)))],
      { windowsHide: true, timeout: 5000 });
    // Establish a stable baseline after initial header and resize animations.
    let previous, stable = 0;
    for (let n = 0; n < 30 && stable < 4; n++) {
      check.baseline = await check.client.evaluate(layout);
      const signature = JSON.stringify(check.baseline); stable = signature === previous ? stable + 1 : 0; previous = signature;
      await delay(500);
    }
    assert.equal(stable, 4);
  }
  // The second native window can change startup/DPI layout in the first. Take
  // the comparison baseline only after the whole arranged group has settled.
  let groupSignature, groupStable = 0;
  for (let n = 0; n < 40 && groupStable < 6; n++) {
    const layouts = await Promise.all(checks.map(check => check.client.evaluate(layout)));
    const signature = JSON.stringify(layouts); groupStable = signature === groupSignature ? groupStable + 1 : 0; groupSignature = signature;
    layouts.forEach((value, index) => { checks[index].baseline = value; }); await delay(500);
  }
  assert.equal(groupStable, 6);
  const policy = { ...PROFILES.balanced, paused: false }, options = { effects: DEFAULTS.effects, policy };
  if (process.argv.includes('--performance')) report.baseline = await measureBaseline(children);
  for (let n=0;n<children.length;n++) {
    await runFile(geometryHelper, [String(children[n].pid), '--visible'], { windowsHide: true, timeout: 5000 });
    await checks[n].client.call('Page.bringToFront');
  }
  await delay(1000);
  report.phase = 'present-native-video';
  await presentation.configure(options); await presentation.reconcile(endpoints, endpoints[0].version, true);
  report.windows = presentation.windows.size; assert.equal(report.windows, ports.length);
  await presentation.invalidate(1);
  for (const check of checks) await check.client.evaluate(`(() => {window.__cwbFileEventProbe={count:0};
    const handler=e=>{if(e.target?.type==='file')window.__cwbFileEventProbe.count++;};window.__cwbFileEventProbe.handler=handler;
    document.addEventListener('input',handler,true);document.addEventListener('change',handler,true);return true;})()`);
  const visibleDeadline=Date.now()+20000;
  while(Date.now()<visibleDeadline) {
    await presentation.heartbeat(); await presentation.video(originalSource, 1, () => true);
    if([...presentation.windows.values()].every(window=>window.generation===1))break;
    await delay(500);
  }
  assert.ok([...presentation.windows.values()].every(window=>window.generation===1), 'Owned test windows must become visible before media acceptance.');
  for (const check of checks) assert.equal(await check.client.evaluate(`(() => {const probe=window.__cwbFileEventProbe;
    document.removeEventListener('input',probe.handler,true);document.removeEventListener('change',probe.handler,true);
    delete window.__cwbFileEventProbe;return probe.count;})()`), 0, 'No file selection event may escape into the app document.');
  report.nativeFileInputEventsEscaped = false;
  report.frameTransport = 'native-file-original-codec'; report.fullFileTransferred = false;
  const hashes = ports.map(() => new Set());
  for (let index = 0; index < 12; index++) {
    await presentation.heartbeat();
    await delay(350);
    for (let n = 0; n < checks.length; n++) {
      const value = await checks[n].client.evaluate(`(() => {
        const c=document.querySelector('canvas[data-cwb-owned="v1"]');if(!c)return null;
        const sample=new OffscreenCanvas(64,36),ctx=sample.getContext('2d');ctx.drawImage(c,0,0,64,36);
        const p=ctx.getImageData(0,0,64,36).data;let h=2166136261;
        for(let i=0;i<p.length;i++)h=Math.imul(h^p[i],16777619);return h>>>0;
      })()`); assert.notEqual(value, null); hashes[n].add(value);
    }
  }
  report.canvasFrameChanges = hashes.map(set => set.size);
  report.playback = await Promise.all(checks.map(check => check.client.evaluate('window.__codexWallpaperBridgeV1.ping()')));
  assert.ok(hashes.every(set => set.size > 1)); report.changingFramesInBothWindows = true;
  for (const check of checks) {
    assert.deepEqual(await check.client.evaluate(layout), check.baseline, 'Foreground font/layout must remain unchanged.');
    assert.deepEqual(await check.client.evaluate(`(() => {
      const c=document.querySelector('canvas[data-cwb-owned="v1"]'),r=c.getBoundingClientRect();
      const transparent=['main','sidebar','composer'].every(k=>getComputedStyle(document.querySelector(${JSON.stringify(adapter.selectors)}[k])).backgroundColor==='rgba(0, 0, 0, 0)');
      return {oneCanvas:document.querySelectorAll('canvas[data-cwb-owned="v1"]').length===1,
        continuous:Math.abs(r.x)<1&&Math.abs(r.y)<1&&Math.abs(r.width-innerWidth)<=1&&Math.abs(r.height-innerHeight)<=1,
        inputTransparent:getComputedStyle(c).pointerEvents==='none',transparent};
    })()`), { oneCanvas: true, continuous: true, inputTransparent: true, transparent: true });
    await check.client.evaluate(`(() => {
      window.__cwbSmokeFocus=document.activeElement;
      const input=document.createElement('input');input.id='cwb-acceptance-input';input.dataset.cwbSmoke='true';
      input.style.cssText='position:fixed;left:30px;top:130px;z-index:2147483647;width:160px;height:30px';
      document.body.append(input);input.focus();return document.activeElement===input;
    })()`);
    assert.equal(await check.client.evaluate("document.activeElement?.id==='cwb-acceptance-input'"), true);
    await check.client.call('Input.insertText', { text: 'Bridge test input' });
    assert.equal(await check.client.evaluate("document.querySelector('#cwb-acceptance-input').value==='Bridge test input'"), true);
    await check.client.evaluate("document.querySelector('#cwb-acceptance-input').remove();window.__cwbSmokeFocus?.focus();delete window.__cwbSmokeFocus;true");
  }
  report.coverageAndForegroundLayout = true; report.authoredInputInteraction = true;
  if (process.argv.includes('--performance')) {
    const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.split('=')[1] || 120);
    assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600);
    report.phase = 'performance-and-endurance';
    await verifyPerformance({ checks, children, presentation, options, report, seconds,
      focusTestWindow: async () => { await runFile(geometryHelper, [String(children.at(-1).pid), '--visible'], { windowsHide: true, timeout: 5000 }); },
      minimizeTestWindow: async () => { await runFile(geometryHelper, [String(children[0].pid), '--minimize'], { windowsHide: true, timeout: 5000 }); },
      resumeTestWindow: async () => { await runFile(geometryHelper, [String(children[0].pid), '--visible'], { windowsHide: true, timeout: 5000 }); } });
    await writeFile(path.join(evidence, 'performance.json'), JSON.stringify(report.performance, null, 2));
  }
  await presentation.configure({ ...options, effects: { opacity: 0.52, blur: 3, brightness: 1.1, contrast: 1.2 } });
  for (const check of checks) assert.equal(await check.client.evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');
    return c.style.opacity==='0.52'&&c.style.filter==='blur(3px) brightness(1.1) contrast(1.2)';})()`), true);
  report.effects = true;
  await presentation.restore();
  for (const check of checks) {
    assert.equal(await check.client.evaluate("document.querySelectorAll('[data-cwb-owned]').length"), 0);
    assert.deepEqual(await check.client.evaluate(layout), check.baseline);
  }
  report.restore = true;
  if (process.argv.includes('--types')) {
    await browser.stop();
    for (const app of before.codex.filter(app => !app.endpoints.length)) {
      const { stdout } = await runFile(geometryHelper, [String(app.pid), '--state'], { windowsHide: true, timeout: 5000 });
      const state = JSON.parse(stdout); if (![1,3,9].includes(state.show)) continue;
      windowRestores.push(state); await writeFile(path.join(evidence, 'window-restore.json'), JSON.stringify(windowRestores));
      await runFile(geometryHelper, [String(app.pid), '--minimize'], { windowsHide: true, timeout: 5000 });
    }
    await verifyLiveTypes({ presentation, clients: checks.map(check => check.client), ports, root: evidence, report,
      focusTestWindow: async () => {
        await runFile(geometryHelper, [String(children.at(-1).pid), '--visible'], { windowsHide: true, timeout: 5000 });
        await checks.at(-1).client.call('Page.bringToFront');
      } });
  }
  // Closing one real test instance must leave the other attached and active.
  if (children.length > 1) {
    for (const child of children) await runFile(geometryHelper, [String(child.pid), '--visible'], { windowsHide: true, timeout: 5000 });
    await presentation.configure(options); await presentation.reconcile(endpoints, endpoints[0].version, true);
    await presentation.invalidate(100); await presentation.video(originalSource, 100, () => true);
    const retained = [...presentation.windows.values()].at(-1);
    await runFile('taskkill.exe', ['/PID', String(children[0].pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); await delay(500);
    await presentation.configure(options);
    await presentation.heartbeat();
    await presentation.reconcile(endpoints.slice(1), endpoints[1].version, true);
    assert.equal(presentation.windows.size, children.length - 1); assert.equal(retained.generation, 100);
    assert.ok([...presentation.windows.values()].includes(retained));
    await presentation.restore(); report.independentWindowClose = true; report.remainingWindowGenerationPreserved = true;
  }
  const after = (await observer.observeDesktop(before.wallpaperEngine, { monitor: 0 })).source;
  assert.equal(after.fingerprint, originalSource.fingerprint); report.wallpaperStateUnchanged = true;
  for (const app of before.codex) process.kill(app.pid, 0);
} finally {
  await presentation.restore().catch(() => {}); await browser.stop(); observer.close();
  for (const check of checks) {
    await check.client.evaluate("document.querySelectorAll('[data-cwb-smoke]').forEach(n=>n.remove());window.__cwbSmokeFocus?.focus();delete window.__cwbSmokeFocus;true").catch(() => {});
    await check.client.evaluate("if(window.__cwbFileEventProbe){document.removeEventListener('input',window.__cwbFileEventProbe.handler,true);document.removeEventListener('change',window.__cwbFileEventProbe.handler,true);delete window.__cwbFileEventProbe;}true").catch(()=>{});
    check.client.close();
  }
  for (const child of children) if (child.exitCode === null) await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true, timeout: 10000 }).catch(() => child.kill());
  const measuredProcesses=new Map((report.performance?.samples||[]).flatMap(sample=>sample.processTree.counters||[])
    .map(counter=>[`${counter.pid}:${counter.identity}`,{pid:counter.pid,identity:counter.identity}]));
  if(measuredProcesses.size) {
    const rows=JSON.stringify([...measuredProcesses.values()]);
    assert.ok([...measuredProcesses.values()].every(row=>Number.isInteger(row.pid)&&/^\d+$/.test(row.identity)));
    const audit=`$rows=ConvertFrom-Json '${rows}';$left=@(foreach($row in $rows){try{$p=[Diagnostics.Process]::GetProcessById($row.pid);if($p.StartTime.ToUniversalTime().Ticks.ToString()-eq $row.identity){[PSCustomObject]@{pid=$p.Id;identity=$row.identity;name=$p.ProcessName}}}catch{}});ConvertTo-Json -InputObject $left -Compress`;
    const cleanupStarted=Date.now();
    do {
      await delay(250);
      const result=await runFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(audit,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});
      report.measuredChildrenRemaining=JSON.parse(result.stdout);
    } while(report.measuredChildrenRemaining.length&&Date.now()-cleanupStarted<15000);
    report.childCleanupMs=Date.now()-cleanupStarted;
  }
  for (const state of windowRestores) await runFile(geometryHelper, [String(state.pid), '--restore', String(state.show), state.hwnd, state.started],
    { windowsHide: true, timeout: 5000 });
  if (windowRestores.length) { report.originalWindowsRestored = true; await writeFile(path.join(evidence, 'window-restore.json'), '[]'); }
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  const compactTree=tree=>tree?{...tree,...(tree.counters?{counters:`${tree.counters.length} process records saved privately`}:{})}:tree;
  console.log(JSON.stringify({ ...report, baseline:compactTree(report.baseline), ...(report.performance ? { performance: { ...report.performance,
    modes:report.performance.modes.map(mode=>({...mode,processTree:compactTree(mode.processTree)})),samples: `${report.performance.samples.length} samples saved privately` } } : {}) }));
  if(report.measuredChildrenRemaining)assert.equal(report.measuredChildrenRemaining.length,0,'Measured test child resources must close within the bounded shutdown period.');
}
