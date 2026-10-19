import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { IsolatedPlayer } from '../src/isolated-player.mjs';
import { describeSource } from '../src/wallpaper-engine.mjs';
import { ROOT, runFile, nativeProbe } from '../src/platform.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const engine = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const helper = path.join(ROOT, 'build', 'BridgeWebIntegration.exe');
const token = randomUUID(), evidence = path.join(ROOT, '.local-evidence', `native-web-interfaces-${token}`), events = [];
await mkdir(evidence, { recursive: true });
const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.url !== `/${token}` || request.method !== 'POST') { response.writeHead(404).end(); return; }
  let body = ''; for await (const part of request) { body += part; if (body.length > 8192) { response.writeHead(413).end(); return; } }
  try { events.push(JSON.parse(body)); } catch {}
  response.end('ok');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/${token}`;
await writeFile(path.join(evidence, 'index.html'), `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:100%;height:100%}</style></head><body><canvas></canvas><script>
const report = value => fetch(${JSON.stringify(endpoint)}, {method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(value)}).catch(()=>{});
let tick=0,audioCount=0,audioContext;
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
function animate(){canvas.width=innerWidth;canvas.height=innerHeight;ctx.fillStyle='hsl('+(tick++%360)+' 80% 40%)';ctx.fillRect(0,0,canvas.width,canvas.height);requestAnimationFrame(animate)}animate();
window.wallpaperPropertyListener={applyUserProperties:p=>report({event:'properties',marker:p.marker?.value}),applyGeneralProperties:p=>{
  report({event:'general',audio:p.videoaudiooutput,fps:p.fps});
  // The fixture itself refuses to produce a tone if the engine did not first
  // report its private output-disabled setting. No unmuted positive control.
  if(p.videoaudiooutput===false&&!audioContext){try{audioContext=new(window.AudioContext||window.webkitAudioContext)();const o=audioContext.createOscillator(),g=audioContext.createGain();o.frequency.value=617;g.gain.value=0.05;o.connect(g).connect(audioContext.destination);o.start();audioContext.resume().then(()=>report({event:'audio',state:audioContext.state}));}catch{report({event:'audio',state:'unavailable'})}}
}};
report({event:'interfaces',audio:typeof wallpaperRegisterAudioListener,media:typeof wallpaperRegisterMediaPropertiesListener,random:typeof wallpaperRequestRandomFileForProperty});
if(typeof wallpaperRegisterAudioListener==='function')wallpaperRegisterAudioListener(values=>{if(++audioCount===1||audioCount%30===0)report({event:'audio-input',length:values.length,count:audioCount,finite:Array.from(values).every(Number.isFinite)})});
document.addEventListener('mousemove',e=>report({event:'move',x:e.clientX,y:e.clientY,width:innerWidth,height:innerHeight,trusted:e.isTrusted}));
document.addEventListener('click',e=>{report({event:'click',x:e.clientX,y:e.clientY,width:innerWidth,height:innerHeight,trusted:e.isTrusted});audioContext?.resume().then(()=>report({event:'audio',state:audioContext.state}))});
</script></body></html>`);
await writeFile(path.join(evidence, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html', title: 'Bridge owned native interface fixture',
  general: { supportsaudioprocessing: true, properties: { marker: { type: 'slider', value: 17, min: 0, max: 100, text: 'Marker' } } } }));
const sessions = async pids => JSON.parse((await runFile(helper, ['--sessions', pids.join(',')], { windowsHide: true, timeout: 5000 })).stdout);
const wait = async (predicate, milliseconds = 8000) => { const end = Date.now() + milliseconds; while (!predicate() && Date.now() < end) await delay(50); return predicate(); };
const desktopEngine = (await nativeProbe()).wallpaperEngine;
assert.ok(desktopEngine?.running && path.resolve(desktopEngine.path).toLowerCase() === path.resolve(engine).toLowerCase(), 'The original desktop engine must be identified freshly.');
const beforeConfig = hash(await readFile(path.join(path.dirname(engine), 'config.json'))), desktopBefore = await sessions([desktopEngine.pid]);
const player = new IsolatedPlayer({ executable: engine }), report = { success: false, started: new Date().toISOString(), events, audioSamples: [] };
let identities = [];
try {
  const source = await describeSource(path.join(evidence, 'project.json')); source.properties = { marker: 73 };
  source.fingerprint += ':marker73';
  await player.start(source, { policy: { maxWidth: 640, fps: 30 } });
  assert.ok(await wait(() => events.some(e => e.event === 'general')), 'A real native general-properties callback is required.');
  assert.ok(events.filter(e => e.event === 'general').every(e => e.audio === false), 'Audio must already be disabled at the first callback.');
  assert.ok(events.some(e => e.event === 'properties' && e.marker === 73), 'Private source properties must reach the source.');
  assert.ok(events.some(e => e.event === 'interfaces' && [e.audio, e.media, e.random].every(type => type === 'function')));
  await player.pointer({ type: 'move', x: 0.25, y: 0.75 });
  assert.ok(await wait(() => events.some(e => e.event === 'move')), 'Native Web must actually receive the forwarded mouse event.');
  const movement = events.filter(e => e.event === 'move').at(-1);
  assert.ok(movement.trusted && Math.abs(movement.x / (movement.width - 1) - 0.25) < 0.01 && Math.abs(movement.y / (movement.height - 1) - 0.75) < 0.01);
  await player.pointer({ type: 'click', x: 0.6, y: 0.4 });
  assert.ok(await wait(() => events.some(e => e.event === 'click')), 'Native Web must actually receive the forwarded left click.');
  assert.ok(await wait(() => events.some(e => e.event === 'audio' && e.state === 'running')));
  for (let index = 0; index < 6; index++) {
    const status = await player.status(); identities = status.processes;
    const sample = await sessions([...new Set([desktopEngine.pid, ...identities.map(row => row.pid)])]);
    assert.equal(sample.queried, true);
    const privatePids = new Set(identities.map(row => row.pid));
    assert.ok(sample.sessions.filter(row => privatePids.has(row.pid)).every(row => row.peak === 0), 'No private source session may produce a nonzero peak.');
    for (const baseline of desktopBefore.sessions) {
      const current = sample.sessions.find(row => row.pid === baseline.pid && row.deviceIndex === baseline.deviceIndex);
      if (current) assert.ok(current.mute === baseline.mute && current.volume === baseline.volume, 'Desktop session mute and volume must remain unchanged.');
    }
    report.audioSamples.push(sample); await delay(150);
  }
  assert.ok(events.some(e => e.event === 'audio-input' && e.length === 128 && e.finite));
  report.ownedProcesses = identities; report.actualNativePointer = movement;
  report.audioScope = 'First native callback reports output disabled; authored Web Audio oscillator runs while sampled private process sessions have zero output peak. Desktop mixer settings preserved. This is not continuous first-sample loopback capture.';
  report.success = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  await player.stop().catch(error => { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; });
  report.originalConfigUnchanged = hash(await readFile(path.join(path.dirname(engine), 'config.json'))) === beforeConfig;
  if (!report.originalConfigUnchanged) { report.success = false; process.exitCode = 1; }
  report.processesRemaining = identities.filter(row => { try { process.kill(row.pid, 0); return true; } catch { return false; } });
  if (report.processesRemaining.length) { report.success = false; process.exitCode = 1; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.finished = new Date().toISOString(); await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success, failure: report.failure, events, audioSamples: report.audioSamples, remaining: report.processesRemaining }));
}
