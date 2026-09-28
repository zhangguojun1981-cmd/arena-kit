/* Multi-account model for the dock (pure; persisted under the store key
 * `accounts`). One record per arena.ai identity:
 *
 *   { id, userId, email, name, avatar, provider,        identity (from the session cookie)
 *     cookies:[{name,value}], sig, expiresAt, capturedAt, lastUsedAt, label }
 *
 * Accounts are logged in BY HAND first (the watcher then records them); a
 * dead session is re-logged in with one tap (injected/account.js re-login:
 * the manual Google round trip, automated). No credentials are stored — the
 * `login` block of builds ≤ 0.4.8 (email / password / TOTP secret) is dropped
 * on load.
 *
 * `state.activeId` is the account whose session is in the page right now,
 * `state.pending` a switch / add / login in flight (survives the reload that
 * every switch needs — the embedded dock on Android dies with the page).
 *
 * Snapshots come from injected/account.js (`account` page event or the
 * `snapshot` RPC): { loggedIn, anonymous, userId, email, name, avatar,
 * provider, expiresAt, cookies, sig, at }. The active account's cookies are
 * refreshed on every snapshot — Supabase rotates refresh tokens, so an old
 * copy would be dead within the hour.
 *
 * Only a real login becomes a record: arena signs visitors in anonymously
 * (Supabase anonymous users — a cookie, a user id, no email), and those guest
 * sessions must never pile up in the list. A snapshot counts as logged in
 * only when the page says so AND it carries an email AND it is not anonymous;
 * records without any email / login email / label (guest leftovers from older
 * builds) are dropped on load. */

export const PENDING_TTL_MS = 5 * 60 * 1000;
const isVerifierCookie = (n) => /code-verifier/i.test(n);

const str = (v) => (v == null ? '' : String(v));
const emailKey = (e) => str(e).trim().toLowerCase();

export function newId(now = Date.now()) {
  return 'acc-' + now.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export function normalizeAccounts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.list) ? src.list.map(normalizeAccount).filter(Boolean) : [];
  const ids = new Set(list.map((a) => a.id));
  return {
    list,
    activeId: ids.has(src.activeId) ? src.activeId : null,
    pending: src.pending && typeof src.pending === 'object' && typeof src.pending.type === 'string' ? { ...src.pending } : null,
  };
}

export function normalizeAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const acc = {
    id: str(a.id) || newId(),
    userId: str(a.userId),
    // a manual record of ≤ 0.4.8 may only carry its login email
    email: emailKey(a.email || (a.login && typeof a.login === 'object' ? a.login.email : '')),
    name: str(a.name),
    avatar: str(a.avatar),
    provider: str(a.provider).toLowerCase(),
    label: str(a.label),
    // session cookies only: builds before 0.4.7 also saved the PKCE verifier
    // (arena-auth-prod-v1-code-verifier) and wrote an old one back on switch
    cookies: Array.isArray(a.cookies) ? a.cookies.filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && !isVerifierCookie(c.name)).map((c) => ({ name: c.name, value: c.value })) : [],
    sig: str(a.sig),
    expiresAt: Number(a.expiresAt) || 0,
    capturedAt: Number(a.capturedAt) || 0,
    lastUsedAt: Number(a.lastUsedAt) || 0,
  };
  // No email, no label → nothing a person could recognise or use; this is
  // what an anonymous (guest) session left behind. Drop it.
  if (!acc.email && !acc.label) return null;
  return acc;
}

/* A snapshot describes a real, saveable login (not the site's guest session). */
export function isRealLogin(snap) {
  return !!(snap && snap.loggedIn && !snap.anonymous && emailKey(snap.email) && Array.isArray(snap.cookies) && snap.cookies.length);
}

/* Display name: label → name → email. */
export function accountLabel(acc) {
  if (!acc) return '';
  return acc.label || acc.name || acc.email || acc.userId || '未命名账号';
}
export function accountEmail(acc) {
  return (acc && acc.email) || '';
}
export function initialOf(acc) {
  const s = accountLabel(acc).trim();
  return s ? s[0].toUpperCase() : '?';
}
export function hasSession(acc) {
  return !!(acc && acc.cookies && acc.cookies.length);
}
/* One-tap re-login needs the identity email (Google's account chooser row). */
export function canLogin(acc) {
  return !!(acc && acc.email);
}
/* Forget a saved session that the site rejected (keeps the record): the card
 * shows 登录 instead of 切换 and the next attempt re-logs in instead of
 * failing the same way again. */
export function dropSession(state, id) {
  const st = normalizeAccounts(state);
  st.list = st.list.map((a) => (a.id === id ? { ...a, cookies: [], sig: '', expiresAt: 0 } : a));
  if (st.activeId === id) st.activeId = '';
  return st;
}
/* What the page-side re-login needs: who to pick on Google's chooser. */
export function credsFor(acc, extra = {}) {
  if (!acc) return null;
  return { accountId: acc.id, email: acc.email || '', startedAt: Number(extra.startedAt) || Date.now() };
}

/* Find the record a snapshot belongs to: same userId, else same email. */
export function findForSnapshot(state, snap) {
  if (!snap) return null;
  const uid = str(snap.userId);
  const em = emailKey(snap.email);
  return (uid && state.list.find((a) => a.userId === uid))
    || (em && state.list.find((a) => a.email === em))
    || null;
}

/* Merge a snapshot of the page's CURRENT session into the store. Returns
 * { state, account, created, changed }. A logged-out (or anonymous / guest)
 * snapshot leaves the records alone and only clears activeId (the page holds
 * no session worth keeping). */
export function applySnapshot(state, snap, now = Date.now()) {
  const st = normalizeAccounts(state);
  if (!isRealLogin(snap)) {
    const changed = st.activeId !== null;
    return { state: { ...st, activeId: null }, account: null, created: false, changed };
  }
  let acc = findForSnapshot(st, snap);
  let created = false;
  if (!acc) {
    acc = normalizeAccount({ id: newId(now), userId: snap.userId, email: snap.email });
    created = true;
    st.list = [...st.list, acc];
  }
  const before = JSON.stringify(acc);
  // Same cookies again (watcher re-announce, dock probe after the watcher):
  // keep the timestamps so an identical snapshot is a no-op for the store.
  const sameCookies = !created && acc.sig === str(snap.sig) && acc.cookies.length > 0;
  const next = {
    ...acc,
    userId: str(snap.userId) || acc.userId,
    email: emailKey(snap.email) || acc.email,
    name: str(snap.name) || acc.name,
    avatar: str(snap.avatar) || acc.avatar,
    provider: str(snap.provider).toLowerCase() || acc.provider,
    cookies: snap.cookies.map((c) => ({ name: c.name, value: c.value })),
    sig: str(snap.sig),
    expiresAt: Number(snap.expiresAt) || acc.expiresAt,
    capturedAt: sameCookies ? acc.capturedAt : now,
    lastUsedAt: sameCookies && st.activeId === acc.id ? acc.lastUsedAt : now,
  };
  const changed = created || before !== JSON.stringify(next) || st.activeId !== next.id;
  st.list = st.list.map((a) => (a.id === next.id ? next : a));
  st.activeId = next.id;
  return { state: st, account: next, created, changed };
}

/* 备注名 — the only thing the user edits on a record. */
export function setLabel(state, id, label) {
  const st = normalizeAccounts(state);
  const acc = st.list.find((a) => a.id === id);
  if (!acc) return { state: st, account: null };
  const next = { ...acc, label: str(label).trim().slice(0, 40) };
  st.list = st.list.map((a) => (a.id === id ? next : a));
  return { state: st, account: next };
}

export function removeAccount(state, id) {
  const st = normalizeAccounts(state);
  st.list = st.list.filter((a) => a.id !== id);
  if (st.activeId === id) st.activeId = null;
  if (st.pending && st.pending.id === id) st.pending = null;
  return st;
}

/* Can we switch to `id` right now? */
export function planSwitch(state, id) {
  const st = normalizeAccounts(state);
  const target = st.list.find((a) => a.id === id);
  if (!target) return { ok: false, reason: '账号不存在' };
  if (st.activeId === id) return { ok: false, reason: '已经是当前账号' };
  if (hasSession(target)) return { ok: true, target, mode: 'cookies' };
  if (canLogin(target)) return { ok: true, target, mode: 'login' };
  return { ok: false, reason: '该账号没有保存的登录状态，也没有邮箱可用于重新登录', target };
}

export function setPending(state, pending, now = Date.now()) {
  const st = normalizeAccounts(state);
  st.pending = pending ? { ...pending, at: Number(pending.at) || now } : null;
  return st;
}

export function lostMessage(target, guest) {
  return (target ? accountLabel(target) : '该账号') + ' 的登录状态已失效' + (guest ? '（页面回到了游客状态）' : '') + '，已清除失效的会话，需要重新登录';
}

/* After a reload, decide what the new snapshot means for the pending
 * operation. Returns { state, outcome:{status,message,account?} }.
 *   switch → 'switched' (same identity) | 'lost' (logged out: session expired)
 *            | 'other' (a different account showed up)
 *   add    → 'added' when a NEW identity logged in | 'waiting' while logged out
 *   login  → 'logged-in' | 'waiting'
 * Pending entries older than PENDING_TTL_MS expire silently. */
export function resolvePending(state, snap, now = Date.now()) {
  const st = normalizeAccounts(state);
  const p = st.pending;
  if (!p) return { state: st, outcome: null };
  if (now - (Number(p.at) || 0) > PENDING_TTL_MS) return { state: { ...st, pending: null }, outcome: { status: 'expired', message: '上次的账号操作已超时' } };
  const loggedIn = isRealLogin(snap);
  const guest = !loggedIn && !!(snap && snap.anonymous);
  const target = p.id ? st.list.find((a) => a.id === p.id) : null;
  const same = loggedIn && target && ((target.userId && target.userId === str(snap.userId)) || (!target.userId && target.email && target.email === emailKey(snap.email)));
  if (p.type === 'switch') {
    if (same) return { state: { ...st, pending: null }, outcome: { status: 'switched', account: target, message: '已切换到 ' + accountLabel(target) } };
    if (loggedIn) return { state: { ...st, pending: null }, outcome: { status: 'other', message: '页面登录的是另一个账号（' + (snap.email || snap.userId) + '）' } };
    // The site rejected the restored session: its tokens are dead for good
    // (a revoked refresh-token family never comes back) — forget them so the
    // card offers 登录 instead of another doomed 切换.
    const dropped = target ? dropSession({ ...st, pending: null }, target.id) : { ...st, pending: null };
    return { state: dropped, outcome: { status: 'lost', account: target ? dropped.list.find((a) => a.id === target.id) || target : null, message: lostMessage(target, guest) } };
  }
  if (p.type === 'add') {
    if (!loggedIn) return { state: st, outcome: { status: 'waiting', message: '请在页面中登录另一个账号；登录完成后会自动保存' + (guest ? '（游客状态不会被记录）' : '') } };
    return { state: { ...st, pending: null }, outcome: { status: 'added', message: '已保存账号 ' + (snap.email || snap.userId) } };
  }
  if (p.type === 'login') {
    if (loggedIn) return { state: { ...st, pending: null }, outcome: { status: 'logged-in', account: target, message: (same ? '已登录 ' + accountLabel(target) : '已登录 ' + (snap.email || snap.userId)) } };
    return { state: st, outcome: { status: 'waiting', message: '正在重新登录…' } };
  }
  return { state: { ...st, pending: null }, outcome: null };
}

/* Re-login stage → human text for the dock status line. */
export function loginStageText(stage, extra = {}) {
  const who = extra.email ? ' ' + extra.email : '';
  const map = {
    'arena-open': '重新登录' + who + '：已点「登录」…',
    'arena-agree': '重新登录' + who + '：已勾选同意条款…',
    'arena-google': '重新登录' + who + '：已点 Google 登录，正在跳转…',
    'arena-google-direct': '重新登录' + who + '：未找到登录按钮，直接打开 Google 登录…',
    'arena-waiting': '重新登录' + who + '：等待登录界面…',
    'google-pick': 'Google：已选择账号' + who + '…',
    'google-continue': 'Google：已点「继续」…',
    'google-waiting': 'Google：等待页面…',
    'google-not-listed': 'Google 账号列表里没有' + who + '：请手动登录一次',
    'google-need-user': 'Google 要求输入密码 / 验证：请手动完成',
    'google-blocked': 'Google 拒绝了应用内登录（disallowed_useragent）',
    'wrong-account': '页面已登录另一个账号' + (extra.email ? '（' + extra.email + '）' : ''),
    'user-active': '你正在操作页面，自动登录暂停 10 秒…',
    done: '登录完成 ✓',
    stopped: '已停止重新登录',
    timeout: '重新登录超时（3 分钟），请手动完成',
    error: '重新登录失败：' + (extra.error || '未知错误'),
  };
  return map[stage] || ('重新登录：' + stage);
}

/* Time-left text for a saved session (access token expiry is informational —
 * the refresh token keeps the session alive much longer). */
export function sessionAgeText(acc, now = Date.now()) {
  if (!hasSession(acc)) return '未保存登录状态';
  const mins = Math.max(0, Math.round((now - (acc.capturedAt || 0)) / 60000));
  if (!acc.capturedAt) return '已保存登录状态';
  if (mins < 1) return '刚刚保存';
  if (mins < 60) return mins + ' 分钟前保存';
  const h = Math.round(mins / 60);
  if (h < 48) return h + ' 小时前保存';
  return Math.round(h / 24) + ' 天前保存';
}
