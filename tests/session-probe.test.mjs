import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionProbePrecheck, sessionProbeText, awaitTurnModel } from '../src/lib/session-probe.js';
import { createTurnTracker } from '../src/lib/turns.js';
import { isOwnPrompt } from '../src/lib/probe-logic.js';

const base = { onArena: true, session: 'abc', agentPath: false, hasComposer: true, hasDraft: false, draftIsOwnPrompt: false, isGenerating: false, renameBusy: false, dialogOpen: false };

test('precheck: go only on an Arena chat with a free composer and no human draft', () => {
  assert.deepEqual(sessionProbePrecheck(base), { ok: true, reason: '' });
  assert.equal(sessionProbePrecheck(base, { probeRunning: true }).reason, '探针运行中，请先停止再发送');
  assert.equal(sessionProbePrecheck(null).reason, '无法读取页面状态');
  assert.equal(sessionProbePrecheck({ ...base, onArena: false }).reason, '已离开 Arena');
  assert.equal(sessionProbePrecheck({ ...base, session: null }).reason, '请先打开一个 Arena 对话');
  assert.equal(sessionProbePrecheck({ ...base, session: null, agentPath: true }).reason, '当前是新对话，发送后将创建会话');
  assert.equal(sessionProbePrecheck({ ...base, hasComposer: false }).reason, '未找到输入框');
  assert.equal(sessionProbePrecheck({ ...base, isGenerating: true }).reason, '当前回复仍在生成，请稍后再试');
  assert.equal(sessionProbePrecheck({ ...base, dialogOpen: true }).ok, false);
  assert.equal(sessionProbePrecheck({ ...base, renameBusy: true }).ok, false);
  assert.equal(sessionProbePrecheck({ ...base, hasDraft: true }).reason, '输入框有未发送的草稿，已停止；不会覆盖草稿');
  assert.equal(sessionProbePrecheck({ ...base, hasDraft: true, draftIsOwnPrompt: true }).ok, true, 'our own leftover prompt may be replaced');
});

test('probe text: custom text or a random arithmetic prompt', () => {
  assert.equal(sessionProbeText('  what model are you?  '), 'what model are you?');
  assert.ok(isOwnPrompt(sessionProbeText('')));
  assert.ok(isOwnPrompt(sessionProbeText(null)));
  assert.equal(sessionProbeText('', () => 0), '1+1=');
  assert.throws(() => sessionProbeText('x'.repeat(8001)), /上限 8000/);
});

test('awaitTurnModel resolves on the next identified turn of the same conversation', async () => {
  const tracker = createTurnTracker();
  tracker.onToken('abc', 'run-1');
  tracker.record(1, 'gpt-4o', ['gpt-4o']);
  let t = 0;
  const now = () => t;
  const sleep = async () => { t += 500; };
  // nothing newer than turn 1 → times out with null
  assert.equal(await awaitTurnModel({ tracker, afterTurn: 1, sessionId: 'abc', timeoutMs: 2000, now, sleep }), null);
  // a new turn appears after two polls
  t = 0;
  let polls = 0;
  const sleep2 = async () => { t += 500; if (++polls === 2) { tracker.onToken('abc', 'run-2'); tracker.record(2, 'claude-opus-5', ['claude-opus-5']); } };
  const r = await awaitTurnModel({ tracker, afterTurn: 1, sessionId: 'abc', timeoutMs: 5000, now, sleep: sleep2 });
  assert.deepEqual(r, { turn: 2, model: 'claude-opus-5', models: ['claude-opus-5'], runId: 'run-2' });
  // a token without a model yet keeps waiting; abort signal ends it
  tracker.onToken('abc', 'run-3');
  const ac = new AbortController();
  const sleep3 = async () => { t += 500; ac.abort(); };
  assert.equal(await awaitTurnModel({ tracker, afterTurn: 2, sessionId: 'abc', timeoutMs: 5000, now, sleep: sleep3, signal: ac.signal }), null);
});

test('awaitTurnModel ignores turns of a different conversation, accepts a fresh one', async () => {
  const tracker = createTurnTracker();
  tracker.onToken('other', 'r1');
  tracker.record(1, 'gpt-4o', ['gpt-4o']);
  let t = 0;
  const now = () => t;
  const sleep = async () => { t += 500; };
  assert.equal(await awaitTurnModel({ tracker, afterTurn: 0, sessionId: 'abc', timeoutMs: 1000, now, sleep }), null);
  // fresh /agent: sessionId unknown at send time → first identified turn wins
  const fresh = createTurnTracker();
  const sleepFresh = async () => { t += 500; fresh.onToken('new-1', 'r9'); fresh.record(1, 'claude-fable-5', ['claude-fable-5']); };
  const r = await awaitTurnModel({ tracker: fresh, afterTurn: 0, sessionId: null, timeoutMs: 5000, now, sleep: sleepFresh });
  assert.equal(r.model, 'claude-fable-5');
});
