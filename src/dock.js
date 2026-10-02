/* ArenaKit native side dock logic.
 * Desktop: runs in its own webview. Talks to Rust via Tauri IPC
 * (window.__TAURI__), and to the arena.ai webview via Rust commands
 * (arena_command evals into the page; the page answers through page_event →
 * "arenakit://page").
 * Android: mobile Tauri has one webview per window, so scripts/bundle-dock.mjs
 * packs this file + ./lib into src/embed/dock-embedded.gen.js and
 * embed/shell.js mounts the same markup inside the arena page (shadow DOM).
 * `__ARENAKIT_EMBED__` marks that mode: DOM lookups go through the shadow root
 * and page actions run directly (lib/page-actions.js) instead of via eval.
 *
 * Structure: one listener per Rust event, a name→handler map for page events,
 * and small feature modules below. Pure logic lives in ./lib (unit-tested with
 * node:test); this file only wires DOM + IPC. */

import { getTauri, createStore } from './lib/tauri-api.js';
import { createPageActions } from './lib/page-actions.js';
import { usageFromReport, mergeUsage, summarizeUsage, formatUsage, formatTokens, formatMoney, completion, exportEvidence } from './lib/usage.js';
import { runsFor, buildRunView, runLabel, evidenceRows } from './lib/usage-view.js';
import { createHistoryStore, recordModels, recordTurns, searchRecords, grandTotals, exportHistory } from './lib/history.js';
import { createTurnTracker } from './lib/turns.js';
import { createRpc } from './lib/rpc.js';
import { buildTitle, sanitizePrefix } from './lib/rename.js';
import { createReplyMonitor } from './lib/monitor.js';
import { createPulseState } from './lib/pulse.js';
import { pillLabel, turnHeadline } from './lib/pill-layout.js';
import { initialState as watchdogInitialState, parseStatus as watchdogParse, decide as watchdogDecide, applied as watchdogApplied, Reason as WatchdogReason, LOG_RELOADING as WATCHDOG_LOG_RELOADING, LOG_NAG as WATCHDOG_LOG_NAG } from './lib/watchdog.js';
import { accountLabel, accountEmail, initialOf, hasSession, canLogin, loginStageText, sessionAgeText } from './lib/accounts.js';
import { createAccountFlow } from './lib/account-flow.js';
import { resolveModel, SOURCE_TEXT } from './lib/model-resolve.js';
import { createFingerprintRunner, FP_FEATURE_POLL_MS, FP_FEATURE_WAIT_MS } from './lib/fingerprint-runner.js';
import { classify as fingerprintClassify } from './lib/fingerprint.js';
import { fingerprintReference, fingerprintProtocolMeta } from './lib/fingerprint-banks.js';

// Embedded (Android) mode: the dock markup lives in a shadow root inside the
// arena page; otherwise this is the dock webview's own document.
const EMBED = globalThis.__ARENAKIT_EMBED__ && globalThis.__ARENAKIT_EMBED__.root ? globalThis.__ARENAKIT_EMBED__ : null;
const root = EMBED ? EMBED.root : document;
// Desktop = the split-view dock webview (never embedded) or the page-embedded
// pill layout on macOS/Windows/Linux (Rust stamps __ARENAKIT_PLATFORM__ into
// the init script). Android is embedded with platform 'mobile'.
const DESKTOP = !EMBED || globalThis.__ARENAKIT_PLATFORM__ === 'desktop';
const q = (id) => root.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* An avatar URL is placed inside a CSS url("…") in a style attribute: entity-
 * escaping does not help there (the browser decodes &quot; before the CSS is
 * parsed), so only plain https URLs without quote / paren / backslash pass. */
const avatarStyle = (url) => (/^https:\/\/[^\s"'()\\]+$/.test(String(url || '')) ? ` style="background-image:url(&quot;${esc(url)}&quot;)"` : '');

// ── activity log (reference panel_activity: newest line + expandable log) ──
const LOG_MAX = 40;
const LOG_SHOWN = 8;
const activity = { lines: [], last: '' };
function setStatus(t) {
  const line = String(t ?? '');
  q('ak-status').textContent = line;
  if (!line || line === activity.last) return;
  activity.last = line;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
  activity.lines.push(`${hh}:${mm}:${ss} ${line}`);
  if (activity.lines.length > LOG_MAX) activity.lines.splice(0, activity.lines.length - LOG_MAX);
  const box = q('ak-log');
  if (box && !box.hidden) { box.textContent = activity.lines.slice(-LOG_SHOWN).join('\n'); box.scrollTop = box.scrollHeight; }
}
function wireActivity() {
  const row = q('ak-activity');
  const box = q('ak-log');
  if (!row || !box) return;
  const toggle = () => {
    const open = row.getAttribute('aria-expanded') !== 'true';
    row.setAttribute('aria-expanded', String(open));
    box.hidden = !open;
    if (open) { box.textContent = activity.lines.slice(-LOG_SHOWN).join('\n') || '（暂无记录）'; box.scrollTop = box.scrollHeight; }
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}

// ── segmented tabs 对话 / 探针 / 工具 / 更多 (remembered in prefs.panelTab) ──
const TABS = ['chat', 'probe', 'tools', 'account', 'more'];
function showTab(name, { persist = true } = {}) {
  const tab = TABS.includes(name) ? name : 'chat';
  root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  root.querySelectorAll('[data-page]').forEach((p) => { p.dataset.active = String(p.dataset.page === tab); });
  if (persist && state.prefs.panelTab !== tab) savePrefs({ panelTab: tab });
  return tab;
}
function wireTabs() {
  showTab(state.prefs.panelTab, { persist: false });
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
}

const state = {
  tauri: null,
  store: null,
  nav: { sessionId: null, path: '/', title: '' },
  aliases: new Map(),       // page conversation id → stream session id (conversationFor)
  freshChat: null,          // {streamId, at}: first token arrived before the page had a conversation id
  prefs: {},
  // sessionId → { runs: [...mergeUsage shape], models: [{model,provider}], title }
  sessions: new Map(),
  // the run currently shown in the model/usage modules
  current: { sessionId: null, runId: null },
  // usage module override: a saved session (history 查看) and/or a picked run
  view: { sessionId: null, runId: null },
  tracker: createTurnTracker(), // per-conversation turn → model (Android TurnTracker port)
  turnHead: '',             // latest "第 N 轮 · …" headline from tracker.record()
  history: null,            // createHistoryStore()
  historyIndex: new Map(),  // sessionId → record (mirror of the store, newest first on render)
  historyCarry: null,       // evicted totals bucket
  rpc: null,                // createRpc() — dock → page probe.js actions
  // 模型指纹: page-side fixed-probe reducer. It COLLECTS the structured features
  fingerprint: { samples: [], lastResult: null, protocolId: null, sessionId: null, runner: null, collecting: false, stopCollect: false, library: [], traceWaiters: [] },
  monitor: null,            // createReplyMonitor() — reply stream anomaly badges
  pulse: createPulseState(), // daily quota % + anchored reset countdown
  // header + status-pill display state: model/routed/pending, the running
  // task (probe / cleanup / recovery) and a transient flash message
  hud: { model: '', source: '', routed: false, strength: '', pending: false, status: '', task: null, flash: '', flashTimer: 0, alertTimer: 0 },
  reloadAt: 0,              // last requestReload() (800 ms debounce, reference MainActivity)
  loadingAt: 0,             // epoch ms a page reload we asked for started (blocks the watchdog ≤ 30 s)
  taskStartedAt: 0,         // epoch ms the running probe / cleanup / session probe started (0 = none)
  watchdog: watchdogInitialState(), // reply watchdog policy state (src/lib/watchdog.js)
  // 账号: the flow object (src/lib/account-flow.js: saved sessions, last page
  // snapshot, switch/add/login orchestration), the dock → account.js RPC and
  // the editor's target
  acct: null,
  accountRpc: null,
  acctEditId: null,
};

function sessionRecord(sessionId) {
  if (!state.sessions.has(sessionId)) state.sessions.set(sessionId, { runs: [], models: [], title: '' });
  return state.sessions.get(sessionId);
}

// Page conversation id → stream session id (reference TurnIntake.aliases).
// Arena's conversation pages (/c/{evalId}, possibly /agent/{id}) can carry an
// id that differs from the id in the realtime stream URL, while all turn data
// is attributed to the stream id. In-memory only; learned from captured tokens.
const MAX_ALIASES = 512;
// 0.4.8: persisted (store key `aliases`). The page id in /agent/{id} is not
// always the stream session id the history records are keyed by; with the map
// in memory only, every app restart lost it and a known conversation showed
// "此对话尚无本地记录" with no model name.
const ALIASES_KEY = 'aliases';
let aliasSaveTimer = 0;
function aliasSession(pageId, streamId) {
  if (!pageId || !streamId || pageId === streamId) return;
  if (state.aliases.get(pageId) === streamId) return;
  state.aliases.delete(pageId);
  state.aliases.set(pageId, streamId);
  // drop the oldest instead of forgetting everything
  while (state.aliases.size > MAX_ALIASES) state.aliases.delete(state.aliases.keys().next().value);
  // 0.4.9: the history record remembers its page ids too (survives a lost alias map)
  if (state.history && state.historyIndex.has(streamId)) {
    state.history.linkPage(streamId, pageId).then((r) => { if (r) state.historyIndex.set(streamId, r); }).catch(() => {});
  }
  clearTimeout(aliasSaveTimer);
  aliasSaveTimer = setTimeout(() => {
    state.store?.set(ALIASES_KEY, Object.fromEntries(state.aliases)).catch(() => {});
  }, 500);
}
async function loadAliases() {
  const saved = await state.store?.get(ALIASES_KEY).catch(() => null);
  if (!saved || typeof saved !== 'object') return;
  for (const [k, v] of Object.entries(saved)) {
    if (typeof k === 'string' && typeof v === 'string' && k && v && k !== v && !state.aliases.has(k)) state.aliases.set(k, v);
  }
}
function conversationFor(id) {
  let current = id || null;
  for (let hops = 0; current && hops < 4; hops++) {
    const next = state.aliases.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

const DEFAULT_PREFS = {
  eniOn: false,
  eniText: '',
  renamePrefix: '',   // optional title prefix: "<prefix><model>"
  // scheduleAgentDefaults still uses these: app open / account switch →
  // Agent Mode + GitHub on. The old arithmetic-probe project/branch inputs are
  // gone, so repo/branch stay '' (github-only default); the switch moved to the
  // 指纹 panel.
  probeRepo: '',
  probeBranch: '',
  agentDefaults: true,  // app open / account switch → Agent Mode + GitHub on
  fingerprintProtocol: 'modeltrace-long-integers-v1', // last-selected fingerprint protocol
  fingerprintBudget: 3,     // max fixed probes (= 会话/轮数) a fingerprint run may send (1..24)
  // Auto-rename from a fingerprint ESTIMATE (statistical, not a true name). Off
  // by default: renaming is a persistent, user-visible mutation and the
  // estimate is explicitly uncalibrated. When on, a server-confirmed true name
  // still wins, and only an estimate at or above the confidence threshold
  // renames. 0.85 ("lazy mode" default): higher than the classify pass gate
  // (0.6) so only confident attributions rename; reachable because the softmax
  // confidence saturates near 1.0 on well-separated replies.
  fingerprintAutoRename: false,
  fingerprintRenameThreshold: 0.85,
  theme: 'auto',            // 'auto' (follow system, like the reference DayNight theme) | 'light' | 'dark'
  panelTab: 'chat',         // last selected segmented tab
  pillRefresh: true,        // 悬浮窗显示刷新按钮 (Android status pill ⟳ zone)
  autoRefresh: true,        // 回复出错或空白时自动刷新 (reply watchdog)
  ballCenter: 'percent-model', // 悬浮球显示: 'percent-model' | 'percent' | 'model'
  capture: true,            // 截获会话流 (extension 监听 toggle): hand run tokens to Rust
  pulseOn: true,            // 额度轮询: periodic /api/me/pulse reads (manual 刷新 always works)
  monitorOn: true,          // 回复监控: reply-stream anomaly detection
  fingerprintOn: false,     // 模型指纹: page-side fixed-probe reducer (default OFF — opt-in, no raw text ever leaves the page)
};

// ── theme ───────────────────────────────────────────────────────────────
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'auto';
  const el = EMBED ? EMBED.host : document.documentElement;
  if (m === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', m);
  root.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themePick === m)));
  return m;
}
function wireTheme() {
  applyTheme(state.prefs.theme);
  root.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
    savePrefs({ theme: applyTheme(b.dataset.themePick) });
  }));
}

// ── settings: page-side feature flags + ball centre ─────────────────────
const FLAG_PREFS = [['capture', 'capture', 'ak-capture-on'], ['pulse', 'pulseOn', 'ak-pulse-on'], ['monitor', 'monitorOn', 'ak-monitor-on'], ['fingerprint', 'fingerprintOn', 'ak-fingerprint-on']];
/* Push the switches into the arena page (injected snoop / pulse / monitor /
 * watchdog read window.__ARENAKIT_FLAGS__). Re-applied on every page load. */
function applyPageFlags() {
  for (const [flag, key] of FLAG_PREFS) page('flagSet', flag, state.prefs[key] !== false);
  page('flagSet', 'autoRefresh', state.prefs.autoRefresh !== false);
  // ENI prefs are pushed on every page load (and again on every change) so
  // the injected eni.js stays in sync with the dock even after a SPA
  // navigation that wipes page context.
  page('eniSet', !!state.prefs.eniOn, state.prefs.eniText || '');
}
// (桌面布局 option removed: macOS uses the split-view dock exclusively now;
// the embedded pill + bottom sheet is Android-only. Historical
// `prefs.desktopLayout` values are ignored.)

// 悬浮球显示 (Android status pill only — the desktop dock has no pill, the
// row is hidden via CSS). Three modes:
//   'percent-model' (default): ring = quota %, label = current model / task
//   'percent'                  : ring = quota %, no label
//   'model'                    : label only, no ring (model name centred)
// The shell renders the picked mode via setPill({mode}); CSS hides the ring
// or the label accordingly. The alert blink (reply anomaly) is independent
// of the mode and always lights the outline red.
const BALL_CENTERS = ['percent-model', 'percent', 'model'];
function wireBallCenter() {
  const row = q('ak-ballcenter-row');
  if (!row) return;
  if (!EMBED) { row.hidden = true; return; }
  row.hidden = false;
  const picked = () => (BALL_CENTERS.includes(state.prefs.ballCenter) ? state.prefs.ballCenter : 'percent-model');
  const render = (p) => {
    root.querySelectorAll('[data-ballcenter-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ballcenterPick === p)));
  };
  render(picked());
  root.querySelectorAll('[data-ballcenter-pick]').forEach((b) => b.addEventListener('click', () => {
    const p = BALL_CENTERS.includes(b.dataset.ballcenterPick) ? b.dataset.ballcenterPick : 'percent-model';
    savePrefs({ ballCenter: p });
    render(p);
    renderPill();
  }));
}

function wireSettings() {
  wireBallCenter();
  for (const [flag, key, id] of FLAG_PREFS) {
    const el = q(id);
    el.checked = state.prefs[key] !== false;
    el.addEventListener('change', () => {
      savePrefs({ [key]: el.checked });
      page('flagSet', flag, el.checked);
      if (flag === 'capture') setStatus(el.checked ? '已开启截获会话流' : '已关闭截获会话流：不再识别模型，直到重新开启');
      if (flag === 'pulse') { setStatus(el.checked ? '已开启额度轮询' : '已关闭额度轮询（可手动刷新）'); if (el.checked) dispatchToPage('pulse-refresh', null); }
      if (flag === 'monitor') { setStatus(el.checked ? '已开启回复监控' : '已关闭回复监控'); renderMonitor(); }
      if (flag === 'fingerprint') { setStatus(el.checked ? '已开启模型指纹（统计估计·非真名·需手动运行）' : '已关闭模型指纹'); setFingerprintRunningUi(state.fingerprint.runner ? state.fingerprint.runner.isRunning : false); renderFingerprintState(); }
    });
  }
  // 悬浮窗显示刷新按钮 (Android pill ⟳ zone; the row is hidden in the desktop dock via CSS)
  const refreshNote = q('ak-refresh-note');
  if (refreshNote && DESKTOP) refreshNote.textContent = '⌘R / Ctrl+R / F5 也会刷新；刷新时顶部显示进度条。';
  const pillRefresh = q('ak-pill-refresh');
  if (pillRefresh) {
    pillRefresh.checked = state.prefs.pillRefresh !== false;
    if (EMBED && typeof EMBED.setRefreshButton === 'function') EMBED.setRefreshButton(pillRefresh.checked);
    pillRefresh.addEventListener('change', () => {
      savePrefs({ pillRefresh: pillRefresh.checked });
      if (EMBED && typeof EMBED.setRefreshButton === 'function') EMBED.setRefreshButton(pillRefresh.checked);
    });
  }
  // 回复出错或空白时自动刷新 (reply watchdog policy)
  const autoRefresh = q('ak-auto-refresh');
  if (autoRefresh) {
    autoRefresh.checked = state.prefs.autoRefresh !== false;
    autoRefresh.addEventListener('change', () => {
      savePrefs({ autoRefresh: autoRefresh.checked });
      page('flagSet', 'autoRefresh', autoRefresh.checked);
      setStatus(autoRefresh.checked ? '已开启：回复出错或空白时自动刷新' : '已关闭自动刷新（回复异常仍会记录）');
    });
  }
  // steppers (本轮最多发送 等): a [data-step] button adjusts the number input
  // named by data-step-target (default: the fingerprint budget).
  root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const targetId = b.dataset.stepTarget || 'ak-fingerprint-budget';
    const input = q(targetId);
    if (!input) return;
    const lo = parseInt(input.min, 10); const hi = parseInt(input.max, 10);
    const min = Number.isFinite(lo) ? lo : 1;
    const max = Number.isFinite(hi) ? hi : 24;
    const base = parseInt(input.value, 10) || min;
    const n = Math.min(max, Math.max(min, base + Number(b.dataset.step)));
    input.value = String(n);
    if (targetId === 'ak-fingerprint-budget') persistFingerprintPanel();
  }));
}

// ── page reload (pill ⟳ · quick menu 刷新页面 · 工具 → 刷新 · pull-up · desktop ⌘R) ──
/* Reference MainActivity.requestReload: 800 ms debounce; when a probe /
 * cleanup is running ask first ("停止并刷新"), then stop it and reload. The
 * page marks sessionStorage so the NEXT document shows the top progress bar
 * from document_start (bridge.js); the pill spins meanwhile. */
function confirmDialog(opts) {
  if (EMBED && typeof EMBED.confirm === 'function') return EMBED.confirm(opts);
  try { return Promise.resolve(globalThis.confirm ? globalThis.confirm(`${opts.title}\n${opts.message}`) : true); } catch { return Promise.resolve(true); }
}
async function requestReload(source = 'panel') {
  const now = Date.now();
  if (now - state.reloadAt < 800) return false;
  if (source === 'watchdog' && state.rpc && (!EMBED || typeof globalThis.ArenaProbe === 'object')) {
    const pre = await state.rpc.call('precheck').catch(() => null);
    if (pre?.hasDraft && !pre.draftIsOwnPrompt) {
      setStatus('回复异常，但输入框有未发送草稿；已停止自动刷新，请手动处理');
      flashPill('有草稿 · 请手动刷新', 4000);
      return false;
    }
  }
  state.reloadAt = now;
  // A reload tears down the page the fingerprint runner drives, so stop it
  // first (ask, unless the watchdog is auto-recovering a broken page).
  const fpRunning = !!(state.fingerprint.runner && state.fingerprint.runner.isRunning);
  if (fpRunning) {
    if (source !== 'watchdog') {
      const ok = await confirmDialog({ title: '刷新页面？', message: '指纹探测正在运行，刷新会中断本次探测。', ok: '停止并刷新', cancel: '取消' });
      if (!ok) return false;
    }
    try { state.fingerprint.runner.stop(); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (source === 'watchdog') setStatus(WATCHDOG_LOG_RELOADING);
  else setStatus(source === 'pull' ? '上拉刷新页面…' : source === 'account' ? '切换账号，刷新页面…' : source === 'setting' ? '应用设置，刷新页面…' : '刷新页面…');
  const btn = root.querySelector('[data-action="page-reload"]');
  if (btn) btn.dataset.loading = 'true';
  state.loadingAt = now;
  if (EMBED && typeof EMBED.setLoading === 'function') EMBED.setLoading(true);
  if (EMBED) EMBED.close();
  await page('reload');
  // Desktop: the arena webview reloads in place; the dock keeps running, so
  // clear the header spinner after a moment. Embedded, the page (and this
  // dock) go away — the timer is only a safety net if the reload never came.
  setTimeout(() => { if (btn) btn.dataset.loading = 'false'; state.loadingAt = 0; }, EMBED ? 30_000 : 1500);
  return true;
}

// ── HUD header (reference panel top: model · status · pulse) ────────────
/* Every place that learns something about the current conversation's model
 * goes through here, so the header, the 服务端模型 module and (on Android)
 * the floating ball never disagree. `known` false = placeholder text. */
function setModelDisplay(text, { routed = false, known = true, pending = false, strength = '', source = 'live' } = {}) {
  const t = String(text || '');
  const hud = q('ak-hud-model');
  const tag = source === 'title' ? '（标题推断）' : source === 'fingerprint' ? '（指纹推断）' : '';
  const label = known && t ? t + (strength ? ' · ' + strength : '') + tag : '模型待确认';
  state.hud.source = known && t ? source : '';
  hud.textContent = label;
  hud.dataset.known = String(!!(known && t));
  hud.dataset.routed = String(!!routed);
  state.hud.model = known && t ? t : '';
  state.hud.strength = known && t ? String(strength || '') : '';
  state.hud.routed = !!routed;
  state.hud.pending = !!pending && !(known && t);
  renderPill();
}
/* The newest model this conversation is known to have answered with (the
 * tracker's last identified turn), or nothing. */
function showLastKnownModel() {
  const t = state.tracker;
  if (t && t.lastModel) { setModelDisplay(t.lastModel, { routed: !!t.routed, known: true }); return; }
  // nothing identified in this run → the local record / runs / title (0.4.9)
  if (refreshCurrentModel('fallback', { force: true })) return;
  setModelDisplay('', { known: false });
}
/* Re-resolve the on-screen conversation's model from every local source
 * (lib/model-resolve.js). Runs when a source changes: history / aliases
 * loaded, a trace ended without labels, a same-conversation nav while the
 * header is empty. Only fills an empty / weaker display; never overrides a
 * model identified in this run or the 识别中… state (unless forced by the
 * trace ending). Returns true when something is shown. */
const SOURCE_RANK = { '': 0, title: 1, fingerprint: 2, turns: 3, runs: 4, history: 5, live: 6 };
function resolveCurrent() {
  return resolveModel({
    pageId: state.nav.sessionId,
    conversationFor,
    sessions: state.sessions,
    historyIndex: state.historyIndex,
    tracker: state.tracker,
    title: state.nav.title,
    prefix: state.prefs.renamePrefix || '',
  });
}
function refreshCurrentModel(reason, { force = false } = {}) {
  if (!state.nav.sessionId) return false;
  if (state.hud.pending && !force) return false;
  const r = resolveCurrent();
  if (!r.models.length) return false;
  if (state.hud.model && (SOURCE_RANK[state.hud.source] || 0) >= (SOURCE_RANK[r.source] || 0)) return true;
  applyResolved(r, { rebuild: r.source !== 'turns' && (state.tracker.sessionId !== r.sid || !state.tracker.turns.length) });
  if (reason !== 'fallback') console.debug('[dock] model re-resolved', reason, r.source);
  return true;
}
/* Show a resolveModel() result for the conversation on screen. */
function applyResolved(r, { rebuild = true } = {}) {
  if (r.pageMatch && r.sid) aliasSession(state.nav.sessionId, r.sid); // learned from record.pageIds
  const sid = r.sid || conversationFor(state.nav.sessionId);
  if (r.record && !state.sessions.has(sid)) restoreFromHistory(sid);
  const rec = state.sessions.get(sid);
  const last = rec?.runs?.at(-1);
  if (!state.current.sessionId || state.current.sessionId !== sid) state.current = { sessionId: sid, runId: last?.runId || null };
  if (rebuild) {
    if (r.record) rebuildTrackerFromRecord(sid, r.record);
    else if (state.tracker.sessionId !== sid) { state.tracker.reset(sid); renderTurns(); }
  }
  if (r.models.length) {
    setModelDisplay(r.models.map((m) => m.model).join(' / '), { known: true, source: r.source, routed: r.source === 'live' && !!state.tracker.routed });
    q('ak-model-sub').textContent = [last ? 'run ' + last.runId.slice(0, 14) : '', last ? completion(last.spans) : '', SOURCE_TEXT[r.source] || ''].filter(Boolean).join(' · ');
    setHudStatus(
      r.source === 'live' ? (state.turnHead || SOURCE_TEXT.live)
      : r.source === 'title' ? '按会话标题推断的模型（未验证）· 发一条消息后识别'
      : r.source === 'fingerprint' ? '指纹统计估计（非真名·未完成Arena校准）· 以服务端确认为准'
      : '已恢复本地记录的模型（非重新验证）');
  } else {
    setModelDisplay('', { known: false });
    q('ak-model-sub').textContent = '此对话尚无本地记录';
    setHudStatus('此对话尚无本地记录 · 发一条消息后识别');
  }
  renderUsage();
}
function setHudStatus(text) {
  state.hud.status = String(text || '');
  q('ak-hud-status').textContent = state.hud.status;
}
/* Status-pill payload (embedded only, reference HudFormat.pill): ring = quota %,
 * label = flash → running task → model (warn tone when routed) → 识别中… →
 * 新对话 → nothing; the ring's orbit spins while a task runs. */
function renderPill() {
  if (!EMBED || typeof EMBED.setPill !== 'function') return;
  const v = state.pulse.view();
  const { text, tone } = pillLabel({
    flash: state.hud.flash,
    task: state.hud.task,
    model: state.hud.model,
    strength: state.hud.strength,
    routed: state.hud.routed,
    pending: state.hud.pending,
    estimate: state.hud.source === 'fingerprint',
    newChat: !state.nav.sessionId && /^\/(agent\/?)?$/.test(state.nav.path || ''), // home / agent page without a conversation
  });
  EMBED.setPill({
    percent: v.percent,
    label: text,
    tone,
    busy: !!state.hud.task && state.hud.task.kind !== 'recovery',
    mode: BALL_CENTERS.includes(state.prefs.ballCenter) ? state.prefs.ballCenter : 'percent-model',
  });
}
/* Transient pill message ("已发送 ✓" 2.5 s, "探针结束 · 命中 n" 4 s). */
function flashPill(text, ms = 2500) {
  state.hud.flash = String(text || '');
  renderPill();
  clearTimeout(state.hud.flashTimer);
  state.hud.flashTimer = setTimeout(() => { state.hud.flash = ''; renderPill(); }, ms);
}
/* The running task shown on the pill: {kind:'probe', round, max, hits, draw} |
 * {kind:'cleanup', archived} | {kind:'recovery'} | null. */
function setTask(task) {
  state.hud.task = task || null;
  if (task && task.kind !== 'recovery') { if (!state.taskStartedAt) state.taskStartedAt = Date.now(); }
  else state.taskStartedAt = 0;
  renderPill();
}

// ── page event routing (arena page → dock) ──────────────────────────────
const pageHandlers = new Map();
const onPage = (name, fn) => pageHandlers.set(name, fn);

// Run a page action (lib/page-actions.js) in the arena page: evaluated via the
// Rust arena_command on desktop, called directly when embedded on Android.
let pageActions = null;
function page(name, ...args) {
  if (!pageActions) return Promise.resolve();
  return pageActions(name, ...args).catch((e) => setStatus('命令失败: ' + (e && e.message || e)));
}
// dock → page bus (bridge.js dispatch).
function dispatchToPage(name, payload) {
  return page('dispatch', name, payload);
}
// Open a conversation: in-page SPA switch when embedded (keeps the dock state
// alive), full navigation of the arena webview on desktop.
function openConversation(sid) {
  const url = 'https://arena.ai/agent/' + sid;
  if (EMBED && state.rpc) return state.rpc.call('openConversation', { sessionId: sid }, { timeout: 12_000 }).catch(() => page('open', url));
  return page('open', url);
}

// ── prefs ───────────────────────────────────────────────────────────────
async function loadPrefs() {
  const saved = await state.store.get('prefs').catch(() => null);
  state.prefs = { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' ? saved : {}) };
}
async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  await state.store.set('prefs', state.prefs).catch((e) => setStatus('保存设置失败: ' + e));
}

// ── module: server-side model (trace pipeline) ──────────────────────────
function onTrace(p) {
  if (!p || typeof p !== 'object' || typeof p.sessionId !== 'string') return;
  if (state.prefs.capture === false) return; // 设置 → 截获会话流 off
  const sub = q('ak-model-sub');
  const tracker = state.tracker;
  // Turns are keyed by the TOKEN (Rust tokenKey), not the run id: arena may
  // deliver the same run scope for every turn of a conversation, and keying by
  // run id collapsed all of them into turn 1 (reference TurnIntake).
  const runKey = p.tokenKey || p.runId || '';
  if (p.stage === 'token') {
    state.current = { sessionId: p.sessionId, runId: p.runId || null };
    // A new run supersedes any picked run of the live conversation (extension: selectedRunId reset).
    if (!state.view.sessionId || state.view.sessionId === p.sessionId) state.view = { sessionId: null, runId: null };
    // A fresh run token = a new turn; a different session = conversation switch.
    const { turn, switched, repeat } = tracker.onToken(p.sessionId, runKey);
    if (switched) { sessionRecord(p.sessionId).historical = false; state.turnHead = ''; }
    // A conversation page may carry a different id than its stream (/c/{evalId}):
    // map the page id to the stream id so the UI resolves by either. Only a NEW
    // turn may claim the page — a replayed run is more likely a late stream of
    // the chat the user just left.
    if (!repeat && state.nav.sessionId) aliasSession(state.nav.sessionId, p.sessionId);
    // Sent from a page without a conversation id (/agent, /): the URL catches
    // up a moment later (/agent/{id}) and that id may differ from the stream's
    // — the nav handler maps it onto this stream instead of wiping the model.
    if (!repeat && !state.nav.sessionId) state.freshChat = { streamId: p.sessionId, at: Date.now() };
    if (!repeat) setModelDisplay('识别中…', { known: false, pending: true });
    sub.textContent = `第 ${turn} 轮 · run ` + String(p.runId || '').slice(0, 14);
    setHudStatus(`第 ${turn} 轮 · 已截获令牌，正在识别模型…`);
    renderTurns();
  } else if (p.stage === 'poll') {
    const turn = tracker.turnOf(runKey);
    if (turn) tracker.setStatus(turn, `读取中 ${p.attempt || ''}/${p.max || ''}`.trim());
    renderTurns();
  } else if (p.stage === 'error') {
    const turn = tracker.turnOf(runKey);
    if (turn) { tracker.setStatus(turn, p.fatal ? '失败' : '未识别'); if (p.fatal) tracker.mark(turn, 'trace-error', '读取失败'); }
    if (state.hud.pending) showLastKnownModel(); // don't leave 识别中… hanging
    if (p.fatal) q('ak-model-sub').textContent = p.status || '错误';
    renderTurns();
  } else if (p.stage === 'done') {
    const turn = tracker.turnOf(runKey);
    if (turn) { const e = tracker.turns.find((x) => x.turn === turn); if (e && e.model) tracker.setStatus(turn, '完成'); }
    if (state.hud.pending) showLastKnownModel();
    renderTurns();
  } else if (p.stage === 'model') {
    const rec = sessionRecord(p.sessionId);
    const models = (p.models || []).filter((m) => m && typeof m.model === 'string' && m.model.trim())
      .map((m) => ({ model: m.model.slice(0, 200), provider: String(m.provider || '').slice(0, 100) }));
    if (models.length) rec.models = models;
    const usage = usageFromReport(p);
    if (usage) rec.runs = mergeUsage(rec.runs, usage);
    rec.historical = false;
    state.current = { sessionId: p.sessionId, runId: p.runId || null };
    if (models.length) saveHistory(p.sessionId, p.runId, models, usage, runKey);
    const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))];
    const run = rec.runs.find((r) => r.runId === p.runId);
    // Per-turn model resolution (routed = differs from this conversation's first model).
    let turn = tracker.turnOf(runKey);
    if (!turn && models.length) turn = tracker.onToken(p.sessionId, runKey).turn; // model without a seen token stage
    let head = '';
    if (turn && models.length) {
      head = tracker.record(turn, models[0].model, models.map((m) => m.model), p.strength || '');
      deliverFingerprintTrace(p, models, turn, runKey);
      if (!p.complete) tracker.setStatus(turn, completion(run?.spans || []));
      else tracker.setStatus(turn, run?.spans?.length ? completion(run.spans) : '已识别');
    }
    // A trace read before its model labels arrived must not wipe what is
    // already known for this conversation.
    if (models.length) setModelDisplay(models.map((m) => m.model).join(' / '), { routed: !!tracker.routed, known: true, strength: p.strength || '' });
    else if (p.complete || !state.hud.pending) showLastKnownModel();
    sub.textContent = ['run ' + String(p.runId || '').slice(0, 14), providers.join(', '), completion(run?.spans || [])].filter(Boolean).join(' · ');
    if (head) state.turnHead = head.split('\n')[0];
    setHudStatus(head ? head.split('\n')[0] : (turn ? `第 ${turn} 轮 · trace 未包含模型标签；不猜测模型` : 'trace 未包含模型标签；不猜测模型'));
    renderTurns();
    renderUsage();
  }
  if (p.stage === 'error') {
    const turn = tracker.turnOf(runKey);
    setHudStatus((turn ? `第 ${turn} 轮 · ` : '') + (p.status || '读取失败'));
  }
  if (p.status) setStatus(p.status);
}

// ── module: turns (per-turn model timeline) ─────────────────────────────
const TURN_EMPTY = '<div class="ak-empty">暂无轮次记录：发一条消息后，每一轮实际应答的模型会记录在这里</div>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
const ICON_ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
/* Reference item_turn rows, newest first: R-number · model (+ strength) ·
 * 已切换 tag when the model differs from the first turn's · ✓ / spinner / ⚠. */
function renderTurns() {
  const t = state.tracker;
  const list = q('ak-turn-list');
  if (!t.turns.length) { list.innerHTML = TURN_EMPTY; q('ak-turn-head').textContent = ''; state.turnHead = ''; return; }
  const restored = t.turns.every((e) => e.status === '历史');
  q('ak-turn-head').textContent = turnHeadline({ count: t.turnCount, firstModel: t.firstModel, routed: !!t.routed, restored });
  const failed = (e) => /失败|错误|过期|未识别/.test(e.status || '') || e.marks.some((m) => /error|fail/.test(m.kind));
  list.innerHTML = t.turns.slice(-30).reverse().map((e) => {
    const marks = e.marks.map((m) => `<span class="ak-badge ${/error|fail|empty|trunc/.test(m.kind) ? 'ak-badge-err' : 'ak-badge-warn'}">${esc(m.label)}</span>`).join('');
    const routed = e.routed ? '<span class="ak-badge ak-badge-warn">已切换</span>' : '';
    const model = e.models.join(' / ') || e.model;
    const icon = model ? `<span class="ak-turn-ok" title="已识别">${ICON_CHECK}</span>` : failed(e) ? `<span class="ak-turn-fail" title="${esc(e.status || '')}">${ICON_ALERT}</span>` : '<span class="ak-turn-spin" title="识别中"></span>';
    const status = model ? (e.status && !/^已识别|^完成|^历史/.test(e.status) ? e.status : '') : (e.status || '识别中');
    return `<div class="ak-turn"><span class="ak-turn-n">R${esc(e.turn)}</span><span class="ak-turn-m${e.routed ? ' ak-routed' : ''}">${esc(model || (failed(e) ? (e.status || '未识别') : '识别中…'))}${e.strength ? ' <span class="ak-sub">· ' + esc(e.strength) + '</span>' : ''}${routed}${marks}</span>${status && model ? `<span class="ak-turn-s">${esc(status)}</span>` : ''}${icon}</div>`;
  }).join('');
}

/* Rebuild the tracker from a stored record so numbering continues when the
 * user comes back to an old conversation (turns seen by ArenaKit only). */
function rebuildTrackerFromRecord(sessionId, record) {
  const t = state.tracker;
  t.reset(sessionId);
  state.turnHead = '';
  for (const r of recordTurns(record)) {
    const { turn } = t.onToken(sessionId, r.runId);
    if (r.models.length) t.record(turn, r.models[0], r.models);
    t.setStatus(turn, '历史');
  }
  t.clearRouted();
  renderTurns();
}

// ── module: Token / trace cost ──────────────────────────────────────────
/* What the usage module looks at: the live conversation, or a saved session
 * picked from the history list (state.view.sessionId). In-memory runs win for
 * sessions seen this session; otherwise the stored record. */
function usageSource() {
  const sessionId = state.view.sessionId || state.current.sessionId || null;
  const rec = sessionId ? state.sessions.get(sessionId) : null;
  const record = sessionId ? state.historyIndex.get(sessionId) : null;
  const other = !!state.view.sessionId && state.view.sessionId !== state.current.sessionId;
  return {
    sessionId, other, rec, record,
    title: record?.title || rec?.title || '',
    runs: rec ? rec.runs : (record?.runs || []),
    observations: record?.observations || [],
  };
}
const fmtWhen = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : ''; };
function renderUsage() {
  const src = usageSource();
  const list = runsFor(src);
  const live = !src.other && !state.view.runId && !!state.current.runId && !(src.rec && src.rec.historical);
  const selected = state.view.runId || (src.other ? '' : (state.current.runId || ''));
  const v = buildRunView({ runs: src.runs, observations: src.observations, runId: selected, live });

  // context line + run picker (extension popup "查看运行")
  q('ak-usage-ctx').textContent = src.other ? `查看已保存会话：${src.title || src.sessionId}` : '当前会话';
  root.querySelector('[data-action="usage-back"]').hidden = !src.other;
  const pick = q('ak-usage-pick');
  const options = [`<option value="">${live ? '本次捕获' : '最近保存的运行'}</option>`]
    .concat(list.map((r) => `<option value="${esc(r.runId)}">${esc(runLabel(r, src.observations))}</option>`));
  pick.innerHTML = options.join('');
  pick.value = state.view.runId && list.some((r) => r.runId === state.view.runId) ? state.view.runId : '';
  q('ak-usage-pick-field').hidden = !list.length;
  q('ak-usage-meta').textContent = v.runId
    ? [v.completion, `Token 覆盖 ${v.tokenCoverage}`, `费用覆盖 ${v.costCoverage}`, v.source, v.checkedAt ? '记录时间 ' + fmtWhen(v.checkedAt) : ''].filter(Boolean).join(' · ')
    : '';

  const run = v.runId ? list.find((r) => r.runId === v.runId) : null;
  q('ak-usage-run').textContent = formatUsage(run ? summarizeUsage([run]) : null);
  const st = src.runs.length ? summarizeUsage(src.runs) : null;
  q('ak-usage-session').textContent = st && st.spanCount ? formatUsage(st) + ` · ${st.runCount} 轮` : '未提供';
  const tt = grandTotals([...state.historyIndex.values()], state.historyCarry);
  q('ak-usage-total').textContent = tt.spanCount ? formatUsage(tt) + ` · ${tt.runCount} 轮 / ${tt.sessions} 会话` : (tt.sessions ? `${tt.sessions} 会话 · 无用量标签` : '未提供');

  const calls = v.calls;
  q('ak-usage-calls').innerHTML = calls.map((c, i) => {
    const flags = [c.partial === true ? '<span class="ak-flag">进行中</span>' : '', c.error === true ? '<span class="ak-err">报错</span>' : '', c.cancelled === true ? '<span class="ak-flag">已取消</span>' : ''].filter(Boolean).join(' ');
    const span = c.spanId ? `<span class="ak-span">span ${esc(String(c.spanId).slice(0, 10))}<button class="ak-link ak-copy" data-copy="${esc(c.spanId)}" title="复制 spanId">复制</button></span>` : '';
    return `<div class="ak-call"><span>${String(i + 1).padStart(2, '0')} ${esc(c.model || '未知模型')}${c.provider ? ' <span class="ak-sub">' + esc(c.provider) + '</span>' : ''} ${span}</span><span>${esc(formatTokens(c.tokens, c.tokensApproximate))} · ${esc(formatMoney(c.costUsd))} ${flags}</span></div>`;
  }).join('') + (calls.length ? `<div class="ak-sub">共 ${calls.length} 次模型调用 · 仅统计 trace 标签，不推算价格</div>` : '');

  // 证据来源 fold: raw label values + their trace paths and observation times.
  const rows = evidenceRows(v);
  q('ak-evidence-count').textContent = calls.length ? `${v.evidenceCount}/${calls.length} 次保留原始标签` : '未保存原始标签';
  q('ak-evidence').innerHTML = rows.map((r) => r.legacy
    ? `<div class="ak-ev"><div class="ak-ev-title">调用 ${String(r.index).padStart(2, '0')} · ${esc(r.model)}</div><div class="ak-legacy">旧记录未保存原始标签；不会补造证据。</div></div>`
    : `<div class="ak-ev"><div class="ak-ev-title">调用 ${String(r.index).padStart(2, '0')} · ${esc(r.model)}</div><div class="ak-path">spanId: ${esc(r.spanId)}</div>`
      + r.fields.map((f) => `<div>${esc(f.label)}：<span class="ak-mono">${esc(f.value)}</span>${f.path ? `<div class="ak-path">${esc(f.path)}${f.observedAt ? ' · 观测于 ' + esc(f.observedAt) : ''}</div>` : ''}</div>`).join('')
      + (r.flags ? `<div class="ak-path">状态原始字段：${esc(r.flags)}</div>` : '') + '</div>'
  ).join('') || '<div class="ak-sub">尚无可展示的证据。</div>';
}
function viewSavedSession(sessionId) {
  state.view = { sessionId, runId: null };
  renderUsage();
  const mod = q('ak-usage-pick').closest('.ak-mod');
  if (mod) mod.dataset.open = 'true';
  setStatus('正在查看已保存会话的记录（本地记录，非重新验证）');
}
function wireUsageView() {
  q('ak-usage-pick').addEventListener('change', (e) => { state.view.runId = e.target.value || null; renderUsage(); });
  q('ak-usage-calls').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); setStatus('spanId 已复制'); } catch { setStatus('复制失败：' + b.dataset.copy); }
  });
}
async function exportCurrentEvidence() {
  // Exports whatever the usage module is looking at (live conversation or a
  // saved session picked from the history list).
  const src = usageSource();
  if (!src.sessionId || !src.runs.length) { setStatus('当前会话还没有可导出的记录'); return; }
  const text = JSON.stringify(exportEvidence({ sessionId: src.sessionId, title: src.title || (src.other ? '' : state.nav.title), runs: src.runs }), null, 2);
  const box = q('ak-export');
  box.value = text;
  box.hidden = false;
  try { await navigator.clipboard.writeText(text); setStatus('证据 JSON 已复制到剪贴板'); } catch { setStatus('证据 JSON 已生成（请手动复制）'); }
}

// ── module: conversation history (local store) ──────────────────────────
async function saveHistory(sessionId, runId, models, usage, runKey = runId) {
  if (!state.history) return;
  const title = conversationFor(state.nav.sessionId) === sessionId ? state.nav.title : undefined;
  try {
    const turn = state.tracker.sessionId === sessionId ? state.tracker.turnOf(runKey) : undefined;
    const pageId = state.nav.sessionId && state.nav.sessionId !== sessionId && conversationFor(state.nav.sessionId) === sessionId ? state.nav.sessionId : undefined;
    const record = await state.history.save({ sessionId, title, models, runId, checkedAt: usage?.checkedAt, usage, turn: turn ?? undefined, pageId });
    state.historyIndex.set(sessionId, record);
    renderHistory();
    renderUsage();
  } catch (e) {
    setStatus('已识别模型，但本地保存失败: ' + (e?.message || e));
  }
}
const HISTORY_RETRY_MS = [2000, 5000, 15000, 30000];
async function loadHistoryIndex(attempt = 0) {
  if (!state.history) return false;
  let ok = false;
  try {
    const list = await state.history.list();
    // keep records saved while the read was in flight
    const next = new Map(list.map((r) => [r.sessionId, r]));
    for (const [k, v] of state.historyIndex) if (!next.has(k)) next.set(k, v);
    state.historyIndex = next;
    state.historyCarry = await state.history.carry();
    ok = true;
  } catch (e) {
    setStatus('读取历史失败: ' + (e?.message || e) + (attempt < HISTORY_RETRY_MS.length ? '（稍后重试）' : ''));
    if (attempt < HISTORY_RETRY_MS.length) setTimeout(() => { loadHistoryIndex(attempt + 1); }, HISTORY_RETRY_MS[attempt]);
  }
  renderHistory();
  renderUsage();
  if (ok) refreshCurrentModel('history');
  return ok;
}
function historyRows() {
  return [...state.historyIndex.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}
const HISTORY_PAGE = 20; // extension popup pages 20 rows at a time
let historyLimit = HISTORY_PAGE;
function renderHistory() {
  const all = searchRecords(historyRows(), q('ak-history-q').value);
  const rows = all.slice(0, historyLimit);
  const fmtDate = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : ''; };
  q('ak-history-list').innerHTML = rows.map((r) => {
    const turns = recordTurns(r);
    const models = turns.length > 1
      ? turns.map((t) => `R${esc(t.turn ?? '?')} ${esc(t.models.join('/'))}`).join(' · ')
      : esc(recordModels(r).map((m) => m.model).join(' / '));
    const t = r.totals || {};
    const usage = t.spanCount ? `${formatTokens(t.tokens, t.tokensApproximate)} · ${formatMoney(t.costUsd)}` : '';
    const cur = r.sessionId === conversationFor(state.nav.sessionId) ? ' ak-current' : '';
    return `<div class="ak-item" data-sid="${esc(r.sessionId)}">
      <div class="ak-item-title${cur}">${esc(r.title || 'Arena 会话')}</div>
      <div class="ak-item-models">${models || '—'}</div>
      <div class="ak-sub">${esc(fmtDate(r.lastSeen))}${usage ? ' · ' + esc(usage) : ''}</div>
      <div class="ak-item-actions"><button class="ak-link" data-open="${esc(r.sessionId)}">打开</button><button class="ak-link" data-view="${esc(r.sessionId)}">查看运行</button><button class="ak-link ak-danger" data-del="${esc(r.sessionId)}">删除</button></div>
    </div>`;
  }).join('') || '<div class="ak-sub">暂无记录：识别到模型后自动保存（仅本机）</div>';
  const total = state.historyIndex.size;
  const more = q('ak-history-more');
  more.hidden = all.length <= rows.length;
  more.textContent = `加载更多（还有 ${Math.max(0, all.length - rows.length)} 个）`;
  const filtered = all.length !== total ? `匹配 ${all.length} 个会话` : `共 ${total} 个会话`;
  q('ak-history-sub').textContent = total ? `${filtered}${rows.length < all.length ? `，显示 ${rows.length}` : ''} · 仅保存会话→模型与用量标签，不包含未捕获的历史消耗` : '';
}
function wireHistory() {
  q('ak-history-q').addEventListener('input', () => { historyLimit = HISTORY_PAGE; renderHistory(); });
  q('ak-history-more').addEventListener('click', () => { historyLimit += HISTORY_PAGE; renderHistory(); });
  q('ak-history-list').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const view = e.target.closest('[data-view]');
    const del = e.target.closest('[data-del]');
    if (open) {
      openConversation(open.dataset.open);
    } else if (view) {
      viewSavedSession(view.dataset.view);
    } else if (del && state.history) {
      const sid = del.dataset.del;
      await state.history.remove(sid).catch((err) => setStatus('删除失败: ' + err));
      state.historyIndex.delete(sid);
      if (state.view.sessionId === sid) state.view = { sessionId: null, runId: null };
      renderHistory();
      renderUsage();
      setStatus('已删除该会话的本地记录（Arena 上的对话不受影响）');
    }
  });
}
async function exportAllHistory() {
  const rows = historyRows();
  if (!rows.length) { setStatus('没有可导出的历史'); return; }
  const text = JSON.stringify(exportHistory(rows), null, 2);
  const box = q('ak-export');
  box.value = text; box.hidden = false;
  try { await navigator.clipboard.writeText(text); setStatus(`已导出 ${rows.length} 个会话到剪贴板`); } catch { setStatus('导出 JSON 已生成（请手动复制）'); }
}
let clearArmed = 0;
async function clearHistory(btn) {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); btn.textContent = '再点一次确认清空'; setTimeout(() => { btn.textContent = '清空历史'; }, 4000); return; }
  clearArmed = 0; btn.textContent = '清空历史';
  if (state.history) await state.history.clear().catch((err) => setStatus('清空失败: ' + err));
  state.historyIndex.clear(); state.historyCarry = null;
  renderHistory(); renderUsage();
  setStatus('本地历史已清空');
}

/* Remove a conversation's local record everywhere the dock caches it. */
async function dropLocalRecord(sessionId) {
  if (!state.history || !state.historyIndex.has(sessionId)) return false;
  await state.history.remove(sessionId);
  state.historyIndex.delete(sessionId);
  if (state.view.sessionId === sessionId) state.view = { sessionId: null, runId: null };
  renderHistory();
  renderUsage();
  return true;
}

/* Extension HUD "归档聊天及删除记录": archive the OPEN conversation through
 * Arena's own ⋯ → Archive menu (never a delete), then drop its local record.
 * Two clicks within 4 s to confirm, like 清空历史. */
let archiveArmed = 0;
const ARCHIVE_LABEL = '归档当前对话并删除记录';
async function archiveCurrent(btn) {
  const sid = state.nav.sessionId;
  if (!sid) { setStatus('当前没有打开的对话'); return; }
  if (!state.rpc) { setStatus('无 Tauri 运行时'); return; }
  if (state.fingerprint.runner?.isRunning) { setStatus('指纹探测进行中，请先停止'); return; }
  if (Date.now() - archiveArmed > 4000) {
    archiveArmed = Date.now(); btn.textContent = '再点一次确认归档';
    setTimeout(() => { btn.textContent = ARCHIVE_LABEL; }, 4000);
    return;
  }
  archiveArmed = 0; btn.textContent = ARCHIVE_LABEL; btn.disabled = true;
  try {
    setStatus('正在归档当前对话…');
    const r = await state.rpc.call('archive', { sessionId: sid, requireCurrentUrl: true, manageSidebar: true });
    if (r && r.archived === false) throw new Error('未确认归档，本地记录保留');
    let msg = '对话已归档';
    try { msg += (await dropLocalRecord(sid)) ? '，本地记录已删除' : '（无本地记录）'; }
    catch (e) { msg += '，但本地记录删除失败：' + (e?.message || e); }
    setStatus(msg + ' · 归档不是永久删除，可在 Arena 归档中找回');
  } catch (e) {
    setStatus('归档失败：' + (e?.message || e));
  } finally {
    btn.disabled = false;
  }
}

// Populate the in-memory session view from a stored record (restore on switch).
function restoreFromHistory(sessionId) {
  const record = state.historyIndex.get(sessionId);
  if (!record) return false;
  const rec = sessionRecord(sessionId);
  rec.runs = record.runs || [];
  rec.models = recordModels(record);
  rec.title = record.title || '';
  rec.historical = true;
  return true;
}

// ── module: navigation (restore per-conversation display) ───────────────
onPage('probe-result', (r) => { if (state.rpc) state.rpc.deliver(r); });

// Page event sent by the ENI badge (injected/eni.js) — open the dock 更多
// tab so the user can edit the prompt.
onPage('openDock', (p) => {
  const tab = (p && typeof p === 'object' && p.tab) || 'more';
  showTab(tab);
});

onPage('nav', (n) => {
  if (!n || typeof n !== 'object') return;
  if (n.reason === 'init') applyPageFlags(); // fresh page load: injected scripts start with flags unset
  // fresh page load on the /agent composer (app open, account switch, login
  // landing) → Agent Mode + GitHub on (+ the probe project)
  if (n.reason === 'init' && !n.sessionId && n.agentPath) scheduleAgentDefaults();
  const switched = n.sessionId !== state.nav.sessionId;
  // The page got its conversation id after the first token of a chat sent
  // from /agent (see onTrace token stage): same conversation, keep it.
  const fresh = state.freshChat;
  if (switched && n.sessionId && fresh && !state.aliases.has(n.sessionId) && Date.now() - fresh.at < 5 * 60_000 && state.tracker.sessionId === fresh.streamId) {
    aliasSession(n.sessionId, fresh.streamId);
  }
  if (switched) state.freshChat = null;
  state.nav = { sessionId: n.sessionId || null, path: n.path || '/', title: n.title || '' };
  // Lookups go through the stream session the page id aliases to (/c/{evalId}).
  const sid = conversationFor(state.nav.sessionId);
  q('ak-session').textContent = state.nav.sessionId ? '会话 ' + state.nav.sessionId.slice(0, 8) + '…' : (n.agentPath ? '新对话' : n.path || '');
  if (sid && state.sessions.has(sid)) sessionRecord(sid).title = state.nav.title;
  if (switched) { renderHistory(); renderRenamePreview(); }
  if (switched && !sid) {
    // Fresh /agent composer: nothing identified yet for this conversation.
    // (Best-effort reset; the next token's session id is the authoritative one.)
    state.current = { sessionId: null, runId: null };
    state.tracker.reset();
    setModelDisplay('', { known: false });
    q('ak-model-sub').textContent = '发一条消息后自动识别';
    setHudStatus('等待会话流…');
    renderTurns();
    renderUsage();
  } else if (switched && sid === state.tracker.sessionId) {
    // Same conversation the tracker is already following (e.g. URL caught up
    // after the token) — keep the live turn state.
    state.current = { sessionId: sid, runId: state.current.runId };
  } else if (switched) {
    // Another conversation: whatever the local sources know about it (live
    // runs, the history record by stream id / page id / pageIds, runs, title).
    state.current = { sessionId: sid, runId: null };
    applyResolved(resolveCurrent(), { rebuild: true });
  } else if (!state.hud.model && !state.hud.pending) {
    // same conversation, header still empty (e.g. the page announced it before
    // the history was loaded, or the title just arrived) → look again
    refreshCurrentModel('nav');
  }
  renderPill(); // "新对话" / model label follows the page
});

// ── module: composer defaults (Agent Mode + GitHub connector) ───────────
// 0.4.8. Runs once per page load when the page lands on a fresh /agent
// composer: app start (the start URL is /agent) and after every account
// switch / login (both navigate to /agent). Never sends anything; failures
// only show up in the status line, e.g. GitHub not connected yet.
let agentDefaultsGen = 0;
function scheduleAgentDefaults(delayMs = 2500) {
  if (state.prefs.agentDefaults === false || !state.rpc) return;
  const gen = ++agentDefaultsGen;
  setTimeout(async () => {
    if (gen !== agentDefaultsGen) return;             // a newer page load took over
    if (state.nav.sessionId) return;                   // user already opened a chat
    const args = { github: true, repo: state.prefs.probeRepo || '', branch: state.prefs.probeBranch || '' };
    let r;
    try { r = await state.rpc.call('applyDefaults', args, { timeout: 45_000 }); }
    catch (e) { setStatus('默认模式设置失败：' + (e?.message || e)); return; }
    if (!r || r.skipped) return;
    const parts = [r.agent ? 'Agent 模式' : '', r.github ? 'GitHub 已开' : '', r.project ? '项目 ' + r.project : ''].filter(Boolean);
    const line = (parts.length ? '已设默认：' + parts.join(' · ') : '默认模式未生效') + (r.errors?.length ? '（' + r.errors.join('；') + '）' : '');
    setStatus(line.slice(0, 200));
  }, delayMs);
}

// ── module: model fingerprint (page-side statistical estimate) ──────────
// A STATISTICAL guess over three families (opus / fable / gpt6) from the
// reduced features the page emits for FIXED probe prompts — never a confirmed
// model name, never overwrites a server-confirmed model, never renames a
// conversation. Thresholds are UNCALIBRATED. The page→dock feature channel +
// de-identified diagnostic view are read-only; the active probe runner
// (createFingerprintRunner) + the classify() call send FIXED allowlisted probes
// only after an explicit user click + a confirmed max-message budget.
const FP_PROTO_LABEL = {
  'modeltrace-long-integers-v1': '长整数序列直方图',
  'fpverify-battery-v1': '分类问答组（五问）',
};
const FP_ERR_LABEL = { 0: '正常', 1: '无整数', 2: '整数过少', 3: '空回复', 4: '无法绑定到当前探针' };
const FP_LOG_MAX = 60; // keep the last N fingerprint log lines
function fingerprintProtocolId() {
  const v = q('ak-fingerprint-protocol') && q('ak-fingerprint-protocol').value;
  return (v === 'fpverify-battery-v1' || v === 'modeltrace-long-integers-v1') ? v : 'modeltrace-long-integers-v1';
}
function fingerprintBudget() {
  const n = parseInt(q('ak-fingerprint-budget') && q('ak-fingerprint-budget').value, 10);
  return Math.min(24, Math.max(1, Number.isFinite(n) ? n : 3));
}
function persistFingerprintPanel() {
  return savePrefs({ fingerprintProtocol: fingerprintProtocolId(), fingerprintBudget: fingerprintBudget() });
}
function setFingerprintRunningUi(running) {
  const start = root.querySelector('[data-action="fingerprint-start"]');
  const stop = root.querySelector('[data-action="fingerprint-stop"]');
  // Start is enabled only when: the feature toggle is on, a runner exists
  // (RPC channel is up), and no fingerprint run is already in flight. The hard
  // guards (page/mode, ≥2 candidates, budget confirm) are re-checked in the
  // runner's preflight; this is just the first gate so a disabled button never
  // auto-sends. When running, start is disabled and stop is enabled.
  const canStart = !running && !!state.fingerprint.runner && state.prefs.fingerprintOn !== false;
  if (start) start.disabled = !canStart;
  if (stop) stop.disabled = !running;
}
function fingerprintLog(line) {
  const el = q('ak-fingerprint-log');
  if (!el) return;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0'), ss = String(t.getSeconds()).padStart(2, '0');
  const lines = el.textContent ? el.textContent.split('\n') : [];
  lines.push(`${hh}:${mm}:${ss} ${line}`);
  el.textContent = lines.slice(-FP_LOG_MAX).join('\n');
  el.hidden = false;
  el.scrollTop = el.scrollHeight;
}
// A one-line, de-identified summary of a received feature frame. NEVER any
// reply text — only counts / a normalized pick / an error code.
function fingerprintSampleLine(s) {
  if (!s || typeof s !== 'object') return '收到无法解析的样本';
  const kind = s.kind === 'categorical' ? '分类' : '直方图';
  if (s.parseError) return `${kind} · 解析失败（${FP_ERR_LABEL[s.parseError] || '错误码 ' + s.parseError}）· 帧 ${s.frames || 0}`;
  if (s.kind === 'histogram') {
    const n = Number.isFinite(s.n) ? s.n : 0;
    return `直方图 · 有效整数 ${n} · 维度 ${s.dims || 0} · 帧 ${s.frames || 0}`;
  }
  if (s.kind === 'categorical') {
    const v = s.value == null ? '（无）' : String(s.value).slice(0, 32);
    return `分类 · 挑选 ${v} · 帧 ${s.frames || 0}`;
  }
  return `${kind} · 帧 ${s.frames || 0}`;
}
function renderFingerprintState() {
  const el = q('ak-fingerprint-state');
  if (!el) return;
  if (state.prefs.fingerprintOn === false) { el.textContent = '模型指纹已关闭（设置 → 模型指纹）。'; return; }
  const fp = state.fingerprint;
  const n = fp.samples.length;
  const r = fp.lastResult;
  if (r) {
    const score = Number.isFinite(r.confidence) ? Math.round(r.confidence * 100) : 0;
    const margin = Number.isFinite(r.margin) ? r.margin.toFixed(2) : '0.00';
    const model = r.estimatedModel || r.family || 'unknown';
    const status = r.status === 'attributed' ? '已归因' : r.status === 'unresolved' ? '未定' : '失败';
    el.textContent = `${status} · ${model} · 置信评分 ${score}% · 边距 ${margin} · ${n} 个样本（统计估计，非真名）`;
    return;
  }
  if (!n) { el.textContent = `未分析 · 协议 ${FP_PROTO_LABEL[fingerprintProtocolId()] || fingerprintProtocolId()} · 预算 ${fingerprintBudget()} 条 · 等待固定探针回答`; return; }
  el.textContent = `已收集 ${n} 个样本 · 协议 ${FP_PROTO_LABEL[fingerprintProtocolId()] || fingerprintProtocolId()} · 最近：${fingerprintSampleLine(fp.samples[n - 1])}`;
}
// The page emits a reduced feature for a fixed probe's reply. PR3: collect +
// show it (read-only); classification is PR4. Payload is counts / a normalized
// pick / an error code only — asserted again here, no text is ever read.
onPage('fingerprint-sample', (sample) => {
  if (state.prefs.fingerprintOn === false) return;
  if (!sample || typeof sample !== 'object') return;
  // Only numeric / short-id fields are kept — defensive mirror of the page-side
  // reduction and the sanitize layer; this guarantees no stray text is stored.
  const clean = {
    sessionId: sample.sessionId ? String(sample.sessionId).slice(0, 128) : null,
    probeId: sample.probeId ? String(sample.probeId).slice(0, 120) : null,
    protocolId: sample.protocolId ? String(sample.protocolId).slice(0, 120) : null,
    kind: sample.kind === 'categorical' ? 'categorical' : sample.kind === 'histogram' ? 'histogram' : null,
    frames: Number.isFinite(sample.frames) ? sample.frames : 0,
    ended: sample.ended ? String(sample.ended).slice(0, 24) : null,
    parseError: Number.isInteger(sample.parseError) ? sample.parseError : 0,
  };
  if (clean.kind === 'histogram') {
    clean.n = Number.isFinite(sample.n) ? sample.n : 0;
    clean.dims = Number.isFinite(sample.dims) ? sample.dims : 0;
    clean.counts = Array.isArray(sample.counts) ? sample.counts.slice(0, 512).map((x) => (Number.isFinite(x) ? x : 0)) : null;
  } else if (clean.kind === 'categorical') {
    // A single normalized token (bare integer or one short word), never free text.
    clean.value = sample.value == null ? null : String(sample.value).slice(0, 64);
  }
  if (state.fingerprint.sessionId && clean.sessionId && state.fingerprint.sessionId !== clean.sessionId) {
    // A new conversation → start a fresh collection.
    state.fingerprint.samples = [];
  }
  state.fingerprint.sessionId = clean.sessionId || state.fingerprint.sessionId;
  state.fingerprint.protocolId = clean.protocolId || state.fingerprint.protocolId;
  state.fingerprint.samples.push(clean);
  if (state.fingerprint.samples.length > 64) state.fingerprint.samples = state.fingerprint.samples.slice(-64);
  fingerprintLog(fingerprintSampleLine(clean));
  renderFingerprintState();
});
// A de-identified diagnostic for copy: protocol / counts summary / error codes
// only. Never any reply text, token, header, or candidate model names copied
// from a confirmed source.
function fingerprintDiagnostic() {
  const fp = state.fingerprint;
  const lines = [
    'ArenaKit 模型指纹诊断（脱敏）',
    `协议: ${fingerprintProtocolId()}`,
    `预算: ${fingerprintBudget()} 条`,
    `样本数: ${fp.samples.length}`,
    '说明: 统计估计 · 非真名 · 阈值未完成 Arena 校准 · 不覆盖服务端确认模型',
  ];
  fp.samples.forEach((s, i) => {
    lines.push(`#${i + 1} ${fingerprintSampleLine(s)}`);
  });
  if (fp.lastResult) {
    const r = fp.lastResult;
    lines.push(`结果: ${r.status} · 系列 ${r.family} · 置信 ${r.confidence} · 边距 ${r.margin} · bank ${r.referenceBankVersion || '—'}`);
  }
  return lines.join('\n');
}
async function copyFingerprintDiagnostic() {
  const text = fingerprintDiagnostic();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard');
    setStatus('已复制脱敏诊断');
  } catch {
    // Fall back to logging it so the user can select it manually.
    fingerprintLog('复制失败，诊断已输出到日志：');
    fingerprintLog(text);
    setStatus('复制失败，诊断已输出到指纹日志');
  }
}
function clearFingerprint() {
  state.fingerprint.samples = [];
  state.fingerprint.lastResult = null;
  state.fingerprint.sessionId = null;
  const log = q('ak-fingerprint-log');
  if (log) { log.textContent = ''; log.hidden = true; }
  renderFingerprintState();
  setStatus('已清除本次指纹结果');
}
function wireFingerprint() {
  const proto = q('ak-fingerprint-protocol');
  const budget = q('ak-fingerprint-budget');
  const saved = state.prefs.fingerprintProtocol;
  if (proto) proto.value = (saved === 'fpverify-battery-v1' || saved === 'modeltrace-long-integers-v1') ? saved : 'modeltrace-long-integers-v1';
  if (budget) budget.value = String(Math.min(24, Math.max(1, parseInt(state.prefs.fingerprintBudget, 10) || 3)));
  if (proto) proto.addEventListener('change', () => { persistFingerprintPanel(); renderFingerprintState(); });
  if (budget) budget.addEventListener('change', () => { persistFingerprintPanel(); renderFingerprintState(); });
  // Opt-in rename preview from the fingerprint estimate. A server-confirmed true
  // name always wins; this only previews when the estimate's confidence clears the
  // threshold below.
  const autoRename = q('ak-fingerprint-autorename');
  if (autoRename) {
    autoRename.checked = !!state.prefs.fingerprintAutoRename;
    autoRename.addEventListener('change', () => {
      savePrefs({ fingerprintAutoRename: autoRename.checked });
      renderRenamePreview();
      setStatus(autoRename.checked
        ? `已开启：指纹置信度 ≥ ${Number(state.prefs.fingerprintRenameThreshold) || 0.85} 时按估计重命名当前会话（服务端真名优先）`
        : '已关闭指纹估计重命名');
    });
  }
  // Confidence threshold for the opt-in rename (0..1, lazy default 0.85).
  const threshold = q('ak-fingerprint-threshold');
  if (threshold) {
    const clamp = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.85));
    const stored = Number(state.prefs.fingerprintRenameThreshold);
    threshold.value = String(Number.isFinite(stored) ? clamp(stored) : 0.85);
    const commit = () => {
      const v = clamp(parseFloat(threshold.value));
      threshold.value = String(v);
      savePrefs({ fingerprintRenameThreshold: v });
      renderRenamePreview();
    };
    threshold.addEventListener('change', commit);
  }
  setFingerprintRunningUi(false);
  renderFingerprintState();
}

// A sync page snapshot the runner uses to detect a page / mode change mid-run.
// state.nav is kept current by onPage('nav'); the dock webview is always on the
// arena origin, so the hard signal is being on an Agent surface. (The runner
// also relies on the page-side send guard, which re-checks origin + agent mode
// and the human draft before every send.)
//
// agentPath must be TRUE both for the fresh /agent composer AND for an already
// open conversation (/agent/{id} or /c/{id}): a user starts a fingerprint run
// from whatever chat is on screen, and the runner calls newChat FIRST (which
// navigates to the fresh /agent composer) before it ever sends. If we only
// accepted the bare /agent composer here, pageChanged() would fire on the very
// first loop iteration — BEFORE newChat runs — and abort with "发送 0 条",
// which is exactly the 0-send bug. The page-side send guard still enforces the
// fresh /agent composer at send time, so widening this snapshot is safe.
function fingerprintPageState() {
  const path = String(state.nav.path || '').replace(/\/+$/, '');
  const onAgentSurface = path === '' || path === '/agent'
    || path.startsWith('/agent/') || path.startsWith('/c/');
  return { onArena: true, agentPath: onAgentSurface, session: state.nav.sessionId || null };
}
// Probe ids per protocol — must mirror injected/probe.js FINGERPRINT_PROMPTS
// (the page-side allowlist). The runner only ever passes an id; the prompt text
// lives on the page so a remote config can never swap the probe body.
const FP_PROBE_IDS = {
  'modeltrace-long-integers-v1': ['seq-1-355'],
  'fpverify-battery-v1': ['random_1_100', 'random_color', 'animal', 'city', 'coin'],
};
// Wait for the page reducer to emit the structured feature for a specific
// (sessionId, probeId). onPage('fingerprint-sample') pushes clean features into
// state.fingerprint.samples; poll it for a match and consume it so the next
// probe can't re-read a stale sample. Resolves null on timeout.
function takeFingerprintFeature(sessionId, probeId, { timeoutMs = FP_FEATURE_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const seen = new Set();
    const tick = () => {
      const samples = state.fingerprint.samples || [];
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (!s || seen.has(s)) continue;
        if (s.sessionId === sessionId && (!s.probeId || s.probeId === probeId)) {
          seen.add(s);
          const feature = s.kind === 'categorical'
            ? { questionId: probeId, value: s.value ?? null, parseError: s.parseError || 0, frames: s.frames || 0 }
            : { counts: Array.isArray(s.counts) ? s.counts : null, n: s.n || 0, dims: s.dims || 0, parseError: s.parseError || 0, frames: s.frames || 0 };
          resolve(feature);
          return;
        }
      }
      if (Date.now() - started >= timeoutMs) { resolve(null); return; }
      setTimeout(tick, FP_FEATURE_POLL_MS);
    };
    tick();
  });
}
// ── labelled fingerprint sample library ---------------------------------
const FP_LIBRARY_KEY = 'fingerprint-sample-library-v1';
const FP_LIBRARY_MAX = 5000;
function eligibleFingerprintModel(name) {
  const s = String(name || '').toLowerCase();
  let m = s.match(/(?:^|[-_])gpt[-_]?([0-9]+)(?:\D|$)/); if (m && Number(m[1]) >= 6) return true;
  m = s.match(/opus[-_]?([0-9]+)(?:\D|$)/); if (m && Number(m[1]) >= 5) return true;
  m = s.match(/fable[-_]?([0-9]+)(?:\D|$)/); return !!(m && Number(m[1]) >= 5);
}
function shortHash(value) {
  let h = 2166136261;
  for (const c of String(value || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function renderFingerprintLibrary() {
  const el = q('ak-fingerprint-library-count');
  if (!el) return;
  const counts = new Map();
  for (const s of state.fingerprint.library) counts.set(s.label.model, (counts.get(s.label.model) || 0) + 1);
  el.textContent = `${state.fingerprint.library.length} 条` + (counts.size ? ` · ${counts.size} 个模型` : '');
}
async function loadFingerprintLibrary() {
  const v = await state.store.get(FP_LIBRARY_KEY).catch(() => []);
  state.fingerprint.library = Array.isArray(v) ? v.slice(-FP_LIBRARY_MAX) : [];
  renderFingerprintLibrary();
}
async function saveFingerprintSample(sample) {
  if (state.fingerprint.library.some((x) => x.sampleId === sample.sampleId)) return false;
  state.fingerprint.library.push(sample);
  if (state.fingerprint.library.length > FP_LIBRARY_MAX) state.fingerprint.library.splice(0, state.fingerprint.library.length - FP_LIBRARY_MAX);
  await state.store.set(FP_LIBRARY_KEY, state.fingerprint.library);
  renderFingerprintLibrary();
  return true;
}
function waitFingerprintTrace(sessionId, startedAt, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const waiter = { sessionId, startedAt, resolve, timer: 0 };
    waiter.timer = setTimeout(() => {
      state.fingerprint.traceWaiters = state.fingerprint.traceWaiters.filter((x) => x !== waiter);
      resolve(null);
    }, timeoutMs);
    state.fingerprint.traceWaiters.push(waiter);
  });
}
function deliverFingerprintTrace(p, models, turn, runKey) {
  const now = Date.now();
  for (const w of [...state.fingerprint.traceWaiters]) {
    if (w.sessionId !== p.sessionId || now < w.startedAt) continue;
    clearTimeout(w.timer);
    state.fingerprint.traceWaiters = state.fingerprint.traceWaiters.filter((x) => x !== w);
    w.resolve({ models, turn, runKey, runId: p.runId || '', provider: models[0]?.provider || '' });
  }
}
async function collectFingerprintSamples() {
  if (state.fingerprint.collecting) return;
  const streamSession = state.current.sessionId || conversationFor(state.nav.sessionId);
  if (!state.nav.sessionId || !streamSession) { setStatus('请先打开一个以前能逐轮识别模型的旧对话'); return; }
  if (state.prefs.capture === false || state.prefs.fingerprintOn === false) { setStatus('请先开启“截获会话流”和“模型指纹”'); return; }
  const protocolId = fingerprintProtocolId(), maxRounds = fingerprintBudget();
  const plan = FP_PROBE_IDS[protocolId] || [];
  if (!plan.length) return;
  const ok = await confirmDialog({ title: '自动采集已确认样本', message: `将在当前旧对话连续发送最多 ${maxRounds} 条固定探针。每轮等待 Trace 真名，只自动保存 GPT-6+、Opus 5+、Fable 5+ 的唯一模型结果。会消耗额度，确定继续？`, ok: '开始采集', cancel: '取消' });
  if (!ok) return;
  state.fingerprint.collecting = true; state.fingerprint.stopCollect = false;
  const startBtn = root.querySelector('[data-action="fingerprint-collect"]'), stopBtn = root.querySelector('[data-action="fingerprint-collect-stop"]');
  if (startBtn) startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
  let saved = 0;
  try {
    for (let i = 0; i < maxRounds && !state.fingerprint.stopCollect; i++) {
      const probeId = protocolId === 'fpverify-battery-v1' ? plan[i % plan.length] : plan[0];
      const startedAt = Date.now();
      fingerprintLog(`样本采集 ${i + 1}/${maxRounds} · ${probeId}`);
      await dispatchToPage('fingerprint-arm', { sessionId: streamSession, probeId, protocolId, kind: protocolId === 'fpverify-battery-v1' ? 'categorical' : 'histogram', questionId: protocolId === 'fpverify-battery-v1' ? probeId : null });
      const featureP = takeFingerprintFeature(streamSession, probeId, { timeoutMs: FP_FEATURE_WAIT_MS });
      const traceP = waitFingerprintTrace(streamSession, startedAt, FP_FEATURE_WAIT_MS);
      await state.rpc.call('sendFingerprintProbeCurrent', { protocolId, probeId });
      const [feature, trace] = await Promise.all([featureP, traceP]);
      await dispatchToPage('fingerprint-disarm', null);
      if (!feature || feature.parseError) { fingerprintLog('未入库：回复特征解析失败'); continue; }
      if (!trace || trace.models.length !== 1) { fingerprintLog('未入库：本轮没有唯一的服务端模型标签'); continue; }
      const model = trace.models[0].model;
      if (!eligibleFingerprintModel(model)) { fingerprintLog(`跳过 ${model}：不在 GPT-6+/Opus 5+/Fable 5+ 范围`); continue; }
      const iso = new Date().toISOString();
      const sidHash = shortHash(streamSession), runHash = shortHash(trace.runKey || trace.runId);
      const sampleId = `fps_${iso.replace(/[-:.]/g, '').replace('Z', 'Z')}_${sidHash}_t${String(trace.turn || 0).padStart(3, '0')}_${runHash}`;
      const sample = { schemaVersion: 1, sampleId, status: 'accepted', label: { model, family: /fable/i.test(model) ? 'fable' : /opus/i.test(model) ? 'opus' : 'gpt6', source: 'server-trace', provider: trace.models[0].provider || '', partial: false }, collection: { channel: 'arena', platform: EMBED ? 'android' : 'desktop', createdAt: iso, sessionHash: sidHash, turn: trace.turn || null, runKeyHash: runHash }, protocol: { id: protocolId, probeId, version: 1 }, feature: feature.counts ? { kind: 'histogram', dims: feature.dims, n: feature.n, counts: feature.counts } : { kind: 'categorical', questionId: probeId, value: feature.value }, quality: { valid: true, signal: feature.n >= 300 ? 'good' : feature.n >= 80 || feature.value ? 'usable' : 'low', labelConfirmed: true, ambiguousTrace: false } };
      if (await saveFingerprintSample(sample)) { saved++; fingerprintLog(`已自动入库：${model} · ${sample.quality.signal} · ${sampleId}`); }
      if (i + 1 < maxRounds) await new Promise((r) => setTimeout(r, 2500));
    }
  } catch (e) { fingerprintLog(`采集中断：${e?.message || e}`); }
  finally {
    state.fingerprint.stopCollect = false; state.fingerprint.collecting = false;
    try { await dispatchToPage('fingerprint-disarm', null); } catch {}
    if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
    setStatus(`样本采集结束，本次自动入库 ${saved} 条`);
  }
}
async function exportFingerprintLibrary() {
  if (!state.fingerprint.library.length) { setStatus('样本库为空'); return; }
  const text = state.fingerprint.library.map((x) => JSON.stringify(x)).join('\n');
  const box = q('ak-export'); box.value = text; box.hidden = false;
  try { await navigator.clipboard.writeText(text); setStatus(`已复制 ${state.fingerprint.library.length} 条 JSONL 样本`); } catch { setStatus('样本 JSONL 已生成，请手动复制'); }
}

// Build the active fingerprint runner. Every side effect is injected so the
// controller stays DOM/IPC-free and unit-testable. loadReference reads the
// BUNDLED banks (fingerprint-banks.js) — never the network — so the estimate
// works fully offline and no remote host can swap a reference distribution.
function createDockFingerprint() {
  return createFingerprintRunner({
    rpc: state.rpc,
    dispatchToPage,
    loadReference: async (protocolId) => fingerprintReference(protocolId),
    classify: fingerprintClassify,
    probeIdsForProtocol: (protocolId) => FP_PROBE_IDS[protocolId] || [],
    takeFeature: (sessionId, probeId, opts) => takeFingerprintFeature(sessionId, probeId, opts),
    // The trace pipeline already saw these models for the conversation; a verdict
    // is a real discrimination only when ≥2 are plausible (gate in preflight).
    candidateModelsForSession: (sid) => (state.sessions.get(conversationFor(sid))?.models || []).map((m) => m.model),
    // No other page-surface driver competes for the RPC channel anymore.
    otherRunActive: () => false,
    pageState: fingerprintPageState,
    protocolMeta: (protocolId) => {
      const meta = fingerprintProtocolMeta(protocolId) || {};
      return { kind: meta.kind, channel: meta.source?.channel, reasoningTier: meta.reasoningTier, language: meta.language, questions: meta.questions };
    },
    onProgress: fingerprintLog,
    onResult: (r) => { state.fingerprint.lastResult = r; renderFingerprintState(); },
    onFinished: (summary) => { fingerprintLog(summary); const el = q('ak-fingerprint-state'); if (el && summary) el.textContent = summary; },
    onRunState: (round, max, active) => setFingerprintRunningUi(active),
  });
}
// Explicit-click entry point: confirm the max-message budget (real messages that
// consume quota), then start the runner. The runner's preflight re-checks every
// hard gate (page/mode, ≥2 candidates, loadable bank, budget confirm).
async function startFingerprint() {
  if (!state.fingerprint.runner) { setStatus('指纹探测不可用（RPC 通道未就绪）'); return; }
  if (state.fingerprint.runner.isRunning) { setStatus('指纹探测已在运行'); return; }
  const protocolId = fingerprintProtocolId();
  const maxRounds = fingerprintBudget();
  // Rename is now opt-in: tell the user whether this run may rename, so the
  // confirm reflects what will actually happen (a server-confirmed true name
  // still always wins over the estimate).
  const willRename = !!state.prefs.fingerprintAutoRename;
  const renameNote = willRename
    ? `识别置信度达到阈值（${Number(state.prefs.fingerprintRenameThreshold) || 0.85}）时会按估计重命名当前会话`
    : '不会重命名会话';
  const ok = await confirmDialog({
    title: '开始模型指纹探测',
    message: `本次最多发送 ${maxRounds} 条固定探针消息（会消耗额度）。结果为统计估计（非真名），阈值未完成 Arena 校准，不会覆盖服务端确认的模型，${renameNote}。确定继续？`,
    ok: '发送探针',
    cancel: '取消',
  });
  if (!ok) { setStatus('已取消指纹探测'); return; }
  await state.fingerprint.runner.start({
    protocolId,
    sessionId: state.nav.sessionId || null,
    maxRounds,
    budgetConfirmed: true,
  });
}

// ── module: quota gauge (pulse %) ───────────────────────────────────────
// injected/pulse.js polls /api/me/pulse inside the arena page (cookies stay
// there) and posts `pulse` events; the dock anchors the reset countdown
// (PulseTiming) and re-renders every second.
function renderPulse() {
  const v = state.pulse.view();
  const fill = q('ak-bar-fill');
  fill.style.width = (v.percent ?? 0) + '%';
  fill.dataset.band = v.band;
  // the bar's own label: remaining quota WITH the % sign (the pill shows the bare number)
  const barPct = q('ak-bar-pct');
  if (barPct) {
    barPct.textContent = v.percent === null ? '–' : Math.round(v.percent) + '%';
    barPct.dataset.band = v.percent === null ? 'unknown' : v.band;
  }
  // Header right column: only the reset hint stays (the old #ak-hud-percent
  // "–" placeholder was removed — quota is shown on the floating pill instead).
  const reset = q('ak-hud-pulse');
  reset.textContent = v.pending
    ? (v.percent === null ? '额度刷新中…' : [v.reset || '', '刷新中…'].filter(Boolean).join(' · '))
    : v.percent === null ? (v.error ? '额度：' + v.error : '额度读取中…') : [v.reset || '', v.error].filter(Boolean).join(' · ') || '剩余额度';
  reset.classList.toggle('ak-warn', !!v.error && !v.pending);
  renderPill();
}
onPage('pulse', (ev) => { state.pulse.ingest(ev); renderPulse(); });
/* Manual 刷新额度: immediate feedback, then the page answers (pending / value /
 * the reason it cannot fetch yet). No answer within 20 s → say so instead of
 * leaving the button looking dead. */
function refreshPulseNow() {
  const at = Date.now();
  state.pulse.ingest({ pending: true, at });
  renderPulse();
  setStatus('正在刷新额度…');
  Promise.resolve().then(() => dispatchToPage('pulse-refresh', null)).catch((e) => {
    state.pulse.ingest({ ok: false, transient: true, error: '无法联系页面：' + (e?.message || e) });
    renderPulse();
  });
  setTimeout(() => {
    const v = state.pulse.view();
    if (v.pending && v.pendingSince <= at + 1000) {
      state.pulse.ingest({ ok: false, transient: true, error: '刷新无响应（页面可能还在加载），稍后自动重试' });
      renderPulse();
    }
  }, 20_000);
}
setInterval(renderPulse, 1000);

// ── module: reply monitor (stream anomaly badges) ───────────────────────
function renderMonitor() {
  const m = state.monitor;
  if (!m) return;
  const entries = m.entries.slice().reverse();
  const head = q('ak-monitor-head');
  const last = m.last;
  if (state.prefs.monitorOn === false) { head.textContent = '回复监控已关闭（设置 → 回复监控）。'; head.classList.remove('ak-warn'); q('ak-monitor-list').innerHTML = ''; return; }
  if (!last) { head.textContent = '监听回复流：空回复 / 报错 / 中断 / 停滞会自动标记到对应轮次。'; q('ak-monitor-list').innerHTML = ''; return; }
  head.textContent = (last.turn ? `第 ${last.turn} 轮 · ` : '') + last.line;
  head.classList.toggle('ak-warn', last.anomalies.length > 0);
  q('ak-monitor-list').innerHTML = entries.map((e) => {
    const badges = e.anomalies.map((a) => `<span class="ak-badge ak-badge-err">${esc(a.label.split('：')[0])}</span>`).join('');
    const when = new Date(e.at);
    const hm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    return `<div class="ak-item"><span class="ak-item-title">${esc(hm)} · ${e.turn ? 'R' + esc(e.turn) : '会话 ' + esc(e.sessionId.slice(0, 8))}${badges}</span><span class="ak-item-models ak-sub">${esc(e.line)}</span></div>`;
  }).join('');
}
onPage('reply-monitor', (summary) => {
  if (!state.monitor || state.prefs.monitorOn === false) return;
  const entry = state.monitor.ingest(summary);
  if (!entry) return;
  renderMonitor();
  renderTurns();
  if (entry.anomalies.length) setStatus(`回复监控：${entry.turn ? '第 ' + entry.turn + ' 轮 ' : ''}${entry.anomalies.map((a) => a.label).join('、')}`);
  // Embedded: blink the ball rim red for a while (reference alert ring).
  if (EMBED && typeof EMBED.alert === 'function') {
    EMBED.alert(entry.anomalies.length > 0);
    clearTimeout(state.hud.alertTimer);
    if (entry.anomalies.length) state.hud.alertTimer = setTimeout(() => EMBED.alert(false), 8000);
  }
});

// ── in-app link tab (native layer on Android; injected/links.js reports its state) ──
// Desktop menu bar 「页面」 (src-tauri/src/menu.rs): reload goes through the
// same requestReload as the pill ⟳ (debounce · busy confirm · progress bar).
onPage('menu', (p) => {
  const action = p && p.action;
  if (action === 'reload') requestReload('menu');
  else if (action === 'back') page('navBack');
  else if (action === 'forward') page('navForward');
});

onPage('link-tab', (p) => {
  const open = !!(p && p.open);
  setStatus(open ? '链接页已打开（返回键 / ✕ 关闭）' : '链接页已关闭');
  if (open && EMBED) EMBED.close();
});

// ── reply watchdog: auto refresh on error card / empty reply (reference ReplyWatchdog) ──
/* injected/watchdog.js reports {k, path, generating, len, at, act} for the
 * open conversation; the pure policy (src/lib/watchdog.js) decides. The
 * switch (工具 → 回复出错或空白时自动刷新) is read fresh every time, and a
 * report about a page we already left never reloads the current one. */
onPage('watch', (payload) => {
  const status = watchdogParse(payload);
  if (!status) return;
  if (state.prefs.autoRefresh === false) return;
  const here = String(state.nav.path || '').replace(/\/+$/, '');
  if (here && here !== '/' && here !== status.path.replace(/\/+$/, '')) return;
  const now = Date.now();
  const linkTabOpen = !!(EMBED && typeof EMBED.linkTabOpen === 'function' && EMBED.linkTabOpen());
  const loading = state.loadingAt > 0 && now - state.loadingAt < (EMBED ? 30_000 : 1500);
  const decision = watchdogDecide(state.watchdog, status, now, { linkTabOpen, loading, taskStartedAt: state.taskStartedAt });
  state.watchdog = watchdogApplied(state.watchdog, status, decision, now);
  if (decision.action === 'reload') {
    const what = status.key === 'empty' ? '模型已结束但页面空白' : '回复显示错误';
    setStatus(`回复监控：${what}，自动刷新页面`);
    setTask({ kind: 'recovery' });
    setTimeout(() => { if (state.hud.task && state.hud.task.kind === 'recovery') setTask(null); }, 4000);
    requestReload('watchdog');
  } else if (decision.action === 'track' && decision.reason === WatchdogReason.NAG) {
    setStatus(WATCHDOG_LOG_NAG);
    flashPill('回复异常 · 请手动刷新', 4000);
  }
});

// ── module: 标题前缀预览 (fingerprint panel title prefix) ───────────────
// The title "<prefix><model>" preview for the 指纹 panel. firstModelOf resolves
// the model name to preview with: a CONFIRMED server model wins; otherwise, when
// the user opted in AND the current fingerprint estimate clears the confidence
// threshold, the estimate is previewed. This is preview only — nothing here
// drives Arena's rename dialog.
function firstModelOf(sessionId) {
  const sid = conversationFor(sessionId); // page id → stream id (/c/{evalId})
  const rec = state.sessions.get(sid);
  const live = rec?.models?.[0]?.model;
  if (live) return live;
  // Prefer a stored CONFIRMED model (server true name, not a title / fingerprint
  // guess) — a confirmed name always wins for titling.
  const r = resolveModel({ pageId: sessionId, conversationFor, sessions: state.sessions, historyIndex: state.historyIndex });
  if (r.source && r.source !== 'title' && r.source !== 'fingerprint') return r.models[0]?.model || '';
  // No confirmed model. Fall back to the fingerprint ESTIMATE only when the user
  // opted in AND the current estimate clears the (user-set) confidence threshold.
  // This is a statistical guess, not a true name — gated behind an explicit
  // switch so a persistent, user-visible rename never happens silently on a
  // low-confidence or uncalibrated verdict. A server true name arriving later
  // overwrites it through the normal trace path.
  if (state.prefs.fingerprintAutoRename) {
    const fp = state.fingerprint.lastResult;
    const threshold = Number(state.prefs.fingerprintRenameThreshold);
    if (fp && fp.status === 'attributed' && fp.sessionId === sid
        && Number(fp.confidence) >= (Number.isFinite(threshold) ? threshold : 0.85)) {
      return fp.estimatedModel || fp.family || '';
    }
  }
  return '';
}

function renderRenamePreview() {
  const model = (state.nav.sessionId && firstModelOf(state.nav.sessionId)) || '<模型名>';
  let text;
  try { text = '预览: ' + buildTitle({ prefix: state.prefs.renamePrefix, model }); } catch (e) { text = String(e.message || e); }
  q('ak-rename-preview').textContent = text;
}

function wireRename() {
  const prefix = q('ak-rename-prefix');
  prefix.value = state.prefs.renamePrefix || '';
  prefix.addEventListener('input', () => { state.prefs.renamePrefix = sanitizePrefix(prefix.value); renderRenamePreview(); });
  prefix.addEventListener('change', () => { prefix.value = sanitizePrefix(prefix.value); savePrefs({ renamePrefix: prefix.value }); renderRenamePreview(); });
  renderRenamePreview();
}

// ── module: 账号 (one-click switch between saved sessions, login helper) ──
/* The orchestration lives in src/lib/account-flow.js (DOM-free, tested end to
 * end against the real injected/account.js in tests/account-flow.test.mjs);
 * this block is the UI: list / 备注名 editor / re-login status.
 * Snapshots arrive as `account` page events (watcher in account.js) and as
 * answers to the `snapshot` RPC; the outcome of a switch is judged from the
 * first snapshot after the reload (pending is persisted, since the embedded
 * dock on Android dies with the page). */
const ACCOUNTS_KEY = 'accounts';
const ACCT_EMPTY = '<div class="ak-empty">还没有保存的账号：登录 Arena 后会自动记录当前账号；再点「添加另一个账号」登录第二个。</div>';
const acctStatus = (t) => { const el = q('ak-acct-status'); if (el) el.textContent = String(t ?? ''); };
/* 自动登录进度: shown only while (or right after) an automatic login runs;
 * the 取消 button only while it is running. */
let acctLoginHideTimer = 0;
const acctLoginStatus = (t, running = !/已停止|已取消|无需|无法|完成|失败|超时|另一个账号|拒绝|没有|手动/.test(String(t ?? ''))) => {
  const el = q('ak-acct-login-status'); if (el) el.textContent = String(t ?? '');
  const box = q('ak-acct-helper'); if (box) box.hidden = !t;
  const stop = q('ak-acct-stop'); if (stop) stop.hidden = !running;
  clearTimeout(acctLoginHideTimer);
  if (!running && box) acctLoginHideTimer = setTimeout(() => { box.hidden = true; }, 60_000);
};
function accountCall(action, args = {}, opts = { timeout: 8000 }) {
  if (!state.accountRpc) return Promise.reject(new Error('无 Tauri 运行时'));
  return state.accountRpc.call(action, args, opts);
}
function createAccounts() {
  return createAccountFlow({
    call: accountCall,
    loadStore: () => state.store.get(ACCOUNTS_KEY),
    saveStore: (st) => state.store.set(ACCOUNTS_KEY, st),
    reload: () => requestReload('account'),
    // restore / clear answered with navigateTo: the page is leaving for the
    // site root on its own — mirror requestReload's loading UI only.
    navigating: (url, source) => {
      setStatus(source === 'switch' ? '切换账号，正在打开新账号的页面…' : '页面跳转中…');
      state.loadingAt = Date.now();
      if (EMBED && typeof EMBED.setLoading === 'function') EMBED.setLoading(true);
      if (EMBED) EMBED.close();
    },
    invoke: state.tauri ? (cmd, args) => state.tauri.invoke(cmd, args) : null,
    status: acctStatus,
    loginStatus: acctLoginStatus,
    toast: (t) => { setStatus(t); if (EMBED) flashPill(t); },
    onChange: renderAccounts,
  });
}
const acct = () => state.acct;

async function deleteAccount(id) {
  const a = acct().find(id);
  if (!a) return;
  const ok = await confirmDialog({ title: '删除账号？', message: `删除「${accountLabel(a)}」保存的登录状态。不会退出该账号在 Arena 的登录。`, ok: '删除', cancel: '取消' });
  if (!ok) return;
  await acct().remove(id);
  if (state.acctEditId === id) { q('ak-acct-edit').hidden = true; state.acctEditId = null; }
}

function openAccountEditor(id) {
  const a = id ? acct().find(id) : null;
  if (!a) return;
  state.acctEditId = a.id;
  q('ak-acct-edit').hidden = false;
  q('ak-acct-edit-title').textContent = accountEmail(a) || accountLabel(a);
  q('ak-acct-label').value = a.label || '';
  try { q('ak-acct-label').focus(); } catch { /* ignore */ }
}
async function saveAccountEditor() {
  if (!state.acctEditId) return;
  await acct().setLabel(state.acctEditId, q('ak-acct-label').value);
  q('ak-acct-edit').hidden = true;
  state.acctEditId = null;
}

function accountRowHtml(a, active) {
  const label = accountLabel(a);
  const email = accountEmail(a);
  const sub = [
    email && email !== label ? email : '',
    hasSession(a) ? sessionAgeText(a) : (canLogin(a) ? '登录状态已失效 · 点「登录」自动重新登录' : '未保存登录状态'),
    a.provider === 'google' ? 'Google 登录' : (a.provider ? a.provider + ' 登录' : ''),
  ].filter(Boolean).join(' · ');
  const avatar = avatarStyle(a.avatar);
  const badge = active ? ' <span class="ak-badge ak-badge-brand">当前</span>' : (!hasSession(a) ? ' <span class="ak-badge ak-badge-warn">需登录</span>' : '');
  const main = active ? '' : `<button class="ak-btn ak-btn-sm ${hasSession(a) ? 'ak-filled' : 'ak-tonal'}" data-acct="switch" data-id="${esc(a.id)}">${hasSession(a) ? '切换' : '登录'}</button>`;
  return `<div class="ak-acct" data-id="${esc(a.id)}" data-active="${active ? 'true' : 'false'}">`
    + `<span class="ak-acct-avatar"${avatar}>${avatar ? '' : esc(initialOf(a))}</span>`
    + `<div class="ak-acct-main"><div class="ak-acct-name">${esc(label)}${badge}</div><div class="ak-acct-sub">${esc(sub)}</div></div>`
    + `<div class="ak-acct-actions">${main}<button class="ak-icon-btn" data-acct="edit" data-id="${esc(a.id)}" title="备注名" aria-label="编辑">✎</button><button class="ak-icon-btn" data-acct="delete" data-id="${esc(a.id)}" title="删除" aria-label="删除">✕</button></div>`
    + '</div>';
}
function renderAccounts() {
  if (!state.acct) return;
  const st = acct().accounts;
  const snap = acct().snap;
  const cur = q('ak-acct-current');
  if (cur) {
    if (!snap) cur.innerHTML = '<div class="ak-empty">尚未读取到登录状态（打开 Arena 页面后自动读取）</div>';
    else if (!snap.loggedIn) cur.innerHTML = `<div class="ak-empty">${snap.anonymous ? '页面当前是游客状态（未登录）：登录后会自动记录账号，游客状态不会被保存' : (snap.hasAuthCookie ? '检测到登录 Cookie，但无法解析账号信息（请点「保存当前登录」重试）' : '页面当前未登录')}</div>`;
    else {
      const active = acct().active();
      const shown = active || { id: '', label: '', name: snap.name, email: snap.email, avatar: snap.avatar, provider: snap.provider, cookies: snap.cookies || [], capturedAt: 0 };
      const sub = [accountEmail(shown) !== accountLabel(shown) ? accountEmail(shown) : '', snap.provider === 'google' ? 'Google 登录' : (snap.provider || '')].filter(Boolean).join(' · ');
      cur.innerHTML = `<div class="ak-acct" data-id="${esc(shown.id)}" data-active="true"><span class="ak-acct-avatar"${avatarStyle(shown.avatar)}>${avatarStyle(shown.avatar) ? '' : esc(initialOf(shown))}</span>`
        + `<div class="ak-acct-main"><div class="ak-acct-name">${esc(accountLabel(shown))}${active ? '' : ' <span class="ak-badge ak-badge-warn">未保存</span>'}</div><div class="ak-acct-sub">${esc(sub)}</div></div></div>`;
    }
  }
  const scope = q('ak-acct-scope');
  if (scope) scope.textContent = snap && snap.scope ? ('Cookie 作用域 ' + (snap.scope === 'domain' ? '.arena.ai' : 'arena.ai')) : '';
  const count = q('ak-acct-count');
  if (count) count.textContent = st.list.length ? st.list.length + ' 个账号' : '';
  const list = q('ak-acct-list');
  if (list) list.innerHTML = st.list.length ? st.list.map((a) => accountRowHtml(a, a.id === st.activeId)).join('') : ACCT_EMPTY;
}
function wireAccounts() {
  const list = q('ak-acct-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && typeof t.closest === 'function' ? t.closest('[data-acct]') : (t && t.dataset && t.dataset.acct ? t : null);
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.acct;
      if (act === 'switch') acct().switchTo(id);
      else if (act === 'edit') openAccountEditor(id);
      else if (act === 'delete') deleteAccount(id);
    });
  }
  const labelIn = q('ak-acct-label');
  if (labelIn) labelIn.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') saveAccountEditor(); });
  renderAccounts();
}

onPage('account-result', (r) => { if (state.accountRpc) state.accountRpc.deliver(r); });
onPage('account', (snap) => {
  // account.js checked the session the previous page handed over (restore
  // with navigate); anything but intact / rotated is worth a log line
  if (snap && snap.bootCheck && !/^(intact|rotated)$/.test(String(snap.bootCheck))) setStatus('账号会话核对: ' + snap.bootCheck);
  if (state.acct) acct().onSnapshot(snap);
});
onPage('login', (p) => {
  if (!p || typeof p !== 'object') return;
  const line = loginStageText(p.stage, p);
  acctLoginStatus(line, !/^(done|error|wrong-account|timeout|stopped)$/.test(p.stage));
  // the page does the clicking → keep the sheet out of its way
  if (/^arena-(google|add|retry)/.test(p.stage) && EMBED) EMBED.close();
  if (/^(done|error|wrong-account|timeout)$/.test(p.stage)) { acctStatus(line); setStatus(line); if (EMBED) flashPill(p.stage === 'done' ? '已登录' : '登录失败'); }
});

// ── module: enhancement toggles + ENI ───────────────────────────────────
function wireControls() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'export-evidence') {
        exportCurrentEvidence();
      } else if (a === 'usage-back') {
        state.view = { sessionId: null, runId: null };
        renderUsage();
      } else if (a === 'history-export') {
        exportAllHistory();
      } else if (a === 'history-clear') {
        clearHistory(el);
      } else if (a === 'archive-current') {
        archiveCurrent(el);
      } else if (a === 'pulse-refresh') {
        refreshPulseNow();
      } else if (a === 'nav-back') {
        page('navBack');
      } else if (a === 'nav-forward') {
        page('navForward');
      } else if (a === 'nav-reload' || a === 'page-reload') {
        requestReload('panel');
      } else if (a === 'save-eni') {
        const eniText = q('ak-eni-text').value;
        const eniOn = q('ak-eni-on').checked;
        savePrefs({ eniText, eniOn });
        page('eniSet', eniOn, eniText);
        setStatus('提示词已保存');
      } else if (a === 'acct-save') {
        acct().saveCurrent();
      } else if (a === 'acct-add') {
        acct().add();
      } else if (a === 'acct-edit-save') {
        saveAccountEditor();
      } else if (a === 'acct-edit-cancel') {
        q('ak-acct-edit').hidden = true;
        state.acctEditId = null;
      } else if (a === 'acct-stop-login') {
        acct().stopLogin();
      } else if (a === 'fingerprint-start') {
        // Explicit user click → confirm the max-message budget, then run. Real
        // messages are sent only after the confirm; the runner's preflight
        // re-checks every hard gate (page/mode, ≥2 candidates, bank).
        startFingerprint();
      } else if (a === 'fingerprint-stop') {
        if (state.fingerprint.runner && typeof state.fingerprint.runner.stop === 'function') { state.fingerprint.runner.stop(); fingerprintLog('正在停止…'); }
      } else if (a === 'fingerprint-copy') {
        copyFingerprintDiagnostic();
      } else if (a === 'fingerprint-clear') {
        clearFingerprint();
      } else if (a === 'fingerprint-collect') {
        collectFingerprintSamples();
      } else if (a === 'fingerprint-collect-stop') {
        state.fingerprint.stopCollect = true;
        fingerprintLog('正在停止自动采集…');
      } else if (a === 'fingerprint-library-export') {
        exportFingerprintLibrary();
      } else if (a === 'fingerprint-library-clear') {
        confirmDialog({ title: '清空指纹样本库', message: `确定删除本机保存的 ${state.fingerprint.library.length} 条已确认样本？`, ok: '清空', cancel: '取消' }).then(async (ok) => {
          if (!ok) return; state.fingerprint.library = []; await state.store.set(FP_LIBRARY_KEY, []); renderFingerprintLibrary(); setStatus('指纹样本库已清空');
        });
      }
    });
  });

  q('ak-eni-on').checked = !!state.prefs.eniOn;
  q('ak-eni-text').value = state.prefs.eniText || '';
  // Push on every toggle so the page hook flips immediately (the textarea
  // save still re-pushes; this just makes the switch live).
  q('ak-eni-on').addEventListener('change', () => {
    const v = q('ak-eni-on').checked;
    const t = q('ak-eni-text').value;
    savePrefs({ eniOn: v, eniText: t });
    page('eniSet', v, t);
  });
}

// ── boot ────────────────────────────────────────────────────────────────
root.querySelectorAll('.ak-mod-head').forEach((h) => {
  h.addEventListener('click', () => {
    const mod = h.parentElement;
    mod.dataset.open = mod.dataset.open === 'true' ? 'false' : 'true';
  });
});

async function boot() {
  state.tauri = getTauri();
  state.store = createStore(state.tauri);
  state.history = createHistoryStore(state.store);
  state.monitor = createReplyMonitor({ tracker: state.tracker });
  if (state.tauri) {
    pageActions = EMBED
      ? createPageActions({ win: globalThis })
      : createPageActions({ evalInPage: (js) => state.tauri.invoke('arena_command', { js }) });
  }
  state.rpc = state.tauri ? createRpc({ send: (action, argsJson, reqId) => pageActions('probeCall', action, argsJson, reqId) }) : null;
  state.accountRpc = state.tauri ? createRpc({ send: (action, argsJson, reqId) => pageActions('accountCall', action, argsJson, reqId) }) : null;
  await loadPrefs();
  await loadFingerprintLibrary();
  const acctFlow = createAccounts();
  await acctFlow.load(); // before any page event can reach onSnapshot
  state.acct = acctFlow;
  if (EMBED && EMBED.host && EMBED.host.dataset) EMBED.host.dataset.embed = 'true';
  wireTheme();
  wireTabs();
  wireActivity();
  wireSettings();
  wireControls();
  wireUsageView();
  wireHistory();
  wireRename();
  wireFingerprint();
  wireAccounts();
  // The fingerprint runner needs the RPC channel; create it once that exists and
  // flip the start button on (setFingerprintRunningUi re-checks the toggle).
  if (state.rpc) { state.fingerprint.runner = createDockFingerprint(); setFingerprintRunningUi(false); }
  // Status-pill gestures (reference MainActivity): tap → panel (the shell
  // opens it itself), tap on ⟳ → reload, long press → quick menu (below),
  // pull-up at the bottom of the conversation → reload.
  if (EMBED && typeof EMBED.onAction === 'function') {
    if (typeof EMBED.setMenuProvider === 'function') {
      EMBED.setMenuProvider(() => [
        { id: 'refresh', label: '刷新页面' },
        { id: 'account', label: '切换账号' },
        { id: 'panel', label: '打开面板' },
      ]);
    }
    EMBED.onAction((name, arg) => {
      const id = name === 'menu' ? arg : name;
      if (id === 'refresh') {
        requestReload('pill');
      } else if (id === 'pull-refresh') {
        requestReload('pull');
      } else if (id === 'account') {
        showTab('account');
        EMBED.open();
      } else if (id === 'panel' && name === 'menu') {
        EMBED.open();
      }
    });
  }
  await loadAliases();
  await loadHistoryIndex();
  if (!state.tauri) {
    setStatus('浏览器预览模式(无 Tauri 运行时)');
    return;
  }
  await state.tauri.listen('arenakit://trace', (e) => onTrace(e.payload));
  await state.tauri.listen('arenakit://page', (e) => {
    const p = e.payload;
    const h = p && pageHandlers.get(p.name);
    if (h) { try { h(p.payload); } catch (err) { console.warn('[dock] page handler', p.name, err); } }
  });
  // Embedded: the bridge announced the initial navigation before our listener
  // existed — read it directly so the current conversation is known at once.
  if (EMBED && globalThis.__ARENAKIT__ && typeof globalThis.__ARENAKIT__.navState === 'function') {
    const h = pageHandlers.get('nav');
    if (h) { try { h({ ...globalThis.__ARENAKIT__.navState(), reason: 'init' }); } catch (err) { console.warn('[dock] nav seed', err); } }
  }
  // Desktop: the arena webview may have announced its first navigation while
  // the dock was still loading prefs/history — ask it to announce again so the
  // current conversation's stored model shows up right away.
  if (!EMBED) dispatchToPage('nav-announce', null);
  applyPageFlags();
  renderMonitor();
  // The page may have announced its session before our listener existed
  // (embedded: the dock boots after account.js) — ask once.
  accountCall('snapshot', {}, { timeout: 10_000 }).then((snap) => state.acct.onSnapshot(snap)).catch(() => {});
  setStatus(EMBED ? '就绪（内嵌模式）' : '就绪');
}

boot();

export { state, page, dispatchToPage, onPage, esc };
