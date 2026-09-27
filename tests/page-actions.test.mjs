import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_ACTIONS, createPageActions } from '../src/lib/page-actions.js';

/* A fake page window recording every hook the actions may touch. */
function fakeWin() {
  const log = [];
  return {
    log,
    location: { assign: (u) => log.push(['assign', u]), reload: () => log.push(['reload']) },
    history: { back: () => log.push(['back']), forward: () => log.push(['forward']) },
    __ARENAKIT_FLAGS__: new Proxy({}, { set(t, k, v) { t[k] = v; log.push(['flag', k, v]); return true; } }),
    __ARENAKIT__: { dispatch: (n, p) => { log.push(['dispatch', n, p]); return 1; }, send: (n, p) => log.push(['send', n, p]) },
    __AK_MANAGER_TOGGLE__: () => log.push(['manager']),
    __AK_ENI_SET__: (on, t) => log.push(['eni', on, t]),
    __AK_UNLOCK_SET__: (k, on) => log.push(['unlock', k, on]),
    __AK_PLUS_SET__: (on) => log.push(['plus', on]),
    ArenaProbe: { call: (a, g, r) => log.push(['probe', a, g, r]) },
    ArenaAccount: { call: (a, g, r) => log.push(['account', a, g, r]) },
  };
}

/* Evaluate the remote JS string against the same fake window: both transports
 * must produce the same effects. */
function evalAgainst(win, js) {
  const fn = new Function('window', 'location', 'with(window){' + js + '}');
  return fn(win, win.location);
}

const CASES = [
  ['dispatch', ['pulse-refresh', null], ['dispatch', 'pulse-refresh', null]],
  ['dispatch', ['x', { a: 1, s: 'q"\u2028' }], ['dispatch', 'x', { a: 1, s: 'q"\u2028' }]],
  ['open', ['https://arena.ai/agent/abc'], ['assign', 'https://arena.ai/agent/abc']],
  ['managerToggle', [], ['manager']],
  ['eniSet', [true, 'sys "prompt"\n</script>'], ['eni', true, 'sys "prompt"\n</script>']],
  ['unlockSet', ['opus', false], ['unlock', 'opus', false]],
  ['plusSet', [1], ['plus', true]],
  ['probeCall', ['rename', '{"sessionId":"s1"}', 'r7'], ['probe', 'rename', '{"sessionId":"s1"}', 'r7']],
  ['accountCall', ['restore', '{"cookies":[{"name":"arena-auth-prod-v1.0","value":"base64-x"}]}', 'r8'], ['account', 'restore', '{"cookies":[{"name":"arena-auth-prod-v1.0","value":"base64-x"}]}', 'r8']],
  ['flagSet', ['capture', false], ['flag', 'capture', false]],
  ['navBack', [], ['back']],
  ['navForward', [], ['forward']],
  ['reload', [], ['reload']],
];

test('remote js() and embedded run() have identical effects for every action', async () => {
  for (const [name, args, expected] of CASES) {
    const a = fakeWin();
    evalAgainst(a, PAGE_ACTIONS[name].js(...args));
    const b = fakeWin();
    PAGE_ACTIONS[name].run(b, ...args);
    assert.deepEqual(a.log, [expected], name + ' (js)');
    assert.deepEqual(b.log, [expected], name + ' (run)');
  }
});

test('every action tolerates a page where the hook is missing', () => {
  const bare = { location: { assign() {} } };
  for (const name of Object.keys(PAGE_ACTIONS)) {
    if (name === 'open') continue;
    assert.doesNotThrow(() => PAGE_ACTIONS[name].run(bare, 'a', 'b', 'c'), name);
    assert.doesNotThrow(() => evalAgainst(bare, PAGE_ACTIONS[name].js('a', 'b', 'c')), name + ' js');
  }
});

test('probeCall without probe.js answers the dock with a probe-result error', () => {
  const w = { __ARENAKIT__: { send: (n, p) => { w.sent = [n, p]; } } };
  PAGE_ACTIONS.probeCall.run(w, 'precheck', '{}', 'r1');
  assert.deepEqual(w.sent, ['probe-result', { reqId: 'r1', ok: false, error: '探针脚本未加载，请刷新 Arena 页面' }]);
  const w2 = { __ARENAKIT__: { send: (n, p) => { w2.sent = [n, p]; } } };
  evalAgainst(w2, PAGE_ACTIONS.probeCall.js('precheck', '{}', 'r1'));
  assert.deepEqual(w2.sent, w.sent);
});

test('accountCall without account.js answers the dock with an account-result error', () => {
  const w = { __ARENAKIT__: { send: (n, p) => { w.sent = [n, p]; } } };
  PAGE_ACTIONS.accountCall.run(w, 'snapshot', '{}', 'r1');
  assert.deepEqual(w.sent, ['account-result', { reqId: 'r1', ok: false, error: '账号脚本未加载，请刷新 Arena 页面' }]);
  const w2 = { __ARENAKIT__: { send: (n, p) => { w2.sent = [n, p]; } } };
  evalAgainst(w2, PAGE_ACTIONS.accountCall.js('snapshot', '{}', 'r1'));
  assert.deepEqual(w2.sent, w.sent);
});

test('createPageActions: remote transport evals, embedded transport runs; failures reject alike', async () => {
  const evals = [];
  const remote = createPageActions({ evalInPage: (js) => { evals.push(js); return Promise.resolve(); } });
  await remote('plusSet', true);
  assert.deepEqual(evals, [PAGE_ACTIONS.plusSet.js(true)]);
  await assert.rejects(remote('nope'), /未知页面动作/);
  const failing = createPageActions({ evalInPage: () => Promise.reject(new Error('webview gone')) });
  await assert.rejects(failing('managerToggle'), /webview gone/);

  const w = fakeWin();
  const embedded = createPageActions({ win: w });
  await embedded('unlockSet', 'hidden', true);
  assert.deepEqual(w.log, [['unlock', 'hidden', true]]);
  w.__AK_PLUS_SET__ = () => { throw new Error('boom'); };
  await assert.rejects(embedded('plusSet', true), /boom/);
  await assert.rejects(createPageActions({})('plusSet', true), /没有可用的页面通道/);
});
