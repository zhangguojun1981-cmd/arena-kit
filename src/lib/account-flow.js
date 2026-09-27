/* 账号 flow — the orchestration between the saved-accounts model
 * (src/lib/accounts.js), the page-side cookie jar (injected/account.js, reached
 * through an RPC `call(action, args)`), the store and the WebView reload. Pure
 * of DOM so the whole switch / add / login journey can be driven in tests with
 * the real account.js on a fake document.cookie (tests/account-flow.test.mjs).
 *
 * Deps (all optional except call/reload):
 *   call(action, args, opts) → Promise<data>   page RPC (snapshot / restore / clear / login / fill / stop)
 *   loadStore() → Promise<raw>, saveStore(state) → Promise   persistence (store key `accounts`)
 *   reload() → Promise                          reload the Arena page (`account` source)
 *   invoke(cmd, args) → Promise                 Tauri commands login_set / login_clear
 *   status(text)                                账号 page status line
 *   loginStatus(text)                           登录助手 status line
 *   toast(text)                                 dock-level status (+ pill flash)
 *   needLogin(account)                          the target has no credentials → open the editor
 *   onChange()                                  re-render hook (state/snapshot changed)
 *   sleep(ms), now()                            timing (tests shrink them) */
import { normalizeAccounts, applySnapshot, removeAccount, planSwitch, setPending, resolvePending, credsFor, accountLabel, hasLogin } from './accounts.js';

const noop = () => {};
const errText = (e) => (e && e.message) || String(e);

export function createAccountFlow(deps) {
  const d = {
    loadStore: async () => null, saveStore: async () => {}, invoke: null,
    status: noop, loginStatus: noop, toast: noop, needLogin: noop, onChange: noop,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    ...deps,
  };
  if (typeof d.call !== 'function' || typeof d.reload !== 'function') throw new Error('createAccountFlow: call() and reload() are required');
  const flow = { accounts: normalizeAccounts(null), snap: null, busy: false };
  const invoke = (cmd, args) => (d.invoke ? Promise.resolve(d.invoke(cmd, args)).catch((e) => d.toast(cmd + ' 失败: ' + errText(e))) : Promise.resolve());
  const changed = () => { try { d.onChange(); } catch { /* render errors must not break the flow */ } };

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
    const { state: st1, outcome } = resolvePending(flow.accounts, snap, now);
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
    } else if (outcome.status === 'lost') {
      const acc = outcome.account;
      if (acc && acc.login && acc.login.auto !== false && hasLogin(acc)) {
        d.status(outcome.message + '，正在自动登录…');
        await flow.startLogin(acc, { snap });
      } else {
        d.status(outcome.message + '。请在页面登录，或点 ✎ 填写登录信息后一键登录');
      }
    }
  }

  /* 切换 → target with a saved session: swap cookies + reload; otherwise login helper. */
  flow.switchTo = async (id) => {
    const plan = planSwitch(flow.accounts, id);
    if (!plan.ok) { d.status(plan.reason); return { ok: false, reason: plan.reason }; }
    if (flow.busy) return { ok: false, reason: 'busy' };
    flow.busy = true;
    try {
      const snap = await d.call('snapshot', {}).catch((e) => { d.status('读取页面登录状态失败: ' + errText(e)); return null; });
      if (!snap) return { ok: false, reason: 'no-snapshot' };
      let st = flow.accounts;
      if (snap.loggedIn) st = applySnapshot(st, snap, d.now()).state; // the account we leave stays fresh
      if (plan.mode === 'login') { await flow.startLogin(plan.target, { snap, st }); return { ok: true, mode: 'login' }; }
      st = setPending(st, { type: 'switch', id }, d.now());
      await flow.save(st);
      d.status('正在切换到 ' + accountLabel(plan.target) + '…');
      await d.call('restore', { cookies: plan.target.cookies, scope: snap.scope || '' });
      await d.sleep(350); // let the WebView flush document.cookie writes before navigating
      await d.reload();
      return { ok: true, mode: 'cookies' };
    } catch (e) {
      d.status('切换失败: ' + errText(e));
      await flow.save(setPending(flow.accounts, null));
      return { ok: false, reason: errText(e) };
    } finally {
      flow.busy = false;
      changed();
    }
  };

  /* Login helper for one account: Rust remembers the credentials for every
   * page load (that is how they reach accounts.google.com); a page that still
   * holds another session is cleared + reloaded first, a logged-out page starts
   * the helper right away. */
  flow.startLogin = async (acc, { snap = null, st = flow.accounts } = {}) => {
    if (!hasLogin(acc)) {
      d.status('请先填写该账号的登录信息（邮箱 / 密码 / 2FA）');
      d.needLogin(acc);
      return { ok: false, reason: 'no-credentials' };
    }
    const cur = snap || await d.call('snapshot', {}).catch(() => null);
    if (cur && cur.loggedIn) st = applySnapshot(st, cur, d.now()).state;
    st = setPending(st, { type: 'login', id: acc.id }, d.now());
    await flow.save(st);
    const creds = credsFor(acc);
    d.loginStatus('登录助手已启动：' + accountLabel(acc));
    await invoke('login_set', { creds });
    if (cur && cur.hasAuthCookie) {
      await d.call('clear', {}).catch((e) => d.status('清除登录 Cookie 失败: ' + errText(e)));
      await d.sleep(300);
      await d.reload();
      return { ok: true, via: 'reload' };
    }
    await d.call('login', { creds }).catch((e) => d.loginStatus('无法启动登录助手: ' + errText(e)));
    return { ok: true, via: 'page' };
  };

  /* 添加另一个账号: keep the current one, clear the page's session, reload → login. */
  flow.add = async () => {
    if (flow.busy) return { ok: false, reason: 'busy' };
    flow.busy = true;
    try {
      const snap = await d.call('snapshot', {}).catch((e) => { d.status('无法读取页面登录状态: ' + errText(e)); return null; });
      if (!snap) return { ok: false, reason: 'no-snapshot' };
      let st = flow.accounts;
      if (snap.loggedIn) st = applySnapshot(st, snap, d.now()).state;
      st = setPending(st, { type: 'add' }, d.now());
      await flow.save(st);
      if (snap.hasAuthCookie) await d.call('clear', {});
      await invoke('login_clear', {});
      d.status('已清除页面登录状态；刷新后请登录另一个账号，登录完成后会自动保存');
      await d.sleep(300);
      await d.reload();
      return { ok: true };
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
    if (!snap.loggedIn) { d.status(snap.hasAuthCookie ? '检测到登录 Cookie，但无法解析账号信息' : '页面当前未登录'); return null; }
    const r = await flow.onSnapshot(snap);
    d.status('已保存 ' + (snap.email || snap.userId));
    return r.account;
  };

  flow.remove = async (id) => { await flow.save(removeAccount(flow.accounts, id)); d.status('已删除'); };

  flow.stopLogin = async () => {
    await invoke('login_clear', {});
    await flow.save(setPending(flow.accounts, null));
    await d.call('stop', {}).catch(() => null);
    d.loginStatus('登录助手已停止');
  };

  flow.find = (id) => flow.accounts.list.find((a) => a.id === id) || null;
  flow.active = () => flow.find(flow.accounts.activeId);
  return flow;
}
