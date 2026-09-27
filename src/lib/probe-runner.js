/* Probe orchestrator — port of arena-trace-android probe/ProbeController.kt.
 *
 * Runs the loop the extension's background.js used to run, but drives the
 * arena page through discrete JS-RPC calls (src/lib/rpc.js → probe.js) and
 * gets model names from the snoop → Rust trace pipeline via modelForSession().
 *
 * Everything is explicit-start / cancellable-stop. The probe sends REAL
 * messages that consume quota — the UI must make that clear before start().
 *
 * Cancellation: stop() flips a token; every await inside the loop races
 * against it, so a stop takes effect immediately even mid-RPC (the page-side
 * action finishes on its own; its late result is simply dropped). */
import {
  randomPrompt, matchTargets, remainingTargets, allTargetsHit, arithmeticCleanupCandidates, nextSuffix,
} from './probe-logic.js';

export const RPC_TIMEOUT_MS = 35_000;
export const MODEL_WAIT_MS = 45_000;
export const MODEL_POLL_MS = 500;
// Space out rounds so we don't hammer Arena / trip 429 rate limits.
export const ROUND_PACING_MS = 2_000;
export const CLEANUP_PACING_MS = 600;
export const ARCHIVE_RETRY_MS = 1_200;
export const MAX_CONSECUTIVE_FAILURES = 3;

class Cancelled extends Error { constructor(msg = '已取消') { super(msg); this.name = 'Cancelled'; } }
export const isCancelled = (e) => e instanceof Cancelled || e?.name === 'Cancelled';

function makeToken() {
  let cancel;
  const promise = new Promise((_, reject) => { cancel = () => reject(new Cancelled()); });
  promise.catch(() => {});
  return { cancelled: false, promise, cancel() { if (!this.cancelled) { this.cancelled = true; cancel(); } } };
}

/* Resolve a title for a probe hit: "<model>-<NNN>" (Android) or, via the
 * dock, "<prefix><model>-<NNN>" (rename.js buildTitle). */
const defaultTitle = (model, suffix) => (suffix ? `${model}-${suffix}` : String(model));

export function createProbeController({
  rpc,                                  // { call(action, args) → Promise<data> }
  modelForSession,                      // (sessionId) → string[] | string | null
  stageForSession = () => '',           // (sessionId) → progress text while the model is unknown (extension acquire.js stages)
  onProgress = () => {},                // (line) → void
  onFinished = () => {},                // (summary) → void
  onProbeState = () => {},              // (round, maxRounds, hits, active)
  onCleanupState = () => {},            // (archived, active)
  onArchived = () => {},                // (sessionId) → void — a chat was archived (dock drops its local record)
  buildTitle = defaultTitle,            // (model, suffix) → title
  titlePrefix = () => '',               // current title prefix: "<prefix><model>" counts per prefix
  suffixCounters = {},                  // persisted per-model counter map (mutated copy returned via onSuffixes)
  onSuffixes = () => {},                // (counters) → void  — persist hook
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  modelWaitMs = MODEL_WAIT_MS,
  modelPollMs = MODEL_POLL_MS,
  roundPacingMs = ROUND_PACING_MS,
  cleanupPacingMs = CLEANUP_PACING_MS,
  archiveRetryMs = ARCHIVE_RETRY_MS,
} = {}) {
  let token = null;      // active run token (probe or cleanup)
  let mode = null;       // 'probe' | 'cleanup' | null
  let counters = { ...suffixCounters };

  const isRunning = () => !!token && !token.cancelled;

  /* Await `p` but bail the moment the run is cancelled. */
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

  function begin(kind) {
    if (isRunning()) return null;
    token = makeToken();
    mode = kind;
    return token;
  }
  function end(tok) {
    if (token === tok) { token = null; mode = null; }
  }

  function modelsOf(sessionId) {
    const m = modelForSession(sessionId);
    const list = Array.isArray(m) ? m : String(m || '').split(' / ');
    return list.map((x) => String(x || '').trim()).filter(Boolean);
  }

  /* Poll the trace pipeline for the session's model names up to modelWaitMs. */
  async function awaitModels(tok, sessionId) {
    const deadline = now() + modelWaitMs;
    let lastStage = '';
    for (;;) {
      const models = modelsOf(sessionId);
      if (models.length) return models;
      let stage = '';
      try { stage = String(stageForSession(sessionId) || ''); } catch { stage = ''; }
      if (stage && stage !== lastStage) { lastStage = stage; onProgress(`等待模型 · ${stage}`); }
      if (now() >= deadline) return [];
      await wait(tok, modelPollMs);
    }
  }

  async function renameHit(tok, sessionId, model) {
    let prefix = '';
    try { prefix = String(titlePrefix() || ''); } catch { prefix = ''; }
    const r = nextSuffix(model, counters, prefix);
    counters = r.counters;
    try { onSuffixes({ ...counters }); } catch { /* persist hook must not break the run */ }
    const title = buildTitle(model, r.suffix);
    try {
      await call(tok, 'rename', { sessionId, title });
      onProgress(`已重命名为 ${title}`);
      return title;
    } catch (e) {
      if (isCancelled(e)) throw e;
      onProgress(`重命名失败：${e.message || e}`);
      return null;
    }
  }

  /* Draw mode (extension "自动抽卡"): name the round's chat after its model,
   * no suffix counter, never stops early. */
  async function renameDraw(tok, sessionId, model) {
    const title = buildTitle(model, '');
    try {
      await call(tok, 'rename', { sessionId, title });
      onProgress(`已重命名为 ${title}`);
      return title;
    } catch (e) {
      if (isCancelled(e)) throw e;
      onProgress(`重命名失败：${e.message || e}`);
      return null;
    }
  }

  /* cfg: { mode: 'probe' | 'draw', targets: string[], maxRounds, findAll, autoRename }
   *   probe — until the target models are hit (extension "自动探针" / Android probe)
   *   draw  — fixed number of rounds, every round's chat renamed to its model
   *           (extension "自动抽卡"); targets are ignored, misses don't exist. */
  async function start(cfg) {
    const tok = begin('probe');
    if (!tok) { onProgress(mode === 'cleanup' ? '清理进行中，请先停止' : '探针已在运行'); return null; }
    const draw = cfg.mode === 'draw';
    const targets = draw ? [] : [...(cfg.targets || [])];
    const maxRounds = Math.min(100, Math.max(1, Number(cfg.maxRounds) || 5));
    const findAll = cfg.findAll !== false;
    const hits = [];
    const sessions = [];
    const drawn = [];      // draw mode: { round, sessionId, models, title }
    let renamedAny = false;
    let summary = '';
    onProbeState(0, maxRounds, 0, true);
    try {
      if (!draw && !targets.length) throw new Error('请填写至少一个目标');
      onProgress(draw
        ? `开始抽卡 · ${maxRounds} 轮 · 每轮新建对话并${cfg.autoRename ? '按模型名重命名' : '记录模型'}`
        : `开始探针 · 目标 ${targets.join('、')} · ${findAll ? '命中全部才停' : '命中即停'} · 最多 ${maxRounds} 轮`);
      for (let round = 1; round <= maxRounds; round++) {
        if (tok.cancelled) throw new Cancelled();
        onProbeState(round, maxRounds, draw ? drawn.length : hits.length, true);
        const outstanding = remainingTargets(targets, hits);
        const pacingLabel = draw ? `抽卡 ${round}/${maxRounds}` : findAll ? `待命中 ${outstanding.join('、')}` : '命中即停';
        const prompt = randomPrompt();
        onProgress(`第 ${round} 轮 · 发送 "${prompt}" · ${pacingLabel}`);

        // 1) fresh chat, 2) confirm Agent Mode, 3) send probe prompt
        await call(tok, 'newChat');
        await call(tok, 'ensureAgentMode');
        const sendData = await call(tok, 'send', { prompt });
        const sessionId = String(sendData?.session || '');
        if (!sessionId) { onProgress('未拿到会话 id，跳过本轮'); await wait(tok, roundPacingMs); continue; }
        sessions.push(sessionId);

        // 4) wait for the model name via the snoop → trace pipeline
        const models = await awaitModels(tok, sessionId);
        if (!models.length) { onProgress(`第 ${round} 轮未识别模型，继续`); await wait(tok, roundPacingMs); continue; }
        onProgress(`识别到：${models.join(' / ')}`);

        if (draw) {
          let title = null;
          if (cfg.autoRename) { title = await renameDraw(tok, sessionId, models[0]); renamedAny = renamedAny || !!title; }
          drawn.push({ round, sessionId, models, title });
          onProbeState(round, maxRounds, drawn.length, true);
          await wait(tok, roundPacingMs);
          continue;
        }

        // 5) match against the FULL target list every round (non-draining).
        const roundHits = matchTargets(models, targets);
        for (const h of roundHits) { hits.push({ ...h, sessionId, round }); onProgress(`命中目标 ${h.target} → ${h.model}`); }
        onProbeState(round, maxRounds, hits.length, true);
        // Rename the round's session at most once (one session, one title).
        if (roundHits.length && cfg.autoRename) {
          await renameHit(tok, sessionId, models[0] || roundHits[0].model);
          renamedAny = true;
        }

        if (findAll) {
          if (allTargetsHit(targets, hits)) { onProgress('全部目标已命中，停止'); break; }
        } else if (roundHits.length) { onProgress('命中，按设置停止'); break; }
        await wait(tok, roundPacingMs);
      }
      if (draw) {
        const tally = new Map();
        for (const d of drawn) for (const m of d.models.slice(0, 1)) tally.set(m, (tally.get(m) || 0) + 1);
        const dist = [...tally].map(([m, n]) => `${m}×${n}`).join('、') || '无';
        summary = `抽卡结束 · ${drawn.length}/${maxRounds} 轮识别到模型 · ${dist}`;
      } else {
        const hitStr = hits.length ? hits.map((h) => `${h.target}→${h.model}`).join('、') : '无';
        summary = `探针结束 · 命中：${hitStr}`;
      }
    } catch (e) {
      summary = isCancelled(e)
        ? (draw ? `抽卡已停止（完成 ${drawn.length} 轮）` : `探针已停止（命中 ${hits.length} 个）`)
        : `${draw ? '抽卡' : '探针'}中断：${e.message || e}`;
    } finally {
      // Auto-rename opens the sidebar to reach a chat's ⋯ menu; close it once
      // here so the probe doesn't leave the sidebar open at the end.
      if (renamedAny) { try { await rpc.call('collapseSidebar'); } catch { /* best effort */ } }
      end(tok);
      onProbeState(0, maxRounds, draw ? drawn.length : hits.length, false);
      onFinished(summary);
    }
    return { mode: draw ? 'draw' : 'probe', hits, drawn, sessions, cancelled: tok.cancelled, summary };
  }

  /* One-off: fill the CURRENTLY open conversation's composer with text and
   * send. Independent of the loop; refused while a probe/cleanup runs so the
   * two don't fight over the composer. */
  async function quickSend(text) {
    if (isRunning()) return { ok: false, message: '探针运行中，请先停止再发送' };
    if (!String(text || '').trim()) return { ok: false, message: '请先填写要发送的内容' };
    try {
      const data = await rpc.call('sendToCurrent', { text: String(text) });
      return { ok: true, message: '已发送到当前对话', data };
    } catch (e) {
      return { ok: false, message: `发送失败：${e.message || e}` };
    }
  }

  async function fetchSidebar(tok) {
    const data = await call(tok, 'sidebarList', { expand: false });
    return (Array.isArray(data?.items) ? data.items : []).map((o) => ({ sessionId: String(o?.sessionId || ''), title: String(o?.title || '') }));
  }
  async function nextCandidate(tok, keepSessionId, done) {
    return arithmeticCleanupCandidates(await fetchSidebar(tok), keepSessionId).find((c) => !done.has(c.sessionId)) || null;
  }
  /* Archive one candidate from its sidebar ⋯ menu without opening the chat;
   * reveal the (virtualised) row first, retry the whole thing once. */
  async function archiveCandidate(tok, c) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await call(tok, 'revealSidebarItem', { sessionId: c.sessionId });
        await call(tok, 'archive', { sessionId: c.sessionId, requireCurrentUrl: false, manageSidebar: false });
        return;
      } catch (e) {
        if (isCancelled(e)) throw e;
        lastError = e;
        if (attempt === 0) await wait(tok, archiveRetryMs);
      }
    }
    throw lastError || new Error('归档失败');
  }

  /* Sidebar title sweep: archive chats whose title is bare arithmetic (our
   * probe residue). Never deletes; never touches user-named chats or
   * keepSessionId (the open conversation). */
  async function cleanup(keepSessionId = null) {
    const tok = begin('cleanup');
    if (!tok) { onProgress(mode === 'probe' ? '探针运行中，请先停止再清理' : '清理已在进行'); return null; }
    let ok = 0, failed = 0, remaining = -1;
    let sidebarOpened = false;
    let summary = '';
    const archivedIds = [];
    onCleanupState(0, true);
    try {
      onProgress('扫描侧栏算式标题…');
      // Open the sidebar ONCE up front; later scans pass expand=false.
      await call(tok, 'sidebarList', { expand: true });
      sidebarOpened = true;
      const done = new Set();
      const archived = new Set();
      let consecutiveFailures = 0;
      for (;;) {
        if (tok.cancelled) throw new Cancelled();
        let candidate = await nextCandidate(tok, keepSessionId, done);
        // After an archive the sidebar may still be repopulating — retry twice.
        if (!candidate) {
          await wait(tok, 1000);
          candidate = await nextCandidate(tok, keepSessionId, done);
          if (!candidate) {
            await wait(tok, 1500);
            candidate = await nextCandidate(tok, keepSessionId, done);
            if (!candidate) break;
          }
        }
        if (ok + failed === 0) onProgress('发现算式标题对话，开始归档');
        try {
          await archiveCandidate(tok, candidate);
          ok++; done.add(candidate.sessionId); archived.add(candidate.sessionId); archivedIds.push(candidate.sessionId);
          try { onArchived(candidate.sessionId); } catch { /* record cleanup must not break the sweep */ }
          consecutiveFailures = 0;
          onProgress(`已归档 ${candidate.title}`);
          onCleanupState(ok, true);
        } catch (e) {
          if (isCancelled(e)) throw e;
          failed++; done.add(candidate.sessionId); consecutiveFailures++;
          onProgress(`归档 ${candidate.title} 失败：${e.message || e}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { onProgress('连续失败已中止'); break; }
        }
        await wait(tok, cleanupPacingMs);
      }
      // Post-sweep recount: report arithmetic titles still left behind.
      await wait(tok, 800);
      try { remaining = arithmeticCleanupCandidates(await fetchSidebar(tok), keepSessionId).filter((c) => !archived.has(c.sessionId)).length; } catch (e) { if (isCancelled(e)) throw e; remaining = -1; }
      const tail = remaining > 0 ? `，仍有 ${remaining} 个未归档（可再点一次清理）` : failed > 0 ? `，失败 ${failed}` : '';
      summary = ok === 0 && failed === 0 && remaining <= 0 ? '没有需要归档的算式标题对话' : `清理完成 · 已归档 ${ok}${tail}（仅归档，未删除）`;
    } catch (e) {
      summary = isCancelled(e) ? `清理已停止（已归档 ${ok}）` : `清理中断：${e.message || e}`;
    } finally {
      if (sidebarOpened) { try { await rpc.call('collapseSidebar'); } catch { /* best effort */ } }
      end(tok);
      onCleanupState(ok, false);
      onFinished(summary);
    }
    return { archived: ok, failed, remaining, cancelled: tok.cancelled, summary, archivedIds: [...archivedIds] };
  }

  return {
    start, stop, cleanup, quickSend,
    get isRunning() { return isRunning(); },
    get mode() { return isRunning() ? mode : null; },
    get suffixCounters() { return { ...counters }; },
  };
}
