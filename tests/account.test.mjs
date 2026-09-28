import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { jwt, supabaseSession, anonymousSession, chunked, fakeDom } from './account-fixture.mjs';

/* injected/account.js: Supabase cookie → identity, snapshot / restore /
 * clear on a document.cookie jar, watcher events, and the one-tap re-login on
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

test('watcher does not run on foreign hosts (accounts.google.com has no IPC)', () => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/identifier' });
  d.flushTimeouts(); d.tickIntervals();
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
const GOOGLE_URL = (link) => `https://arena.ai/nextjs-api/sign-in/google?shouldLinkHistory=${link}&marketingConsent=false&returnTo=%2Fagent`;

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

/* ── one-tap re-login (0.4.9): the manual Google round trip, automated ── */
const ALICE = (extra = {}) => ({ accountId: 'acc-a', email: 'alice@gmail.com', startedAt: Date.now(), ...extra });
const stages = (d) => d.events.filter((e) => e.name === 'login').map((e) => e.payload.stage);
const run = (d, n = 1) => { for (let i = 0; i < n; i++) { d.flushTimeouts(); d.tickIntervals(); } };

test('re-login needs the account email; no password / TOTP is accepted or kept', () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar() });
  assert.throws(() => d.api.startLogin({ accountId: 'x' }), /邮箱/);
  const r = plain(d.sandbox.__AK_LOGIN_APPLY__({ accountId: 'x', email: '' }));
  assert.equal(r.started, false);
  assert.equal(typeof d.api.googleSignInUrl, 'function');
  assert.equal(d.sandbox.__AK_TOTP__, undefined, 'the TOTP lib is gone');
});

test('re-login on arena: stale session cookies dropped, then the Google sign-in URL WITHOUT linking history; the site\'s own buttons are never clicked', () => withClock(5_000_000, () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: [...guestJar(), { name: '_ga', value: 'keep' }] });
  const loginBtn = d.mk('button', {}, 'Login');
  const googleBtn = d.mk('button', {}, 'Continue with Google');
  d.api.startLogin(ALICE());
  run(d);
  assert.equal(loginBtn.clicks + googleBtn.clicks, 0);
  assert.equal(plain(d.api.snapshot()).hasAuthCookie, false, 'the dead / guest session is gone before Google');
  assert.ok(d.cookies.has('|_ga'), 'unrelated cookies kept');
  assert.deepEqual(d.navigations.map((n) => n.url), [GOOGLE_URL('false')]);
  assert.equal(stages(d).at(-1), 'arena-google');
  assert.equal(JSON.parse(d.sessionStorage.getItem('arenakit.relogin.try')).n, 1, 'round trip recorded');
  run(d, 5);
  assert.equal(d.navigations.length, 1, 'no second OAuth start while Google loads');
  // the leaving page cannot write the stale session back
  for (const c of guestJar()) d.doc.cookie = `${c.name}=${c.value}; Path=/`;
  assert.equal(plain(d.api.snapshot()).hasAuthCookie, false);
}));

test('re-login: an auth route answering {"error":"Auth session missing!"} → one fresh attempt, then the error text and back to /agent', () => withClock(5_100_000, () => {
  const session = new Map();
  const c = ALICE();
  const page1 = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: guestJar(), session });
  page1.api.startLogin(c); run(page1);
  assert.equal(page1.navigations.length, 1);
  // the sign-in route answered JSON instead of redirecting
  const errPage = () => {
    const p = fakeDom({ hostname: 'arena.ai', pathname: '/nextjs-api/sign-in/google', jar: guestJar(), session });
    p.doc.body = { textContent: '{"error":"Auth session missing!"}' };
    p.sandbox.__AK_LOGIN_APPLY__(c); run(p);
    return p;
  };
  const p2 = errPage();
  assert.deepEqual(p2.navigations.map((n) => n.url), [GOOGLE_URL('false')], 'retried once with the cookies cleared again');
  assert.equal(stages(p2).at(-1), 'arena-retry');
  assert.equal(plain(p2.api.snapshot()).hasAuthCookie, false);
  const p3 = errPage();
  const ev = p3.lastEvent('login').payload;
  assert.equal(ev.stage, 'error');
  assert.match(ev.error, /Auth session missing!/);
  assert.deepEqual(p3.navigations.map((n) => n.how + ' ' + n.url), ['replace /agent'], 'no raw JSON page left on screen');
  assert.ok(p3.invokes.some((i) => i.cmd === 'login_clear'));
  // an empty body on an auth route = a redirect in progress → wait
  const p4 = fakeDom({ hostname: 'arena.ai', pathname: '/nextjs-api/callback/google', session: new Map() });
  p4.sandbox.__AK_LOGIN_APPLY__(ALICE()); run(p4);
  assert.equal(stages(p4).at(-1), 'arena-waiting');
  assert.equal(p4.navigations.length, 0);
}));

test('add mode: no email needed; on arena it goes to Google the same way; any logged-in account completes it', () => withClock(5_200_000, () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: guestJar() });
  assert.equal(plain(d.sandbox.__AK_LOGIN_APPLY__({ mode: 'add', startedAt: Date.now() })).started, true);
  run(d);
  assert.deepEqual(d.navigations.map((n) => n.url), [GOOGLE_URL('false')]);
  assert.equal(stages(d).at(-1), 'arena-add');
  const back = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: userJar('new@gmail.com', 'un') });
  back.sandbox.__AK_LOGIN_APPLY__({ mode: 'add', startedAt: Date.now() }); run(back);
  assert.equal(stages(back).at(-1), 'done');
}));

test('re-login, back on arena after Google: right account → done + login_clear; wrong → wrong-account; still logged out → error once, never loops', () => withClock(7_000_000, () => {
  const tried = (startedAt) => new Map([['arenakit.relogin.try', JSON.stringify({ id: String(startedAt), n: 1, at: Date.now(), how: 'button' })]]);
  const c = ALICE();
  const ok = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: userJar('Alice@gmail.com', 'ua'), session: tried(c.startedAt) });
  ok.sandbox.__AK_LOGIN_APPLY__(c); run(ok);
  assert.equal(stages(ok).at(-1), 'done');
  assert.ok(ok.invokes.some((i) => i.cmd === 'login_clear'));
  assert.equal(ok.sessionStorage.getItem('arenakit.relogin.try'), null);
  const other = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: userJar('bob@gmail.com', 'ub') });
  other.sandbox.__AK_LOGIN_APPLY__(c); run(other);
  const ev = other.lastEvent('login').payload;
  assert.equal(ev.stage, 'wrong-account');
  assert.equal(ev.email, 'bob@gmail.com');
  const lost = fakeDom({ hostname: 'arena.ai', pathname: '/agent', jar: guestJar(), session: tried(c.startedAt) });
  const btn = lost.mk('button', {}, 'Login');
  lost.sandbox.__AK_LOGIN_APPLY__(c); run(lost, 4);
  assert.deepEqual(stages(lost), ['error']);
  assert.equal(btn.clicks, 0, 'no second round trip');
  assert.equal(lost.navigations.length, 0);
  assert.ok(lost.invokes.some((i) => i.cmd === 'login_clear'));
}));

test('re-login yields to the user: a real tap pauses it for 10 s', () => withClock(8_000_000, (advance) => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: guestJar() });
  d.api.startLogin(ALICE());
  d.userEvent('pointerdown', {});
  run(d);
  assert.equal(d.navigations.length, 0);
  assert.equal(stages(d).at(-1), 'user-active');
  advance(10_500);
  d.userEvent('pointerdown', { isTrusted: false }); // our own clicks never count
  run(d);
  assert.equal(d.navigations.length, 1, 'resumes after the pause');
}));

test('Google side: account chooser → the target row; confirmation → 继续 (not the account chip); each once', () => {
  const d = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/accountchooser' });
  const bob = d.mk('div', { 'data-identifier': 'bob@gmail.com' }, 'Bob');
  const alice = d.mk('div', { 'data-identifier': 'Alice@Gmail.com' }, 'Alice');
  d.mk('div', { role: 'link' }, 'Use another account');
  assert.equal(plain(d.sandbox.__AK_LOGIN_APPLY__(ALICE())).started, true);
  run(d, 3);
  assert.equal(alice.clicks, 1, 'target picked once');
  assert.equal(bob.clicks, 0);
  assert.match(d.doc.getElementById('ak-relogin-bar').children[0].textContent, /已选择 alice@gmail.com/);
  // confirmation page: the chosen account chip + 继续
  d.clearElements(); d.location.pathname = '/signin/oauth/id';
  const chip = d.mk('div', { 'data-identifier': 'alice@gmail.com' }, 'alice@gmail.com');
  d.mk('button', {}, 'Cancel');
  const cont = d.mk('button', {}, '继续');
  run(d, 3);
  assert.equal(cont.clicks, 1);
  assert.equal(chip.clicks, 0);
  assert.equal(d.events.length, 0, 'no IPC on google');
});

test('Google side hands over: account not in the chooser, password / 2FA pages, disallowed_useragent — nothing typed or clicked', () => {
  const notListed = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/accountchooser' });
  const bob = notListed.mk('div', { 'data-identifier': 'bob@gmail.com' }, 'Bob');
  const another = notListed.mk('div', { role: 'link' }, 'Use another account');
  notListed.sandbox.__AK_LOGIN_APPLY__(ALICE()); run(notListed, 3);
  assert.equal(bob.clicks + another.clicks, 0);
  const bar = notListed.doc.getElementById('ak-relogin-bar');
  assert.match(bar.children[0].textContent, /没有 alice@gmail.com/);
  assert.equal(bar.children[1].textContent, '返回 Arena');
  const pwd = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/challenge/pwd' });
  const input = pwd.mk('input', { type: 'password', name: 'Passwd' });
  const next = pwd.mk('button', {}, 'Continue');
  pwd.sandbox.__AK_LOGIN_APPLY__(ALICE()); run(pwd, 3);
  assert.equal(input.value, '', 'no password typed');
  assert.equal(next.clicks, 0, 'a Continue next to a password field is the user\'s');
  assert.match(pwd.doc.getElementById('ak-relogin-bar').children[0].textContent, /手动完成/);
  const blocked = fakeDom({ hostname: 'accounts.google.com', pathname: '/signin/rejected' });
  blocked.mk('h1', {}, 'Couldn\'t sign you in: This browser or app may not be secure');
  blocked.sandbox.__AK_LOGIN_APPLY__(ALICE()); run(blocked);
  assert.match(blocked.doc.getElementById('ak-relogin-bar').children[0].textContent, /disallowed_useragent/);
});

test('re-login on arena that is already logged in as the target: done, the page is not touched', () => {
  const d = fakeDom({ hostname: 'arena.ai', pathname: '/', jar: userJar('alice@gmail.com', 'ua') });
  const btn = d.mk('button', {}, 'Login');
  d.api.startLogin(ALICE()); run(d);
  assert.equal(stages(d).at(-1), 'done');
  assert.equal(btn.clicks, 0);
  assert.equal(d.navigations.length, 0);
});
