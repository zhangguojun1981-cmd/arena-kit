import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SCHEMA_VERSION, TARGET_FAMILIES, DEFAULT_THRESHOLDS, PROTOCOL_MIN_SIGNAL,
  parseIntegers, histogram, smoothedProbs, bhattacharyya,
  validateReference, extractFeature, scoreCandidates, classify, sanitizeResult,
} from '../src/lib/fingerprint.js';

const loadJSON = (rel) => JSON.parse(fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));
const MT = loadJSON('data/fingerprint/references/modeltrace-summary-v1.json');
const FP = loadJSON('data/fingerprint/references/fpverify-summary-v1.json');

/* Build a synthetic histogram answer string whose longest integer run matches
 * a given reference model's distribution exactly (counts → repeated numbers). */
function answerFromCounts(counts) {
  const parts = [];
  for (let i = 0; i < counts.length; i++) for (let k = 0; k < counts[i]; k++) parts.push(i + 1);
  // light shuffle-free join with spaces; order is irrelevant to the histogram
  return parts.join(' ');
}
const modelById = (ref, id) => ref.models.find((m) => m.id === id);

/* ── parser ──────────────────────────────────────────────────────────── */
test('parseIntegers keeps the longest run and splits on letters', () => {
  assert.deepEqual(parseIntegers('1 2 3 note 4 5'), [1, 2, 3]); // first run is longer? tie → first found of max len
  assert.deepEqual(parseIntegers('1 2 note 4 5 6'), [4, 5, 6]);
  assert.deepEqual(parseIntegers('500 2 3', { min: 1, max: 355 }), [2, 3], 'out-of-range dropped');
  assert.deepEqual(parseIntegers('hello'), []);
  assert.deepEqual(parseIntegers('1. 23\n2. 57\n3. 91'), [1, 23, 2, 57, 3, 91], 'markdown list digits all in one run (no letters between)');
});

test('histogram + smoothedProbs are well formed', () => {
  const h = histogram([1, 1, 2], 3);
  assert.deepEqual(h, [2, 1, 0]);
  const p = smoothedProbs(h);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'probs sum to 1');
  assert.ok(p[2] > 0, 'add-0.5 keeps unseen bin positive');
  const uni = smoothedProbs([0, 0, 0, 0]);
  assert.ok(Math.abs(uni.reduce((a, b) => a + b) - 1) < 1e-9);
});

test('bhattacharyya is 1 for identical, lower for divergent', () => {
  const a = smoothedProbs([5, 0, 0]);
  const b = smoothedProbs([0, 0, 5]);
  assert.ok(bhattacharyya(a, a) > bhattacharyya(a, b));
  assert.ok(bhattacharyya(a, a) <= 1 + 1e-9);
});

/* ── reference validation ────────────────────────────────────────────── */
test('bundled references validate as histogram / categorical', () => {
  assert.equal(validateReference(MT).kind, 'histogram');
  assert.equal(validateReference(FP).kind, 'categorical');
});

test('validateReference rejects malformed banks', () => {
  assert.throws(() => validateReference(null), /不是对象/);
  assert.throws(() => validateReference({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validateReference({ schemaVersion: 1, protocolId: 'x', referenceVersion: 'v', dims: 3, models: [] }), /没有模型/);
  assert.throws(() => validateReference({ schemaVersion: 1, protocolId: 'x', referenceVersion: 'v', dims: 3, models: [{ id: 'm', family: 'opus', counts: [1, 2] }] }), /维度不符/);
});

/* ── ModelTrace histogram classification ─────────────────────────────── */
test('a sample drawn from a reference model classifies to its family', () => {
  const opus = modelById(MT, 'claude-opus-5');
  const ans = answerFromCounts(opus.counts);
  const r = classify({ sessionId: 's1', protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [ans] });
  assert.equal(r.status, 'attributed');
  assert.equal(r.family, 'opus');
  assert.equal(r.candidates[0].id, 'claude-opus-5');
  assert.equal(r.estimatedModel, 'claude-opus-5');
  assert.equal(r.source, 'fingerprint');
  assert.equal(r.referenceBankVersion, 'modeltrace-summary-v1');
});

test('a GPT-6 sample classifies to gpt6', () => {
  const g = modelById(MT, 'gpt-6-astra');
  const r = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [answerFromCounts(g.counts)] });
  assert.equal(r.family, 'gpt6');
  assert.equal(r.candidates[0].id, 'gpt-6-astra');
});

test('closest match is a non-target family → unknown, never forced into a target', () => {
  const sonnet = modelById(MT, 'claude-sonnet-5');
  const r = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [answerFromCounts(sonnet.counts)] });
  assert.equal(r.candidates[0].family, 'sonnet');
  assert.equal(r.family, 'unknown');
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'closest-is-non-target');
  assert.equal(r.estimatedModel, null);
});

test('too-short integer answer carries insufficient signal', () => {
  const r = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: ['1 2 3 4 5'] });
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'insufficient-signal');
  assert.equal(PROTOCOL_MIN_SIGNAL['modeltrace-long-integers-v1'], 80);
});

test('a flat / uniform-random answer is rejected, never given a confident target', () => {
  // deterministic pseudo-uniform sequence over 1..355, length 300
  let x = 12345;
  const nums = [];
  for (let i = 0; i < 300; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; nums.push((x % 355) + 1); }
  const r = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [nums.join(' ')] });
  // A uniform batch resembles every near-uniform reference equally, so even if
  // the family softmax happens to tip one way, the absolute affinity floor must
  // keep it unresolved. This is the ModelTrace PRNG counterexample behaviour:
  // confident closed-set labels on noise are a FAILURE, and we refuse them.
  assert.equal(r.status, 'unresolved');
  assert.equal(r.family, 'unknown');
  assert.equal(r.reason, 'no-close-reference');
  assert.equal(r.estimatedModel, null);
});

test('protocol mismatch between answer protocol and reference bank fails cleanly', () => {
  const r = classify({ protocol: { id: 'fpverify-battery-v1' }, reference: MT, answers: ['1 2 3'] });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /协议与参考库不匹配/);
});

/* ── fpverify categorical classification ─────────────────────────────── */
test('a full Fable battery classifies to fable; a single magic answer does not', () => {
  const fable = { random_1_100: '73', random_color: 'teal', animal: 'otter', city: 'kyoto', coin: 'heads' };
  const r = classify({ protocol: { id: 'fpverify-battery-v1' }, reference: FP, answers: [fable] });
  assert.equal(r.family, 'fable');
  assert.equal(r.candidates[0].id, 'claude-fable-5');

  // "answered 73" alone — Fable AND Opus-4.8-thinking both emit 73; must not be
  // a confident fable attribution on one shared answer.
  const single = classify({ protocol: { id: 'fpverify-battery-v1' }, reference: FP, answers: [{ random_1_100: '73' }] });
  assert.notEqual(single.status, 'attributed');
});

test('scoreCandidates ranks the matching model first (histogram)', () => {
  const opus = modelById(MT, 'claude-opus-4-8');
  const f = extractFeature(MT, 'histogram', answerFromCounts(opus.counts));
  const { perModel } = scoreCandidates(MT, 'histogram', [f]);
  assert.equal(perModel[0].id, 'claude-opus-4-8');
});

/* Draw `n` integers from a reference model's own distribution (seeded LCG), so
 * we get a NOISY but genuine sample rather than the exact histogram. */
function drawFromCounts(counts, n, seed) {
  const total = counts.reduce((a, b) => a + b, 0);
  const cum = []; let s = 0;
  for (const v of counts) { s += v; cum.push(s / total); }
  let y = seed >>> 0; const out = [];
  for (let i = 0; i < n; i++) {
    y = (y * 1103515245 + 12345) & 0x7fffffff;
    const u = (y % 100000) / 100000;
    let j = 0; while (j < cum.length && u > cum[j]) j++;
    out.push(j + 1);
  }
  return out;
}

test('a noisy but genuine reply attributes once it carries enough signal; a short one stays unresolved', () => {
  const opus = modelById(MT, 'claude-opus-5');
  // One short noisy reply (300 numbers) is honestly under-powered → unresolved,
  // not a false attribution.
  const short = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [drawFromCounts(opus.counts, 300, 7).join(' ')] });
  assert.equal(short.status, 'unresolved');
  // A larger genuine sample (≈900 numbers) clears the OOD ratio gate and lands
  // on the right family/model.
  const big = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [drawFromCounts(opus.counts, 900, 7).join(' ')] });
  assert.equal(big.status, 'attributed');
  assert.equal(big.family, 'opus');
  assert.equal(big.estimatedModel, 'claude-opus-5');
});

test('uniform PRNG batches stay unresolved at every sample size (OOD ratio gate)', () => {
  for (const [n, seed] of [[300, 99], [900, 99], [1800, 99]]) {
    let y = seed >>> 0; const nums = [];
    for (let i = 0; i < n; i++) { y = (y * 1103515245 + 12345) & 0x7fffffff; nums.push((y % 355) + 1); }
    const r = classify({ protocol: { id: 'modeltrace-long-integers-v1' }, reference: MT, answers: [nums.join(' ')] });
    assert.equal(r.status, 'unresolved', `n=${n} must be unresolved`);
    assert.equal(r.reason, 'no-close-reference', `n=${n} must be rejected as OOD`);
    assert.equal(r.estimatedModel, null);
  }
});

/* ── serialization safety ────────────────────────────────────────────── */
test('sanitizeResult drops stray fields and never carries raw text', () => {
  const dirty = {
    schemaVersion: 1, sessionId: 'abc', family: 'opus', estimatedModel: 'claude-opus-5',
    candidates: [{ id: 'claude-opus-5', family: 'opus', score: 0.9, normalizedScore: 0.4, samples: 36, referenceVersion: 'modeltrace-summary-v1', secretRawAnswer: 'eyJhbGc...' }],
    confidence: 0.8, margin: 2.1, status: 'attributed', source: 'fingerprint',
    protocol: { id: 'modeltrace-long-integers-v1', version: '1', channel: 'arena', reasoningTier: '', language: 'zh', promptSetHash: 'h', junk: 'x' },
    referenceBankVersion: 'modeltrace-summary-v1', probeCount: 3, createdAt: '2026-10-01T00:00:00Z',
    token: 'eyJhbGciOi...', rawReply: 'the model said 1 2 3 ...',
  };
  const clean = sanitizeResult(dirty);
  const json = JSON.stringify(clean);
  assert.ok(!json.includes('eyJhbGc'), 'no token-like material');
  assert.ok(!json.includes('rawReply') && !json.includes('secretRawAnswer') && !json.includes('model said'), 'no raw answer text');
  assert.ok(!('token' in clean) && !('rawReply' in clean));
  assert.ok(!('junk' in clean.protocol) && !('secretRawAnswer' in clean.candidates[0]));
  assert.equal(clean.family, 'opus');
  assert.equal(clean.status, 'attributed');
});

test('sanitizeResult coerces an out-of-vocab family to unknown and bad status to failed', () => {
  const r = sanitizeResult({ family: 'gemini', status: 'bogus', candidates: [], protocol: {} });
  assert.equal(r.family, 'unknown');
  assert.equal(r.status, 'failed');
  assert.equal(r.source, 'fingerprint');
});

/* ── invariants ──────────────────────────────────────────────────────── */
test('exports and constants are stable', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(TARGET_FAMILIES, ['opus', 'fable', 'gpt6']);
  assert.equal(DEFAULT_THRESHOLDS.calibrated, false, 'defaults are explicitly uncalibrated');
});
