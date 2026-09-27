import test from 'node:test';
import assert from 'node:assert/strict';
import { runsFor, buildRunView, metricNotes, runLabel, evidenceRows } from '../src/lib/usage-view.js';

const ev = (model, tokens, cost) => ({
  schemaVersion: 1, source: 'Trigger.dev run events', spanName: 'ai.streamText.doStream',
  model: { path: 'style.accessory.items[icon=tabler-cube].text', value: model, observedAt: '2026-09-27T10:00:00.000Z' },
  ...(tokens ? { tokens: { path: 'style.accessory.items[icon=tabler-hash].text', value: tokens, observedAt: '2026-09-27T10:00:00.000Z' } } : {}),
  ...(cost ? { cost: { path: 'style.accessory.items[icon=tabler-currency-dollar].text', value: cost, observedAt: '2026-09-27T10:00:00.000Z' } } : {}),
  flags: { isPartial: false, isError: null, isCancelled: null, observedAt: '2026-09-27T10:00:00.000Z' },
});
const record = {
  runs: [
    { runId: 'run_old', checkedAt: '2026-09-26T08:00:00.000Z', turn: 1, spans: [
      { spanId: 'a', model: 'gpt-6', provider: 'openai', tokens: 1200, tokensApproximate: true, costUsd: 0.0123, partial: false, error: null, cancelled: null, evidence: ev('gpt-6', '1.2k', '$0.0123') },
    ] },
    { runId: 'run_new', checkedAt: '2026-09-27T10:00:00.000Z', turn: 2, spans: [
      { spanId: 'b', model: 'claude-opus-5', provider: '', tokens: 800, tokensApproximate: false, costUsd: null, partial: false, error: null, cancelled: null, evidence: ev('claude-opus-5', '800', null) },
      { spanId: 'c', model: 'claude-opus-5', provider: '', tokens: null, costUsd: 0.5, partial: true, error: null, cancelled: null, evidence: null },
    ] },
  ],
  observations: [
    { runId: 'run_new', model: 'claude-opus-5', provider: 'anthropic', spanId: 'b', turn: 2, lastSeen: '2026-09-27T10:00:00.000Z' },
    { runId: 'run_legacy', model: 'gemini-3', provider: 'google', spanId: '', turn: null, lastSeen: '2026-09-25T00:00:00.000Z' },
  ],
};

test('runsFor merges stored runs with observation-only runs, newest first', () => {
  const runs = runsFor(record);
  assert.deepEqual(runs.map((r) => r.runId), ['run_new', 'run_old', 'run_legacy']);
  assert.deepEqual(runs[2].spans, []);
  assert.equal(runs[2].checkedAt, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(runsFor(null), []);
});

test('buildRunView: newest run by default, coverage, completion, provider back-filled from observations', () => {
  const v = buildRunView({ runs: record.runs, observations: record.observations, live: true });
  assert.equal(v.runId, 'run_new');
  assert.equal(v.turn, 2);
  assert.equal(v.historical, false);
  assert.equal(v.source, '本次捕获');
  assert.equal(v.calls.length, 2);
  assert.equal(v.calls[0].provider, 'anthropic');
  assert.deepEqual(v.models, [{ model: 'claude-opus-5', provider: 'anthropic' }, { model: 'claude-opus-5', provider: '' }]);
  assert.equal(v.tokens, '800');
  assert.equal(v.cost, '$0.5');
  assert.equal(v.tokenCoverage, '1/2');
  assert.equal(v.costCoverage, '1/2');
  assert.equal(v.tokenMissing, true);
  assert.equal(v.completion, '调用进行中');
  assert.equal(v.count, '2');
  assert.equal(v.evidenceCount, 1);
  const notes = metricNotes(v);
  assert.equal(notes.tokens, '部分缺失 · 覆盖 1/2 次调用');
  assert.equal(notes.cost, '部分缺失 · 覆盖 1/2 次调用');
  assert.equal(notes.count, '按 runId + spanId 去重');
});

test('buildRunView: an explicitly selected run is always a local record; approximate tokens keep ≈', () => {
  const v = buildRunView({ runs: record.runs, observations: record.observations, runId: 'run_old', live: false });
  assert.equal(v.runId, 'run_old');
  assert.equal(v.source, '本地记录 · 非重新验证');
  assert.equal(v.tokens, '≈1,200');
  assert.equal(v.cost, '$0.0123');
  assert.equal(v.completion, '调用已完成');
  assert.equal(metricNotes(v).tokens, '缩写标为约数；不推算输入／输出');
  assert.equal(metricNotes(v).cost, 'trace 展示值，非实际账单');
});

test('buildRunView: observation-only run shows the observed models, no calls; unknown run falls back to waiting', () => {
  const v = buildRunView({ runs: record.runs, observations: record.observations, runId: 'run_legacy' });
  assert.deepEqual(v.models, [{ model: 'gemini-3', provider: 'google' }]);
  assert.equal(v.count, '未提供');
  assert.equal(v.completion, '等待数据');
  assert.equal(metricNotes(v).count, '尚无调用明细');
  const none = buildRunView({ runs: [], observations: [], runId: 'nope' });
  assert.equal(none.runId, '');
  assert.equal(none.count, '—');
  assert.equal(none.source, '等待捕获');
});

test('runLabel and evidenceRows render the picker and 证据来源 fold', () => {
  const runs = runsFor(record);
  assert.match(runLabel(runs[0], record.observations), /^run_new · .+ · 第 2 轮$/);
  assert.match(runLabel(runs[2], record.observations), /^run_legacy · [^·]+$/);
  const rows = evidenceRows(buildRunView({ runs: record.runs, observations: record.observations }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].legacy, false);
  assert.deepEqual(rows[0].fields.map((f) => [f.label, f.value]), [['模型原始标签', 'claude-opus-5'], ['供应商原始标识', '未提供'], ['Token 原始标签', '800'], ['费用原始标签', '未提供']]);
  assert.equal(rows[0].fields[0].path, 'style.accessory.items[icon=tabler-cube].text');
  assert.equal(rows[0].flags, 'isPartial=false · isError=null · isCancelled=null');
  assert.equal(rows[1].legacy, true);
  assert.equal(rows[1].spanId, 'c');
});
