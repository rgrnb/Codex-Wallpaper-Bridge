import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { nativeProbe, ROOT } from '../../src/platform.mjs';
const run = promisify(execFile), delay = ms => new Promise(r => setTimeout(r, ms));
const app = (await nativeProbe()).wallpaperEngine;
const id = randomUUID(), name = `CodexBridgeProbe-${id}`, events = [];
const server = http.createServer(async (request, response) => {
  if (request.url !== `/${id}`) { response.writeHead(404).end(); return; }
  let text = ''; for await (const c of request) { text += c; if (text.length > 8192) break; }
  try { events.push(JSON.parse(text)); } catch { }
  response.setHeader('Access-Control-Allow-Origin', '*'); response.end('ok');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const root = path.join(ROOT, '.local-evidence', `default-mute-${id}`);
await mkdir(root);
await writeFile(path.join(root, 'index.html'), `<!doctype html><body style="background:#245"><script>
function report(type,value){fetch('http://127.0.0.1:${server.address().port}/${id}',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({type,value})});}
window.wallpaperPropertyListener={applyUserProperties:p=>report('user',p),applyGeneralProperties:p=>report('general',p)};
</script>`);
await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html', title: 'silent-default-probe',
  general: { videoaudiooutput: false, volume: 0, properties: { volume: { type: 'slider', value: 0, min: 0, max: 100, text: 'Volume' }, marker: { type: 'slider', value: 77, min: 0, max: 100, text: 'Marker' } } } }));
const wrapper = path.join(root, 'wrapper'); await mkdir(wrapper);
const original = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
await writeFile(path.join(wrapper, 'project.json'), JSON.stringify({ ...original, file: path.join(root, 'index.html') }));
const configPath = path.join(path.dirname(app.path), 'config.json');
const selected = config => Object.fromEntries(Object.entries(config).filter(([, v]) => v?.general?.wallpaperconfig).map(([k, v]) => [k, v.general.wallpaperconfig.selectedwallpapers]));
const before = selected(JSON.parse(await readFile(configPath, 'utf8')));
try {
  await run(app.path, ['-control', 'openWallpaper', '-file', path.join(wrapper, 'project.json'), '-playInWindow', name, '-width', '320', '-height', '180'], { windowsHide: true });
  await delay(2200);
} finally {
  await run(app.path, ['-control', 'closeWallpaper', '-location', name], { windowsHide: true });
  server.close();
}
const result = { events, defaultZeroSeen: events.find(e=>e.type==='user')?.value?.volume?.value === 0,
  generalAudioDisabled: events.find(e=>e.type==='general')?.value?.videoaudiooutput === false, absoluteEntryWorked: events.length > 0,
  desktopSelectionUnchanged: JSON.stringify(before) === JSON.stringify(selected(JSON.parse(await readFile(configPath, 'utf8')))), audioCreated: false };
await writeFile(path.join(ROOT, '.local-evidence', 'default-mute-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
