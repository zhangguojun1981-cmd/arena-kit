import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected, fakePage, tick, plain } from './helpers.mjs';

test('bridge exposes the IPC surface and routes commands', async () => {
  const page = fakePage({ pathname: '/agent/abc-123' });
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  assert.ok(ak);
  await ak.onToken({ sessionId: 'abc-123', token: 'a.b.c' });
  await ak.send('hello', { x: 1 });
  await ak.storeSet('k', { v: 2 });
  await ak.storeGet('k');
  await ak.proxyGet('https://arena.ai/x');
  const cmds = page.calls.map((c) => c.cmd);
  assert.equal(cmds[0], 'page_event'); // init nav announcement comes first
  assert.ok(cmds.includes('on_token'));
  assert.deepEqual(plain(page.calls.find((c) => c.cmd === 'on_token').args), { token: 'a.b.c', sessionId: 'abc-123' });
  assert.deepEqual(plain(page.calls.find((c) => c.cmd === 'page_event' && c.args.name === 'hello').args), { name: 'hello', payload: { x: 1 } });
  assert.deepEqual(plain(page.calls.find((c) => c.cmd === 'store_set').args), { key: 'k', value: { v: 2 } });
  assert.equal(page.calls.find((c) => c.cmd === 'store_get').args.key, 'k');
  assert.equal(page.calls.find((c) => c.cmd === 'proxy_get').args.url, 'https://arena.ai/x');
});

test('bridge announces navigation on init, pushState and popstate with session ids', async () => {
  const page = fakePage({ pathname: '/agent' });
  runInjected('injected/bridge.js', page.sandbox);
  const navs = () => page.calls.filter((c) => c.cmd === 'page_event' && c.args.name === 'nav').map((c) => c.args.payload);
  assert.equal(navs().length, 1);
  assert.equal(navs()[0].reason, 'init');
  assert.equal(navs()[0].sessionId, null);
  assert.equal(navs()[0].agentPath, true);

  page.history.pushState({}, '', '/agent/sess-1');
  await tick();
  assert.equal(navs().length, 2);
  assert.equal(navs()[1].sessionId, 'sess-1');
  assert.equal(navs()[1].reason, 'pushState');

  // Same path again → deduplicated.
  page.history.replaceState({}, '', '/agent/sess-1');
  await tick();
  assert.equal(navs().length, 2);

  page.location.pathname = '/agent/sess-2';
  for (const fn of page.listeners.popstate) fn();
  await tick();
  assert.equal(navs().at(-1).sessionId, 'sess-2');
  assert.equal(navs().at(-1).reason, 'popstate');
});

test('dispatch fans out to page-side handlers and reports the count', () => {
  const page = fakePage();
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  const seen = [];
  const off = ak.on('ping', (p) => seen.push(p));
  ak.on('ping', () => { throw new Error('boom'); }); // a failing handler must not break the others
  assert.equal(ak.dispatch('ping', { a: 1 }), 2);
  assert.deepEqual(plain(seen), [{ a: 1 }]);
  off();
  assert.equal(ak.dispatch('ping', {}), 1);
  assert.equal(ak.dispatch('unknown', {}), 0);
});

test('bridge rejects cleanly without a Tauri runtime', async () => {
  const page = fakePage();
  delete page.sandbox.__TAURI_INTERNALS__;
  runInjected('injected/bridge.js', page.sandbox);
  await assert.rejects(page.sandbox.__ARENAKIT__.storeGet('k'), /no tauri runtime/);
});

test('sessionFromPath matches only /agent/<id>', () => {
  const page = fakePage();
  runInjected('injected/bridge.js', page.sandbox);
  const f = page.sandbox.__ARENAKIT__.sessionFromPath;
  assert.equal(f('/agent/abc-DEF-123'), 'abc-DEF-123');
  assert.equal(f('/agent/abc/'), 'abc');
  assert.equal(f('/agent'), null);
  assert.equal(f('/agent/abc/settings'), null);
  assert.equal(f('/chat/abc'), null);
});
