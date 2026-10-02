/* Reply monitor (回复监控), dock side. Turns the page-side stream summary
 * (injected/monitor.js → `reply-monitor` page event) into anomaly badges on
 * the matching turn of the per-turn tracker. Content is never inspected here —
 * only counts and flags arrive.
 *
 * Anomaly kinds (badge label):
 *   reply-error      回复报错   error frame / failed status / HTTP error
 *   reply-truncated  回复中断   stream cut before it finished (abort)
 *   reply-stalled    回复停滞   no frame for 2 min while Stop is still shown
 *   reply-empty      空回复     stream finished normally with no text at all */

export const KINDS = {
  'reply-error': '回复报错',
  'reply-truncated': '回复中断',
  'reply-stalled': '回复停滞',
  'reply-empty': '空回复',
};

const fmtChars = (n) => (n >= 10_000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtDur = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

export function classifyReply(s) {
  if (!s || typeof s !== 'object') return { anomalies: [], line: '' };
  const frames = Number(s.frames) || 0, textChars = Number(s.textChars) || 0, errorFrames = Number(s.errorFrames) || 0;
  const anomalies = [];
  const err = String(s.lastError || '').trim();
  if (errorFrames > 0 || err || s.ended === 'http') anomalies.push({ kind: 'reply-error', label: KINDS['reply-error'] + (err ? `：${err.slice(0, 60)}` : '') });
  if (s.ended === 'abort') anomalies.push({ kind: 'reply-truncated', label: KINDS['reply-truncated'] });
  if (s.ended === 'stalled') anomalies.push({ kind: 'reply-stalled', label: KINDS['reply-stalled'] });
  if (s.ended === 'done' && textChars === 0 && !anomalies.length) anomalies.push({ kind: 'reply-empty', label: KINDS['reply-empty'] });
  const stats = [`${frames} 帧`, `${fmtChars(textChars)} 字符`, fmtDur(Number(s.durationMs) || 0)];
  const line = stats.join(' · ') + ' · ' + (anomalies.length ? anomalies.map((a) => a.label).join('、') : '无异常信号');
  return { anomalies, line };
}

/* Keeps the last few summaries and marks the tracker turn they belong to.
 * A stream belongs to the newest turn of its conversation (the tracker only
 * follows one conversation at a time; other sessions are kept but unmarked). */
export function createReplyMonitor({ tracker, max = 8 } = {}) {
  const entries = []; // newest last: {sessionId, turn, line, anomalies, at}
  function ingest(summary) {
    if (!summary || typeof summary !== 'object' || typeof summary.sessionId !== 'string') return null;
    const { anomalies, line } = classifyReply(summary);
    let turn = null;
    if (tracker && tracker.sessionId === summary.sessionId && tracker.turns.length) {
      const e = tracker.turns.at(-1);
      turn = e.turn;
      for (const a of anomalies) tracker.mark(turn, a.kind, a.label.split('：')[0]);
    }
    const entry = { sessionId: summary.sessionId, turn, line, anomalies, at: Number(summary.at) || Date.now() };
    entries.push(entry);
    if (entries.length > max) entries.splice(0, entries.length - max);
    return entry;
  }
  return { ingest, get entries() { return entries.slice(); }, get last() { return entries.at(-1) || null; } };
}
