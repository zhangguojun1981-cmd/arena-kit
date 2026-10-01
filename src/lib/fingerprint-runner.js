/* Active model-fingerprint orchestrator (ArenaKit 0.5.x).
 *
 * Sends a FIXED, allowlisted probe prompt, lets the page-side reducer
 * (injected/fingerprint.js) turn the reply into a structured feature
 * (histogram counts / normalized category pick — never raw text), and feeds
 * those features to classify() for a STATISTICAL family estimate.
 *
 * Safety machinery:
 *   - a cancel token every await races against (stop() is immediate),
 *   - a single-run gate (no concurrent fingerprint run),
 *   - RPC timeout (inherited from the shared rpc),
 *   - round pacing (don't hammer Arena / trip 429),
 *   - a consecutive-failure cap,
 *   - stop on page / session / mode change,
 *   - never overwrite a human draft (the page-side guard enforces this).
 *
 * It sends REAL messages that consume quota, so the dock must only call start()
 * after an explicit user click + a confirmed max-message budget. The estimate
 * is uncalibrated and NEVER renames a session or overwrites a confirmed model.
 *
 * Pure of DOM / IPC: every side effect is an injected dependency, so the whole
 * loop is unit-testable with mocks and NO real model calls. */

export const FP_RPC_TIMEOUT_MS = 45_000;    // a fixed probe + its reply is slower than an arithmetic draw
export const FP_FEATURE_WAIT_MS = 60_000;    // wait for the page reducer to emit the structured feature
export const FP_FEATURE_POLL_MS = 400;
export const FP_ROUND_PACING_MS = 2_500;     // space out probes
export const FP_MAX_CONSECUTIVE_FAILURES = 3;
export const FP_MAX_BUDGET = 24;             // hard ceiling regardless of UI

class Cancelled extends Error { constructor(msg = '已取消') { super(msg); this.name = 'Cancelled'; } }
export const isCancelled = (e) => e instanceof Cancelled || e?.name === 'Cancelled';

function makeToken() {
  let cancel;
  const promise = new Promise((_, reject) => { cancel = () => reject(new Cancelled()); });
  promise.catch(() => {});
  return { cancelled: false, promise, cancel() { if (!this.cancelled) { this.cancelled = true; cancel(); } } };
}

/* The fixed probe plan for a protocol. For the histogram protocol a single
 * probe id is repeated up to the budget (each reply is an independent sample).
 * For the categorical battery the plan walks the registered questions in order,
 * one probe per question, and the per-question picks are merged into one
 * answer map before classify() (which needs ≥3 answered questions). The probe
 * ids MUST exist in injected/probe.js's FINGERPRINT_PROMPTS allowlist — the
 * runner only ever passes ids, never prompt text. */
export function buildProbePlan(protocolId, probeIds, budget) {
  const ids = Array.isArray(probeIds) ? probeIds.filter((x) => typeof x === 'string' && x) : [];
  if (!ids.length) return [];
  const cap = Math.min(FP_MAX_BUDGET, Math.max(1, Number(budget) || 1));
  if (protocolId === 'fpverify-battery-v1') {
    // One probe per registered question, in order, up to the budget.
    return ids.slice(0, cap).map((probeId) => ({ probeId, kind: 'categorical', questionId: probeId }));
  }
  // Histogram (default): repeat the single long-integer probe id up to the budget.
  const probeId = ids[0];
  return new Array(cap).fill(0).map(() => ({ probeId, kind: 'histogram', questionId: null }));
}

export function createFingerprintRunner({
  rpc,                                  // shared createRpc(); .call('sendFingerprintProbe', {protocolId, probeId})
  dispatchToPage = () => {},            // (name, payload) → arm/disarm the page reducer
  loadReference,                        // async (protocolId) → parsed reference bank (data/fingerprint/references/*)
  classify,                             // the pure classify() from fingerprint.js
  probeIdsForProtocol,                  // (protocolId) → string[] of allowlisted probe ids (from ArenaProbe.fingerprintProbeIds)
  takeFeature,                          // async (sessionId, probeId, {signal}) → structured feature | null — resolves when the page emits it
  candidateModelsForSession = () => [], // (sessionId|null) → string[] of models the trace pipeline already saw (gate: ≥2 candidates)
  otherRunActive = () => false,         // () → bool — a probe/cleanup/quick send is running; refuse to start
  pageState = () => ({}),               // () → { onArena, agentPath, session } snapshot used to detect page/mode change
  protocolMeta = () => ({}),            // (protocolId) → { kind, channel, reasoningTier, language, ... }
  onProgress = () => {},                // (line) → void
  onResult = () => {},                  // (classifyResult) → void — incremental + final
  onFinished = () => {},                // (summary) → void
  onRunState = () => {},                // (round, maxRounds, active) → void
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  roundPacingMs = FP_ROUND_PACING_MS,
  featureWaitMs = FP_FEATURE_WAIT_MS,
} = {}) {
  let token = null;
  let running = false;

  const isRunning = () => !!token && !token.cancelled;

  function guarded(tok, p) {
    if (tok.cancelled) return Promise.reject(new Cancelled());
    return Promise.race([p, tok.promise]);
  }
  const wait = (tok, ms) => guarded(tok, sleep(ms));
  const call = (tok, action, args) => guarded(tok, rpc.call(action, args));

  function stop() {
    if (!token) return false;
    token.cancel();
    return true;
  }

  function begin() {
    if (isRunning()) return null;
    token = makeToken();
    running = true;
    return token;
  }
  function end(tok) {
    if (token === tok) { token = null; running = false; }
  }

  /* A frozen snapshot of the page we must stay on for the whole run. If the
   * origin / agent path flips we stop rather than send into an unknown surface.
   * (A baseline is kept for symmetry; the hard check is the live origin +
   * agent-path.) */
  function pageChanged() {
    let s;
    try { s = pageState() || {}; } catch { return true; }
    return !s.onArena || !s.agentPath;
  }

  /* START GATE (plan 阶段4.4). All must hold or start() refuses:
   *   - not already running, and no other probe/cleanup/quick run active,
   *   - a loadable + validatable reference bank for the protocol,
   *   - the protocol's probe ids are in the page allowlist,
   *   - ≥2 candidate models (so a verdict is a real discrimination, not a
   *     foregone single option),
   *   - a confirmed max-message budget (the dock gets explicit user confirm).
   * Channel / reasoning-tier / language compatibility is advisory metadata the
   * dock surfaces; the hard gate is the five above. */
  async function preflight(cfg) {
    const protocolId = String(cfg?.protocolId || '');
    if (!protocolId) return { ok: false, reason: '未选择指纹协议' };
    if (isRunning()) return { ok: false, reason: '指纹探测已在运行' };
    try { if (otherRunActive()) return { ok: false, reason: '有其他探针/清理正在运行，请先停止' }; } catch { /* treat as clear */ }

    let probeIds = [];
    try { probeIds = probeIdsForProtocol(protocolId) || []; } catch { probeIds = []; }
    if (!probeIds.length) return { ok: false, reason: '该协议没有登记的探针提示' };

    let reference = null;
    try { reference = await loadReference(protocolId); } catch (e) { return { ok: false, reason: '参考库加载失败：' + (e?.message || e) }; }
    if (!reference) return { ok: false, reason: '参考库不可用' };

    // ≥2 candidate models: either already-seen trace models, or (none yet) the
    // reference bank must itself carry ≥2 target-family members to discriminate.
    let candidates = [];
    try { candidates = (candidateModelsForSession(cfg?.sessionId || null) || []).filter(Boolean); } catch { candidates = []; }
    const bankModels = Array.isArray(reference.models) ? reference.models.length : 0;
    if (candidates.length < 2 && bankModels < 2) {
      return { ok: false, reason: '候选模型不足两个，无法区分' };
    }

    const maxRounds = Math.min(FP_MAX_BUDGET, Math.max(1, Number(cfg?.maxRounds) || 1));
    if (!cfg?.budgetConfirmed) return { ok: false, reason: '需确认最大消息数后再开始' };

    return { ok: true, protocolId, probeIds, reference, maxRounds };
  }

  /* Run the fixed probe plan. cfg: { protocolId, sessionId?, maxRounds,
   * budgetConfirmed, thresholds? }. Sends real messages — only after the dock's
   * explicit-click + confirmed-budget gate. */
  async function start(cfg = {}) {
    const pf = await preflight(cfg);
    if (!pf.ok) { onProgress(pf.reason); onFinished(pf.reason); return { started: false, reason: pf.reason }; }

    const tok = begin();
    if (!tok) { onProgress('指纹探测已在运行'); return { started: false, reason: '指纹探测已在运行' }; }

    const { protocolId, probeIds, reference, maxRounds } = pf;
    const meta = (() => { try { return protocolMeta(protocolId) || {}; } catch { return {}; } })();
    const plan = buildProbePlan(protocolId, probeIds, maxRounds);

    const answers = [];            // structured features fed to classify()
    let consecutiveFailures = 0;
    let lastResult = null;
    let summary = '';
    let sent = 0;

    onRunState(0, plan.length, true);
    try {
      if (!plan.length) throw new Error('没有可执行的指纹探针');
      onProgress(`开始指纹探测 · 协议 ${protocolId} · 计划 ${plan.length} 条固定探针（统计估计，非真名）`);

      for (let i = 0; i < plan.length; i++) {
        if (tok.cancelled) throw new Cancelled();
        // Between-rounds safety stop only. The FIRST probe is NEVER gated on
        // the dock's page snapshot: the user starts a run from whatever chat is
        // on screen (a /c/{id} or /agent/{id} conversation), and newChat() below
        // navigates to the fresh /agent composer before we ever send. Gating the
        // first iteration on the pre-newChat snapshot is exactly the 0-send bug
        // ("发送 0 条") — the old arithmetic probe (probe-runner.js) had no such
        // pre-send gate and relied on newChat + the page-side send guard, which
        // is the real authority (sendFingerprintProbe re-checks origin + agent
        // mode + fresh composer live before every send).
        if (i > 0 && pageChanged()) { onProgress('页面/模式已变化，停止探测'); break; }
        if (consecutiveFailures >= FP_MAX_CONSECUTIVE_FAILURES) { onProgress(`连续失败 ${consecutiveFailures} 次，停止`); break; }

        const step = plan[i];
        onRunState(i + 1, plan.length, true);
        onProgress(`第 ${i + 1}/${plan.length} 条 · 探针 ${step.probeId}`);

        // 1) fresh chat so each probe is an independent instance.
        try {
          await call(tok, 'newChat');
          if (i === 0) await call(tok, 'ensureAgentMode');
        } catch (e) {
          if (isCancelled(e)) throw e;
          consecutiveFailures += 1;
          onProgress(`准备会话失败：${e.message || e}`);
          await wait(tok, roundPacingMs);
          continue;
        }

        // 2) arm the page reducer, then ask the page to send the FIXED probe.
        //    We pass only {protocolId, probeId}; the prompt lives in the page
        //    allowlist. Disarm in finally so a failed send never leaves the
        //    reducer bound to a stale session.
        let sessionId = '';
        let feature = null;
        try {
          const sendData = await call(tok, 'sendFingerprintProbe', { protocolId, probeId: step.probeId });
          sessionId = String(sendData?.session || '');
          if (!sessionId) throw new Error('未拿到会话 id');
          sent += 1;
          // Arm AFTER we have the session id so the reducer binds to the right stream.
          dispatchToPage('fingerprint-arm', {
            sessionId, probeId: step.probeId, protocolId, kind: step.kind, questionId: step.questionId,
          });
          // 3) wait for the page to emit the structured feature for THIS probe.
          feature = await guarded(tok, takeFeature(sessionId, step.probeId, { timeoutMs: featureWaitMs }));
        } catch (e) {
          if (isCancelled(e)) throw e;
          consecutiveFailures += 1;
          onProgress(`探针失败：${e.message || e}`);
          try { dispatchToPage('fingerprint-disarm', null); } catch { /* best effort */ }
          await wait(tok, roundPacingMs);
          continue;
        } finally {
          try { dispatchToPage('fingerprint-disarm', null); } catch { /* best effort */ }
        }

        if (!feature) {
          consecutiveFailures += 1;
          onProgress('未收到结构化特征（可能无法绑定），跳过本条');
          await wait(tok, roundPacingMs);
          continue;
        }
        consecutiveFailures = 0;

        // 4) accumulate the feature and re-score incrementally. The histogram
        //    protocol feeds raw per-reply features; the categorical battery
        //    merges per-question picks into one answer map so classify() sees a
        //    multi-question vector (never one "magic answer").
        if (step.kind === 'categorical') {
          if (feature && feature.value != null && feature.questionId) {
            // Merge into a single rolling answer map (one object in answers[]).
            let bag = answers[0];
            if (!bag) { bag = {}; answers.push(bag); }
            bag[feature.questionId] = feature.value;
          }
        } else if (feature && Array.isArray(feature.counts)) {
          // Reconstruct the integer-run string shape classify()/extractFeature
          // expects (it re-parses). Simpler: pass the counts through a feature
          // object the classifier can consume directly via its answer string.
          answers.push(countsToAnswerString(feature.counts));
        } else if (feature && feature.parseError) {
          onProgress(`本条解析：${featureErrorText(feature.parseError)}`);
        }

        // Re-classify with everything so far.
        try {
          lastResult = classify({
            sessionId: sessionId || cfg.sessionId || null,
            protocol: {
              id: protocolId,
              channel: meta.channel, reasoningTier: meta.reasoningTier, language: meta.language,
            },
            reference,
            answers,
            thresholds: cfg.thresholds,
          });
          onResult(lastResult);
          onProgress(`已评估 ${answers.length} 个样本 · ${verdictText(lastResult)}`);
          // 5) stop early once a calibrated bank attributes a family. With an
          //    uncalibrated bank we never short-circuit; we always run the full
          //    plan and leave the final verdict unresolved unless it clears the
          //    (uncalibrated) thresholds, which the UI labels as such.
          if (lastResult && lastResult.status === 'attributed'
              && lastResult.protocol && reference.calibrated === true) {
            onProgress('已达到归因阈值（已校准），停止');
            break;
          }
        } catch (e) {
          if (isCancelled(e)) throw e;
          onProgress(`评估失败：${e.message || e}`);
        }

        await wait(tok, roundPacingMs);
      }

      summary = lastResult
        ? `指纹探测结束 · 发送 ${sent} 条 · ${verdictText(lastResult)}`
        : `指纹探测结束 · 发送 ${sent} 条 · 无有效样本`;
    } catch (e) {
      summary = isCancelled(e)
        ? `指纹探测已停止（发送 ${sent} 条${lastResult ? ' · ' + verdictText(lastResult) : ''}）`
        : `指纹探测中断：${e.message || e}`;
    } finally {
      try { dispatchToPage('fingerprint-disarm', null); } catch { /* best effort */ }
      end(tok);
      onRunState(0, plan.length, false);
      onFinished(summary);
    }
    return { started: true, sent, result: lastResult, summary, cancelled: tok.cancelled };
  }

  return {
    start, stop, preflight, buildProbePlan,
    get isRunning() { return isRunning(); },
  };
}

/* A histogram feature arrives from the page as a 355-bin count vector. The
 * classifier's extractFeature() re-parses an answer string, so expand the
 * counts back into a space-joined integer run (order is irrelevant to the
 * histogram). Kept tiny and allocation-bounded. */
export function countsToAnswerString(counts) {
  const parts = [];
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] | 0;
    for (let k = 0; k < c; k++) parts.push(i + 1);
  }
  return parts.join(' ');
}

const FP_ERR_TEXT = { 0: '正常', 1: '无整数', 2: '整数过少', 3: '空回复', 4: '无法绑定到当前探针' };
function featureErrorText(code) { return FP_ERR_TEXT[code] || `错误码 ${code}`; }

function verdictText(r) {
  if (!r) return '无结果';
  if (r.status === 'attributed') return `估计 ${r.estimatedModel || r.family}（${r.family}·统计估计·非真名）`;
  if (r.status === 'unresolved') return `未定（${r.reason || 'unresolved'}）`;
  if (r.status === 'failed') return `失败（${r.error || 'failed'}）`;
  return r.status || '未知';
}
