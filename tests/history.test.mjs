import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecord, createHistoryStore, conversationUrl, recordModels, recordTurns, searchRecords, grandTotals, addToCarry, exportHistory, MAX_ENTRIES, mergeFingerprintRecord, sanitizeFingerprintForRecord, recordFingerprintModel } from '../src/lib/history.js';
import { usageFromReport } from '../src/lib/usage.js';

const input = { sessionId: 'session-1', title: '测试会话', runId: 'run_one', checkedAt: '2026-09-15T10:00:00.000Z', models: [{ model: 'model-A', provider: 'provider', spanId: 'span1' }], token: 'NEVER_SAVE', body: 'NEVER_SAVE' };
const usage = (runId = 'run_one', tokens = 1000, cost = 0.01) => usageFromReport({ runId, checkedAt: '2026-09-15T10:00:00.000Z', spans: [{ spanId: runId + '-s', model: 'model-A', provider: 'provider', tokens, tokensApproximate: false, tokenLabel: String(tokens), costUsd: cost, costLabel: '$' + cost, partial: false }] });

/* In-memory stand-in for createStore(): get/set/keys. */
function memStore(data = {}) {
  return {
    data,
    get: async (k) => (k in data ? structuredClone(data[k]) : null),
    set: async (k, v) => { if (v === null || v === undefined) delete data[k]; else data[k] = structuredClone(v); },
    keys: async (p) => Object.keys(data).filter((k) => k.startsWith(p || '')).sort(),
  };
}

test('allowlisted fields only, canonical conversation URL', () => {
  const r = mergeRecord(null, input);
  assert.equal(r.url, 'https://arena.ai/agent/session-1');
  assert.equal(JSON.stringify(r).includes('NEVER_SAVE'), false);
  assert.throws(() => conversationUrl('../other'));
  assert.throws(() => mergeRecord(null, { ...input, models: [] }));
});

test('deduplicate same run/model; preserve observations when model changes; turns recorded', () => {
  let r = mergeRecord(null, { ...input, turn: 1 });
  r = mergeRecord(r, { ...input, checkedAt: '2026-09-15T11:00:00.000Z' });
  assert.equal(r.observations.length, 1);
  assert.equal(r.firstSeen, input.checkedAt);
  assert.equal(r.observations[0].firstSeen, input.checkedAt);
  assert.equal(r.observations[0].turn, 1, 'turn survives a re-save without turn');
  r = mergeRecord(r, { ...input, runId: 'run_two', turn: 2, checkedAt: '2026-09-15T12:00:00.000Z', models: [{ model: 'model-B' }], usage: usage('run_two', 5, 0.5) });
  assert.equal(r.observations.length, 2);
  assert.equal(r.observations[0].model, 'model-A');
  assert.deepEqual(recordModels(r), [{ model: 'model-B', provider: '' }], 'latest run first');
  assert.deepEqual(recordTurns(r).map((t) => [t.turn, t.models[0]]), [[1, 'model-A'], [2, 'model-B']]);
  assert.equal(r.runs.find((x) => x.runId === 'run_two').turn, 2);
  assert.equal(r.totals.tokens, 5);
});

test('concurrent saves serialized; persistence survives store recreation', async () => {
  const area = memStore();
  const store = createHistoryStore(area);
  await Promise.all([store.save(input), store.save({ ...input, runId: 'run_two' }), store.save({ ...input, sessionId: 'session-2', checkedAt: '2026-09-16T10:00:00.000Z' })]);
  const restored = await createHistoryStore(area).list();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].sessionId, 'session-2');
  assert.equal(restored[1].observations.length, 2);
});

test('failed save does not poison queue', async () => {
  const area = memStore();
  let fail = true;
  const realSet = area.set;
  area.set = async (k, v) => { if (fail) { fail = false; throw Error('quota'); } return realSet(k, v); };
  const store = createHistoryStore(area);
  await assert.rejects(store.save(input));
  await store.save(input);
  assert.equal((await store.list()).length, 1);
});

test('delete removes only one conversation; clear wipes history but not prefs', async () => {
  const area = memStore({ prefs: { keep: true } });
  const store = createHistoryStore(area);
  await store.save(input); await store.save({ ...input, sessionId: 'session-2' });
  await store.remove(input.sessionId);
  assert.equal(await store.get(input.sessionId), null);
  assert.deepEqual((await createHistoryStore(area).list()).map((r) => r.sessionId), ['session-2']);
  await store.remove(input.sessionId); // idempotent
  await assert.rejects(store.remove('../x'));
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(area.data.prefs, { keep: true });
});

test('eviction keeps the newest MAX_ENTRIES and carries evicted totals into the grand total', async () => {
  const area = memStore();
  const store = createHistoryStore(area, { max: 3 });
  for (let i = 1; i <= 5; i++) await store.save({ ...input, sessionId: 'sess-' + i, runId: 'run_' + i, checkedAt: `2026-09-1${i}T10:00:00.000Z`, usage: usage('run_' + i, 100, 0.1) });
  const list = await store.list();
  assert.deepEqual(list.map((r) => r.sessionId), ['sess-5', 'sess-4', 'sess-3']);
  const carry = await store.carry();
  assert.equal(carry.sessions, 2);
  assert.equal(carry.tokens, 200);
  assert.equal(carry.costUsd, 0.2);
  const g = grandTotals(list, carry);
  assert.equal(g.tokens, 500);
  assert.equal(g.costUsd, 0.5);
  assert.equal(g.sessions, 5);
  assert.equal(g.runCount, 5);
  assert.equal(MAX_ENTRIES, 200);
});

test('grandTotals is null-safe and addToCarry accumulates', () => {
  assert.equal(grandTotals([], null).tokens, null);
  assert.equal(grandTotals([], null).sessions, 0);
  const c = addToCarry(addToCarry(null, { totals: { tokens: 1, costUsd: 0.1, spanCount: 1, runCount: 1 } }), { runs: [], totals: null });
  assert.equal(c.sessions, 2);
  assert.equal(c.tokens, 1);
});

test('search matches title, session id, model and provider', () => {
  const a = mergeRecord(null, input);
  const b = mergeRecord(null, { ...input, sessionId: 'zzz', title: 'Other', models: [{ model: 'gpt-6', provider: 'openai' }] });
  assert.deepEqual(searchRecords([a, b], '测试').map((r) => r.sessionId), ['session-1']);
  assert.deepEqual(searchRecords([a, b], 'GPT').map((r) => r.sessionId), ['zzz']);
  assert.deepEqual(searchRecords([a, b], 'openai').map((r) => r.sessionId), ['zzz']);
  assert.deepEqual(searchRecords([a, b], 'zz').map((r) => r.sessionId), ['zzz']);
  assert.equal(searchRecords([a, b], '  ').length, 2);
});

test('exportHistory carries models, turns and totals but never tokens', () => {
  const r = mergeRecord(null, { ...input, turn: 1, usage: usage() });
  const out = exportHistory([r], new Date('2026-09-20T00:00:00Z'));
  assert.equal(out.sessions[0].models[0], 'model-A');
  assert.deepEqual(out.sessions[0].turns, [{ turn: 1, runId: 'run_one', models: ['model-A'] }]);
  assert.equal(out.sessions[0].totals.tokens, 1000);
  assert.equal(JSON.stringify(out).includes('NEVER_SAVE'), false);
});

test('retitle updates only the title of an existing record', async () => {
  const store = memStore();
  const h = createHistoryStore(store);
  await h.save({ sessionId: 'abc', title: 'old', models: [{ model: 'm' }], runId: 'r1' });
  const r = await h.retitle('abc', 'AK-m');
  assert.equal(r.title, 'AK-m');
  assert.equal(r.observations.length, 1);
  assert.equal((await h.get('abc')).title, 'AK-m');
  assert.equal(await h.retitle('nope', 'x'), null);
});

/* ── fingerprint estimate: statistical, kept apart from confirmed models ── */

const estimate = (over = {}) => ({
  schemaVersion: 1, sessionId: 'fp-1', family: 'opus', estimatedModel: 'claude-opus-5',
  candidates: [{ id: 'claude-opus-5', family: 'opus', score: 0.6, normalizedScore: 0.8, samples: 1, referenceVersion: 'modeltrace-summary-v1' }],
  confidence: 0.91, margin: 2.3, status: 'attributed', source: 'fingerprint',
  protocol: { id: 'modeltrace-long-integers-v1', version: '1', promptSetHash: 'abc', channel: 'arena-agent', reasoningTier: 'standard', language: 'zh' },
  referenceBankVersion: 'modeltrace-summary-v1', probeCount: 3, createdAt: '2026-10-01T00:00:00.000Z',
  rawAnswer: 'NEVER_SAVE 73 14 200', token: 'NEVER_SAVE', ...over,
});

test('sanitizeFingerprintForRecord: allowlist only, no raw answer / token', () => {
  const s = sanitizeFingerprintForRecord(estimate());
  assert.equal(s.source, 'fingerprint');
  assert.equal(s.family, 'opus');
  assert.equal(s.estimatedModel, 'claude-opus-5');
  assert.equal(s.status, 'attributed');
  assert.equal(s.protocol.id, 'modeltrace-long-integers-v1');
  assert.equal(JSON.stringify(s).includes('NEVER_SAVE'), false, 'no raw answer / token survives');
  assert.equal('candidates' in s, false, 'full candidate list is not persisted on the record');
  // bad input is clamped, never thrown
  const bad = sanitizeFingerprintForRecord({ family: 'martian', status: 'bogus', confidence: NaN, estimatedModel: 123 });
  assert.equal(bad.family, 'unknown');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.confidence, 0);
  assert.equal(sanitizeFingerprintForRecord(null), null);
});

test('mergeFingerprintRecord keeps observations/runs empty but attaches the estimate; recordFingerprintModel reads it only when attributed', async () => {
  // fresh record from a guess (no confirmed model yet — the Agent-mode case)
  const rec = mergeFingerprintRecord(null, { sessionId: 'fp-1', estimate: estimate() });
  assert.equal(rec.schemaVersion, 1);
  assert.equal(rec.url, 'https://arena.ai/agent/fp-1');
  assert.deepEqual(rec.observations, []);
  assert.deepEqual(rec.runs, []);
  assert.equal(rec.fingerprint.estimatedModel, 'claude-opus-5');
  assert.equal(JSON.stringify(rec).includes('NEVER_SAVE'), false);
  assert.equal(recordFingerprintModel(rec), 'claude-opus-5');
  // an unresolved estimate is stored but yields no model
  const un = mergeFingerprintRecord(null, { sessionId: 'fp-2', estimate: estimate({ sessionId: 'fp-2', status: 'unresolved', family: 'unknown', estimatedModel: null }) });
  assert.equal(recordFingerprintModel(un), '');
  assert.throws(() => mergeFingerprintRecord(null, { sessionId: 'fp-3', estimate: null }));
  // store: saveFingerprint creates a record and preserves a later confirmed save
  const h = createHistoryStore(memStore());
  await h.saveFingerprint({ sessionId: 'fp-4', estimate: estimate({ sessionId: 'fp-4' }) });
  const got = await h.get('fp-4');
  assert.equal(got.fingerprint.estimatedModel, 'claude-opus-5');
  assert.deepEqual(got.observations, []);
  // a confirmed observation saved afterwards does not wipe the estimate… but
  // mergeRecord (confirmed) builds a fresh record, so the estimate lives only
  // through saveFingerprint; recordModels still reflects the confirmed label.
  const confirmed = await h.save({ sessionId: 'fp-4', models: [{ model: 'claude-opus-5-5' }], runId: 'r' });
  assert.deepEqual(recordModels(confirmed), [{ model: 'claude-opus-5-5', provider: '' }]);
});
