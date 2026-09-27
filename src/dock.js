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
  if (p.stage === 'token') {
    state.current = { sessionId: p.sessionId, runId: p.runId || null };
    q('ak-model').textContent = '识别中…';
    sub.textContent = 'run ' + String(p.runId || '').slice(0, 14);
  } else if (p.stage === 'model') {
    const rec = sessionRecord(p.sessionId);
    const models = (p.models || []).filter((m) => m && typeof m.model === 'string' && m.model.trim())
      .map((m) => ({ model: m.model.slice(0, 200), provider: String(m.provider || '').slice(0, 100) }));
    if (models.length) rec.models = models;
    const usage = usageFromReport(p);
    if (usage) rec.runs = mergeUsage(rec.runs, usage);
    state.current = { sessionId: p.sessionId, runId: p.runId || null };
    q('ak-model').textContent = models.map((m) => m.model).join(' / ') || '未识别';
    const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))];
    const run = rec.runs.find((r) => r.runId === p.runId);
    sub.textContent = ['run ' + String(p.runId || '').slice(0, 14), providers.join(', '), completion(run?.spans || [])].filter(Boolean).join(' · ');
    renderUsage();
  } else if (p.stage === 'error' && p.fatal) {
    q('ak-model-sub').textContent = p.status || '错误';
  }
  if (p.status) setStatus(p.status);
}

// ── module: Token / trace cost ──────────────────────────────────────────
function allRuns() {
  const out = [];
  for (const rec of state.sessions.values()) out.push(...rec.runs);
  return out;
}
function renderUsage() {
  const { sessionId, runId } = state.current;
  const rec = sessionId ? state.sessions.get(sessionId) : null;
  const run = rec?.runs.find((r) => r.runId === runId) || null;
  q('ak-usage-run').textContent = formatUsage(run ? summarizeUsage([run]) : null);
  const st = rec ? summarizeUsage(rec.runs) : null;
  q('ak-usage-session').textContent = st && st.spanCount ? formatUsage(st) + ` · ${st.runCount} 轮` : '未提供';
  const tt = summarizeUsage(allRuns());
  q('ak-usage-total').textContent = tt.spanCount ? formatUsage(tt) + ` · ${tt.runCount} 轮 / ${state.sessions.size} 会话` : '未提供';
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

// ── module: navigation (restore per-conversation display) ───────────────
onPage('nav', (n) => {
  if (!n || typeof n !== 'object') return;
  const switched = n.sessionId !== state.nav.sessionId;
  state.nav = { sessionId: n.sessionId || null, path: n.path || '/', title: n.title || '' };
  q('ak-session').textContent = state.nav.sessionId ? '会话 ' + state.nav.sessionId.slice(0, 8) + '…' : (n.agentPath ? '新对话' : n.path || '');
  if (state.nav.sessionId && state.sessions.has(state.nav.sessionId)) sessionRecord(state.nav.sessionId).title = state.nav.title;
  if (switched && !state.nav.sessionId) {
    // Fresh /agent composer: nothing identified yet for this conversation.
    state.current = { sessionId: null, runId: null };
    q('ak-model').textContent = '—';
    q('ak-model-sub').textContent = '发一条消息后自动识别';
    renderUsage();
  } else if (switched && state.sessions.has(state.nav.sessionId)) {
    // Back to a conversation seen this session: show its last run again.
    const rec = state.sessions.get(state.nav.sessionId);
    const last = rec.runs.at(-1);
    state.current = { sessionId: state.nav.sessionId, runId: last?.runId || null };
    q('ak-model').textContent = rec.models.map((m) => m.model).join(' / ') || '—';
    q('ak-model-sub').textContent = last ? 'run ' + last.runId.slice(0, 14) + ' · ' + completion(last.spans) : '';
    renderUsage();
  }
});

// ── module: enhancement toggles + ENI ───────────────────────────────────
function wireControls() {
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'manager') {
        arenaCmd('window.__AK_MANAGER_TOGGLE__ && window.__AK_MANAGER_TOGGLE__()');
      } else if (a === 'export-evidence') {
        exportCurrentEvidence();
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
  await loadPrefs();
  wireControls();
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
