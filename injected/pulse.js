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
 * an earlier refetch but never sooner than 15 s; a 429 Retry-After (capped at
 * 10 min) always wins. Results go to the dock as a `pulse` page event:
 *   {ok:true, percent, refreshedAt(ms|0), at}  |  {ok:false, error, retryAfterMs, at}
 * The dock may force a refetch (subject to the same gaps) via dispatch('pulse-refresh').
 */
(() => {
  if (window.__ARENAKIT_PULSE__) return;
  const PULSE_URL = 'https://arena.ai/api/me/pulse';
  const NORMAL_GAP_MS = 60_000;
  const ACCOUNT_GAP_MS = 15_000;
  const TICK_MS = 1_000;
  const MAX_BLOCK_MS = 600_000;

  let lastFetch = 0;
  let blockedUntil = 0;
  let lastCookieSig = '';
  let inFlight = false;
  let wanted = false; // manual refresh requested

  const send = (payload) => { try { window.__ARENAKIT__ && window.__ARENAKIT__.send('pulse', payload); } catch { } };
  const sig = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };

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

  async function fetchPulse(now) {
    inFlight = true;
    lastFetch = now;
    try {
      const res = await fetch(PULSE_URL, { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After'));
        const retryAfterMs = (Number.isFinite(retry) && retry > 0 ? retry : 120) * 1000;
        blockedUntil = now + Math.min(retryAfterMs, MAX_BLOCK_MS);
        send({ ok: false, error: '额度接口限流（429）', retryAfterMs, at: now });
        return;
      }
      if (res.status === 401 || res.status === 403) { send({ ok: false, error: '未登录 Arena', at: now }); return; }
      if (!res.ok) { send({ ok: false, error: `额度接口返回 HTTP ${res.status}`, at: now }); return; }
      const pulse = parse(await res.json());
      if (!pulse) { send({ ok: false, error: '额度返回格式未识别', at: now }); return; }
      send({ ok: true, percent: pulse.percent, refreshedAt: pulse.refreshedAt, at: now });
    } catch (e) {
      send({ ok: false, error: '额度读取失败：' + (e && e.message || e), at: now });
    } finally {
      inFlight = false;
    }
  }

  function tick(now = Date.now()) {
    if (inFlight) return false;
    if (location.origin !== 'https://arena.ai') return false;
    const cookieSig = sig(String(document.cookie || ''));
    const accountChanged = cookieSig !== lastCookieSig;
    const minGap = accountChanged || wanted ? ACCOUNT_GAP_MS : NORMAL_GAP_MS;
    if (now - lastFetch < minGap || now < blockedUntil) return false;
    lastCookieSig = cookieSig;
    wanted = false;
    fetchPulse(now);
    return true;
  }

  const timer = setInterval(() => { try { tick(); } catch { } }, TICK_MS);
  const requestRefresh = () => { wanted = true; return tick(); };
  if (window.__ARENAKIT__ && typeof window.__ARENAKIT__.on === 'function') {
    try { window.__ARENAKIT__.on('pulse-refresh', requestRefresh); } catch { }
  }
  window.__ARENAKIT_PULSE__ = { parse, tick, requestRefresh, PULSE_URL, _timer: timer };
  // first read as soon as the page is up
  setTimeout(() => { try { tick(); } catch { } }, 1500);
})();
