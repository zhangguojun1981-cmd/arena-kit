/* ArenaKit injected/gm-shim.js
 * Shims the Tampermonkey GM_* API used by ported userscripts (manager.js, eni.js)
 * on top of localStorage + the ArenaKit Tauri bridge. Runs at document_start,
 * before any ported script. No-op-safe outside Tauri (falls back to fetch).
 */
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
