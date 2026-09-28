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

function unlockPage(ls = storage(), fetchImpl = async () => new Response('')) {
  const sb = {
    localStorage: ls, console, JSON, Object, Array, String, Math,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    fetch: fetchImpl, Response, TransformStream, TextDecoder, TextEncoder,
  };
  sb.self = sb; sb.window = sb;
  return runInjected('injected/unlock.js', sb);
}
// A Next.js flight chunk the way arena ships its model list.
const chunk = (name, pad = 80) => `{"initialModels":[{"publicName":"${name}","padding":"${'x'.repeat(pad)}","userSelectable":false}]}`;
/* RSC text row: `id:T<hex byte length>,<text>` — the parser reads exactly
 * that many bytes; a rewrite that changes the length corrupts every row after. */
const tRow = (id, text) => `${id}:T${Buffer.byteLength(text).toString(16)},${text}`;
const parseTRow = (row) => { const m = /^(\w+):T([0-9a-f]+),/.exec(row); const n = parseInt(m[2], 16); return Buffer.from(row.slice(m[0].length)).subarray(0, n).toString(); };

test('unlock.js: off by default — no __next_f hook, no fetch wrapper; __AK_UNLOCK_SET__ persists the dock switches for the next load', () => {
  const origFetch = async () => new Response('');
  let w = unlockPage(storage(), origFetch);
  assert.equal(typeof w.__AK_UNLOCK_SET__, 'function', 'dock hook defined');
  assert.equal(w.fetch, origFetch, 'fetch untouched while both switches are off');
  assert.equal(w.__next_f, undefined, 'no __next_f hook while off');

  const ls = storage();
  w = unlockPage(ls);
  assert.equal(w.__AK_UNLOCK_SET__('hidden', true).ok, true);
  assert.equal(w.__AK_UNLOCK_SET__('opus', true).changed, true);
  assert.equal(w.__AK_UNLOCK_SET__('bogus', true).ok, false);
  assert.deepEqual(JSON.parse(ls.getItem('_at')), { h: true, o: true });
  w = unlockPage(ls);
  assert.deepEqual({ ...w.__AK_UNLOCK_GET__() }, { h: true, o: true });
});

test('unlock.js: every rewrite keeps the byte length — a length-prefixed RSC row still parses; Opus and hidden rules', () => {
  const ls = storage({ _at: JSON.stringify({ o: true }) });
  let w = unlockPage(ls);
  w.__next_f = [];                         // Next's inline bootstrap: (self.__next_f = self.__next_f || []).push(...)
  const opus = chunk('claude-opus-4-1'), hidden = chunk('secret-blind-model');
  const flag = '{"flags":{"disable-opus":"disable-opus","x":1},"pad":"' + 'y'.repeat(60) + '"}';
  w.__next_f.push([1, opus]); w.__next_f.push([1, hidden]); w.__next_f.push([1, flag]);
  assert.equal(w.__next_f[0][1].length, opus.length, 'same length');
  assert.match(w.__next_f[0][1], /"userSelectable":true /, 'Opus unlocked (padded)');
  assert.deepEqual(JSON.parse(w.__next_f[0][1]).initialModels[0].userSelectable, true, 'still valid JSON');
  assert.match(w.__next_f[1][1], /"userSelectable":false/, 'hidden stays hidden with only the Opus switch');
  assert.equal(w.__next_f[2][1].length, flag.length);
  assert.equal(JSON.parse(w.__next_f[2][1]).flags['disable-opus'], '$undefined');
  // escaped form inside a JS string literal of the flight payload
  const esc = JSON.stringify(opus).slice(1, -1);
  w.__next_f.push([1, esc]);
  assert.equal(w.__next_f[3][1].length, esc.length);
  assert.match(w.__next_f[3][1], /\\"userSelectable\\":true /);

  // hidden switch: every userSelectable:false; a T row around it still parses byte-exact
  w = unlockPage(storage({ _at: JSON.stringify({ h: true }) }));
  w.__next_f = [];
  const text = hidden + '中文说明';
  const rows = tRow('1a', text) + tRow('1b', 'after');
  w.__next_f.push([1, rows]);
  const out = w.__next_f[0][1];
  assert.equal(Buffer.byteLength(out), Buffer.byteLength(rows), 'byte length unchanged');
  const first = parseTRow(out);
  assert.equal(JSON.parse(first.replace('中文说明', '')).initialModels[0].userSelectable, true);
  assert.equal(parseTRow(out.slice(out.indexOf('1b:'))), 'after', 'the next row is still aligned');
});

test('unlock.js: router (text/x-component) responses are rewritten as a stream keeping url / redirected; chat streams and foreign hosts untouched', async () => {
  const body = chunk('claude-opus-4-1');
  const mk = (ct, text = body) => { const r = new Response(text, { headers: { 'content-type': ct } }); Object.defineProperty(r, 'url', { value: 'https://arena.ai/agent?_rsc=1' }); Object.defineProperty(r, 'redirected', { value: true }); return r; };
  let next = null;
  const w = unlockPage(storage({ _at: JSON.stringify({ o: true }) }), async () => next);
  next = mk('text/x-component');
  const r1 = await w.fetch('/agent?_rsc=1');
  assert.equal(r1.url, 'https://arena.ai/agent?_rsc=1', 'url kept (Next router reads it)');
  assert.equal(r1.redirected, true, 'redirected kept');
  const t1 = await r1.text();
  assert.equal(t1.length, body.length);
  assert.match(t1, /"userSelectable":true /);
  // chat stream: the very same Response object comes back (never buffered)
  next = mk('text/plain; charset=utf-8'); const chat = next;
  assert.equal(await w.fetch('/nextjs-api/stream/create-evaluation'), chat);
  next = mk('text/event-stream'); const sse = next;
  assert.equal(await w.fetch('/ai-proxy/realtime/v1/sessions/x'), sse);
  next = mk('text/x-component'); const foreign = next;
  assert.equal(await w.fetch('https://example.com/x'), foreign, 'other hosts untouched');
  assert.equal(await w.fetch('//evil.example/x'), foreign, 'protocol-relative is not same-origin');
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
