import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected, fakePage, tick, plain } from './helpers.mjs';

/* injected/snoop.js v2: fetch / EventSource / XHR / WebSocket taps on the arena
 * session stream, raw JWT fallback, per-(page, session, token) dedupe and
 * throttled activity pings — all inside a vm sandbox with fake transports. */

const STREAM = (sid) => `https://arena.ai/ai-proxy/realtime/v1/sessions/${sid}/stream`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicnVuIjoicnVuX2FiYyJ9.abcdefghijklmnopqrstuvwxyz012345';
const JWT2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5ODc2NTQzMjEwIiwicnVuIjoicnVuX3h5eiJ9.zyxwvutsrqponmlkjihgfedcba543210';
const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const tokenFrame = (token) => sse({ records: [{ headers: [['public-access-token', token]] }] });

const streamOf = (text) => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
});

function snoopPage({ pathname = '/agent/sess-1', responses = {}, now = () => 1_000_000 } = {}) {
  const page = fakePage({ pathname });
  const tokens = [];
  const pings = [];
  const posted = [];
  const sb = page.sandbox;
  sb.__ARENAKIT__ = { onToken: (p) => tokens.push(plain(p)), onActivity: (p) => pings.push(plain(p)) };
  sb.postMessage = (m) => posted.push(m);
  sb.Response = Response;
  sb.TextDecoder = TextDecoder;
  sb.Date = { now };
  sb.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = responses[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(streamOf(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  runInjected('injected/snoop.js', sb);
  return { page, sb, tokens, pings, posted };
}

const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('fetch tap: token + page path handed to the bridge, page body left intact, activity pinged', async () => {
  const body = tokenFrame(JWT) + sse({ type: 'delta', text: 'hello' });
  const { sb, tokens, pings } = snoopPage({ responses: { [STREAM('sess-1')]: body } });
  const res = await sb.fetch(STREAM('sess-1'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body, 'the page still receives the whole stream');
  await settle();
  assert.deepEqual(tokens, [{ sessionId: 'sess-1', token: JWT, page: '/agent/sess-1' }]);
  assert.deepEqual(pings, [{ sessionId: 'sess-1', page: '/agent/sess-1' }]);
});

test('same (page, session, token) is forwarded once; a new page or token is forwarded again', async () => {
  const { sb, tokens, page } = snoopPage({ responses: { [STREAM('sess-1')]: tokenFrame(JWT) + tokenFrame(JWT) } });
  await sb.fetch(STREAM('sess-1')); await settle();
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(tokens.length, 1);
  page.location.pathname = '/c/eval-77';
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(tokens.length, 2);
  assert.equal(tokens[1].page, '/c/eval-77');
});

test('activity pings are throttled to one per 15 s per session', async () => {
  let t = 1_000_000;
  const { sb, pings } = snoopPage({ responses: { [STREAM('sess-1')]: sse({ text: 'x' }) }, now: () => t });
  await sb.fetch(STREAM('sess-1')); await settle();
  t += 5_000;
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(pings.length, 1);
  t += 11_000;
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(pings.length, 2);
});

test('non-arena and non-stream URLs are not tapped; HTTP errors are passed through', async () => {
  const { sb, tokens, pings } = snoopPage({ responses: { 'https://example.com/ai-proxy/realtime/v1/sessions/s/stream': tokenFrame(JWT) } });
  const r = await sb.fetch('https://example.com/ai-proxy/realtime/v1/sessions/s/stream');
  assert.equal(await r.text(), tokenFrame(JWT));
  const e = await sb.fetch(STREAM('missing'));
  assert.equal(e.status, 404);
  await settle();
  assert.equal(tokens.length, 0);
  assert.equal(pings.length, 0);
});

test('capture flag off keeps the tap silent', async () => {
  const { sb, tokens, pings } = snoopPage({ responses: { [STREAM('sess-1')]: tokenFrame(JWT) } });
  sb.__ARENAKIT_FLAGS__ = { capture: false };
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(tokens.length, 0);
  assert.equal(pings.length, 0);
});

test('XMLHttpRequest progressive reads are scanned, including a plain JSON body (raw JWT fallback)', () => {
  const page = fakePage({ pathname: '/agent/sess-2' });
  const tokens = [];
  page.sandbox.__ARENAKIT__ = { onToken: (p) => tokens.push(plain(p)), onActivity() {} };
  page.sandbox.Date = { now: () => 1 };
  class FakeXHR {
    open(_m, url) { this.url = url; }
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; }
    send() {
      this.readyState = 3;
      this.responseText = '{"run":{"publicAccessToken":"' + JWT2 + '"}}';
      this.listeners?.readystatechange?.();
      this.readyState = 4;
      this.listeners?.readystatechange?.();
    }
  }
  page.sandbox.XMLHttpRequest = FakeXHR;
  runInjected('injected/snoop.js', page.sandbox);
  const xhr = new page.sandbox.XMLHttpRequest();
  xhr.open('POST', STREAM('sess-2'));
  xhr.send();
  assert.deepEqual(tokens, [{ sessionId: 'sess-2', token: JWT2, page: '/agent/sess-2' }]);
  // Other URLs are not scanned.
  const other = new page.sandbox.XMLHttpRequest();
  other.open('GET', 'https://arena.ai/api/other');
  other.responseText = JWT;
  other.send();
  assert.equal(tokens.length, 1);
});

test('WebSocket frames on the wss stream endpoint are scanned; constants preserved', () => {
  const page = fakePage({ pathname: '/c/eval-1' });
  const tokens = [];
  page.sandbox.__ARENAKIT__ = { onToken: (p) => tokens.push(plain(p)), onActivity() {} };
  page.sandbox.Date = { now: () => 1 };
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; }
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; }
    emit(data) { this.listeners?.message?.({ data }); }
  }
  page.sandbox.WebSocket = FakeWS;
  runInjected('injected/snoop.js', page.sandbox);
  const WS = page.sandbox.WebSocket;
  assert.equal(WS.OPEN, 1);
  assert.equal(WS.CLOSED, 3);
  const ws = new WS('wss://arena.ai/ai-proxy/realtime/v1/sessions/sess-9/stream');
  ws.emit(JSON.stringify({ records: [{ headers: { public_access_token: JWT } }] }));
  assert.deepEqual(tokens, [{ sessionId: 'sess-9', token: JWT, page: '/c/eval-1' }]);
  // Plain ws:// (not page-legal on arena) and other hosts are ignored.
  new WS('ws://arena.ai/ai-proxy/realtime/v1/sessions/sess-8/stream').emit(JSON.stringify({ publicAccessToken: JWT2 }));
  new WS('wss://evil.example/ai-proxy/realtime/v1/sessions/sess-8/stream').emit(JSON.stringify({ publicAccessToken: JWT2 }));
  assert.equal(tokens.length, 1);
});

test('EventSource messages are scanned and the guard prevents double injection', () => {
  const page = fakePage({ pathname: '/agent/sess-3' });
  const tokens = [];
  page.sandbox.__ARENAKIT__ = { onToken: (p) => tokens.push(plain(p)), onActivity() {} };
  page.sandbox.Date = { now: () => 1 };
  class FakeES {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; }
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; }
  }
  page.sandbox.EventSource = FakeES;
  runInjected('injected/snoop.js', page.sandbox);
  const first = page.sandbox.EventSource;
  runInjected('injected/snoop.js', page.sandbox);
  assert.equal(page.sandbox.EventSource, first, 're-injection is a no-op');
  const es = new first(STREAM('sess-3'));
  es.listeners.message({ data: JSON.stringify({ records: [{ headers: [['Public_Access_Token', JWT]] }] }) });
  assert.deepEqual(tokens, [{ sessionId: 'sess-3', token: JWT, page: '/agent/sess-3' }]);
});

test('without the bridge the original postMessage channel is used', async () => {
  const { sb, posted } = snoopPage({ responses: { [STREAM('sess-1')]: tokenFrame(JWT) } });
  delete sb.__ARENAKIT__;
  await sb.fetch(STREAM('sess-1')); await settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].source, 'ati-snoop');
  assert.equal(posted[0].token, JWT);
});
