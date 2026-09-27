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

test('getTauri is null outside the runtime', () => {
  assert.equal(getTauri(), null);
});
