import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Presentation } from '../src/presentation.mjs';

test('a legacy controller takeover restores and adopts its pixels in one renderer task', async () => {
  const calls = [], connected = new Set(), sentinel = { color: 'red' };
  class Canvas {
    constructor() { this.width = 640; this.height = 480; this.dataset = {}; this.style = {}; this.pixels = null; }
    get isConnected() { return connected.has(this); }
    getContext() { return { drawImage: source => { this.pixels = source.pixels; calls.push(this.isConnected ? 'adopt' : 'snapshot'); } }; }
    remove() { connected.delete(this); }
  }
  const oldCanvas = new Canvas(); oldCanvas.pixels = sentinel; oldCanvas.dataset.cwbOwned = 'v1'; connected.add(oldCanvas);
  const listeners = new Set(), intervals = new Set();
  const document = {
    readyState: 'complete', hidden: false,
    querySelector(selector) {
      if (selector.startsWith('canvas')) return [...connected].find(node => node instanceof Canvas) || null;
      if (selector === '#root' || selector === 'main') return {};
      return null;
    },
    querySelectorAll() { return [...connected]; },
    createElement(tag) {
      if (tag === 'canvas') return new Canvas();
      return { dataset: {}, get isConnected() { return connected.has(this); }, remove() { connected.delete(this); } };
    },
    head: { appendChild(node) { connected.add(node); } }, body: { prepend(node) { connected.add(node); } },
    addEventListener(name, handler) { listeners.add(handler); }, removeEventListener(name, handler) { listeners.delete(handler); },
  };
  const window = { addEventListener(name, handler) { listeners.add(handler); }, removeEventListener(name, handler) { listeners.delete(handler); } };
  window.__codexWallpaperBridgeV1 = { restore() { calls.push('restore'); oldCanvas.remove(); delete window.__codexWallpaperBridgeV1; } };
  const context = vm.createContext({ window, document, HTMLCanvasElement: Canvas, Date, performance,
    setInterval(callback) { const id = {}; intervals.add(id); return id; }, clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame() { assert.fail('Snapshot adoption must complete synchronously.'); }, cancelAnimationFrame() {},
  });
  let evaluations = 0;
  const client = { async evaluate(expression) { evaluations++; return vm.runInContext(expression, context); }, close() {} };
  const adapter = { verifiedVersions: ['26.1007.1'], selectors: { root: '#root', main: 'main', sidebar: 'aside', composer: '.composer' } };
  const presentation = new Presentation(adapter, { async event() {} }, { discover: async () => [{ id: 'owned' }], connect: async () => client });
  await presentation.configure({ effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 1000000 }, display: { zoom: 3, positionX: 1, positionY: 1 } });
  const status = await presentation.reconcile([9336], '26.1007.1', false);
  assert.equal(status.count, 1); assert.equal(evaluations, 2, 'Structure check plus one atomic installation evaluation.');
  assert.deepEqual(calls, ['snapshot', 'restore', 'adopt']);
  const canvas = [...connected].find(node => node instanceof Canvas);
  assert.equal(canvas.pixels, sentinel); assert.notEqual(canvas, oldCanvas);
  assert.equal([...connected].filter(node => node instanceof Canvas).length, 1);
  assert.equal(window.__codexWallpaperBridgeV1.runtimeVersion, 5);
  assert.equal(window.__codexWallpaperBridgeV1.ping().generation, -1);
  assert.equal(window.__codexWallpaperBridgeV1.ping().display.zoom, 1, 'An already-composited snapshot must not be cropped again.');
  await presentation.restore(); assert.equal(connected.size, 0); assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
});
