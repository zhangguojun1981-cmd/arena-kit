import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../src/lib/rpc.js';

function harness(sendImpl) {
  const evals = [];
  const timers = [];
  const rpc = createRpc({
    send: (action, argsJson, reqId) => { evals.push({ action, argsJson, reqId }); return sendImpl ? sendImpl(action) : Promise.resolve(); },
    timeoutMs: 1000,
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { t.cleared = true; },
  });
  return { rpc, evals, timers };
}

test('call hands (action, argsJson, reqId) to the transport and resolves on delivery', async () => {
  const h = harness();
  const p = h.rpc.call('rename', { sessionId: 's1', title: 'x"y' });
  await Promise.resolve();
  assert.equal(h.evals.length, 1);
  assert.deepEqual(h.evals[0], { action: 'rename', argsJson: JSON.stringify({ sessionId: 's1', title: 'x"y' }), reqId: 'r1' });
  assert.equal(h.rpc.pendingCount, 1);
  assert.equal(h.rpc.deliver({ reqId: 'r1', ok: true, data: { title: 'x"y' } }), true);
  assert.deepEqual(await p, { title: 'x"y' });
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.rpc.pendingCount, 0);
});

test('error results reject with the page message; unknown ids are ignored', async () => {
  const h = harness();
  const p = h.rpc.call('archive', { sessionId: 's1' });
  assert.equal(h.rpc.deliver({ reqId: 'nope', ok: true }), false);
  assert.equal(h.rpc.deliver(null), false);
  h.rpc.deliver({ reqId: 'r1', ok: false, error: '未找到唯一的 Archive 入口' });
  await assert.rejects(p, /未找到唯一的 Archive 入口/);
  const p2 = h.rpc.call('x');
  h.rpc.deliver({ reqId: 'r2', ok: false });
  await assert.rejects(p2, /x 失败/);
});

test('timeout rejects and clears the waiter', async () => {
  const h = harness();
  const p = h.rpc.call('sidebarList', {}, { timeout: 5 });
  assert.equal(h.timers[0].ms, 5);
  h.timers[0].fn();
  await assert.rejects(p, /sidebarList 超时/);
  assert.equal(h.rpc.deliver({ reqId: 'r1', ok: true }), false);
});

test('transport failure rejects immediately; cancelAll rejects everything pending', async () => {
  const h = harness(() => Promise.reject(new Error('webview gone')));
  await assert.rejects(h.rpc.call('precheck'), /无法执行页面脚本: webview gone/);
  const ok = harness();
  const a = ok.rpc.call('a'), b = ok.rpc.call('b');
  ok.rpc.cancelAll('停止');
  await assert.rejects(a, /停止/);
  await assert.rejects(b, /停止/);
  assert.equal(ok.rpc.pendingCount, 0);
});
