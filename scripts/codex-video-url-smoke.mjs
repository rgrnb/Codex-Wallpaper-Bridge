import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { WallpaperEngine } from '../src/wallpaper-engine.mjs';
import { projectServer } from '../src/web-backend.mjs';

const before = await nativeProbe(), port = 19340, root = path.join(ROOT, '.local-evidence', `video-url-${randomBytes(8).toString('hex')}`);
assert.ok(!before.codex.some(app => app.endpoints.includes(port))); await mkdir(root);
const observer = new WallpaperEngine({ username: os.userInfo().username });
const source = (await observer.observeDesktop(before.wallpaperEngine, { monitor: 0 })).source; observer.close(); assert.equal(source.type, 'video');
const host = await projectServer(source.root, source.resource), report = { currentChatAccessed: false, wallpaperCopies: 0 };
const child = spawn(before.codexInstall, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${root}`], { windowsHide: true, stdio: 'ignore' });
let client;
try {
  for (let n = 0; n < 80 && !client; n++) {
    const apps = await nativeProbe();
    if (apps.codex.some(app => app.pid === child.pid && app.endpoints.includes(port))) for (const target of await listTargets(port)) {
      const candidate = await new CdpClient(target.webSocketDebuggerUrl, { timeout: 20000 }).connect();
      if (await candidate.evaluate("!!document.querySelector('aside.app-shell-left-panel')")) { client = candidate; break; } candidate.close();
    }
    if (!client) await new Promise(r => setTimeout(r, 300));
  }
  assert.ok(client);
  report.media = await client.evaluate(`(async () => {
    let directive=null;const listener=e=>{if(e.blockedURI?.startsWith('http://127.0.0.1:'))directive=e.effectiveDirective;};
    document.addEventListener('securitypolicyviolation',listener);
    const video=document.createElement('video');video.dataset.cwbUrlProbe='true';video.muted=true;video.defaultMuted=true;video.volume=0;
    video.crossOrigin='anonymous';video.loop=true;video.playsInline=true;video.src=${JSON.stringify(host.url)};
    video.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none';document.body.append(video);
    try {
      const ready=await Promise.race([video.play().then(()=>true,()=>false),new Promise(r=>setTimeout(()=>r(false),10000))]);
      await new Promise(r=>setTimeout(r,1500));let canvasReadable=false;
      if(ready){const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(video,0,0,1,1);try{x.getImageData(0,0,1,1);canvasReadable=true;}catch{}}
      return {ready,width:video.videoWidth,height:video.videoHeight,muted:video.muted&&video.volume===0,
        decodedFrames:video.getVideoPlaybackQuality().totalVideoFrames,canvasReadable,directive,error:video.error?.code||null};
    }finally{video.pause();video.removeAttribute('src');video.load();video.remove();document.removeEventListener('securitypolicyviolation',listener);}
  })()`);
  const input = await client.call('Runtime.evaluate', { expression: `(() => {const input=document.createElement('input');
    input.type='file';input.id='cwb-native-file-probe';input.style.display='none';document.body.append(input);return input;})()`, returnByValue: false });
  assert.ok(input.result.objectId);
  try {
    await client.call('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [source.resource] });
    report.nativeFile = await client.evaluate(`(async () => {
      const input=document.getElementById('cwb-native-file-probe'),file=input.files[0];input.remove();
      const url=URL.createObjectURL(file),video=document.createElement('video');video.muted=video.defaultMuted=true;video.volume=0;video.src=url;
      try{await video.play();await new Promise(r=>setTimeout(r,1500));const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
        const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,1,1);ctx.getImageData(0,0,1,1);
        return {ready:true,width:video.videoWidth,height:video.videoHeight,muted:video.muted&&video.volume===0,
          decodedFrames:video.getVideoPlaybackQuality().totalVideoFrames,fileBytes:file.size,fullFileTransferred:false};
      }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
    })()`);
  } finally { await client.call('Runtime.releaseObject', { objectId: input.result.objectId }).catch(()=>{}); }
} finally {
  client?.close(); if (child.exitCode === null) await runFile('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,timeout:10000}).catch(()=>child.kill());
  host.server.closeAllConnections();host.server.close(); await writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
}
