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

test('bridge exposes Gist calls that never carry a token', async () => {
  const page = fakePage({ pathname: '/agent/abc-123' });
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  await ak.gistTokenSet('ghp_x');
  await ak.gistTokenStatus();
  await ak.gistRequest('PATCH', 'abc', { files: {} });
  await ak.gistRequest('POST', '', { files: {} });
  const by = (cmd) => page.calls.filter((c) => c.cmd === cmd).map((c) => plain(c.args));
  assert.deepEqual(by('gist_token_set'), [{ token: 'ghp_x' }]);
  assert.equal(by('gist_token_status').length, 1);
  assert.deepEqual(by('gist_request'), [
    { method: 'PATCH', gistId: 'abc', body: { files: {} } },
    { method: 'POST', gistId: null, body: { files: {} } },
  ]);
  for (const a of by('gist_request')) assert.ok(!('token' in a) && !('Authorization' in a));
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

test('sessionFromPath matches /agent/<id> and /c/<id> conversation pages', () => {
  const page = fakePage();
  runInjected('injected/bridge.js', page.sandbox);
  const f = page.sandbox.__ARENAKIT__.sessionFromPath;
  assert.equal(f('/agent/abc-DEF-123'), 'abc-DEF-123');
  assert.equal(f('/agent/abc/'), 'abc');
  assert.equal(f('/c/eval-42'), 'eval-42');
  assert.equal(f('/c/eval-42/'), 'eval-42');
  assert.equal(f('/agent'), null);
  assert.equal(f('/c'), null);
  assert.equal(f('/agent/abc/settings'), null);
  assert.equal(f('/c/abc/x'), null);
  assert.equal(f('/chat/abc'), null);
  assert.equal(page.sandbox.__ARENAKIT__.isNewChatPath('/agent/'), true);
  assert.equal(page.sandbox.__ARENAKIT__.isNewChatPath('/agent/x'), false);
});

const onTokens = (page) => page.calls.filter((c) => c.cmd === 'on_token').map((c) => plain(c.args));

test('token routing: every stream is accepted on a conversation page, none elsewhere', async () => {
  const page = fakePage({ pathname: '/c/eval-1' });
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  assert.equal(await ak.onToken({ sessionId: 'stream-1', token: 'a.b.c', page: '/c/eval-1' }), true);
  assert.equal(await ak.onToken({ sessionId: 'stream-2', token: 'd.e.f', page: '/c/eval-1' }), true, 'page id and stream id need not match');
  // Captured on a non-conversation page (leaderboard, settings…): dropped.
  assert.equal(await ak.onToken({ sessionId: 'stream-3', token: 'g.h.i', page: '/leaderboard' }), false);
  assert.equal(await ak.onToken({ sessionId: 'bad id', token: 'g.h.i', page: '/c/eval-1' }), false);
  assert.deepEqual(onTokens(page).map((a) => a.sessionId), ['stream-1', 'stream-2']);
});

test('token routing: the new-chat composer adopts exactly one conversation and rejects late replays', async () => {
  const page = fakePage({ pathname: '/agent/old-chat' });
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  await ak.onToken({ sessionId: 'old-chat', token: 'a.b.c', page: '/agent/old-chat' });
  // User taps "new chat" → /agent. A late token of the chat just left is known → rejected.
  page.history.pushState({}, '', '/agent');
  await tick();
  assert.equal(await ak.onToken({ sessionId: 'old-chat', token: 'a.b.c', page: '/agent' }), false);
  // The first unseen stream is the conversation being created → adopted…
  assert.equal(await ak.onToken({ sessionId: 'new-chat', token: 'd.e.f', page: '/agent' }), true);
  // …and it stays the only one accepted on this composer.
  assert.equal(await ak.onToken({ sessionId: 'other', token: 'g.h.i', page: '/agent' }), false);
  assert.equal(await ak.onToken({ sessionId: 'new-chat', token: 'j.k.l', page: '/agent' }), true);
  // Entering /agent again starts a fresh adoption.
  page.history.pushState({}, '', '/agent/new-chat');
  await tick();
  page.history.pushState({}, '', '/agent');
  await tick();
  assert.equal(await ak.onToken({ sessionId: 'third', token: 'm.n.o', page: '/agent' }), true);
  assert.deepEqual(onTokens(page).map((a) => a.sessionId), ['old-chat', 'new-chat', 'new-chat', 'third']);
});

test('stream activity re-runs the last lookup after the 45 s cooldown, never for an expired token', async () => {
  let now = 1_000_000;
  const page = fakePage({ pathname: '/agent/sess-1' });
  page.sandbox.Date = { now: () => now };
  page.sandbox.atob = atob;
  runInjected('injected/bridge.js', page.sandbox);
  const ak = page.sandbox.__ARENAKIT__;
  const exp = Math.floor((now + 10 * 60_000) / 1000);
  const token = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.sig';
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/agent/sess-1' }), false, 'nothing to refresh yet');
  await ak.onToken({ sessionId: 'sess-1', token, page: '/agent/sess-1' });
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/agent/sess-1' }), false, 'inside the cooldown');
  now += 46_000;
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/agent/sess-1' }), true);
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/agent/sess-1' }), false, 'cooldown restarted');
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/leaderboard' }), false, 'routing guard applies to pings too');
  assert.equal(onTokens(page).length, 2);
  assert.equal(onTokens(page)[1].token, token);
  // Token about to expire → no refresh.
  now = exp * 1000 - 1000;
  assert.equal(ak.onActivity({ sessionId: 'sess-1', page: '/agent/sess-1' }), false);
});

test('nav-announce re-sends the current navigation (desktop dock missed init)', () => {
  const page = fakePage({ pathname: '/agent/sess-9' });
  runInjected('injected/bridge.js', page.sandbox);
  const navs = () => page.calls.filter((c) => c.cmd === 'page_event' && c.args.name === 'nav').map((c) => c.args.payload);
  assert.equal(navs().length, 1);
  page.sandbox.__ARENAKIT__.dispatch('nav-announce', null);
  assert.equal(navs().length, 2, 'not swallowed by the same-path dedupe');
  assert.equal(navs()[1].reason, 'seed');
  assert.equal(navs()[1].sessionId, 'sess-9');
});
