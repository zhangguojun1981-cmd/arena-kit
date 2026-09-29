/* 账号 flow — the orchestration between the saved-accounts model
 * (src/lib/accounts.js), the page-side cookie jar (injected/account.js, reached
 * through an RPC `call(action, args)`), the store and the WebView reload. Pure
 * of DOM so the whole switch / add / login journey can be driven in tests with
 * the real account.js on a fake document.cookie (tests/account-flow.test.mjs).
 *
 * Deps (all optional except call/reload):
 *   call(action, args, opts) → Promise<data>   page RPC (snapshot / restore / clear / login / stop)
 *   loadStore() → Promise<raw>, saveStore(state) → Promise   persistence (store key `accounts`)
 *   reload() → Promise                          reload the Arena page (`account` source) — only used
 *                                               when the page could not navigate by itself
 *   navigating(url)                             the page is leaving on its own (restore / clear with
 *                                               `navigate`): show the loading state, close the sheet
 *   invoke(cmd, args) → Promise                 Tauri commands login_set / login_clear
 *   status(text)                                账号 page status line
 *   loginStatus(text)                           重新登录 status line
 *   toast(text)                                 dock-level status (+ pill flash)
 *   onChange()                                  re-render hook (state/snapshot changed)
 *   sleep(ms), now()                            timing (tests shrink them) */
import { normalizeAccounts, applySnapshot, removeAccount, planSwitch, setPending, resolvePending, credsFor, accountLabel, canLogin, isRealLogin, dropSession, lostMessage, setLabel } from './accounts.js';

const noop = () => {};
const errText = (e) => (e && e.message) || String(e);
const isTimeout = (e) => /超时|timeout/i.test(errText(e));
/* Where a switch / add lands: the site root. The URL we are on belongs to the
 * account we are leaving (its conversation) — the new account cannot open it,
 * and a failed load there is what used to end in a logged-out page. */
export const HOME_PATH = '/agent'; // 0.4.8: land on the Agent Mode composer
/* After a switch was confirmed by the first snapshot, the site may still
 * reject the restored refresh token a few seconds later (its middleware /
 * auth client refreshes on load; a dead token family ends in a sign-out and
 * an anonymous re-login). A guest snapshot inside this window is treated as
 * "lost", not as the user logging out. */
export const VERIFY_MS = 20_000;

export function createAccountFlow(deps) {
  const d = {
    loadStore: async () => null, saveStore: async () => {}, invoke: null, navigating: noop,
    status: noop, loginStatus: noop, toast: noop, onChange: noop,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    ...deps,
  };
  if (typeof d.call !== 'function' || typeof d.reload !== 'function') throw new Error('createAccountFlow: call() and reload() are required');
  const flow = { accounts: normalizeAccounts(null), snap: null, busy: false, verify: null /* { id, until } */ };
  const invoke = (cmd, args) => (d.invoke ? Promise.resolve(d.invoke(cmd, args)).catch((e) => d.toast(cmd + ' 失败: ' + errText(e))) : Promise.resolve());
  const changed = () => { try { d.onChange(); } catch { /* render errors must not break the flow */ } };
  /* After a page-side `restore` / `clear` answered with navigateTo the page is
   * already on its way; otherwise (older page script) reload it ourselves. */
  const leave = async (res, source) => {
    if (res && res.navigateTo) { try { d.navigating(res.navigateTo, source); } catch { /* ui only */ } return 'page'; }
    await d.sleep(300);
    await d.reload();
    return 'reload';
  };

  flow.load = async () => { flow.accounts = normalizeAccounts(await d.loadStore().catch(() => null)); changed(); return flow.accounts; };
  flow.save = async (next) => {
    flow.accounts = normalizeAccounts(next);
    await d.saveStore(flow.accounts).catch((e) => d.status('保存账号失败: ' + errText(e)));
    changed();
    return flow.accounts;
  };

  /* Every snapshot goes through here (watcher event, RPC answer, boot probe).
   * Returns { outcome, created, account } so callers/tests can inspect it. */
  flow.onSnapshot = async (snap) => {
    if (!snap || typeof snap !== 'object') return { outcome: null, created: false, account: null };
    flow.snap = snap;
    const now = d.now();
    const before = JSON.stringify(flow.accounts);
    let { state: st1, outcome } = resolvePending(flow.accounts, snap, now);
    // post-switch verification: the site threw the restored session away
    if (!outcome && flow.verify) {
      const v = flow.verify;
      const target = st1.list.find((a) => a.id === v.id) || null;
      if (now > v.until || !target) flow.verify = null;
      else if (!isRealLogin(snap)) {
        flow.verify = null;
        st1 = dropSession(st1, v.id);
        outcome = { status: 'lost', account: st1.list.find((a) => a.id === v.id) || target, message: lostMessage(target, !!snap.anonymous) };
      } else if (target.userId && snap.userId && String(snap.userId) !== target.userId) flow.verify = null; // someone else logged in on purpose
    }
    const merged = applySnapshot(st1, snap, now);
    if (JSON.stringify(merged.state) !== before) await flow.save(merged.state);
    if (outcome) await handleOutcome(outcome, snap);
    else if (merged.created) {
      d.status('已自动保存当前账号 ' + accountLabel(merged.account));
      d.toast('账号已记录: ' + accountLabel(merged.account));
    }
    changed();
    return { outcome, created: !!merged.created, account: merged.account || null };
  };

  async function handleOutcome(outcome, snap) {
    d.status(outcome.message);
    if (outcome.status === 'switched' || outcome.status === 'added' || outcome.status === 'logged-in') {
      d.toast(outcome.message);
      d.loginStatus('');
      await invoke('login_clear', {});
      flow.verify = outcome.status === 'switched' && outcome.account ? { id: outcome.account.id, until: d.now() + VERIFY_MS } : null;
    } else if (outcome.status === 'lost') {
      // the user decides: 登录 on the card runs the automated re-login
      d.toast(outcome.message);
      d.status(outcome.message + '。点该账号的「登录」即可自动重新登录');
    }
  }

  /* 切换 → target with a saved session: swap cookies + leave for the site
   * root; otherwise (登录) the automated re-login. The swap is guarded by the snapshot's
   * signature: if the page's cookies rotated between our snapshot and the
   * restore, the page refuses, we persist the newer tokens of the account we
   * are leaving and try once more — so no saved session is ever older than
   * what the site last issued. */
  flow.switchTo = async (id) => {
    const plan = planSwitch(flow.accounts, id);
    if (!plan.ok) { d.status(plan.reason); return { ok: false, reason: plan.reason }; }
    if (flow.busy) return { ok: false, reason: 'busy' };
    flow.busy = true;
    let navigated = false;
    try {
      const snap = await d.call('snapshot', {}).catch((e) => { d.status('读取页面登录状态失败: ' + errText(e)); return null; });
      if (!snap) return { ok: false, reason: 'no-snapshot' };
      let st = flow.accounts;
      if (isRealLogin(snap)) st = applySnapshot(st, snap, d.now()).state; // the account we leave stays fresh
      if (plan.mode === 'login') { await flow.startLogin(plan.target, { snap, st }); return { ok: true, mode: 'login' }; }
      st = setPending(st, { type: 'switch', id }, d.now());
      await flow.save(st);
      d.status('正在切换到 ' + accountLabel(plan.target) + '…');
      const args = { cookies: plan.target.cookies, scope: snap.scope || '', navigate: HOME_PATH };
      let res = await d.call('restore', { ...args, expectSig: snap.sig || '' });
      if (res && res.stale) {
        // token rotation slipped in between: save what the page holds now, retry once
        if (isRealLogin(res.previous)) await flow.save(applySnapshot(flow.accounts, res.previous, d.now()).state);
        res = await d.call('restore', { ...args, expectSig: (res.previous && res.previous.sig) || '' });
        if (res && res.stale) throw new Error('页面的登录状态正在变化，请稍后再试');
      }
      navigated = (await leave(res, 'switch')) === 'page';
      return { ok: true, mode: 'cookies', via: navigated ? 'page' : 'reload' };
    } catch (e) {
      if (isTimeout(e) && !navigated) {
        // The page answers and leaves in the same task; a lost answer most
        // likely means it is already loading the new session. Leave the
        // pending switch for the first snapshot (or its 5 min TTL) to settle.
        d.status('页面正在跳转，等待新账号加载…');
        return { ok: true, mode: 'cookies', via: 'unknown' };
      }
      d.status('切换失败: ' + errText(e));
      await flow.save(setPending(flow.accounts, null));
      return { ok: false, reason: errText(e) };
    } finally {
      flow.busy = false;
      changed();
    }
  };

  const lower = (v) => String(v || '').trim().toLowerCase();
  function sameIdentity(acc, snap) {
    if (acc.userId && snap.userId) return acc.userId === String(snap.userId);
    const want = lower(acc.email);
    return !!want && want === lower(snap.email);
  }

  /* One-tap re-login (the manual Google round trip, automated — see
   * injected/account.js): Rust remembers WHO for every page load (that is how
   * the target reaches accounts.google.com); a page that still holds another
   * session is cleared + left for /agent first, a logged-out page starts at
   * once. */
  flow.startLogin = async (acc, { snap = null, st = flow.accounts } = {}) => {
    if (!canLogin(acc)) {
      d.status('该账号没有邮箱，无法自动重新登录：请在页面上手动登录');
      return { ok: false, reason: 'no-email' };
    }
    const cur = snap || await d.call('snapshot', {}).catch(() => null);
    // Already logged in AS this account: nothing to do (no sign-in on top).
    if (isRealLogin(cur) && sameIdentity(acc, cur)) {
      await flow.save(setPending(applySnapshot(st, cur, d.now()).state, null));
      await invoke('login_clear', {});
      d.loginStatus('页面已经登录 ' + accountLabel(acc) + '，无需再登录');
      return { ok: true, via: 'already' };
    }
    if (isRealLogin(cur)) st = applySnapshot(st, cur, d.now()).state;
    st = setPending(st, { type: 'login', id: acc.id }, d.now());
    await flow.save(st);
    const creds = credsFor(acc);
    d.loginStatus('正在重新登录 ' + accountLabel(acc) + '：清除失效登录 → Google 登录 → 选择该账号 → 继续');
    await invoke('login_set', { creds });
    // A page that still holds another (real) session is cleared and left for
    // the site root; a guest / logged-out page runs the helper right here.
    if (cur && cur.hasAuthCookie && !cur.anonymous) {
      let res = null;
      try { res = await d.call('clear', { navigate: HOME_PATH }); } catch (e) {
        if (!isTimeout(e)) { d.status('清除登录 Cookie 失败: ' + errText(e)); await d.reload(); return { ok: true, via: 'reload' }; }
        return { ok: true, via: 'unknown' };
      }
      return { ok: true, via: await leave(res, 'login') };
    }
    await d.call('login', { creds }).catch((e) => d.loginStatus('无法开始重新登录: ' + errText(e)));
    return { ok: true, via: 'page' };
  };

  /* 添加另一个账号: keep the current one, clear the page's session (guest
   * cookies included) and go straight to Google's sign-in, where the page
   * taps "Use another account" → Google's account input page; the user types
   * the new account there. The first real login afterwards is saved. */
  flow.add = async () => {
    if (flow.busy) return { ok: false, reason: 'busy' };
    flow.busy = true;
    try {
      const snap = await d.call('snapshot', {}).catch((e) => { d.status('无法读取页面登录状态: ' + errText(e)); return null; });
      if (!snap) return { ok: false, reason: 'no-snapshot' };
      let st = flow.accounts;
      if (isRealLogin(snap)) st = applySnapshot(st, snap, d.now()).state;
      st = setPending(st, { type: 'add' }, d.now());
      await flow.save(st);
      const creds = { mode: 'add', accountId: '', email: '', startedAt: d.now() };
      await invoke('login_set', { creds });
      d.status('正在打开 Google 登录：自动点「使用其他账号」，请在 Google 页面输入要添加的账号；登录完成后自动保存');
      d.loginStatus('添加账号：正在打开 Google 登录…');
      let res = null;
      if (isRealLogin(snap)) {
        // leave the current account's page first; the next page load starts the add
        try { res = await d.call('clear', { navigate: HOME_PATH }); } catch (e) {
          if (isTimeout(e)) return { ok: true, via: 'unknown' };
          throw e;
        }
        return { ok: true, via: await leave(res, 'add') };
      }
      await d.call('login', { creds }).catch((e) => d.loginStatus('无法打开 Google 登录: ' + errText(e)));
      return { ok: true, via: 'page' };
    } catch (e) {
      d.status('操作失败: ' + errText(e));
      return { ok: false, reason: errText(e) };
    } finally {
      flow.busy = false;
      changed();
    }
  };

  flow.saveCurrent = async () => {
    const snap = await d.call('snapshot', {}).catch((e) => { d.status('读取失败: ' + errText(e)); return null; });
    if (!snap) return null;
    if (!isRealLogin(snap)) { d.status(snap.anonymous ? '页面当前是游客状态（未登录），不会记录' : (snap.hasAuthCookie ? '检测到登录 Cookie，但无法解析账号信息' : '页面当前未登录')); return null; }
    const r = await flow.onSnapshot(snap);
    d.status('已保存 ' + (snap.email || snap.userId));
    return r.account;
  };

  flow.remove = async (id) => { await flow.save(removeAccount(flow.accounts, id)); d.status('已删除'); };
  flow.setLabel = async (id, label) => { const r = setLabel(flow.accounts, id, label); if (r.account) { await flow.save(r.state); d.status('备注名已保存'); } return r.account; };

  flow.stopLogin = async () => {
    await invoke('login_clear', {});
    await flow.save(setPending(flow.accounts, null));
    await d.call('stop', {}).catch(() => null);
    d.loginStatus('已取消自动登录');
  };

  flow.find = (id) => flow.accounts.list.find((a) => a.id === id) || null;
  flow.active = () => flow.find(flow.accounts.activeId);
  return flow;
}
