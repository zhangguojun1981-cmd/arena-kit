/* ArenaKit injected/gm-shim.js
 * Shims the Tampermonkey GM_* API used by ported userscripts (manager.js, eni.js)
 * and a tiny `chrome.*` compatibility object (window.__AK_CHROME__) used by the
 * ported extension script (plus.js) on top of localStorage +
 * the ArenaKit Tauri bridge. Runs at document_start, before any ported script.
 * No-op-safe outside Tauri (falls back to fetch).
 *
 * `chrome` itself is deliberately NOT defined on window: arena.ai could sniff it
 * and it would make the page believe it runs inside a Chrome extension. The Rust
 * side passes __AK_CHROME__ to the scripts that need it as a local `chrome`.
 */
(() => {
  if (window.GM_getValue) return; // already shimmed

  const GM_PREFIX = 'ak_gm_';
  const CHROME_PREFIX = 'ak_chrome_';

  // ── safe localStorage wrappers ──────────────────────────────────────────
  const lsGet = (key) => {
    try { return window.localStorage.getItem(key); } catch { return null; }
  };
  const lsSet = (key, val) => {
    try { window.localStorage.setItem(key, val); } catch { /* quota / disabled */ }
  };
  const lsRemove = (key) => {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  };

  // ── GM_* ────────────────────────────────────────────────────────────────
  // Values are stored as-is (callers pass strings; they JSON-encode objects).
  window.GM_getValue = (key, def) => {
    const v = lsGet(GM_PREFIX + key);
    return v === null ? def : v;
  };
  window.GM_setValue = (key, val) => lsSet(GM_PREFIX + key, val);
  window.GM_deleteValue = (key) => lsRemove(GM_PREFIX + key);

  window.GM_addStyle = (css) => {
    const el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    return el;
  };

  // No Tampermonkey menu in a WebView — keep a registry a settings panel can render.
  window.__AK_MENU__ = window.__AK_MENU__ || [];
  window.GM_registerMenuCommand = (name, fn) => {
    window.__AK_MENU__.push({ name, fn });
    return window.__AK_MENU__.length - 1;
  };

  // GM_xmlhttpRequest: header-less GETs go through the native proxy when the
  // Tauri bridge is present (bypasses page CORS); everything else uses fetch.
  // Requests with custom headers (e.g. `Authorization` for GitHub gists) MUST
  // NOT use the proxy: it cannot forward headers and would silently drop them.
  window.GM_xmlhttpRequest = (opts) => {
    const method = (opts.method || 'GET').toUpperCase();
    const hasHeaders = !!opts.headers && Object.keys(opts.headers).length > 0;

    const finish = (status, text, response) => {
      const res = { status, statusText: String(status), responseText: text, response: response ?? text, readyState: 4 };
      const ok = status >= 200 && status < 300;
      const cb = ok ? opts.onload : (opts.onerror || opts.onload);
      if (cb) cb(res);
    };
    const fail = (e) => {
      if (opts.onerror) opts.onerror({ status: 0, error: String(e) });
      else if (opts.ontimeout) opts.ontimeout(e);
    };

    const proxyGet = window.__ARENAKIT__ && window.__ARENAKIT__.proxyGet;
    if (proxyGet && method === 'GET' && !hasHeaders && opts.responseType !== 'blob') {
      // Two-arg `then`: an exception thrown inside onload must not re-enter onerror.
      proxyGet(opts.url).then(
        (data) => finish(200, typeof data === 'string' ? data : JSON.stringify(data)),
        fail,
      );
      return;
    }

    const init = { method, headers: opts.headers || {} };
    if (opts.data) init.body = opts.data;
    fetch(opts.url, init).then(
      async (r) => {
        if (opts.responseType === 'blob') finish(r.status, '', await r.blob());
        else finish(r.status, await r.text());
      },
      fail,
    );
  };

  // ── chrome.* compatibility (only what plus.js touches) ────
  // storage.{sync,local}.get(keys[, cb]) / .set(obj[, cb]) — Promise- and
  // callback-style, backed by localStorage as JSON.
  const makeArea = (area) => {
    const key = (k) => `${CHROME_PREFIX}${area}_${k}`;
    return {
      get(keys, cb) {
        const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
        const out = {};
        for (const k of list) {
          const raw = lsGet(key(k));
          if (raw === null) continue;
          try { out[k] = JSON.parse(raw); } catch { /* corrupt entry: treat as absent */ }
        }
        if (typeof cb === 'function') cb(out);
        return Promise.resolve(out);
      },
      set(items, cb) {
        for (const [k, v] of Object.entries(items || {})) lsSet(key(k), JSON.stringify(v));
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      },
    };
  };

  // Icons the extension shipped as files; inline them so no asset pipeline is needed.
  const svgIcon = (body) =>
    'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ` +
      `stroke="#8b8b95" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
  const ICONS = {
    'icons/text.svg': svgIcon('<path d="M5 6h14M12 6v13"/>'),
    'icons/image.svg': svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-9 9"/>'),
    'icons/audio.svg': svgIcon('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>'),
    'icons/video.svg': svgIcon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>'),
    'icons/arenaaiplus-icon.svg': svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  };

  window.__AK_CHROME__ = {
    storage: { sync: makeArea('sync'), local: makeArea('local') },
    runtime: {
      getURL: (path) => ICONS[path] || '',
      onMessage: { addListener() {} }, // no popup/background page in ArenaKit
    },
  };
})();
