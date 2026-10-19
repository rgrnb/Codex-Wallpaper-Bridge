import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT } from '../src/platform.mjs';
import { Presentation } from '../src/presentation.mjs';
const { chromium } = await import(process.env.BRIDGE_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.BRIDGE_PLAYWRIGHT_MODULE).href : 'playwright');
const evidence = path.join(ROOT, '.local-evidence', `frame-transport-${randomBytes(8).toString('hex')}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.BRIDGE_BROWSER_PATH });
const report = { started: new Date().toISOString(), actualCodex: false, source: 'authored JPEG; unique bounded COM marker; identical pixel content', results: [], success: false };
try {
  for (const legacy of [true, false]) {
    const context = await browser.newContext(), page = await context.newPage();
    await page.setContent('<div id="root"><main>Authored transport fixture</main></div>');
    const bytes = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.fillStyle = '#2379c1'; x.fillRect(0, 0, 640, 360); return c.toDataURL('image/jpeg', .8).split(',')[1]; }), 'base64');
    const session = await context.newCDPSession(page);
    const client = { call: (method, params) => session.send(method, params), async evaluate(expression) {
      const response = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error('TRANSPORT_RENDERER_FAILED'); return response.result?.value;
    }, close() {} };
    const adapter = { verifiedVersions: ['fixture'], selectors: { root: '#root', main: 'main' } };
    const p = new Presentation(adapter, { async event() {} }, { discover: async () => [{ id: 'authored' }], connect: async () => client });
    await p.configure({ effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 2073600 } });
    await p.reconcile([19300], 'fixture', false); await session.send('HeapProfiler.collectGarbage');
    const before = await session.send('Runtime.getHeapUsage'), started = Date.now();
    for (let i = 0; i < 600; i++) {
      const marker = Buffer.alloc(32772, 65); marker[0] = 255; marker[1] = 254; marker.writeUInt16BE(32770, 2); marker.write(String(i), 4);
      const jpeg = Buffer.concat([bytes.subarray(0, 2), marker, bytes.subarray(2)]).toString('base64');
      if (legacy) await client.evaluate(`window.__codexWallpaperBridgeV1.frame(1,${JSON.stringify(jpeg)})`);
      else await p.frame({ jpeg }, 1);
      if (i % 60 === 0) await p.heartbeat();
    }
    const after = await session.send('Runtime.getHeapUsage'); await session.send('HeapProfiler.collectGarbage');
    const collected = await session.send('Runtime.getHeapUsage');
    assert.equal(await client.evaluate('document.querySelectorAll("canvas[data-cwb-owned]").length'), 1);
    report.results.push({ transport: legacy ? 'legacy-evaluated-frame-literal' : 'fixed-function-data-arguments', frames: 600,
      durationSeconds: (Date.now() - started) / 1000, before, after, collected,
      retainedBackingGrowth: collected.backingStorageSize - before.backingStorageSize,
      retainedHeapGrowth: collected.usedSize - before.usedSize });
    await p.restore(); await context.close();
  }
  report.comparison = { oldRetainedBytes: report.results[0].retainedBackingGrowth, newRetainedBytes: report.results[1].retainedBackingGrowth };
  assert.ok(report.comparison.newRetainedBytes < 8 * 1024 ** 2, 'FRAME_ARGUMENT_RETENTION_EXCEEDED');
  report.comparison.legacyRetentionReproduced = report.comparison.oldRetainedBytes > report.comparison.newRetainedBytes + 8 * 1024 ** 2;
  report.comparison.causalLeakClaim = false;
  report.success = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally { await browser.close(); report.finished = new Date().toISOString(); await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ evidence, success: report.success, comparison: report.comparison, failure: report.failure })); }
