import vm from 'node:vm';
import { read, plain } from './helpers.mjs';

/* Shared fixture for the 账号 tests: Supabase session cookies the way
 * @supabase/ssr chunks them, and a tiny DOM with a real-ish document.cookie
 * jar (Max-Age=0 + Domain honoured) that runs the real injected/account.js
 * (+ totp.gen.js) inside a vm context. Used by tests/account.test.mjs
 * (unit) and tests/account-flow.test.mjs (end-to-end switch / add / login). */

export const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const jwt = (payload) => 'eyJhbGciOiJIUzI1NiJ9.' + b64url(payload) + '.sig';

export function supabaseSession({ email = 'alice@example.com', id = 'user-aaaa', name = 'Alice', provider = 'google', exp = 1_800_000_000, refresh = 'rt-1' } = {}) {
  return {
    access_token: jwt({ sub: id, email, exp, app_metadata: { provider } }),
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh,
    user: { id, email, app_metadata: { provider }, user_metadata: { full_name: name, avatar_url: 'https://img/' + id, email } },
  };
}
/* The site's guest state: a Supabase anonymous user (is_anonymous claim, no
 * email, empty app_metadata) — same cookie names as a real login. */
export function anonymousSession({ id = 'anon-0001', exp = 1_800_000_000, refresh = 'rt-anon' } = {}) {
  return {
    access_token: jwt({ sub: id, exp, role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {} }),
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh,
    user: { id, aud: 'authenticated', role: 'authenticated', email: '', app_metadata: {}, user_metadata: {}, identities: [], is_anonymous: true },
  };
}
/* Chunk like @supabase/ssr: `base64-` + base64url(json) split every N chars into name.0 / name.1 … */
export function chunked(name, session, size = 120) {
  const value = 'base64-' + b64url(session);
  const parts = [];
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
  return parts.map((v, i) => ({ name: `${name}.${i}`, value: v }));
}

/* ── tiny DOM with a real-ish cookie jar and a selector matcher ────────── */
function parseSel(sel) {
  // compound selector: tag? (#id)? ([attr(op value)( i)?])*
  const out = { tag: null, id: null, attrs: [] };
  let rest = sel.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) { out.tag = tag[0].toLowerCase(); rest = rest.slice(tag[0].length); }
  const id = /^#([\w-]+)/.exec(rest);
  if (id) { out.id = id[1]; rest = rest.slice(id[0].length); }
  const attrRe = /^\[([\w-]+)(?:([*^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?(\s+i)?\]/;
  let m;
  while ((m = attrRe.exec(rest))) {
    out.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? null, ci: !!m[6] });
    rest = rest.slice(m[0].length);
  }
  if (rest.trim()) throw new Error('fake DOM: unsupported selector part "' + rest + '" in ' + sel);
  return out;
}
function matches(el, sel) {
  return sel.split(',').some((one) => {
    const s = parseSel(one);
    if (s.tag && el.tag !== s.tag) return false;
    if (s.id && el.attrs.id !== s.id) return false;
    return s.attrs.every((a) => {
      if (!(a.name in el.attrs)) return false;
      if (!a.op) return true;
      let have = String(el.attrs[a.name]), want = String(a.value);
      if (a.ci) { have = have.toLowerCase(); want = want.toLowerCase(); }
      if (a.op === '=') return have === want;
      if (a.op === '*=') return have.includes(want);
      if (a.op === '^=') return have.startsWith(want);
      if (a.op === '$=') return have.endsWith(want);
      return false;
    });
  });
}

/* Map-backed Web Storage (length / key(i) included: account.js scans for
 * stale `sb-*-auth-token` copies). Pass a Map to share it across page loads
 * the way sessionStorage survives same-tab navigations. */
export function webStorage(m = new Map()) {
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    map: m,
  };
}

export function fakeDom({ hostname = 'arena.ai', pathname = '/', jar = [], session = new Map(), local = new Map() } = {}) {
  const cookies = new Map(); // key domain|name → { name, value, domain }
  const key = (domain, name) => (domain || '') + '|' + name;
  for (const c of jar) cookies.set(key(c.domain || '', c.name), { name: c.name, value: c.value, domain: c.domain || '' });
  const events = []; // bridge sends
  const invokes = [];
  const timers = { intervals: [], timeouts: [] };
  const elements = [];
  const navigations = []; // location.replace / assign / reload calls (restore / clear with `navigate`)
  const location = {
    hostname, pathname, href: 'https://' + hostname + pathname, origin: 'https://' + hostname,
    replace(url) { navigations.push({ how: 'replace', url }); },
    assign(url) { navigations.push({ how: 'assign', url }); },
    reload() { navigations.push({ how: 'reload', url: this.href }); },
  };
  const sessionStorage = webStorage(session);
  const localStorage = webStorage(local);

  const docListeners = {}; // type → [fn] (capture listeners account.js installs)
  const overlay = []; // nodes appended to <html> (the sign-in rescue bar)
  const node = (tag) => {
    const n = {
      tag, attrs: {}, children: [], textContent: '', listeners: {}, removed: false,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      remove() { this.removed = true; const i = overlay.indexOf(this); if (i >= 0) overlay.splice(i, 1); },
    };
    return n;
  };
  const doc = {
    readyState: 'complete',
    documentElement: { tag: 'html', attrs: {}, appendChild(c) { overlay.push(c); return c; } },
    querySelectorAll: (sel) => elements.filter((e) => e.connected && matches(e, sel)),
    querySelector: (sel) => elements.find((e) => e.connected && matches(e, sel)) || null,
    getElementById: (id) => overlay.find((n) => n.id === id) || null,
    createElement: (tag) => node(tag),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };
  /* A real (trusted) user event reaching the document capture listeners. */
  const userEvent = (type, init = {}) => { for (const fn of docListeners[type] || []) fn({ type, isTrusted: true, ...init }); };
  Object.defineProperty(doc, 'cookie', {
    configurable: true, // like Document.prototype.cookie: account.js may shadow it when the page is leaving
    get() { return [...cookies.values()].map((c) => c.name + '=' + c.value).join('; '); },
    set(str) {
      const [pair, ...attrParts] = String(str).split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      const attrs = {};
      for (const p of attrParts) { const [k, v] = p.split('='); attrs[k.trim().toLowerCase()] = (v || '').trim(); }
      let domain = attrs.domain ? attrs.domain.replace(/^\./, '') : '';
      if (domain && !(hostname === domain || hostname.endsWith('.' + domain))) return; // rejected by the browser
      if (domain) domain = '.' + domain;
      if (attrs['max-age'] === '0') { cookies.delete(key(domain, name)); return; }
      cookies.set(key(domain, name), { name, value, domain });
    },
  });

  /* `parent`: nest the element (Google wraps its Next buttons:
   * `<div id="identifierNext"><div><button>Next</button></div></div>`);
   * nested elements are reachable through parent.querySelector(). */
  const mk = (tag, attrs = {}, text = '', { parent = null } = {}) => {
    const el = {
      tag: tag.toLowerCase(), attrs: { ...attrs }, textContent: text, value: attrs.value || '', connected: true, clicks: 0, dispatched: [], children: [],
      get tagName() { return this.tag.toUpperCase(); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      getClientRects() { return this.attrs.hidden ? [] : [{}]; },
      click() { this.clicks++; if (typeof this.onclick === 'function') this.onclick(); },
      focus() {}, dispatchEvent(ev) { this.dispatched.push(ev.type); return true; },
      closest() { return null; }, get isConnected() { return this.connected; },
      querySelector(sel) { const all = (n) => n.children.flatMap((c) => [c, ...all(c)]); return all(this).find((e) => e.connected && matches(e, sel)) || null; },
      form: null,
    };
    if (parent) { parent.children.push(el); parent.textContent = (parent.textContent || '') + text; }
    elements.push(el);
    return el;
  };
  const clearElements = () => { for (const e of elements) e.connected = false; };

  const quiet = { debug() {}, log() {}, warn() {}, error() {} };
  const sandbox = {
    document: doc, location, console: quiet,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), TextDecoder,
    Uint8Array, Uint32Array, DataView, JSON, Math, Date, Object, Array, String, Number, Error, Map, Set, Promise, RegExp, URL,
    localStorage,
    sessionStorage,
    setTimeout: (fn, ms) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    clearInterval: (id) => { if (timers.intervals[id - 1]) timers.intervals[id - 1].fn = null; },
    Event: class { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} },
    addEventListener() {},
    __ARENAKIT__: {
      send: (name, payload) => { events.push({ name, payload: plain(payload) }); return Promise.resolve(); },
      invoke: (cmd, args) => { invokes.push({ cmd, args }); return Promise.resolve(null); },
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('injected/totp.gen.js'), sandbox, { filename: 'totp.gen.js' });
  vm.runInContext(read('injected/account.js'), sandbox, { filename: 'account.js' });
  const flushTimeouts = () => { const list = timers.timeouts.splice(0); for (const t of list) t.fn(); };
  const tickIntervals = () => { for (const t of timers.intervals) if (t.fn) t.fn(); };
  const lastEvent = (name) => [...events].reverse().find((e) => e.name === name) || null;
  return { sandbox, doc, cookies, events, invokes, mk, clearElements, flushTimeouts, tickIntervals, lastEvent, location, navigations, sessionStorage, localStorage, userEvent, overlay, api: sandbox.ArenaAccount };
}

export const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

