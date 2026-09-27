/* Per-conversation turn tracking.
 * Port of arena-trace-android probe/TurnTracker.kt (semantics + strings kept
 * identical so the Kotlin unit tests translate 1:1, see tests/turns.test.mjs).
 *
 * Arena issues a fresh run token per turn, and a turn may be routed to a
 * different model — so each new token is a new turn. `routed` is true when a
 * turn's model differs from the CURRENT conversation's first resolved model.
 *
 * Reset discipline: a non-empty sessionId that differs from the tracked one
 * means the chat was SWITCHED (sidebar tap, probe newChat). That switch —
 * observed at token time — is the authoritative reset point. Navigation events
 * also reset, but they can be missed, so they are only a best-effort complement.
 *
 * Extension over Android: `runs` keeps a runId → turn map and per-turn entries
 * (model, run, anomaly marks) for the dock's timeline. */

export const MAX_HISTORY = 6;

export function createTurnTracker() {
  const t = {
    sessionId: '',
    turnCount: 0,
    firstModel: '',
    lastModel: '',
    routed: false,
    history: [],
    turns: [],           // [{turn, runId, model, models, status, marks:[]}] newest last
    runToTurn: new Map(),
  };

  function reset(newSessionId = '') {
    t.sessionId = newSessionId;
    t.turnCount = 0;
    t.firstModel = '';
    t.lastModel = '';
    t.routed = false;
    t.history = [];
    t.turns = [];
    t.runToTurn = new Map();
  }
  function clearRouted() { t.routed = false; }

  /* A fresh run token arrived = a new turn. Returns {turn, switched}. */
  function onToken(sessionId, runId = '') {
    const sid = String(sessionId || '');
    const switched = !!sid && sid !== t.sessionId;
    if (switched) reset(sid);
    if (runId && t.runToTurn.has(runId)) return { turn: t.runToTurn.get(runId), switched: false, repeat: true };
    t.turnCount += 1;
    if (runId) t.runToTurn.set(runId, t.turnCount);
    t.turns.push({ turn: t.turnCount, runId: runId || '', model: '', models: [], status: '识别中', marks: [] });
    return { turn: t.turnCount, switched, repeat: false };
  }

  /* Record the resolved model for `turn` and build the status text:
   * headline + per-turn history line ("本会话: R1 … · R2 …"). */
  function record(turn, model, models = null) {
    const m = String(model || '');
    if (!t.firstModel) t.firstModel = m;
    t.routed = m !== t.firstModel;
    const changedFromPrev = !!t.lastModel && m !== t.lastModel;
    t.lastModel = m;
    t.history.push(`R${turn} ${m}`);
    while (t.history.length > MAX_HISTORY) t.history.shift();
    const entry = t.turns.find((x) => x.turn === turn);
    if (entry) { entry.model = m; entry.models = Array.isArray(models) && models.length ? models.slice() : [m]; entry.status = '已识别'; entry.routed = t.routed; }
    const head = t.routed && changedFromPrev ? `第 ${turn} 轮 · 已切换模型 → ${m}`
      : t.routed ? `第 ${turn} 轮 · ${m}（非首轮模型）`
        : `第 ${turn} 轮 · ${m}`;
    return head + '\n' + historyLine();
  }

  /* "本会话: R1 m1 · R2 m2" — newest last, capped at MAX_HISTORY. */
  function historyLine() { return '本会话: ' + t.history.join(' · '); }

  function turnOf(runId) { return runId ? t.runToTurn.get(runId) ?? null : null; }
  function setStatus(turn, status) { const e = t.turns.find((x) => x.turn === turn); if (e) e.status = String(status || ''); }
  /* Anomaly / note marks per turn (reply monitor). Deduplicated by kind. */
  function mark(turn, kind, label) {
    const e = t.turns.find((x) => x.turn === turn);
    if (!e) return false;
    if (e.marks.some((k) => k.kind === kind)) return false;
    e.marks.push({ kind, label: String(label || kind) });
    return true;
  }

  return {
    get sessionId() { return t.sessionId; },
    get turnCount() { return t.turnCount; },
    get firstModel() { return t.firstModel; },
    get lastModel() { return t.lastModel; },
    get routed() { return t.routed; },
    get turns() { return t.turns; },
    reset, clearRouted, onToken, record, historyLine, turnOf, setStatus, mark,
  };
}
