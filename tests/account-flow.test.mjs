import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { supabaseSession, anonymousSession, chunked, fakeDom, settle } from './account-fixture.mjs';
import { createRpc } from '../src/lib/rpc.js';
import { createAccountFlow } from '../src/lib/account-flow.js';

/* End-to-end 账号 journeys, as close to the device as the sandbox allows:
 * the real injected/account.js runs on a document.cookie jar, the real RPC
 * (src/lib/rpc.js) carries dock → page calls and the `account-result` /
 * `account` bridge events back, and the real flow (src/lib/account-flow.js)
 * drives it — exactly what dock.js wires up. A "device" keeps what survives
 * a page reload (cookie jar, the `accounts` store, Rust's pending login),
 * `boot()` is one page load (fresh page + fresh dock, like Android's
 * embedded dock). Not covered here, by nature: the real arena.ai / Google
 * DOM, Rust on_page_load, and whether the server accepts the swapped
 * refresh token — see docs/DEVELOPMENT.md → 账号. */

const DOMAIN = '.arena.ai';
const cookiesOf = (page) => [...page.cookies.values()].map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
const sessionJar = (opts, extra = []) => chunked('arena-auth-prod-v1', supabaseSession(opts)).map((c) => ({ ...c, domain: DOMAIN })).concat(extra);
const setSiteCookies = (page, opts) => { for (const c of chunked('arena-auth-prod-v1', supabaseSession(opts))) page.doc.cookie = `${c.name}=${c.value}; Path=/; Domain=${DOMAIN}`; };
/* What the site does on a logged-out page: sign the visitor in anonymously. */
const setGuestCookies = (page, id = 'anon-' + Math.random().toString(36).slice(2, 8)) => { for (const c of chunked('arena-auth-prod-v1', anonymousSession({ id }))) page.doc.cookie = `${c.name}=${c.value}; Path=/; Domain=${DOMAIN}`; };
/* The server rejecting a restored session on the page load after a switch:
 * the site removes the auth cookies (and, when `guest`, signs the visitor in
 * anonymously). account.js re-applies the expected session once at document
 * start and loads again (`reapplied:…`), so the rejection happens twice
 * before the dock sees the outcome — exactly one extra page load. */
function rejectRestoredSession(dev, { guest = null } = {}) {
  const reject = () => { dev.jar = dev.jar.filter((c) => !c.name.startsWith('arena-auth')).concat(guest ? chunked('arena-auth-prod-v1', anonymousSession({ id: guest })).map((c) => ({ ...c, domain: DOMAIN })) : []); };
  reject();
  const retry = boot(dev); // document start: stamp present, expected identity gone → re-apply + navigate
  assert.match(retry.page.api.bootCheck, /^reapplied:(none|guest)$/, 'account.js re-applied the expected session once: ' + retry.page.api.bootCheck);
  assert.equal(retry.page.navigations.at(-1) && retry.page.navigations.at(-1).how, 'replace');
  dev.jar = cookiesOf(retry.page);
  reject(); // …and the server rejects it again
  assert.equal(dev.session.has('arenakit.account.expect'), false, 'the stamp is consumed — no second attempt');
}
const refreshTokenOf = (acc) => JSON.parse(Buffer.from(acc.cookies.map((c) => c.value).join('').slice('base64-'.length), 'base64url').toString()).refresh_token;

function device(jar = []) {
  return { jar, store: new Map(), rust: { login: null, invokes: [] }, reloads: 0, navigations: [], session: new Map() /* sessionStorage survives navigations */ };
}
/* One page load: page (account.js on the device jar) + dock side (rpc + flow). */
function boot(dev, { hostname = 'arena.ai', pathname = '/' } = {}) {
  const page = fakeDom({ hostname, pathname, jar: dev.jar, session: dev.session });
  const log = { status: [], loginStatus: [], toast: [], needLogin: [], navigating: [], saves: 0 };
  // the page leaving on its own (restore / clear with `navigate`) = a reload
  // of the device onto the new URL; the dock's reload() dep is the fallback
  page.location.replace = (url) => { dev.reloads++; dev.navigations.push(url); dev.jar = cookiesOf(page); page.clearElements(); };
  let flow = null;
  const rpc = createRpc({ send: (action, argsJson, reqId) => { page.api.call(action, argsJson, reqId); }, timeoutMs: 2000 });
  // page → dock bridge (Rust relays these as page events in the app)
  page.sandbox.__ARENAKIT__.send = (name, payload) => {
    const p = plain(payload);
    page.events.push({ name, payload: p });
    if (name === 'account-result') rpc.deliver(p);
    else if (name === 'account' && flow) flow.onSnapshot(p);
    return Promise.resolve();
  };
  const invoke = (cmd, args) => {
    dev.rust.invokes.push({ cmd, args: plain(args || {}) });
    if (cmd === 'login_set') dev.rust.login = plain(args.creds);
    if (cmd === 'login_clear') dev.rust.login = null;
    return Promise.resolve(null);
  };
  page.sandbox.__ARENAKIT__.invoke = invoke; // account.js finish('done') → login_clear
  flow = createAccountFlow({
    call: (action, args, opts) => rpc.call(action, args, opts),
    loadStore: async () => (dev.store.has('accounts') ? JSON.parse(dev.store.get('accounts')) : null),
    saveStore: async (st) => { log.saves++; dev.store.set('accounts', JSON.stringify(st)); },
    reload: async () => { dev.reloads++; dev.navigations.push('reload:' + page.location.pathname); dev.jar = cookiesOf(page); page.clearElements(); },
    navigating: (url, source) => log.navigating.push(source + ':' + url),
    invoke,
    status: (t) => log.status.push(t),
    loginStatus: (t) => log.loginStatus.push(t),
    toast: (t) => log.toast.push(t),
    needLogin: (a) => log.needLogin.push(a.id),
    sleep: async () => {},
  });
  return { page, flow, rpc, log, dev };
}
/* Boot + what dock.js does right after: load the store, let account.js
 * announce the page's session (800 ms init timer), then the dock's own
 * snapshot probe. */
async function start(dev, opts) {
  const app = boot(dev, opts);
  await app.flow.load();
  app.page.flushTimeouts();
  await settle();
  await app.flow.onSnapshot(await app.rpc.call('snapshot', {}));
  await settle();
  return app;
}
const stored = (dev) => JSON.parse(dev.store.get('accounts'));

test('first run: the logged-in account is recorded automatically (once) and persisted', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }, [{ name: 'cf_clearance', value: 'keep', domain: '' }]));
  const app = await start(dev);
  const st = app.flow.accounts;
  assert.equal(st.list.length, 1);
  assert.equal(st.activeId, st.list[0].id);
  assert.equal(st.list[0].email, 'alice@example.com');
  assert.equal(st.list[0].userId, 'ua');
  assert.equal(st.list[0].provider, 'google');
  assert.ok(st.list[0].cookies.length >= 2, 'the chunked session cookies are saved');
  assert.equal(st.list[0].sig, plain(app.page.api.snapshot()).sig);
  assert.deepEqual(stored(dev).list.map((a) => a.email), ['alice@example.com'], 'persisted in the accounts store');
  assert.equal(app.log.saves, 1, 'init announce + dock probe carry the same session → saved once');
  assert.match(app.log.status.at(-1), /已自动保存当前账号 Alice/);
  assert.equal(app.flow.snap.scope, 'domain', 'account.js detected the site\'s Domain=.arena.ai scope');
});

test('journey: add a second account, watcher keeps it fresh across token rotation, one-click switch back, then switch again', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }, [{ name: 'cf_clearance', value: 'keep', domain: '' }]));
  let app = await start(dev);
  const aliceId = app.flow.accounts.activeId;

  // ── 添加另一个账号: current session kept, page cleared, page leaves for the root ──
  const add = await app.flow.add();
  assert.equal(add.ok, true);
  assert.equal(add.via, 'page');
  assert.equal(plain(app.page.api.snapshot()).hasAuthCookie, false, 'page auth cookies cleared');
  assert.ok(app.page.cookies.has('|cf_clearance'), 'unrelated cookies kept');
  assert.equal(dev.reloads, 1);
  assert.equal(dev.navigations.at(-1), 'https://arena.ai/agent');
  assert.equal(stored(dev).pending.type, 'add', 'the pending add survives the reload in the store');
  assert.equal(stored(dev).list.find((a) => a.id === aliceId).cookies.length > 0, true, 'Alice\'s session is still saved');
  assert.ok(dev.rust.invokes.some((i) => i.cmd === 'login_clear'));

  // ── reload: logged-out page, pending add → waiting for the user to log in ──
  app = await start(dev);
  assert.equal(app.flow.accounts.pending.type, 'add');
  assert.match(app.log.status.at(-1), /请在页面中登录另一个账号/);
  assert.equal(app.flow.accounts.activeId, null, 'a logged-out page has no current account');
  assert.ok(app.flow.find(aliceId), 'Alice is still in the list');

  // ── the site signs the visitor in anonymously (guest cookies appear): NOT an account ──
  setGuestCookies(app.page, 'anon-1');
  app.page.tickIntervals();
  await settle();
  assert.equal(app.flow.accounts.list.length, 1, 'guest session did not become a record');
  assert.equal(app.flow.accounts.pending.type, 'add', 'still waiting for a real login');
  assert.equal(app.flow.accounts.activeId, null);
  assert.equal(app.flow.snap.anonymous, true);
  assert.match(app.log.status.at(-1), /游客状态不会被记录/);

  // ── the user logs in as Bob (the site writes the cookies) → watcher → added ──
  setSiteCookies(app.page, { email: 'bob@example.com', id: 'ub', name: 'Bob', refresh: 'rt-b1' });
  app.page.tickIntervals();
  await settle();
  let st = app.flow.accounts;
  assert.equal(st.list.length, 2);
  assert.equal(st.pending, null);
  const bob = st.list.find((a) => a.email === 'bob@example.com');
  assert.equal(st.activeId, bob.id);
  assert.match(app.log.toast.at(-1), /已保存账号 bob@example.com/);
  assert.deepEqual(stored(dev).list.map((a) => a.email).sort(), ['alice@example.com', 'bob@example.com']);

  // ── Supabase rotates Bob's refresh token: the saved copy follows ──
  assert.equal(refreshTokenOf(bob), 'rt-b1');
  setSiteCookies(app.page, { email: 'bob@example.com', id: 'ub', name: 'Bob', refresh: 'rt-b2' });
  app.page.tickIntervals();
  await settle();
  assert.equal(refreshTokenOf(app.flow.find(bob.id)), 'rt-b2', 'rotation picked up by the watcher and persisted');
  assert.equal(refreshTokenOf(stored(dev).list.find((a) => a.id === bob.id)), 'rt-b2');

  // ── one-click switch back to Alice: cookie swap + the page leaves for the site root ──
  const sw = await app.flow.switchTo(aliceId);
  assert.deepEqual(sw, { ok: true, mode: 'cookies', via: 'page' });
  const pageNow = plain(app.page.api.snapshot());
  assert.equal(pageNow.email, 'alice@example.com', 'the page jar now holds Alice\'s session');
  assert.ok(cookiesOf(app.page).filter((c) => c.name.startsWith('arena-auth')).every((c) => c.domain === DOMAIN), 'restored with the site\'s Domain scope');
  assert.equal(dev.reloads, 2);
  assert.equal(dev.navigations.at(-1), 'https://arena.ai/agent', 'lands on the Agent composer, not on Bob\'s conversation');
  assert.deepEqual(app.log.navigating, ['switch:/agent'], 'dock showed the loading state instead of reloading again');
  assert.equal(stored(dev).pending.type, 'switch');
  assert.equal(stored(dev).pending.id, aliceId);
  assert.equal(refreshTokenOf(stored(dev).list.find((a) => a.id === bob.id)), 'rt-b2', 'Bob (the account we left) was snapshotted before the swap');
  assert.match(app.log.status.at(-1), /正在切换到 Alice/);

  // ── reload: the first snapshot decides the outcome ──
  app = await start(dev);
  st = app.flow.accounts;
  assert.equal(st.pending, null);
  assert.equal(st.activeId, aliceId);
  assert.match(app.log.toast.at(-1), /已切换到 Alice/);
  assert.ok(dev.rust.invokes.filter((i) => i.cmd === 'login_clear').length >= 2);

  // ── and straight back to Bob (his fresh rt-b2 cookies) ──
  const sw2 = await app.flow.switchTo(bob.id);
  assert.equal(sw2.ok, true);
  assert.equal(plain(app.page.api.snapshot()).email, 'bob@example.com');
  app = await start(dev);
  assert.equal(app.flow.accounts.activeId, bob.id);
  assert.equal(refreshTokenOf(app.flow.active()), 'rt-b2');
  assert.match(app.log.toast.at(-1), /已切换到 Bob/);
});

/* The race that used to lose a session: the site rotates the CURRENT
 * account's refresh token between the dock's snapshot and the cookie swap.
 * The page refuses the stale swap (expectSig), the dock saves the newer
 * tokens, retries — and the account we left keeps its live refresh token. */
test('switch: a token rotation between snapshot and restore is caught (expectSig) — the account being left is saved with its newest token', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice', refresh: 'rt-a1' }));
  const app = await start(dev);
  const aliceId = app.flow.accounts.activeId;
  await app.flow.save({ ...app.flow.accounts, list: app.flow.accounts.list.concat([{ id: 'bob', userId: 'ub', email: 'bob@example.com', cookies: chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', refresh: 'rt-b' })), login: { email: '', password: '', totp: '', auto: true } }]) });
  // rotate Alice's token the moment the first restore arrives (before it runs)
  const realCall = app.page.api.call;
  let restores = 0;
  app.page.api.call = (action, argsJson, reqId) => {
    if (action === 'restore' && ++restores === 1) setSiteCookies(app.page, { email: 'alice@example.com', id: 'ua', name: 'Alice', refresh: 'rt-a2' });
    return realCall(action, argsJson, reqId);
  };
  const r = await app.flow.switchTo('bob');
  assert.deepEqual(r, { ok: true, mode: 'cookies', via: 'page' });
  assert.equal(restores, 2, 'first restore refused as stale, second went through');
  assert.equal(refreshTokenOf(stored(dev).list.find((a) => a.id === aliceId)), 'rt-a2', 'Alice saved with the rotated token, not the snapshot\'s');
  assert.equal(plain(app.page.api.snapshot()).email, 'bob@example.com');
  assert.equal(stored(dev).pending.type, 'switch');
  assert.equal(dev.navigations.at(-1), 'https://arena.ai/agent');
});

/* Guest sessions from older builds were saved as accounts (a user id, no
 * email). They are dropped on load, and a page that falls back to the guest
 * state after a switch is judged 'lost' (not 'other account'). */
test('guest leftovers are purged from the store; a switch that lands in the guest state is reported as lost', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  dev.store.set('accounts', JSON.stringify({ list: [
    { id: 'g1', userId: 'anon-111', email: '', cookies: [{ name: 'arena-auth-prod-v1.0', value: 'base64-x' }], login: { email: '', password: '', totp: '', auto: true } },
    { id: 'g2', userId: 'anon-222', cookies: [], login: {} },
    { id: 'bob', userId: 'ub', email: 'bob@example.com', cookies: chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', refresh: 'rt-b' })), login: { email: '', password: '', totp: '', auto: true } },
  ], activeId: 'g1', pending: null }));
  let app = await start(dev);
  assert.deepEqual(app.flow.accounts.list.map((a) => a.id).filter((id) => id.startsWith('g')), [], 'guest records gone');
  assert.equal(app.flow.accounts.list.length, 2, 'Bob + Alice (auto-recorded)');
  // switch to Bob; the server rejects his token → the site falls back to a guest session
  const sw = await app.flow.switchTo('bob');
  assert.equal(sw.ok, true);
  rejectRestoredSession(dev, { guest: 'anon-333' });
  app = await start(dev);
  assert.equal(app.flow.accounts.list.length, 2, 'no guest record created');
  assert.equal(app.flow.accounts.activeId, null);
  assert.ok(app.log.status.some((t) => /bob@example.com 的登录状态已失效（页面回到了游客状态），已清除失效的会话/.test(t)), app.log.status.join(' | '));
  assert.deepEqual(app.flow.find('bob').cookies, [], 'the rejected session is forgotten');
  // Bob has no typed credentials but an identity email: the helper still
  // starts (opens the dialog, picks the provider, fills the address; the
  // password is typed on the page) instead of leaving the user stranded.
  assert.deepEqual(app.flow.accounts.pending && { type: app.flow.accounts.pending.type, id: app.flow.accounts.pending.id }, { type: 'login', id: 'bob' });
  assert.equal(dev.rust.login && dev.rust.login.email, 'bob@example.com');
  assert.equal(dev.rust.login && dev.rust.login.password, '');
  assert.match(app.log.loginStatus.at(-1), /未保存密码，请在登录页面输入/);
  assert.equal((await app.rpc.call('status', {})).running, true, 'page-side helper running on the guest page');
  await app.flow.stopLogin();
  assert.equal(app.flow.accounts.pending, null);
  assert.equal(await app.flow.saveCurrent(), null);
  assert.match(app.log.status.at(-1), /游客状态/);
});

test('post-switch verification: the site throwing the restored session away seconds after a confirmed switch is reported as lost (not after the window)', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  let app = await start(dev);
  const bobCookies = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', name: 'Bob', refresh: 'rt-b' }));
  await app.flow.save({ ...app.flow.accounts, list: app.flow.accounts.list.concat([{ id: 'bob', userId: 'ub', email: 'bob@example.com', name: 'Bob', provider: 'google', cookies: bobCookies, capturedAt: Date.now(), login: { email: '', password: '', totp: '', auto: false } }]) });
  assert.equal((await app.flow.switchTo('bob')).ok, true);
  // new page: Bob's cookies are there → first snapshot confirms the switch
  app = await start(dev);
  assert.equal(app.flow.accounts.activeId, 'bob');
  assert.ok(app.log.toast.some((t) => /已切换到 Bob/.test(t)), app.log.toast.join(' | '));
  assert.equal(app.flow.verify && app.flow.verify.id, 'bob', 'verification window armed');
  // 3 s later the site's auth client failed to refresh the token: sign-out + anonymous re-login
  for (const c of [...app.page.cookies.values()]) if (c.name.startsWith('arena-auth')) app.page.cookies.delete((c.domain || '') + '|' + c.name);
  setGuestCookies(app.page, 'anon-777');
  app.page.tickIntervals(); // watcher poll
  await settle();
  assert.equal(app.flow.verify, null);
  assert.deepEqual(app.flow.find('bob').cookies, [], 'rejected session forgotten');
  assert.equal(app.flow.accounts.activeId, null);
  assert.ok(app.log.status.some((t) => /Bob 的登录状态已失效（页面回到了游客状态），已清除失效的会话/.test(t)), app.log.status.join(' | '));
  assert.match(app.log.status.at(-1), /请点该账号的「登录」/, 'auto = false → no helper, just the hint');
  assert.equal(app.flow.accounts.pending, null);
  assert.equal(app.flow.accounts.list.length, 2, 'no guest record');

  // the same guest snapshot AFTER the window is a plain logout: nothing is dropped
  await app.flow.save({ ...app.flow.accounts, list: app.flow.accounts.list.map((a) => (a.id === 'bob' ? { ...a, cookies: bobCookies } : a)) });
  const realNow = Date.now;
  try {
    app.flow.verify = { id: 'bob', until: realNow() - 1 };
    setGuestCookies(app.page, 'anon-778');
    app.page.tickIntervals();
    await settle();
    assert.equal(app.flow.verify, null);
    assert.ok(app.flow.find('bob').cookies.length > 0, 'session kept after the window');
  } finally { Date.now = realNow; }
});

test('switch race: the old page cannot write its session back after the swap, and a Set-Cookie that undid the swap in flight is repaired on the next document start', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  let app = await start(dev);
  const bobCookies = chunked('arena-auth-prod-v1', supabaseSession({ email: 'bob@example.com', id: 'ub', name: 'Bob', refresh: 'rt-b' }), 200);
  await app.flow.save({ ...app.flow.accounts, list: app.flow.accounts.list.concat([{ id: 'bob', userId: 'ub', email: 'bob@example.com', name: 'Bob', provider: 'google', cookies: bobCookies, capturedAt: Date.now(), login: { email: '', password: '', totp: '', auto: true } }]) });
  const aliceJar = dev.jar.slice();
  assert.equal((await app.flow.switchTo('bob')).ok, true);
  assert.equal(dev.navigations.at(-1), 'https://arena.ai/agent');
  // (a) a late token-refresh answer in the OLD page tries to write Alice back → dropped
  for (const c of aliceJar) app.page.doc.cookie = `${c.name}=${c.value}; Path=/; Domain=${DOMAIN}`;
  assert.equal(plain(app.page.api.snapshot()).email, 'bob@example.com', 'leaving page cannot write auth cookies');
  // (b) something we cannot intercept (a Set-Cookie on one of the old page's
  // late requests) put Alice's cookies back before the new document loaded
  dev.jar = aliceJar;
  const retry = boot(dev);
  assert.equal(retry.page.api.bootCheck, 'reapplied:other:ua');
  assert.equal(plain(retry.page.api.snapshot()).email, 'bob@example.com', 'Bob re-applied before the site\'s scripts run');
  assert.deepEqual(retry.page.navigations.map((n) => n.how + ' ' + n.url), ['replace https://arena.ai/'], 'one more load with the right cookies');
  dev.jar = cookiesOf(retry.page);
  // the load after that: Bob, confirmed; the check is visible in the dock's status log
  app = await start(dev);
  assert.equal(app.flow.accounts.activeId, 'bob');
  assert.ok(app.log.toast.some((t) => /已切换到 Bob/.test(t)), app.log.toast.join(' | '));
  assert.equal(app.page.api.bootCheck, '', 'stamp consumed by the repair — no loop');
});

test('switching to an account whose saved session is dead falls back to the login helper (Rust keeps the credentials for accounts.google.com)', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  let app = await start(dev);
  // Carol: an older saved session (cookies present) + credentials for auto-login
  const carolCookies = chunked('arena-auth-prod-v1', supabaseSession({ email: 'carol@gmail.com', id: 'uc', name: 'Carol', refresh: 'rt-stale' }));
  const seeded = { ...app.flow.accounts, list: app.flow.accounts.list.concat([{ id: 'carol', userId: 'uc', email: 'carol@gmail.com', name: 'Carol', provider: 'google', cookies: carolCookies, capturedAt: Date.now() - 86_400_000, login: { email: 'carol@gmail.com', password: 'pw-c', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', auto: true } }]) };
  await app.flow.save(seeded);
  assert.equal(await app.flow.switchTo('carol').then((r) => r.mode), 'cookies');
  assert.equal(plain(app.page.api.snapshot()).email, 'carol@gmail.com');

  // The server rejected the stale refresh token: after the reload the site
  // removed the auth cookies → first snapshot = logged out → 'lost' → helper.
  rejectRestoredSession(dev, { guest: 'anon-9' }); // the site put its guest session back
  app = await start(dev);
  assert.ok(app.log.status.some((t) => /Carol 的登录状态已失效（页面回到了游客状态），已清除失效的会话，需要重新登录，正在自动登录/.test(t)), app.log.status.join(' | '));
  assert.equal(app.flow.accounts.pending.type, 'login');
  assert.equal(app.flow.accounts.pending.id, 'carol');
  // the rejected session is forgotten (revoked token families never come back)
  assert.deepEqual(app.flow.find('carol').cookies, [], 'dead session dropped from the record');
  assert.equal(app.flow.find('carol').login.password, 'pw-c', 'typed credentials kept');
  assert.deepEqual(dev.rust.login && { email: dev.rust.login.email, password: dev.rust.login.password, totp: dev.rust.login.totp, provider: dev.rust.login.provider, accountId: dev.rust.login.accountId },
    { email: 'carol@gmail.com', password: 'pw-c', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', provider: 'google', accountId: 'carol' }, 'login_set handed Rust the credentials');
  assert.equal(app.flow.accounts.activeId, null, 'logged-out page → no current account');
  assert.match(app.log.loginStatus.at(-1), /登录助手已启动：Carol/);
  // the page-side helper started on arena.ai (logged-out page → `login` RPC, no reload needed)
  const status = await app.rpc.call('status', {});
  assert.equal(status.running, true);
  // logged OUT (guest) + Google account → straight to the sign-in endpoint,
  // the site's dialog is never touched
  const loginBtn = app.page.mk('button', {}, 'Log In');
  app.page.flushTimeouts();
  assert.equal(loginBtn.clicks, 0, 'no dialog');
  assert.match(app.page.navigations.at(-1).url, /^https:\/\/arena\.ai\/nextjs-api\/sign-in\/google\?shouldLinkHistory=true&/);

  // accounts.google.com: no IPC there — Rust's on_page_load evals
  // __AK_LOGIN_APPLY__(creds) with what login_set stored. Identifier → password → TOTP.
  const g = fakeDom({ hostname: 'accounts.google.com', pathname: '/v3/signin/identifier' });
  const idIn = g.mk('input', { type: 'email', id: 'identifierId' });
  g.mk('button', { id: 'identifierNext' }, 'Next');
  assert.equal(plain(g.sandbox.__AK_LOGIN_APPLY__(dev.rust.login)).started, true);
  g.flushTimeouts(); g.flushTimeouts();
  assert.equal(idIn.value, 'carol@gmail.com');
  g.clearElements(); g.location.pathname = '/v3/signin/challenge/pwd';
  const pwdIn = g.mk('input', { type: 'password', name: 'Passwd' }); g.mk('button', { id: 'passwordNext' }, 'Next');
  g.tickIntervals(); g.flushTimeouts();
  assert.equal(pwdIn.value, 'pw-c');
  g.clearElements(); g.location.pathname = '/v3/signin/challenge/totp';
  const totpIn = g.mk('input', { type: 'tel', id: 'totpPin', name: 'totpPin' }); g.mk('button', { id: 'totpNext' }, 'Next');
  const realNow = g.sandbox.Date.now; g.sandbox.Date.now = () => 59_000; // RFC 6238 vector
  g.tickIntervals(); g.flushTimeouts();
  g.sandbox.Date.now = realNow;
  assert.equal(totpIn.value, '287082', 'the 2FA code came from the saved secret');
  assert.equal(g.events.length, 0, 'nothing crosses the bridge on google');

  // Back on arena.ai with Carol's new session: pending login → logged-in, Rust cleared.
  dev.jar = sessionJar({ email: 'carol@gmail.com', id: 'uc', name: 'Carol', refresh: 'rt-new' });
  app = await start(dev);
  assert.equal(app.flow.accounts.pending, null);
  assert.equal(app.flow.accounts.activeId, 'carol');
  assert.equal(refreshTokenOf(app.flow.active()), 'rt-new');
  assert.match(app.log.toast.at(-1), /已登录 Carol/);
  assert.equal(dev.rust.login, null, 'login_clear after success');
  assert.equal(app.flow.accounts.list.length, 2, 'no duplicate: matched by userId');
});

test('targets without a session: credentials → clear + reload into the helper; nothing → refused; failures clear the pending flag', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  const app = await start(dev);
  const base = app.flow.accounts;
  await app.flow.save({ ...base, list: base.list.concat([
    { id: 'dave', label: 'Dave', cookies: [], login: { email: 'dave@example.com', password: 'pw-d', totp: '', auto: true } },
    { id: 'erin', label: 'Erin', cookies: [], login: { email: '', password: '', totp: '', auto: true } },
    { id: 'junk', email: 'junk@example.com', cookies: [{ name: '_ga', value: 'x' }], login: { email: '', password: '', totp: '', auto: true } },
  ]) });
  // Erin: nothing to go on
  assert.deepEqual(await app.flow.switchTo('erin'), { ok: false, reason: '该账号没有保存的登录状态，也没有填写登录信息' });
  assert.deepEqual(await app.flow.switchTo(app.flow.accounts.activeId), { ok: false, reason: '已经是当前账号' });
  // junk cookies: restore refuses → pending cleared, page untouched
  const bad = await app.flow.switchTo('junk');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /没有可恢复/);
  assert.equal(app.flow.accounts.pending, null);
  assert.equal(plain(app.page.api.snapshot()).email, 'alice@example.com');
  assert.equal(dev.reloads, 0);
  // Dave: credentials only, page still logged in as Alice → login_set, clear, page leaves for the root
  const r = await app.flow.switchTo('dave');
  assert.deepEqual(r, { ok: true, mode: 'login' });
  assert.equal(dev.rust.login.email, 'dave@example.com');
  assert.equal(dev.rust.login.provider, 'email', 'no google marker → email flow');
  assert.equal(plain(app.page.api.snapshot()).hasAuthCookie, false);
  assert.equal(dev.reloads, 1);
  assert.equal(dev.navigations.at(-1), 'https://arena.ai/agent');
  assert.deepEqual(app.log.navigating, ['login:/agent']);
  assert.equal(stored(dev).pending.type, 'login');
  assert.equal(stored(dev).list.find((a) => a.id === app.flow.accounts.activeId).cookies.length > 0, true, 'Alice stays saved');
  // startLogin on an account without credentials asks for them
  const r2 = await app.flow.startLogin(app.flow.find('erin'));
  assert.equal(r2.ok, false);
  assert.deepEqual(app.log.needLogin, ['erin']);
  // stop: Rust + store + page helper
  await app.flow.stopLogin();
  assert.equal(dev.rust.login, null);
  assert.equal(app.flow.accounts.pending, null);
  assert.match(app.log.loginStatus.at(-1), /已停止/);
});

test('a pending operation older than 5 minutes is dropped instead of misjudged; saveCurrent reports a logged-out page', async () => {
  const dev = device([]);
  dev.store.set('accounts', JSON.stringify({ list: [], activeId: '', pending: { type: 'switch', id: 'x', at: Date.now() - 6 * 60_000 } }));
  const app = await start(dev);
  assert.equal(app.flow.accounts.pending, null);
  assert.match(app.log.status.join('\n'), /上次的账号操作已超时/);
  assert.equal(await app.flow.saveCurrent(), null);
  assert.match(app.log.status.at(-1), /页面当前未登录/);
  assert.throws(() => createAccountFlow({}), /call\(\) and reload\(\)/);
});

test('login for the account that is already logged in: nothing happens on the page (no clear, no sign-in)', async () => {
  const dev = device(sessionJar({ email: 'alice@example.com', id: 'ua', name: 'Alice' }));
  const app = await start(dev);
  const alice = app.flow.accounts.list[0];
  const r = await app.flow.startLogin(alice);
  assert.equal(r.via, 'already');
  assert.equal(app.page.navigations.length, 0, 'page left alone');
  assert.equal(dev.rust.login, null, 'no credentials handed to Rust');
  assert.equal(app.flow.accounts.pending, null);
  assert.match(app.log.loginStatus.at(-1), /已经登录/);
});
