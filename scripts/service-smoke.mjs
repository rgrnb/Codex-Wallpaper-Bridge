import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(path.join(os.tmpdir(), 'cwb-service-')), token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['src/main.mjs'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_DATA_DIR: data, BRIDGE_CONTROL_TOKEN: token } });
let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
const stopped = once(child, 'exit'); const lines = createInterface({ input: child.stdout });
let timer;
try {
  const ready = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service readiness timed out: ' + errors)), 15000); })]);
  clearTimeout(timer); const base = `http://127.0.0.1:${ready.port}`, headers = { 'X-Bridge-Token': token, 'Content-Type': 'application/json' };
  const status = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(status.state, 'Disabled'); assert.equal(status.settings.enabled, false); assert.equal(status.fullPrdAccepted, false);
  assert.equal((await fetch(`${base}/settings`, { method: 'POST', headers, body: '{"effects":{"opacity":9}}' })).status, 400);
  assert.equal((await fetch(`${base}/export`, { method: 'POST', headers, body: '{}' })).status, 200);
  const exportText = await readFile(path.join(data, 'diagnostics.json'), 'utf8'); assert.ok(!exportText.includes(token));
  await fetch(`${base}/exit`, { method: 'POST', headers, body: '{}' });
  const [code] = await stopped; assert.equal(code, 0);
  console.log('Service smoke passed: native discovery, authenticated status, disabled default, invalid setting rejection, private export, graceful exit.');
} finally { clearTimeout(timer); lines.close(); if (child.exitCode === null) child.kill(); }
