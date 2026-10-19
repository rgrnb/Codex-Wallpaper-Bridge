import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ROOT, nativeProbe, runFile } from '../src/platform.mjs';
import { listTargets } from '../src/cdp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), port = 19344;
const before = await nativeProbe(), evidence = path.join(ROOT, '.local-evidence', `codex-owned-cleanup-${randomUUID()}`);
assert.ok(before.codexInstall); assert.ok(!before.codex.some(app => app.endpoints.includes(port)));
await new Promise((resolve, reject) => { const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve)); });
await mkdir(evidence); const profile=path.join(evidence,'empty-profile');await mkdir(profile);
const helper=path.join(evidence,'CodexWindowProbe.exe');
await runFile(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/platform:x64',`/out:${helper}`,path.join(ROOT,'scripts/experiments/CodexWindowProbe.cs')],{windowsHide:true,timeout:15000});
const report={started:new Date().toISOString(),success:false,port,profile,scope:'One newly spawned empty-profile Codex only. No window activation or user-window access. Wrong native stamp must refuse; original native proof must terminate the complete owned tree.'};
let child,identity,closed;
async function terminate(){return JSON.parse((await runFile(helper,[String(identity.pid),'--owned-terminate-tree',identity.nativeStarted,identity.nativeExecutable],{windowsHide:true,timeout:15000})).stdout);}
try {
  child=spawn(before.codexInstall,['--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`],{windowsHide:true,stdio:'ignore'});
  closed=new Promise(resolve=>child.once('exit',resolve));assert.ok(child.pid&&!before.codex.some(app=>app.pid===child.pid));
  const deadline=Date.now()+40000;
  while(!identity&&Date.now()<deadline&&child.exitCode===null){try{identity=JSON.parse((await runFile(helper,[String(child.pid),'--owned-stamp'],{windowsHide:true,timeout:5000})).stdout);}catch{await pause(150);}}
  assert.ok(identity,'Original managed and native identities must be recorded after launch.');report.identity=identity;
  report.nativeVsManagedTickDelta=String(BigInt(identity.nativeStarted)-BigInt(identity.started));
  report.nativeVsManagedPathEqual=path.resolve(identity.nativeExecutable).toLowerCase()===path.resolve(identity.executable).toLowerCase();
  let targets=[];while(!targets.length&&Date.now()<deadline&&child.exitCode===null){try{targets=await listTargets(port);}catch{}if(!targets.length)await pause(200);}
  assert.ok(targets.length,'Owned empty-profile renderer must exist before tree cleanup.');report.targetCount=targets.length;
  const altered=String(BigInt(identity.nativeStarted)+1n);
  await assert.rejects(runFile(helper,[String(identity.pid),'--owned-terminate-tree',altered,identity.nativeExecutable],{windowsHide:true,timeout:5000}),error=>{report.wrongStampRejection=JSON.parse(error.stdout);return report.wrongStampRejection.code==='OWNED_PROCESS_IDENTITY_INVALID'&&report.wrongStampRejection.actual.nativeStarted===identity.nativeStarted;});
  assert.equal(child.exitCode,null);report.rootAliveAfterRejection=true;
  report.terminated=await terminate();await Promise.race([closed,pause(3000)]);
  assert.equal(report.terminated.identityVerified,true);assert.equal(report.terminated.skipped.length,0);
  assert.ok(report.terminated.processes.length>1&&report.terminated.processes.every(row=>row.exited));
  assert.ok(report.terminated.processes.some(row=>row.pid===child.pid));
  report.success=true;
}catch(error){report.failure={message:error.message,stdout:error.stdout,stderr:error.stderr};process.exitCode=1;}
finally {
  if(child&&child.exitCode===null&&child.signalCode===null){try{if(identity)report.rescueCleanup=await terminate();else{report.originalSpawnHandleFallback=child.kill();}await Promise.race([closed,pause(3000)]);}catch(error){report.cleanupFailure={message:error.message,stdout:error.stdout,stderr:error.stderr};report.success=false;process.exitCode=1;}}
  const after=await nativeProbe();report.ownedRootExited=!child||!after.codex.some(app=>app.pid===child.pid);
  report.userPidsRetained=before.codex.every(app=>after.codex.some(current=>current.pid===app.pid));
  report.wallpaperEnginePreserved=after.wallpaperEngine?.pid===before.wallpaperEngine?.pid&&after.wallpaperEngine?.path===before.wallpaperEngine?.path;
  if(!report.ownedRootExited||!report.userPidsRetained||!report.wallpaperEnginePreserved){report.success=false;process.exitCode=1;}
  report.finished=new Date().toISOString();await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({evidence,...report}));
}
