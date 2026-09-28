/* ArenaKit injected/account.js — 多账号：会话快照 / 一键切换 / 登录助手（2FA）。
 * MAIN world, document_start, runs on every page of the arena webview
 * (arena.ai AND the sign-in hosts that links.js keeps in place, e.g.
 * accounts.google.com).
 *
 * How arena.ai sessions work (facts, see docs/ARCHITECTURE.md → 账号):
 *   • Supabase SSR keeps the session in JS-readable cookies named
 *     `arena-auth-prod-v1` — chunked as `arena-auth-prod-v1.0`, `.1`, … when
 *     long. The value is `base64-` + base64url(JSON {access_token,
 *     refresh_token, expires_at, user:{id,email,user_metadata…}}).
 *   • The site's own browser client reads them through document.cookie, so
 *     they are not HttpOnly and this script can read / rewrite them.
 *   • Swapping that cookie set + reload == switching account. Tokens rotate
 *     (refresh_token is single-use), so the ACTIVE account's snapshot must be
 *     kept fresh: the watcher below reports every cookie change to the dock
 *     (`account` page event) and the dock persists it.
 *   • arena.ai has no 2FA of its own; TOTP belongs to the identity provider
 *     (Google …). The login helper fills email / password / TOTP on those pages
 *     (`window.__AK_TOTP__` from injected/totp.gen.js computes the code).
 *
 * Dock → page:  window.ArenaAccount.call(action, argsJson, reqId)
 *               actions: snapshot · restore{cookies,scope} · clear · login{creds}
 *               · fill{code} · stop
 * Page → dock:  __ARENAKIT__.send('account-result', {reqId, ok, data|error})
 *               __ARENAKIT__.send('account', snapshot)   (watcher, on change)
 *               __ARENAKIT__.send('login', {stage, …})   (helper progress)
 * Rust → page:  window.__AK_LOGIN_APPLY__(creds) on every page load while a
 *               login is pending (lib.rs login_set / on_page_load) — that is
 *               how credentials reach accounts.google.com, where no IPC exists. */
(() => {
  'use strict';
  const W = globalThis;
  const D = W.document;
  const L = W.location || {};
  const MAX_AGE = 400 * 24 * 3600; // @supabase/ssr default cookie lifetime
  const SCOPE_KEY = 'ak_account_cookie_scope';
  const WATCH_MS = 4000;
  const LOGIN_TTL_MS = 4 * 60 * 1000;

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
  const isAuthName = (n) => /^arena-auth/i.test(n) || /^sb-[\w-]+-auth-token/i.test(n);
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
  function clearAuth() {
    const names = [...new Set(authCookies().map((c) => c.name))];
    for (const n of names) expireCookie(n);
    return names.length;
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
    return { userId, email, name, avatar, provider, expiresAt };
  }
  function sigOf(cookies) {
    const s = cookies.map((c) => c.name + '=' + c.value).join(';');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + s.length;
  }
  function scopeCache() { try { return W.localStorage.getItem(SCOPE_KEY) || ''; } catch (_) { return ''; } }
  function rememberScope(s) { try { W.localStorage.setItem(SCOPE_KEY, s); } catch (_) { /* blocked */ } }

  function snapshot() {
    const cookies = authCookies();
    const dec = decodeSession(cookies);
    const id = dec ? identity(dec.session) : null;
    return Object.assign(
      { ok: true, host: hostOf(), loggedIn: !!(id && (id.userId || id.email)), hasAuthCookie: cookies.length > 0 },
      id || {},
      { cookies, sig: sigOf(cookies), scope: scopeCache(), at: now() }
    );
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
  async function actRestore(args) {
    const list = Array.isArray(args && args.cookies)
      ? args.cookies.filter((c) => c && typeof c.name === 'string' && isAuthName(c.name) && validValue(c.value))
      : [];
    if (!list.length) throw new Error('没有可恢复的登录 Cookie');
    let scope = (args && args.scope) || scopeCache();
    if (!scope) scope = (await detectScope()) || 'host';
    const cleared = clearAuth();
    for (const c of list) writeCookie(c.name, c.value, scope);
    const after = authCookies();
    const missing = list.filter((c) => !after.some((a) => a.name === c.name && a.value === c.value));
    if (missing.length) throw new Error('写入 Cookie 失败: ' + missing.map((c) => c.name).join(', '));
    lastSig = sigOf(after); // our own change — the dock already knows
    return { ok: true, cleared, written: list.length, scope };
  }
  function actClear() {
    const cleared = clearAuth();
    const remaining = authCookies();
    lastSig = sigOf(remaining);
    if (remaining.length) throw new Error('部分 Cookie 无法删除: ' + remaining.map((c) => c.name).join(', '));
    return { ok: true, cleared };
  }

  // ── watcher: report every auth-cookie change to the dock ─────────────
  let lastSig = null;
  function announce(reason) {
    const s = snapshot();
    if (s.sig === lastSig && reason !== 'force') return false;
    lastSig = s.sig;
    send('account', Object.assign({ reason }, s));
    return true;
  }

  // ── login helper ─────────────────────────────────────────────────────
  let login = null; // { creds, startedAt, done:Set, timer, obs, stage }

  function setNativeValue(el, value) {
    try { el.focus(); } catch (_) { /* ignore */ }
    let proto = null;
    try { proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype; } catch (_) { proto = null; }
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && typeof desc.set === 'function') desc.set.call(el, value); else el.value = value;
    const Ev = W.Event || function (t) { return { type: t }; };
    try { el.dispatchEvent(new Ev('input', { bubbles: true })); } catch (_) { /* ignore */ }
    try { el.dispatchEvent(new Ev('change', { bubbles: true })); } catch (_) { /* ignore */ }
  }
  const visible = (el) => {
    if (!el || el.isConnected === false || el.disabled || el.type === 'hidden') return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
    return el.offsetParent !== null || el.offsetParent === undefined;
  };
  const textOf = (el) => String((el && (el.textContent || el.value || (el.getAttribute && el.getAttribute('aria-label')))) || '').replace(/\s+/g, ' ').trim();
  function q(sel, root) { try { return [...(root || D).querySelectorAll(sel)].filter(visible); } catch (_) { return []; } }
  function findButton(re, root) {
    return q('button, [role="button"], input[type="submit"], a[href]', root).find((b) => re.test(textOf(b))) || null;
  }
  // Google's #identifierNext / #passwordNext / #totpNext are wrapper DIVs
  // around the real <button> (`#identifierNext > div > button`); click the
  // button itself so the click takes the same handler path as a finger.
  const isClickable = (el) => /^(button|input|a)$/i.test(String((el && el.tagName) || '')) || (el && el.getAttribute && el.getAttribute('role') === 'button');
  function innerButton(el) {
    if (!el || isClickable(el)) return el;
    try {
      const inner = el.querySelector && el.querySelector('button, [role="button"], input[type="submit"]');
      return inner || el;
    } catch (_) { return el; }
  }
  function submitNear(el, btnRe, idSel) {
    let b = null;
    try { b = idSel ? innerButton(D.querySelector(idSel)) : null; } catch (_) { b = null; }
    if (!b || !visible(b)) b = findButton(btnRe, (el.closest && el.closest('form')) || D) || findButton(btnRe);
    if (b) { b.click(); return 'button'; }
    const f = el.form || (el.closest && el.closest('form'));
    if (f) {
      try { if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit(); return 'form'; } catch (_) { /* fall through */ }
    }
    try {
      const KE = W.KeyboardEvent;
      if (KE) el.dispatchEvent(new KE('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (_) { /* ignore */ }
    return 'enter';
  }
  const once = (key) => { if (!login || login.done.has(key)) return false; login.done.add(key); return true; };
  function fillOnce(key, el, value) {
    if (!once(key)) return false;
    setNativeValue(el, value);
    return true;
  }
  function codeFor(secret) {
    try {
      const lib = W.__AK_TOTP__;
      if (!lib || !secret) return '';
      const r = lib.totpNow(secret);
      return r && r.code ? String(r.code) : '';
    } catch (_) { return ''; }
  }
  function report(stage, extra) {
    if (!login) return;
    const changed = login.stage !== stage;
    login.stage = stage;
    if (!changed && stage !== 'done' && stage !== 'error') return;
    const payload = Object.assign({ stage, host: hostOf(), accountId: login.creds.accountId || null, at: now() }, extra || {});
    // Only arena.ai may talk to Rust (capabilities); elsewhere just log.
    if (isArenaHost(hostOf())) send('login', payload);
    else { try { console.debug('[ArenaKit] login helper', payload); } catch (_) { /* ignore */ } }
  }
  function finish(stage, extra) {
    report(stage, extra);
    stopLogin(false);
    if (stage === 'done') {
      try { const b = W.__ARENAKIT__; if (b && typeof b.invoke === 'function') b.invoke('login_clear', {}).catch(() => {}); } catch (_) { /* ignore */ }
    }
  }
  function stopLogin(reportIt) {
    if (!login) return;
    if (reportIt) report('stopped');
    if (login.timer) clearInterval(login.timer);
    if (login.obs) { try { login.obs.disconnect(); } catch (_) { /* ignore */ } }
    login = null;
  }

  function stepGoogle(c) {
    const path = String(L.pathname || '');
    const emailIn = q('input[type="email"], #identifierId, input[name="identifier"]')[0];
    if (emailIn && c.email) {
      if (fillOnce('g-email:' + path, emailIn, c.email)) {
        later(() => submitNear(emailIn, /^(next|下一步|continue|继续)$/i, '#identifierNext'), 450);
        report('google-email');
      }
      return;
    }
    if (c.email) {
      const want = c.email.toLowerCase();
      const pick = q('[data-identifier], [data-email]').find((e) => String(e.getAttribute('data-identifier') || e.getAttribute('data-email') || '').toLowerCase() === want);
      if (pick) { if (once('g-pick:' + path)) { pick.click(); report('google-pick'); } return; }
    }
    const pwdIn = q('input[type="password"], input[name="Passwd"]')[0];
    if (pwdIn) {
      if (!c.password) { report('need-password'); return; }
      if (fillOnce('g-pwd:' + path, pwdIn, c.password)) {
        later(() => submitNear(pwdIn, /^(next|下一步|continue|继续)$/i, '#passwordNext'), 450);
        report('google-password');
      }
      return;
    }
    const totpIn = q('#totpPin, input[name="totpPin"], input[name="idvPin"], input[name="pin"], input[autocomplete="one-time-code"]')[0];
    if (totpIn) {
      if (!c.totp) { report('need-code'); return; }
      const code = codeFor(c.totp);
      if (!code) { report('error', { error: 'TOTP 密钥无效' }); return; }
      if (fillOnce('g-totp:' + path + ':' + code, totpIn, code)) {
        later(() => submitNear(totpIn, /^(next|下一步|verify|验证|continue|继续)$/i, '#totpNext'), 450);
        report('google-totp');
      }
      return;
    }
    if (c.totp) {
      const opt = findButton(/authenticator|验证器|verification code from|获取验证码/i);
      if (opt) { if (once('g-authopt:' + path)) { opt.click(); report('google-pick-authenticator'); } return; }
      const other = findButton(/try another way|其他方式|more ways/i);
      if (other) { if (once('g-other:' + path)) { other.click(); report('google-other-way'); } return; }
    }
    const cont = findButton(/^(continue|继续|allow|允许|confirm|确认)$/i);
    if (cont) { if (once('g-cont:' + path)) { cont.click(); report('google-continue'); } return; }
    report('google-waiting');
  }

  function stepArena(c) {
    if (snapshot().loggedIn) { finish('done'); return; }
    const emailIn = q('input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"], input[placeholder*="email" i], input[placeholder*="邮箱"]')[0];
    const pwdIn = q('input[type="password"]')[0];
    const otpIn = q('input[autocomplete="one-time-code"], input[name*="code" i], input[name*="otp" i], input[inputmode="numeric"]')[0];
    const googleBtn = findButton(/google/i);
    const wantGoogle = c.provider === 'google' || (!c.provider && !c.password);
    if (googleBtn && wantGoogle && c.email) {
      if (once('a-google')) { googleBtn.click(); report('arena-google'); }
      return;
    }
    if (pwdIn) {
      if (!c.password) { report('need-password'); return; }
      if (fillOnce('a-pwd', pwdIn, c.password)) {
        later(() => submitNear(pwdIn, /log ?in|sign ?in|continue|登录|继续/i), 450);
        report('arena-password');
      }
      return;
    }
    if (otpIn) {
      if (c.code) {
        if (fillOnce('a-code:' + c.code, otpIn, c.code)) { later(() => submitNear(otpIn, /verify|continue|验证|继续/i), 450); report('arena-code'); }
      } else report('need-code');
      return;
    }
    if (emailIn) {
      if (!c.email) { report('need-email'); return; }
      if (fillOnce('a-email', emailIn, c.email)) {
        later(() => {
          const b = findButton(/continue with email|使用邮箱|邮箱继续/i) || findButton(/^(continue|next|继续|下一步)$/i);
          if (b) b.click(); else submitNear(emailIn, /continue|next|继续|下一步/i);
        }, 450);
        report('arena-email');
      }
      return;
    }
    const loginBtn = findButton(/^(log ?in|sign ?in|sign ?up|登录|登入|注册\s*\/\s*登录)$/i);
    if (loginBtn) {
      const key = 'a-open:' + Math.floor((now() - login.startedAt) / 5000);
      if (once(key)) { loginBtn.click(); report('arena-open'); }
      return;
    }
    report('arena-waiting');
  }

  function stepGeneric(c) {
    const emailIn = q('input[type="email"], input[autocomplete="username"], input[name="email"], input[name="login"]')[0];
    if (emailIn && c.email) { if (fillOnce('x-email:' + L.pathname, emailIn, c.email)) { later(() => submitNear(emailIn, /next|continue|sign in|log in|下一步|继续|登录/i), 450); report('generic-email'); } return; }
    const pwdIn = q('input[type="password"]')[0];
    if (pwdIn && c.password) { if (fillOnce('x-pwd:' + L.pathname, pwdIn, c.password)) { later(() => submitNear(pwdIn, /next|continue|sign in|log in|下一步|继续|登录/i), 450); report('generic-password'); } return; }
    const otpIn = q('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], input[name*="code" i]')[0];
    if (otpIn && c.totp) {
      const code = codeFor(c.totp);
      if (code && fillOnce('x-totp:' + L.pathname + ':' + code, otpIn, code)) { later(() => submitNear(otpIn, /verify|next|continue|验证|下一步|继续/i), 450); report('generic-totp'); }
      return;
    }
    report('generic-waiting');
  }

  function step() {
    if (!login) return;
    if (now() - login.startedAt > LOGIN_TTL_MS) { finish('timeout'); return; }
    try {
      const h = hostOf();
      if (isArenaHost(h)) stepArena(login.creds);
      else if (isGoogleHost(h)) stepGoogle(login.creds);
      else stepGeneric(login.creds);
    } catch (e) {
      report('error', { error: String((e && e.message) || e) });
    }
  }

  function startLogin(creds) {
    const c = creds && typeof creds === 'object' ? creds : {};
    const clean = {
      accountId: c.accountId ? String(c.accountId) : '',
      email: c.email ? String(c.email).trim() : '',
      password: c.password ? String(c.password) : '',
      totp: c.totp ? String(c.totp).trim() : '',
      code: c.code ? String(c.code).trim() : '',
      provider: c.provider ? String(c.provider).toLowerCase() : '',
      startedAt: Number(c.startedAt) || 0,
    };
    if (!clean.email && !clean.password && !clean.totp) throw new Error('登录信息为空');
    if (clean.startedAt && now() - clean.startedAt > LOGIN_TTL_MS) return { started: false, reason: 'expired' };
    stopLogin(false);
    login = { creds: clean, startedAt: clean.startedAt || now(), done: new Set(), timer: null, obs: null, stage: '' };
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

  // Rust pushes the pending login on every page load (lib.rs on_page_load).
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
    clear: () => actClear(),
    login: (args) => startLogin(args && args.creds ? args.creds : args),
    fill: (args) => {
      if (!login) throw new Error('登录助手未运行');
      if (args && args.code) login.creds.code = String(args.code).trim();
      if (args && args.password) login.creds.password = String(args.password);
      step();
      return { ok: true, stage: login ? login.stage : 'done' };
    },
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
    return res;
  }

  W.ArenaAccount = {
    call, snapshot, startLogin, stopLogin,
    // exposed for tests
    parseCookieHeader, groupChunks, decodeSession, identity, sigOf, isAuthName, detectScope,
  };

  // ── boot the watcher on arena pages ──────────────────────────────────
  if (isArenaHost(hostOf())) {
    later(() => announce('init'), 800);
    setInterval(() => announce('poll'), WATCH_MS);
    const onWake = () => announce('wake');
    try { D.addEventListener('visibilitychange', onWake); } catch (_) { /* ignore */ }
    try { W.addEventListener('focus', onWake); W.addEventListener('pageshow', onWake); } catch (_) { /* ignore */ }
  }
})();
