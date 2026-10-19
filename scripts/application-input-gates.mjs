import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ROOT, HOST, runFile } from '../src/platform.mjs';

const evidence=path.join(ROOT,'.local-evidence',`application-input-gates-${randomUUID()}`);
await mkdir(evidence);
const compiler=path.win32.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const executable=path.join(evidence,'AuthoredUnknownApplication.exe');
await runFile(compiler,['/nologo','/target:exe','/platform:x86','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',`/out:${executable}`,
  path.join(ROOT,'scripts/experiments/ApplicationInputGateProbe.cs')],{windowsHide:true,timeout:20000});
const output=await runFile(executable,[path.join(path.dirname(HOST),'BridgeApplicationInput.dll'),path.join(path.dirname(HOST),'BridgeApplicationInputHook32.dll'),path.join(evidence,'result.json')],{windowsHide:true,timeout:15000});
console.log(JSON.stringify({evidence,...JSON.parse(output.stdout)}));
