/* ArenaKit injected/bridge.js
 * MAIN world, document_start — the FIRST script in the init bundle.
 *
 * The only page-side code that talks to Tauri. Every other injected module
 * (snoop, probe, pulse, monitor, gm-shim) goes through window.__ARENAKIT__:
 *
 *   page → Rust : invoke(cmd, args)        Tauri IPC, gated by capabilities/arena.json
 *   page → dock : send(name, payload)      Rust re-emits it as the "arenakit://page" event
 *   dock → page : dispatch(name, payload)  the dock evals this via the arena_command command
 *
 * Also announces SPA navigation (pushState / replaceState / popstate / title
 * changes) to the dock so it can restore the remembered model per conversation
 * and reset per-conversation turn tracking — the Tauri equivalent of the
 * Android WebViewClient.doUpdateVisitedHistory hook.
 *
 * No conversation text ever leaves the page through this bridge.
 */
(() => {
  if (window.__ARENAKIT__) return;

  // ── reload progress: 2 px brand bar at the very top, from document_start
  // until `load` (reference page_progress). Only after an ArenaKit-triggered
  // reload (page-actions `reload` stamps sessionStorage; cleared here).
  (function bootProgress() {
    let stamp = 0;
    try { stamp = Number(sessionStorage.getItem('arenakit.reloading')) || 0; sessionStorage.removeItem('arenakit.reloading'); } catch { return; }
    if (!stamp || Date.now() - stamp > 60_000 || document.readyState === 'complete') return;
    const dark = (() => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } })();
    const bar = document.createElement('div');
    bar.id = 'arenakit-boot-progress';
    bar.setAttribute('style', `position:fixed;top:0;left:0;height:2px;width:8%;background:${dark ? '#9DB8FF' : '#2F6BFF'};z-index:2147483647;transition:width .3s ease-out,opacity .25s;pointer-events:none;`);
    (document.documentElement || document).appendChild(bar);
    let v = 8;
    const tick = setInterval(() => { v = Math.min(90, v + (90 - v) * 0.08); bar.style.width = v + '%'; }, 200);
    const finish = () => { clearInterval(tick); bar.style.width = '100%'; setTimeout(() => { bar.style.opacity = '0'; setTimeout(() => bar.remove(), 300); }, 250); };
    document.addEventListener('DOMContentLoaded', () => { v = Math.max(v, 70); bar.style.width = v + '%'; }, { once: true });
    window.addEventListener('load', finish, { once: true });
    setTimeout(finish, 30_000);
  })();

  const internals = () => window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => {
    const t = internals();
    return t && typeof t.invoke === 'function'
      ? t.invoke(cmd, args || {})
      : Promise.reject(new Error('no tauri runtime'));
  };

  // dock → page event bus (dispatch is invoked by evaluated JS).
  const handlers = new Map();
  const on = (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name)?.delete(fn);
  };
  const dispatch = (name, payload) => {
    let n = 0;
    for (const fn of handlers.get(name) || []) {
      n++;
      try { fn(payload); } catch (e) { console.warn('[ArenaKit] dispatch', name, e); }
    }
    return n;
  };

  // page → dock. Fire-and-forget; failures are logged, never thrown into callers.
  const send = (name, payload) => invoke('page_event', { name: String(name), payload: payload === undefined ? null : payload })
    .catch((e) => console.warn('[ArenaKit] page_event', name, e));

  const sessionFromPath = (path) => String(path || '').match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const navState = () => ({
    path: location.pathname,
    sessionId: sessionFromPath(location.pathname),
    agentPath: location.pathname.replace(/\/$/, '') === '/agent',
    title: String(document.title || '').slice(0, 300),
    url: location.href.split(/[?#]/)[0],
  });

  window.__ARENAKIT__ = {
    invoke,
    onToken: (p) => invoke('on_token', { token: p.token, sessionId: p.sessionId })
      .catch((e) => console.warn('[ArenaKit] on_token', e)),
    proxyGet: (url) => invoke('proxy_get', { url }),
    storeGet: (key) => invoke('store_get', { key }),
    storeSet: (key, value) => invoke('store_set', { key, value: value === undefined ? null : value }),
    send, on, dispatch, navState, sessionFromPath,
  };

  // ── navigation announcements ────────────────────────────────────────────
  let lastSig = '';
  const announce = (reason) => {
    const s = navState();
    const sig = s.path + '|' + s.title;
    if (sig === lastSig && reason !== 'init') return;
    lastSig = sig;
    send('nav', { ...s, reason });
  };
  const wrapHistory = (name) => {
    const orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(() => announce(name), 0);
      return r;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => announce('popstate'));
  const watchTitle = () => {
    const el = document.querySelector('title');
    if (!el || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => announce('title')).observe(el, { childList: true, characterData: true, subtree: true });
  };
  const init = () => { announce('init'); watchTitle(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
