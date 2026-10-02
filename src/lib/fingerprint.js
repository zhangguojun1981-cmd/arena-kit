/* Offline model fingerprint classification (ArenaKit 0.5.x).
 *
 * When the Trigger trace pipeline cannot name a conversation's model, this
 * module turns a batch of structured probe answers into a STATISTICAL guess:
 *   family  → opus | fable | gpt6 | unknown
 *   estimatedModel → a specific id, only when the margin is clear
 * It never claims certainty, never overrides a server-confirmed model, and
 * never merges two different probe protocols into one probability.
 *
 * Pure functions, no DOM / IPC / network. The reference banks live under
 * data/fingerprint/references/*.json (versioned distribution summaries, not
 * raw replies). The caller passes a parsed reference object in.
 *
 * Honesty rules baked in (see docs/FINGERPRINT.md):
 *   - A single "magic answer" (e.g. 73, teal) is never a classifier: we always
 *     compare the whole answer distribution.
 *   - Non-target families (sonnet/haiku/gpt5/…) stay in the reference as
 *     NEGATIVES; if the best match is one of them, we return `unknown`, not a
 *     forced opus/fable/gpt6 label. A closed set must not manufacture a target.
 *   - Thresholds below are UNCALIBRATED defaults (ported from arena-local-bridge
 *     PR#29: MIN_MARGIN=1.2, CONFIDENCE_THRESHOLD=0.6). Until measured on real
 *     Arena data they only gate attributed vs unresolved; they are not accuracy.
 */

export const SCHEMA_VERSION = 1;
export const TARGET_FAMILIES = ['opus', 'fable', 'gpt6'];

/* UNCALIBRATED defaults — see module header. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minMargin: 1.2,          // top family softmax weight / second family weight
  minConfidence: 0.6,      // top family's share of total softmax weight
  minSamples: 1,           // probe answers required to attempt a verdict
  minUniformRatio: 1.05,   // primary OOD gate (histogram): whitened distance to
                           // the UNIFORM null / distance to the best model. An
                           // in-distribution batch is strictly closer to some
                           // model than to uniform noise, so this ratio exceeds
                           // 1 and GROWS with sample size; a uniform-random
                           // (OOD) batch sits at/under 1 at every n. Unlike an
                           // absolute score floor it does not punish short but
                           // genuine replies. Uncalibrated — thin at small n.
  minTopScore: 1e-6,       // degenerate-input safety floor only (empty / all-
                           // zero feature); real OOD rejection is the ratio.
  calibrated: false,       // flipped to true only once Arena-measured
});

/* Softmax temperature applied to raw affinities before computing confidence /
 * margin. Raw Bhattacharyya / likelihood affinities over hundreds of bins sit
 * close to each other, so a plain ratio barely moves; ModelTrace's own bank
 * calibrates beta≈7.2 (1 reply) → 12 (2–3 replies). We use its multi-reply
 * value as an UNCALIBRATED default. This only sharpens the family decision; it
 * does not change which family is closest, and it is not a measured accuracy. */
export const DEFAULT_BETA = 12;

/* Per-protocol minimum valid signal to even attempt a verdict. ModelTrace's
 * own bank sets minimum_valid_numbers = 80; below that a long-integer answer is
 * too short to carry a distribution. For the categorical battery we require
 * several answered questions, so that a single "magic answer" (73, teal) can
 * never attribute on its own. */
export const PROTOCOL_MIN_SIGNAL = Object.freeze({
  'modeltrace-long-integers-v1': 80, // minimum integers in one answer
  'fpverify-battery-v1': 1,          // minimum integers (n/a — categorical)
});
export const CATEGORICAL_MIN_QUESTIONS = 3; // answered battery questions needed

const MAX_CANDIDATES = 24;
const MAX_SAMPLES = 64;
const MAX_ID_LEN = 120;
const MAX_STR_LEN = 200;

/* ---- parsing ---------------------------------------------------------- */

/* Longest run of integers in [min,max]; a run is split when the gap between
 * two numbers contains a letter (independent reproduction of ModelTrace's
 * "longest digit run; alphabetic separators split runs" parser). */
export function parseIntegers(text, { min = 1, max = 355 } = {}) {
  const s = String(text ?? '');
  const runs = [];
  let current = [];
  let prevEnd = 0;
  const re = /[0-9]+/g;
  let m;
  while ((m = re.exec(s))) {
    const gap = s.slice(prevEnd, m.index);
    if (current.length && /\p{L}/u.test(gap)) { runs.push(current); current = []; }
    const v = Number(m[0]);
    if (v >= min && v <= max) current.push(v);
    prevEnd = m.index + m[0].length;
  }
  if (current.length) runs.push(current);
  let best = [];
  for (const r of runs) if (r.length > best.length) best = r;
  return best;
}

/* Count vector over [1..dims]. */
export function histogram(numbers, dims) {
  const counts = new Array(dims).fill(0);
  for (const n of numbers) {
    const i = (n | 0) - 1;
    if (i >= 0 && i < dims) counts[i] += 1;
  }
  return counts;
}

/* Add-0.5 smoothed probability vector (so unseen bins never zero out an
 * answer), i.e. the squared Hellinger coordinates' base distribution. */
export function smoothedProbs(counts) {
  const dims = counts.length;
  const total = counts.reduce((a, b) => a + b, 0) + 0.5 * dims;
  if (!(total > 0)) return counts.map(() => 1 / Math.max(dims, 1));
  return counts.map((c) => (c + 0.5) / total);
}

/* Bhattacharyya coefficient in [0,1]: sum sqrt(p_i q_i). 1 = identical
 * distributions, 0 = disjoint. This is 1 - squared Hellinger distance proxy;
 * we use it directly as the per-candidate affinity. */
export function bhattacharyya(p, q) {
  const n = Math.min(p.length, q.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.sqrt(p[i] * q[i]);
  return s;
}

/* ---- reference validation -------------------------------------------- */

/* A reference bank is a versioned distribution summary. We validate shape and
 * bounds before trusting it (banks ship in-repo but may be swapped later). */
export function validateReference(ref) {
  if (!ref || typeof ref !== 'object') throw new Error('参考库无效：不是对象');
  if (ref.schemaVersion !== 1) throw new Error('参考库 schemaVersion 不受支持');
  if (typeof ref.protocolId !== 'string' || !ref.protocolId) throw new Error('参考库缺少 protocolId');
  if (typeof ref.referenceVersion !== 'string' || !ref.referenceVersion) throw new Error('参考库缺少 referenceVersion');
  const kind = ref.kind || (Number.isInteger(ref.dims) ? 'histogram' : 'categorical');
  if (kind === 'histogram') {
    if (!Number.isInteger(ref.dims) || ref.dims < 2 || ref.dims > 4096) throw new Error('参考库 dims 超出范围');
  }
  if (!Array.isArray(ref.models) || !ref.models.length) throw new Error('参考库没有模型');
  for (const m of ref.models) {
    if (!m || typeof m.id !== 'string' || !m.id) throw new Error('参考模型缺少 id');
    if (typeof m.family !== 'string' || !m.family) throw new Error('参考模型缺少 family');
    if (kind === 'histogram') {
      if (!Array.isArray(m.counts) || m.counts.length !== ref.dims) throw new Error(`参考模型 ${m.id} 直方图维度不符`);
      if (!m.counts.every((c) => Number.isFinite(c) && c >= 0)) throw new Error(`参考模型 ${m.id} 直方图含非法值`);
    } else {
      if (!m.questions || typeof m.questions !== 'object') throw new Error(`参考模型 ${m.id} 缺少 questions`);
    }
  }
  return { kind };
}

/* ---- feature extraction per protocol --------------------------------- */

/* Turn one raw probe answer into the protocol's feature. Returns null when the
 * answer carries too little signal to score (caller drops it). */
export function extractFeature(ref, kind, answer) {
  if (kind === 'histogram') {
    const [min, max] = Array.isArray(ref.range) ? ref.range : [1, ref.dims];
    const nums = parseIntegers(answer, { min, max });
    const need = PROTOCOL_MIN_SIGNAL[ref.protocolId] ?? 1;
    if (nums.length < need) return null;
    return { type: 'histogram', counts: histogram(nums, ref.dims), n: nums.length };
  }
  // categorical: answer is already a normalized {question: value} map produced
  // in-page (no free text crosses the bridge). Lower-cased, trimmed values.
  if (!answer || typeof answer !== 'object') return null;
  const picks = {};
  let any = 0;
  for (const [q, v] of Object.entries(answer)) {
    const key = String(q).slice(0, MAX_STR_LEN);
    const val = String(v ?? '').trim().toLowerCase().slice(0, MAX_STR_LEN);
    if (key && val) { picks[key] = val; any += 1; }
  }
  return any ? { type: 'categorical', picks, answered: any } : null;
}

/* Across one histogram reference bank, the per-bin mean and standard deviation
 * of the models' smoothed distributions. Whitening by these (a diagonal
 * nuisance projection, ModelTrace's idea without its full ordered-block stage)
 * amplifies the few bins where models actually differ, so family separation is
 * dramatically sharper than a raw Bhattacharyya overlap. Memoized per bank. */
const _whitenCache = new WeakMap();
function whitenStats(ref) {
  if (_whitenCache.has(ref)) return _whitenCache.get(ref);
  const dims = ref.dims;
  const probs = ref.models.map((m) => smoothedProbs(m.counts));
  const mean = new Array(dims).fill(0);
  for (const p of probs) for (let i = 0; i < dims; i++) mean[i] += p[i] / probs.length;
  const scale = new Array(dims).fill(0);
  for (const p of probs) for (let i = 0; i < dims; i++) scale[i] += (p[i] - mean[i]) ** 2;
  for (let i = 0; i < dims; i++) scale[i] = Math.sqrt(scale[i] / probs.length) || 1e-9;
  const centroids = probs.map((p) => p.map((v, i) => (v - mean[i]) / (scale[i] < 1e-12 ? 1e-12 : scale[i])));
  // The UNIFORM null distribution, whitened the same way. Used as an
  // out-of-distribution reference: a real answer is closer to some model than
  // to uniform noise; a PRNG batch is not.
  const uniformWhitened = new Array(dims).fill(0).map((_, i) => ((1 / dims) - mean[i]) / (scale[i] < 1e-12 ? 1e-12 : scale[i]));
  const stats = { mean, scale, centroids, uniformWhitened, dims };
  _whitenCache.set(ref, stats);
  return stats;
}

/* ---- feature scoring per protocol ------------------------------------ */

/* Whitened squared distance between a whitened probability vector `z` and a
 * reference centroid (lower = closer). Both are already in z-score space. */
function whitenedDist(z, centroid, dims) {
  let s = 0;
  for (let i = 0; i < dims; i++) { const d = z[i] - centroid[i]; s += d * d; }
  return s / dims;
}

/* Whiten a feature's smoothed distribution into z-score space once. */
function whitenFeature(feature, stats) {
  const p = smoothedProbs(feature.counts);
  const { mean, scale, dims } = stats;
  const z = new Array(dims);
  for (let i = 0; i < dims; i++) z[i] = (p[i] - mean[i]) / (scale[i] < 1e-12 ? 1e-12 : scale[i]);
  return z;
}

function affinityCategorical(feature, modelQuestions) {
  // Per question, probability the model would emit the observed value, under
  // the reference's add-0.5 smoothed category distribution; geometric mean
  // (mean log-prob) across answered questions keeps it length-independent.
  const qs = Object.keys(feature.picks).filter((q) => modelQuestions[q]);
  if (!qs.length) return { logScore: -1e9, score: 0 };
  let logSum = 0;
  for (const q of qs) {
    const dist = modelQuestions[q];
    const total = Object.values(dist).reduce((a, b) => a + Number(b || 0), 0);
    const vocab = Object.keys(dist).length || 1;
    const observed = Number(dist[feature.picks[q]] || 0);
    const prob = (observed + 0.5) / (total + 0.5 * (vocab + 1));
    logSum += Math.log(prob);
  }
  const mean = logSum / qs.length;
  return { logScore: mean, score: Math.exp(mean) };
}

/* ---- classification --------------------------------------------------- */

/* Mean per-sample affinity for every reference model, then the best member of
 * each family. Each model carries both a human-facing `score` in [0,1] and a
 * `logScore` (negative whitened distance / mean log-prob) used for the softmax
 * so that close distributions still separate. Returns the raw scoring detail;
 * shaping into the result object is done by classify(). */
export function scoreCandidates(ref, kind, features) {
  const stats = kind === 'histogram' ? whitenStats(ref) : null;
  // For histograms, whiten each feature once and remember the mean distance to
  // the uniform null, so classify() can gate out-of-distribution batches.
  const whitened = stats ? features.map((f) => whitenFeature(f, stats)) : null;
  const perModel = ref.models.map((m, mi) => {
    let sumScore = 0;
    let sumLog = 0;
    let sumDist = 0;
    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      if (kind === 'histogram') {
        const dist = whitenedDist(whitened[fi], stats.centroids[mi], stats.dims);
        sumDist += dist;
        sumLog += -dist;
        sumScore += Math.exp(-dist);
      } else {
        const a = affinityCategorical(f, m.questions);
        sumScore += a.score;
        sumLog += a.logScore;
      }
    }
    const n = features.length || 1;
    return {
      id: m.id,
      family: m.family,
      samples: Number.isFinite(m.samples) ? m.samples : null,
      score: sumScore / n,
      logScore: sumLog / n,
      dist: kind === 'histogram' ? sumDist / n : null,
    };
  });
  perModel.sort((a, b) => b.logScore - a.logScore);
  // Family affinity = best member's logScore (a family is "near" if ANY of its
  // versions matches; summing would punish well-sampled families).
  const familyBest = new Map();
  for (const c of perModel) {
    if (!familyBest.has(c.family) || familyBest.get(c.family) < c.logScore) familyBest.set(c.family, c.logScore);
  }
  // OOD gate (histogram only): mean whitened distance to the uniform null over
  // distance to the single best model. >1 means "closer to a model than to
  // uniform noise". Grows with sample size for genuine replies; stays ≤1 for
  // PRNG / flat batches regardless of how lopsided the family softmax is.
  let uniformRatio = null;
  if (kind === 'histogram' && whitened.length) {
    let sumUni = 0;
    for (const z of whitened) sumUni += whitenedDist(z, stats.uniformWhitened, stats.dims);
    const meanUni = sumUni / whitened.length;
    const bestDist = perModel[0].dist;
    uniformRatio = bestDist > 1e-12 ? meanUni / bestDist : (meanUni > 0 ? Infinity : 1);
  }
  return { perModel, familyBest, uniformRatio };
}

/* Main entry. Produces a result object matching the fingerprint schema.
 *   opts: { sessionId, protocol:{id,version,promptSetHash,channel,reasoningTier,language},
 *           reference, answers:[...], thresholds?, now? }
 */
export function classify(opts = {}) {
  const {
    sessionId = null,
    protocol = {},
    reference = null,
    answers = [],
    thresholds = DEFAULT_THRESHOLDS,
    now = new Date().toISOString(),
  } = opts;

  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const base = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionId ? String(sessionId).slice(0, 128) : null,
    family: 'unknown',
    estimatedModel: null,
    candidates: [],
    confidence: 0,
    margin: 0,
    status: 'failed',
    source: 'fingerprint',
    protocol: sanitizeProtocol(protocol),
    referenceBankVersion: null,
    probeCount: Array.isArray(answers) ? answers.length : 0,
    createdAt: String(now),
  };

  let kind;
  try {
    ({ kind } = validateReference(reference));
  } catch (e) {
    return { ...base, status: 'failed', error: String(e && e.message || e).slice(0, MAX_STR_LEN) };
  }
  base.referenceBankVersion = String(reference.referenceVersion).slice(0, MAX_ID_LEN);
  if (reference.protocolId !== base.protocol.id && base.protocol.id) {
    return { ...base, status: 'failed', error: '协议与参考库不匹配' };
  }
  base.protocol.id = base.protocol.id || reference.protocolId;

  const raw = Array.isArray(answers) ? answers.slice(0, MAX_SAMPLES) : [];
  const features = [];
  for (const a of raw) { const f = extractFeature(reference, kind, a); if (f) features.push(f); }

  if (features.length < Math.max(1, th.minSamples)) {
    return { ...base, status: 'unresolved', reason: 'insufficient-signal' };
  }
  // For the categorical battery, require enough answered questions in total so
  // that one shared "magic answer" (73, which Fable AND Opus-4.8-thinking both
  // emit) can never attribute on its own.
  if (kind === 'categorical') {
    const answered = features.reduce((a, f) => a + (f.answered || 0), 0);
    if (answered < CATEGORICAL_MIN_QUESTIONS) {
      return { ...base, status: 'unresolved', reason: 'insufficient-signal' };
    }
  }

  const { perModel, familyBest, uniformRatio } = scoreCandidates(reference, kind, features);
  const candidates = perModel.slice(0, MAX_CANDIDATES).map((c) => ({
    id: c.id.slice(0, MAX_ID_LEN),
    family: c.family,
    score: round(c.score),
    normalizedScore: 0,
    samples: c.samples,
    referenceVersion: base.referenceBankVersion,
  }));

  // Family-level confidence / margin from best-member affinities, sharpened
  // through a softmax (raw distribution affinities sit close together, so a
  // bare ratio under-separates families; the temperature is uncalibrated).
  const fams = [...familyBest.entries()].sort((a, b) => b[1] - a[1]);
  const beta = Number.isFinite(th.beta) ? th.beta : DEFAULT_BETA;
  const maxAff = fams[0][1];
  const weights = fams.map(([f, v]) => [f, Math.exp(beta * (v - maxAff))]);
  const totalW = weights.reduce((a, [, w]) => a + w, 0) || 1;
  const weightOf = new Map(weights);
  for (const c of candidates) c.normalizedScore = round((weightOf.get(c.family) || 0) / totalW);
  const [topFam] = weights[0];
  const topW = weights[0][1];
  const secondW = weights[1] ? weights[1][1] : 1e-9;
  const confidence = topW / totalW;
  const margin = topW / Math.max(secondW, 1e-9);

  const result = {
    ...base,
    candidates,
    confidence: round(confidence),
    margin: round(margin),
  };

  const isTarget = TARGET_FAMILIES.includes(topFam);
  // Out-of-distribution gate. A batch that resembles NO reference model (uniform
  // random, OOD) can still produce a lopsided softmax between two equally-bad
  // families, so we must reject it on an ABSOLUTE basis, not a relative one.
  //   - histogram: primary test is uniformRatio = dist(sample, uniform null) /
  //     dist(sample, best model). >=minUniformRatio means the batch is closer to
  //     a real model than to uniform noise. This holds for short genuine replies
  //     and grows with sample size, while uniform batches sit at/under 1.
  //   - also keep a tiny absolute floor against degenerate (empty) features.
  const topScore = perModel.length ? perModel[0].score : 0;
  const floorOk = topScore >= (Number.isFinite(th.minTopScore) ? th.minTopScore : 0);
  const ratioOk = kind !== 'histogram'
    || uniformRatio == null
    || uniformRatio >= (Number.isFinite(th.minUniformRatio) ? th.minUniformRatio : 1);
  const resembles = floorOk && ratioOk;
  const passes = isTarget && resembles && margin >= th.minMargin && confidence >= th.minConfidence;

  if (!resembles) {
    // Nothing in the bank is actually close: do not attribute.
    return { ...result, family: 'unknown', status: 'unresolved', reason: 'no-close-reference' };
  }
  if (!isTarget) {
    // Best match is a non-target negative (sonnet/haiku/gpt5/…): refuse to
    // force a target label.
    return { ...result, family: 'unknown', status: 'unresolved', reason: 'closest-is-non-target' };
  }
  if (!passes) {
    return { ...result, family: topFam, status: 'unresolved', reason: margin < th.minMargin ? 'low-margin' : 'low-confidence' };
  }
  const topModel = perModel.find((c) => c.family === topFam);
  return {
    ...result,
    family: topFam,
    estimatedModel: topModel ? topModel.id.slice(0, MAX_ID_LEN) : null,
    status: 'attributed',
  };
}

/* ---- serialization / sanitization ------------------------------------ */

function sanitizeProtocol(p) {
  const o = p && typeof p === 'object' ? p : {};
  const str = (v) => (v == null ? '' : String(v).slice(0, MAX_ID_LEN));
  return {
    id: str(o.id),
    version: str(o.version),
    promptSetHash: str(o.promptSetHash),
    channel: str(o.channel),
    reasoningTier: str(o.reasoningTier),
    language: str(o.language),
  };
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0);

/* Strip a result down to the fields allowed in persistence / diagnostics.
 * Guarantees no stray fields (and never any raw answer text, token, header). */
export function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const r = result;
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: r.sessionId ? String(r.sessionId).slice(0, 128) : null,
    family: TARGET_FAMILIES.includes(r.family) ? r.family : 'unknown',
    estimatedModel: r.estimatedModel ? String(r.estimatedModel).slice(0, MAX_ID_LEN) : null,
    candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, MAX_CANDIDATES).map((c) => ({
      id: String(c.id || '').slice(0, MAX_ID_LEN),
      family: String(c.family || '').slice(0, 40),
      score: round(Number(c.score) || 0),
      normalizedScore: round(Number(c.normalizedScore) || 0),
      samples: Number.isFinite(c.samples) ? c.samples : null,
      referenceVersion: String(c.referenceVersion || '').slice(0, MAX_ID_LEN),
    })),
    confidence: round(Number(r.confidence) || 0),
    margin: round(Number(r.margin) || 0),
    status: ['attributed', 'unresolved', 'failed'].includes(r.status) ? r.status : 'failed',
    source: 'fingerprint',
    protocol: sanitizeProtocol(r.protocol),
    referenceBankVersion: r.referenceBankVersion ? String(r.referenceBankVersion).slice(0, MAX_ID_LEN) : null,
    probeCount: Number.isInteger(r.probeCount) && r.probeCount >= 0 ? r.probeCount : 0,
    createdAt: String(r.createdAt || new Date().toISOString()).slice(0, 40),
    ...(r.reason ? { reason: String(r.reason).slice(0, 60) } : {}),
    ...(r.error ? { error: String(r.error).slice(0, MAX_STR_LEN) } : {}),
  };
}
