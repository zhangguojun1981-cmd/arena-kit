import test from 'node:test';
import assert from 'node:assert/strict';
import { usageFromReport, mergeUsage, summarizeUsage, formatUsage, completion, exportEvidence, sanitizeEvidence, mergeEvidence } from '../src/lib/usage.js';

// One span as emitted by src-tauri/src/usage.rs (camelCase SpanUsage).
const span = (spanId = 's1', tokens = 6600, cost = 0.0133, extra = {}) => ({
  spanId, model: 'model', provider: 'anthropic', providerIcon: 'ai-provider-anthropic',
  tokens, tokensApproximate: tokens === 6600, tokenLabel: tokens === null ? null : tokens === 6600 ? '6.6k' : String(tokens),
  costUsd: cost, costLabel: cost === null ? null : '$' + cost, partial: false, error: null, cancelled: null, ...extra,
});
const report = (spans, checkedAt = 1700000000000) => ({ runId: 'run_x', checkedAt, spans });

test('usageFromReport converts a Rust snapshot and builds evidence from raw labels', () => {
  const u = usageFromReport(report([span()]));
  assert.equal(u.runId, 'run_x');
  assert.equal(u.checkedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(u.spans.length, 1);
  const s = u.spans[0];
  assert.equal(s.tokens, 6600);
  assert.equal(s.tokensApproximate, true);
  assert.equal(s.costUsd, 0.0133);
  assert.equal(s.partial, false);
  assert.equal(s.error, null);
  assert.equal(s.evidence.schemaVersion, 1);
  assert.equal(s.evidence.tokens.value, '6.6k');
  assert.equal(s.evidence.cost.value, '$0.0133');
  assert.equal(s.evidence.provider.value, 'ai-provider-anthropic');
  assert.equal(s.evidence.model.value, 'model');
  assert.equal(s.evidence.flags.isPartial, false);
  assert.equal(s.evidence.flags.isError, null);
  assert.equal(JSON.stringify(u).includes('tokenLabel'), false);
});

test('usageFromReport tolerates missing labels and bad input', () => {
  const u = usageFromReport(report([span('s1', null, null), { spanId: 5 }, null]));
  assert.equal(u.spans.length, 1);
  assert.equal(u.spans[0].tokens, null);
  assert.equal(u.spans[0].costUsd, null);
  assert.equal(u.spans[0].evidence.tokens, undefined);
  assert.equal(usageFromReport(null), null);
  assert.equal(usageFromReport({ runId: 1 }), null);
  assert.equal(usageFromReport({ runId: 'run_y', checkedAt: 'not a date', spans: [] }).checkedAt.length > 10, true);
});

test('count leaf span once, totals across spans', () => {
  const u = usageFromReport(report([span('s1'), span('s2', 400, 0.001)]));
  const t = summarizeUsage([u]);
  assert.equal(t.spanCount, 2);
  assert.equal(t.tokens, 7000);
  assert.equal(t.costUsd, 0.0143);
  assert.equal(t.tokensApproximate, true);
  assert.equal(t.runCount, 1);
});

test('same run snapshot replaces same span, new spans accumulate', () => {
  let runs = mergeUsage([], usageFromReport(report([span()])));
  runs = mergeUsage(runs, usageFromReport(report([span()])));
  assert.equal(summarizeUsage(runs).tokens, 6600);
  runs = mergeUsage(runs, usageFromReport(report([span('s1', 7000, 0.015), span('s2', 1000, 0.002)])));
  assert.equal(summarizeUsage(runs).tokens, 8000);
  assert.equal(summarizeUsage(runs).costUsd, 0.017);
  assert.equal(runs.length, 1);
  runs = mergeUsage(runs, { ...usageFromReport(report([span('s9', 1, 0.001)])), runId: 'run_y', turn: 2 });
  assert.equal(runs.length, 2);
  assert.equal(runs[1].turn, 2);
  assert.equal(summarizeUsage(runs).runCount, 2);
});

test('merge keeps sticky flags: partial=false stays, error=true stays', () => {
  let runs = mergeUsage([], usageFromReport(report([span('s1', 1, 0.1, { partial: true })])));
  assert.equal(runs[0].spans[0].partial, true);
  runs = mergeUsage(runs, usageFromReport(report([span('s1', 1, 0.1, { partial: false, error: true })])));
  assert.equal(runs[0].spans[0].partial, false);
  assert.equal(runs[0].spans[0].error, true);
  runs = mergeUsage(runs, usageFromReport(report([span('s1', 1, 0.1, { partial: true, error: false })])));
  assert.equal(runs[0].spans[0].partial, false, 'a completed span never goes back to partial');
  assert.equal(runs[0].spans[0].error, true, 'an observed error is never un-observed');
  assert.equal(completion(runs[0].spans), '调用报错');
});

test('unknown remains null, zero remains zero, missing coverage explicit', () => {
  const missing = usageFromReport(report([span('s1', null, null)]));
  assert.equal(summarizeUsage([missing]).tokens, null);
  assert.match(formatUsage(summarizeUsage([missing])), /未提供/);
  const mixed = usageFromReport(report([span('s1', 0, 0), span('s2', null, null)]));
  const t = summarizeUsage([mixed]);
  assert.equal(t.tokens, 0);
  assert.equal(t.costUsd, 0);
  assert.match(formatUsage(t), /部分缺失/);
  assert.equal(formatUsage(null), 'Token / 费用：未提供');
  assert.match(formatUsage(summarizeUsage([usageFromReport(report([span('s1', 1, 0.5, { partial: true })]))])), /进行中/);
});

test('completion mirrors the inspector view model', () => {
  assert.equal(completion([]), '等待数据');
  assert.equal(completion([{ partial: true }]), '调用进行中');
  assert.equal(completion([{ cancelled: true }]), '调用已取消');
  assert.equal(completion([{ partial: false }]), '调用已完成');
  assert.equal(completion([{ partial: null }]), '状态未提供');
});

test('evidence sanitizer only keeps allowlisted observed labels', () => {
  const e = sanitizeEvidence({ schemaVersion: 1, model: { value: 'm', observedAt: 'bad' }, provider: { value: 'not-a-provider' }, tokens: { value: 'abc' }, cost: { value: '$1.5' }, flags: { isPartial: 'yes', isError: true } });
  assert.equal(e.model.observedAt, null);
  assert.equal(e.provider, undefined);
  assert.equal(e.tokens, undefined);
  assert.equal(e.cost.value, '$1.5');
  assert.equal(e.flags.isPartial, null);
  assert.equal(e.flags.isError, true);
  assert.equal(sanitizeEvidence({ schemaVersion: 2 }), null);
  const merged = mergeEvidence({ schemaVersion: 1, tokens: { value: '1k', observedAt: '2024-01-01T00:00:00.000Z' } }, { schemaVersion: 1, cost: { value: '$1' } });
  assert.equal(merged.tokens.value, '1k');
  assert.equal(merged.cost.value, '$1');
});

test('exportEvidence carries no raw trace and marks provenance', () => {
  const runs = mergeUsage([], { ...usageFromReport(report([span()])), turn: 1 });
  runs.push({ runId: 'run_old', spans: [{ spanId: 'z', model: 'legacy', provider: '', tokens: null, costUsd: null }] });
  const out = exportEvidence({ sessionId: 'sess', title: 'T', runs }, new Date('2024-05-01T00:00:00Z'));
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.exportedAt, '2024-05-01T00:00:00.000Z');
  assert.equal(out.totals.tokens, 6600);
  assert.equal(out.runs[0].turn, 1);
  assert.equal(out.runs[0].completion, '调用已完成');
  assert.equal(out.runs[0].calls[0].provenance, 'observed-trace-labels');
  assert.equal(out.runs[1].calls[0].provenance, 'legacy-local-record-no-raw-labels');
  assert.equal(out.runs[1].calls[0].evidence, null);
  assert.equal(JSON.stringify(out).includes('"events":'), false);
});
