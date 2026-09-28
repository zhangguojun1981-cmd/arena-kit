import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccounts, normalizeAccount, applySnapshot, isRealLogin, upsertLogin, removeAccount, planSwitch, setPending, resolvePending, credsFor, accountLabel, initialOf, hasSession, hasLogin, canLogin, dropSession, loginStageText, sessionAgeText, PENDING_TTL_MS } from '../src/lib/accounts.js';

const snap = (over = {}) => ({
  loggedIn: true, userId: 'ua', email: 'Alice@Example.com', name: 'Alice', avatar: 'https://img/a', provider: 'google', expiresAt: 1_800_000_000_000,
  cookies: [{ name: 'arena-auth-prod-v1.0', value: 'base64-aaa' }, { name: 'arena-auth-prod-v1.1', value: 'bbb' }], sig: 's1', at: 1000, ...over,
});

test('normalizeAccounts tolerates junk and drops empty records', () => {
  assert.deepEqual(normalizeAccounts(null), { list: [], activeId: null, pending: null });
  assert.deepEqual(normalizeAccounts({ list: [{}, null, 'x'], activeId: 'nope', pending: 'bad' }), { list: [], activeId: null, pending: null });
  const st = normalizeAccounts({ list: [{ id: 'a', email: 'A@B.c', cookies: [{ name: 'n', value: 'v' }, { bad: 1 }], login: { password: 'p' } }], activeId: 'a', pending: { type: 'switch', id: 'a' } });
  assert.equal(st.list.length, 1);
  assert.equal(st.list[0].email, 'a@b.c');
  assert.deepEqual(st.list[0].cookies, [{ name: 'n', value: 'v' }]);
  assert.equal(st.list[0].login.auto, true, 'auto-login defaults on');
  assert.equal(st.activeId, 'a');
  assert.deepEqual(st.pending, { type: 'switch', id: 'a' });
  assert.equal(normalizeAccount({ login: { totp: 'X' } }), null, 'no identity, no email, no label → dropped');
  assert.ok(normalizeAccount({ label: '备用' }));
  // guest leftovers (anonymous sessions saved by older builds): a user id, cookies, no email → dropped
  assert.equal(normalizeAccount({ id: 'g', userId: 'anon-1', cookies: [{ name: 'arena-auth-prod-v1.0', value: 'base64-x' }] }), null);
  assert.ok(normalizeAccount({ id: 'r', userId: 'ua', email: 'a@b.c' }), 'a real identity stays');
  assert.ok(normalizeAccount({ id: 'm', userId: '', login: { email: 'me@b.c' } }), 'a manual record with a login email stays');
});

test('isRealLogin / applySnapshot ignore the site\'s guest session and email-less sessions', () => {
  assert.equal(isRealLogin(snap()), true);
  assert.equal(isRealLogin(snap({ anonymous: true, email: '', userId: 'anon-1' })), false);
  assert.equal(isRealLogin(snap({ anonymous: true })), false, 'anonymous flag wins even with an email');
  assert.equal(isRealLogin(snap({ email: '' })), false, 'no email → nothing to show or match by');
  assert.equal(isRealLogin(snap({ loggedIn: false })), false);
  assert.equal(isRealLogin(snap({ cookies: [] })), false);
  const a = applySnapshot(null, snap(), 1000);
  const g = applySnapshot(a.state, snap({ anonymous: true, email: '', userId: 'anon-1', sig: 'g' }), 2000);
  assert.equal(g.created, false);
  assert.equal(g.account, null);
  assert.equal(g.state.list.length, 1, 'no guest record');
  assert.equal(g.state.activeId, null, 'guest page → no current account');
  const e = applySnapshot(a.state, snap({ email: '', userId: 'ux', sig: 'e' }), 3000);
  assert.equal(e.created, false);
  assert.equal(e.state.list.length, 1);
});

test('applySnapshot creates a record on first sight, refreshes the same identity in place (token rotation), and sets activeId', () => {
  const s1 = applySnapshot(null, snap(), 1000);
  assert.equal(s1.created, true);
  assert.equal(s1.changed, true);
  assert.equal(s1.state.list.length, 1);
  assert.equal(s1.state.activeId, s1.account.id);
  assert.equal(s1.account.email, 'alice@example.com');
  assert.equal(s1.account.name, 'Alice');
  assert.equal(s1.account.provider, 'google');
  assert.equal(s1.account.capturedAt, 1000);
  assert.equal(hasSession(s1.account), true);
  // same user, rotated cookies
  const s2 = applySnapshot(s1.state, snap({ cookies: [{ name: 'arena-auth-prod-v1.0', value: 'base64-ccc' }], sig: 's2' }), 2000);
  assert.equal(s2.created, false);
  assert.equal(s2.changed, true);
  assert.equal(s2.state.list.length, 1, 'no duplicate');
  assert.deepEqual(s2.account.cookies, [{ name: 'arena-auth-prod-v1.0', value: 'base64-ccc' }]);
  assert.equal(s2.account.capturedAt, 2000);
  // identical snapshot → unchanged except the timestamps
  const s3 = applySnapshot(s2.state, snap({ cookies: s2.account.cookies, sig: 's2' }), 3000);
  assert.equal(s3.created, false);
  // another user → second record, becomes active
  const s4 = applySnapshot(s3.state, snap({ userId: 'ub', email: 'bob@example.com', name: 'Bob', sig: 's9' }), 4000);
  assert.equal(s4.created, true);
  assert.equal(s4.state.list.length, 2);
  assert.equal(s4.state.activeId, s4.account.id);
  assert.notEqual(s4.account.id, s1.account.id);
  // logged out → activeId cleared, records kept
  const s5 = applySnapshot(s4.state, { loggedIn: false, cookies: [] }, 5000);
  assert.equal(s5.state.activeId, null);
  assert.equal(s5.state.list.length, 2);
  assert.equal(s5.changed, true);
  assert.equal(applySnapshot(s5.state, null).changed, false);
});

test('a manual record (email + password entered before any login) is claimed by the matching session', () => {
  const m = upsertLogin(null, null, { email: 'Carol@example.com', password: 'pw', totp: 'JBSWY3DPEHPK3PXP', label: '工作号' });
  assert.equal(m.created, true);
  assert.equal(m.account.email, 'carol@example.com');
  assert.equal(hasLogin(m.account), true);
  assert.equal(hasSession(m.account), false);
  assert.equal(accountLabel(m.account), '工作号');
  const s = applySnapshot(m.state, snap({ userId: 'uc', email: 'carol@example.com', name: 'Carol' }), 10);
  assert.equal(s.created, false, 'matched by email');
  assert.equal(s.account.id, m.account.id);
  assert.equal(s.account.userId, 'uc');
  assert.equal(s.account.login.password, 'pw', 'login info kept');
  assert.equal(accountLabel(s.account), '工作号');
  // editing keeps unknown fields; auto can be switched off
  const e = upsertLogin(s.state, s.account.id, { auto: false, password: 'new' });
  assert.equal(e.account.login.auto, false);
  assert.equal(e.account.login.password, 'new');
  assert.equal(e.account.login.totp, 'JBSWY3DPEHPK3PXP');
  assert.deepEqual(credsFor(e.account, { startedAt: 5 }), { accountId: e.account.id, email: 'Carol@example.com', password: 'new', totp: 'JBSWY3DPEHPK3PXP', provider: 'google', startedAt: 5 });
  assert.equal(initialOf(e.account), '工');
  // remove
  const r = removeAccount(setPending(e.state, { type: 'switch', id: e.account.id }), e.account.id);
  assert.equal(r.list.length, 0);
  assert.equal(r.pending, null);
});

test('planSwitch: cookies first, login helper as fallback, refuses the active account', () => {
  const a = applySnapshot(null, snap(), 1).state;
  const withB = upsertLogin(a, null, { email: 'bob@example.com', password: 'x' });
  const b = withB.account;
  const c = upsertLogin(withB.state, null, { label: '空账号' });
  const st = c.state;
  assert.equal(planSwitch(st, a.activeId).ok, false);
  assert.match(planSwitch(st, a.activeId).reason, /当前账号/);
  assert.equal(planSwitch(st, b.id).mode, 'login');
  assert.equal(planSwitch(st, c.account.id).ok, false);
  assert.equal(planSwitch(st, 'nope').ok, false);
  const st2 = applySnapshot(st, snap({ userId: 'ub', email: 'bob@example.com' }), 2).state; // bob logged in now
  assert.equal(planSwitch(st2, st.activeId).mode, 'cookies', 'alice has cookies');
});

test('dropSession forgets a rejected session (record + credentials kept); an identity email alone is enough for the login helper', () => {
  const st = applySnapshot(null, snap(), 1).state; // alice, auto-recorded, no typed credentials
  const alice = st.list[0];
  assert.equal(hasSession(alice), true);
  assert.equal(hasLogin(alice), false);
  assert.equal(canLogin(alice), true, 'identity email → the helper can open the dialog and fill it');
  const st2 = applySnapshot(st, snap({ userId: 'ub', email: 'bob@example.com' }), 2).state;
  const dropped = dropSession(st2, alice.id);
  const a2 = dropped.list.find((a) => a.id === alice.id);
  assert.deepEqual(a2.cookies, []);
  assert.equal(a2.sig, '');
  assert.equal(a2.expiresAt, 0);
  assert.equal(a2.email, 'alice@example.com', 'record kept');
  assert.equal(dropped.activeId, st2.activeId, 'another account stays active');
  assert.equal(dropSession(st, alice.id).activeId, '', 'dropping the active account clears activeId');
  assert.equal(planSwitch(dropped, alice.id).mode, 'login', 'no session → helper with the identity email');
  assert.equal(credsFor(a2).email, 'alice@example.com');
  assert.equal(credsFor(a2).password, '');
  // resolvePending lost → the target's session is dropped right there
  const pend = setPending(st2, { type: 'switch', id: alice.id }, 3);
  const r = resolvePending(pend, { loggedIn: false, anonymous: true, hasAuthCookie: true, userId: 'anon-1', email: '' }, 4);
  assert.equal(r.outcome.status, 'lost');
  assert.deepEqual(r.state.list.find((a) => a.id === alice.id).cookies, []);
  assert.deepEqual(r.outcome.account.cookies, []);
  assert.match(r.outcome.message, /已清除失效的会话，需要重新登录/);
  assert.equal(r.state.pending, null);
});

test('resolvePending interprets the post-reload snapshot for switch / add / login', () => {
  const a = applySnapshot(null, snap(), 1);
  const b = applySnapshot(a.state, snap({ userId: 'ub', email: 'bob@example.com' }), 2);
  const st = setPending(b.state, { type: 'switch', id: a.account.id }, 100);
  // switched back to alice
  let r = resolvePending(st, snap(), 200);
  assert.equal(r.outcome.status, 'switched');
  assert.equal(r.state.pending, null);
  assert.match(r.outcome.message, /Alice/);
  // session dead → lost
  r = resolvePending(st, { loggedIn: false }, 200);
  assert.equal(r.outcome.status, 'lost');
  assert.equal(r.outcome.account.id, a.account.id);
  // …also when the site fell back to its guest session (not 'other')
  r = resolvePending(st, snap({ anonymous: true, email: '', userId: 'anon-9' }), 200);
  assert.equal(r.outcome.status, 'lost');
  assert.match(r.outcome.message, /游客状态/);
  // someone else
  r = resolvePending(st, snap({ userId: 'uz', email: 'z@z.z' }), 200);
  assert.equal(r.outcome.status, 'other');
  // add: waits while logged out, settles when a session appears
  const add = setPending(b.state, { type: 'add' }, 100);
  assert.equal(resolvePending(add, { loggedIn: false }, 200).outcome.status, 'waiting');
  assert.equal(resolvePending(add, { loggedIn: false }, 200).state.pending.type, 'add', 'still pending');
  assert.equal(resolvePending(add, snap({ userId: 'uc', email: 'c@c.c' }), 200).outcome.status, 'added');
  // login: waiting / logged-in
  const lg = setPending(b.state, { type: 'login', id: a.account.id }, 100);
  assert.equal(resolvePending(lg, { loggedIn: false }, 200).outcome.status, 'waiting');
  assert.equal(resolvePending(lg, snap(), 200).outcome.status, 'logged-in');
  // ttl
  assert.equal(resolvePending(lg, snap(), 100 + PENDING_TTL_MS + 1).outcome.status, 'expired');
  assert.equal(resolvePending(b.state, snap(), 1).outcome, null);
});

test('status texts', () => {
  assert.equal(loginStageText('google-totp'), 'Google：已填入两步验证码…');
  assert.match(loginStageText('error', { error: 'x' }), /x/);
  assert.equal(loginStageText('weird'), '登录助手：weird');
  const acc = { cookies: [{ name: 'a', value: 'b' }], capturedAt: 0 };
  assert.equal(sessionAgeText(acc), '已保存登录状态');
  assert.equal(sessionAgeText({ ...acc, capturedAt: 1000 }, 1000 + 5 * 60000), '5 分钟前保存');
  assert.equal(sessionAgeText({ ...acc, capturedAt: 1000 }, 1000 + 3 * 3600000), '3 小时前保存');
  assert.equal(sessionAgeText({ cookies: [] }), '未保存登录状态');
});
