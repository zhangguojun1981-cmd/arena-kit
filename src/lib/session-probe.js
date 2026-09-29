/* Session probe (会话探针): send one probe message into the conversation that
 * is ALREADY open and identify the model that answers *this turn*. Unlike the
 * auto probe it never creates chats; unlike a plain trace it is an explicit,
 * user-triggered check ("what am I talking to right now?").
 *
 * The page half is probe.js sendToCurrent (Android quickSend); the
 * identification half is the per-turn tracker fed by the trace pipeline. This
 * module is the pure glue: preconditions and "wait for the next identified
 * turn". */
import { randomPrompt } from './probe-logic.js';

export const TURN_WAIT_MS = 60_000;
export const TURN_POLL_MS = 500;

/* Turn the page precheck into a go / no-go with a human reason. */
export function sessionProbePrecheck(pre, { probeRunning = false } = {}) {
  if (probeRunning) return { ok: false, reason: '探针运行中，请先停止再发送' };
  if (!pre || typeof pre !== 'object') return { ok: false, reason: '无法读取页面状态' };
  if (!pre.onArena) return { ok: false, reason: '已离开 Arena' };
  if (!pre.session && !pre.agentPath) return { ok: false, reason: '请先打开一个 Arena 对话' };
  if (!pre.hasComposer) return { ok: false, reason: '未找到输入框' };
  if (pre.isGenerating) return { ok: false, reason: '当前回复仍在生成，请稍后再试' };
  if (pre.dialogOpen || pre.renameBusy) return { ok: false, reason: '页面有对话框打开，已停止' };
  if (pre.hasDraft && !pre.draftIsOwnPrompt) return { ok: false, reason: '输入框有未发送的草稿，已停止；不会覆盖草稿' };
  return { ok: true, reason: pre.session ? '' : '当前是新对话，发送后将创建会话' };
}

/* The text to send: the user's own text, or a fresh arithmetic prompt. */
export function sessionProbeText(custom, rng) {
  const t = String(custom ?? '').trim();
  if (t.length > 8000) throw new Error('内容过长（上限 8000 字）');
  return t || randomPrompt(rng);
}

/* Wait until the tracker shows a turn newer than `afterTurn` with a model
 * (or, when the conversation was fresh, any identified turn of the session
 * that appeared after sending). Resolves {turn, model, models, runId} or null. */
export async function awaitTurnModel({
  tracker, afterTurn = 0, sessionId = null, timeoutMs = TURN_WAIT_MS, pollMs = TURN_POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, signal = null,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return null;
    const sameSession = !sessionId || !tracker.sessionId || tracker.sessionId === sessionId;
    if (sameSession) {
      const hit = (tracker.turns || []).find((t) => t.turn > afterTurn && t.model);
      if (hit) return { turn: hit.turn, model: hit.model, models: hit.models || [hit.model], runId: hit.runId || '' };
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}
