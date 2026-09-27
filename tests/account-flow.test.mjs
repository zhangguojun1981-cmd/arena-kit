import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { supabaseSession, chunked, fakeDom, settle } from './account-fixture.mjs';
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
const refreshTokenOf = (acc) => JSON.parse(Buffer.from(acc.cookies.map((c) => c.value).join('').slice('base64-'.length), 'base64url').toString()).refresh_token;

function device(jar = []) {
  return { jar, store: new Map(), rust: { login: null, invokes: [] }, reloads: 0 };
}
/* One page load: page (account.js on the device jar) + dock side (rpc + flow). */
function boot(dev, { hostname = 'arena.ai', pathname = '/' } = {}) {
  const page = fakeDom({ hostname, pathname, jar: dev.jar });
  const log = { status: [], loginStatus: [], toast: [], needLogin: [], saves: 0 };
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
    reload: async () => { dev.reloads++; dev.jar = cookiesOf(page); page.clearElements(); },
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

  // ── 添加另一个账号: current session kept, page cleared, reload ──
  const add = await app.flow.add();
  assert.equal(add.ok, true);
  assert.equal(plain(app.page.api.snapshot()).hasAuthCookie, false, 'page auth cookies cleared');
  assert.ok(app.page.cookies.has('|cf_clearance'), 'unrelated cookies kept');
  assert.equal(dev.reloads, 1);
  assert.equal(stored(dev).pending.type, 'add', 'the pending add survives the reload in the store');
  assert.equal(stored(dev).list.find((a) => a.id === aliceId).cookies.length > 0, true, 'Alice\'s session is still saved');
  assert.ok(dev.rust.invokes.some((i) => i.cmd === 'login_clear'));

  // ── reload: logged-out page, pending add → waiting for the user to log in ──
  app = await start(dev);
  assert.equal(app.flow.accounts.pending.type, 'add');
  assert.match(app.log.status.at(-1), /请在页面中登录另一个账号/);
  assert.equal(app.flow.accounts.activeId, null, 'a logged-out page has no current account');
  assert.ok(app.flow.find(aliceId), 'Alice is still in the list');

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

  // ── one-click switch back to Alice: cookie swap + reload ──
  const sw = await app.flow.switchTo(aliceId);
  assert.deepEqual(sw, { ok: true, mode: 'cookies' });
  const pageNow = plain(app.page.api.snapshot());
  assert.equal(pageNow.email, 'alice@example.com', 'the page jar now holds Alice\'s session');
  assert.ok(cookiesOf(app.page).filter((c) => c.name.startsWith('arena-auth')).every((c) => c.domain === DOMAIN), 'restored with the site\'s Domain scope');
  assert.equal(dev.reloads, 2);
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
  dev.jar = dev.jar.filter((c) => !c.name.startsWith('arena-auth'));
  app = await start(dev);
  assert.ok(app.log.status.some((t) => /Carol 的登录状态已失效，需要重新登录，正在自动登录/.test(t)), app.log.status.join(' | '));
  assert.equal(app.flow.accounts.pending.type, 'login');
  assert.equal(app.flow.accounts.pending.id, 'carol');
  assert.deepEqual(dev.rust.login && { email: dev.rust.login.email, password: dev.rust.login.password, totp: dev.rust.login.totp, provider: dev.rust.login.provider, accountId: dev.rust.login.accountId },
    { email: 'carol@gmail.com', password: 'pw-c', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', provider: 'google', accountId: 'carol' }, 'login_set handed Rust the credentials');
  assert.equal(app.flow.accounts.activeId, null, 'logged-out page → no current account');
  assert.match(app.log.loginStatus.at(-1), /登录助手已启动：Carol/);
  // the page-side helper started on arena.ai (logged-out page → `login` RPC, no reload needed)
  const status = await app.rpc.call('status', {});
  assert.equal(status.running, true);
  const loginBtn = app.page.mk('button', {}, 'Login');
  app.page.flushTimeouts();
  assert.equal(loginBtn.clicks, 1, 'opened the login modal');
  const google = app.page.mk('button', {}, 'Continue with Google');
  app.page.tickIntervals();
  assert.equal(google.clicks, 1, 'google account → Continue with Google');

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
  // Dave: credentials only, page still logged in as Alice → login_set, clear, reload
  const r = await app.flow.switchTo('dave');
  assert.deepEqual(r, { ok: true, mode: 'login' });
  assert.equal(dev.rust.login.email, 'dave@example.com');
  assert.equal(dev.rust.login.provider, 'email', 'no google marker → email flow');
  assert.equal(plain(app.page.api.snapshot()).hasAuthCookie, false);
  assert.equal(dev.reloads, 1);
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
