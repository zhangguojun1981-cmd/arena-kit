/* ArenaKit native side dock logic.
 * Runs in its own webview. Talks to Rust via Tauri IPC (window.__TAURI__), and
 * to the arena.ai webview via Rust commands (arena_command evals into the page;
 * the page answers through page_event → "arenakit://page").
 *
 * Structure: one listener per Rust event, a name→handler map for page events,
 * and small feature modules below. Pure logic lives in ./lib (unit-tested with
 * node:test); this file only wires DOM + IPC. */

import { getTauri, createStore, jsString } from './lib/tauri-api.js';
import { usageFromReport, mergeUsage, summarizeUsage, formatUsage, formatTokens, formatMoney, completion, exportEvidence } from './lib/usage.js';
import { createHistoryStore, recordModels, recordTurns, searchRecords, grandTotals, exportHistory } from './lib/history.js';
import { createTurnTracker } from './lib/turns.js';
import { createRpc } from './lib/rpc.js';
import { buildTitle, sanitizePrefix, createRenameGate } from './lib/rename.js';
import { parseTargets, DEFAULT_TARGETS } from './lib/probe-logic.js';
import { createProbeController } from './lib/probe-runner.js';
import { sessionProbePrecheck, sessionProbeText, awaitTurnModel } from './lib/session-probe.js';

const q = (id) => document.getElementById(id);
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
  tracker: createTurnTracker(), // per-conversation turn → model (Android TurnTracker port)
  turnHead: '',             // latest "第 N 轮 · …" headline from tracker.record()
  history: null,            // createHistoryStore()
  historyIndex: new Map(),  // sessionId → record (mirror of the store, newest first on render)
  historyCarry: null,       // evicted totals bucket
  rpc: null,                // createRpc() — dock → page probe.js actions
  renameGate: null,         // createRenameGate() — auto-rename once per conversation
  renaming: false,          // a rename dialog is being driven right now
  probe: null,              // createProbeController() — auto probe / cleanup / quick send
  quickBusy: false,         // a session probe is in flight
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
};

// ── page event routing (arena page → dock) ──────────────────────────────
const pageHandlers = new Map();
const onPage = (name, fn) => pageHandlers.set(name, fn);

// Send a command into the arena.ai page webview via Rust.
function arenaCmd(js) {
  if (!state.tauri) return Promise.resolve();
  return state.tauri.invoke('arena_command', { js }).catch((e) => setStatus('命令失败: ' + e));
}
// dock → page bus (bridge.js dispatch).
function dispatchToPage(name, payload) {
  return arenaCmd(`window.__ARENAKIT__&&window.__ARENAKIT__.dispatch(${jsString(name)},${JSON.stringify(payload ?? null)})`);
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
    // A fresh run token = a new turn; a different session = conversation switch.
    const { turn, switched, repeat } = tracker.onToken(p.sessionId, p.runId || '');
    if (switched) { sessionRecord(p.sessionId).historical = false; state.turnHead = ''; }
    if (!repeat) q('ak-model').textContent = '识别中…';
    q('ak-model').dataset.routed = 'false';
    sub.textContent = `第 ${turn} 轮 · run ` + String(p.runId || '').slice(0, 14);
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
    q('ak-model').textContent = models.map((m) => m.model).join(' / ') || '未识别';
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
    q('ak-model').dataset.routed = String(!!tracker.routed);
    sub.textContent = ['run ' + String(p.runId || '').slice(0, 14), providers.join(', '), completion(run?.spans || [])].filter(Boolean).join(' · ');
    if (head) state.turnHead = head.split('\n')[0];
    renderTurns();
    renderUsage();
  } else if (p.stage === 'error' && p.fatal) {
    q('ak-model-sub').textContent = p.status || '错误';
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
function renderUsage() {
  const { sessionId, runId } = state.current;
  const rec = sessionId ? state.sessions.get(sessionId) : null;
  const run = rec?.runs.find((r) => r.runId === runId) || null;
  q('ak-usage-run').textContent = formatUsage(run ? summarizeUsage([run]) : null);
  const st = rec ? summarizeUsage(rec.runs) : null;
  q('ak-usage-session').textContent = st && st.spanCount ? formatUsage(st) + ` · ${st.runCount} 轮` : '未提供';
  const tt = grandTotals([...state.historyIndex.values()], state.historyCarry);
  q('ak-usage-total').textContent = tt.spanCount ? formatUsage(tt) + ` · ${tt.runCount} 轮 / ${tt.sessions} 会话` : (tt.sessions ? `${tt.sessions} 会话 · 无用量标签` : '未提供');
  const calls = run?.spans || [];
  q('ak-usage-calls').innerHTML = calls.map((c) => {
    const flags = [c.partial === true ? '<span class="ak-flag">进行中</span>' : '', c.error === true ? '<span class="ak-err">报错</span>' : '', c.cancelled === true ? '<span class="ak-flag">已取消</span>' : ''].filter(Boolean).join(' ');
    return `<div class="ak-call"><span>${esc(c.model || '未知模型')}${c.provider ? ' <span class="ak-sub">' + esc(c.provider) + '</span>' : ''}</span><span>${esc(formatTokens(c.tokens, c.tokensApproximate))} · ${esc(formatMoney(c.costUsd))} ${flags}</span></div>`;
  }).join('') + (calls.length ? `<div class="ak-sub">共 ${calls.length} 次模型调用 · 仅统计 trace 标签，不推算价格</div>` : '');
}
async function exportCurrentEvidence() {
  const { sessionId } = state.current;
  const rec = sessionId ? state.sessions.get(sessionId) : null;
  if (!rec || !rec.runs.length) { setStatus('当前会话还没有可导出的记录'); return; }
  const text = JSON.stringify(exportEvidence({ sessionId, title: rec.title || state.nav.title, runs: rec.runs }), null, 2);
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
function renderHistory() {
  const rows = searchRecords(historyRows(), q('ak-history-q').value).slice(0, 60);
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
      <div class="ak-item-actions"><button class="ak-link" data-open="${esc(r.sessionId)}">打开</button><button class="ak-link ak-danger" data-del="${esc(r.sessionId)}">删除</button></div>
    </div>`;
  }).join('') || '<div class="ak-sub">暂无记录：识别到模型后自动保存（仅本机）</div>';
  const total = state.historyIndex.size;
  q('ak-history-sub').textContent = total ? `共 ${total} 个会话${rows.length < total ? `，显示 ${rows.length}` : ''} · 仅保存会话→模型与用量标签` : '';
}
function wireHistory() {
  q('ak-history-q').addEventListener('input', renderHistory);
  q('ak-history-list').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-del]');
    if (open) {
      const sid = open.dataset.open;
      arenaCmd(`location.assign(${jsString('https://arena.ai/agent/' + sid)})`);
    } else if (del && state.history) {
      const sid = del.dataset.del;
      await state.history.remove(sid).catch((err) => setStatus('删除失败: ' + err));
      state.historyIndex.delete(sid);
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
    q('ak-model').textContent = '—';
    q('ak-model').dataset.routed = 'false';
    q('ak-model-sub').textContent = '发一条消息后自动识别';
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
    q('ak-model').textContent = rec.models.map((m) => m.model).join(' / ') || '—';
    q('ak-model').dataset.routed = 'false';
    q('ak-model-sub').textContent = [last ? 'run ' + last.runId.slice(0, 14) : '', last ? completion(last.spans) : '', rec.historical ? '本地记录 · 非重新验证' : ''].filter(Boolean).join(' · ');
    renderUsage();
  } else if (switched) {
    state.current = { sessionId: state.nav.sessionId, runId: null };
    state.tracker.reset(state.nav.sessionId);
    q('ak-model').textContent = '—';
    q('ak-model').dataset.routed = 'false';
    q('ak-model-sub').textContent = '此对话尚无本地记录';
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
  document.querySelector('[data-action="probe-start"]').disabled = running;
  document.querySelector('[data-action="probe-stop"]').disabled = !running;
  document.querySelector('[data-action="probe-stop"]').textContent = running ? `停止${what}` : '停止';
}

async function startProbe() {
  if (!state.probe) { probeLog('无 Tauri 运行时'); return; }
  if (state.probe.isRunning) { probeLog(state.probe.mode === 'cleanup' ? '清理进行中，请先停止' : '探针已在运行'); return; }
  await persistProbePanel();
  const cfg = probeConfigFromPanel();
  if (!cfg.targets.length) { probeLog('请填写至少一个目标'); return; }
  q('ak-probe-log').textContent = '';
  setProbeRunningUi(true);
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
  document.querySelector('[data-action="cleanup-start"]').disabled = running;
  document.querySelector('[data-action="cleanup-stop"]').disabled = !running;
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
    onProgress: probeLog,
    onFinished: (summary) => {
      probeLog(summary);
      if (/^清理|^没有需要归档/.test(summary)) q('ak-cleanup-state').textContent = summary;
      else q('ak-probe-state').textContent = summary;
    },
    onProbeState: (round, max, hits, active) => {
      q('ak-probe-state').textContent = active ? `探针运行中 · 第 ${round}/${max} 轮 · 命中 ${hits}` : (q('ak-probe-state').textContent || '');
    },
    onCleanupState: (archived, active) => {
      q('ak-cleanup-state').textContent = active ? `清理中 · 已归档 ${archived}` : `上次清理已归档 ${archived}`;
    },
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

// ── module: session probe (send into the OPEN conversation, identify this turn)
const quickState = (t) => { q('ak-quick-state').textContent = t; };
async function sessionProbe() {
  if (!state.probe || !state.rpc) { quickState('无 Tauri 运行时'); return; }
  if (state.quickBusy) { quickState('上一条探针仍在等待识别…'); return; }
  state.quickBusy = true;
  const btn = document.querySelector('[data-action="quick-send"]');
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
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'manager') {
        arenaCmd('window.__AK_MANAGER_TOGGLE__ && window.__AK_MANAGER_TOGGLE__()');
      } else if (a === 'export-evidence') {
        exportCurrentEvidence();
      } else if (a === 'history-export') {
        exportAllHistory();
      } else if (a === 'history-clear') {
        clearHistory(el);
      } else if (a === 'rename-now') {
        renameNow();
      } else if (a === 'probe-start') {
        startProbe();
      } else if (a === 'probe-stop') {
        if (state.probe?.stop()) probeLog('正在停止…');
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
        arenaCmd(`window.__AK_ENI_SET__ && window.__AK_ENI_SET__(${eniOn}, ${jsString(eniText)})`);
        setStatus('提示词已保存');
      }
    });
  });

  // Unlock / plus toggles → persist + set the page-side config.
  const bind = (id, key, fn) => {
    q(id).checked = !!state.prefs[key];
    q(id).addEventListener('change', (e) => { savePrefs({ [key]: e.target.checked }); fn(e.target.checked); });
  };
  bind('ak-unlock-opus', 'unlockOpus', (v) => arenaCmd(`window.__AK_UNLOCK_SET__ && window.__AK_UNLOCK_SET__('opus', ${v})`));
  bind('ak-unlock-hidden', 'unlockHidden', (v) => arenaCmd(`window.__AK_UNLOCK_SET__ && window.__AK_UNLOCK_SET__('hidden', ${v})`));
  bind('ak-plus', 'plus', (v) => arenaCmd(`window.__AK_PLUS_SET__ && window.__AK_PLUS_SET__(${v})`));
  q('ak-eni-on').checked = !!state.prefs.eniOn;
  q('ak-eni-text').value = state.prefs.eniText || '';
}

// ── boot ────────────────────────────────────────────────────────────────
document.querySelectorAll('.ak-mod-head').forEach((h) => {
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
  state.rpc = state.tauri ? createRpc({ evalInPage: (js) => state.tauri.invoke('arena_command', { js }) }) : null;
  await loadPrefs();
  wireControls();
  wireHistory();
  wireRename();
  wireProbe();
  wireCleanup();
  wireSessionProbe();
  if (state.rpc) state.probe = createDockProbe();
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
  setStatus('就绪');
}

boot();

export { state, arenaCmd, dispatchToPage, onPage, esc };
