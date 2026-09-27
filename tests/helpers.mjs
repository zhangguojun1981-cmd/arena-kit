import fs from 'node:fs';
import vm from 'node:vm';

export const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/* Run an injected (IIFE) page script inside a sandbox and return the sandbox. */
export function runInjected(rel, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(read(rel), sandbox, { filename: rel });
  return sandbox;
}

/* Minimal window/document/location stand-in with a recording invoke(). */
export function fakePage({ pathname = '/agent', title = 'Arena' } = {}) {
  const calls = [];
  const listeners = {};
  const location = { pathname, href: 'https://arena.ai' + pathname, origin: 'https://arena.ai' };
  const history = {
    pushState(_s, _t, url) { location.pathname = new URL(url, location.href).pathname; },
    replaceState(_s, _t, url) { location.pathname = new URL(url, location.href).pathname; },
  };
  const document = {
    readyState: 'complete',
    title,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const window = {
    location, history, document,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    __TAURI_INTERNALS__: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(null); } },
    setTimeout: (fn) => { fn(); return 0; },
    console: { warn() {}, log() {}, error() {} },
    URL,
  };
  window.window = window;
  window.globalThis = window;
  return { sandbox: window, calls, listeners, location, history, document };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

/* Objects created inside a vm context have a foreign prototype; normalise
 * before deep-equal assertions. */
export const plain = (o) => JSON.parse(JSON.stringify(o));
