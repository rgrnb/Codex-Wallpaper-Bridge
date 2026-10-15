import test from 'node:test';
import assert from 'node:assert/strict';
import { Presentation } from '../src/presentation.mjs';
test('closing one window detaches it without stopping another window (AT-15)', async () => {
  const p = new Presentation({}, { event: async () => {} }); let closed = 0;
  p.windows.set('closed', { client: { evaluate: async () => { throw new Error('CDP_CLOSED'); }, close() { closed++; } } });
  p.windows.set('live', { generation: 12, client: { evaluate: async () => ({ installed: true, compatible: true, visible: true, fps: 15 }), close() { throw new Error('Must not close live window'); } } });
  await p.heartbeat(); assert.equal(closed, 1); assert.equal(p.windows.size, 1);
  assert.equal(p.windows.get('live').generation, 12); assert.equal(p.visibleCount, 1);
});

test('an auxiliary or unready page cannot prevent another Codex window from attaching', async () => {
  const clients = new Map();
  const p = new Presentation({ verifiedVersions: ['26.1007.1'], selectors: { root: '#root', main: 'main.shell' } }, { async event() {} }, {
    discover: async () => [{ id: 'main' }, { id: 'auxiliary' }],
    connect: async target => {
      let evaluations = 0;
      const client = { closed: false, close() { this.closed = true; }, async evaluate() {
        evaluations++;
        if (evaluations === 1) return { compatible: target.id === 'main', ready: true };
        return { compatible: true, visible: true };
      } }; clients.set(target.id, client); return client;
    },
  });
  await p.configure({}); const status = await p.reconcile([9336], '26.1007.1', false);
  assert.equal(status.count, 1); assert.equal(status.pending, 1);
  assert.equal(clients.get('main').closed, false); assert.equal(clients.get('auxiliary').closed, true);
  await p.restore();
});

test('restore cancels a delayed connection before it can reapply an owned runtime', async () => {
  let release, closed = false, evaluated = false;
  const p = new Presentation({ verifiedVersions: ['26.1007.1'], selectors: { root: '#root', main: 'main' } }, { async event() {} }, {
    discover: async () => [{ id: 'delayed' }],
    connect: () => new Promise(resolve => { release = () => resolve({ close() { closed = true; }, async evaluate() { evaluated = true; } }); }),
  });
  const reconciling = p.reconcile([9336], '26.1007.1', false); await new Promise(resolve => setImmediate(resolve));
  await p.restore(); release(); await reconciling;
  assert.equal(closed, true); assert.equal(evaluated, false); assert.equal(p.windows.size, 0); assert.equal(p.pending.size, 0);
});

test('a window closing during configure/frame or endpoint discovery cannot reset another live window', async () => {
  const make = () => new Presentation({ verifiedVersions: ['26.1007.1'], selectors: { root: '#root', main: 'main' } }, { async event() {} }, {
    discover: async port => { if (port === 9336) throw new Error('fetch failed'); return [{ id: 'live' }]; },
  });
  for (const operation of ['configure', 'frame', 'invalidate']) {
    const p = make(); let liveCalls = 0;
    p.windows.set('closed', { visible: true, client: { async evaluate() { throw new Error('CDP_CLOSED'); }, close() {} } });
    p.windows.set('9338:live', { visible: true, generation: 7, client: { async evaluate() { liveCalls++; return true; }, close() { assert.fail('Live client must remain connected'); } } });
    await p[operation](operation === 'configure' ? {} : operation === 'frame' ? { jpeg: 'owned-frame' } : 8, 8);
    assert.equal(p.windows.size, 1); assert.equal(liveCalls, 1);
    await p.reconcile([9336, 9338], '26.1007.1', false);
    assert.equal(p.windows.size, 1);
  }
});

test('a hidden native video window defers loading without blocking visible window playback', async () => {
  const p = new Presentation({}, { async event() {} });
  p.windows.set('hidden', { visible: false, generation: 4, client: { call() { assert.fail('Hidden Chromium media must wait for resume.'); } } });
  assert.equal(await p.video({}, 5, () => true), true);
  assert.equal(p.windows.get('hidden').generation, 4);
});
