/* Reply watchdog policy (port of the reference app's web/ReplyWatchdog.kt).
 *
 * Auto-refresh for the failure mode where the conversation UI stops updating:
 * the reply shows an error card ("Something went wrong with this response,
 * please try again." / "出现了一些问题…请重试"), or the model finished but
 * nothing was rendered. Page-side injected/watchdog.js reports a compact
 * status ({k, path, generating, len, at, act}, the `watch` page event); this
 * module decides when an automatic reload is allowed:
 *
 *  - the page only reports within 2 minutes of real conversation activity
 *    (send / stream growth / Stop button); the policy re-checks that window —
 *    a conversation the user is merely READING is never refreshed;
 *  - one sighting is suspicious, two (≥ CONFIRM_MS apart) are evidence;
 *  - the same problem (same path + same error key) auto-reloads at most twice,
 *    then nudges for a manual refresh once, then stays silent;
 *  - ≥ COOLDOWN_MS between two auto reloads of the same path; never while a
 *    link tab covers the page, a load is in flight, or a probe / cleanup /
 *    quick send started less than TASK_BLOCK_MS ago.
 *
 * Pure: no DOM, no timers. State is a plain immutable-by-convention object. */

export const COOLDOWN_MS = 30_000;
export const TASK_BLOCK_MS = 120_000;
export const FRESH_MS = 120_000;
export const ERROR_ACCEPT_MS = 45_000;
export const STALE_EMPTY_MS = 20_000;
export const MAX_SAME_KEY_RELOADS = 2;
export const MAX_SNIPPET_CHARS = 24;
export const CONFIRM_MS = 2_000;
export const MAX_SEEN_PROBLEMS = 64;

export const KEY_EMPTY = 'empty';
export const KEY_ERROR_PREFIX = 'error:';

export const Reason = Object.freeze({
  BUSY: 'busy', TASK_RUNNING: 'task-running', COOLDOWN: 'cooldown', STALE: 'stale', NAG: 'nag', CAPPED: 'capped', WAIT: 'wait',
});

export const RELOAD = Object.freeze({ action: 'reload' });
export const IGNORE = Object.freeze({ action: 'ignore' });
export const track = (reason) => ({ action: 'track', reason });

export function initialState() {
  return { lastReloadAt: {}, reloads: {}, nagged: [], firstSeen: {} };
}

const AGENT_PATH = /^\/(?:agent|c\/)/;

/* Parse one page report. Returns null for anything malformed and for
 * non-conversation paths (the page only scans those anyway). */
export function parseStatus(o) {
  if (!o || typeof o !== 'object') return null;
  const key = typeof o.k === 'string' ? o.k : '';
  const path = typeof o.path === 'string' ? o.path : '';
  if (!key || !path || !AGENT_PATH.test(path)) return null;
  let textKey;
  if (key === KEY_EMPTY) textKey = KEY_EMPTY;
  else if (key.startsWith(KEY_ERROR_PREFIX)) textKey = KEY_ERROR_PREFIX + key.slice(KEY_ERROR_PREFIX.length).slice(0, MAX_SNIPPET_CHARS);
  else return null;
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
  return {
    key: textKey,
    path: path.slice(0, 128),
    generating: o.generating === true,
    textLen: Math.trunc(num(o.len, 0, 1_000_000)),
    at: num(o.at, 0, Number.MAX_SAFE_INTEGER),
    act: num(o.act, 0, Number.MAX_SAFE_INTEGER),
  };
}

const problemOf = (status) => status.path + '|' + status.key;

/* Decide what to do with a page status.
 * @param opts.linkTabOpen   the in-app link tab covers the page
 * @param opts.loading       a page load is in flight (auto reload would fight it)
 * @param opts.taskStartedAt epoch ms when the current task started; 0 = no task */
export function decide(state, status, nowMs, { linkTabOpen = false, loading = false, taskStartedAt = 0 } = {}) {
  if (!status) return IGNORE;
  if (linkTabOpen || loading) return track(Reason.BUSY);
  if (taskStartedAt > 0 && nowMs - taskStartedAt < TASK_BLOCK_MS) return track(Reason.TASK_RUNNING);

  // No known/recent conversation activity: an idle chat is never ours to fix.
  // act=0 (the page knows of none) counts as idle.
  if (nowMs - (status.act || 0) > FRESH_MS) return IGNORE;

  // A streaming reply usually gets its content in the end — don't interrupt.
  if (status.generating && status.key === KEY_EMPTY) return IGNORE;

  // Stale reports: empty goes cold quickly, errors stay actionable longer.
  if (status.at > 0) {
    const age = nowMs - status.at;
    const limit = status.key === KEY_EMPTY ? STALE_EMPTY_MS : ERROR_ACCEPT_MS;
    if (age > limit) return track(Reason.STALE);
  }

  // Budget per problem: at most MAX_SAME_KEY_RELOADS automatic reloads, then
  // one manual-refresh nudge, then silence.
  const problem = problemOf(status);
  if ((state.reloads[problem] || 0) >= MAX_SAME_KEY_RELOADS) {
    return track(state.nagged.includes(problem) ? Reason.CAPPED : Reason.NAG);
  }

  // Two observations, at least CONFIRM_MS apart, before any action.
  const first = state.firstSeen[problem];
  if (!first) return track(Reason.WAIT);
  if (nowMs - first < CONFIRM_MS) return track(Reason.WAIT);

  const last = state.lastReloadAt[status.path] || 0;
  if (last > 0 && nowMs - last < COOLDOWN_MS) return track(Reason.COOLDOWN);
  return RELOAD;
}

/* Apply the outcome of decide() to the state (returns a new state). */
export function applied(state, status, decision, nowMs) {
  if (!status || !decision) return state;
  const problem = problemOf(status);
  if (decision.action === 'reload') {
    const firstSeen = { ...state.firstSeen };
    delete firstSeen[problem]; // a reload starts a fresh observation cycle
    return {
      ...state,
      lastReloadAt: { ...state.lastReloadAt, [status.path]: nowMs },
      reloads: { ...state.reloads, [problem]: (state.reloads[problem] || 0) + 1 },
      firstSeen,
    };
  }
  if (decision.action === 'track') {
    if (decision.reason === Reason.NAG) {
      return state.nagged.includes(problem) ? state : { ...state, nagged: [...state.nagged, problem] };
    }
    if (decision.reason === Reason.WAIT) {
      if (Object.prototype.hasOwnProperty.call(state.firstSeen, problem)) return state;
      const firstSeen = { ...state.firstSeen, [problem]: nowMs };
      const keys = Object.keys(firstSeen);
      if (keys.length > MAX_SEEN_PROBLEMS) {
        let oldest = keys[0];
        for (const k of keys) if (firstSeen[k] < firstSeen[oldest]) oldest = k;
        delete firstSeen[oldest];
      }
      return { ...state, firstSeen };
    }
  }
  return state;
}

/* Human-readable log lines (reference strings.xml). */
export const LOG_RELOADING = '回复异常，正在自动刷新…';
export const LOG_NAG = '当前对话回复异常仍未恢复，请手动刷新（自动刷新已达上限）';
