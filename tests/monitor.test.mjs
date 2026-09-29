import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, createReplyMonitor, KINDS } from '../src/lib/monitor.js';
import { createTurnTracker } from '../src/lib/turns.js';
import { runInjected, fakePage, plain } from './helpers.mjs';

test('classifyReply: normal reply reports no anomaly signal', () => {
  const r = classifyReply({ ended: 'done', frames: 42, textChars: 1280, errorFrames: 0, durationMs: 8300 });
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.line, '42 帧 · 1280 字符 · 8.3s · 无异常信号');
  assert.equal(classifyReply({ ended: 'done', frames: 900, textChars: 12345, durationMs: 75000 }).line, '900 帧 · 12.3k 字符 · 1m15s · 无异常信号');
  assert.deepEqual(classifyReply(null), { anomalies: [], line: '' });
});

test('classifyReply: empty / error / truncated / stalled', () => {
  assert.deepEqual(classifyReply({ ended: 'done', frames: 1, textChars: 0 }).anomalies.map((a) => a.kind), ['reply-empty']);
  let r = classifyReply({ ended: 'done', frames: 3, textChars: 0, errorFrames: 1, lastError: 'rate limit exceeded' });
  assert.deepEqual(r.anomalies.map((a) => a.kind), ['reply-error'], 'error wins over empty');
  assert.equal(r.anomalies[0].label, '回复报错：rate limit exceeded');
  r = classifyReply({ ended: 'abort', frames: 10, textChars: 400 });
  assert.deepEqual(r.anomalies.map((a) => a.kind), ['reply-truncated']);
  assert.ok(r.line.endsWith(KINDS['reply-truncated']));
  assert.deepEqual(classifyReply({ ended: 'stalled', frames: 2, textChars: 5 }).anomalies.map((a) => a.kind), ['reply-stalled']);
  assert.deepEqual(classifyReply({ ended: 'http', frames: 0, textChars: 0, lastError: 'HTTP 429' }).anomalies.map((a) => a.kind), ['reply-error']);
  r = classifyReply({ ended: 'abort', frames: 4, textChars: 0, errorFrames: 1, lastError: 'boom' });
  assert.deepEqual(r.anomalies.map((a) => a.kind), ['reply-error', 'reply-truncated']);
});

test('reply monitor marks the newest turn of the tracked conversation only', () => {
  const tracker = createTurnTracker();
  tracker.onToken('abc', 'run-1');
  tracker.record(1, 'gpt-4o', ['gpt-4o']);
  const mon = createReplyMonitor({ tracker, max: 2 });
  const e1 = mon.ingest({ sessionId: 'abc', ended: 'done', frames: 5, textChars: 0, at: 1 });
  assert.equal(e1.turn, 1);
  assert.deepEqual(tracker.turns[0].marks, [{ kind: 'reply-empty', label: '空回复' }]);
  const other = mon.ingest({ sessionId: 'zzz', ended: 'abort', frames: 1, textChars: 1, at: 2 });
  assert.equal(other.turn, null);
  assert.equal(tracker.turns[0].marks.length, 1);
  tracker.onToken('abc', 'run-2');
  const e3 = mon.ingest({ sessionId: 'abc', ended: 'done', frames: 9, textChars: 30, errorFrames: 1, lastError: 'overloaded: try again', at: 3 });
  assert.equal(e3.turn, 2);
  assert.deepEqual(tracker.turns[1].marks, [{ kind: 'reply-error', label: '回复报错' }]);
  assert.equal(mon.entries.length, 2, 'capped');
  assert.equal(mon.last.turn, 2);
  assert.equal(mon.ingest(null), null);
  assert.equal(mon.ingest({ ended: 'done' }), null);
});

/* ── injected/monitor.js ─────────────────────────────────────────────── */
function loadMonitor({ generating = false } = {}) {
  const page = fakePage({ pathname: '/agent/abc' });
  const sent = [];
  page.sandbox.__ARENAKIT__ = { send: (name, payload) => sent.push({ name, payload: plain(payload) }) };
  page.sandbox.setInterval = () => 0;
  const stop = { isConnected: true, getClientRects: () => [{}], getAttribute: () => 'Stop generating' };
  page.document.querySelectorAll = (sel) => (sel === 'button[aria-label]' && generating ? [stop] : []);
  runInjected('injected/monitor.js', page.sandbox);
  return { M: page.sandbox.__ARENAKIT_MONITOR__, sent, page };
}

test('page monitor reduces SSE frames to counts and flags — no text crosses the bridge', () => {
  const { M, sent } = loadMonitor();
  M.onOpen('s1');
  M.onFrame('s1', 'data: {"type":"text.delta","delta":"Hello, "}', 40);
  M.onFrame('s1', 'data: {"type":"text.delta","delta":"world"}', 30);
  M.onFrame('s1', 'data: {"type":"message","content":[{"type":"text","text":"Hello, world"}]}', 60);
  M.onFrame('s1', 'event: done\ndata: {"status":"COMPLETED"}', 20);
  assert.equal(sent.length, 0, 'nothing reported before the stream ends');
  M.onEnd('s1', 'done');
  assert.equal(sent.length, 1);
  const p = sent[0].payload;
  assert.equal(sent[0].name, 'reply-monitor');
  assert.equal(p.sessionId, 's1');
  assert.equal(p.ended, 'done');
  assert.equal(p.frames, 4);
  assert.equal(p.bytes, 150);
  assert.equal(p.textChars, 'Hello, '.length + 'world'.length + 'Hello, world'.length);
  assert.equal(p.errorFrames, 0);
  assert.equal(p.lastStatus, 'COMPLETED');
  assert.equal(JSON.stringify(p).includes('Hello'), false, 'no conversation text in the payload');
  M.onEnd('s1', 'done');
  assert.equal(sent.length, 1, 'reported once');
});

test('page monitor flags errors, aborts, HTTP failures and stalls', () => {
  let { M, sent } = loadMonitor();
  M.onOpen('e1');
  M.onFrame('e1', 'data: {"type":"run.status","status":"SYSTEM_FAILURE"}', 10);
  M.onFrame('e1', 'event: error\ndata: {"error":{"message":"model overloaded"}}', 10);
  M.onEnd('e1', 'abort');
  assert.equal(sent[0].payload.ended, 'abort');
  assert.equal(sent[0].payload.errorFrames, 2);
  assert.equal(sent[0].payload.lastError, 'model overloaded');

  ({ M, sent } = loadMonitor());
  M.onHttpError('h1', 429);
  assert.deepEqual([sent[0].payload.ended, sent[0].payload.lastError, sent[0].payload.errorFrames], ['http', 'HTTP 429', 1]);

  ({ M, sent } = loadMonitor({ generating: true }));
  M.onOpen('st1');
  M.onFrame('st1', 'data: {"delta":"a"}', 1);
  const s = M._streams.get('st1');
  M.check(s.lastFrameAt + M.STALL_MS - 1);
  assert.equal(sent.length, 0);
  M.check(s.lastFrameAt + M.STALL_MS);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.ended, 'stalled');
  assert.equal(sent[0].payload.generating, true);
  assert.equal(sent[0].payload.idleMs, M.STALL_MS);

  ({ M, sent } = loadMonitor({ generating: false }));
  M.onOpen('st2');
  M.check(Date.now() + M.STALL_MS * 2);
  assert.equal(sent.length, 0, 'idle stream without a Stop button is not a stall');

  ({ M, sent } = loadMonitor());
  M.onOpen('r1');
  M.onEnd('r1', 'retry');
  assert.equal(sent.length, 0, 'EventSource reconnects are not final');
  M.onFrame('r1', 'plain text frame without data prefix is ignored, data: none', 5);
  M.onFrame('r1', 'data: not-json', 5);
  M.onEnd('r1', 'done');
  assert.equal(sent[0].payload.textChars, 'not-json'.length);
  assert.equal(sent[0].payload.frames, 2);
});
