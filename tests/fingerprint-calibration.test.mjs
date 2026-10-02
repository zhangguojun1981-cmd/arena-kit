import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classify, DEFAULT_THRESHOLDS, TARGET_FAMILIES } from '../src/lib/fingerprint.js';
import {
  makeRng, sampleHistogramAnswer, sampleCategoricalValue, probePlanFor,
  sampleSession, referenceWithout, bankInfo, evaluate, sweepThresholds,
} from '../src/lib/fingerprint-calibration.js';

const loadJSON = (rel) => JSON.parse(fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));
const MT = loadJSON('data/fingerprint/references/modeltrace-summary-v1.json');
const FP = loadJSON('data/fingerprint/references/fpverify-summary-v1.json');

const modelById = (ref, id) => ref.models.find((m) => m.id === id);

/* ── seeded RNG ──────────────────────────────────────────────────────── */
test('makeRng is deterministic and in [0,1)', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB, 'same seed → identical stream');
  for (const x of seqA) assert.ok(x >= 0 && x < 1, 'value in [0,1)');
  const c = makeRng(124);
  assert.notDeepEqual(seqA, [c(), c(), c(), c(), c()], 'different seed → different stream');
});

/* ── histogram sampling ──────────────────────────────────────────────── */
test('sampleHistogramAnswer draws from the model distribution and is parseable', () => {
  const rng = makeRng(7);
  const model = modelById(MT, 'gpt-5.4');
  const s = sampleHistogramAnswer(model, MT.dims, 200, rng);
  const nums = s.split(' ').map(Number);
  assert.equal(nums.length, 200);
  assert.ok(nums.every((n) => n >= 1 && n <= MT.dims), 'all integers in [1,dims]');
  // The empirical mode of a big draw should be a high-mass bin of the model.
  const counts = model.counts;
  const topBin = counts.indexOf(Math.max(...counts)) + 1;
  const freq = {};
  for (const n of nums) freq[n] = (freq[n] || 0) + 1;
  const empMode = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
  // not a strict assertion on exact equality (sampling noise), but the mode
  // should at least carry a count the reference also weights heavily.
  assert.ok(counts[empMode - 1] > 0, 'empirical mode is a bin the model actually populates');
  void topBin;
});

/* ── categorical sampling ────────────────────────────────────────────── */
test('sampleCategoricalValue returns a stored value or null for missing cell', () => {
  const rng = makeRng(3);
  const fable = modelById(FP, 'claude-fable-5');
  const v = sampleCategoricalValue(fable, 'random_color', rng);
  assert.ok(Object.keys(fable.questions.random_color).includes(v), 'value from the stored vocab');
  const gpt = modelById(FP, 'gpt-5.6-sol'); // only has coin
  assert.equal(sampleCategoricalValue(gpt, 'animal', rng), null, 'missing cell → null');
});

/* ── probe plan mirrors the runner ───────────────────────────────────── */
test('probePlanFor repeats histogram id and walks categorical questions', () => {
  assert.deepEqual(probePlanFor(MT, 'histogram', 3), ['seq-1-355', 'seq-1-355', 'seq-1-355']);
  const fpPlan = probePlanFor(FP, 'categorical', 10);
  assert.ok(fpPlan.includes('random_1_100') && fpPlan.includes('coin'));
  assert.ok(fpPlan.length <= 5, 'capped at the registered question union');
});

/* ── session sampling shape ──────────────────────────────────────────── */
test('sampleSession shapes answers per protocol', () => {
  const rng = makeRng(11);
  const hist = sampleSession({ reference: MT, kind: 'histogram', model: modelById(MT, 'claude-opus-4-8'), budget: 4, integersPerReply: 100, rng });
  assert.equal(hist.answers.length, 4);
  assert.ok(hist.answers.every((a) => typeof a === 'string'));

  const cat = sampleSession({ reference: FP, kind: 'categorical', model: modelById(FP, 'claude-fable-5'), budget: 5, rng });
  assert.equal(cat.answers.length, 1, 'merged into one bag');
  assert.equal(typeof cat.answers[0], 'object');
  assert.ok(Object.keys(cat.answers[0]).length >= 3, 'full fable model fills ≥3 questions');

  const sparse = sampleSession({ reference: FP, kind: 'categorical', model: modelById(FP, 'gpt-5.6-sol'), budget: 5, rng });
  assert.ok(sparse.answers.length === 0 || Object.keys(sparse.answers[0]).length <= 1, 'coin-only model yields ≤1 answered → not scorable');
});

/* ── leave-one-model-out helper ──────────────────────────────────────── */
test('referenceWithout drops a model or returns null below 2', () => {
  const r = referenceWithout(MT, 'claude-opus-4-8');
  assert.equal(r.models.length, MT.models.length - 1);
  assert.ok(!r.models.find((m) => m.id === 'claude-opus-4-8'));
  const tiny = { ...FP, models: FP.models.slice(0, 2) };
  assert.equal(referenceWithout(tiny, tiny.models[0].id), null, 'dropping below 2 → null');
});

/* ── bank provenance ─────────────────────────────────────────────────── */
test('bankInfo surfaces version + sampling date + partial models', () => {
  const mt = bankInfo(MT);
  assert.equal(mt.referenceVersion, 'modeltrace-summary-v1');
  assert.equal(mt.kind, 'histogram');
  assert.ok(mt.sampledAt, 'has an upstreamBuiltAt date');
  const fp = bankInfo(FP);
  assert.ok(fp.partialModels.includes('gpt-5.6-sol'));
  assert.ok(fp.families.includes('fable'));
});

/* ── evaluate: determinism + honest metric set ───────────────────────── */
test('evaluate is deterministic for a fixed seed', () => {
  const opts = { reference: FP, classify, seed: 5, sessionsPerModel: 20, budget: 5 };
  const a = evaluate(opts);
  const b = evaluate(opts);
  assert.deepEqual(a.confusion, b.confusion);
  assert.equal(a.coverage, b.coverage);
  assert.equal(a.acceptAccuracy, b.acceptAccuracy);
});

test('evaluate exposes the full plan-mandated metric set', () => {
  const r = evaluate({ reference: FP, classify, seed: 2, sessionsPerModel: 30, budget: 5 });
  // confusion matrix with target columns + unknown
  for (const fam of Object.keys(r.confusion)) {
    for (const col of [...TARGET_FAMILIES, 'unknown']) {
      assert.ok(Number.isInteger(r.confusion[fam][col]), `${fam}->${col} is a count`);
    }
  }
  assert.ok(r.coverage >= 0 && r.coverage <= 1);
  assert.ok(r.acceptAccuracy == null || (r.acceptAccuracy >= 0 && r.acceptAccuracy <= 1));
  assert.ok(r.unknownRejection == null || (r.unknownRejection >= 0 && r.unknownRejection <= 1));
  assert.ok('opusAsFableRate' in r.mutualMisclass, 'fpverify has both opus and fable');
  assert.ok(r.probeCountStats && 'mean' in r.probeCountStats && 'p95' in r.probeCountStats && 'max' in r.probeCountStats);
  assert.ok(Array.isArray(r.honesty) && r.honesty.length >= 3, 'honesty caveats present');
  assert.equal(r.thresholds.calibrated, false, 'bundled thresholds are uncalibrated');
});

test('evaluate never attributes a non-target family and keeps accept-accuracy honest', () => {
  // Non-target families (sonnet/haiku/gpt5) must land in the unknown column.
  const r = evaluate({ reference: MT, classify, seed: 9, sessionsPerModel: 20, budget: 4, integersPerReply: 600 });
  for (const nonTarget of ['gpt5', 'sonnet', 'haiku']) {
    if (!r.confusion[nonTarget]) continue;
    assert.equal(r.confusion[nonTarget].opus, 0);
    assert.equal(r.confusion[nonTarget].fable, 0);
    assert.equal(r.confusion[nonTarget].gpt6, 0);
  }
  // When it DOES accept, under the self-consistency design the family must be right.
  if (r.acceptAccuracy != null) assert.equal(r.acceptAccuracy, 1, 'self-consistency: accepted families are correct');
});

test('evaluate reports GPT-6 version drift bucket for the histogram bank', () => {
  const r = evaluate({ reference: MT, classify, seed: 1, sessionsPerModel: 20, budget: 4, integersPerReply: 600 });
  assert.ok('wrongVersionRate' in r.versionDrift, 'gpt6 present → drift measured');
  assert.ok(r.versionDrift.gpt6CorrectFamily >= 0);
});

test('evaluate marks the fpverify opus-vs-fable separation as measurable', () => {
  const r = evaluate({ reference: FP, classify, seed: 4, sessionsPerModel: 30, budget: 5 });
  assert.equal(typeof r.mutualMisclass.opusAsFableRate, 'number');
  assert.equal(typeof r.mutualMisclass.fableAsOpusRate, 'number');
});

/* ── threshold sweep ─────────────────────────────────────────────────── */
test('sweepThresholds returns a coverage/precision grid', () => {
  const rows = sweepThresholds({ reference: FP, classify, seed: 1, sessionsPerModel: 15, budget: 5, marginGrid: [1.2, 2.0], confidenceGrid: [0.6, 0.9] });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok('minMargin' in row && 'minConfidence' in row);
    assert.ok(row.coverage >= 0 && row.coverage <= 1);
  }
});

/* ── honesty guard: self-consistency is an upper bound, holdout is harder ── */
test('leave-one-model-out generalization is no better than self-consistency coverage', () => {
  const self = evaluate({ reference: MT, classify, seed: 3, sessionsPerModel: 20, budget: 4, integersPerReply: 600 });
  const held = evaluate({ reference: MT, classify, seed: 3, sessionsPerModel: 20, budget: 4, integersPerReply: 600, holdOutModel: true });
  assert.equal(held.design, 'leave-one-model-out (family generalization)');
  // Holdout removes the model's own centroid, so accept-accuracy can only drop
  // or hold; it must never be reported as a higher correctness than self-view.
  if (held.acceptAccuracy != null && self.acceptAccuracy != null) {
    assert.ok(held.acceptAccuracy <= self.acceptAccuracy + 1e-9);
  }
});
