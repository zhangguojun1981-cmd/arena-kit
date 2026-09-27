/* Quota (pulse %) timing + formatting — port of arena-trace-android
 * net/PulseTiming.kt and the extension's pulse.js level()/format(). Pure.
 *
 * Bug PulseTiming fixes: /api/me/pulse returns `refreshedAt`, the time the
 * quota was last refreshed. Using it directly as the reset instant made the
 * countdown jump back to ~24h on every refetch. Derive the reset instant from
 * refreshedAt and ANCHOR it so refetch jitter never restarts the count. */

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DRIFT_TOLERANCE_MS = 2 * 60 * 1000;

/* refreshedAt ≤ 0 → 0 (unknown); in the past → window start, reset one window
 * later; in the future → treat as the reset instant itself. */
export function resetTimeFromRefreshedAt(refreshedAtMs, nowMs, windowMs = QUOTA_WINDOW_MS) {
  if (!(refreshedAtMs > 0)) return 0;
  return refreshedAtMs <= nowMs ? refreshedAtMs + windowMs : refreshedAtMs;
}

/* Keep the countdown stable across refetches: adopt the candidate only when
 * there is no anchor, the anchor already elapsed, or the candidate is
 * meaningfully EARLIER; otherwise keep the anchor. */
export function anchorReset(previousAnchorMs, candidateMs, nowMs, toleranceMs = DRIFT_TOLERANCE_MS) {
  if (!(candidateMs > 0)) return previousAnchorMs > 0 ? previousAnchorMs : 0;
  if (!(previousAnchorMs > 0)) return candidateMs;
  if (nowMs >= previousAnchorMs) return candidateMs;
  if (candidateMs < previousAnchorMs - toleranceMs) return candidateMs;
  return previousAnchorMs;
}

/* ok / warning (<20%) / danger (<10%) — matches pulse.rs credit_band and the
 * dock bar's data-band values. */
export function band(percent) {
  if (!Number.isFinite(percent)) return 'unknown';
  if (percent < 10) return 'danger';
  if (percent < 20) return 'warning';
  return 'ok';
}

/* H:MM:SS */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export function formatReset(anchorMs, nowMs) {
  if (!(anchorMs > 0)) return '';
  const left = anchorMs - nowMs;
  return left > 0 ? formatCountdown(left) + ' 后重置' : '已到重置时间，正在重新读取…';
}

/* Small state machine the dock feeds with `pulse` page events. */
export function createPulseState({ now = Date.now } = {}) {
  const s = { percent: null, refreshedAt: 0, anchor: 0, error: '', updatedAt: 0, blockedUntil: 0 };
  return {
    ingest(ev) {
      const t = Number(ev?.at) || now();
      if (ev && ev.ok === true && Number.isFinite(Number(ev.percent))) {
        s.percent = Math.max(0, Math.min(100, Math.round(Number(ev.percent))));
        s.refreshedAt = Number(ev.refreshedAt) || 0;
        s.anchor = anchorReset(s.anchor, resetTimeFromRefreshedAt(s.refreshedAt, t), t);
        s.error = '';
        s.updatedAt = t;
      } else if (ev && ev.ok === false) {
        s.error = String(ev.error || '额度读取失败');
        if (Number(ev.retryAfterMs) > 0) s.blockedUntil = t + Math.min(Number(ev.retryAfterMs), 600_000);
      }
      return this.view(t);
    },
    view(t = now()) {
      const known = s.percent !== null;
      const reset = formatReset(s.anchor, t);
      let text;
      if (!known) text = s.error ? `额度：${s.error}` : '额度读取中…';
      else text = `剩余额度 ${s.percent}%` + (reset ? ' · ' + reset : '') + (s.error ? ' · ' + s.error : '');
      return { percent: s.percent, band: band(s.percent ?? NaN), reset, error: s.error, text, anchor: s.anchor, updatedAt: s.updatedAt };
    },
    get state() { return { ...s }; },
  };
}
