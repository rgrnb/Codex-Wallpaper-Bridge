import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
const binding = '__cwbPointer' + 'a'.repeat(24), token = 'b'.repeat(32);
async function fixture() {
  const listeners = new Map(), connected = new Set(), timeouts = new Map(), output = [];
  let now = 0, nextTimer = 0, focused = true;
  class Canvas {
    constructor() { this.width = 0; this.height = 0; this.dataset = {}; this.style = {}; }
    get isConnected() { return connected.has(this); }
    getContext() { return { drawImage() {}, clearRect() {} }; }
    remove() { connected.delete(this); }
  }
  const document = { hidden: false,
    hasFocus: () => focused,
    querySelector: () => ({}), querySelectorAll: () => [],
    createElement: name => name === 'canvas' ? new Canvas() : { dataset: {}, remove() { connected.delete(this); } },
    head: { appendChild(value) { connected.add(value); } }, body: { prepend(value) { connected.add(value); } },
    addEventListener(name, callback, options) { listeners.set(name, { callback, options }); },
    removeEventListener(name, callback) { if (listeners.get(name)?.callback === callback) listeners.delete(name); },
  };
  const window = { [binding]: value => output.push(JSON.parse(value)), addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, document, innerWidth: 800, innerHeight: 600, devicePixelRatio: 1.5,
    HTMLCanvasElement: Canvas, Blob, Uint8Array, atob, Date, performance: { now: () => now },
    setTimeout(callback, duration) { const id = ++nextTimer; timeouts.set(id, { callback, at: now + duration }); return id; },
    clearTimeout: id => timeouts.delete(id), setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    createImageBitmap: async () => ({ width: 1600, height: 900, close() {} }),
  });
  vm.runInContext(source, context);
  const api = window.__codexWallpaperBridgeV1;
  const options = { effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 2073600 } };
  api.install(options, { root: '#root', main: 'main' }); await api.frame(5, 'AA==');
  api.pointerMode({ enabled: true, generation: 5, binding, token });
  const dispatch = (type, values = {}) => listeners.get(type)?.callback({ type, isTrusted: true, pointerType: 'mouse', pointerId: 1,
    clientX: 400, clientY: 300, button: 0, buttons: 0, detail: 1, ...values });
  const advance = duration => {
    const until = now + duration;
    for (;;) {
      const next = [...timeouts].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      now = next[1].at; timeouts.delete(next[0]); next[1].callback();
    }
    now = until;
  };
  return { api, options, dispatch, advance, output, listeners, document, focus: value => { focused = value; } };
}

test('passive renderer observations never intercept native input and sustain at most 30 move messages per second', async () => {
  const f = await fixture();
  for (const event of ['pointermove', 'click', 'pointerdown', 'pointerup', 'pointercancel']) {
    assert.equal(f.listeners.get(event).options.capture, true); assert.equal(f.listeners.get(event).options.passive, true);
  }
  // Handlers receive no preventDefault/stopPropagation method: interception
  // would fail this test rather than silently altering the host input event.
  for (let milliseconds = 0; milliseconds < 1000; milliseconds++) {
    for (let index = 0; index < 5; index++) f.dispatch('pointermove', { clientX: 100 + index });
    f.advance(1);
  }
  assert.ok(f.output.length >= 29 && f.output.length <= 31);
  assert.ok(f.output.every(value => value.type === 'move' && value.token === token && value.generation === 5));
  assert.ok(f.output.every((value, index) => index === 0 || value.sequence > f.output[index - 1].sequence));
  f.api.restore(); assert.equal(f.listeners.size, 0);
});

test('renderer maps Cover crops exactly and rejects drag, keyboard, synthetic, hidden and unfocused observations', async () => {
  const f = await fixture();
  f.dispatch('click'); assert.equal(f.output.length, 1); assert.equal(f.output[0].x, 0.5); assert.equal(f.output[0].y, 0.5);
  f.api.configure({ ...f.options, display: { zoom: 2, positionX: 1, positionY: 0 } });
  f.dispatch('click'); assert.ok(Math.abs(f.output[1].x - 0.8125) < 1e-12); assert.equal(f.output[1].y, 0.25);
  f.output.length = 0;
  for (const value of [{ isTrusted: false }, { detail: 0 }, { ctrlKey: true }, { button: 2 }, { clientX: -1 }, { buttons: 1 }]) f.dispatch('click', value);
  f.dispatch('pointermove', { pointerType: 'touch' }); f.advance(40); assert.equal(f.output.length, 0);
  f.dispatch('pointerdown', { buttons: 1 }); f.dispatch('pointermove', { clientX: 500, buttons: 1 });
  f.dispatch('pointerup', { clientX: 500 }); f.dispatch('click', { clientX: 500 }); f.advance(40); assert.equal(f.output.length, 0);
  f.focus(false); f.dispatch('click'); f.focus(true); f.document.hidden = true; f.dispatch('click');
  assert.equal(f.output.length, 0); f.document.hidden = false;
  f.api.configure({ ...f.options, policy: { ...f.options.policy, paused: true } }); f.dispatch('click'); assert.equal(f.output.length, 0);
  f.api.restore();
});

test('queued movement is cancelled by generation invalidation or mode change and retained old frames never receive new input', async () => {
  const f = await fixture(); f.dispatch('pointermove'); f.api.invalidate(6); f.advance(40); assert.equal(f.output.length, 0);
  f.api.pointerMode({ enabled: true, generation: 6, binding, token }); f.dispatch('click'); assert.equal(f.output.length, 0);
  await f.api.frame(6, 'AA=='); f.dispatch('pointermove'); f.api.pointerMode({ enabled: false, generation: 6, binding, token });
  f.advance(40); assert.equal(f.output.length, 0);
  f.api.pointerMode({ enabled: true, generation: 6, binding, token }); f.dispatch('click'); assert.equal(f.output.length, 1);
  f.api.restore(); assert.equal(f.listeners.size, 0);
});
