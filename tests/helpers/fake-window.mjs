/* Minimal browser-ish sandbox for running the classic injected scripts under
 * node:test. Not a DOM implementation — just enough surface for bootstrap.js
 * and gm-shim.js, which only touch localStorage, location and document events. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function makeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    _map: map,
  };
}

export function makeWindow({ storage = {}, readyState = 'complete', env, invoke } = {}) {
  const listeners = {};
  const window = {
    localStorage: makeLocalStorage(storage),
    location: {
      href: 'https://arena.ai/?mode=direct',
      reload() {
        window.__reloads = (window.__reloads || 0) + 1;
      },
    },
    document: {
      readyState,
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      fire(type) {
        for (const fn of listeners[type] || []) fn({ type });
      },
    },
    console: { warn: () => {}, log: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    Date,
    Error,
    encodeURIComponent,
  };
  if (env) window.__ARENAKIT_ENV__ = env;
  if (invoke) window.__TAURI_INTERNALS__ = { invoke };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  return window;
}

/** Objects created inside the vm realm have a foreign Object.prototype, which
 * trips assert.deepStrictEqual — normalise through JSON first. */
export const plain = (value) => JSON.parse(JSON.stringify(value));

export function runScript(window, path) {
  const ctx = vm.createContext(window);
  const src = readFileSync(new URL(path, import.meta.url), 'utf8');
  new vm.Script(src, { filename: path }).runInContext(ctx);
  return ctx;
}
