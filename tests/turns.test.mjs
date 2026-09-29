import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTracker, MAX_HISTORY } from '../src/lib/turns.js';

// ---- turn counting within one conversation (TurnTrackerTest.kt) ----
test('tokens within the same conversation increment turns', () => {
  const t = createTurnTracker();
  assert.deepEqual(t.onToken('s1'), { turn: 1, switched: true, repeat: false });
  assert.deepEqual(t.onToken('s1'), { turn: 2, switched: false, repeat: false });
  assert.deepEqual(t.onToken('s1'), { turn: 3, switched: false, repeat: false });
  assert.equal(t.turnCount, 3);
});

test('empty session token keeps the current conversation', () => {
  const t = createTurnTracker();
  t.onToken('s1');
  assert.deepEqual(t.onToken(''), { turn: 2, switched: false, repeat: false });
  assert.equal(t.sessionId, 's1');
});

test('the same run id does not open a second turn (re-polled token)', () => {
  const t = createTurnTracker();
  assert.equal(t.onToken('s1', 'run_a').turn, 1);
  assert.deepEqual(t.onToken('s1', 'run_a'), { turn: 1, switched: false, repeat: true });
  assert.equal(t.onToken('s1', 'run_b').turn, 2);
  assert.equal(t.turnOf('run_a'), 1);
  assert.equal(t.turnOf('run_b'), 2);
  assert.equal(t.turnOf('run_zzz'), null);
  assert.equal(t.turnOf(''), null);
});

// ---- conversation switching ----
test('different session switches and restarts at turn one', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.onToken('s1');
  const { turn, switched } = t.onToken('s2');
  assert.equal(switched, true);
  assert.equal(turn, 1);
  assert.equal(t.sessionId, 's2');
});

test('same model in a new conversation is not routed', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-x');
  t.onToken('s2');
  assert.equal(t.firstModel, '');
  assert.equal(t.routed, false);
  assert.equal(t.lastModel, '');
  t.record(1, 'model-x');
  assert.equal(t.routed, false, 'same model as the previous chat must NOT read routed');
  assert.equal(t.firstModel, 'model-x');
});

test('routed only when model differs from the current conversation first model', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-a');
  assert.equal(t.routed, false);
  t.onToken('s1');
  const line = t.record(2, 'model-b');
  assert.equal(t.routed, true);
  assert.ok(line.startsWith('第 2 轮 · 已切换模型 → model-b'));
  t.onToken('s1'); t.record(3, 'model-a');
  assert.equal(t.routed, false);
});

test('routed but unchanged from previous turn reads non-first model', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-a');
  t.onToken('s1'); t.record(2, 'model-b');
  t.onToken('s1');
  const line = t.record(3, 'model-b');
  assert.equal(t.routed, true);
  assert.ok(line.startsWith('第 3 轮 · model-b（非首轮模型）'));
});

// ---- history line ----
test('history line lists turns newest last', () => {
  const t = createTurnTracker();
  t.onToken('s1');
  const status = t.record(1, 'model-a');
  t.onToken('s1');
  const status2 = t.record(2, 'model-b');
  assert.equal(status, '第 1 轮 · model-a\n本会话: R1 model-a');
  assert.equal(status2, '第 2 轮 · 已切换模型 → model-b\n本会话: R1 model-a · R2 model-b');
});

test('history is capped at six entries', () => {
  const t = createTurnTracker();
  t.onToken('s1');
  for (let i = 1; i <= 8; i++) { t.onToken('s1'); t.record(i, 'model-a'); }
  const line = t.historyLine();
  assert.equal(line.includes('R1 '), false);
  assert.equal(line.includes('R2 '), false);
  assert.ok(line.includes('R3 model-a'));
  assert.ok(line.includes('R8 model-a'));
  assert.equal(line.replace('本会话: ', '').split(' · ').length, 6);
  assert.equal(MAX_HISTORY, 6);
});

test('switch clears history so the new conversation log is complete', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-a');
  t.onToken('s1'); t.record(2, 'model-b');
  t.onToken('s2');
  assert.equal(t.historyLine(), '本会话: ');
  t.record(1, 'model-b');
  assert.equal(t.historyLine(), '本会话: R1 model-b');
});

// ---- reset / clearRouted ----
test('reset clears everything', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-a');
  t.reset();
  assert.equal(t.sessionId, '');
  assert.equal(t.turnCount, 0);
  assert.equal(t.firstModel, '');
  assert.equal(t.lastModel, '');
  assert.equal(t.routed, false);
  assert.equal(t.historyLine(), '本会话: ');
  assert.deepEqual(t.turns, []);
});

test('clearRouted keeps turn state', () => {
  const t = createTurnTracker();
  t.onToken('s1'); t.record(1, 'model-a');
  t.onToken('s1'); t.record(2, 'model-b');
  assert.equal(t.routed, true);
  t.clearRouted();
  assert.equal(t.routed, false);
  assert.equal(t.firstModel, 'model-a');
  assert.equal(t.historyLine(), '本会话: R1 model-a · R2 model-b');
});

// ---- timeline entries (dock extension) ----
test('turn entries carry model, status and deduplicated marks', () => {
  const t = createTurnTracker();
  t.onToken('s1', 'run_1');
  assert.equal(t.turns[0].status, '识别中');
  t.record(1, 'model-a', ['model-a', 'model-a2']);
  assert.deepEqual(t.turns[0].models, ['model-a', 'model-a2']);
  assert.equal(t.turns[0].status, '已识别');
  assert.equal(t.turns[0].routed, false);
  assert.equal(t.mark(1, 'empty', '空回复'), true);
  assert.equal(t.mark(1, 'empty', '空回复'), false);
  assert.equal(t.mark(9, 'empty', '空回复'), false);
  assert.deepEqual(t.turns[0].marks, [{ kind: 'empty', label: '空回复' }]);
  t.setStatus(1, '完成');
  assert.equal(t.turns[0].status, '完成');
});

test('record keeps an optional strength tier per turn and turns are keyed by the caller\'s run key', () => {
  const t = createTurnTracker();
  const a = t.onToken('s1', 'tok-key-1');
  assert.equal(a.turn, 1);
  t.record(1, 'gpt-6', ['gpt-6'], 'high');
  assert.equal(t.turns[0].strength, 'high');
  // Same run id delivered again under a different token key = a new turn.
  const b = t.onToken('s1', 'tok-key-2');
  assert.equal(b.turn, 2);
  assert.equal(b.repeat, false);
  t.record(2, 'gpt-6', ['gpt-6']);
  assert.equal(t.turns[1].strength, undefined);
  assert.equal(t.turnOf('tok-key-2'), 2);
  assert.equal(t.onToken('s1', 'tok-key-1').repeat, true);
});
