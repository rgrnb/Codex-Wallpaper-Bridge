import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CdpClient } from '../src/cdp.mjs';
import { Presentation } from '../src/presentation.mjs';

// These are self-authored headless pages, never the user's Codex or desktop.
// The production CdpClient/WebSocket/addBinding transport is used unchanged.
const modulePath = process.env.BRIDGE_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const value = server.address().port; server.close(() => resolve(value));
  });
});
const browser = await chromium.launch({ headless: true, ...(process.env.BRIDGE_BROWSER_PATH ? { executablePath: process.env.BRIDGE_BROWSER_PATH } : {}),
  args: [`--remote-debugging-port=${port}`] });
const report = { started: new Date().toISOString(), actualCodex: false, physicalWindows: false,
  scope: 'Authored headless pages, production WebSocket CDP binding, trusted browser mouse input; no native backend injection.', checks: [] };
const evidence = path.resolve('.local-evidence', `pointer-forwarding-${randomBytes(8).toString('hex')}`);
await mkdir(evidence, { recursive: true });
let presentation, heartbeat;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const selectors = { root: '#root', main: 'main', sidebar: 'aside', header: 'header', composer: '.composer', surfaces: '.thread' };
const options = { effects: { opacity: 0.6, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 921601 }, display: { zoom: 1, positionX: 0.5, positionY: 0.5 } };
const fixture = `<!DOCTYPE html><style>html,body{margin:0;width:100%;height:100%;background:#151d28;color:white}#root{display:flex;height:100vh}aside{width:120px}main{flex:1}.composer{position:absolute;bottom:30px;left:140px}textarea{width:250px;height:40px}button{width:100px;height:40px}</style>
<div id="root"><aside>Authored sidebar</aside><main><header>Authored fixture</header><div class="composer"><textarea aria-label="Own test input"></textarea><button>Own button</button></div></main></div>
<script>window.nativeClicks=0;document.querySelector('button').addEventListener('click',()=>window.nativeClicks++);</script>`;
try {
  for (const deviceScaleFactor of [1, 1.5, 2]) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor });
    const one = await context.newPage(), two = await context.newPage();
    await one.setContent(fixture); await two.setContent(fixture);
    presentation = new Presentation({ verifiedVersions: ['fixture'], selectors }, { async event() {} }, {
      discover: async () => {
        const values = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return values.filter(value => value.type === 'page').map(({ id, webSocketDebuggerUrl }) => ({ id, webSocketDebuggerUrl }));
      }, connect: target => new CdpClient(target.webSocketDebuggerUrl).connect(),
    });
    await presentation.configure(options); await presentation.reconcile([port], 'fixture', false);
    let heartbeating = false;
    heartbeat = setInterval(() => { if (!heartbeating) { heartbeating = true;
      presentation?.heartbeat().catch(() => {}).finally(() => { heartbeating = false; }); } }, 1000);
    assert.equal(presentation.windows.size, 2);
    assert.ok([...presentation.windows.values()].every(value => value.pointerAvailable), 'addBinding must work without Runtime.enable.');
    const jpeg = await one.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#33aacc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    await presentation.invalidate(1); await presentation.frame({ jpeg }, 1); await delay(350);
    await presentation.setPointerMode({ enabled: true, generation: 1 });
    let oneKey;
    for (const viewport of [{ width: 800, height: 600 }, { width: 601, height: 899 }]) {
      await one.setViewportSize(viewport); await delay(40);
      for (const display of [{ zoom: 1, positionX: 0.5, positionY: 0.5 }, { zoom: 2.3, positionX: 0.1, positionY: 0.9 }, { zoom: 4, positionX: 1, positionY: 0 }]) {
        await presentation.configure({ ...options, display });
        const point = { x: Math.floor(viewport.width * 0.67), y: Math.floor(viewport.height * 0.39) };
        await one.mouse.click(point.x, point.y); await delay(50);
        const values = presentation.drainPointers(1), click = values.find(value => value.type === 'click');
        assert.ok(click, `Trusted click at DPR ${deviceScaleFactor} must be forwarded.`);
        oneKey ||= click.windowKey; assert.equal(click.windowKey, oneKey);
        const expected = await one.evaluate(({ point, display }) => {
          const canvas = document.querySelector('canvas[data-cwb-owned]'), scale = Math.max(canvas.width / 1600, canvas.height / 900) * display.zoom;
          return { x: (point.x * canvas.width / innerWidth - (canvas.width - 1600 * scale) * display.positionX) / (1600 * scale),
            y: (point.y * canvas.height / innerHeight - (canvas.height - 900 * scale) * display.positionY) / (900 * scale) };
        }, { point, display });
        assert.ok(Math.abs(click.x - expected.x) < 1e-9); assert.ok(Math.abs(click.y - expected.y) < 1e-9);
        assert.deepEqual(Object.keys(click).sort(), ['generation', 'type', 'windowKey', 'x', 'y']);
      }
    }
    report.checks.push({ code: 'COVER_ZOOM_POSITION_MAP', deviceScaleFactor, cases: 6 });
    await two.mouse.click(500, 250); await delay(50);
    const other = presentation.drainPointers(1).find(value => value.type === 'click'); assert.ok(other); assert.notEqual(other.windowKey, oneKey);
    await one.getByRole('textbox').fill('AUTHORED INPUT MUST STAY LOCAL');
    await one.getByRole('button').click(); await delay(50);
    assert.equal(await one.evaluate(() => window.nativeClicks), 1);
    assert.equal(await one.getByRole('textbox').inputValue(), 'AUTHORED INPUT MUST STAY LOCAL');
    assert.ok(presentation.drainPointers(1).some(value => value.type === 'click'));
    report.checks.push({ code: 'NATIVE_CHAT_INPUT_CLICK_AND_WINDOW_ISOLATION', deviceScaleFactor });

    await one.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, pointerType: 'mouse', buttons: 0 }));
      document.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 100, button: 0, detail: 1 }));
    });
    await delay(60); assert.deepEqual(presentation.drainPointers(1), []);
    await one.getByRole('button').focus(); await one.keyboard.press('Enter'); await delay(50);
    assert.equal(await one.evaluate(() => window.nativeClicks), 2); assert.deepEqual(presentation.drainPointers(1), []);
    await one.keyboard.down('Control'); await one.mouse.click(400, 250); await one.keyboard.up('Control'); await delay(50);
    assert.deepEqual(presentation.drainPointers(1), []);
    await one.mouse.down(); await one.mouse.move(410, 255); await one.mouse.up(); await delay(50);
    assert.deepEqual(presentation.drainPointers(1), [], 'Text selection/drag must not produce a wallpaper click.');
    report.checks.push({ code: 'SYNTHETIC_KEYBOARD_MODIFIER_AND_DRAG_EXCLUSION', deviceScaleFactor });

    await presentation.setPointerMode({ enabled: false, generation: 1 }); await one.mouse.click(400, 250); await delay(50);
    assert.deepEqual(presentation.drainPointers(1), []);
    await presentation.setPointerMode({ enabled: true, generation: 1 }); await presentation.configure({ ...options, policy: { ...options.policy, paused: true } });
    await one.mouse.click(420, 260); await delay(50); assert.deepEqual(presentation.drainPointers(1), []);
    await presentation.configure(options); await presentation.invalidate(2); await presentation.setPointerMode({ enabled: true, generation: 2 });
    await one.mouse.click(440, 270); await delay(50); assert.deepEqual(presentation.drainPointers(2), [], 'A retained old frame must not control the new source.');
    await presentation.frame({ jpeg }, 2); await one.mouse.click(450, 280); await delay(50);
    assert.ok(presentation.drainPointers(2).some(value => value.type === 'click'));
    report.checks.push({ code: 'DISABLED_PAUSED_AND_GENERATION_FENCES', deviceScaleFactor });

    let received = 0;
    const raw = event => { const value = JSON.parse(event.data); if (value.method === 'Runtime.bindingCalled' && value.params?.name === presentation.pointerBinding) received++; };
    const source = presentation.windows.get(oneKey); source.client.ws.addEventListener('message', raw);
    const started = performance.now();
    for (let index = 0; index < 12; index++) await one.mouse.move(150 + index, 150 + index);
    await delay(45); const durationMs = performance.now() - started;
    source.client.ws.removeEventListener('message', raw);
    assert.ok(received > 0 && received <= Math.ceil(durationMs / (1000 / 30)) + 2);
    assert.ok(presentation.drainPointers(2).length <= 1);
    report.checks.push({ code: 'MOVE_RATE_AND_COALESCING', deviceScaleFactor, inputMoves: 12, bindingMessages: received, durationMs });

    const binding = presentation.pointerBinding; await presentation.restore();
    for (const page of [one, two]) {
      assert.equal(await page.locator('[data-cwb-owned]').count(), 0);
      assert.equal(await page.evaluate(name => typeof window[name], binding), 'undefined');
      await page.mouse.click(100, 100);
    }
    assert.deepEqual(presentation.drainPointers(2), []); report.checks.push({ code: 'RESTORE_REMOVES_BINDING_LISTENERS_AND_CANVAS', deviceScaleFactor });
    clearInterval(heartbeat); heartbeat = null;
    await context.close(); presentation = null;
    console.log(JSON.stringify({ completedDeviceScaleFactor: deviceScaleFactor, checks: report.checks.length }));
  }
  report.success = true;
} catch (error) { report.failure = { code: error.message, stack: String(error.stack).split('\n').slice(0, 6) }; throw error; }
finally {
  clearInterval(heartbeat);
  await presentation?.restore(); await browser.close(); report.finished = new Date().toISOString();
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, success: report.success || false, failure: report.failure, checks: report.checks.length }));
}
