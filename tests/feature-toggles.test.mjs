import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected } from './helpers.mjs';

/* 更多 → 功能模块 switches. Before, the dock called window.__AK_UNLOCK_SET__
 * and window.__AK_PLUS_SET__ but no page script defined them: the switches
 * were saved in the dock and did nothing. These tests run the real injected
 * modules in a sandbox and check that the switches reach them. */

const storage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};

function unlockPage(ls = storage()) {
  const sb = {
    localStorage: ls, console, JSON, Object, Array, String, Math,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    fetch: async () => ({ headers: { get: () => '' } }),
    Response: class {},
  };
  sb.self = sb; sb.window = sb;
  return runInjected('injected/unlock.js', sb);
}
// A Next.js flight chunk the way arena ships its model list.
const chunk = (name) => `{"initialModels":[{"publicName":"${name}","padding":"${'x'.repeat(80)}","userSelectable":false}]}`;

test('unlock.js: default settings unlock Opus only; __AK_UNLOCK_SET__ persists the dock switches for the next load', () => {
  let w = unlockPage();
  assert.equal(typeof w.__AK_UNLOCK_SET__, 'function', 'dock hook defined');
  w.__next_f.push([1, chunk('claude-opus-4-1')]);
  w.__next_f.push([1, chunk('secret-blind-model')]);
  assert.match(w.__next_f[0][1], /"userSelectable":true/, 'Opus unlocked by default');
  assert.match(w.__next_f[1][1], /"userSelectable":false/, 'hidden models stay hidden by default');

  // dock: 解锁隐藏 / 盲测模型 on, 解锁 Opus 全系 off → stored for the next document
  const ls = storage();
  w = unlockPage(ls);
  assert.deepEqual({ ...w.__AK_UNLOCK_SET__('hidden', true) }.ok, true);
  assert.equal(w.__AK_UNLOCK_SET__('opus', false).changed, true);
  assert.equal(w.__AK_UNLOCK_SET__('bogus', true).ok, false);
  assert.deepEqual(JSON.parse(ls.getItem('_at')), { h: true, o: false });

  // next page load reads them
  w = unlockPage(ls);
  w.__next_f.push([1, chunk('secret-blind-model')]);
  assert.match(w.__next_f[0][1], /"userSelectable":true/, 'hidden model unlocked after the reload');
  assert.deepEqual({ ...w.__AK_UNLOCK_GET__() }, { h: true, o: false });
});

test('plus.js: __AK_PLUS_SET__ is defined and switching it off skips the leaderboard columns on the next load', () => {
  const run = (ls) => {
    const sb = {
      localStorage: ls, console: { log() {}, warn() {}, error() {}, debug() {} },
      document: { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, body: { appendChild() {} } },
      MutationObserver: class { observe() {} disconnect() {} },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: false, json: async () => ({}) }),
      location: { hostname: 'arena.ai', pathname: '/leaderboard', href: 'https://arena.ai/leaderboard' },
      addEventListener() {}, JSON, Object, Array, String, Number, Math, Date, Map, Set, Promise,
    };
    sb.window = sb; sb.self = sb;
    return runInjected('injected/plus.js', sb);
  };
  const ls = storage();
  const w = run(ls);
  assert.equal(typeof w.__AK_PLUS_SET__, 'function', 'dock hook defined');
  assert.equal(w.__AK_PLUS_SET__(false).ok, true);
  assert.equal(ls.getItem('arenakit.plus.on'), '0');
  // off: the module returns before touching the page
  let observed = 0;
  const w2 = run(ls);
  w2.MutationObserver = class { observe() { observed++; } disconnect() {} };
  assert.equal(typeof w2.__AK_PLUS_SET__, 'function', 'hook still defined while off (so it can be switched back on)');
  assert.equal(observed, 0);
  assert.equal(w2.__AK_PLUS_SET__(true).changed, true);
  assert.equal(ls.getItem('arenakit.plus.on'), '1');
});
