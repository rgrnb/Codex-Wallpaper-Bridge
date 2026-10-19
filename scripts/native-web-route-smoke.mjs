import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.local-evidence', `native-web-route-${randomUUID()}`);
await mkdir(path.join(evidence, 'helper'), { recursive: true });
for (const file of ['CodexWallpaperBridge.exe', 'BridgeGraphicsHook.dll'])
  await copyFile(path.join(process.env.BRIDGE_POINTER_BUILD || path.join(root, 'build'), file), path.join(evidence, 'helper', file));
process.env.BRIDGE_NATIVE_HOST = path.join(evidence, 'helper', 'CodexWallpaperBridge.exe');
const { IsolatedPlayer } = await import('../src/isolated-player.mjs');
const { describeSource } = await import('../src/wallpaper-engine.mjs');
const engine = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const config = path.join(path.dirname(engine), 'config.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalConfig = hash(await readFile(config));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
await writeFile(path.join(evidence, 'project.json'), JSON.stringify({ type: 'web', file: 'index.html', title: 'Authored history route pointer fixture' }));
await writeFile(path.join(evidence, 'index.html'), `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#12405b;color:white}body{display:grid;place-items:center;font:32px sans-serif}</style></head><body>Authored history route fixture<script>
history.pushState({},'', 'circuit');window.pointerEvents=[];
for(const type of ['mousemove','mousedown','mouseup','click'])document.addEventListener(type,e=>{window.pointerEvents.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});if(type==='click')document.body.style.background='#538734'});
</script></body></html>`);
const source = await describeSource(path.join(evidence, 'project.json'));
await writeFile(path.join(evidence, 'other.html'), `<!doctype html><script>
performance.getEntriesByType=()=>[{name:${JSON.stringify(pathToFileURL(source.resource).href)}}];history.pushState({},'', 'circuit');
</script>Unrelated same-directory document with forged default-world performance`);
const policy = { maxWidth: 640, height: 360, fps: 30, jpegQuality: 95 };
const player = new IsolatedPlayer({ executable: engine });
const report = { started: new Date().toISOString(), success: false, scope: 'Real private CEF, same-document history routing and trusted mouse input; no system input or audio source.' };
let runtime;
try {
  report.surface = await player.start(source, { policy }); runtime = player.runtime;
  let client, lastFailure;
  const deadline = Date.now() + 12000;
  while (!client && Date.now() < deadline) {
    try { client = await player.webInputClient(); }
    catch (error) { lastFailure = error.message; await delay(100); }
  }
  assert.ok(client, lastFailure);
  report.initialProof = { ...player.webDocument, navigationUrl: await client.evaluate(`performance.getEntriesByType('navigation')[0].name`) };
  assert.equal(report.initialProof.navigationUrl, pathToFileURL(source.resource).href);
  assert.ok(report.initialProof.target.url.endsWith('/circuit'));
  assert.equal(await player.pointer({ type: 'move', x: 0.25, y: 0.75 }), true);
  assert.equal(await player.pointer({ type: 'click', x: 0.6, y: 0.4 }), true);
  report.firstEvents = await client.evaluate('window.pointerEvents');
  const movement = report.firstEvents.find(event => event.type === 'mousemove' && event.x < 200);
  const click = report.firstEvents.find(event => event.type === 'click');
  assert.ok(movement?.trusted && Math.abs(movement.x / 639 - 0.25) < 0.01 && Math.abs(movement.y / 359 - 0.75) < 0.01);
  assert.ok(click?.trusted && Math.abs(click.x / 639 - 0.6) < 0.01 && Math.abs(click.y / 359 - 0.4) < 0.01);
  await client.evaluate(`history.pushState({},'', 'second-route')`);
  assert.equal(await player.pointer({ type: 'click', x: 0.7, y: 0.3 }), true);
  report.secondRoute = await client.evaluate('({url:location.href,events:window.pointerEvents})');
  assert.equal(report.secondRoute.events.filter(event => event.type === 'click' && event.trusted).length, 2);
  const shot = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(evidence, 'compositor.png'), Buffer.from(shot.data, 'base64'));
  const frame = await player.capture(source, policy);
  await writeFile(path.join(evidence, 'gdi.jpg'), Buffer.from(frame.jpeg, 'base64'));
  await client.call('Page.navigate', { url: pathToFileURL(source.resource).href });
  await delay(500);
  report.newDocumentInputRejected = await player.pointer({ type: 'click', x: 0.5, y: 0.5 }) === false;
  assert.equal(report.newDocumentInputRejected, true, 'A new loader must revoke the prior document proof.');
  const replacement = await player.webInputClient();
  await replacement.call('Page.navigate', { url: pathToFileURL(path.join(evidence, 'other.html')).href });
  await delay(500);
  report.forgedDefaultWorldNavigation = await replacement.evaluate(`performance.getEntriesByType('navigation')[0].name`);
  assert.equal(report.forgedDefaultWorldNavigation, pathToFileURL(source.resource).href);
  assert.equal(await player.pointer({ type: 'click', x: 0.5, y: 0.5 }), false);
  await assert.rejects(player.webInputClient(), /ISOLATED_INPUT_TARGET_UNAVAILABLE/);
  report.forgedDocumentRejected = true;
  report.success = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
finally {
  try { await player.stop(); report.cleaned = true; }
  catch (error) { report.cleanupFailure = error.message; report.success = false; process.exitCode = 1; }
  report.privateRuntimeRemoved = runtime ? await stat(runtime.root).then(() => false, error => error.code === 'ENOENT') : true;
  report.originalConfigUnchanged = hash(await readFile(config)) === originalConfig;
  if (!report.privateRuntimeRemoved || !report.originalConfigUnchanged) { report.success = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }));
}
