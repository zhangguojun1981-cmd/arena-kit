/* Thin access to the Tauri runtime from the dock webview.
 * The dock is served from the bundled frontend (no bundler), so it uses the
 * global injected by `app.withGlobalTauri` instead of @tauri-apps/api imports. */
export function getTauri() {
  const t = globalThis.__TAURI__;
  if (!t || !t.core || typeof t.core.invoke !== 'function' || !t.event || typeof t.event.listen !== 'function') return null;
  return { invoke: t.core.invoke, listen: t.event.listen };
}

/* JSON store backed by Rust (store_get / store_set / store_keys). Falls back to
 * localStorage in browser preview mode so the dock UI can still be exercised. */
export function createStore(tauri) {
  if (tauri) {
    // Embedded (Android) dock only: src-tauri hands it a per-launch token as the
    // `__AK_GUARD__` argument of its init-script closure. Credential keys
    // (`accounts`, `secret.*`) are refused without it; the desktop dock is
    // recognised by its webview label instead and has no token.
    const guard = typeof __AK_GUARD__ === 'string' ? __AK_GUARD__ : '';
    const withGuard = (args) => (guard ? { ...args, guardToken: guard } : args);
    return {
      get: (key) => tauri.invoke('store_get', withGuard({ key })),
      set: (key, value) => tauri.invoke('store_set', withGuard({ key, value: value === undefined ? null : value })),
      keys: (prefix) => tauri.invoke('store_keys', withGuard({ prefix: prefix || '' })),
    };
  }
  const ls = globalThis.localStorage;
  return {
    async get(key) { try { const v = ls.getItem('ak.' + key); return v === null ? null : JSON.parse(v); } catch { return null; } },
    async set(key, value) { if (value === null || value === undefined) ls.removeItem('ak.' + key); else ls.setItem('ak.' + key, JSON.stringify(value)); },
    async keys(prefix) { const out = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k.startsWith('ak.' + (prefix || ''))) out.push(k.slice(3)); } return out.sort(); },
  };
}

/* JS string literal safe to embed in evaluated code. */
export function jsString(value) {
  return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/<\/script/gi, '<\\/script');
}
