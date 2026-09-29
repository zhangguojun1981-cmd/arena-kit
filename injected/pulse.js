/* ArenaKit injected/pulse.js — daily-quota (pulse %) poller, page side.
 * Source: arena-trace-inspector pulse.js (PULSE_URL, payload shape) +
 * arena-trace-android PulseClient.kt / MainActivity.startPulseLoop (cadence,
 * 429 back-off, account-switch refresh). MAIN world, document_start.
 *
 * Runs INSIDE the arena.ai page so the request carries the user's own session
 * cookies (same-origin fetch) — no cookie export, no token, no proxy. Reads only
 * GET https://arena.ai/api/me/pulse → {"pulse": 0..100, "refreshedAt": ISO}.
 *
 * Cadence: at most every 60 s; a cookie change (account switch / login) forces
 * an earlier refetch but never sooner than 15 s. Results go to the dock as a
 * `pulse` page event:
 *   {ok:true, percent, refreshedAt(ms|0), at}
 *   {ok:false, error, retryAfterMs?, transient?, at}
 *   {pending:true, at}                       (a manual refresh was accepted)
 *
 * 0.4.8 — the "429 → 未登录 → 刷新没反应" bug:
 *  - 429 is rate limiting, never "logged out": the last good value is kept
 *    (dock side) and the error is marked `transient`. An explicit Retry-After
 *    blocks the automatic polls; without one we back off 60 s but a MANUAL
 *    refresh may try again after 15 s.
 *  - 401/403 while the auth cookie says "logged in" (ArenaAccount.snapshot)
 *    is the site still refreshing its access token right after load / an
 *    account switch — retried at 5 s / 10 s / 15 s and only then reported.
 *    Only a guest / no-cookie page is reported as "未登录 Arena".
 *  - every fetch has a 15 s timeout, so a hung request can no longer park the
 *    poller (inFlight) forever;
 *  - a manual refresh ALWAYS answers at once: `pending`, or why it cannot
 *    run right now (in flight / rate-limited with the seconds left).
 *  - the first read waits 4 s for the page (and its token refresh) to settle.
 * The dock may force a refetch via dispatch('pulse-refresh').
 */
(() => {
  if (window.__ARENAKIT_PULSE__) return;
  const PULSE_URL = 'https://arena.ai/api/me/pulse';
  const NORMAL_GAP_MS = 60_000;
  const ACCOUNT_GAP_MS = 15_000;
  const MANUAL_GAP_MS = 3_000;
  const TICK_MS = 1_000;
  const MAX_BLOCK_MS = 600_000;
  const DEFAULT_429_MS = 60_000;
  const FETCH_TIMEOUT_MS = 15_000;
  const AUTH_RETRY_MS = [5_000, 10_000, 15_000];

  let lastFetch = 0;
  let blockedUntil = 0;
  let blockedExplicit = false; // the server named the wait (Retry-After)
  let blockedAt = 0;
  let lastCookieSig = '';
  let inFlight = false;
  let inFlightSince = 0;
  let wanted = false; // manual refresh requested
  let retryAt = 0;    // scheduled transient retry (401 while logged in)
  let authFails = 0;

  const send = (payload) => { try { window.__ARENAKIT__ && window.__ARENAKIT__.send('pulse', payload); } catch { } };
  const sig = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
  /* 'logged-in' | 'guest' | 'none' | 'broken' | '' (account helper missing) */
  const loginState = () => { try { return String(window.ArenaAccount.snapshot().state || ''); } catch { return ''; } };

  /* Parse the pulse payload; null when the shape is not the documented one. */
  function parse(json) {
    if (!json || typeof json !== 'object') return null;
    const p = Number(json.pulse);
    if (!Number.isFinite(p) || p < 0 || p > 100) return null;
    let refreshedAt = 0;
    if (typeof json.refreshedAt === 'string') { const t = Date.parse(json.refreshedAt); if (Number.isFinite(t)) refreshedAt = t; }
    else if (typeof json.refreshedAt === 'number' && Number.isFinite(json.refreshedAt)) refreshedAt = json.refreshedAt > 1e11 ? json.refreshedAt : json.refreshedAt * 1000;
    return { percent: Math.round(p), refreshedAt };
  }

  function onAuthRefused(status, now) {
    const st = loginState();
    // guest / no session: that really is "not logged in"
    if (st === 'guest' || st === 'none') { authFails = 0; retryAt = 0; send({ ok: false, error: '未登录 Arena', at: now }); return; }
    if (authFails < AUTH_RETRY_MS.length) {
      retryAt = now + AUTH_RETRY_MS[authFails];
      authFails++;
      send({ ok: false, transient: true, error: '登录会话刷新中，稍后自动重试', at: now });
      return;
    }
    retryAt = 0;
    send({ ok: false, error: st === 'logged-in' ? `额度接口拒绝访问（HTTP ${status}），请重新加载页面` : '未登录 Arena', at: now });
  }

  async function fetchPulse(now) {
    inFlight = true;
    inFlightSince = now;
    lastFetch = now;
    retryAt = 0;
    let timer = 0;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { try { ctl && ctl.abort(); } catch { } reject(new Error('timeout')); }, FETCH_TIMEOUT_MS); });
      const opts = { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' };
      if (ctl) opts.signal = ctl.signal;
      const res = await Promise.race([fetch(PULSE_URL, opts), timeout]);
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After'));
        blockedExplicit = Number.isFinite(retry) && retry > 0;
        const retryAfterMs = Math.min(blockedExplicit ? retry * 1000 : DEFAULT_429_MS, MAX_BLOCK_MS);
        blockedAt = now;
        blockedUntil = now + retryAfterMs;
        send({ ok: false, transient: true, error: `额度接口限流（429），${Math.ceil(retryAfterMs / 1000)} 秒后自动重试`, retryAfterMs, at: now });
        return;
      }
      if (res.status === 401 || res.status === 403) { onAuthRefused(res.status, now); return; }
      if (!res.ok) { send({ ok: false, transient: true, error: `额度接口返回 HTTP ${res.status}`, at: now }); return; }
      const pulse = parse(await Promise.race([res.json(), timeout]));
      if (!pulse) { send({ ok: false, error: '额度返回格式未识别', at: now }); return; }
      authFails = 0;
      blockedUntil = 0;
      send({ ok: true, percent: pulse.percent, refreshedAt: pulse.refreshedAt, at: now });
    } catch (e) {
      const msg = e && e.message === 'timeout' ? '额度读取超时（15 秒）' : '额度读取失败：' + (e && e.message || e);
      send({ ok: false, transient: true, error: msg, at: now });
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
  }

  function tick(now = Date.now()) {
    if (location.origin !== 'https://arena.ai') return false;
    if (inFlight) {
      if (now - inFlightSince < FETCH_TIMEOUT_MS + 5_000) return false;
      inFlight = false; // belt and braces: a request that never settled
    }
    const manual = wanted;
    // ArenaKit 设置 → 额度轮询 off: no periodic reads (an explicit 刷新 still goes through).
    if (!manual && !retryAt && window.__ARENAKIT_FLAGS__ && window.__ARENAKIT_FLAGS__.pulse === false) return false;
    if (now < blockedUntil) {
      // a guessed back-off (no Retry-After) yields to a manual refresh after 15 s
      if (!(manual && !blockedExplicit && now - blockedAt >= ACCOUNT_GAP_MS)) return false;
    }
    const cookieSig = sig(String(document.cookie || ''));
    const accountChanged = cookieSig !== lastCookieSig;
    const due = retryAt && now >= retryAt;
    const minGap = manual || due ? MANUAL_GAP_MS : accountChanged ? ACCOUNT_GAP_MS : NORMAL_GAP_MS;
    if (now - lastFetch < minGap) return false;
    if (accountChanged && lastCookieSig) authFails = 0;
    lastCookieSig = cookieSig;
    wanted = false;
    fetchPulse(now);
    return true;
  }

  const timer = setInterval(() => { try { tick(); } catch { } }, TICK_MS);
  /* Manual refresh: fetch now if possible; ALWAYS tell the dock what happened. */
  const requestRefresh = (now = Date.now()) => {
    if (typeof now !== 'number') now = Date.now();
    wanted = true;
    if (inFlight && now - inFlightSince < FETCH_TIMEOUT_MS + 5_000) { send({ pending: true, at: now }); return false; }
    const started = tick(now);
    if (started) { send({ pending: true, at: now }); return true; }
    if (now < blockedUntil) {
      const left = Math.ceil((blockedUntil - now) / 1000);
      send({ ok: false, transient: true, error: `额度接口限流中，${left} 秒后自动重试`, retryAfterMs: blockedUntil - now, at: now });
    } else {
      send({ pending: true, at: now }); // the 1 s ticker picks it up within the manual gap
    }
    return false;
  };
  if (window.__ARENAKIT__ && typeof window.__ARENAKIT__.on === 'function') {
    try { window.__ARENAKIT__.on('pulse-refresh', () => requestRefresh()); } catch { }
  }
  window.__ARENAKIT_PULSE__ = { parse, tick, requestRefresh, PULSE_URL, _timer: timer };
  // first read once the page (and its token refresh) has settled
  setTimeout(() => { try { tick(); } catch { } }, 4000);
})();
