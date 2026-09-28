import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { jwt, supabaseSession, anonymousSession, chunked, fakeDom } from './account-fixture.mjs';

/* injected/account.js: Supabase cookie → identity, snapshot / restore /
 * clear on a document.cookie jar, watcher events, and the login helper on
 * fake arena.ai / accounts.google.com pages. The jar honours Max-Age=0 and
 * the Domain attribute so scope detection is exercised for real. */

/* ── cookie parsing / identity ───────────────────────────────────────── */
test('snapshot decodes the chunked Supabase cookie into an identity', () => {
  const session = supabaseSession();
  const jar = chunked('arena-auth-prod-v1', session).concat([{ name: '_ga', value: 'GA1.1' }, { name: 'cf_clearance', value: 'x' }]);
  assert.ok(jar.length >= 4, 'session spans several chunks');
  const { api } = fakeDom({ jar });
  const s = plain(api.snapshot());
  assert.equal(s.loggedIn, true);
  assert.equal(s.email, 'alice@example.com');
  assert.equal(s.userId, 'user-aaaa');
  assert.equal(s.name, 'Alice');
  assert.equal(s.provider, 'google');
  assert.equal(s.avatar, 'https://img/user-aaaa');
  assert.equal(s.expiresAt, 1_800_000_000 * 1000);
  assert.deepEqual(s.cookies.map((c) => c.name), jar.filter((c) => c.name.startsWith('arena-auth')).map((c) => c.name), 'only auth cookies, chunk order kept');
  assert.equal(typeof s.sig, 'string');
  assert.equal(s.hasAuthCookie, true);
  assert.equal(s.anonymous, false);
});

/* arena.ai signs visitors in anonymously (Supabase anonymous users): the
 * guest state has the same cookie names, a user id and no email. It must read
 * as logged OUT, otherwise every guest session becomes a junk account. */
test('the site\'s anonymous (guest) session is reported as logged out, not as an account', () => {
  const { api, events, flushTimeouts } = fakeDom({ jar: chunked('arena-auth-prod-v1', anonymousSession()) });
  const s = plain(api.snapshot());
  assert.equal(s.hasAuthCookie, true, 'the guest cookie exists');
  assert.equal(s.anonymous, true);
  assert.equal(s.loggedIn, false, 'guest ≠ logged in');
  assert.equal(s.userId, 'anon-0001', 'identity still decoded (for diagnostics)');
  assert.equal(s.email, '');
  // the watcher says the same
  flushTimeouts();
  const ev = events.find((e) => e.name === 'account');
  assert.equal(ev.payload.loggedIn, false);
  assert.equal(ev.payload.anonymous, true);
  // a real session without an email claim is not saveable either (nothing to show / match by)
  const noEmail = { ...supabaseSession({ email: '' }) };
  noEmail.user = { ...noEmail.user, email: '' };
  const s2 = plain(fakeDom({ jar: chunked('arena-auth-prod-v1', noEmail) }).api.snapshot());
  assert.equal(s2.loggedIn, false);
  assert.equal(s2.anonymous, false);
});

test('chunks are joined by index (10 sorts after 9), legacy URL-encoded JSON and JWT fallbacks are understood', () => {
  const { api } = fakeDom();
  const parts = api.groupChunks([{ name: 'n.10', value: 'K' }, { name: 'n.2', value: 'C' }, { name: 'n.0', value: 'A' }, { name: 'n.1', value: 'B' }, { name: 'other', value: 'Z' }]);
  assert.deepEqual(plain(parts), [{ base: 'n', value: 'ABCK' }, { base: 'other', value: 'Z' }]);
  // legacy: URL-encoded JSON (single cookie) without a user object → identity from the JWT
  const legacy = encodeURIComponent(JSON.stringify({ access_token: jwt({ sub: 'u-2', email: 'bob@x.io', exp: 1_700_000_000 }), refresh_token: 'r' }));
  const dec = api.decodeSession([{ name: 'arena-auth-prod-v1', value: legacy }]);
  assert.equal(dec.base, 'arena-auth-prod-v1');
  const id = plain(api.identity(dec.session));
  assert.equal(id.email, 'bob@x.io'); assert.equal(id.userId, 'u-2'); assert.equal(id.expiresAt, 1_700_000_000 * 1000);
  // array form (oldest auth-helpers layout)
  const arr = encodeURIComponent(JSON.stringify([jwt({ sub: 'u-3', email: 'c@x.io' }), 'refresh']));
  assert.equal(plain(api.identity(api.decodeSession([{ name: 'sb-abc-auth-token', value: arr }]).session)).email, 'c@x.io');
  // junk → not logged in but the cookie is still reported
  const junkDom = fakeDom({ jar: [{ name: 'arena-auth-prod-v1.0', value: 'base64-!!!' }] });
  const s = plain(junkDom.api.snapshot());
  assert.equal(s.loggedIn, false); assert.equal(s.hasAuthCookie, true);
  assert.equal(api.isAuthName('arena-auth-prod-v1-code-verifier'), true);
  assert.equal(api.isAuthName('_ga'), false);
});

/* ── restore / clear on the jar ──────────────────────────────────────── */
test('restore swaps the auth cookies for another account, matching the site\'s cookie scope (domain)', async () => {
  const a = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua' }));
  const b = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub' }), 200);
  // the site set A as Domain=.arena.ai cookies
  const d = fakeDom({ jar: a.map((c) => ({ ...c, domain: '.arena.ai' })).concat([{ name: 'cf_clearance', value: 'keep' }]) });
  const before = plain(await d.api.call('snapshot', '{}', 'r1'));
  assert.equal(before.ok, true);
  assert.equal(before.data.scope, 'domain', 'delete-probe detected the domain scope');
  assert.equal(d.sandbox.localStorage.getItem('ak_account_cookie_scope'), 'domain');
  assert.equal(plain(d.api.snapshot()).email, 'alice@example.com', 'probe re-set the very same value');
  const res = plain(await d.api.call('restore', JSON.stringify({ cookies: b }), 'r2'));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.scope, 'domain');
  assert.equal(res.data.written, b.length);
  const after = plain(d.api.snapshot());
  assert.equal(after.email, 'bob@example.com');
  assert.deepEqual(after.cookies.map((c) => c.name), b.map((c) => c.name), 'old chunk names are gone (A had more chunks than B)');
  assert.ok([...d.cookies.values()].filter((c) => c.name.startsWith('arena-auth')).every((c) => c.domain === '.arena.ai'), 'written with Domain=.arena.ai');
  assert.equal(d.cookies.get('|cf_clearance').value, 'keep', 'non-auth cookies untouched');
  // both RPC answers went out on the bridge with their reqIds
  assert.deepEqual(d.events.filter((e) => e.name === 'account-result').map((e) => e.payload.reqId), ['r1', 'r2']);
  assert.equal(res.data.previous.email, 'alice@example.com', 'the session being left comes back with the answer');
  assert.deepEqual(d.navigations, [], 'no navigate requested → the page stays');
});

/* Switching = swap + leave in the same task. `expectSig` protects the account
 * being left: if its cookies rotated after the dock's snapshot, the page
 * refuses and hands back the newer session instead of swapping. */
test('restore with expectSig refuses a stale swap (returns previous, touches nothing); with navigate it leaves for the site root after answering', async () => {
  const a1 = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua', refresh: 'rt-a1' }));
  const a2 = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua', refresh: 'rt-a2' }));
  const b = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub' }), 200);
  const d = fakeDom({ pathname: '/agent/conv-of-alice', jar: a1 });
  const sigA1 = plain(d.api.snapshot()).sig;
  // the site rotates Alice's token after the dock took its snapshot
  for (const c of a2) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  const stale = plain(await d.api.call('restore', JSON.stringify({ cookies: b, expectSig: sigA1, navigate: '/' }), 'r1'));
  assert.equal(stale.ok, true);
  assert.equal(stale.data.stale, true);
  assert.equal(stale.data.previous.email, 'alice@example.com');
  assert.notEqual(stale.data.previous.sig, sigA1);
  assert.equal(plain(d.api.snapshot()).email, 'alice@example.com', 'cookies untouched');
  assert.deepEqual(d.navigations, [], 'no navigation on a refused swap');
  // retry with the newer signature → swap + navigate (site root, not Alice's conversation)
  const ok = plain(await d.api.call('restore', JSON.stringify({ cookies: b, expectSig: stale.data.previous.sig, navigate: '/' }), 'r2'));
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.navigateTo, '/');
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com');
  assert.deepEqual(d.navigations, [{ how: 'replace', url: 'https://arena.ai/' }]);
  assert.ok(Number(d.sessionStorage.getItem('arenakit.reloading')) > 0, 'boot progress stamp set for the next document');
  const answers = d.events.filter((e) => e.name === 'account-result').map((e) => e.payload.reqId);
  assert.deepEqual(answers, ['r1', 'r2'], 'the answer left before the navigation');
  // navigate targets are same-origin paths only
  assert.equal(d.api.navTarget('//evil.example'), '/');
  assert.equal(d.api.navTarget('https://evil.example/'), '/');
  assert.equal(d.api.navTarget('/agent'), '/agent');
  assert.equal(d.api.navTarget(true), '/');
  // clear with navigate: guest-free page, then leave
  const d2 = fakeDom({ jar: a1 });
  const cl = plain(await d2.api.call('clear', JSON.stringify({ navigate: true }), 'c1'));
  assert.equal(cl.ok, true);
  assert.equal(cl.data.previous.email, 'alice@example.com');
  assert.equal(plain(d2.api.snapshot()).hasAuthCookie, false);
  assert.deepEqual(d2.navigations, [{ how: 'replace', url: 'https://arena.ai/' }]);
});

test('restore on a host-only site keeps host-only scope; clear() removes every auth cookie', async () => {
  const a = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua' }));
  const d = fakeDom({ jar: a });
  assert.equal(await d.api.detectScope(), 'host');
  const res = plain(await d.api.call('restore', JSON.stringify({ cookies: chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub' })) }), 'r'));
  assert.equal(res.ok, true, res.error);
  assert.ok([...d.cookies.values()].filter((c) => c.name.startsWith('arena-auth')).every((c) => c.domain === ''));
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com');
  const cleared = plain(await d.api.call('clear', '{}', 'c'));
  assert.equal(cleared.ok, true);
  assert.ok(cleared.data.cleared >= 1);
  assert.equal(plain(d.api.snapshot()).hasAuthCookie, false);
  // restore rejects junk
  const bad = plain(await d.api.call('restore', JSON.stringify({ cookies: [{ name: '_ga', value: 'x' }, { name: 'arena-auth-prod-v1.0', value: 'bad;value' }] }), 'x'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /没有可恢复/);
  const unknown = plain(await d.api.call('nope', '{}', 'u'));
  assert.equal(unknown.ok, false);
});

test('Cookie Store API is preferred for scope detection when the WebView has it', async () => {
  const a = chunked('arena-auth-prod-v1', supabaseSession());
  const d = fakeDom({ jar: a });
  d.sandbox.cookieStore = { getAll: async ({ name }) => [{ name, value: a[0].value, domain: 'arena.ai' }] };
  assert.equal(await d.api.detectScope(), 'domain');
  assert.equal(d.sandbox.localStorage.getItem('ak_account_cookie_scope'), 'domain');
});

/* ── watcher ─────────────────────────────────────────────────────────── */
test('watcher announces the initial state and every auth-cookie change (not unrelated cookies)', () => {
  const a = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua', refresh: 'rt-1' }));
  const d = fakeDom({ jar: a });
  d.flushTimeouts(); // the 800 ms init announce
  let ev = d.lastEvent('account');
  assert.ok(ev, 'init announce');
  assert.equal(ev.payload.reason, 'init');
  assert.equal(ev.payload.email, 'alice@example.com');
  const n = d.events.length;
  d.tickIntervals();
  assert.equal(d.events.length, n, 'no change → silent');
  d.doc.cookie = '_ga=changed; Path=/';
  d.tickIntervals();
  assert.equal(d.events.length, n, 'non-auth cookie change → silent');
  // token rotation: same user, new refresh token → the dock must get the fresh cookies
  for (const c of chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua', refresh: 'rt-2' }))) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  d.tickIntervals();
  ev = d.lastEvent('account');
  assert.equal(d.events.length, n + 1);
  assert.equal(ev.payload.reason, 'poll');
  assert.equal(ev.payload.userId, 'ua');
  assert.ok(ev.payload.cookies.length >= 1);
  // logout → loggedIn false announced
  for (const c of a) d.doc.cookie = `${c.name}=; Max-Age=0; Path=/`;
  d.tickIntervals();
  assert.equal(d.lastEvent('account').payload.loggedIn, false);
});

/* Google's Next controls are wrapper DIVs around the real button
 * (`#identifierNext > div > button`, seen in every public automation recipe
 * for accounts.google.com). Clicking the wrapper does nothing; the helper
 * must click the inner <button>. */
test('login helper clicks the <button> inside Google\'s #identifierNext / #passwordNext wrapper divs', () => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/identifier' });
  const creds = { accountId: 'acc1', email: 'alice@gmail.com', password: 'pw-123', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', provider: 'google' };
  const emailIn = d.mk('input', { type: 'email', id: 'identifierId' });
  const wrap1 = d.mk('div', { id: 'identifierNext' });
  const mid1 = d.mk('div', {}, '', { parent: wrap1 });
  const btn1 = d.mk('button', { type: 'button' }, 'Next', { parent: mid1 });
  assert.equal(plain(d.sandbox.__AK_LOGIN_APPLY__(creds)).started, true);
  d.flushTimeouts(); d.flushTimeouts();
  assert.equal(emailIn.value, 'alice@gmail.com');
  assert.equal(btn1.clicks, 1, 'inner button clicked');
  assert.equal(wrap1.clicks, 0, 'wrapper div not clicked');
  assert.equal(mid1.clicks, 0);
  // password page: same wrapper shape; a role=button wrapper is clicked directly
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/pwd';
  const pwdIn = d.mk('input', { type: 'password', name: 'Passwd' });
  const wrap2 = d.mk('div', { id: 'passwordNext', role: 'button' });
  const btn2 = d.mk('button', {}, 'Next', { parent: wrap2 });
  d.tickIntervals(); d.flushTimeouts();
  assert.equal(pwdIn.value, 'pw-123');
  assert.equal(wrap2.clicks, 1, 'role=button wrapper is itself the control');
  assert.equal(btn2.clicks, 0);
  // hidden wrapper without any button inside → fall back to the visible Next button by text
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/totp';
  const totpIn = d.mk('input', { type: 'tel', id: 'totpPin', name: 'totpPin' });
  const wrap3 = d.mk('div', { id: 'totpNext', hidden: true });
  const byText = d.mk('button', {}, '下一步');
  const realNow = d.sandbox.Date.now;
  d.sandbox.Date.now = () => 59_000; // RFC 6238 vector → 287082
  d.tickIntervals(); d.flushTimeouts();
  d.sandbox.Date.now = realNow;
  assert.equal(totpIn.value, '287082');
  assert.equal(wrap3.clicks, 0);
  assert.equal(byText.clicks, 1, 'text match fallback');
});

test('watcher does not run on foreign hosts (accounts.google.com has no IPC)', () => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/identifier' });
  d.flushTimeouts(); d.tickIntervals();
  assert.equal(d.events.length, 0);
});

/* ── login helper: Google 2-step with TOTP ───────────────────────────── */
test('login helper fills Google identifier → password → TOTP (code from __AK_TOTP__) and presses Next each time', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/identifier' });
  const creds = { accountId: 'acc1', email: 'alice@gmail.com', password: 'pw-123', totp: secret, provider: 'google' };
  // step 1: identifier page
  const emailIn = d.mk('input', { type: 'email', id: 'identifierId' });
  const next1 = d.mk('button', { id: 'identifierNext' }, 'Next');
  const r = plain(d.sandbox.__AK_LOGIN_APPLY__(creds));
  assert.equal(r.started, true);
  d.flushTimeouts(); // the 50 ms first step
  assert.equal(emailIn.value, 'alice@gmail.com');
  assert.deepEqual(emailIn.dispatched, ['input', 'change']);
  d.flushTimeouts(); // the 450 ms submit
  assert.equal(next1.clicks, 1);
  d.tickIntervals();
  assert.equal(next1.clicks, 1, 'never re-submits the same step');
  // step 2: password page (SPA route change)
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/pwd';
  const pwdIn = d.mk('input', { type: 'password', name: 'Passwd' });
  const next2 = d.mk('button', { id: 'passwordNext' }, 'Next');
  d.tickIntervals(); d.flushTimeouts();
  assert.equal(pwdIn.value, 'pw-123');
  assert.equal(next2.clicks, 1);
  // step 3: authenticator page
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/totp';
  const totpIn = d.mk('input', { type: 'tel', id: 'totpPin', name: 'totpPin' });
  const next3 = d.mk('button', { id: 'totpNext' }, 'Next');
  const realNow = d.sandbox.Date.now;
  d.sandbox.Date.now = () => 59_000; // RFC 6238 vector → 287082
  d.tickIntervals(); d.flushTimeouts();
  d.sandbox.Date.now = realNow;
  assert.equal(totpIn.value, '287082');
  assert.equal(next3.clicks, 1);
  // challenge chooser: prefers the authenticator option, else "Try another way"
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/selection';
  const other = d.mk('button', {}, 'Try another way');
  d.tickIntervals();
  assert.equal(other.clicks, 1);
  d.clearElements(); d.location.pathname = '/v3/signin/challenge/selection2';
  d.mk('button', {}, 'Get a verification code from the Google Authenticator app');
  d.tickIntervals();
  assert.equal(d.doc.querySelector('button').clicks, 1);
  // no IPC on google: nothing was sent through the bridge
  assert.equal(d.events.length, 0);
});

test('login helper on arena.ai: opens the modal, picks Google for google accounts, and finishes when the session cookie appears', async () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/' });
  const loginBtn = d.mk('button', {}, 'Login');
  const r = plain(await d.api.call('login', JSON.stringify({ creds: { accountId: 'acc1', email: 'alice@example.com', provider: 'google' } }), 'l1'));
  assert.equal(r.ok, true);
  d.flushTimeouts();
  assert.equal(loginBtn.clicks, 1, 'opened the login modal');
  assert.equal(d.lastEvent('login').payload.stage, 'arena-open');
  // the modal renders
  const google = d.mk('button', {}, 'Continue with Google');
  d.mk('input', { type: 'email', placeholder: 'Your email' });
  d.tickIntervals();
  assert.equal(google.clicks, 1, 'google provider → Continue with Google');
  assert.equal(d.lastEvent('login').payload.stage, 'arena-google');
  // …OAuth round trip happened, the session cookie is back → done + login_clear
  for (const c of chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua' }))) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  d.tickIntervals();
  assert.equal(d.lastEvent('login').payload.stage, 'done');
  assert.deepEqual(d.invokes.map((i) => i.cmd), ['login_clear']);
  assert.equal(plain(await d.api.call('status', '{}', 's')).data.running, false);
});

test('login helper on arena.ai: email flow fills the address, presses "Continue with email", then asks the user for the mailed code', async () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/' });
  const emailIn = d.mk('input', { type: 'email', placeholder: 'Your email' });
  const cont = d.mk('button', {}, 'Continue with email');
  d.mk('button', {}, 'Continue with Google');
  const r = plain(d.api.startLogin({ email: 'bob@example.com', password: 'secret', provider: 'email' }));
  assert.equal(r.started, true);
  d.flushTimeouts(); // step → fill
  assert.equal(emailIn.value, 'bob@example.com');
  d.flushTimeouts(); // submit
  assert.equal(cont.clicks, 1);
  assert.equal(d.doc.querySelectorAll('button')[1].clicks, 0, 'did not touch the Google button');
  // code step
  d.clearElements();
  const otp = d.mk('input', { autocomplete: 'one-time-code', inputmode: 'numeric' });
  d.tickIntervals();
  assert.equal(d.lastEvent('login').payload.stage, 'need-code');
  // dock relays the code typed by the user
  const f = plain(await d.api.call('fill', JSON.stringify({ code: '123456' }), 'f'));
  assert.equal(f.ok, true);
  assert.equal(otp.value, '123456');
  // password step
  d.clearElements();
  const pwd = d.mk('input', { type: 'password' });
  const submit = d.mk('button', {}, 'Log in');
  d.tickIntervals(); d.flushTimeouts();
  assert.equal(pwd.value, 'secret');
  assert.equal(submit.clicks, 1);
  // stop
  plain(await d.api.call('stop', '{}', 'x'));
  assert.equal(d.lastEvent('login').payload.stage, 'stopped');
  assert.throws(() => d.api.startLogin({}), /登录信息为空/);
});
