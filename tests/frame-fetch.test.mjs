import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameFetch, MAX_FRAME_BYTES } from '../src/frame-fetch.mjs';
import { Presentation } from '../src/presentation.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const ws = new EventTarget(), calls = []; let now = 1000;
  const client = { ws, close() {}, async evaluate() { return true; }, async call(method, params = {}) {
    calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'owned-root', loaderId: 'document-one' } } };
    if (method === 'Runtime.evaluate') return { result: { value: 'app://-', objectId: 'owned-global' } };
    return { result: { value: true } };
  } };
  const emit = (method, params) => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) }));
  const request = (ticket, patch = {}) => emit('Fetch.requestPaused', { requestId: 'owned-request', frameId: 'owned-root',
    request: { method: 'GET', url: ticket.url }, ...patch });
  return { client, calls, emit, request, advance: ms => { now += ms; }, transport: new FrameFetch(client, { clock: () => now }) };
}
const frame = { jpeg: Buffer.from('authored JPEG fixture bytes').toString('base64') };

test('binary frames use one exact private route and a response proof that never appears in the request URL', async () => {
  const f = fixture(), ticket = await f.transport.offer(frame, 7);
  assert.equal(ticket.size, Buffer.byteLength(frame.jpeg, 'base64')); assert.ok(!ticket.url.includes(ticket.proof));
  const enabled = f.calls.find(row => row.method === 'Fetch.enable');
  assert.deepEqual(enabled.params.patterns, [{ urlPattern: `${f.transport.prefix}*`, requestStage: 'Request' }]);
  f.request(ticket); await tick();
  const response = f.calls.find(row => row.method === 'Fetch.fulfillRequest');
  assert.equal(response.params.body, frame.jpeg); assert.equal(response.params.responseCode, 200);
  const headers = Object.fromEntries(response.params.responseHeaders.map(row => [row.name, row.value]));
  assert.equal(headers['X-Cwb-Frame-Proof'], ticket.proof); assert.equal(headers['Access-Control-Allow-Origin'], 'app://-');
  assert.equal(headers['Cache-Control'], 'no-store');
  f.request(ticket); await tick(); assert.equal(f.calls.filter(row => row.method === 'Fetch.fulfillRequest').length, 1, 'A ticket is single-use.');
  assert.equal(f.calls.filter(row => row.method === 'Fetch.failRequest').length, 1);
  const count = f.calls.length; f.request({ url: 'https://persistent.oaistatic.com/official-resource' }); await tick();
  assert.equal(f.calls.length, count, 'Unrelated app requests must not be inspected or altered.');
  await f.transport.stop(); await f.transport.stop();
  assert.equal(f.calls.filter(row => row.method === 'Fetch.disable').length, 1);
  assert.ok(f.calls.every(row => row.method !== 'Fetch.continueRequest'));
});

test('wrong document, method, old frame, expired ticket and invalidation all reject the private request without frame bytes', async () => {
  for (const variation of ['document', 'method', 'old', 'expired', 'invalidated', 'navigated']) {
    const f = fixture(), ticket = await f.transport.offer(frame, 7); let patch = {};
    if (variation === 'document') patch.frameId = 'unowned-child';
    if (variation === 'method') patch.request = { method: 'POST', url: ticket.url };
    if (variation === 'old') await f.transport.offer(frame, 7);
    if (variation === 'expired') f.advance(5001);
    if (variation === 'invalidated') f.transport.invalidate();
    if (variation === 'navigated') f.emit('Page.frameNavigated', { frame: { id: 'owned-root', loaderId: 'document-two' } });
    f.request(ticket, patch); await tick();
    assert.equal(f.calls.filter(row => row.method === 'Fetch.fulfillRequest').length, 0, variation);
    assert.equal(f.calls.filter(row => row.method === 'Fetch.failRequest').length, 1, variation);
    await f.transport.stop();
  }
});

test('stop and invalidation win against a pending route allocation, and oversized payloads never enable interception', async () => {
  let release;
  const f = fixture({ 'Page.getFrameTree': () => new Promise(resolve => { release = () => resolve({ frameTree: { frame: { id: 'owned-root', loaderId: 'one' } } }); }) });
  const offering = assert.rejects(f.transport.offer(frame, 1), /FRAME_FETCH_CLOSED/); await tick();
  const stopping = f.transport.stop(); release(); await offering; await stopping;
  assert.ok(f.calls.every(row => row.method !== 'Fetch.enable'));
  const oversized = fixture();
  await assert.rejects(oversized.transport.offer({ jpeg: 'a'.repeat(6 * 1024 * 1024 + 1) }, 1), /PAYLOAD_INVALID/);
  assert.equal(oversized.calls.length, 0); assert.equal(MAX_FRAME_BYTES, 4.5 * 1024 * 1024);
  let enable;
  const racing = fixture({ 'Fetch.enable': () => new Promise(resolve => { enable = resolve; }) });
  const pending = assert.rejects(racing.transport.offer(frame, 1), /FRAME_FETCH_STALE/);
  while (!enable) await tick(); racing.transport.invalidate(); enable({}); await pending;
  assert.equal(racing.transport.frame, null); await racing.transport.stop();
});

test('a failed fulfillment is consumed and closing removes every listener without continuing requests', async () => {
  const f = fixture({ 'Fetch.fulfillRequest': async () => { throw new Error('CDP_CLOSED'); } });
  const ticket = await f.transport.offer(frame, 1); f.request(ticket); await tick();
  assert.equal(f.transport.requests.size, 0); f.client.ws = null; await f.transport.stop();
  const count = f.calls.length; f.request(ticket); await tick(); assert.equal(f.calls.length, count);
});

test('real client presentation passes only a small ticket to JavaScript and releases its binary route on Restore', async () => {
  const f = fixture(), p = new Presentation({}, { async event() {} });
  const window = { client: f.client, target: { webSocketDebuggerUrl: 'ws://127.0.0.1:19344/devtools/page/owned' }, visible: true };
  p.windows.set('owned', window); await p.frame(frame, 9);
  const invoke = f.calls.find(row => row.method === 'Runtime.callFunctionOn');
  assert.match(invoke.params.functionDeclaration, /frameFromUrl/);
  assert.equal(typeof invoke.params.arguments[1].value, 'object');
  assert.ok(!JSON.stringify(invoke.params).includes(frame.jpeg)); assert.equal(window.generation, 9);
  await p.invalidate(10); assert.equal(window.frameFetch.frame, null);
  await p.restore(); assert.equal(window.frameFetch.ready, false); assert.equal(p.windows.size, 0);
});
