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

// Embedded (Android) mode: the dock markup lives in a shadow root inside the
// arena page; otherwise this is the dock webview's own document.
const EMBED = globalThis.__ARENAKIT_EMBED__ && globalThis.__ARENAKIT_EMBED__.root ? globalThis.__ARENAKIT_EMBED__ : null;
const root = EMBED ? EMBED.root : document;
const q = (id) => root.getElementById(id);
const setStatus = (t) => { q('ak-status').textContent = t; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  tauri: null,
  store: null,
  nav: { sessionId: null, path: '/', title: '' },
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
  hud: { model: '', routed: false, status: '', busy: null, busyTimer: 0, alertTimer: 0 }, // header + floating-ball display state
};

function sessionRecord(sessionId) {
  if (!state.sessions.has(sessionId)) state.sessions.set(sessionId, { runs: [], models: [], title: '' });
  return state.sessions.get(sessionId);
}

const DEFAULT_PREFS = {
  unlockOpus: true,
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

// ── HUD header (reference panel top: model · status · pulse) ────────────
/* Every place that learns something about the current conversation's model
 * goes through here, so the header, the 服务端模型 module and (on Android)
 * the floating ball never disagree. `known` false = placeholder text. */
function setModelDisplay(text, { routed = false, known = true } = {}) {
  const t = String(text || '');
  const big = q('ak-model');
  big.textContent = known ? t : (t || '—');
  big.dataset.routed = String(!!routed);
  const hud = q('ak-hud-model');
  hud.textContent = known && t ? t : '模型待确认';
  hud.dataset.known = String(!!(known && t));
  hud.dataset.routed = String(!!routed);
  state.hud.model = known && t ? t : '';
  state.hud.routed = !!routed;
  if (EMBED && typeof EMBED.setBall === 'function') renderBall();
}
function setHudStatus(text) {
  state.hud.status = String(text || '');
  q('ak-hud-status').textContent = state.hud.status;
}
/* Floating-ball payload (embedded only): ring = quota %, centre = quota % and/or
 * the model, per prefs.ballCenter; a transient (probe / cleanup) owns the centre
 * while state.hud.busy is set. */
function renderBall() {
  if (!EMBED || typeof EMBED.setBall !== 'function') return;
  const v = state.pulse.view();
  const percent = v.percent;
  const b = state.hud.busy;
  if (b) { EMBED.setBall({ percent, band: v.band, top: b.top, bottom: b.bottom, isModel: false, routed: false }); return; }
  const mode = state.prefs.ballCenter || 'percent-model';
  const pct = percent === null ? '…' : percent + '%';
  const model = state.hud.model;
  const short = shortModel(model);
  if (mode === 'model' && model) {
    EMBED.setBall({ percent, band: v.band, top: short.top, bottom: short.bottom, isModel: true, routed: state.hud.routed });
  } else if (mode === 'percent' || !model) {
    EMBED.setBall({ percent, band: v.band, top: pct, bottom: '', isModel: false, routed: false });
  } else {
    // percent on top, one model line below: the whole id when short, else the name part
    const both = short.top + (short.bottom ? ' ' + short.bottom : '');
    EMBED.setBall({ percent, band: v.band, top: pct, bottom: both.length <= 12 ? both : short.top, isModel: true, routed: state.hud.routed });
  }
}
/* "claude-opus-4-8" → {top:"claude-opus", bottom:"4-8"}; "gpt-4o" → {top:"gpt", bottom:"4o"}
 * (reference applyBallModel: split at the first numeric token, ≤ 12 chars a line). */
function shortModel(model) {
  const id = String(model || '').split(' / ')[0].trim();
  if (!id) return { top: '', bottom: '' };
  const parts = id.split(/[-_ /]+/).filter(Boolean);
  const v = parts.findIndex((x) => /^\d/.test(x));
  const clip = (x) => (x.length > 12 ? x.slice(0, 11) + '…' : x);
  if (v <= 0) return { top: clip(id), bottom: '' };
  return { top: clip(parts.slice(0, v).join('-')), bottom: clip(parts.slice(v).join('-')) };
}
/* Briefly show a two-line status in the ball centre (reference flashBall). */
function flashBall(top, bottom, ms = 2500) {
  state.hud.busy = { top, bottom };
  renderBall();
  clearTimeout(state.hud.busyTimer);
  state.hud.busyTimer = setTimeout(() => { state.hud.busy = null; renderBall(); }, ms);
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
  const sub = q('ak-model-sub');
  const tracker = state.tracker;
  if (p.stage === 'token') {
    state.current = { sessionId: p.sessionId, runId: p.runId || null };
    // A new run supersedes any picked run of the live conversation (extension: selectedRunId reset).
    if (!state.view.sessionId || state.view.sessionId === p.sessionId) state.view = { sessionId: null, runId: null };
    // A fresh run token = a new turn; a different session = conversation switch.
    const { turn, switched, repeat } = tracker.onToken(p.sessionId, p.runId || '');
    if (switched) { sessionRecord(p.sessionId).historical = false; state.turnHead = ''; }
    if (!repeat) setModelDisplay('识别中…', { known: false });
    sub.textContent = `第 ${turn} 轮 · run ` + String(p.runId || '').slice(0, 14);
    setHudStatus(`第 ${turn} 轮 · 已截获令牌，正在识别模型…`);
    renderTurns();
  } else if (p.stage === 'poll') {
    const turn = tracker.turnOf(p.runId);
    if (turn) tracker.setStatus(turn, `读取中 ${p.attempt || ''}/${p.max || ''}`.trim());
    renderTurns();
  } else if (p.stage === 'error') {
    const turn = tracker.turnOf(p.runId);
    if (turn) { tracker.setStatus(turn, p.fatal ? '失败' : '未识别'); if (p.fatal) tracker.mark(turn, 'trace-error', '读取失败'); }
    renderTurns();
  } else if (p.stage === 'done') {
    const turn = tracker.turnOf(p.runId);
    if (turn) { const e = tracker.turns.find((x) => x.turn === turn); if (e && e.model) tracker.setStatus(turn, '完成'); }
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
    if (models.length) saveHistory(p.sessionId, p.runId, models, usage);
    const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))];
    const run = rec.runs.find((r) => r.runId === p.runId);
    if (models.length && p.complete) maybeAutoRename(p.sessionId, models[0].model, run);
    // Per-turn model resolution (routed = differs from this conversation's first model).
    let turn = tracker.turnOf(p.runId);
    if (!turn && models.length) turn = tracker.onToken(p.sessionId, p.runId || '').turn; // model without a seen token stage
    let head = '';
    if (turn && models.length) {
      head = tracker.record(turn, models[0].model, models.map((m) => m.model));
      if (!p.complete) tracker.setStatus(turn, completion(run?.spans || []));
      else tracker.setStatus(turn, run?.spans?.length ? completion(run.spans) : '已识别');
    }
    setModelDisplay(models.map((m) => m.model).join(' / '), { routed: !!tracker.routed, known: models.length > 0 });
    if (!models.length) q('ak-model').textContent = '未识别';
    sub.textContent = ['run ' + String(p.runId || '').slice(0, 14), providers.join(', '), completion(run?.spans || [])].filter(Boolean).join(' · ');
    if (head) state.turnHead = head.split('\n')[0];
    setHudStatus(head ? head.split('\n')[0] : (turn ? `第 ${turn} 轮 · trace 未包含模型标签；不猜测模型` : 'trace 未包含模型标签；不猜测模型'));
    renderTurns();
    renderUsage();
  } else if (p.stage === 'error' && p.fatal) {
    q('ak-model-sub').textContent = p.status || '错误';
  }
  if (p.stage === 'error') {
    const turn = tracker.turnOf(p.runId);
    setHudStatus((turn ? `第 ${turn} 轮 · ` : '') + (p.status || '读取失败'));
  }
  if (p.status) setStatus(p.status);
}

// ── module: turns (per-turn model timeline) ─────────────────────────────
function renderTurns() {
  const t = state.tracker;
  const list = q('ak-turn-list');
  if (!t.turns.length) { list.innerHTML = ''; q('ak-turn-head').textContent = ''; state.turnHead = ''; return; }
  q('ak-turn-head').textContent = [state.turnHead, t.historyLine()].filter(Boolean).join('\n');
  list.innerHTML = t.turns.slice(-12).map((e) => {
    const marks = e.marks.map((m) => `<span class="ak-badge ${/error|fail|empty|trunc/.test(m.kind) ? 'ak-badge-err' : 'ak-badge-warn'}">${esc(m.label)}</span>`).join('');
    const routed = e.routed ? '<span class="ak-badge ak-badge-warn">非首轮模型</span>' : '';
    return `<div class="ak-turn"><span class="ak-turn-n">R${e.turn}</span><span class="ak-turn-m${e.routed ? ' ak-routed' : ''}">${esc(e.models.join(' / ') || e.model || '—')}${routed}${marks}</span><span class="ak-turn-s">${esc(e.status || '')}</span></div>`;
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
async function saveHistory(sessionId, runId, models, usage) {
  if (!state.history) return;
  const title = state.nav.sessionId === sessionId ? state.nav.title : undefined;
  try {
    const turn = state.tracker.sessionId === sessionId ? state.tracker.turnOf(runId) : undefined;
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
    const cur = r.sessionId === state.nav.sessionId ? ' ak-current' : '';
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

onPage('nav', (n) => {
  if (!n || typeof n !== 'object') return;
  const switched = n.sessionId !== state.nav.sessionId;
  state.nav = { sessionId: n.sessionId || null, path: n.path || '/', title: n.title || '' };
  q('ak-session').textContent = state.nav.sessionId ? '会话 ' + state.nav.sessionId.slice(0, 8) + '…' : (n.agentPath ? '新对话' : n.path || '');
  if (state.nav.sessionId && state.sessions.has(state.nav.sessionId)) sessionRecord(state.nav.sessionId).title = state.nav.title;
  if (switched) { renderHistory(); renderRenamePreview(); }
  if (switched && !state.nav.sessionId) {
    // Fresh /agent composer: nothing identified yet for this conversation.
    // (Best-effort reset; the next token's session id is the authoritative one.)
    state.current = { sessionId: null, runId: null };
    state.tracker.reset();
    setModelDisplay('', { known: false });
    q('ak-model-sub').textContent = '发一条消息后自动识别';
    setHudStatus('等待会话流…');
    renderTurns();
    renderUsage();
  } else if (switched && state.nav.sessionId === state.tracker.sessionId) {
    // Same conversation the tracker is already following (e.g. URL caught up
    // after the token) — keep the live turn state.
    state.current = { sessionId: state.nav.sessionId, runId: state.current.runId };
  } else if (switched && (state.sessions.has(state.nav.sessionId) || restoreFromHistory(state.nav.sessionId))) {
    // Back to a known conversation: show its remembered model (local record,
    // not re-verified) until a new turn produces a fresh trace.
    const rec = state.sessions.get(state.nav.sessionId);
    const last = rec.runs.at(-1);
    state.current = { sessionId: state.nav.sessionId, runId: last?.runId || null };
    const record = state.historyIndex.get(state.nav.sessionId);
    if (record) rebuildTrackerFromRecord(state.nav.sessionId, record); else { state.tracker.reset(state.nav.sessionId); renderTurns(); }
    setModelDisplay(rec.models.map((m) => m.model).join(' / '), { known: rec.models.length > 0 });
    q('ak-model-sub').textContent = [last ? 'run ' + last.runId.slice(0, 14) : '', last ? completion(last.spans) : '', rec.historical ? '本地记录 · 非重新验证' : ''].filter(Boolean).join(' · ');
    setHudStatus(rec.historical ? '已恢复本地记录的模型（非重新验证）' : (state.turnHead || '本次运行已识别'));
    renderUsage();
  } else if (switched) {
    state.current = { sessionId: state.nav.sessionId, runId: null };
    state.tracker.reset(state.nav.sessionId);
    setModelDisplay('', { known: false });
    q('ak-model-sub').textContent = '此对话尚无本地记录';
    setHudStatus('此对话尚无本地记录 · 发一条消息后识别');
    renderTurns();
    renderUsage();
  }
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
    modelForSession: (sid) => (state.sessions.get(sid)?.models || []).map((m) => m.model),
    // Extension acquire.js parity: show which stage the capture is in while waiting.
    stageForSession: (sid) => {
      if (state.tracker.sessionId !== sid) return '截获会话流，等待运行令牌';
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
      // Reference ball transient: "R2/5" + "命中1" while running, "探针完" for 3 s after.
      if (EMBED) {
        if (typeof EMBED.setBusy === 'function') EMBED.setBusy('probe', active);
        if (active) { clearTimeout(state.hud.busyTimer); state.hud.busy = { top: `R${round}/${max}`, bottom: (draw ? '识别' : '命中') + hits }; renderBall(); }
        else flashBall(draw ? '抽卡完' : '探针完', (draw ? '识别' : '命中') + hits, 3000);
      }
    },
    onCleanupState: (archived, active) => {
      q('ak-cleanup-state').textContent = active ? `清理中 · 已归档 ${archived}` : `上次清理已归档 ${archived}`;
      if (EMBED) {
        if (typeof EMBED.setBusy === 'function') EMBED.setBusy('cleanup', active);
        if (active) { clearTimeout(state.hud.busyTimer); state.hud.busy = { top: '清理', bottom: String(archived) }; renderBall(); }
        else flashBall('已归档', String(archived), 3000);
      }
    },
    // Extension parity: an archived probe chat also loses its local record.
    onArchived: (sid) => { dropLocalRecord(sid).catch(() => {}); },
    buildTitle: (model, suffix) => buildTitle({ prefix: state.prefs.renamePrefix, model, suffix }),
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
  q('ak-hud-pulse').textContent = v.text;
  q('ak-hud-pulse').classList.toggle('ak-warn', !!v.error);
  if (EMBED) renderBall();
}
onPage('pulse', (ev) => { state.pulse.ingest(ev); renderPulse(); });
setInterval(renderPulse, 1000);

// ── module: reply monitor (stream anomaly badges) ───────────────────────
function renderMonitor() {
  const m = state.monitor;
  if (!m) return;
  const entries = m.entries.slice().reverse();
  const head = q('ak-monitor-head');
  const last = m.last;
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
  if (!state.monitor) return;
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

// ── module: session probe (send into the OPEN conversation, identify this turn)
const quickState = (t) => { q('ak-quick-state').textContent = t; };
async function sessionProbe() {
  if (!state.probe || !state.rpc) { quickState('无 Tauri 运行时'); return; }
  if (state.quickBusy) { quickState('上一条探针仍在等待识别…'); return; }
  state.quickBusy = true;
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
    if (EMBED) flashBall('探针', '发送中', 2500);
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
  const rec = state.sessions.get(sessionId);
  const live = rec?.models?.[0]?.model;
  if (live) return live;
  return state.historyIndex.get(sessionId)?.models?.[0]?.model || '';
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
  if (state.nav.sessionId !== sessionId) return;              // only the conversation on screen
  if (run?.spans?.some((sp) => sp.partial)) return;           // wait for the usage to settle
  if (autoRenameSeen.has(sessionId)) return;
  autoRenameSeen.add(sessionId);
  let title;
  try { title = buildTitle({ prefix: state.prefs.renamePrefix, model }); } catch (e) { renameStatus(String(e.message || e)); return; }
  if (state.nav.title && state.nav.title.trim() === title) return; // already named
  try {
    if (!(await state.renameGate.claim(sessionId))) return;     // renamed (or tried) in an earlier session
    await renameConversation(sessionId, title, { reason: '自动' });
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
        dispatchToPage('pulse-refresh', null);
        setStatus('已请求刷新额度');
      } else if (a === 'nav-back') {
        page('navBack');
      } else if (a === 'nav-forward') {
        page('navForward');
      } else if (a === 'nav-reload') {
        page('reload');
        if (EMBED) EMBED.close();
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
      }
    });
  });

  // Unlock / plus toggles → persist + set the page-side config.
  const bind = (id, key, fn) => {
    q(id).checked = !!state.prefs[key];
    q(id).addEventListener('change', (e) => { savePrefs({ [key]: e.target.checked }); fn(e.target.checked); });
  };
  bind('ak-unlock-opus', 'unlockOpus', (v) => page('unlockSet', 'opus', v));
  bind('ak-unlock-hidden', 'unlockHidden', (v) => page('unlockSet', 'hidden', v));
  bind('ak-plus', 'plus', (v) => page('plusSet', v));
  q('ak-eni-on').checked = !!state.prefs.eniOn;
  q('ak-eni-text').value = state.prefs.eniText || '';
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
  await loadPrefs();
  wireTheme();
  wireControls();
  wireUsageView();
  wireHistory();
  wireRename();
  wireProbe();
  wireCleanup();
  wireSessionProbe();
  if (state.rpc) state.probe = createDockProbe();
  // Floating-ball gestures (reference MainActivity): radial dock buttons, long
  // press = 会话探针 quick send, double tap = panel (the shell opens it itself).
  if (EMBED && typeof EMBED.onAction === 'function') {
    EMBED.onAction((name) => {
      if (name === 'probe') {
        if (state.probe?.isRunning && state.probe.mode !== 'cleanup') { state.probe.stop(); probeLog('正在停止…'); return; }
        state.probeDraw = false;
        startProbe('probe');
      } else if (name === 'cleanup') {
        if (state.probe?.isRunning && state.probe.mode === 'cleanup') { state.probe.stop(); probeLog('正在停止清理…'); return; }
        startCleanup();
      } else if (name === 'refresh') {
        page('reload');
      } else if (name === 'quick') {
        sessionProbe();
      }
    });
  }
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
  setStatus(EMBED ? '就绪（内嵌模式）' : '就绪');
}

boot();

export { state, page, dispatchToPage, onPage, esc };
