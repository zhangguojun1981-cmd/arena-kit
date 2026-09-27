/* ArenaKit injected/bootstrap.js
 * First script in the init bundle (MAIN world, document_start, every
 * navigation). Defines window.__ARENAKIT__ — the only surface the native dock
 * talks to (via the `arena_command` eval) and the only surface the ported
 * userscripts use to reach Rust (fetch_trace / proxy_get / page_event).
 *
 * Also owns the module switches (localStorage `ak_modules`) that the Rust init
 * script consults through `__ARENAKIT__.moduleOn(name)` before running each
 * ported script. Keep this file dependency-free and tolerant of running in a
 * plain browser (userscript / preview) where no Tauri runtime exists.
 */
(function () {
  if (window.__ARENAKIT__ && window.__ARENAKIT__.__v === 2) return;

  var env = window.__ARENAKIT_ENV__ || {};
  var MODULES_KEY = 'ak_modules';
  var UNLOCK_KEY = '_at';                          // unlock.js settings {e,o,h}
  var SYNC_KEY = 'ak_chrome_sync';                 // chrome.storage.sync shim store
  var ENI_PROMPT_KEY = 'ak_gm_arena_eni_system_prompt_v1'; // GM store key used by eni.js
  var HUD_KEY = 'ak_hud';

  // Ported-script switches. The HUD is not gated here: hud.js always loads and
  // its visibility is a separate flag (`ak_hud`, default on for mobile only).
  var DEFAULTS = {
    manager: true,
    unlock: true,
    plus: true,
    leaderboard: true,
    eni: false,
  };
  var HUD_DEFAULT = !!env.mobile;

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
  function readStr(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStr(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function modules() {
    var saved = readJSON(MODULES_KEY, {});
    var out = {};
    for (var k in DEFAULTS) out[k] = k in saved ? saved[k] !== false : DEFAULTS[k];
    return out;
  }
  function moduleOn(name) {
    var m = modules();
    return name in m ? m[name] : true; // unknown modules (snoop) always run
  }

  // ── IPC ─────────────────────────────────────────────────────────────
  function rawInvoke() {
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke;
    }
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return window.__TAURI__.core.invoke;
    }
    return null;
  }
  function invoke(cmd, args) {
    var fn = rawInvoke();
    if (!fn) return Promise.reject(new Error('no tauri runtime'));
    try {
      return Promise.resolve(fn(cmd, args || {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var hasRuntime = function () { return !!rawInvoke(); };

  // ── state reported to the dock ──────────────────────────────────────
  function unlockState() {
    var u = readJSON(UNLOCK_KEY, {});
    return { opus: u.o !== false, hidden: u.h === true };
  }
  function eniState() {
    var text = readStr(ENI_PROMPT_KEY) || '';
    return { on: moduleOn('eni'), text: text };
  }
  function hudState() {
    var s = readStr(HUD_KEY);
    return s === null ? HUD_DEFAULT : s === '1';
  }
  function snapshot() {
    return {
      modules: modules(),
      unlock: unlockState(),
      eni: eniState(),
      hud: hudState(),
      url: location.href,
      version: env.version || null,
    };
  }
  function reportState() {
    if (!hasRuntime()) return Promise.resolve(false);
    return invoke('page_event', { kind: 'state', payload: snapshot() })
      .then(function () { return true; })
      .catch(function (e) { console.warn('[ArenaKit] reportState', e); return false; });
  }

  function reload() {
    try { location.reload(); } catch (e) { /* ignore */ }
  }

  // ── mutations invoked by the dock ───────────────────────────────────
  function setModule(name, on) {
    var saved = readJSON(MODULES_KEY, {});
    saved[name] = !!on;
    writeJSON(MODULES_KEY, saved);
    reportState();
    // Ported scripts cannot be un-run in place; a reload applies the change.
    reload();
  }

  function setUnlock(key, on) {
    var map = { opus: 'o', hidden: 'h' };
    var field = map[key];
    if (!field) return;
    var cur = readJSON(UNLOCK_KEY, { e: true, o: true, h: false });
    cur[field] = !!on;
    cur.e = true;
    writeJSON(UNLOCK_KEY, cur);
    // keep the chrome.storage.sync shim in step so unlock.js's boot does not
    // overwrite `_at` with stale values on the next load.
    var sync = readJSON(SYNC_KEY, {});
    sync.o = cur.o; sync.h = cur.h; sync.e = true;
    writeJSON(SYNC_KEY, sync);
    reportState();
    reload();
  }

  function setEni(on, text) {
    var t = typeof text === 'string' ? text : '';
    writeStr(ENI_PROMPT_KEY, t);
    var saved = readJSON(MODULES_KEY, {});
    var was = saved.eni === true;
    saved.eni = !!on;
    writeJSON(MODULES_KEY, saved);
    // eni.js reads window.__arenaENIPrompt on each intercepted request; an
    // empty string disables injection without a reload.
    var loaded = typeof window.__arenaENIPrompt !== 'undefined';
    if (loaded) {
      window.__arenaENIPrompt = on ? t : '';
    }
    reportState();
    if (on && !loaded) reload();
    if (!on && was && !loaded) { /* nothing running — no reload needed */ }
  }

  function setHud(on) {
    writeStr(HUD_KEY, on ? '1' : '0');
    if (window.__AK_HUD__) window.__AK_HUD__.setVisible(!!on);
    reportState();
  }

  function toggleManager() {
    if (typeof window.__AK_MANAGER_TOGGLE__ === 'function') {
      window.__AK_MANAGER_TOGGLE__();
      return true;
    }
    return false;
  }

  window.__ARENAKIT__ = {
    __v: 2,
    env: env,
    invoke: invoke,
    hasRuntime: hasRuntime,
    // used by snoop.js / gm-shim.js
    onToken: function (payload) {
      return invoke('fetch_trace', { token: payload.token, sessionId: payload.sessionId })
        .catch(function (e) { console.warn('[ArenaKit] fetch_trace', e); });
    },
    proxyGet: function (url) { return invoke('proxy_get', { url: url }); },
    log: function (message) {
      return invoke('page_event', { kind: 'log', payload: { message: String(message) } }).catch(function () {});
    },
    // module gating used by the Rust init script wrapper
    moduleOn: moduleOn,
    modules: modules,
    // dock-facing API (called through arena_command eval)
    snapshot: snapshot,
    reportState: reportState,
    setModule: setModule,
    setUnlock: setUnlock,
    setEni: setEni,
    setHud: setHud,
    toggleManager: toggleManager,
  };

  // The dock may have started before this page finished loading: announce.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { reportState(); });
  } else {
    reportState();
  }
})();
