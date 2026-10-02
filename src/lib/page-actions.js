/* Dock → arena page actions, in two transports.
 *
 *   remote   (desktop)  the dock lives in its own webview; every action is
 *                       compiled to a JS string and evaluated inside the
 *                       arena webview through the Rust `arena_command`.
 *   embedded (Android)  the dock is mounted INSIDE the arena page (a single
 *                       WebView per window on mobile), so the same actions run
 *                       directly against the page's `window` — no eval, which
 *                       also keeps us clear of the page CSP.
 *
 * Each action has `js(...args)` (remote) and `run(win, ...args)` (embedded);
 * the two must stay behaviourally identical, which the unit tests enforce. */
import { jsString } from './tauri-api.js';

export const PAGE_ACTIONS = {
  // bridge.js dispatch — dock → page event bus.
  dispatch: {
    js: (name, payload) => `window.__ARENAKIT__&&window.__ARENAKIT__.dispatch(${jsString(name)},${JSON.stringify(payload ?? null)})`,
    run: (w, name, payload) => (w.__ARENAKIT__ ? w.__ARENAKIT__.dispatch(String(name), payload ?? null) : 0),
  },
  // Full navigation (history "打开" fallback).
  open: {
    js: (url) => `location.assign(${jsString(url)})`,
    run: (w, url) => w.location.assign(String(url)),
  },
  eniSet: {
    js: (on, text) => `window.__AK_ENI_SET__ && window.__AK_ENI_SET__(${!!on}, ${jsString(text)})`,
    run: (w, on, text) => (w.__AK_ENI_SET__ ? w.__AK_ENI_SET__(!!on, String(text)) : undefined),
  },
  // Feature flags read by the injected scripts (snoop capture / pulse polling /
  // reply monitor): window.__ARENAKIT_FLAGS__[name] = on.
  flagSet: {
    js: (name, on) => `window.__ARENAKIT_FLAGS__=window.__ARENAKIT_FLAGS__||{};window.__ARENAKIT_FLAGS__[${jsString(name)}]=${!!on}`,
    run: (w, name, on) => { w.__ARENAKIT_FLAGS__ = w.__ARENAKIT_FLAGS__ || {}; w.__ARENAKIT_FLAGS__[String(name)] = !!on; },
  },
  // Browser controls (reference app panel: ‹ 后退 / 前进 › / 刷新).
  navBack: {
    js: () => 'window.history&&window.history.back()',
    run: (w) => (w.history ? w.history.back() : undefined),
  },
  navForward: {
    js: () => 'window.history&&window.history.forward()',
    run: (w) => (w.history ? w.history.forward() : undefined),
  },
  // Marks sessionStorage first so the NEXT document shows the top progress
  // bar from document_start (bridge.js reads and clears the flag).
  reload: {
    js: () => "try{sessionStorage.setItem('arenakit.reloading',String(Date.now()))}catch(e){}window.location&&window.location.reload&&window.location.reload()",
    run: (w) => {
      try { w.sessionStorage.setItem('arenakit.reloading', String(Date.now())); } catch { /* storage blocked */ }
      return w.location && typeof w.location.reload === 'function' ? w.location.reload() : undefined;
    },
  },
  // probe.js RPC: answered asynchronously through the bridge as 'probe-result'.
  probeCall: {
    js: (action, argsJson, reqId) => '(function(){var a=' + jsString(action) + ',g=' + jsString(argsJson) + ',r=' + jsString(reqId) + ';'
      + 'if(window.ArenaProbe&&window.ArenaProbe.call){window.ArenaProbe.call(a,g,r);}'
      + "else if(window.__ARENAKIT__){window.__ARENAKIT__.send('probe-result',{reqId:r,ok:false,error:'探针脚本未加载，请刷新 Arena 页面'});}})();",
    run: (w, action, argsJson, reqId) => {
      if (w.ArenaProbe && typeof w.ArenaProbe.call === 'function') { w.ArenaProbe.call(String(action), String(argsJson), String(reqId)); return; }
      if (w.__ARENAKIT__) w.__ARENAKIT__.send('probe-result', { reqId: String(reqId), ok: false, error: '探针脚本未加载，请刷新 Arena 页面' });
    },
  },
  // account.js RPC (snapshot / restore / clear / login / fill / stop):
  // answered asynchronously through the bridge as 'account-result'.
  accountCall: {
    js: (action, argsJson, reqId) => '(function(){var a=' + jsString(action) + ',g=' + jsString(argsJson) + ',r=' + jsString(reqId) + ';'
      + 'if(window.ArenaAccount&&window.ArenaAccount.call){window.ArenaAccount.call(a,g,r);}'
      + "else if(window.__ARENAKIT__){window.__ARENAKIT__.send('account-result',{reqId:r,ok:false,error:'账号脚本未加载，请刷新 Arena 页面'});}})();",
    run: (w, action, argsJson, reqId) => {
      if (w.ArenaAccount && typeof w.ArenaAccount.call === 'function') { w.ArenaAccount.call(String(action), String(argsJson), String(reqId)); return; }
      if (w.__ARENAKIT__) w.__ARENAKIT__.send('account-result', { reqId: String(reqId), ok: false, error: '账号脚本未加载，请刷新 Arena 页面' });
    },
  },
};

/* Build a `call(name, ...args) → Promise` bound to one transport.
 *   evalInPage(js)  remote transport (required unless `win` is given)
 *   win             embedded transport: the page window to act on
 * Unknown action names reject; embedded run() exceptions reject too, so both
 * transports surface failures the same way. */
export function createPageActions({ evalInPage, win } = {}) {
  const embedded = !!win;
  return function call(name, ...args) {
    const a = PAGE_ACTIONS[name];
    if (!a) return Promise.reject(new Error('未知页面动作: ' + name));
    if (embedded) {
      try { return Promise.resolve(a.run(win, ...args)); } catch (e) { return Promise.reject(e); }
    }
    if (typeof evalInPage !== 'function') return Promise.reject(new Error('没有可用的页面通道'));
    return Promise.resolve().then(() => evalInPage(a.js(...args)));
  };
}
