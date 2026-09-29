import test from 'node:test';
import assert from 'node:assert/strict';
import { jsString, createStore, getTauri } from '../src/lib/tauri-api.js';

test('jsString produces an eval-safe literal', () => {
  assert.equal(jsString('a"b'), '"a\\"b"');
  assert.equal(jsString('x\u2028y'), '"x\\u2028y"');
  assert.equal(jsString('</script>'), '"<\\/script>"');
  assert.equal(eval(jsString('line\nbreak')), 'line\nbreak');
});

test('createStore routes to the Rust store commands', async () => {
  const calls = [];
  const store = createStore({ invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'store_get' ? { ok: 1 } : cmd === 'store_keys' ? ['a'] : null; } });
  assert.deepEqual(await store.get('prefs'), { ok: 1 });
  await store.set('prefs', { a: 1 });
  await store.set('gone', undefined);
  assert.deepEqual(await store.keys('h.'), ['a']);
  assert.deepEqual(calls, [
    ['store_get', { key: 'prefs' }],
    ['store_set', { key: 'prefs', value: { a: 1 } }],
    ['store_set', { key: 'gone', value: null }],
    ['store_keys', { prefix: 'h.' }],
  ]);
});

test('createStore adds the launch token only when the embedded dock closure provides one', async () => {
  const calls = [];
  const tauri = { invoke: async (cmd, args) => { calls.push([cmd, args]); return null; } };
  globalThis.__AK_GUARD__ = 'abc123';
  try {
    const store = createStore(tauri);
    await store.get('accounts');
    await store.set('secret.gistToken', 'x');
    await store.keys('');
  } finally { delete globalThis.__AK_GUARD__; }
  assert.deepEqual(calls, [
    ['store_get', { key: 'accounts', guardToken: 'abc123' }],
    ['store_set', { key: 'secret.gistToken', value: 'x', guardToken: 'abc123' }],
    ['store_keys', { prefix: '', guardToken: 'abc123' }],
  ]);
});

test('getTauri is null outside the runtime', () => {
  assert.equal(getTauri(), null);
});
