/* ArenaKit injected/account.js — 多账号：会话快照 / 一键切换 / 失效后一键重新登录。
 * MAIN world, document_start, runs on every page of the arena webview
 * (arena.ai AND the sign-in hosts that links.js keeps in place, e.g.
 * accounts.google.com).
 *
 * How arena.ai sessions work (facts, see docs/arena-google-login-flow.md):
 *   • Supabase SSR keeps the session in JS-readable cookies named
 *     `arena-auth-prod-v1` — chunked as `arena-auth-prod-v1.0`, `.1`, … when
 *     long. The value is `base64-` + base64url(JSON {access_token,
 *     refresh_token, expires_at, user:{id,email,user_metadata…}}).
 *   • Swapping that cookie set + reload == switching account. Tokens rotate
 *     (refresh_token is single-use), so the ACTIVE account's snapshot must be
 *     kept fresh: the watcher below reports every cookie change to the dock
 *     (`account` page event) and the dock persists it.
 *   • A logged-out visitor is NOT cookie-less: the site signs visitors in
 *     anonymously (`is_anonymous: true`, no email) — never an account record.
 *   • Accounts are logged in BY HAND the first time; afterwards `restore`
 *     switches by cookies, and a dead session is re-logged in through the
 *     manual Google round trip, automated (re-login section below). The old
 *     credentials helper (email / password / TOTP / SMS) is gone (0.4.9).
 *
 * Dock → page:  window.ArenaAccount.call(action, argsJson, reqId)
 *               actions: snapshot · restore{cookies,scope,expectSig,navigate}
 *               · clear{navigate} · login{creds:{accountId,email,startedAt}} · stop · status
 * Page → dock:  __ARENAKIT__.send('account-result', {reqId, ok, data|error})
 *               __ARENAKIT__.send('account', snapshot)   (watcher, on change)
 *               __ARENAKIT__.send('login', {stage, …})   (re-login progress)
 * Rust → page:  window.__AK_LOGIN_APPLY__({accountId,email,startedAt}) on every
 *               page load while a re-login is pending (lib.rs login_set). */
(() => {
  'use strict';
  const W = globalThis;
  const D = W.document;
  const L = W.location || {};
  const MAX_AGE = 400 * 24 * 3600; // @supabase/ssr default cookie lifetime
  const SCOPE_KEY = 'ak_account_cookie_scope';
  const EXPECT_KEY = 'arenakit.account.expect'; // sessionStorage: the session the NEXT document must start with
  const EXPECT_TTL_MS = 30_000;
  const WATCH_MS = 4000;
  const LOGIN_TTL_MS = 3 * 60 * 1000; // one re-login round trip

  const hostOf = () => String(L.hostname || '').toLowerCase();
  const isArenaHost = (h) => /(^|\.)(arena\.ai|lmarena\.ai)$/.test(h || '');
  const isGoogleHost = (h) => /(^|\.)accounts\.google\.com$/.test(h || '');
  const now = () => Date.now();
  const later = (fn, ms) => setTimeout(fn, ms);

  const send = (name, payload) => {
    try {
      const b = W.__ARENAKIT__;
      if (b && typeof b.send === 'function') b.send(name, payload);
    } catch (_) { /* no bridge / IPC denied on foreign hosts */ }
  };

  // ── cookie jar (document.cookie) ─────────────────────────────────────
  function parseCookieHeader(str) {
    const out = [];
    for (const part of String(str || '').split(';')) {
      const s = part.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      if (i <= 0) continue;
      out.push({ name: s.slice(0, i).trim(), value: s.slice(i + 1) });
    }
    return out;
  }
  // Session cookies only. `arena-auth-prod-v1-code-verifier` (PKCE verifier
  // of an OAuth round trip in flight) is NOT part of a session: saving it
  // with an account and writing an old one back on switch broke the next
  // Google sign-in (callback → __arena_auth_error no_user_data).
  const isVerifierName = (n) => /code-verifier/i.test(n);
  const isAuthName = (n) => (/^arena-auth/i.test(n) || /^sb-[\w-]+-auth-token/i.test(n)) && !isVerifierName(n);
  const AUTH_ERROR_COOKIE = '__arena_auth_error';
  const validValue = (v) => typeof v === 'string' && v.length <= 8192 && !/[;\r\n\u0000-\u001f\u007f]/.test(v);
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  function readAll() { try { return parseCookieHeader(D.cookie); } catch (_) { return []; } }
  const authCookies = () => readAll().filter((c) => isAuthName(c.name)).sort(byName);
  function baseDomain() {
    const parts = hostOf().split('.').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostOf();
  }
  const attrs = (scope) => `; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax` + (scope === 'domain' ? `; Domain=.${baseDomain()}` : '');
  function writeCookie(name, value, scope) { D.cookie = `${name}=${value}${attrs(scope)}`; }
  function expireCookie(name) {
    for (const dom of ['', `; Domain=.${baseDomain()}`, `; Domain=${baseDomain()}`]) {
      D.cookie = `${name}=; Max-Age=0; Path=/; Secure${dom}`;
      D.cookie = `${name}=; Max-Age=0; Path=/${dom}`;
    }
  }
  /* Expire every auth cookie the page can see, plus the chunk siblings of
   * every base name involved (`name`, `name.0` … `name.N+2`) — a leftover
   * chunk from a longer session would otherwise be glued onto the restored
   * one and break the site's JSON parse. */
  function clearAuth(extra) {
    const names = new Set(authCookies().map((c) => c.name));
    const bases = new Map();
    for (const n of [...names, ...((extra || []).map((c) => c.name))]) {
      const m = /^(.*?)(?:\.(\d+))?$/.exec(n);
      const idx = m[2] == null ? 0 : Number(m[2]);
      bases.set(m[1], Math.max(bases.get(m[1]) || 0, idx));
    }
    for (const [base, max] of bases) {
      names.add(base);
      for (let i = 0; i <= max + 2; i++) names.add(base + '.' + i);
    }
    const present = authCookies().length;
    for (const n of names) expireCookie(n);
    return present;
  }

  /* Web-storage copies of a session (classic supabase-js keeps
   * `sb-<ref>-auth-token` in localStorage; the site may cache under the
   * cookie name too). Swapping the cookies while such a copy survives lets
   * the site's client resurrect the old account — and burn the new one's
   * refresh token doing so. Harmless when nothing matches. */
  const isAuthStorageKey = (k) => /^sb-[\w-]+-auth-token/i.test(k) || /^arena-auth/i.test(k) || /supabase\.auth\.token/i.test(k);
  function clearWebStorageSessions() {
    let n = 0;
    for (const store of [W.localStorage, W.sessionStorage]) {
      try {
        const keys = [];
        for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && isAuthStorageKey(k)) keys.push(k); }
        for (const k of keys) { store.removeItem(k); n++; }
      } catch (_) { /* storage blocked */ }
    }
    return n;
  }
  /* This document is leaving (restore / clear with `navigate`): from now on
   * the site's own auth client must not write auth cookies any more — a
   * token refresh answered in the few hundred ms before the next document
   * commits used to overwrite the freshly restored session. */
  let frozen = false;
  function freezeAuthWrites() {
    if (frozen) return true;
    frozen = true;
    try {
      const own = Object.getOwnPropertyDescriptor(D, 'cookie');
      const proto = W.Document && W.Document.prototype ? Object.getOwnPropertyDescriptor(W.Document.prototype, 'cookie') : null;
      const desc = (own && own.set && own.get) ? own : (proto && proto.set && proto.get ? proto : null);
      if (!desc) return false;
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        get() { return desc.get.call(D); },
        set(v) {
          const name = String(v).split(';')[0].split('=')[0].trim();
          if (isAuthName(name)) return; // dropped: the page is on its way out
          desc.set.call(D, v);
        },
      });
    } catch (_) { return false; }
    try {
      const cs = W.cookieStore;
      if (cs) {
        const guard = (orig) => function (a, b) { const name = typeof a === 'string' ? a : (a && a.name); if (isAuthName(String(name || ''))) return Promise.resolve(); return orig.apply(this, [a, b]); };
        if (typeof cs.set === 'function') cs.set = guard(cs.set);
        if (typeof cs.delete === 'function') cs.delete = guard(cs.delete);
      }
    } catch (_) { /* no Cookie Store API */ }
    return true;
  }

  // ── session decoding ─────────────────────────────────────────────────
  function b64urlDecode(s) {
    let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    while (t.length % 4) t += '=';
    const bin = W.atob(t);
    try {
      if (typeof W.TextDecoder === 'function') {
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new W.TextDecoder().decode(bytes);
      }
      return decodeURIComponent(Array.prototype.map.call(bin, (c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    } catch (_) { return bin; }
  }
  /* `name.0` + `name.1` … → one value per base name (chunk order preserved). */
  function groupChunks(cookies) {
    const groups = new Map();
    for (const c of cookies) {
      const m = /^(.*?)(?:\.(\d+))?$/.exec(c.name);
      const base = m[1];
      const idx = m[2] == null ? -1 : Number(m[2]);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ idx, value: c.value });
    }
    const out = [];
    for (const [base, parts] of groups) {
      parts.sort((a, b) => a.idx - b.idx);
      out.push({ base, value: parts.map((p) => p.value).join('') });
    }
    return out;
  }
  function decodeValue(v) {
    if (!v) return null;
    try {
      if (v.startsWith('base64-')) return JSON.parse(b64urlDecode(v.slice(7)));
      let s = v;
      try { s = decodeURIComponent(v); } catch (_) { /* raw */ }
      const j = JSON.parse(s);
      if (Array.isArray(j)) return { access_token: j[0], refresh_token: j[1] };
      return j;
    } catch (_) { return null; }
  }
  function jwtPayload(tok) {
    try { return JSON.parse(b64urlDecode(String(tok).split('.')[1])); } catch (_) { return null; }
  }
  function decodeSession(cookies) {
    for (const g of groupChunks(cookies)) {
      const s = decodeValue(g.value);
      if (s && typeof s === 'object' && (s.access_token || s.refresh_token || s.user)) return { base: g.base, session: s };
    }
    return null;
  }
  function identity(session) {
    if (!session || typeof session !== 'object') return null;
    const u = session.user || {};
    const md = u.user_metadata || {};
    const jwt = session.access_token ? jwtPayload(session.access_token) : null;
    const email = String(u.email || (jwt && jwt.email) || md.email || '').toLowerCase();
    const userId = String(u.id || (jwt && jwt.sub) || '');
    const name = String(md.full_name || md.name || md.user_name || md.preferred_username || '');
    const avatar = String(md.avatar_url || md.picture || '');
    const provider = String((u.app_metadata && u.app_metadata.provider) || (jwt && jwt.app_metadata && jwt.app_metadata.provider) || '');
    const expiresAt = (Number(session.expires_at) * 1000) || (jwt && Number(jwt.exp) * 1000) || 0;
    // Supabase anonymous sign-in (the site's guest state): is_anonymous claim,
    // no email. Treated as logged out everywhere.
    const anonymous = u.is_anonymous === true || !!(jwt && jwt.is_anonymous === true) || provider === 'anonymous';
    return { userId, email, name, avatar, provider, expiresAt, anonymous };
  }
  function sigOf(cookies) {
    const s = cookies.map((c) => c.name + '=' + c.value).join(';');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + s.length;
  }
  function scopeCache() { try { return W.localStorage.getItem(SCOPE_KEY) || ''; } catch (_) { return ''; } }
  function rememberScope(s) { try { W.localStorage.setItem(SCOPE_KEY, s); } catch (_) { /* blocked */ } }

  /* Failure note the OAuth callback leaves for 120 s (base64 JSON
   * {"message":"no_user_data"}); '' when absent. */
  function authErrorMessage() {
    const c = readAll().find((x) => x.name === AUTH_ERROR_COOKIE);
    if (!c || !c.value) return '';
    let v = c.value;
    try { v = decodeURIComponent(v); } catch (_) { /* raw */ }
    try {
      const j = JSON.parse(b64urlDecode(v.replace(/^base64-/, '')));
      return String((j && (j.message || j.error)) || 'unknown').slice(0, 200);
    } catch (_) { return v.slice(0, 200); }
  }
  /* The page's login state, the one distinction every login decision uses:
   *   logged-in  session cookie → a real user (not anonymous, has an email)
   *   guest      session cookie → the anonymous user arena creates for every
   *              visitor (arena-auth-prod-v1 exists while logged OUT)
   *   none       no session cookie (right after a clear, before the site made
   *              its guest session)
   *   broken     a session cookie that does not decode */
  function loginStateOf(cookies, id) {
    if (id && !id.anonymous && id.email) return 'logged-in';
    if (id) return 'guest';
    return cookies.length ? 'broken' : 'none';
  }

  function snapshot() {
    const cookies = authCookies();
    const dec = decodeSession(cookies);
    const id = dec ? identity(dec.session) : null;
    const state = loginStateOf(cookies, id);
    // Only a real identity (email, not anonymous) is a login worth saving.
    const loggedIn = state === 'logged-in';
    return Object.assign(
      { ok: true, host: hostOf(), state, loggedIn, anonymous: !!(id && id.anonymous), hasAuthCookie: cookies.length > 0, authError: authErrorMessage() },
      id || {},
      { cookies, sig: sigOf(cookies), scope: scopeCache(), at: now() }
    );
  }

  /* Leave the current page for `path` on this origin (site root by default)
   * in the same task as the cookie writes, so the site's own auth client
   * cannot write the old session back in between. The `arenakit.reloading`
   * stamp lets bridge.js draw the boot progress bar. */
  const navTarget = (v) => (typeof v === 'string' && /^\/(?!\/)\S*$/.test(v) ? v : '/');
  function navigateTo(path) {
    const origin = L.origin || ('https://' + hostOf());
    const url = origin + navTarget(path);
    try { W.sessionStorage.setItem('arenakit.reloading', String(now())); } catch (_) { /* storage blocked */ }
    try { if (typeof L.replace === 'function') { L.replace(url); return url; } } catch (_) { /* fall through */ }
    try { L.href = url; } catch (_) { /* ignore */ }
    return url;
  }

  /* Host-only vs Domain=.arena.ai: a restored cookie must use the SAME scope
   * the site uses, otherwise the site's next refresh creates a second cookie
   * with the same name and the stale one wins. Cookie Store API when present
   * (Android WebView); otherwise a one-off delete-probe that re-sets the
   * identical value at once. Cached in localStorage. */
  async function detectScope(cookies) {
    const cached = scopeCache();
    if (cached) return cached;
    const list = cookies || authCookies();
    if (!list.length) return '';
    const probe = list[0];
    const cs = W.cookieStore;
    if (cs && typeof cs.getAll === 'function') {
      try {
        const all = await cs.getAll({ name: probe.name });
        const hit = (all && all.find((c) => c.value === probe.value)) || (all && all[0]);
        if (hit) { const s = hit.domain ? 'domain' : 'host'; rememberScope(s); return s; }
      } catch (_) { /* fall through */ }
    }
    const read = () => { const c = readAll().find((x) => x.name === probe.name); return c ? c.value : null; };
    if (read() == null) return '';
    D.cookie = `${probe.name}=; Max-Age=0; Path=/; Secure`;
    if (read() == null) { writeCookie(probe.name, probe.value, 'host'); rememberScope('host'); return 'host'; }
    D.cookie = `${probe.name}=; Max-Age=0; Path=/; Secure; Domain=.${baseDomain()}`;
    if (read() == null) { writeCookie(probe.name, probe.value, 'domain'); rememberScope('domain'); return 'domain'; }
    return '';
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function actSnapshot() {
    const s = snapshot();
    if (s.hasAuthCookie && !s.scope) s.scope = await detectScope(s.cookies);
    return s;
  }
  /* restore{cookies, scope, expectSig, navigate}: swap the page's auth cookies
   * for `cookies`. `previous` is the page's session right before the swap (the
   * dock persists it for the account being left). When `expectSig` is given
   * and the page's cookies no longer match it, nothing is touched and
   * { stale: true, previous } comes back so the dock can save the newer
   * tokens first and retry. `navigate` (true | "/path") makes the page leave
   * for that path right after answering. */
  async function actRestore(args) {
    const list = Array.isArray(args && args.cookies)
      ? args.cookies.filter((c) => c && typeof c.name === 'string' && isAuthName(c.name) && validValue(c.value))
      : [];
    if (!list.length) throw new Error('没有可恢复的登录 Cookie');
    const previous = snapshot();
    if (args && args.expectSig && previous.sig !== args.expectSig) return { ok: true, stale: true, previous };
    let scope = (args && args.scope) || scopeCache();
    if (!scope) scope = (await detectScope()) || 'host';
    const cleared = clearAuth(list);
    for (const c of list) writeCookie(c.name, c.value, scope);
    const after = authCookies();
    const missing = list.filter((c) => !after.some((a) => a.name === c.name && a.value === c.value));
    if (missing.length) throw new Error('写入 Cookie 失败: ' + missing.map((c) => c.name).join(', '));
    const strangers = after.filter((a) => !list.some((c) => c.name === a.name));
    if (strangers.length) throw new Error('无法清除旧的登录 Cookie: ' + strangers.map((c) => c.name).join(', '));
    lastSig = sigOf(after); // our own change — the dock already knows
    const res = { ok: true, cleared, written: list.length, scope, previous, storageCleared: clearWebStorageSessions() };
    if (args && args.navigate) {
      res.navigateTo = navTarget(args.navigate === true ? '/' : args.navigate);
      // the next document verifies it really starts with this session
      const dec = decodeSession(list);
      const id = dec ? identity(dec.session) : null;
      try { W.sessionStorage.setItem(EXPECT_KEY, JSON.stringify({ cookies: list, scope, sig: lastSig, userId: (id && id.userId) || '', at: now() })); } catch (_) { /* storage blocked */ }
    }
    return res;
  }
  function actClear(args) {
    const previous = snapshot();
    const cleared = clearAuth();
    const remaining = authCookies();
    lastSig = sigOf(remaining);
    if (remaining.length) throw new Error('部分 Cookie 无法删除: ' + remaining.map((c) => c.name).join(', '));
    const res = { ok: true, cleared, previous, storageCleared: clearWebStorageSessions() };
    try { W.sessionStorage.removeItem(EXPECT_KEY); } catch (_) { /* ignore */ }
    if (args && args.navigate) res.navigateTo = navTarget(args.navigate === true ? '/' : args.navigate);
    return res;
  }

  /* Document start of the page a `restore{navigate}` led to: the swap can
   * still have been undone in flight (a refresh answer of the old page, a
   * Set-Cookie on one of its late requests, mixed chunks). If the cookies no
   * longer carry the expected identity — a rotation of the SAME user by the
   * server is fine — write them again before the site's scripts run and
   * load once more; the stamp is consumed first, so this happens at most
   * once. The result is reported with the watcher's `init` snapshot. */
  let bootCheck = '';
  function reassertExpected() {
    let exp = null;
    try { exp = JSON.parse(W.sessionStorage.getItem(EXPECT_KEY) || 'null'); W.sessionStorage.removeItem(EXPECT_KEY); } catch (_) { return ''; }
    if (!exp || !Array.isArray(exp.cookies) || !exp.cookies.length) return '';
    if (now() - (Number(exp.at) || 0) > EXPECT_TTL_MS) return 'expired';
    const cur = authCookies();
    if (sigOf(cur) === exp.sig) return 'intact';
    const dec = decodeSession(cur);
    const id = dec ? identity(dec.session) : null;
    if (id && !id.anonymous && id.userId && id.userId === exp.userId) return 'rotated';
    const found = id ? (id.anonymous ? 'guest' : 'other:' + id.userId) : (cur.length ? 'undecodable' : 'none');
    const list = exp.cookies.filter((c) => c && typeof c.name === 'string' && isAuthName(c.name) && validValue(c.value));
    clearAuth(list);
    for (const c of list) writeCookie(c.name, c.value, exp.scope || scopeCache() || 'host');
    const after = authCookies();
    const good = list.length > 0 && list.every((c) => after.some((a) => a.name === c.name && a.value === c.value));
    if (good) { freezeAuthWrites(); navigateTo(String(L.pathname || '/') + String(L.search || '')); }
    return (good ? 'reapplied:' : 'reapply-failed:') + found;
  }

  // ── watcher: report every auth-cookie change to the dock ─────────────
  let lastSig = null;
  function announce(reason) {
    const s = snapshot();
    if (s.sig === lastSig && reason !== 'force') return false;
    lastSig = s.sig;
    if (reason === 'init' && bootCheck) s.bootCheck = bootCheck;
    send('account', Object.assign({ reason }, s));
    return true;
  }

  // ── re-login (0.4.9) ─────────────────────────────────────────────────
  // Replaces the old credentials helper (email / password / TOTP / SMS,
  // removed). Every account is first logged in BY HAND; when its saved
  // session dies the user taps 登录 and this automates exactly the manual
  // Google round trip for an account Google already knows on this device:
  //   arena  : 登录 → (dialog) tick the terms checkbox → Continue with Google
  //   google : account chooser → the target row [data-identifier=email]
  //            → confirmation page → 继续 / Continue
  //   arena  : back logged in → done (the dock saves the new session)
  // Anything else Google asks for (password, 2FA, an account that is not in
  // the chooser) is left to the user with a short note; no credentials are
  // stored or typed. The target reaches accounts.google.com through Rust
  // (login_set → __AK_LOGIN_APPLY__ on every page load), since that page has
  // no IPC; login_clear on every terminal stage.
  const TRY_KEY = 'arenakit.relogin.try';
  const DIRECT_AFTER_MS = 20_000; // no Google button by then → the button's own URL
  let login = null; // { creds, startedAt, done:Set, timer, obs, stage, leaving, leftAt }

  const visible = (el) => {
    if (!el || el.isConnected === false || el.type === 'hidden') return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
    return el.offsetParent !== null || el.offsetParent === undefined;
  };
  const enabled = (el) => !!el && !el.disabled && !(el.getAttribute && el.getAttribute('aria-disabled') === 'true');
  const textOf = (el) => String((el && (el.textContent || el.value || (el.getAttribute && el.getAttribute('aria-label')))) || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    let t = textOf(el) + ' ' + String((el && el.getAttribute && el.getAttribute('aria-label')) || '');
    try { if (el.id && D.querySelector) { const l = D.querySelector('label[for="' + el.id + '"]'); if (l) t += ' ' + textOf(l); } } catch (_) { /* ignore */ }
    let row = el && el.parentElement;
    for (let i = 0; row && i < 3; i++, row = row.parentElement) { const rt = textOf(row); if (rt && rt.length <= 200) { t += ' ' + rt; break; } }
    return t;
  };
  function q(sel, root) { try { return [...(root || D).querySelectorAll(sel)].filter(visible); } catch (_) { return []; } }
  const emailKey = (e) => String(e || '').trim().toLowerCase();
  const once = (key) => { if (!login || login.done.has(key)) return false; login.done.add(key); return true; };

  function report(stage, extra) {
    if (!login) return;
    const changed = login.stage !== stage;
    login.stage = stage;
    if (!changed && stage !== 'done' && stage !== 'error') return;
    const payload = Object.assign({ stage, host: hostOf(), accountId: login.creds.accountId || null, email: login.creds.email || '', at: now() }, extra || {});
    // Only arena.ai may talk to Rust (capabilities); elsewhere the note bar.
    if (isArenaHost(hostOf())) send('login', payload);
    else { try { console.debug('[ArenaKit] relogin', payload); } catch (_) { /* ignore */ } }
  }
  function finish(stage, extra) {
    report(stage, extra);
    stopLogin(false);
    try { const b = W.__ARENAKIT__; if (b && typeof b.invoke === 'function') b.invoke('login_clear', {}).catch(() => {}); } catch (_) { /* ignore */ }
  }
  function stopLogin(reportIt) {
    if (!login) return;
    if (reportIt) report('stopped');
    if (login.timer) clearInterval(login.timer);
    if (login.obs) { try { login.obs.disconnect(); } catch (_) { /* ignore */ } }
    login = null;
  }

  // A real tap / key press pauses the automation for 10 s: the user comes
  // first, and a double start of the OAuth round trip breaks it.
  const USER_YIELD_MS = 10_000;
  let userAt = 0;
  const onUserInput = (ev) => { if (ev && ev.isTrusted !== false) userAt = now(); };
  try { D.addEventListener('pointerdown', onUserInput, true); D.addEventListener('keydown', onUserInput, true); } catch (_) { /* ignore */ }
  const userActive = () => now() - userAt < USER_YIELD_MS;

  /* Small note bar on Google's pages (no dock there): progress, or what the
   * user has to do by hand, plus 返回 Arena (the webview has no back button). */
  function noteBar(text, withBack) {
    if (!D || typeof D.createElement !== 'function' || !D.documentElement) return null;
    let bar = D.getElementById && D.getElementById('ak-relogin-bar');
    if (!bar) {
      bar = D.createElement('div');
      bar.id = 'ak-relogin-bar';
      bar.setAttribute('style', 'position:fixed;left:8px;right:8px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;padding:10px 12px;border-radius:12px;background:#1F2228;color:#E6E8ED;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)');
      D.documentElement.appendChild(bar);
    }
    bar.textContent = '';
    const msg = D.createElement('span');
    msg.setAttribute('style', 'flex:1;min-width:0');
    msg.textContent = 'ArenaKit：' + text;
    bar.appendChild(msg);
    if (withBack) {
      const b = D.createElement('button');
      b.type = 'button';
      b.textContent = '返回 Arena';
      b.setAttribute('style', 'flex:none;border:0;border-radius:16px;padding:6px 12px;font:600 13px system-ui,sans-serif;background:#9DB8FF;color:#0B1A45');
      b.addEventListener('click', () => { try { L.href = 'https://arena.ai/agent'; } catch (_) { /* ignore */ } });
      bar.appendChild(b);
    }
    return bar;
  }

  // ── Google side (accounts.google.com) ────────────────────────────────
  function findButton(re, root) {
    return q('button, [role="button"], input[type="submit"], a[href]', root).find((b) => enabled(b) && re.test(textOf(b))) || null;
  }
  function pageSays(re) {
    return q('h1, h2, [role="heading"], p, [jsname] > span, div[aria-live]').some((e) => re.test(textOf(e)));
  }
  function stepGoogle(c) {
    const path = String(L.pathname || '');
    const want = emailKey(c.email);
    if (pageSays(/disallowed_useragent|browser or app may not be secure|浏览器或应用可能不安全/i)) {
      report('google-blocked'); noteBar('Google 拒绝了应用内登录（disallowed_useragent）', true); finishLocal(); return;
    }
    // 1. anything that needs a person: identifier / password / 2FA pages
    if (q('#identifierId, input[type="email"], input[name="identifier"], input[type="password"], #totpPin, #idvPin, #backupCodePinInput, [data-challengetype]').length) {
      report('google-need-user');
      noteBar('Google 要求输入账号 / 密码 / 验证：请手动完成（登录助手已移除，不再代填）', true);
      finishLocal();
      return;
    }
    // 2. confirmation / consent page → Continue (checked first: it may show
    //    the chosen account as a [data-identifier] chip too)
    const cont = findButton(/^(continue|继续|繼續|allow|允许|允許|confirm|确认|確認)$/i);
    if (cont) {
      if (once('g-cont:' + path)) { cont.click(); report('google-continue'); noteBar('已点「继续」，正在返回 Arena…', false); }
      return;
    }
    // 3. account chooser: the accounts already signed in to Google here
    const rows = q('[data-identifier]');
    if (rows.length) {
      const pick = rows.find((r) => emailKey(r.getAttribute('data-identifier')) === want);
      if (pick) {
        if (once('g-pick:' + path)) { pick.click(); report('google-pick'); noteBar('已选择 ' + c.email + '…', false); }
        return;
      }
      report('google-not-listed');
      noteBar('Google 账号列表里没有 ' + c.email + '：请手动选择或登录（首次需手工登录一次）', true);
      finishLocal();
      return;
    }
    report('google-waiting');
  }
  /* On Google the page cannot reach Rust; stop here, arena clears later
   * (the pending entry also expires on the Rust side after its TTL). */
  function finishLocal() { stopLogin(false); }

  // ── Arena side ───────────────────────────────────────────────────────
  function readTry(c) {
    try {
      const t = JSON.parse(W.sessionStorage.getItem(TRY_KEY) || 'null');
      if (t && t.id === String(c.startedAt || '') && now() - (Number(t.at) || 0) < LOGIN_TTL_MS) return t;
    } catch (_) { /* storage blocked */ }
    return { id: String(c.startedAt || ''), n: 0, at: 0 };
  }
  function writeTry(c, how) {
    const next = { id: String(c.startedAt || ''), n: readTry(c).n + 1, at: now(), how };
    try { W.sessionStorage.setItem(TRY_KEY, JSON.stringify(next)); } catch (_) { /* storage blocked */ }
    return next;
  }
  function clearTry() { try { W.sessionStorage.removeItem(TRY_KEY); } catch (_) { /* ignore */ } }
  function googleSignInUrl(linkHistory) {
    // the same URL the site's "Continue with Google" button navigates to
    const qs = 'shouldLinkHistory=' + (linkHistory ? 'true' : 'false') + '&marketingConsent=false&returnTo=' + encodeURIComponent('/agent');
    return (L.origin || ('https://' + hostOf())) + '/nextjs-api/sign-in/google?' + qs;
  }
  const isChecked = (el) => {
    const a = (k) => (el.getAttribute ? el.getAttribute(k) : null);
    if (a('aria-checked') === 'true' || a('data-state') === 'checked') return true;
    if (a('aria-checked') === 'false' || a('data-state') === 'unchecked') return false;
    return !!el.checked;
  };
  const MARKETING = /marketing|newsletter|updates|promotion|email me|营销|推广|订阅|资讯/i;
  const TERMS = /agree|terms|privacy|policy|consent|同意|条款|條款|隐私|隱私|协议|協議/i;
  function loginDialog() {
    const dialogs = q('[role="dialog"], [role="alertdialog"], dialog[open]');
    return dialogs.find((d) => /google/i.test(textOf(d))) || dialogs[0] || null;
  }
  // inside the login dialog any "Google" button; on the bare page only an
  // explicit sign-in label (model names like "Google Gemini" must not match)
  const GOOGLE_SIGNIN = /(continue|sign ?in|log ?in) with google|使用\s*google|google\s*(帐号|账号|帳號)?\s*(登录|登入|继续|繼續)|通过\s*google/i;
  function googleButton(root) {
    const re = root ? /google/i : GOOGLE_SIGNIN;
    return q('button, [role="button"], a[href]', root).find((b) => re.test(textOf(b) + ' ' + String((b.getAttribute && b.getAttribute('aria-label')) || ''))) || null;
  }
  function termsBoxes(root) {
    return q('input[type="checkbox"], [role="checkbox"], button[role="checkbox"]', root).filter((b) => !MARKETING.test(labelOf(b)));
  }
  function loginButton() {
    return q('button, [role="button"], a[href]').find((b) => /^(log ?in|sign ?in|sign ?up|登录|登入|登錄|注册\s*\/\s*登录)$/i.test(textOf(b))) || null;
  }
  function leaveVia(c, how, url) {
    login.leaving = true;
    login.leftAt = now();
    writeTry(c, how);
    report(how === 'button' ? 'arena-google' : 'arena-google-direct');
    if (url) { try { if (typeof L.assign === 'function') L.assign(url); else L.href = url; } catch (_) { try { L.href = url; } catch (__) { /* ignore */ } } }
  }

  function stepArena(c) {
    const s = snapshot();
    if (s.state === 'logged-in') {
      clearTry();
      if (!c.email || emailKey(s.email) === emailKey(c.email)) { finish('done', { email: s.email }); return; }
      finish('wrong-account', { email: s.email, error: '页面已登录 ' + s.email + '，不是 ' + c.email });
      return;
    }
    if (login.leaving) {
      // Google is loading; a button click that never navigated (15 s) →
      // the button's own URL, once
      if (now() - login.leftAt > 15_000 && once('a-direct-late')) leaveVia(c, 'direct', googleSignInUrl(s.state === 'guest'));
      return;
    }
    // back from one round trip and still logged out → report, never loop
    if (readTry(c).n > 0) {
      const err = s.authError;
      clearTry();
      finish('error', { error: err ? 'Arena 登录失败：' + err : '回到 Arena 后仍未登录（在 Google 页面取消了，或该账号需要手动登录）' });
      return;
    }
    const dlg = loginDialog();
    const gBtn = googleButton(dlg || undefined);
    if (gBtn) {
      // tick the terms checkbox first (never a marketing opt-in)
      const boxes = termsBoxes(dlg || undefined);
      const box = boxes.find((b) => TERMS.test(labelOf(b)) && !isChecked(b)) || (boxes.length === 1 && !isChecked(boxes[0]) ? boxes[0] : null);
      if (box) {
        if (once('a-agree')) { box.click(); report('arena-agree'); }
        return; // next tick: the button (often enabled only once ticked)
      }
      if (!enabled(gBtn)) { report('arena-waiting'); return; }
      if (once('a-google')) { gBtn.click(); leaveVia(c, 'button', ''); }
      return;
    }
    const btn = loginButton();
    if (btn && !dlg) {
      // once, plus one retry after 10 s when no dialog showed up
      const key = now() - login.startedAt < 10_000 ? 'a-open:0' : 'a-open:1';
      if (once(key)) { btn.click(); report('arena-open'); return; }
    }
    // no dialog / button found in time → what the Google button does
    if (now() - login.startedAt > DIRECT_AFTER_MS) { leaveVia(c, 'direct', googleSignInUrl(s.state === 'guest')); return; }
    if (login.stage !== 'arena-open') report('arena-waiting'); // keep "clicked 登录" while the dialog loads
  }

  function step() {
    if (!login) return;
    if (now() - login.startedAt > LOGIN_TTL_MS) { finish('timeout'); return; }
    if (userActive()) { report('user-active'); return; }
    try {
      const h = hostOf();
      if (isArenaHost(h)) stepArena(login.creds);
      else if (isGoogleHost(h)) stepGoogle(login.creds);
    } catch (e) {
      report('error', { error: String((e && e.message) || e) });
    }
  }

  function startLogin(creds) {
    const c = creds && typeof creds === 'object' ? creds : {};
    const clean = { accountId: c.accountId ? String(c.accountId) : '', email: c.email ? String(c.email).trim() : '', startedAt: Number(c.startedAt) || 0 };
    if (!clean.email) throw new Error('缺少账号邮箱');
    if (clean.startedAt && now() - clean.startedAt > LOGIN_TTL_MS) return { started: false, reason: 'expired' };
    if (login && login.creds.startedAt === clean.startedAt && login.creds.email === clean.email) return { started: true, host: hostOf(), already: true };
    stopLogin(false);
    login = { creds: clean, startedAt: clean.startedAt || now(), done: new Set(), timer: null, obs: null, stage: '', leaving: false, leftAt: 0 };
    login.timer = setInterval(step, 700);
    try {
      if (typeof W.MutationObserver === 'function' && D.documentElement) {
        let pending = false;
        login.obs = new W.MutationObserver(() => {
          if (pending) return;
          pending = true;
          later(() => { pending = false; step(); }, 150);
        });
        login.obs.observe(D.documentElement, { childList: true, subtree: true });
      }
    } catch (_) { /* ignore */ }
    later(step, 50);
    return { started: true, host: hostOf() };
  }

  // Rust pushes the pending re-login on every page load (lib.rs on_page_load).
  W.__AK_LOGIN_APPLY__ = function (creds) {
    try { return startLogin(creds); } catch (e) { return { started: false, error: String((e && e.message) || e) }; }
  };
  if (W.__AK_LOGIN__ && typeof W.__AK_LOGIN__ === 'object') {
    try { startLogin(W.__AK_LOGIN__); } catch (_) { /* ignore */ }
  }

  // ── RPC (same shape as probe.js; answered as 'account-result') ───────
  const ACTIONS = {
    snapshot: actSnapshot,
    restore: actRestore,
    clear: (args) => actClear(args),
    login: (args) => startLogin(args && args.creds ? args.creds : args),
    stop: () => { stopLogin(true); return { ok: true }; },
    status: () => ({ ok: true, running: !!login, stage: login ? login.stage : '', host: hostOf() }),
  };
  async function call(action, argsJson, reqId) {
    let res;
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const fn = ACTIONS[action];
      if (!fn) throw Error('unknown action: ' + action);
      const data = await fn(args);
      res = { ok: true, data: data ?? {} };
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    send('account-result', Object.assign({ reqId }, res));
    // restore / clear with `navigate`: leave right away (after the answer has
    // been handed to the bridge), before the site's auth client can react.
    if (res.ok && res.data && res.data.navigateTo) { freezeAuthWrites(); navigateTo(res.data.navigateTo); }
    return res;
  }

  W.ArenaAccount = {
    call, snapshot, startLogin, stopLogin,
    // exposed for tests
    parseCookieHeader, groupChunks, decodeSession, identity, sigOf, isAuthName, detectScope, navTarget, freezeAuthWrites, reassertExpected,
    userActive, googleSignInUrl,
    get bootCheck() { return bootCheck; },
  };

  // ── boot the watcher on arena pages ──────────────────────────────────
  if (isArenaHost(hostOf())) {
    try { bootCheck = reassertExpected(); } catch (_) { bootCheck = 'error'; }
    later(() => announce('init'), 800);
    setInterval(() => announce('poll'), WATCH_MS);
    const onWake = () => announce('wake');
    try { D.addEventListener('visibilitychange', onWake); } catch (_) { /* ignore */ }
    try { W.addEventListener('focus', onWake); W.addEventListener('pageshow', onWake); } catch (_) { /* ignore */ }
  }
})();
