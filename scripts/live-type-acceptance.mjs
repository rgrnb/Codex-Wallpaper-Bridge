import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, nativeProbe, NativeFrames, runFile } from '../src/platform.mjs';
import { SettingsStore } from '../src/config.mjs';
import { Diagnostics } from '../src/diagnostics.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { WebBackend } from '../src/web-backend.mjs';
import { Coordinator } from '../src/coordinator.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const signature = `(() => {const c=document.querySelector('canvas[data-cwb-owned="v1"]');if(!c)return null;
  const sample=new OffscreenCanvas(64,36),ctx=sample.getContext('2d');ctx.drawImage(c,0,0,64,36);
  const p=ctx.getImageData(0,0,64,36).data;let h=2166136261;
  for(let i=0;i<p.length;i++)h=Math.imul(h^p[i],16777619);return h>>>0;})()`;

export async function verifyLiveTypes({ presentation, clients, ports, root, report, focusTestWindow }) {
  const initial = await nativeProbe(), observer = new WallpaperEngine({ username: os.userInfo().username });
  const previous = (await observer.observeDesktop(initial.wallpaperEngine, { monitor: 0 })).source; observer.close();
  const executable = initial.wallpaperEngine.path;
  const command = args => runFile(executable, args.map(quote), { windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 });
  const appRoot = path.join(root, 'application-fixture'); await mkdir(appRoot);
  const fixture = path.join(appRoot, 'BridgeApplicationFixture.exe');
  await runFile(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64',
    `/out:${fixture}`, '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', path.join(ROOT, 'scripts', 'experiments', 'ApplicationFixture.cs')],
    { windowsHide: true, timeout: 15000 });
  const appProject = path.join(appRoot, 'project.json');
  await writeFile(appProject, JSON.stringify({ type: 'application', file: path.basename(fixture), title: 'Bridge authored acceptance fixture' }));
  const store = new SettingsStore(path.join(root, 'service-data')); await store.load();
  await store.save({ ...store.value, enabled: true, allowCandidateAdapter: true, performance: 'balanced' });
  const coordinator = new Coordinator({ settings: store, presentation, wallpaper: new WallpaperEngine({ username: os.userInfo().username }),
    frames: new NativeFrames(), web: new WebBackend(), log: new Diagnostics(path.join(root, 'service-data')),
    capabilities: JSON.parse(await readFile(path.join(ROOT, 'config', 'wallpaper-engine.json'), 'utf8')),
    probe: async () => { const apps = await nativeProbe(); return { ...apps,
      codex: apps.codex.filter(app => app.endpoints?.some(port => ports.includes(port))) }; } });
  const timer = setInterval(() => void coordinator.tick(), 50), results = report.fourTypeResults = [];
  try {
    for (const [type, project] of [
      ['video', null], ['web', path.join(ROOT, 'scripts', 'experiments', 'fixtures', 'web', 'project.json')],
      ['scene', path.join(path.dirname(executable), 'projects', 'defaultprojects', 'shimmering_particles', 'project.json')], ['application', appProject],
    ]) {
      report.phase = `live-current-${type}`;
      if (project) await command(['-control', 'openWallpaper', '-file', project, '-monitor', '0']);
      await focusTestWindow();
      const end = Date.now() + 45000;
      while (Date.now() < end && !(coordinator.source?.type === type && coordinator.state === 'Active' &&
        presentation.windows.size === clients.length && [...presentation.windows.values()].every(w => w.generation === coordinator.generation))) await delay(100);
      assert.equal(coordinator.source?.type, type);
      assert.equal(coordinator.state, 'Active', `${type}: ${coordinator.code}`);
      const hashes = clients.map(() => new Set());
      for (let n = 0; n < 12; n++) {
        for (let index = 0; index < clients.length; index++) {
          const value = await clients[index].evaluate(signature); assert.notEqual(value, null); hashes[index].add(value);
        }
        await delay(300);
      }
      assert.ok(hashes.every(set => set.size > 1), `${type} must change in every actual Codex window.`);
      results.push({ type, state: coordinator.state, backend: coordinator.code, generation: coordinator.generation,
        windows: presentation.windows.size, changingFrameCounts: hashes.map(set => set.size) });
    }
    // A fresh source change must recover to the original video without restarting.
    await command(['-control', 'openWallpaper', '-file', previous.resource, '-monitor', '0']);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !(coordinator.source?.resource === previous.resource && coordinator.state === 'Active')) await delay(100);
    assert.equal(coordinator.source?.resource, previous.resource); assert.equal(coordinator.state, 'Active');
    report.restartFreeFourTypeSynchronization = true;
  } finally {
    clearInterval(timer); await coordinator.stop();
    await command(['-control', 'openWallpaper', '-file', previous.resource, '-monitor', '0']);
    if (Object.keys(previous.properties || {}).length) await runFile(executable, [quote('-control'), quote('applyProperties'), quote('-properties'),
      `RAW~(${JSON.stringify(previous.properties)})~END`, quote('-monitor'), quote('0')], { windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 });
    const restored = new WallpaperEngine({ username: os.userInfo().username });
    try {
      const source = (await restored.observeDesktop((await nativeProbe()).wallpaperEngine, { monitor: 0 })).source;
      report.originalSourceAndPropertiesRestored = source.resource.toLowerCase() === previous.resource.toLowerCase() &&
        JSON.stringify(Object.entries(source.properties).sort()) === JSON.stringify(Object.entries(previous.properties).sort());
      assert.equal(report.originalSourceAndPropertiesRestored, true);
    } finally { restored.close(); }
    await writeFile(path.join(root, 'four-types.json'), JSON.stringify(report, null, 2));
  }
}
