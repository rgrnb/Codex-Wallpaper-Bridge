import test from 'node:test';
import assert from 'node:assert/strict';
import { PointerEvents } from '../src/pointer-events.mjs';
import { Presentation } from '../src/presentation.mjs';

const token = '1234567890abcdef1234567890abcdef';
const mode = { enabled: true, visible: true, generation: 5, token };
const payload = (sequence, values = {}) => JSON.stringify({ token, generation: 5, sequence, type: 'move', x: 0.3, y: 0.6, ...values });

test('pointer events contain only normalized coordinates and reject malformed, stale or replayed payloads', () => {
  const queue = new PointerEvents({ clock: () => 1000 });
  for (const value of [null, '', '{', 'x'.repeat(513), '{}', '[]', payload(1, { text: 'must never cross the boundary' }),
    payload(1, { generation: 4 }), payload(1, { token: 'different' }), payload(0), payload(1, { x: 2 }),
    payload(1, { type: 'keydown' }), payload(1, { y: null })]) assert.equal(queue.accept('one', value, mode), false);
  assert.equal(queue.accept('one', payload(2), { ...mode, enabled: false }), false);
  assert.equal(queue.accept('one', payload(2), { ...mode, visible: false }), false);
  assert.equal(queue.accept('one', payload(2), mode), true);
  assert.equal(queue.accept('one', payload(2), mode), false);
  assert.equal(queue.accept('one', payload(1), mode), false);
  assert.deepEqual(queue.drain(5, () => true), [{ windowKey: 'one', generation: 5, type: 'move', x: 0.3, y: 0.6, receivedAt: 1000 }]);
  assert.deepEqual(queue.drain(5, () => true), []);
  assert.equal(queue.accept('one', payload(2), mode), false, 'Draining must not reset the replay fence.');
});

test('movement coalesces, click queues stay bounded, and each window keeps an independent sequence', () => {
  const queue = new PointerEvents();
  for (let sequence = 1; sequence <= 1000; sequence++) queue.accept('one', payload(sequence), mode);
  for (let sequence = 1001; sequence <= 1020; sequence++) queue.accept('one', payload(sequence, { type: 'click', x: sequence / 10000 }), mode);
  queue.accept('one', payload(1021, { x: 0.9 }), mode);
  queue.accept('two', payload(1, { y: 0.2 }), mode);
  const events = queue.drain(5, () => true);
  assert.equal(events.length, 10); assert.equal(events.filter(event => event.type === 'click').length, 8);
  assert.equal(events[0].x, 1013 / 10000); assert.equal(events.at(-2).x, 0.9); assert.equal(events.at(-1).windowKey, 'two');
  assert.equal(queue.rows.size, 2);
});

test('paused, replaced, closed and old input cannot reach a later playback session', () => {
  let now = 1000; const queue = new PointerEvents({ clock: () => now });
  queue.accept('one', payload(1), mode); now += 251; assert.deepEqual(queue.drain(5, () => true), []);
  queue.accept('one', payload(2), mode); assert.deepEqual(queue.drain(6, () => true), []);
  queue.accept('one', payload(3), mode); assert.deepEqual(queue.drain(5, () => false), []); assert.equal(queue.rows.size, 0);
  queue.accept('one', payload(4), mode); queue.remove('one'); assert.deepEqual(queue.drain(5, () => true), []);
  queue.accept('one', payload(5), mode); queue.clear(); assert.deepEqual(queue.drain(5, () => true), []);
});

test('input keeps receive order when focus moves between windows', () => {
  const queue = new PointerEvents();
  queue.accept('one', payload(1, { type: 'click' }), mode);
  queue.accept('two', payload(1, { type: 'click' }), mode);
  queue.accept('one', payload(2, { type: 'click' }), mode);
  assert.deepEqual(queue.drain(5, () => true).map(event => event.windowKey), ['one', 'two', 'one']);
});

test('Presentation accepts only its own binding and current visible window, then detaches the listener', async () => {
  const presentation = new Presentation({}, { async event() {} });
  const ws = new EventTarget(), evaluations = [];
  const window = { generation: 5, visible: true, client: { ws, async call() {}, async evaluate(value) { evaluations.push(value); }, close() {} } };
  presentation.windows.set('one', window); await presentation.attachPointer('one', window);
  await presentation.setPointerMode({ enabled: true, generation: 5 });
  const send = (sequence, values = {}, name = presentation.pointerBinding) => ws.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { name,
      payload: JSON.stringify({ token: presentation.pointerMode.token, generation: 5, sequence, type: 'move', x: 0.3, y: 0.6, ...values }) } }) }));
  send(1, {}, 'anotherBinding'); assert.deepEqual(presentation.drainPointers(5), []);
  send(1); assert.equal(presentation.drainPointers(5).length, 1);
  window.visible = false; send(2); assert.deepEqual(presentation.drainPointers(5), []);
  window.visible = true; send(2); await presentation.setPointerMode({ enabled: false, generation: 5 });
  assert.deepEqual(presentation.drainPointers(5), []); send(3); assert.deepEqual(presentation.drainPointers(5), []);
  await presentation.setPointerMode({ enabled: true, generation: 6 }); send(4); assert.deepEqual(presentation.drainPointers(6), []);
  window.generation = 6; send(5, { generation: 6 }); assert.equal(presentation.drainPointers(6).length, 1);
  window.detachPointer(); send(6, { generation: 6 }); assert.deepEqual(presentation.drainPointers(6), []);
  assert.equal(window.pointerAvailable, false); assert.ok(evaluations.length >= 4);
});
