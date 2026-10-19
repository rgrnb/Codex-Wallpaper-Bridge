import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { Presentation } from '../src/presentation.mjs';
import { ProcessSampler } from '../src/metrics.mjs';

// Diagnostic only: authored pixels and newly spawned empty profiles. Forced GC
// is reported separately and can never turn a failed endurance run into PASS.
const before = await nativeProbe(), port = 19344, frames = Number(process.env.BRIDGE_MEMORY_PROBE_FRAMES || 1200);
assert.ok(Number.isInteger(frames) && frames >= 200 && frames <= 4000);
assert.ok(before.codexInstall && !before.codex.some(app => app.endpoints.includes(port)));
await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
const evidence = path.join(ROOT, '.local-evidence', `codex-frame-memory-${randomUUID()}`); await mkdir(evidence);
const helper = path.join(evidence, 'CodexWindowProbe.exe');
await runFile(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, path.join(ROOT, 'scripts/experiments/CodexWindowProbe.cs')], { windowsHide: true, timeout: 15000 });
const adapter = JSON.parse(await readFile(path.join(ROOT, 'config/adapter.json'), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { success: false, frames, scope: 'Authored JPEG pixels; exact newly spawned empty-profile processes only; no user targets, input, focus or file contents.', results: [] };
const checkpoint = () => writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
const modes = (process.env.BRIDGE_MEMORY_PROBE_MODES || 'transport-only,blob-bitmap,image-decoder').split(',');
assert.ok(modes.every(mode => ['production-binary','transport-only','transport-sync','blob-notawait','transport-group','transport-reconnect','blob-reconnect','blob-bitmap','blob-cpu-canvas','image-decoder','image-decoder-cpu','http-transport-only','http-bitmap','http-decoder','http-isolated','fetch-transport-only','fetch-bitmap'].includes(mode)));
let binaryFrame; const capability = randomUUID(), origins = new Set(), binaryRequests = [];
const binaryServer = createHttpServer((request, response) => {
  if (request.url !== `/${capability}` || !binaryFrame) { response.writeHead(404); response.end(); return; }
  if (binaryRequests.length < 10) binaryRequests.push({ method: request.method, origin: request.headers.origin, privateNetworkPreflight: request.headers['access-control-request-private-network'] });
  origins.add(String(request.headers.origin));
  const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': request.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Private-Network': 'true' };
  if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  response.writeHead(200, headers);
  response.end(binaryFrame);
});
await new Promise(resolve => binaryServer.listen(0, '127.0.0.1', resolve));
const binaryUrl = `http://127.0.0.1:${binaryServer.address().port}/${capability}`;
try {
  for (const mode of modes) {
    console.error(`Memory probe: ${mode}.`);
    const profile = path.join(evidence, mode); await mkdir(profile);
    const child = spawn(before.codexInstall, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { windowsHide: true, stdio: 'ignore' });
    assert.ok(child.pid && !before.codex.some(app => app.pid === child.pid));
    const closed = new Promise(resolve => child.once('exit', resolve));
    const result = { mode, pid: child.pid, samples: [] }; report.results.push(result);
    let identity, client, browser, presentation, fetchListener, ackListener, ackBinding;
    try {
      const deadline = Date.now() + 90000;
      while (!identity && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try { const stamp = JSON.parse((await runFile(helper, [String(child.pid), '--owned-stamp'], { windowsHide: true, timeout: 5000 })).stdout);
          assert.equal(path.resolve(stamp.executable).toLowerCase(), path.resolve(before.codexInstall).toLowerCase()); identity = stamp; }
        catch { await pause(200); }
      }
      assert.ok(identity); result.identity = identity;
      while (!client && Date.now() < deadline) {
        let targets = []; try { targets = await listTargets(port); } catch {}
        for (const target of targets) {
          const candidate = await new CdpClient(target.webSocketDebuggerUrl).connect();
          if (await candidate.evaluate(`!!document.querySelector(${JSON.stringify(adapter.selectors.main)})`)) { client = candidate; result.target = target; break; }
          candidate.close();
        }
        if (!client) await pause(300);
      }
      assert.ok(client, 'Owned renderer did not become ready');
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), socket = new URL(version.webSocketDebuggerUrl);
      assert.equal(socket.hostname, '127.0.0.1'); assert.equal(Number(socket.port), port); assert.match(socket.pathname, /^\/devtools\/browser\/[a-z0-9-]+$/i);
      browser = await new CdpClient(socket.href).connect();
      result.processRoles = await browser.call('SystemInfo.getProcessInfo');
      result.policyMetadata = await client.evaluate(`({nativeFetch:/\\[native code\\]/.test(String(fetch)),connectPolicies:[...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map(m=>m.content.split(';').find(d=>d.trim().startsWith('connect-src'))).filter(Boolean)})`);
      if (mode === 'blob-cpu-canvas' || mode === 'image-decoder-cpu') await client.evaluate(`(() => {const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,options){return original.call(this,kind,kind==='2d'&&this.dataset.cwbOwned==='v1'?{...options,willReadFrequently:true}:options);};return true;})()`);
      // Historical variants deliberately retain their original data-argument
      // path; only the named production mode exercises the new binary route.
      presentation = new Presentation(adapter, { async event() {} }, { discover: async () => [mode === 'production-binary' ? result.target : { id: result.target.id }], connect: async () => client });
      await presentation.configure({ effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 2073600 } });
      await presentation.reconcile([{ port, version: before.codex.find(app => app.version)?.version || '26.1013.4894.0' }], '', true);
      assert.equal(presentation.windows.size, 1);
      const authored = await client.evaluate(`(() => {const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.fillStyle='#245a8b';x.fillRect(0,0,1280,720);let seed=12345;for(let i=0;i<800;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;x.fillStyle='#'+(seed&0xffffff).toString(16).padStart(6,'0');x.fillRect((seed>>>1)%1280,(seed>>>13)%720,35+(seed%50),25+(seed%40));}return c.toDataURL('image/jpeg',.85).split(',')[1];})()`);
      const jpeg = Buffer.from(authored, 'base64'); result.authoredJpegBytes = jpeg.length;
      if (mode.startsWith('fetch-')) {
        await presentation.frame({ jpeg: authored }, 1); result.warmupFrames = 1;
        const { frameTree } = await client.call('Page.getFrameTree');
        // Synthetic HTTPS path: every matching request is fulfilled locally;
        // the interceptor never continues it to the remote service.
        const virtualPrefix = `https://persistent.oaistatic.com/__cwb_memory_${randomUUID()}/`, originalCall = client.call.bind(client);
        result.syntheticHttpsFulfilledLocally = true;
        let encoded = authored, sequence = 0; result.interceptedFrames = 0;
        fetchListener = event => {
          let row; try { row = JSON.parse(event.data); } catch { return; }
          if (row.method !== 'Fetch.requestPaused') return;
          const request = row.params;
          if (!request.request.url.startsWith(virtualPrefix) || request.frameId !== frameTree.frame.id || request.request.method !== 'GET') {
            void originalCall('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return;
          }
          result.interceptedFrames++;
          void originalCall('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'image/jpeg' }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: encoded }).catch(error => { (result.transportErrors ||= []).push(error.message); });
        };
        client.ws.addEventListener('message', fetchListener);
        await originalCall('Fetch.enable', { patterns: [{ urlPattern: `${virtualPrefix}*`, requestStage: 'Request' }] });
        result.sameOriginPolicy = await client.evaluate(`fetch(${JSON.stringify(virtualPrefix + 'probe')},{cache:'no-store',credentials:'omit'}).then(r=>r.arrayBuffer()).then(b=>({bytes:b.byteLength})).catch(e=>({error:e.name+':'+e.message}))`);
        assert.equal(result.sameOriginPolicy.bytes, jpeg.length);
        await client.evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned]');c.width=1280;c.height=720;const ctx=c.getContext('2d');window.__codexWallpaperBridgeV1.frame=async(g,url)=>{const r=await fetch(url,{cache:'no-store',credentials:'omit'}),bytes=new Uint8Array(await r.arrayBuffer());if(${JSON.stringify(mode)}==='fetch-transport-only')return true;const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));try{ctx.drawImage(image,0,0,c.width,c.height);return true;}finally{image.close();}};return true;})()`);
        client.call = (method, params = {}) => {
          if (method === 'Runtime.callFunctionOn' && params.arguments?.length === 2) {
            encoded = params.arguments[1].value;
            params = { ...params, arguments: [params.arguments[0], { value: `${virtualPrefix}${++sequence}` }] };
          }
          return originalCall(method, params);
        };
      }
      if (mode.startsWith('transport-')) await client.evaluate('window.__codexWallpaperBridgeV1.frame = async () => true');
      if (mode === 'transport-sync') await client.evaluate('window.__codexWallpaperBridgeV1.frame = () => true');
      if (mode === 'blob-notawait') {
        ackBinding = `__cwbMemoryAck${randomUUID().replaceAll('-', '')}`;
        const originalCall = client.call.bind(client), pending = new Map(); let sequence = 0; result.acknowledgements = 0;
        ackListener = event => {
          if (typeof event.data !== 'string' || event.data.length > 2048) return;
          let row, ack; try { row = JSON.parse(event.data); } catch { return; }
          if (row.method !== 'Runtime.bindingCalled' || row.params?.name !== ackBinding) return;
          try { ack = JSON.parse(row.params.payload); } catch { return; }
          const accept = pending.get(ack.id); if (!accept) return; result.acknowledgements++; accept(ack);
        };
        client.ws.addEventListener('message', ackListener); await originalCall('Runtime.addBinding', { name: ackBinding });
        client.call = async (method, params = {}) => {
          if (method !== 'Runtime.callFunctionOn' || params.arguments?.length !== 2) return originalCall(method, params);
          const id = String(++sequence); let timer;
          const acknowledged = new Promise((resolve, reject) => { pending.set(id, resolve); timer = setTimeout(() => reject(new Error('MEMORY_FRAME_ACK_TIMEOUT')), 5000); });
          try {
            await originalCall(method, { ...params, awaitPromise: false,
              functionDeclaration: 'function(g,jpeg,id,binding){Promise.resolve(this.__codexWallpaperBridgeV1.frame(g,jpeg)).then(ok=>this[binding](JSON.stringify({id,ok})),()=>this[binding](JSON.stringify({id,ok:false})));return true;}',
              arguments: [...params.arguments, { value: id }, { value: ackBinding }] });
            const ack = await acknowledged; assert.equal(ack.ok, true);
            return { result: { type: 'boolean', value: true } };
          } finally { clearTimeout(timer); pending.delete(id); }
        };
      }
      if (mode === 'transport-group') {
        const originalCall = client.call.bind(client);
        client.call = async (method, params = {}) => {
          if (method !== 'Runtime.callFunctionOn') return originalCall(method, params);
          try { return await originalCall(method, { ...params, objectGroup: 'cwb-frame-probe' }); }
          finally { await originalCall('Runtime.releaseObjectGroup', { objectGroup: 'cwb-frame-probe' }); }
        };
      }
      if (mode === 'image-decoder' || mode === 'image-decoder-cpu') {
        assert.equal(await client.evaluate('typeof ImageDecoder'), 'function');
        await client.evaluate(`globalThis.createImageBitmap=async blob=>{const decoder=new ImageDecoder({data:new Uint8Array(await blob.arrayBuffer()),type:'image/jpeg'});try{const frame=(await decoder.decode({frameIndex:0})).image;Object.defineProperties(frame,{width:{value:frame.displayWidth},height:{value:frame.displayHeight}});return frame;}finally{decoder.close();}}`);
      }
      if (mode.startsWith('http-')) {
        binaryFrame = jpeg;
        const fetchExpression = `(async()=>{const violations=[];const listener=e=>violations.push({effectiveDirective:e.effectiveDirective,violatedDirective:e.violatedDirective,disposition:e.disposition});document.addEventListener('securitypolicyviolation',listener);let bytes,error;try{bytes=(await(await fetch(${JSON.stringify(binaryUrl)},{cache:'no-store',credentials:'omit'})).arrayBuffer()).byteLength;}catch(e){error={name:e.name,message:e.message};}await new Promise(r=>setTimeout(r,150));document.removeEventListener('securitypolicyviolation',listener);return {bytes,error,violations};})()`;
        result.fetchPolicy = await client.evaluate(fetchExpression);
        if (mode === 'http-isolated') {
          const { frameTree } = await client.call('Page.getFrameTree');
          const world = await client.call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: `cwb-memory-${randomUUID()}` });
          const isolated = await client.call('Runtime.evaluate', { expression: fetchExpression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true });
          result.isolatedFetch = isolated.result?.value; assert.equal(result.isolatedFetch?.bytes, jpeg.length);
          result.policyOnly = true; continue;
        }
        result.binaryFetchBytes = result.fetchPolicy.bytes;
        assert.equal(result.binaryFetchBytes, jpeg.length);
        await client.evaluate(`(() => {const c=document.querySelector('canvas[data-cwb-owned]');c.width=1280;c.height=720;const ctx=c.getContext('2d');window.__codexWallpaperBridgeV1.frame=async(g,url)=>{const response=await fetch(url,{cache:'no-store',credentials:'omit'}),bytes=new Uint8Array(await response.arrayBuffer());
          if(${JSON.stringify(mode)}==='http-transport-only')return true;
          let decoder,image;try{if(${JSON.stringify(mode)}==='http-decoder'){decoder=new ImageDecoder({data:bytes,type:'image/jpeg'});image=(await decoder.decode({frameIndex:0})).image;}else image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));ctx.drawImage(image,0,0,c.width,c.height);return true;}finally{image?.close();decoder?.close();}};return true;})()`);
        const originalCall = client.call.bind(client);
        client.call = (method, params = {}) => {
          if (method === 'Runtime.callFunctionOn' && params.arguments?.length === 2) {
            binaryFrame = Buffer.from(params.arguments[1].value, 'base64');
            params = { ...params, arguments: [params.arguments[0], { value: binaryUrl }] };
          }
          return originalCall(method, params);
        };
      }
      const sampler = new ProcessSampler({ details: true, scope: 'owned-memory-probe-tree' });
      const sample = async label => ({ label, tree: await sampler.collect([child.pid]), heap: await client.call('Runtime.getHeapUsage'), dom: await client.call('Memory.getDOMCounters') });
      await pause(3000); result.before = await sample('before'); const started = Date.now();
      for (let index = 0; index < frames; index++) {
        const marker = Buffer.alloc(32772, 65); marker[0] = 255; marker[1] = 254; marker.writeUInt16BE(32770, 2); marker.write(String(index), 4);
        const unique = Buffer.concat([jpeg.subarray(0, 2), marker, jpeg.subarray(2)]).toString('base64');
        await presentation.frame({ jpeg: unique }, 1);
        if (mode.endsWith('-reconnect') && (index + 1) % 60 === 0) {
          client.close(); client = await new CdpClient(result.target.webSocketDebuggerUrl).connect();
          for (const window of presentation.windows.values()) { window.client = client; window.frameObjectId = null; }
          result.frameSessionRotations = (result.frameSessionRotations || 0) + 1;
        }
        if (index % 60 === 0) await presentation.heartbeat();
        if ((index + 1) % 200 === 0) { result.samples.push(await sample(`frame-${index + 1}`)); await checkpoint(); }
      }
      result.durationSeconds = (Date.now() - started) / 1000; result.after = await sample('after');
      await client.call('HeapProfiler.collectGarbage'); await pause(1000); result.afterDiagnosticGc = await sample('after-diagnostic-gc');
      result.privateGrowth = result.after.tree.privateBytes - result.before.tree.privateBytes;
      result.productionBinaryRoute = !![...presentation.windows.values()][0]?.frameFetch?.ready;
      result.afterGcPrivateGrowth = result.afterDiagnosticGc.tree.privateBytes - result.before.tree.privateBytes;
      console.error(`Memory probe: ${mode} completed, growth ${Math.round(result.privateGrowth / 1024 ** 2)} MiB, after diagnostic GC ${Math.round(result.afterGcPrivateGrowth / 1024 ** 2)} MiB.`);
    } finally {
      if (ackListener) { client?.ws?.removeEventListener('message', ackListener); await client?.call('Runtime.removeBinding', { name: ackBinding }).catch(() => {}); }
      try { await presentation?.restore(); } catch (error) { result.restoreError = error.message; }
      if (fetchListener) { client?.ws?.removeEventListener('message', fetchListener); await client?.call('Fetch.disable').catch(() => {}); }
      client?.close(); browser?.close();
      if (identity) result.cleanup = JSON.parse((await runFile(helper, [String(child.pid), '--owned-terminate-tree', identity.nativeStarted, identity.nativeExecutable], { windowsHide: true, timeout: 15000 })).stdout);
      else if (child.exitCode === null) child.kill();
      await Promise.race([closed, pause(3000)]); await checkpoint();
    }
  }
  report.success = true;
} catch (error) { report.failure = { message: error.message, stdout: error.stdout, stack: error.stack }; process.exitCode = 1; }
finally {
  binaryServer.closeAllConnections(); await new Promise(resolve => binaryServer.close(resolve)); report.binaryRequestOrigins = [...origins]; report.binaryRequests = binaryRequests;
  const after = await nativeProbe(); report.userPidsRetained = before.codex.every(app => after.codex.some(current => current.pid === app.pid));
  report.wallpaperEnginePreserved = after.wallpaperEngine?.pid === before.wallpaperEngine?.pid;
  report.success &&= report.userPidsRetained && report.wallpaperEnginePreserved;
  if (!report.success) process.exitCode = 1; await checkpoint(); console.log(JSON.stringify({ evidence, success: report.success, failure: report.failure }));
}
