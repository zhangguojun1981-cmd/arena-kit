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
import { buildTitle, sanitizePrefix, createRenameGate } from './lib/rename.js';
import { parseTargets, DEFAULT_TARGETS } from './lib/probe-logic.js';
import { createProbeController } from './lib/probe-runner.js';
import { sessionProbePrecheck, sessionProbeText, awaitTurnModel } from './lib/session-probe.js';
import { createReplyMonitor } from './lib/monitor.js';
import { createPulseState } from './lib/pulse.js';
import { pillLabel, turnHeadline } from './lib/pill-layout.js';
import { initialState as watchdogInitialState, parseStatus as watchdogParse, decide as watchdogDecide, applied as watchdogApplied, Reason as WatchdogReason, LOG_RELOADING as WATCHDOG_LOG_RELOADING, LOG_NAG as WATCHDOG_LOG_NAG } from './lib/watchdog.js';
import { upsertLogin, accountLabel, accountEmail, initialOf, hasSession, hasLogin, loginStageText, sessionAgeText } from './lib/accounts.js';
import { createAccountFlow } from './lib/account-flow.js';
import { totpNow, parseOtpSecret } from './lib/totp.js';

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
  renameGate: null,         // createRenameGate() — auto-rename once per conversation
  renaming: false,          // a rename dialog is being driven right now
  probe: null,              // createProbeController() — auto probe / cleanup / quick send
  probeDraw: false,         // current probe run is a draw (自动抽卡) rather than a target probe
  quickBusy: false,         // a session probe is in flight
  monitor: null,            // createReplyMonitor() — reply stream anomaly badges
  pulse: createPulseState(), // daily quota % + anchored reset countdown
  // header + status-pill display state: model/routed/pending, the running
  // task (probe / cleanup / recovery) and a transient flash message
  hud: { model: '', routed: false, strength: '', pending: false, status: '', task: null, flash: '', flashTimer: 0, alertTimer: 0 },
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
  unlockOpus: false,        // off by default since 0.4.5 (see loadPrefs migration)
  unlockHidden: false,
  plus: true,
  eniOn: false,
  eniText: '',
  renamePrefix: '',   // optional title prefix: "<prefix><model>"
  autoRename: false,  // rename the current conversation once its model is identified
  probeTargets: DEFAULT_TARGETS.join(', '),
  probeRounds: 5,
  probeFindAll: true,
  probeRename: true,
  cleanupAfterProbe: false, // sweep arithmetic-titled probe residue when a probe run ends
  quickText: '',            // session probe text ('' = random arithmetic)
  quickRename: false,       // rename the conversation after the session probe identifies its model
  theme: 'auto',            // 'auto' (follow system, like the reference DayNight theme) | 'light' | 'dark'
  panelTab: 'chat',         // last selected segmented tab
  pillRefresh: true,        // 悬浮窗显示刷新按钮 (Android status pill ⟳ zone)
  autoRefresh: true,        // 回复出错或空白时自动刷新 (reply watchdog)
  ballCenter: 'percent-model', // 悬浮球显示: 'percent-model' | 'percent' | 'model'
  capture: true,            // 截获会话流 (extension 监听 toggle): hand run tokens to Rust
  pulseOn: true,            // 额度轮询: periodic /api/me/pulse reads (manual 刷新 always works)
  monitorOn: true,          // 回复监控: reply-stream anomaly detection
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
const FLAG_PREFS = [['capture', 'capture', 'ak-capture-on'], ['pulse', 'pulseOn', 'ak-pulse-on'], ['monitor', 'monitorOn', 'ak-monitor-on']];
/* Push the switches into the arena page (injected snoop / pulse / monitor /
 * watchdog read window.__ARENAKIT_FLAGS__). Re-applied on every page load. */
function applyPageFlags() {
  for (const [flag, key] of FLAG_PREFS) page('flagSet', flag, state.prefs[key] !== false);
  page('flagSet', 'autoRefresh', state.prefs.autoRefresh !== false);
  // unlock.js / plus.js read their switches from the page's localStorage at
  // document_start; mirror the dock prefs there so the NEXT load agrees with
  // the switches (a fresh profile / cleared site data starts from defaults).
  page('unlockSet', 'opus', !!state.prefs.unlockOpus);
  page('unlockSet', 'hidden', !!state.prefs.unlockHidden);
  page('plusSet', state.prefs.plus !== false);
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
  // 最多轮数 stepper
  root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const input = q('ak-probe-rounds');
    const n = Math.min(100, Math.max(1, (parseInt(input.value, 10) || 5) + Number(b.dataset.step)));
    input.value = String(n);
    persistProbePanel();
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
  state.reloadAt = now;
  const running = state.probe?.isRunning ? state.probe.mode : null;
  if (running) {
    if (source !== 'watchdog') {
      const what = running === 'cleanup' ? '清理正在进行，刷新会中断本次清理。' : '探针正在运行，刷新会中断本次探针。';
      const ok = await confirmDialog({ title: '刷新页面？', message: what, ok: '停止并刷新', cancel: '取消' });
      if (!ok) return false;
    }
    state.probe.stop();
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
function setModelDisplay(text, { routed = false, known = true, pending = false, strength = '' } = {}) {
  const t = String(text || '');
  const hud = q('ak-hud-model');
  const label = known && t ? t + (strength ? ' · ' + strength : '') : '模型待确认';
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
  setModelDisplay('', { known: false });
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
  else if (!state.quickBusy) state.taskStartedAt = 0;
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
  // 0.4.5: unlock.js had never run before 0.4.4 (its extension boot threw);
  // 0.4.4 switched it on for everyone and its rewrite broke hydration (taps
  // on the page did nothing). Both unlock switches start off once; the user
  // turns them back on deliberately.
  if (state.prefs.unlockReset !== 1) {
    state.prefs = { ...state.prefs, unlockOpus: false, unlockHidden: false, unlockReset: 1 };
    await state.store.set('prefs', state.prefs).catch(() => {});
  }
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
    if (models.length && p.complete) maybeAutoRename(p.sessionId, models[0].model, run);
    // Per-turn model resolution (routed = differs from this conversation's first model).
    let turn = tracker.turnOf(runKey);
    if (!turn && models.length) turn = tracker.onToken(p.sessionId, runKey).turn; // model without a seen token stage
    let head = '';
    if (turn && models.length) {
      head = tracker.record(turn, models[0].model, models.map((m) => m.model), p.strength || '');
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
  } else if (p.stage === 'error' && p.fatal) {
    q('ak-model-sub').textContent = p.status || '错误';
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
    return `<div class="ak-turn"><span class="ak-turn-n">R${e.turn}</span><span class="ak-turn-m${e.routed ? ' ak-routed' : ''}">${esc(model || (failed(e) ? (e.status || '未识别') : '识别中…'))}${e.strength ? ' <span class="ak-sub">· ' + esc(e.strength) + '</span>' : ''}${routed}${marks}</span>${status && model ? `<span class="ak-turn-s">${esc(status)}</span>` : ''}${icon}</div>`;
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
    const record = await state.history.save({ sessionId, title, models, runId, checkedAt: usage?.checkedAt, usage, turn: turn ?? undefined });
    state.historyIndex.set(sessionId, record);
    renderHistory();
    renderUsage();
  } catch (e) {
    setStatus('已识别模型，但本地保存失败: ' + (e?.message || e));
  }
}
async function loadHistoryIndex() {
  if (!state.history) return;
  try {
    const list = await state.history.list();
    state.historyIndex = new Map(list.map((r) => [r.sessionId, r]));
    state.historyCarry = await state.history.carry();
  } catch (e) { setStatus('读取历史失败: ' + (e?.message || e)); }
  renderHistory();
  renderUsage();
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
      ? turns.map((t) => `R${t.turn ?? '?'} ${esc(t.models.join('/'))}`).join(' · ')
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
  if (state.probe?.isRunning) { setStatus('探针 / 清理进行中，请先停止'); return; }
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
  } else if (switched && (state.sessions.has(sid) || restoreFromHistory(sid))) {
    // Back to a known conversation: show its remembered model (local record,
    // not re-verified) until a new turn produces a fresh trace.
    const rec = state.sessions.get(sid);
    const last = rec.runs.at(-1);
    state.current = { sessionId: sid, runId: last?.runId || null };
    const record = state.historyIndex.get(sid);
    if (record) rebuildTrackerFromRecord(sid, record); else { state.tracker.reset(sid); renderTurns(); }
    setModelDisplay(rec.models.map((m) => m.model).join(' / '), { known: rec.models.length > 0 });
    q('ak-model-sub').textContent = [last ? 'run ' + last.runId.slice(0, 14) : '', last ? completion(last.spans) : '', rec.historical ? '本地记录 · 非重新验证' : ''].filter(Boolean).join(' · ');
    setHudStatus(rec.historical ? '已恢复本地记录的模型（非重新验证）' : (state.turnHead || '本次运行已识别'));
    renderUsage();
  } else if (switched) {
    state.current = { sessionId: sid, runId: null };
    state.tracker.reset(sid);
    setModelDisplay('', { known: false });
    q('ak-model-sub').textContent = '此对话尚无本地记录';
    setHudStatus('此对话尚无本地记录 · 发一条消息后识别');
    renderTurns();
    renderUsage();
  }
  renderPill(); // "新对话" / model label follows the page
});

// ── module: auto probe (Android ProbeController port) ───────────────────
// The dock is the orchestrator; every page step is a probe.js RPC action and
// model names come from the trace pipeline (state.sessions, keyed by session).
const PROBE_LOG_MAX = 60;
function probeLog(line) {
  const el = q('ak-probe-log');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0'), ss = String(t.getSeconds()).padStart(2, '0');
  const lines = el.textContent ? el.textContent.split('\n') : [];
  lines.push(`${hh}:${mm}:${ss} ${line}`);
  el.textContent = lines.slice(-PROBE_LOG_MAX).join('\n');
  el.hidden = false;
  el.scrollTop = el.scrollHeight;
  setStatus(line);
}

function probeConfigFromPanel() {
  const rounds = Math.min(100, Math.max(1, parseInt(q('ak-probe-rounds').value, 10) || 5));
  q('ak-probe-rounds').value = String(rounds);
  return {
    targets: parseTargets(q('ak-probe-targets').value),
    maxRounds: rounds,
    findAll: q('ak-probe-findall').checked,
    autoRename: q('ak-probe-rename').checked,
  };
}
function persistProbePanel() {
  const cfg = probeConfigFromPanel();
  return savePrefs({ probeTargets: q('ak-probe-targets').value, probeRounds: cfg.maxRounds, probeFindAll: cfg.findAll, probeRename: cfg.autoRename });
}
function setProbeRunningUi(running, what = '探针') {
  root.querySelector('[data-action="probe-start"]').disabled = running;
  root.querySelector('[data-action="draw-start"]').disabled = running;
  root.querySelector('[data-action="probe-stop"]').disabled = !running;
  root.querySelector('[data-action="probe-stop"]').textContent = running ? `停止${what}` : '停止';
}

/* mode 'probe' (until targets hit) or 'draw' (extension 自动抽卡: N rounds,
 * every chat renamed to its model, no targets). */
async function startProbe(mode = 'probe') {
  if (!state.probe) { probeLog('无 Tauri 运行时'); return; }
  if (state.probe.isRunning) { probeLog(state.probe.mode === 'cleanup' ? '清理进行中，请先停止' : '探针已在运行'); return; }
  await persistProbePanel();
  const cfg = { ...probeConfigFromPanel(), mode };
  if (mode !== 'draw' && !cfg.targets.length) { probeLog('请填写至少一个目标'); return; }
  q('ak-probe-log').textContent = '';
  setProbeRunningUi(true, mode === 'draw' ? '抽卡' : '探针');
  let result = null;
  try {
    result = await state.probe.start(cfg);
  } finally {
    setProbeRunningUi(false);
  }
  // Optional follow-up sweep: archive the arithmetic-titled chats the run
  // left behind (hit chats were renamed, so they are not candidates). Skipped
  // when the user stopped the probe by hand.
  if (result && !result.cancelled && state.prefs.cleanupAfterProbe) {
    probeLog('探针结束，开始自动清理…');
    await startCleanup();
  }
}

// ── module: cleanup sweep (archive arithmetic-titled probe residue) ─────
function setCleanupRunningUi(running) {
  root.querySelector('[data-action="cleanup-start"]').disabled = running;
  root.querySelector('[data-action="cleanup-stop"]').disabled = !running;
}
async function startCleanup() {
  if (!state.probe) { setStatus('无 Tauri 运行时'); return null; }
  if (state.probe.isRunning) { probeLog(state.probe.mode === 'probe' ? '探针运行中，请先停止再清理' : '清理已在进行'); return null; }
  setCleanupRunningUi(true);
  q('ak-cleanup-state').textContent = '扫描侧栏算式标题…';
  try {
    // keepSessionId = the conversation on screen; it is never archived.
    return await state.probe.cleanup(state.nav.sessionId || null);
  } finally {
    setCleanupRunningUi(false);
  }
}
function wireCleanup() {
  const after = q('ak-cleanup-after');
  after.checked = !!state.prefs.cleanupAfterProbe;
  after.addEventListener('change', () => savePrefs({ cleanupAfterProbe: after.checked }));
  setCleanupRunningUi(false);
}

function createDockProbe() {
  const counters = state.prefs.probeSuffixes && typeof state.prefs.probeSuffixes === 'object' ? state.prefs.probeSuffixes : {};
  return createProbeController({
    rpc: state.rpc,
    // The probe knows the PAGE id; turn data lives under the stream id it aliases.
    modelForSession: (sid) => (state.sessions.get(conversationFor(sid))?.models || []).map((m) => m.model),
    // Extension acquire.js parity: show which stage the capture is in while waiting.
    stageForSession: (sid) => {
      if (state.tracker.sessionId !== conversationFor(sid)) return '截获会话流，等待运行令牌';
      const t = state.tracker.turns.at(-1);
      return t?.status && t.status !== '已识别' ? `拉取 trace · ${t.status}` : '已取得运行令牌，读取 trace…';
    },
    onProgress: probeLog,
    onFinished: (summary) => {
      probeLog(summary);
      if (/^清理|^没有需要归档/.test(summary)) q('ak-cleanup-state').textContent = summary;
      else q('ak-probe-state').textContent = summary;
    },
    onProbeState: (round, max, hits, active) => {
      const draw = !!state.probeDraw;
      q('ak-probe-state').textContent = active
        ? (draw ? `抽卡进行中 · 第 ${round}/${max} 轮 · 已识别 ${hits}` : `探针运行中 · 第 ${round}/${max} 轮 · 命中 ${hits}`)
        : (q('ak-probe-state').textContent || '');
      // Reference pill: "探针 2/5 · 命中 1" while running, "探针结束 · 命中 n" for 4 s after.
      if (active) setTask({ kind: 'probe', round, max, hits, draw });
      else { setTask(null); flashPill(`${draw ? '抽卡' : '探针'}结束 · ${draw ? '识别' : '命中'} ${hits}`, 4000); }
    },
    onCleanupState: (archived, active) => {
      q('ak-cleanup-state').textContent = active ? `清理中 · 已归档 ${archived}` : `上次清理已归档 ${archived}`;
      if (active) setTask({ kind: 'cleanup', archived });
      else { setTask(null); flashPill(`清理完成 · 已归档 ${archived}`, 4000); }
    },
    // Extension parity: an archived probe chat also loses its local record.
    onArchived: (sid) => { dropLocalRecord(sid).catch(() => {}); },
    buildTitle: (model, suffix) => buildTitle({ prefix: state.prefs.renamePrefix, model, suffix }),
    titlePrefix: () => state.prefs.renamePrefix || '',
    suffixCounters: counters,
    onSuffixes: (c) => savePrefs({ probeSuffixes: c }),
  });
}

function wireProbe() {
  q('ak-probe-targets').value = state.prefs.probeTargets || DEFAULT_TARGETS.join(', ');
  q('ak-probe-rounds').value = String(state.prefs.probeRounds || 5);
  q('ak-probe-findall').checked = state.prefs.probeFindAll !== false;
  q('ak-probe-rename').checked = state.prefs.probeRename !== false;
  for (const id of ['ak-probe-targets', 'ak-probe-rounds', 'ak-probe-findall', 'ak-probe-rename']) q(id).addEventListener('change', persistProbePanel);
  setProbeRunningUi(false);
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
    return `<div class="ak-item"><span class="ak-item-title">${esc(hm)} · ${e.turn ? 'R' + e.turn : '会话 ' + esc(e.sessionId.slice(0, 8))}${badges}</span><span class="ak-item-models ak-sub">${esc(e.line)}</span></div>`;
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

// ── module: session probe (send into the OPEN conversation, identify this turn)
const quickState = (t) => { q('ak-quick-state').textContent = t; };
async function sessionProbe() {
  if (!state.probe || !state.rpc) { quickState('无 Tauri 运行时'); return; }
  if (state.quickBusy) { quickState('上一条探针仍在等待识别…'); return; }
  state.quickBusy = true;
  if (!state.taskStartedAt) state.taskStartedAt = Date.now();
  const btn = root.querySelector('[data-action="quick-send"]');
  btn.disabled = true;
  try {
    await savePrefs({ quickText: q('ak-quick-text').value, quickRename: q('ak-quick-rename').checked });
    let text;
    try { text = sessionProbeText(state.prefs.quickText); } catch (e) { quickState(String(e.message || e)); return; }
    const pre = await state.rpc.call('precheck').catch((e) => { quickState('无法读取页面状态: ' + (e.message || e)); return null; });
    if (!pre) return;
    const go = sessionProbePrecheck(pre, { probeRunning: state.probe.isRunning });
    if (!go.ok) { quickState(go.reason); return; }
    const sessionId = pre.session || null;
    const afterTurn = sessionId && state.tracker.sessionId === sessionId ? state.tracker.turnCount : 0;
    quickState(`发送 "${text.slice(0, 40)}"…${go.reason ? ' · ' + go.reason : ''}`);
    flashPill('探针发送中…', 2500);
    const sent = await state.probe.quickSend(text);
    if (!sent.ok) { quickState(sent.message); return; }
    quickState('已发送，等待本轮 trace 识别模型…');
    const hit = await awaitTurnModel({ tracker: state.tracker, afterTurn, sessionId });
    if (!hit) { quickState('等待超时：本轮未识别到模型（trace 可能未包含模型标签）'); return; }
    const routed = state.tracker.firstModel && hit.model !== state.tracker.firstModel;
    quickState(`第 ${hit.turn} 轮实际模型：${hit.models.join(' / ')}${routed ? `（非首轮模型 ${state.tracker.firstModel}）` : ''}`);
    setStatus(`会话探针：第 ${hit.turn} 轮 → ${hit.model}`);
    if (state.prefs.quickRename) {
      const sid = sessionId || state.tracker.sessionId || state.nav.sessionId;
      if (!sid) { quickState(q('ak-quick-state').textContent + ' · 无会话 ID，未重命名'); return; }
      try {
        await renameConversation(sid, buildTitle({ prefix: state.prefs.renamePrefix, model: hit.model }), { reason: '会话探针' });
      } catch (e) {
        quickState(q('ak-quick-state').textContent + ' · 重命名失败: ' + (e.message || e));
      }
    }
  } finally {
    state.quickBusy = false;
    if (!state.hud.task || state.hud.task.kind === 'recovery') state.taskStartedAt = 0;
    btn.disabled = false;
  }
}
function wireSessionProbe() {
  q('ak-quick-text').value = state.prefs.quickText || '';
  q('ak-quick-rename').checked = !!state.prefs.quickRename;
  q('ak-quick-text').addEventListener('change', () => savePrefs({ quickText: q('ak-quick-text').value }));
  q('ak-quick-rename').addEventListener('change', (e) => savePrefs({ quickRename: e.target.checked }));
}

// ── module: rename conversation (prefix + manual / auto) ────────────────
// Rename goes through Arena's own sidebar ⋯ → Rename dialog (probe.js →
// conversation-rename.js), never a private endpoint. Auto-rename fires at most
// once per conversation (gate persisted in the store), only for the
// conversation currently open, and only once the trace is complete.
const renameStatus = (t) => { q('ak-rename-status').textContent = t; };

function firstModelOf(sessionId) {
  const sid = conversationFor(sessionId); // page id → stream id (/c/{evalId})
  const rec = state.sessions.get(sid);
  const live = rec?.models?.[0]?.model;
  if (live) return live;
  return state.historyIndex.get(sid)?.models?.[0]?.model || state.historyIndex.get(sessionId)?.models?.[0]?.model || '';
}

function renderRenamePreview() {
  const model = (state.nav.sessionId && firstModelOf(state.nav.sessionId)) || '<模型名>';
  let text;
  try { text = '预览: ' + buildTitle({ prefix: state.prefs.renamePrefix, model }); } catch (e) { text = String(e.message || e); }
  q('ak-rename-preview').textContent = text;
}

async function renameConversation(sessionId, title, { reason }) {
  if (!state.rpc) throw new Error('无 Tauri 运行时');
  if (state.renaming) throw new Error('上一次重命名尚未完成');
  state.renaming = true;
  try {
    renameStatus(`${reason}重命名为「${title}」…`);
    const res = await state.rpc.call('rename', { sessionId, title });
    const rec = sessionRecord(sessionId);
    rec.title = title;
    if (state.nav.sessionId === sessionId) state.nav.title = title;
    if (state.historyIndex.has(sessionId)) {
      await state.history.retitle(sessionId, title).then((r) => { if (r) state.historyIndex.set(sessionId, r); }).catch(() => {});
      renderHistory();
    }
    renameStatus(`${reason}已重命名为「${res?.title || title}」`);
    setStatus('对话已重命名');
    return true;
  } finally {
    state.renaming = false;
  }
}

async function renameNow() {
  const sid = state.nav.sessionId;
  if (!sid) { renameStatus('请先打开一个已保存的 Arena 对话'); return; }
  const model = firstModelOf(sid);
  if (!model) { renameStatus('此对话尚未识别模型，请先发送一条消息'); return; }
  try {
    await renameConversation(sid, buildTitle({ prefix: state.prefs.renamePrefix, model }), { reason: '手动' });
  } catch (e) {
    renameStatus('重命名失败: ' + (e && e.message || e));
  }
}

const autoRenameSeen = new Set(); // in-memory fast path in front of the persisted gate
async function maybeAutoRename(sessionId, model, run) {
  if (!state.prefs.autoRename || !state.rpc || !sessionId || !model) return;
  if (state.probe?.isRunning) return;                          // the probe names its own sessions
  // Only the conversation on screen; the page id may alias the stream id
  // (/c/{evalId}) and the page-side rename needs the PAGE id.
  const pageId = state.nav.sessionId;
  if (!pageId || conversationFor(pageId) !== sessionId) return;
  if (run?.spans?.some((sp) => sp.partial)) return;           // wait for the usage to settle
  if (autoRenameSeen.has(sessionId)) return;
  autoRenameSeen.add(sessionId);
  let title;
  try { title = buildTitle({ prefix: state.prefs.renamePrefix, model }); } catch (e) { renameStatus(String(e.message || e)); return; }
  if (state.nav.title && state.nav.title.trim() === title) return; // already named
  try {
    if (!(await state.renameGate.claim(sessionId))) return;     // renamed (or tried) in an earlier session
    await renameConversation(pageId, title, { reason: '自动' });
  } catch (e) {
    renameStatus('自动重命名失败: ' + (e && e.message || e) + '（可点击“立即重命名”重试）');
  }
}

function wireRename() {
  const prefix = q('ak-rename-prefix');
  prefix.value = state.prefs.renamePrefix || '';
  prefix.addEventListener('input', () => { state.prefs.renamePrefix = sanitizePrefix(prefix.value); renderRenamePreview(); });
  prefix.addEventListener('change', () => { prefix.value = sanitizePrefix(prefix.value); savePrefs({ renamePrefix: prefix.value }); renderRenamePreview(); });
  const auto = q('ak-auto-rename');
  auto.checked = !!state.prefs.autoRename;
  auto.addEventListener('change', () => { savePrefs({ autoRename: auto.checked }); renameStatus(auto.checked ? '已开启：识别到模型后自动重命名当前对话（每个对话仅一次）' : '已关闭自动重命名'); });
  renderRenamePreview();
}

// ── module: 账号 (one-click switch between saved sessions, login helper) ──
/* The orchestration lives in src/lib/account-flow.js (DOM-free, tested end to
 * end against the real injected/account.js in tests/account-flow.test.mjs);
 * this block is the UI: list / editor / live 2FA codes / login helper panel.
 * Snapshots arrive as `account` page events (watcher in account.js) and as
 * answers to the `snapshot` RPC; the outcome of a switch is judged from the
 * first snapshot after the reload (pending is persisted, since the embedded
 * dock on Android dies with the page). */
const ACCOUNTS_KEY = 'accounts';
const ACCT_EMPTY = '<div class="ak-empty">还没有保存的账号：登录 Arena 后会自动记录当前账号；再点「添加另一个账号」登录第二个。</div>';
const acctStatus = (t) => { const el = q('ak-acct-status'); if (el) el.textContent = String(t ?? ''); };
const acctLoginStatus = (t) => { const el = q('ak-acct-login-status'); if (el) el.textContent = String(t ?? ''); };
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
    needLogin: (acc) => openAccountEditor(acc.id),
    onChange: renderAccounts,
  });
}
const acct = () => state.acct;

async function deleteAccount(id) {
  const a = acct().find(id);
  if (!a) return;
  const ok = await confirmDialog({ title: '删除账号？', message: `删除「${accountLabel(a)}」保存的登录状态和登录信息。不会退出该账号在 Arena 的登录。`, ok: '删除', cancel: '取消' });
  if (!ok) return;
  await acct().remove(id);
  if (state.acctEditId === id) { q('ak-acct-edit').hidden = true; state.acctEditId = null; }
}

function openAccountEditor(id) {
  const a = id ? acct().find(id) : null;
  state.acctEditId = a ? a.id : null;
  q('ak-acct-edit').hidden = false;
  q('ak-acct-edit-title').textContent = a ? accountLabel(a) : '新账号';
  q('ak-acct-label').value = a ? a.label : '';
  q('ak-acct-email').value = a ? (a.login.email || a.email) : '';
  q('ak-acct-password').value = a ? a.login.password : '';
  q('ak-acct-totp').value = a ? a.login.totp : '';
  q('ak-acct-auto').checked = a ? a.login.auto !== false : true;
  q('ak-acct-method').value = a ? (a.login.method || '') : '';
  renderTotpPreview();
  try { q('ak-acct-email').focus(); } catch { /* ignore */ }
}
function renderTotpPreview() {
  const el = q('ak-acct-totp-preview');
  const raw = String(q('ak-acct-totp').value || '').trim();
  if (!raw) { el.textContent = ''; return; }
  const r = totpNow(raw);
  el.textContent = r.error ? '密钥格式不对：需要 base32（A-Z、2-7）或 otpauth:// 链接' : `当前动态码 ${r.code} · ${r.remaining}s 后刷新`;
}
async function saveAccountEditor({ login = false } = {}) {
  const fields = { label: q('ak-acct-label').value, email: q('ak-acct-email').value, password: q('ak-acct-password').value, totp: String(q('ak-acct-totp').value || '').trim(), auto: q('ak-acct-auto').checked, method: q('ak-acct-method').value || '' };
  if (fields.totp) {
    const parsed = parseOtpSecret(fields.totp);
    if (!parsed) { acctStatus('2FA 密钥格式不对：需要 base32（A-Z、2-7）或 otpauth:// 链接'); return; }
    if (!/^otpauth:/i.test(fields.totp)) fields.totp = parsed.secret;
    if (!fields.email && parsed.account && parsed.account.includes('@')) fields.email = parsed.account;
  }
  const r = upsertLogin(acct().accounts, state.acctEditId, fields);
  if (!r.account) { acctStatus('请至少填写邮箱或备注名'); return; }
  await acct().save(r.state);
  q('ak-acct-edit').hidden = true;
  state.acctEditId = null;
  acctStatus('登录信息已保存');
  if (login) {
    const a = acct().find(r.account.id);
    if (a) await acct().startLogin(a);
  }
}
async function copyTotp(id) {
  const a = acct().find(id);
  if (!a || !a.login.totp) return;
  const r = totpNow(a.login.totp);
  if (r.error) { acctStatus(r.error); return; }
  try { await globalThis.navigator.clipboard.writeText(r.code); acctStatus(`已复制动态码 ${r.code}（${r.remaining}s 内有效）`); } catch { acctStatus('复制失败，动态码: ' + r.code); }
}
async function fillLoginCode() {
  const code = String(q('ak-acct-code').value || '').trim();
  if (!code) { acctLoginStatus('请先输入验证码'); return; }
  await accountCall('fill', { code }).then(() => { acctLoginStatus('已把验证码填入页面'); q('ak-acct-code').value = ''; }).catch((e) => acctLoginStatus('填入失败: ' + (e && e.message || e)));
}

function accountRowHtml(a, active) {
  const label = accountLabel(a);
  const email = accountEmail(a);
  const sub = [
    email && email !== label ? email : '',
    hasSession(a) ? sessionAgeText(a) : (hasLogin(a) ? '未保存登录状态 · 可自动登录' : (a.email ? '未保存登录状态 · 「登录」会打开登录页并填好邮箱' : '未保存登录状态')),
    a.provider === 'google' ? 'Google 登录' : (a.provider ? a.provider + ' 登录' : ''),
  ].filter(Boolean).join(' · ');
  const avatar = a.avatar ? ` style="background-image:url(&quot;${esc(a.avatar)}&quot;)"` : '';
  const totp = a.login.totp
    ? `<div class="ak-acct-totp" data-totp-id="${esc(a.id)}"><span>2FA</span><b data-code>------</b><span class="ak-acct-left" data-left></span><button class="ak-link" data-acct="copy" data-id="${esc(a.id)}">复制</button></div>`
    : '';
  const badge = active ? ' <span class="ak-badge ak-badge-brand">当前</span>' : (!hasSession(a) ? ' <span class="ak-badge ak-badge-warn">需登录</span>' : '');
  const main = active ? '' : `<button class="ak-btn ak-btn-sm ${hasSession(a) ? 'ak-filled' : 'ak-tonal'}" data-acct="switch" data-id="${esc(a.id)}">${hasSession(a) ? '切换' : '登录'}</button>`;
  return `<div class="ak-acct" data-id="${esc(a.id)}" data-active="${active ? 'true' : 'false'}">`
    + `<span class="ak-acct-avatar"${avatar}>${a.avatar ? '' : esc(initialOf(a))}</span>`
    + `<div class="ak-acct-main"><div class="ak-acct-name">${esc(label)}${badge}</div><div class="ak-acct-sub">${esc(sub)}</div>${totp}</div>`
    + `<div class="ak-acct-actions">${main}<button class="ak-icon-btn" data-acct="edit" data-id="${esc(a.id)}" title="登录信息 / 2FA" aria-label="编辑">✎</button><button class="ak-icon-btn" data-acct="delete" data-id="${esc(a.id)}" title="删除" aria-label="删除">✕</button></div>`
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
      const shown = active || { id: '', label: '', name: snap.name, email: snap.email, avatar: snap.avatar, provider: snap.provider, cookies: snap.cookies || [], capturedAt: 0, login: { email: '', password: '', totp: '', auto: true } };
      const sub = [accountEmail(shown) !== accountLabel(shown) ? accountEmail(shown) : '', snap.provider === 'google' ? 'Google 登录' : (snap.provider || '')].filter(Boolean).join(' · ');
      cur.innerHTML = `<div class="ak-acct" data-id="${esc(shown.id)}" data-active="true"><span class="ak-acct-avatar"${shown.avatar ? ` style="background-image:url(&quot;${esc(shown.avatar)}&quot;)"` : ''}>${shown.avatar ? '' : esc(initialOf(shown))}</span>`
        + `<div class="ak-acct-main"><div class="ak-acct-name">${esc(accountLabel(shown))}${active ? '' : ' <span class="ak-badge ak-badge-warn">未保存</span>'}</div><div class="ak-acct-sub">${esc(sub)}</div></div></div>`;
    }
  }
  const scope = q('ak-acct-scope');
  if (scope) scope.textContent = snap && snap.scope ? ('Cookie 作用域 ' + (snap.scope === 'domain' ? '.arena.ai' : 'arena.ai')) : '';
  const count = q('ak-acct-count');
  if (count) count.textContent = st.list.length ? st.list.length + ' 个账号' : '';
  const list = q('ak-acct-list');
  if (list) list.innerHTML = st.list.length ? st.list.map((a) => accountRowHtml(a, a.id === st.activeId)).join('') : ACCT_EMPTY;
  renderTotpCodes();
}
function renderTotpCodes() {
  if (!state.acct) return;
  const now = Date.now();
  root.querySelectorAll('[data-totp-id]').forEach((el) => {
    const a = acct().find(el.dataset.totpId);
    const code = el.querySelector('[data-code]');
    const left = el.querySelector('[data-left]');
    if (!a || !code || !left) return;
    const r = totpNow(a.login.totp, now);
    if (r.error) { code.textContent = '无效密钥'; left.textContent = ''; return; }
    code.textContent = r.code.length === 6 ? r.code.slice(0, 3) + ' ' + r.code.slice(3) : r.code;
    left.textContent = r.remaining + 's';
    left.dataset.low = String(r.remaining <= 5);
  });
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
      else if (act === 'copy') copyTotp(id);
    });
  }
  const totpIn = q('ak-acct-totp');
  if (totpIn) totpIn.addEventListener('input', renderTotpPreview);
  const codeIn = q('ak-acct-code');
  if (codeIn) codeIn.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') fillLoginCode(); });
  renderAccounts();
}
// 1 s ticker for the live 2FA codes (only touches the DOM while the tab shows).
setInterval(() => {
  const edit = q('ak-acct-edit');
  if (root.querySelector('[data-page="account"][data-active="true"]')) { renderTotpCodes(); if (edit && !edit.hidden) renderTotpPreview(); }
}, 1000);

onPage('account-result', (r) => { if (state.accountRpc) state.accountRpc.deliver(r); });
onPage('account', (snap) => {
  // account.js checked the session the previous page handed over (restore
  // with navigate); anything but intact / rotated is worth a log line
  if (snap && snap.bootCheck && !/^(intact|rotated)$/.test(String(snap.bootCheck))) setStatus('账号会话核对: ' + snap.bootCheck);
  if (state.acct) acct().onSnapshot(snap);
});
onPage('login', (p) => {
  if (!p || typeof p !== 'object') return;
  acctLoginStatus(loginStageText(p.stage, p));
  if (p.stage === 'need-code') { showTab('account'); if (EMBED) EMBED.open(); }
  // the user must type on the page itself → get the sheet out of the way
  // the user must act on the page itself → get the sheet out of the way
  if (/^(need-password|need-email|need-totp|need-backup|need-phone|google-need-choice)$/.test(p.stage)) { setStatus(loginStageText(p.stage, p)); if (EMBED) EMBED.close(); }
  if (p.stage === 'error' || p.stage === 'wrong-account' || p.stage === 'google-blocked') { acctStatus(loginStageText(p.stage, p)); setStatus(loginStageText(p.stage, p)); }
});

// ── module: enhancement toggles + ENI ───────────────────────────────────
function wireControls() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'manager') {
        page('managerToggle');
        if (EMBED) EMBED.close();
      } else if (a === 'export-evidence') {
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
      } else if (a === 'rename-now') {
        renameNow();
      } else if (a === 'probe-start') {
        state.probeDraw = false;
        startProbe('probe');
      } else if (a === 'draw-start') {
        state.probeDraw = true;
        startProbe('draw');
      } else if (a === 'probe-stop') {
        if (state.probe?.stop()) probeLog('正在停止…');
      } else if (a === 'pulse-refresh') {
        refreshPulseNow();
      } else if (a === 'nav-back') {
        page('navBack');
      } else if (a === 'nav-forward') {
        page('navForward');
      } else if (a === 'nav-reload' || a === 'page-reload') {
        requestReload('panel');
      } else if (a === 'quick-send') {
        sessionProbe();
      } else if (a === 'cleanup-start') {
        startCleanup();
      } else if (a === 'cleanup-stop') {
        if (state.probe?.mode === 'cleanup' && state.probe.stop()) probeLog('正在停止清理…');
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
      } else if (a === 'acct-new') {
        openAccountEditor(null);
      } else if (a === 'acct-edit-save') {
        saveAccountEditor();
      } else if (a === 'acct-edit-login') {
        saveAccountEditor({ login: true });
      } else if (a === 'acct-edit-cancel') {
        q('ak-acct-edit').hidden = true;
        state.acctEditId = null;
      } else if (a === 'acct-fill-code') {
        fillLoginCode();
      } else if (a === 'acct-stop-login') {
        acct().stopLogin();
      }
    });
  });

  // Unlock / plus toggles → persist + set the page-side config. Both page
  // modules rewrite data while the page loads (unlock.js: the Next.js model
  // payload; plus.js: the leaderboard table), so the page is reloaded to
  // apply the change (requestReload asks first when a probe is running).
  const bind = (id, key, fn) => {
    q(id).checked = !!state.prefs[key];
    q(id).addEventListener('change', async (e) => {
      savePrefs({ [key]: e.target.checked });
      await fn(e.target.checked);
      requestReload('setting');
    });
  };
  bind('ak-unlock-opus', 'unlockOpus', (v) => page('unlockSet', 'opus', v));
  bind('ak-unlock-hidden', 'unlockHidden', (v) => page('unlockSet', 'hidden', v));
  bind('ak-plus', 'plus', (v) => page('plusSet', v));
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
  state.renameGate = createRenameGate(state.store);
  state.monitor = createReplyMonitor({ tracker: state.tracker });
  if (state.tauri) {
    pageActions = EMBED
      ? createPageActions({ win: globalThis })
      : createPageActions({ evalInPage: (js) => state.tauri.invoke('arena_command', { js }) });
  }
  state.rpc = state.tauri ? createRpc({ send: (action, argsJson, reqId) => pageActions('probeCall', action, argsJson, reqId) }) : null;
  state.accountRpc = state.tauri ? createRpc({ send: (action, argsJson, reqId) => pageActions('accountCall', action, argsJson, reqId) }) : null;
  await loadPrefs();
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
  wireProbe();
  wireCleanup();
  wireSessionProbe();
  wireAccounts();
  if (state.rpc) state.probe = createDockProbe();
  // Status-pill gestures (reference MainActivity): tap → panel (the shell
  // opens it itself), tap on ⟳ → reload, long press → quick menu (below),
  // pull-up at the bottom of the conversation → reload.
  if (EMBED && typeof EMBED.onAction === 'function') {
    const probeRunning = () => !!state.probe?.isRunning && state.probe.mode !== 'cleanup';
    const cleanupRunning = () => !!state.probe?.isRunning && state.probe.mode === 'cleanup';
    if (typeof EMBED.setMenuProvider === 'function') {
      EMBED.setMenuProvider(() => [
        { id: 'probe', label: probeRunning() ? '停止探针' : '开始探针' },
        { id: 'quick', label: '会话探针', disabled: probeRunning() || cleanupRunning() },
        { id: 'cleanup', label: cleanupRunning() ? '停止清理' : '清理算式标题' },
        { id: 'refresh', label: '刷新页面' },
        { id: 'account', label: '切换账号' },
        { id: 'panel', label: '打开面板' },
      ]);
    }
    EMBED.onAction((name, arg) => {
      const id = name === 'menu' ? arg : name;
      if (id === 'probe') {
        if (probeRunning()) { state.probe.stop(); probeLog('正在停止…'); return; }
        state.probeDraw = false;
        showTab('probe');
        startProbe('probe');
      } else if (id === 'cleanup') {
        if (cleanupRunning()) { state.probe.stop(); probeLog('正在停止清理…'); return; }
        showTab('tools');
        startCleanup();
      } else if (id === 'refresh') {
        requestReload('pill');
      } else if (id === 'pull-refresh') {
        requestReload('pull');
      } else if (id === 'quick') {
        showTab('probe');
        sessionProbe();
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
