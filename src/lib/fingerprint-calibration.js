/* Fingerprint threshold-calibration & evaluation scaffold (PR5).
 *
 * PURPOSE
 *   Turn a bundled reference bank into an HONEST, reproducible report of how
 *   separable the families actually are UNDER THE BANK ITSELF, and sweep the
 *   decision thresholds so a human can trade coverage against accept-accuracy.
 *   This is the "依盲测结果校准阈值" step — but we do NOT have an independent
 *   matched-channel Arena blind set yet, so the honest thing to publish is a
 *   PARAMETRIC-BOOTSTRAP closed-set self-consistency check, clearly labelled as
 *   an UPPER BOUND, never as real accuracy.
 *
 * WHAT IT DOES
 *   - Draws synthetic probe answers from each reference model's OWN stored
 *     distribution with a seeded RNG (no model calls, fully deterministic).
 *   - Scores them through the real classify() and tallies the metric set the
 *     plan mandates: a 三系列 confusion matrix, Opus↔Fable mutual-misclass,
 *     GPT‑6 version drift, accept-accuracy, conclusion coverage, unknown
 *     rejection on NON-target families, and probe-count-to-decision stats.
 *   - Sweeps (minMargin, minConfidence) to expose the coverage/precision curve.
 *
 * HONESTY (do NOT strip these when wiring into docs/UI):
 *   - Synthetic answers are sampled from the SAME aggregated bank classify()
 *     scores against. This measures the bank's INTERNAL separability, i.e. an
 *     optimistic ceiling. It cannot see channel shift, version drift beyond the
 *     enrolled versions, system-prompt/sampling mismatch, or train/test leakage.
 *   - Numbers here are NOT current-Arena accuracy and must never be relabelled
 *     as such. softmax confidence is NOT a calibrated correctness probability.
 *   - Partial/sparse bank cells (fpverify opus-4.8-thinking has no coin;
 *     gpt-5.6-sol has only coin) will legitimately produce "no decision"; that
 *     is correct behaviour, not a bug.
 *
 * No DOM / IPC / network. Pure functions + seeded RNG.
 */

import {
  TARGET_FAMILIES, DEFAULT_THRESHOLDS, PROTOCOL_MIN_SIGNAL,
  validateReference,
} from './fingerprint.js';

const PRED_UNKNOWN = 'unknown';

/* ---- seeded RNG (mulberry32) ----------------------------------------- */

/* Deterministic 32-bit PRNG so every report is byte-reproducible from a seed.
 * Returns a function → float in [0,1). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Build a cumulative distribution [{threshold, value}] from a weight map/array
 * so we can sample a category in O(log n) (here linear — vocab is tiny). */
function cumulativeFromCounts(entries) {
  // entries: [[value, weight], ...]
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, Number(w) || 0);
  const cum = [];
  let acc = 0;
  for (const [value, w] of entries) {
    acc += Math.max(0, Number(w) || 0);
    cum.push({ upto: total > 0 ? acc / total : 0, value });
  }
  return { cum, total };
}

function sampleCum(cum, rng) {
  const r = rng();
  for (const e of cum) if (r < e.upto) return e.value;
  return cum.length ? cum[cum.length - 1].value : null;
}

/* ---- synthetic answer sampling --------------------------------------- */

/* One histogram probe reply: `n` integers drawn i.i.d. from the model's own
 * count distribution, returned as the space-joined string classify() re-parses.
 * `n` defaults above the protocol's min-signal floor so a reply is scorable. */
export function sampleHistogramAnswer(model, dims, n, rng) {
  const counts = model.counts || [];
  const entries = [];
  for (let i = 0; i < dims; i++) entries.push([i + 1, counts[i] || 0]);
  const { cum, total } = cumulativeFromCounts(entries);
  const parts = [];
  for (let k = 0; k < n; k++) {
    // total===0 would be a degenerate empty model; fall back to uniform.
    parts.push(total > 0 ? sampleCum(cum, rng) : (1 + Math.floor(rng() * dims)));
  }
  return parts.join(' ');
}

/* One categorical probe answer for a single question id: sample the value from
 * the model's stored value→count distribution. Returns null when the model has
 * no cell for that question (a partial bank), which the caller treats as "the
 * probe produced nothing" — exactly what a real sparse model would do. */
export function sampleCategoricalValue(model, questionId, rng) {
  const dist = model.questions && model.questions[questionId];
  if (!dist || typeof dist !== 'object') return null;
  const entries = Object.entries(dist);
  if (!entries.length) return null;
  const { cum, total } = cumulativeFromCounts(entries);
  if (total <= 0) return null;
  return sampleCum(cum, rng);
}

/* The ordered probe-id plan for a reference, mirroring buildProbePlan() in the
 * runner (histogram repeats the one id; categorical walks the registered
 * questions in order). Kept local so calibration has no runner dependency. */
export function probePlanFor(reference, kind, budget) {
  const cap = Math.max(1, Number(budget) || 1);
  if (kind === 'histogram') return new Array(cap).fill('seq-1-355');
  // categorical: the question ids are the union of keys across models, in a
  // stable order (first-seen). This matches the registered battery order.
  const seen = [];
  for (const m of reference.models) {
    for (const q of Object.keys(m.questions || {})) if (!seen.includes(q)) seen.push(q);
  }
  return seen.slice(0, cap);
}

/* Build one synthetic session's answers[] for a given true model, sampled at a
 * fixed probe budget. Histogram → array of integer-run strings. Categorical →
 * a single merged {questionId: value} bag (same shape the runner accumulates).
 * Returns { answers, probesUsed } where probesUsed counts probes that produced
 * a usable signal (sparse categorical cells may yield fewer). */
export function sampleSession({ reference, kind, model, budget, integersPerReply = 120, rng }) {
  const plan = probePlanFor(reference, kind, budget);
  if (kind === 'histogram') {
    const answers = plan.map(() => sampleHistogramAnswer(model, reference.dims, integersPerReply, rng));
    return { answers, probesUsed: answers.length };
  }
  const bag = {};
  let used = 0;
  for (const q of plan) {
    const v = sampleCategoricalValue(model, q, rng);
    if (v != null) { bag[q] = v; used += 1; }
  }
  return { answers: Object.keys(bag).length ? [bag] : [], probesUsed: used };
}

/* ---- a reference bank with one model removed (leave-one-model-out) ---- */

/* Returns a shallow clone of the reference whose models exclude `modelId`.
 * Used for the honest "family generalization" variant: a session sampled from
 * model M must match a DIFFERENT model (ideally same family) rather than
 * trivially matching its own centroid. Returns null if removal would empty the
 * bank or drop below the 2 models classify() needs to be meaningful. */
export function referenceWithout(reference, modelId) {
  const models = reference.models.filter((m) => m.id !== modelId);
  if (models.length < 2) return null;
  return { ...reference, models };
}

/* ---- the classify-driven prediction ---------------------------------- */

/* Map one classify() result to a predicted family label for the confusion
 * matrix: a target family only when status==='attributed' AND the family is a
 * target; everything else (unresolved, failed, non-target) → 'unknown'. */
function predictedFamily(result) {
  if (result && result.status === 'attributed' && TARGET_FAMILIES.includes(result.family)) {
    return result.family;
  }
  return PRED_UNKNOWN;
}

/* Smallest probe count at which the session reaches a CORRECT target
 * attribution, by replaying classify() over a growing answer prefix. For the
 * categorical bag we grow by answered-question count. Returns null if it never
 * reaches a correct decision within the session. */
function firstCorrectProbeCount({ classify, reference, kind, trueFamily, answers, thresholds, protocolId }) {
  const run = (ans) => classify({
    protocol: { id: protocolId },
    reference,
    answers: ans,
    thresholds,
  });
  if (kind === 'histogram') {
    for (let k = 1; k <= answers.length; k++) {
      const r = run(answers.slice(0, k));
      if (r.status === 'attributed' && r.family === trueFamily) return k;
    }
    return null;
  }
  // categorical: answers is [bag]; grow the bag one question at a time.
  const bag = answers[0] || {};
  const qs = Object.keys(bag);
  for (let k = 1; k <= qs.length; k++) {
    const partial = {};
    for (let i = 0; i < k; i++) partial[qs[i]] = bag[qs[i]];
    const r = run([partial]);
    if (r.status === 'attributed' && r.family === trueFamily) return k;
  }
  return null;
}

/* ---- the evaluation -------------------------------------------------- */

function emptyConfusion(trueFamilies) {
  const cols = [...TARGET_FAMILIES, PRED_UNKNOWN];
  const matrix = {};
  for (const t of trueFamilies) {
    matrix[t] = {};
    for (const c of cols) matrix[t][c] = 0;
  }
  return matrix;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/* Bank provenance for the report header (sampling date + version). */
export function bankInfo(reference) {
  const src = reference.source || {};
  return {
    referenceVersion: reference.referenceVersion || null,
    protocolId: reference.protocolId || null,
    kind: reference.kind || (Number.isInteger(reference.dims) ? 'histogram' : 'categorical'),
    sampledAt: src.upstreamBuiltAt || src.enrolledAt || null,
    channel: src.channel || (Array.isArray(src.providers) ? src.providers.join('+') : null) || null,
    project: src.project || null,
    license: src.license || null,
    modelCount: reference.models.length,
    families: [...new Set(reference.models.map((m) => m.family))].sort(),
    partialModels: reference.models.filter((m) => m.partial).map((m) => m.id),
  };
}

/* Core evaluation. Deterministic given `seed`. */
export function evaluate({
  reference,
  classify,
  seed = 1,
  sessionsPerModel = 60,
  budget = 8,
  integersPerReply = 120,
  thresholds = DEFAULT_THRESHOLDS,
  holdOutModel = false,          // leave-one-model-out (family generalization)
} = {}) {
  const { kind } = validateReference(reference);
  const protocolId = reference.protocolId;
  const rng = makeRng(seed);
  const trueFamilies = [...new Set(reference.models.map((m) => m.family))].sort();
  const confusion = emptyConfusion(trueFamilies);

  let attributed = 0;
  let attributedCorrect = 0;
  let nonTargetTotal = 0;
  let nonTargetRejected = 0;
  // Opus↔Fable mutual misclassification (only meaningful when both exist).
  let opusTotal = 0, opusAsFable = 0, fableTotal = 0, fableAsOpus = 0;
  // GPT‑6 version drift: among correctly-family'd gpt6 sessions, wrong version.
  let gpt6Correct = 0, gpt6VersionWrong = 0;
  const probeCounts = []; // probes to first correct decision (correct sessions)
  let noDecision = 0;

  const scoreRef = (excludeId) => (holdOutModel ? referenceWithout(reference, excludeId) : reference);

  for (const model of reference.models) {
    const evalRef = scoreRef(model.id);
    if (!evalRef) continue; // holdOut emptied the bank for a singleton family
    const isTarget = TARGET_FAMILIES.includes(model.family);
    for (let s = 0; s < sessionsPerModel; s++) {
      const { answers } = sampleSession({ reference, kind, model, budget, integersPerReply, rng });
      const result = classify({ protocol: { id: protocolId }, reference: evalRef, answers, thresholds });
      const pred = predictedFamily(result);
      if (confusion[model.family]) confusion[model.family][pred] += 1;

      if (result.status === 'attributed' && TARGET_FAMILIES.includes(result.family)) {
        attributed += 1;
        if (result.family === model.family) {
          attributedCorrect += 1;
          if (model.family === 'gpt6') {
            gpt6Correct += 1;
            if (result.estimatedModel && result.estimatedModel !== model.id) gpt6VersionWrong += 1;
          }
        }
      }
      if (!isTarget) {
        nonTargetTotal += 1;
        if (pred === PRED_UNKNOWN) nonTargetRejected += 1;
      }
      if (model.family === 'opus') { opusTotal += 1; if (pred === 'fable') opusAsFable += 1; }
      if (model.family === 'fable') { fableTotal += 1; if (pred === 'opus') fableAsOpus += 1; }

      const fc = firstCorrectProbeCount({ classify, reference: evalRef, kind, trueFamily: model.family, answers, thresholds, protocolId });
      if (fc != null) probeCounts.push(fc); else noDecision += 1;
    }
  }

  const totalSessions = Object.values(confusion).reduce(
    (a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0);
  // Coverage = fraction of ALL sessions that reached ANY target attribution.
  const coverage = totalSessions ? attributed / totalSessions : 0;
  const acceptAccuracy = attributed ? attributedCorrect / attributed : null;
  const unknownRejection = nonTargetTotal ? nonTargetRejected / nonTargetTotal : null;
  const sorted = probeCounts.slice().sort((a, b) => a - b);
  const probeCountStats = {
    decided: probeCounts.length,
    noDecision,
    mean: probeCounts.length ? probeCounts.reduce((a, b) => a + b, 0) / probeCounts.length : null,
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    min: sorted.length ? sorted[0] : null,
  };

  // Opus↔Fable only meaningful when both families are present in this bank.
  const bothOpusFable = trueFamilies.includes('opus') && trueFamilies.includes('fable');
  const mutualMisclass = bothOpusFable ? {
    opusAsFableRate: opusTotal ? opusAsFable / opusTotal : null,
    fableAsOpusRate: fableTotal ? fableAsOpus / fableTotal : null,
  } : { note: '该 bank 不同时含 opus 与 fable，无法度量互相误判（见两协议分离约束）' };

  const versionDrift = trueFamilies.includes('gpt6') ? {
    gpt6CorrectFamily: gpt6Correct,
    gpt6WrongVersion: gpt6VersionWrong,
    wrongVersionRate: gpt6Correct ? gpt6VersionWrong / gpt6Correct : null,
    note: '家族正确但精确版本判错的比例（family≠exact-version）',
  } : { note: '该 bank 不含 gpt6' };

  return {
    design: holdOutModel ? 'leave-one-model-out (family generalization)' : 'parametric-bootstrap self-consistency',
    seed, sessionsPerModel, budget, integersPerReply, totalSessions,
    thresholds: { minMargin: thresholds.minMargin, minConfidence: thresholds.minConfidence, calibrated: !!thresholds.calibrated },
    bank: bankInfo(reference),
    confusion,
    coverage,
    acceptAccuracy,
    unknownRejection,
    mutualMisclass,
    versionDrift,
    probeCountStats,
    honesty: [
      '合成回答抽样自 classify() 评分所用的同一聚合 bank，这是内部可分性上界，不是当前 Arena 真实准确率。',
      'softmax 置信度不是标定后的正确概率。',
      '无法反映渠道漂移、系统提示/采样差异、未入库版本或 train/test 泄漏。',
      'partial/稀疏单元（如 fpverify 的 opus‑4.8‑thinking 无 coin、gpt‑5.6‑sol 仅 coin）会合法地产生“无结论”。',
    ],
  };
}

/* Sweep (minMargin, minConfidence) to expose the coverage ↔ accept-accuracy
 * tradeoff. Returns rows [{minMargin, minConfidence, coverage, acceptAccuracy,
 * unknownRejection}]. Intended to HELP a human pick thresholds against a real
 * blind set later — it does NOT auto-commit any threshold. */
export function sweepThresholds({
  reference, classify, seed = 1, sessionsPerModel = 40, budget = 8,
  marginGrid = [1.05, 1.2, 1.5, 2.0, 3.0],
  confidenceGrid = [0.5, 0.6, 0.7, 0.8, 0.9],
  base = DEFAULT_THRESHOLDS,
} = {}) {
  const rows = [];
  for (const minMargin of marginGrid) {
    for (const minConfidence of confidenceGrid) {
      const th = { ...base, minMargin, minConfidence };
      const r = evaluate({ reference, classify, seed, sessionsPerModel, budget, thresholds: th });
      rows.push({
        minMargin, minConfidence,
        coverage: r.coverage,
        acceptAccuracy: r.acceptAccuracy,
        unknownRejection: r.unknownRejection,
      });
    }
  }
  return rows;
}
