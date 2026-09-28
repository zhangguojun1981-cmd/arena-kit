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
  // the PKCE verifier of an OAuth round trip is not part of a session
  assert.equal(api.isAuthName('arena-auth-prod-v1-code-verifier'), false);
  assert.equal(api.isAuthName('sb-abc-auth-token-code-verifier'), false);
  assert.equal(api.isAuthName('arena-auth-prod-v1.1'), true);
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

/* The window between the swap and the next document: the old page's auth
 * client must not write its session back (frozen document.cookie), stale
 * web-storage copies go, and the next document checks the stamp. */
test('after a navigating restore the leaving page cannot write auth cookies back; web-storage session copies are purged', async () => {
  const a = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua', refresh: 'rt-a' }));
  const b = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub' }), 200);
  const local = new Map([['sb-abcdefgh-auth-token', '{"old":1}'], ['arena-auth-prod-v1', 'cache'], ['ak_theme', 'dark']]);
  const d = fakeDom({ jar: a, local });
  const res = plain(await d.api.call('restore', JSON.stringify({ cookies: b, navigate: '/' }), 'r1'));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.storageCleared, 2, 'stale session copies removed from web storage');
  assert.deepEqual([...local.keys()].filter((k) => k !== 'ak_account_cookie_scope'), ['ak_theme']);
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com');
  // the site's client answers a late token refresh for Alice → dropped
  for (const c of a) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com', 'auth-cookie writes are frozen once the page is leaving');
  d.doc.cookie = 'cf_clearance=still-fine; Path=/';
  assert.ok(d.cookies.has('|cf_clearance'), 'unrelated cookie writes still work');
  // the next document gets the expected session in sessionStorage
  const exp = JSON.parse(d.sessionStorage.getItem('arenakit.account.expect'));
  assert.equal(exp.userId, 'ub');
  assert.equal(exp.cookies.length, b.length);
  assert.equal(exp.sig, plain(d.api.snapshot()).sig);
  // clear{navigate}: no stamp (nothing to expect on a logged-out page)
  const d2 = fakeDom({ jar: a });
  await d2.api.call('clear', JSON.stringify({ navigate: true }), 'c1');
  assert.equal(d2.sessionStorage.getItem('arenakit.account.expect'), null);
  for (const c of a) d2.doc.cookie = `${c.name}=${c.value}; Path=/`;
  assert.equal(plain(d2.api.snapshot()).hasAuthCookie, false, 'frozen after clear too');
});

test('document start after a switch: the expected session is re-applied once when the cookies lost it (old account / guest / nothing), left alone when intact or rotated', () => {
  const bob = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', refresh: 'rt-b' }), 200);
  const bobRotated = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', refresh: 'rt-b2' }), 200);
  const alice = chunked('arena-auth-prod-v1', supabaseSession({ email: 'alice@example.com', id: 'ua' }));
  const sigOf = (cookies) => fakeDom({ jar: cookies }).api.sigOf(cookies.map((c) => ({ name: c.name, value: c.value })).sort((x, y) => (x.name < y.name ? -1 : 1)));
  const stamp = (over = {}) => new Map([['arenakit.account.expect', JSON.stringify({ cookies: bob, scope: 'domain', sig: sigOf(bob), userId: 'ub', at: Date.now(), ...over })]]);
  const dom = (jar, session) => fakeDom({ pathname: '/', jar: jar.map((c) => ({ ...c, domain: '.arena.ai' })), session });

  // intact → nothing to do, stamp consumed
  let d = dom(bob, stamp());
  assert.equal(d.api.bootCheck, 'intact');
  assert.deepEqual(d.navigations, []);
  assert.equal(d.sessionStorage.getItem('arenakit.account.expect'), null, 'stamp consumed');
  // the server refreshed Bob's token while serving the page → same user, keep it
  d = dom(bobRotated, stamp());
  assert.equal(d.api.bootCheck, 'rotated');
  assert.deepEqual(d.navigations, []);
  assert.equal(plain(d.api.snapshot()).sig, sigOf(bobRotated));
  // the old page wrote Alice back (late refresh answer / Set-Cookie) → re-apply Bob, load again
  d = dom(alice, stamp());
  assert.equal(d.api.bootCheck, 'reapplied:other:ua');
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com');
  assert.ok([...d.cookies.values()].filter((c) => c.name.startsWith('arena-auth')).every((c) => c.domain === '.arena.ai'), 'restored with the stamped scope');
  assert.deepEqual(d.navigations, [{ how: 'replace', url: 'https://arena.ai/' }]);
  for (const c of alice) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  assert.equal(plain(d.api.snapshot()).email, 'bob@example.com', 'writes frozen while the reload is on its way');
  // guest / no cookies at all → re-applied as well (a dead session is rejected again → the dock reports lost)
  d = dom(chunked('arena-auth-prod-v1', anonymousSession({ id: 'anon-1' })), stamp());
  assert.equal(d.api.bootCheck, 'reapplied:guest');
  d = dom([], stamp());
  assert.equal(d.api.bootCheck, 'reapplied:none');
  // the init snapshot carries the check for the dock's activity log
  d.flushTimeouts();
  assert.equal(d.lastEvent('account').payload.bootCheck, 'reapplied:none');
  // stale stamp (older than 30 s) is ignored
  d = dom(alice, stamp({ at: Date.now() - 31_000 }));
  assert.equal(d.api.bootCheck, 'expired');
  assert.equal(plain(d.api.snapshot()).email, 'alice@example.com');
  assert.deepEqual(d.navigations, []);
  // no stamp → nothing
  d = dom(alice, new Map());
  assert.equal(d.api.bootCheck, '');
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

/* Frozen clock for the helper's timers (Date is shared with the sandbox). */
function withClock(start, fn) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  try { return fn((ms) => { t += ms; }); } finally { Date.now = real; }
}
const guestJar = () => chunked('arena-auth-prod-v1', anonymousSession());
const userJar = (email, id) => chunked('arena-auth-prod-v1', supabaseSession({ email, id }));
const GOOGLE_URL = (link) => `https://arena.ai/nextjs-api/sign-in/google?shouldLinkHistory=${link}&marketingConsent=false&returnTo=%2F`;

test('snapshot classifies the page: logged-in / guest / none / broken, and reads __arena_auth_error', () => {
  assert.equal(plain(fakeDom({ jar: userJar('a@x.io', 'ua') }).api.snapshot()).state, 'logged-in');
  assert.equal(plain(fakeDom({ jar: guestJar() }).api.snapshot()).state, 'guest');
  assert.equal(plain(fakeDom().api.snapshot()).state, 'none');
  assert.equal(plain(fakeDom({ jar: [{ name: 'arena-auth-prod-v1', value: 'base64-!!!' }] }).api.snapshot()).state, 'broken');
  const err = Buffer.from(JSON.stringify({ message: 'no_user_data' })).toString('base64');
  const s = plain(fakeDom({ jar: [...guestJar(), { name: '__arena_auth_error', value: 'base64-' + err }, { name: 'arena-auth-prod-v1-code-verifier', value: 'base64-xyz' }] }).api.snapshot());
  assert.equal(s.authError, 'no_user_data');
  assert.equal(s.state, 'guest');
  assert.ok(!s.cookies.some((c) => /verifier|error/.test(c.name)), 'verifier / error cookies never saved with an account');
});

test('login helper, arena LOGGED OUT (guest) + Google account: navigates straight to /nextjs-api/sign-in/google — no dialog, no clicks', () => withClock(5_000_000, () => {
  const session = new Map();
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar(), session });
  const loginBtn = d.mk('button', {}, 'Log In');
  const google = d.mk('button', {}, 'Continue with Google');
  d.api.startLogin({ accountId: 'acc1', email: 'alice@gmail.com', provider: 'google', startedAt: Date.now() });
  d.flushTimeouts(); d.tickIntervals(); d.tickIntervals();
  assert.deepEqual(d.navigations, [{ how: 'assign', url: GOOGLE_URL(true) }], 'one full-page navigation (guest history linked)');
  assert.equal(loginBtn.clicks + google.clicks, 0, 'the dialog is never touched');
  assert.equal(d.lastEvent('login').payload.stage, 'arena-google');
  assert.equal(JSON.parse(session.get('arenakit.login.try')).n, 1, 'round trip stamped');
}));

test('login helper, arena with NO session cookie yet: waits up to 6 s for the guest session, then goes without linking history', () => withClock(6_000_000, (advance) => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/' });
  d.api.startLogin({ accountId: 'acc1', email: 'alice@gmail.com', provider: 'google', startedAt: Date.now() });
  d.flushTimeouts(); d.tickIntervals();
  assert.equal(d.navigations.length, 0);
  assert.equal(d.lastEvent('login').payload.stage, 'arena-waiting');
  advance(6500); d.tickIntervals();
  assert.deepEqual(d.navigations, [{ how: 'assign', url: GOOGLE_URL(false) }]);
}));

test('login helper, back on arena after the Google round trip: logged in → done; error cookie / still logged out → reported once, never looped', () => withClock(7_000_000, () => {
  const startedAt = Date.now();
  const creds = { accountId: 'acc1', email: 'alice@gmail.com', provider: 'google', startedAt };
  const tripped = () => new Map([['arenakit.login.try', JSON.stringify({ id: String(startedAt), n: 1, at: Date.now(), method: 'google' })]]);
  // success: the callback wrote Alice's session
  const ok = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: userJar('alice@gmail.com', 'ua'), session: tripped() });
  ok.api.startLogin(creds); ok.flushTimeouts();
  assert.equal(ok.lastEvent('login').payload.stage, 'done');
  assert.deepEqual(ok.invokes.map((i) => i.cmd), ['login_clear']);
  assert.equal(ok.navigations.length, 0);
  // failure: __arena_auth_error from the callback
  const err = Buffer.from(JSON.stringify({ message: 'no_user_data' })).toString('base64');
  const bad = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: [...guestJar(), { name: '__arena_auth_error', value: 'base64-' + err }], session: tripped() });
  bad.api.startLogin(creds); bad.flushTimeouts();
  const e = bad.lastEvent('login').payload;
  assert.equal(e.stage, 'error'); assert.match(e.error, /Arena 登录失败：no_user_data/);
  assert.equal(bad.navigations.length, 0, 'no second attempt');
  assert.deepEqual(bad.invokes.map((i) => i.cmd), ['login_clear'], 'Rust forgets the creds → no restart on the next page load');
  // cancelled on Google (back button): still a guest, no error cookie
  const back = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar(), session: tripped() });
  back.api.startLogin(creds); back.flushTimeouts(); back.tickIntervals();
  assert.match(back.lastEvent('login').payload.error, /仍未登录/);
  assert.equal(back.navigations.length, 0);
}));

test('login helper, arena LOGGED IN: never touches the page — done for the wanted account, wrong-account for another', () => {
  const same = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: userJar('Alice@Gmail.com', 'ua') });
  const btn = same.mk('button', {}, 'Log In');
  same.api.startLogin({ accountId: 'a', email: 'alice@gmail.com', provider: 'google', startedAt: Date.now() });
  same.flushTimeouts();
  assert.equal(same.lastEvent('login').payload.stage, 'done');
  assert.equal(btn.clicks, 0); assert.equal(same.navigations.length, 0);
  const other = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: userJar('bob@gmail.com', 'ub') });
  other.api.startLogin({ accountId: 'a', email: 'alice@gmail.com', provider: 'google', startedAt: Date.now() });
  other.flushTimeouts();
  const p = other.lastEvent('login').payload;
  assert.equal(p.stage, 'wrong-account'); assert.equal(p.email, 'bob@gmail.com');
  assert.equal(other.navigations.length, 0, 'no sign-in on top of another logged-in account');
});

test('login helper, email + password account: POST /nextjs-api/sign-in/email, reload on success, error text on failure, dialog when the endpoint is gone', async () => {
  const creds = { accountId: 'b', email: 'bob@example.com', password: 'secret', provider: 'email', startedAt: Date.now() };
  const run = async (reply) => {
    const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar() });
    const calls = [];
    d.sandbox.fetch = async (url, init) => { calls.push({ url, init }); return reply; };
    d.api.startLogin(creds); d.flushTimeouts();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    return { d, calls };
  };
  const okRun = await run({ ok: true, status: 200, json: async () => ({ ok: true }) });
  assert.equal(okRun.calls[0].url, '/nextjs-api/sign-in/email');
  assert.equal(okRun.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(okRun.calls[0].init.body), { email: 'bob@example.com', password: 'secret', shouldLinkHistory: true });
  assert.deepEqual(okRun.d.navigations.map((n) => n.url), ['https://arena.ai/'], 'reload into the new session');
  const badRun = await run({ ok: false, status: 400, json: async () => ({ error: 'Invalid email or password' }) });
  assert.match(badRun.d.lastEvent('login').payload.error, /Invalid email or password/);
  assert.equal(badRun.d.navigations.length, 0);
  const goneRun = await run({ ok: false, status: 404, json: async () => { throw new Error('html'); } });
  assert.equal(goneRun.d.lastEvent('login').payload.stage, 'arena-dialog');
  const emailIn = goneRun.d.mk('input', { type: 'email', name: 'email' });
  goneRun.d.tickIntervals();
  assert.equal(emailIn.value, 'bob@example.com', 'dialog fallback fills the address');
});

test('login helper, email account without password (mailed code): dialog once (+1 retry after 12 s), fill address, ask for the code', () => withClock(1_000_000, (advance) => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar() });
  const loginBtn = d.mk('button', {}, 'Log In');
  d.api.startLogin({ accountId: 'a', email: 'bob@example.com', provider: 'email', startedAt: Date.now() });
  d.flushTimeouts();
  assert.equal(loginBtn.clicks, 1);
  for (let i = 0; i < 10; i++) { advance(1000); d.tickIntervals(); }
  assert.equal(loginBtn.clicks, 1, 'no re-click inside 12 s');
  advance(3000); d.tickIntervals();
  assert.equal(loginBtn.clicks, 2, 'one retry when no dialog showed up');
  for (let i = 0; i < 30; i++) { advance(1000); d.tickIntervals(); }
  assert.equal(loginBtn.clicks, 2, 'and never again');
  // the dialog renders: email → Continue with email → code
  const emailIn = d.mk('input', { type: 'email', name: 'email' });
  const cont = d.mk('button', {}, 'Continue with email');
  d.tickIntervals(); d.flushTimeouts();
  assert.equal(emailIn.value, 'bob@example.com');
  assert.equal(cont.clicks, 1);
  d.clearElements();
  d.mk('input', { autocomplete: 'one-time-code', inputmode: 'numeric' });
  d.tickIntervals();
  assert.equal(d.lastEvent('login').payload.stage, 'need-code');
  assert.equal(d.navigations.length, 0);
}));

test('login helper yields to the user: a real tap pauses it for 10 s (no double sign-in start)', () => withClock(2_000_000, (advance) => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar() });
  d.api.startLogin({ accountId: 'a', email: 'alice@example.com', provider: 'google', startedAt: Date.now() });
  d.userEvent('pointerdown', { target: { closest: () => ({}) } });
  d.flushTimeouts(); d.tickIntervals();
  assert.equal(d.navigations.length, 0, 'helper did not start a second sign-in on top of the user');
  assert.equal(d.lastEvent('login').payload.stage, 'user-active');
  // helper-made (untrusted) events never count as the user
  advance(10_500);
  d.userEvent('pointerdown', { isTrusted: false, target: { closest: () => ({}) } });
  d.tickIntervals();
  assert.equal(d.navigations.length, 1, 'resumes after the pause');
}));

test('Google side, signed in to Google: account chooser → the target row; not listed → "Use another account"; SMS / backup / phone prompt hand over', () => {
  const creds = { accountId: 'a', email: 'alice@gmail.com', password: 'pw', provider: 'google' };
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/accountchooser' });
  d.mk('div', { 'data-identifier': 'bob@gmail.com' }, 'Bob');
  const alice = d.mk('div', { 'data-identifier': 'Alice@gmail.com' }, 'Alice');
  d.sandbox.__AK_LOGIN_APPLY__(creds); d.flushTimeouts(); d.tickIntervals();
  assert.equal(alice.clicks, 1, 'target row picked once');
  const d2 = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/accountchooser' });
  const bob = d2.mk('div', { 'data-identifier': 'bob@gmail.com' }, 'Bob');
  const another = d2.mk('li', { role: 'link' }, 'Use another account');
  d2.sandbox.__AK_LOGIN_APPLY__(creds); d2.flushTimeouts();
  assert.equal(bob.clicks, 0, 'never picks someone else');
  assert.equal(another.clicks, 1);
  // SMS code: waits for the code from the dock, then fills #idvPin (not the TOTP)
  const d3 = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/challenge/ipp' });
  const pin = d3.mk('input', { id: 'idvPin', name: 'Pin' });
  d3.sandbox.__AK_LOGIN_APPLY__({ ...creds, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }); d3.flushTimeouts();
  assert.equal(pin.value, '', 'an SMS pin never gets the TOTP code');
  d3.api.call('fill', JSON.stringify({ code: '445566' }), 'f'); d3.flushTimeouts();
  assert.equal(pin.value, '445566');
  // backup-code page without a TOTP secret, and a phone prompt → the user
  const d4 = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/challenge/bc' });
  d4.mk('input', { id: 'backupCodePinInput' });
  let stage = '';
  d4.sandbox.console = { debug: (_t, p) => { stage = p.stage; }, log() {}, warn() {}, error() {} };
  d4.sandbox.__AK_LOGIN_APPLY__(creds); d4.flushTimeouts();
  assert.equal(stage, 'need-backup');
  // method chooser with data-challengetype: Authenticator (6) for a TOTP account
  const d5 = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/challenge/selection' });
  d5.mk('div', { 'data-challengetype': '9' }, 'Get a text message');
  const auth = d5.mk('div', { 'data-challengetype': '6' }, 'Get a code');
  d5.sandbox.__AK_LOGIN_APPLY__({ ...creds, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }); d5.flushTimeouts();
  assert.equal(auth.clicks, 1);
});

test('Google sign-in rescue: same URL 25 s after a tap on an account row → 重试 / 返回 Arena bar; typing clears it', () => withClock(3_000_000, (advance) => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/accountchooser' });
  assert.equal(d.api.checkStall(), '', 'nothing before any tap');
  const row = d.mk('div', { 'data-identifier': 'alice@gmail.com' }, 'Alice');
  d.userEvent('pointerdown', { target: { closest: () => row } });
  advance(20_000);
  assert.equal(d.api.checkStall(), '', 'still within the grace period');
  advance(6_000);
  assert.equal(d.api.checkStall(), 'stall');
  const bar = d.doc.getElementById('ak-login-rescue');
  assert.ok(bar, 'rescue bar shown');
  const labels = bar.children.map((c) => c.textContent);
  assert.deepEqual(labels.slice(1), ['重试', '返回 Arena']);
  assert.match(labels[0], /卡住/);
  // 返回 Arena → leaves for arena.ai
  bar.children[2].listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(d.location.href, 'https://arena.ai/');
  // typing on the page = the user is busy → the timer and the bar go away
  d.location.href = 'https://accounts.google.com/v3/signin/accountchooser';
  d.userEvent('keydown', { key: 'a' });
  assert.equal(d.api.checkStall(), '');
  assert.equal(d.doc.getElementById('ak-login-rescue'), null);
  // a tap into a field does not start the timer either
  d.userEvent('pointerdown', { target: { closest: () => null } });
  advance(60_000);
  assert.equal(d.api.checkStall(), '');
}));

test('Google sign-in rescue: a pop-up-mode page without an opener is flagged at once (it can never report back in the app)', () => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/o/oauth2/v2/auth' });
  d.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&ux_mode=popup&redirect_uri=storagerelay%3A%2F%2Fhttps%2Farena.ai';
  assert.equal(d.api.checkStall(), 'popup');
  const bar = d.doc.getElementById('ak-login-rescue');
  assert.ok(bar);
  assert.deepEqual(bar.children.slice(1).map((c) => c.textContent), ['返回 Arena']);
  // a real pop-up (has an opener) is left alone
  const d2 = fakeDom({ hostname: 'accounts.google.com', pathname: '/o/oauth2/v2/auth' });
  d2.location.href = d.location.href;
  d2.sandbox.opener = {};
  assert.equal(d2.api.checkStall(), '');
  // never on arena itself
  assert.equal(fakeDom({ hostname: 'arena.ai', pathname: '/' }).api.checkStall(), '');
});
