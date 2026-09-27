/* ArenaKit injected/gm-shim.js
 * Shims the Tampermonkey GM_* API used by ported userscripts (manager.js, eni.js)
 * and the minimal chrome.storage / chrome.runtime surface used by ported
 * extension content scripts (unlock.js, plus.js, leaderboard.js) on top of
 * localStorage + the ArenaKit Tauri bridge. Runs at document_start, before any
 * ported script. No-op-safe outside Tauri (falls back to fetch).
 */

// ── chrome.* shim (extension content-script API → localStorage) ─────────
(() => {
  const chrome = (window.chrome = window.chrome || {});
  if (chrome.storage && chrome.storage.sync && chrome.runtime && chrome.runtime.getURL) return;

  const listeners = [];
  const areaListeners = { sync: [], local: [] };

  const makeArea = (name) => {
    const KEY = 'ak_chrome_' + name;
    const readAll = () => {
      try { return JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
    };
    const writeAll = (obj) => {
      try { window.localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
    };
    const notify = (changes) => {
      if (!Object.keys(changes).length) return;
      for (const fn of areaListeners[name].concat(listeners)) {
        try { fn(changes, name); } catch (e) { console.warn('[ArenaKit] chrome.storage listener', e); }
      }
    };
    const done = (cb, value) => {
      if (typeof cb === 'function') { try { cb(value); } catch (e) { console.warn('[ArenaKit] chrome.storage cb', e); } }
      return Promise.resolve(value);
    };
    return {
      get(keys, cb) {
        if (typeof keys === 'function') { cb = keys; keys = null; }
        const all = readAll();
        let out = {};
        if (keys === null || keys === undefined) out = all;
        else if (typeof keys === 'string') { if (keys in all) out[keys] = all[keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in all) out[k] = all[k]; }
        else if (typeof keys === 'object') { out = { ...keys }; for (const k of Object.keys(keys)) if (k in all) out[k] = all[k]; }
        return done(cb, out);
      },
      set(items, cb) {
        const all = readAll();
        const changes = {};
        for (const k of Object.keys(items || {})) {
          changes[k] = { oldValue: all[k], newValue: items[k] };
          all[k] = items[k];
        }
        writeAll(all);
        notify(changes);
        return done(cb);
      },
      remove(keys, cb) {
        const all = readAll();
        const changes = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (k in all) { changes[k] = { oldValue: all[k] }; delete all[k]; }
        }
        writeAll(all);
        notify(changes);
        return done(cb);
      },
      clear(cb) {
        const all = readAll();
        const changes = {};
        for (const k of Object.keys(all)) changes[k] = { oldValue: all[k] };
        writeAll({});
        notify(changes);
        return done(cb);
      },
      onChanged: {
        addListener(fn) { areaListeners[name].push(fn); },
        removeListener(fn) { const i = areaListeners[name].indexOf(fn); if (i >= 0) areaListeners[name].splice(i, 1); },
      },
    };
  };

  chrome.storage = chrome.storage || {};
  chrome.storage.sync = chrome.storage.sync || makeArea('sync');
  chrome.storage.local = chrome.storage.local || makeArea('local');
  chrome.storage.onChanged = chrome.storage.onChanged || {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
  };

  // Extension assets do not exist in a WebView: hand back a transparent SVG so
  // <img src> never 404s. Ported scripts only use these for decorative icons.
  const BLANK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const noop = () => {};
  chrome.runtime = chrome.runtime || {};
  chrome.runtime.id = chrome.runtime.id || 'arenakit';
  chrome.runtime.getURL = chrome.runtime.getURL || (() => BLANK);
  chrome.runtime.sendMessage = chrome.runtime.sendMessage || ((...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) { try { cb(undefined); } catch {} }
    return Promise.resolve(undefined);
  });
  chrome.runtime.onMessage = chrome.runtime.onMessage || { addListener: noop, removeListener: noop, hasListener: () => false };
  chrome.runtime.getManifest = chrome.runtime.getManifest || (() => ({ name: 'ArenaKit', version: (window.__ARENAKIT_ENV__ || {}).version || '0.0.0' }));
})();

// ── GM_* shim (Tampermonkey API → localStorage / proxy_get) ─────────────
(() => {
  if (window.GM_getValue) return; // already shimmed

  const store = {
    get(key) {
      try { return window.localStorage.getItem('ak_gm_' + key); } catch { return null; }
    },
    set(key, val) {
      try { window.localStorage.setItem('ak_gm_' + key, val); } catch {}
    },
  };

  window.GM_getValue = (key, def) => {
    const v = store.get(key);
    return v === null || v === undefined ? def : v;
  };
  window.GM_setValue = (key, val) => store.set(key, val);
  window.GM_deleteValue = (key) => { try { window.localStorage.removeItem('ak_gm_' + key); } catch {} };

  window.GM_addStyle = (css) => {
    const el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    return el;
  };

  // GM_registerMenuCommand: no Tampermonkey menu in a WebView — expose on a
  // registry the ArenaKit settings panel can render later.
  window.__AK_MENU__ = window.__AK_MENU__ || [];
  window.GM_registerMenuCommand = (name, fn) => {
    window.__AK_MENU__.push({ name, fn });
    return window.__AK_MENU__.length - 1;
  };

  // GM_xmlhttpRequest: route cross-origin GETs through the native proxy when
  // the Tauri bridge is present (bypasses page CORS); otherwise plain fetch.
  window.GM_xmlhttpRequest = (opts) => {
    const method = (opts.method || 'GET').toUpperCase();
    const finish = (status, text, response) => {
      const res = { status, statusText: String(status), responseText: text, response: response ?? text, readyState: 4 };
      if (status >= 200 && status < 300) opts.onload && opts.onload(res);
      else (opts.onerror || opts.onload) && (opts.onerror || opts.onload)(res);
    };

    const bridge = window.__ARENAKIT__ && window.__ARENAKIT__.proxyGet;
    if (bridge && method === 'GET' && opts.responseType !== 'blob') {
      bridge(opts.url)
        .then((data) => finish(200, typeof data === 'string' ? data : JSON.stringify(data)))
        .catch((e) => (opts.onerror ? opts.onerror({ status: 0, error: String(e) }) : null));
      return;
    }

    // Fallback: page fetch (works for same-origin / CORS-permitted; logos may
    // fail under CORS until proxy_get is wired in M2 — scripts degrade gracefully).
    const init = { method, headers: opts.headers || {} };
    if (opts.data) init.body = opts.data;
    fetch(opts.url, init)
      .then(async (r) => {
        if (opts.responseType === 'blob') {
          const blob = await r.blob();
          finish(r.status, '', blob);
        } else {
          finish(r.status, await r.text());
        }
      })
      .catch((e) => (opts.onerror ? opts.onerror({ status: 0, error: String(e) }) : (opts.ontimeout && opts.ontimeout(e))));
  };
})();
