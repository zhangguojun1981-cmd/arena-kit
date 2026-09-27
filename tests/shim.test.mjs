import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, plain, runScript } from './helpers/fake-window.mjs';

const SHIM = '../../injected/gm-shim.js';

function shim(storage) {
  const w = makeWindow({ storage });
  w.document.createElement = () => ({ textContent: '', remove() {} });
  w.document.head = { appendChild() {} };
  runScript(w, SHIM);
  return w;
}

test('chrome.storage.sync: promise and callback forms', async () => {
  const w = shim();
  const { sync } = w.chrome.storage;
  await sync.set({ a: 1, b: { x: true } });
  assert.deepEqual(plain(await sync.get(['a', 'b', 'missing'])), { a: 1, b: { x: true } });
  assert.deepEqual(plain(await sync.get('a')), { a: 1 });
  assert.deepEqual(plain(await sync.get({ a: 0, c: 'default' })), { a: 1, c: 'default' });
  assert.deepEqual(plain(await sync.get(null)), { a: 1, b: { x: true } });
  const viaCb = await new Promise((res) => sync.get(['a'], res));
  assert.deepEqual(plain(viaCb), { a: 1 });
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ak_chrome_sync')), { a: 1, b: { x: true } });
});

test('chrome.storage.local is a separate area and fires onChanged', async () => {
  const w = shim();
  const changes = [];
  w.chrome.storage.onChanged.addListener((c, area) => changes.push([area, c]));
  w.chrome.storage.local.onChanged.addListener((c, area) => changes.push(['local-only', area]));
  await w.chrome.storage.local.set({ leaderboard_arena: { m: { wins: 1, losses: 0 } } });
  assert.deepEqual(plain(await w.chrome.storage.sync.get(null)), {});
  assert.equal(changes.length, 2);
  const global = changes.find((c) => c[0] === 'local');
  assert.ok(global, 'global onChanged fired with area "local"');
  assert.ok(changes.find((c) => c[0] === 'local-only'), 'area onChanged fired');
  assert.deepEqual(plain(global[1].leaderboard_arena.newValue), { m: { wins: 1, losses: 0 } });
  await w.chrome.storage.local.remove('leaderboard_arena');
  assert.deepEqual(plain(await w.chrome.storage.local.get(null)), {});
});

test('unlock.js boot pattern: sync.get(defaults, cb) merges saved values', async () => {
  const w = shim({ ak_chrome_sync: JSON.stringify({ h: true }) });
  const r = await new Promise((res) => w.chrome.storage.sync.get({ e: true, o: true, h: false }, res));
  assert.deepEqual(plain(r), { e: true, o: true, h: true });
});

test('chrome.runtime surface is safe to call', async () => {
  const w = shim();
  assert.match(w.chrome.runtime.getURL('icons/x.svg'), /^data:image\/svg\+xml/);
  assert.equal(typeof w.chrome.runtime.id, 'string');
  w.chrome.runtime.onMessage.addListener(() => {});
  assert.equal(await w.chrome.runtime.sendMessage({ t: 'g' }), undefined);
  assert.equal(w.chrome.runtime.getManifest().name, 'ArenaKit');
});

test('GM_* values round-trip through the ak_gm_ prefix', () => {
  const w = shim();
  assert.equal(w.GM_getValue('k', 'dflt'), 'dflt');
  w.GM_setValue('k', 'v');
  assert.equal(w.GM_getValue('k'), 'v');
  assert.equal(w.localStorage.getItem('ak_gm_k'), 'v');
  w.GM_deleteValue('k');
  assert.equal(w.GM_getValue('k', null), null);
  assert.equal(w.GM_registerMenuCommand('x', () => {}), 0);
  assert.equal(w.__AK_MENU__.length, 1);
});

test('shim does not clobber an existing chrome object', () => {
  const w = makeWindow();
  w.document.createElement = () => ({});
  w.chrome = { loadTimes() {} };
  runScript(w, SHIM);
  assert.equal(typeof w.chrome.loadTimes, 'function');
  assert.equal(typeof w.chrome.storage.sync.get, 'function');
});
