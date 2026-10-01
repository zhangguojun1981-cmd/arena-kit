import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createFingerprintRunner, buildProbePlan, countsToAnswerString,
  FP_MAX_BUDGET, isCancelled,
} from '../src/lib/fingerprint-runner.js';
import { classify, histogram } from '../src/lib/fingerprint.js';

const loadJSON = (rel) => JSON.parse(fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));
const MT = loadJSON('data/fingerprint/references/modeltrace-summary-v1.json');
const FP = loadJSON('data/fingerprint/references/fpverify-summary-v1.json');

const MT_PROBE_IDS = ['seq-1-355'];
const FP_PROBE_IDS = ['random_1_100', 'random_color', 'animal', 'city', 'coin'];

/* A scripted fake page + reducer. Every real side effect is a mock: NO real
 * model calls, NO DOM, NO IPC. The "page" returns a fresh session id per send
 * and the "reducer" hands back a scripted structured feature per probe. */
function harness({
  protocolId = 'modeltrace-long-integers-v1',
  reference = MT,
  probeIds = MT_PROBE_IDS,
  featuresByProbe = [],         // array of structured features returned in order
  candidates = ['claude-opus-5', 'claude-fable-5'],
  otherRun = false,
  page = { onArena: true, agentPath: true, session: null },
  pageSeq = null,               // optional: array of page snapshots, one consumed per pageState() call
  thresholds = undefined,
} = {}) {
  const calls = [];
  const dispatched = [];
  const log = [];
  const results = [];
  const runStates = [];
  let sends = 0;
  let featIdx = 0;
  let pageIdx = 0;

  const rpc = {
    call: async (action, args = {}) => {
      calls.push({ action, args });
      if (action === 'sendFingerprintProbe') {
        return { session: 'sess-' + (++sends), probeId: args.probeId };
      }
      return {};
    },
  };

  const runner = createFingerprintRunner({
    rpc,
    dispatchToPage: (name, payload) => dispatched.push({ name, payload }),
    loadReference: async () => reference,
    classify,
    probeIdsForProtocol: () => probeIds,
    takeFeature: async () => {
      const f = featuresByProbe[featIdx] ?? null;
      featIdx += 1;
      return f;
    },
    candidateModelsForSession: () => candidates,
    otherRunActive: () => otherRun,
    pageState: () => {
      if (pageSeq) { const s = pageSeq[Math.min(pageIdx, pageSeq.length - 1)]; pageIdx += 1; return s; }
      return page;
    },
    protocolMeta: () => ({ kind: reference.kind || 'histogram', channel: 'test', reasoningTier: 'base', language: 'en' }),
    onProgress: (l) => log.push(l),
    onResult: (r) => results.push(r),
    onFinished: (s) => log.push('FIN ' + s),
    onRunState: (r, m, a) => runStates.push([r, m, a]),
    sleep: () => Promise.resolve(),
    roundPacingMs: 0,
    featureWaitMs: 10,
  });

  return { runner, calls, dispatched, log, results, runStates, startCfg: { protocolId, maxRounds: probeIds.length, budgetConfirmed: true, thresholds } };
}

/* Build a histogram feature that matches a reference model's distribution. */
function featureForModel(ref, id) {
  const m = ref.models.find((x) => x.id === id);
  return { kind: 'histogram', counts: m.counts.slice(), n: m.counts.reduce((a, b) => a + b, 0), dims: ref.dims, parseError: 0 };
}

/* ── buildProbePlan ──────────────────────────────────────────────────── */
test('buildProbePlan repeats the histogram probe up to the budget', () => {
  const plan = buildProbePlan('modeltrace-long-integers-v1', ['seq-1-355'], 3);
  assert.equal(plan.length, 3);
  assert.ok(plan.every((p) => p.probeId === 'seq-1-355' && p.kind === 'histogram' && p.questionId === null));
});

test('buildProbePlan walks the categorical battery one probe per question', () => {
  const plan = buildProbePlan('fpverify-battery-v1', FP_PROBE_IDS, 10);
  assert.equal(plan.length, FP_PROBE_IDS.length);
  assert.deepEqual(plan.map((p) => p.questionId), FP_PROBE_IDS);
  assert.ok(plan.every((p) => p.kind === 'categorical'));
});

test('buildProbePlan clamps to FP_MAX_BUDGET and rejects empty ids', () => {
  assert.equal(buildProbePlan('modeltrace-long-integers-v1', ['seq-1-355'], 999).length, FP_MAX_BUDGET);
  assert.deepEqual(buildProbePlan('modeltrace-long-integers-v1', [], 3), []);
});

test('countsToAnswerString round-trips through the histogram parser', () => {
  const counts = histogram([3, 3, 7, 200], 355);
  const str = countsToAnswerString(counts);
  // three 3-tokens is nonsense ordering but the histogram is order-independent.
  assert.ok(/\b3\b/.test(str) && /\b7\b/.test(str) && /\b200\b/.test(str));
});

/* ── start gate ──────────────────────────────────────────────────────── */
test('preflight refuses when fewer than two candidates and a thin bank', async () => {
  const h = harness({ candidates: ['only-one'], reference: { ...MT, models: MT.models.slice(0, 1) } });
  const pf = await h.runner.preflight(h.startCfg);
  assert.equal(pf.ok, false);
  assert.match(pf.reason, /候选模型不足/);
});

test('preflight refuses without a confirmed budget', async () => {
  const h = harness();
  const pf = await h.runner.preflight({ ...h.startCfg, budgetConfirmed: false });
  assert.equal(pf.ok, false);
  assert.match(pf.reason, /最大消息数/);
});

test('preflight refuses when another run is active', async () => {
  const h = harness({ otherRun: true });
  const pf = await h.runner.preflight(h.startCfg);
  assert.equal(pf.ok, false);
  assert.match(pf.reason, /其他探针/);
});

test('preflight refuses an unknown protocol / empty probe ids', async () => {
  const h = harness({ probeIds: [] });
  const pf = await h.runner.preflight(h.startCfg);
  assert.equal(pf.ok, false);
  assert.match(pf.reason, /登记的探针/);
});

test('start() refuses (does not send) when the gate fails', async () => {
  const h = harness({ otherRun: true });
  const r = await h.runner.start(h.startCfg);
  assert.equal(r.started, false);
  assert.equal(h.calls.length, 0, 'no probe was sent');
});

/* ── happy path: histogram ──────────────────────────────────────────── */
test('histogram run: sends fixed probes, arms/disarms the reducer, classifies incrementally', async () => {
  const feats = [featureForModel(MT, MT.models[0].id), featureForModel(MT, MT.models[0].id)];
  const h = harness({ featuresByProbe: feats, probeIds: MT_PROBE_IDS });
  const r = await h.runner.start({ ...h.startCfg, maxRounds: 2 });
  assert.equal(r.started, true);
  assert.equal(r.sent, 2);
  // only the allowlisted action was ever used — never 'send' or 'sendToCurrent'.
  const probeCalls = h.calls.filter((c) => c.action === 'sendFingerprintProbe');
  assert.equal(probeCalls.length, 2);
  assert.ok(probeCalls.every((c) => c.args.probeId === 'seq-1-355' && !('prompt' in c.args)));
  assert.ok(!h.calls.some((c) => c.action === 'send' || c.action === 'sendToCurrent'));
  // reducer armed once per probe, disarmed afterwards.
  assert.equal(h.dispatched.filter((d) => d.name === 'fingerprint-arm').length, 2);
  assert.ok(h.dispatched.some((d) => d.name === 'fingerprint-disarm'));
  // each arm carried only structured ids, no prompt text.
  for (const d of h.dispatched.filter((d) => d.name === 'fingerprint-arm')) {
    assert.deepEqual(Object.keys(d.payload).sort(), ['kind', 'probeId', 'protocolId', 'questionId', 'sessionId']);
  }
  assert.ok(h.results.length >= 1, 'classify ran incrementally');
});

/* ── stop() cancels mid-run ──────────────────────────────────────────── */
test('stop() cancels the run; isRunning flips back to false', async () => {
  // takeFeature never resolves until we cancel — simulate a long reply.
  let resolveFeature;
  const rpc = { call: async (a, args = {}) => (a === 'sendFingerprintProbe' ? { session: 's1', probeId: args.probeId } : {}) };
  const log = [];
  const runner = createFingerprintRunner({
    rpc,
    dispatchToPage: () => {},
    loadReference: async () => MT,
    classify,
    probeIdsForProtocol: () => MT_PROBE_IDS,
    takeFeature: () => new Promise((res) => { resolveFeature = res; }),
    candidateModelsForSession: () => ['a', 'b'],
    otherRunActive: () => false,
    pageState: () => ({ onArena: true, agentPath: true }),
    protocolMeta: () => ({}),
    onProgress: (l) => log.push(l),
    sleep: () => Promise.resolve(),
    roundPacingMs: 0,
  });
  const p = runner.start({ protocolId: 'modeltrace-long-integers-v1', maxRounds: 3, budgetConfirmed: true });
  // let the loop reach the awaiting-feature point.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runner.isRunning, true);
  runner.stop();
  const r = await p;
  assert.equal(runner.isRunning, false);
  assert.equal(r.cancelled, true);
  void resolveFeature;
});

/* ── page change stops the run ───────────────────────────────────────── */
test('a page/mode change stops before sending the next probe', async () => {
  const feats = [featureForModel(MT, MT.models[0].id)];
  // pageState() is read once per loop iteration (pageChanged at the top).
  // Round 1 sees on-arena, round 2 sees off-arena → stop before probe 2.
  const h = harness({
    featuresByProbe: feats,
    probeIds: MT_PROBE_IDS,
    pageSeq: [
      { onArena: true, agentPath: true },   // round 1 check
      { onArena: false, agentPath: false },  // round 2 check → stop
    ],
  });
  const r = await h.runner.start({ ...h.startCfg, maxRounds: 3 });
  assert.equal(r.started, true);
  assert.ok(r.sent <= 1);
  assert.ok(h.log.some((l) => /页面\/模式已变化/.test(l)));
});

/* ── consecutive failure cap ─────────────────────────────────────────── */
test('three consecutive feature failures stop the run', async () => {
  // takeFeature always returns null → each probe counts as a failure.
  const h = harness({ featuresByProbe: [null, null, null, null, null], probeIds: MT_PROBE_IDS });
  const r = await h.runner.start({ ...h.startCfg, maxRounds: 10 });
  assert.equal(r.started, true);
  assert.ok(h.log.some((l) => /连续失败/.test(l)));
});

/* ── categorical battery merges per-question picks ───────────────────── */
test('categorical battery merges picks into one answer vector for classify', async () => {
  const feats = [
    { kind: 'categorical', questionId: 'random_1_100', value: '73', parseError: 0 },
    { kind: 'categorical', questionId: 'random_color', value: 'teal', parseError: 0 },
    { kind: 'categorical', questionId: 'animal', value: 'otter', parseError: 0 },
    { kind: 'categorical', questionId: 'city', value: 'kyoto', parseError: 0 },
    { kind: 'categorical', questionId: 'coin', value: 'heads', parseError: 0 },
  ];
  const h = harness({ protocolId: 'fpverify-battery-v1', reference: FP, probeIds: FP_PROBE_IDS, featuresByProbe: feats });
  const r = await h.runner.start({ protocolId: 'fpverify-battery-v1', maxRounds: FP_PROBE_IDS.length, budgetConfirmed: true });
  assert.equal(r.started, true);
  assert.ok(r.result, 'produced a classify result');
  // the final result is a real verdict (attributed OR a principled unresolved),
  // never a crash and never a forced label from one answer.
  assert.ok(['attributed', 'unresolved'].includes(r.result.status));
});

/* ── never attributes early on an uncalibrated bank ──────────────────── */
test('uncalibrated bank: run completes the full plan, does not short-circuit', async () => {
  const feats = [featureForModel(MT, MT.models[0].id), featureForModel(MT, MT.models[0].id), featureForModel(MT, MT.models[0].id)];
  // reference.calibrated is absent/false → no early stop even if attributed.
  const h = harness({ featuresByProbe: feats, probeIds: MT_PROBE_IDS });
  const r = await h.runner.start({ ...h.startCfg, maxRounds: 3 });
  assert.equal(r.sent, 3, 'sent all planned probes, no early stop on uncalibrated bank');
});
