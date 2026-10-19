import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
const ticket = { url: `https://persistent.oaistatic.com/__cwb_frame/${'a'.repeat(32)}/1`, proof: 'b'.repeat(64), size: 3 };
function response(body = new Uint8Array([1, 2, 3]), proof = ticket.proof) {
  return new Response(body, { headers: { 'Content-Type': 'image/jpeg', 'X-Cwb-Frame-Proof': proof } });
}
function fixture(fetch) {
  const nodes = new Set(), bitmaps = [], requests = [], timers = new Map(); let timerId = 0;
  class Canvas {
    constructor() { this.width = 0; this.height = 0; this.dataset = {}; this.style = {}; }
    get isConnected() { return nodes.has(this); }
    getContext() { return { drawImage() {}, clearRect() {} }; }
    remove() { nodes.delete(this); }
  }
  const document = { hidden: false, querySelector: () => ({}), querySelectorAll: () => [],
    createElement: tag => tag === 'canvas' ? new Canvas() : { dataset: {}, remove() { nodes.delete(this); } },
    head: { appendChild(node) { nodes.add(node); } }, body: { prepend(node) { nodes.add(node); } }, addEventListener() {}, removeEventListener() {} };
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(source, { window, document, HTMLCanvasElement: Canvas, innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    Date, performance, Blob, Uint8Array, AbortController, atob,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    async fetch(url, options) { requests.push({ url, options }); return fetch(url, options); },
    async createImageBitmap(blob) { const image = { width: 640, height: 360, bytes: [...new Uint8Array(await blob.arrayBuffer())], closed: false,
      close() { this.closed = true; } }; bitmaps.push(image); return image; },
  });
  const api = window.__codexWallpaperBridgeV1;
  const options = { effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 2073600 } }, selectors = { root: '#root', main: 'main' };
  api.install(options, selectors);
  return { api, requests, nodes, bitmaps, timers, reinstall: () => api.install(options, selectors) };
}

test('binary renderer accepts only an authenticated bounded response, retains cover geometry and closes its bitmap on Restore', async () => {
  const f = fixture(async () => response());
  assert.equal(await f.api.frameFromUrl(2, ticket), true); assert.equal(f.api.ping().generation, 2);
  assert.deepEqual(f.bitmaps[0].bytes, [1, 2, 3]); assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.redirect, 'error'); assert.equal(f.requests[0].options.cache, 'no-store');
  assert.equal(f.timers.size, 0); f.api.restore(); assert.equal(f.bitmaps[0].closed, true); assert.equal(f.nodes.size, 0);
});

test('binary renderer rejects arbitrary URLs, wrong proofs, body overflow and truncation without replacing a valid frame', async () => {
  let next = response(); const f = fixture(async () => next);
  for (const value of [{ ...ticket, url: 'https://example.com/frame' }, { ...ticket, url: ticket.url + '/../private' }, { ...ticket, size: 5 * 1024 ** 2 }, { ...ticket, proof: '' }])
    assert.equal(await f.api.frameFromUrl(2, value), false);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.api.frameFromUrl(2, ticket), true);
  for (const [value, error] of [[response(new Uint8Array([1, 2, 3]), 'wrong'), /IDENTITY_INVALID/],
    [response(new Uint8Array([1, 2, 3, 4])), /SIZE_INVALID/], [response(new Uint8Array([1, 2])), /SIZE_INVALID/]]) {
    next = value; await assert.rejects(f.api.frameFromUrl(3, ticket), error);
    assert.equal(f.api.ping().generation, 2); assert.equal(f.bitmaps.length, 1); assert.equal(f.bitmaps[0].closed, false);
  }
  f.api.restore();
});

test('a wrong proof cancels the response body before consuming any bytes', async () => {
  let cancelled = false, read = false;
  const f = fixture(async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg', 'X-Cwb-Frame-Proof': 'wrong' }),
    body: { getReader() { read = true; throw new Error('Must not consume unverified content'); }, async cancel() { cancelled = true; } } }));
  await assert.rejects(f.api.frameFromUrl(2, ticket), /IDENTITY_INVALID/);
  assert.equal(read, false); assert.equal(cancelled, true); f.api.restore();
});

test('invalidation and Restore abort pending binary fetches; late successful responses cannot resurrect an old frame', async () => {
  for (const action of ['invalidate', 'restore', 'reinstall']) {
    let resolve; const f = fixture(() => new Promise(accept => { resolve = accept; }));
    const loading = f.api.frameFromUrl(2, ticket);
    if (action === 'invalidate') f.api.invalidate(3); else if (action === 'restore') f.api.restore(); else f.reinstall();
    assert.equal(f.requests[0].options.signal.aborted, true);
    resolve(response()); assert.equal(await loading, false); assert.equal(f.bitmaps.length, 0); assert.equal(f.nodes.size, 0);
    assert.equal(f.timers.size, 0); f.api.restore();
  }
});

test('binary fetch timeout aborts the read and releases the renderer frame slot', async () => {
  const f = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Authored fetch aborted')))));
  const loading = assert.rejects(f.api.frameFromUrl(2, ticket), /fetch aborted/);
  [...f.timers.values()][0](); await loading; assert.equal(f.timers.size, 0);
  f.api.restore();
});
