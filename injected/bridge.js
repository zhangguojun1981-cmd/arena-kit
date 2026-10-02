/* ArenaKit injected/bridge.js
 * MAIN world, document_start — the FIRST script in the init bundle.
 *
 * The only page-side code that talks to Tauri. Every other injected module
 * (snoop, probe, pulse, monitor) goes through window.__ARENAKIT__:
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

  // Arena conversation pages: /agent/{id} and /c/{id} (reference
  // HistoryLogic.CONVERSATION_PATH). The page id need not equal the stream's
  // session id (/c/{evalId} aliases) — attribution follows the stream.
  const SESSION_PATH = /^\/(?:agent|c)\/([a-zA-Z0-9-]{1,128})\/?$/;
  const SESSION_ID = /^[a-zA-Z0-9-]{1,128}$/;
  const sessionFromPath = (path) => String(path || '').match(SESSION_PATH)?.[1] || null;
  const isNewChatPath = (path) => String(path || '').replace(/\/$/, '') === '/agent';
  const navState = () => ({
    path: location.pathname,
    sessionId: sessionFromPath(location.pathname),
    agentPath: isNewChatPath(location.pathname),
    title: String(document.title || '').slice(0, 300),
    url: location.href.split(/[?#]/)[0],
  });

  // ── token routing (reference SessionRouting / TurnIntake) ───────────────
  // snoop.js can still deliver a token from a conversation the user already
  // left (a delayed stream, a prefetch, the old stream closing late). Handing
  // it over would switch the dock's turn log back to the OLD chat. Rule: on a
  // conversation page every stream is accepted (page id and stream id need not
  // match, and a stream may rotate its id between turns); on the new-chat
  // composer exactly ONE conversation is adopted — the first stream not seen
  // before (the chat being created); anywhere else nothing is accepted.
  const known = new Set();
  let newChatSession = null;
  let routedPath = location.pathname;
  const noteKnown = (sessionId) => {
    known.add(sessionId);
    if (known.size > 256) known.delete(known.values().next().value);
  };
  const onRoutedNavigation = (path) => {
    if (path === routedPath) return;
    routedPath = path;
    if (isNewChatPath(path)) newChatSession = null; // a fresh composer starts a fresh adoption
  };
  const accepts = (sessionId, page) => {
    if (!SESSION_ID.test(String(sessionId || ''))) return false;
    if (sessionFromPath(page)) return true;
    if (!isNewChatPath(page)) return false;
    if (newChatSession) return newChatSession === sessionId;
    if (known.has(sessionId)) return false;
    newChatSession = sessionId;
    return true;
  };

  // Last accepted token per stream session, in memory only (the page already
  // holds it): stream activity without a new token (arena streams many replies
  // through ONE run) re-runs the lookup once the first one is over, so the
  // model / turn data follows the growing run. Reference TurnIntake.onActivity.
  const REFRESH_COOLDOWN_MS = 45_000;
  const lastTokens = new Map();
  const tokenExpiry = (token) => {
    try {
      const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number(payload && payload.exp) || 0;
    } catch { return 0; }
  };
  const rememberToken = (sessionId, token) => {
    lastTokens.delete(sessionId);
    lastTokens.set(sessionId, { token, at: Date.now(), refreshedAt: Date.now(), exp: tokenExpiry(token) });
    if (lastTokens.size > 32) lastTokens.delete(lastTokens.keys().next().value);
  };
  const onToken = (p) => {
    const page = p && typeof p.page === 'string' ? p.page : location.pathname;
    if (!p || !accepts(p.sessionId, page)) return Promise.resolve(false);
    noteKnown(p.sessionId);
    rememberToken(p.sessionId, p.token);
    return invoke('on_token', { token: p.token, sessionId: p.sessionId })
      .then(() => true, (e) => { console.warn('[ArenaKit] on_token', e); return false; });
  };
  const onActivity = (p) => {
    const page = p && typeof p.page === 'string' ? p.page : location.pathname;
    if (!p || !accepts(p.sessionId, page)) return false;
    const rec = lastTokens.get(p.sessionId);
    if (!rec) return false;
    const now = Date.now();
    if (now - rec.refreshedAt < REFRESH_COOLDOWN_MS) return false;
    if (rec.exp && rec.exp * 1000 <= now + 5000) return false;
    rec.refreshedAt = now;
    // Rust dedupes a token whose lookup is still running, so this is a no-op
    // until the previous poll finished (forget_token) — exactly the reference
    // "not while in flight" rule.
    invoke('on_token', { token: rec.token, sessionId: p.sessionId })
      .catch((e) => console.warn('[ArenaKit] on_token (refresh)', e));
    return true;
  };

  window.__ARENAKIT__ = {
    invoke,
    onToken,
    onActivity,
    proxyGet: (url) => invoke('proxy_get', { url }),
    storeGet: (key) => invoke('store_get', { key }),
    storeSet: (key, value) => invoke('store_set', { key, value: value === undefined ? null : value }),
    // GitHub Gist sync (manager.js). The token lives in Rust: it can be set or
    // cleared here but never read back, and requests only reach api.github.com/gists.
    gistTokenSet: (token) => invoke('gist_token_set', { token: String(token || '') }),
    gistTokenStatus: () => invoke('gist_token_status'),
    gistRequest: (method, gistId, body) => invoke('gist_request', { method, gistId: gistId || null, body: body === undefined ? null : body }),
    send, on, dispatch, navState, sessionFromPath, isNewChatPath,
  };

  // ── navigation announcements ────────────────────────────────────────────
  let lastSig = '';
  const announce = (reason) => {
    const s = navState();
    onRoutedNavigation(s.path);
    const sig = s.path + '|' + s.title;
    if (sig === lastSig && reason !== 'init' && reason !== 'seed') return;
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
  // The desktop dock asks for a re-announce once its listener is up (it may
  // have missed 'init' while loading its history).
  on('nav-announce', () => announce('seed'));
  const init = () => { announce('init'); watchTitle(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
