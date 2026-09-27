/* Dock → page JS-RPC (the Tauri counterpart of Android ProbeController.rpc()).
 * Each call evaluates `window.ArenaProbe.call(action, argsJson, reqId)` inside
 * the arena webview; probe.js answers through the bridge as a `probe-result`
 * page event, which the dock feeds into deliver(). Times out like Android
 * (35 s) so a wedged page can never hang the orchestrator. */
import { jsString } from './tauri-api.js';

export const RPC_TIMEOUT_MS = 35_000;

export function createRpc({ evalInPage, timeoutMs = RPC_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const pending = new Map();
  let seq = 0;

  function call(action, args = {}, { timeout = timeoutMs } = {}) {
    const reqId = 'r' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => { pending.delete(reqId); reject(new Error(action + ' 超时')); }, timeout);
      pending.set(reqId, { resolve, reject, timer, action });
      const js = '(function(){var a=' + jsString(action) + ',g=' + jsString(JSON.stringify(args ?? {})) + ',r=' + jsString(reqId) + ';'
        + 'if(window.ArenaProbe&&window.ArenaProbe.call){window.ArenaProbe.call(a,g,r);}'
        + "else if(window.__ARENAKIT__){window.__ARENAKIT__.send('probe-result',{reqId:r,ok:false,error:'探针脚本未加载，请刷新 Arena 页面'});}})();";
      Promise.resolve().then(() => evalInPage(js)).catch((e) => {
        const p = pending.get(reqId);
        if (!p) return;
        pending.delete(reqId);
        clearTimeoutFn(p.timer);
        reject(new Error('无法执行页面脚本: ' + (e && e.message || e)));
      });
    });
  }

  /* Feed a probe-result payload; returns false when nobody is waiting. */
  function deliver(res) {
    const p = res && typeof res === 'object' ? pending.get(res.reqId) : null;
    if (!p) return false;
    pending.delete(res.reqId);
    clearTimeoutFn(p.timer);
    if (res.ok) p.resolve(res.data && typeof res.data === 'object' ? res.data : {});
    else p.reject(new Error(String(res.error || (p.action + ' 失败'))));
    return true;
  }

  function cancelAll(reason = '已取消') {
    for (const [id, p] of pending) { clearTimeoutFn(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  }

  return { call, deliver, cancelAll, get pendingCount() { return pending.size; } };
}
