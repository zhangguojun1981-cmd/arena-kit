/* ArenaKit native side dock.
 *
 * Runs in its own (local-origin) webview. Talks to Rust over Tauri IPC
 * (`window.__TAURI__`, enabled by `app.withGlobalTauri`) and reaches the
 * arena.ai page only through the `arena_command` command, which evals into
 * the page webview where `injected/bootstrap.js` exposes `window.__ARENAKIT__`.
 *
 * Outside Tauri (plain browser) the dock runs in preview mode with sample data
 * so the design can be reviewed in isolation.
 */
import {
  charCount,
  creditBand,
  creditPercent,
  describeModels,
  formatReset,
  nextThemeMode,
  pushRecent,
  relativeTime,
  formatUsage,
  resolveTheme,
  shortRun,
  shortSession,
  themeLabel,
  turnHeadline,
  turnHistoryLine,
} from './lib/format.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — ignore */
    }
  },
};

// ── theme ────────────────────────────────────────────────────────────────
const themeBtn = $('theme-btn');
const mq = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = store.get('ak_theme_mode', localStorage.getItem('ak_theme') || 'system');

function applyTheme() {
  const html = document.documentElement;
  if (themeMode === 'system') delete html.dataset.theme;
  else html.dataset.theme = themeMode;
  themeBtn.dataset.mode = themeMode;
  themeBtn.title = themeLabel(themeMode);
  // Keep the pre-paint snippet in shell.html in sync.
  try {
    if (themeMode === 'system') localStorage.removeItem('ak_theme');
    else localStorage.setItem('ak_theme', themeMode);
  } catch {
    /* ignore */
  }
  store.set('ak_theme_mode', themeMode);
  const effective = resolveTheme(themeMode, mq.matches);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', effective);
}
themeBtn.addEventListener('click', () => {
  themeMode = nextThemeMode(themeMode);
  applyTheme();
});
mq.addEventListener?.('change', applyTheme);
applyTheme();

// ── collapsible cards (state persisted) ──────────────────────────────────
const sections = store.get('ak_sections', {});
document.querySelectorAll('.card[data-section]').forEach((card) => {
  const key = card.dataset.section;
  if (key in sections) card.dataset.open = sections[key] ? 'true' : 'false';
  const head = card.querySelector('.card-head');
  head.setAttribute('aria-expanded', card.dataset.open === 'true');
  head.addEventListener('click', () => {
    const open = card.dataset.open !== 'true';
    card.dataset.open = open ? 'true' : 'false';
    head.setAttribute('aria-expanded', String(open));
    sections[key] = open;
    store.set('ak_sections', sections);
  });
});

// ── small UI helpers ─────────────────────────────────────────────────────
let toastTimer = 0;
export function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

export function setStatus(text, tone = '') {
  const el = $('status');
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setConn(state, text) {
  const pill = $('conn');
  pill.dataset.state = state;
  $('conn-text').textContent = text;
}

// ── model card ───────────────────────────────────────────────────────────
let recent = store.get('ak_recent', []);
let lastModel = '';

function renderRecent() {
  const ul = $('recent');
  const items = recent.filter((r) => r && r.name && r.name !== lastModel).slice(0, 4);
  ul.hidden = items.length === 0;
  ul.innerHTML = '';
  const now = Date.now();
  for (const r of items) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = r.name;
    b.title = r.name;
    const span = document.createElement('span');
    span.textContent = relativeTime(r.at, now);
    li.append(b, span);
    ul.appendChild(li);
  }
}

function showModels(payload, opts = {}) {
  const info = describeModels(payload?.models);
  const block = $('model-block');
  if (!info.name) {
    block.dataset.empty = 'true';
    $('model-name').textContent = payload && !payload.cleared ? '未识别' : '—';
    $('model-provider').textContent = '';
    $('model-run').textContent = '';
    $('copy-model').hidden = true;
    $('model-when').textContent = payload?.cleared ? '新对话' : '';
    $('model-usage').hidden = true;
    return;
  }
  block.dataset.empty = 'false';
  $('model-name').textContent = info.name;
  $('model-provider').textContent = info.provider;
  $('model-run').textContent = shortRun(payload?.run_id || payload?.runId);
  $('copy-model').hidden = false;
  $('model-when').textContent = payload?.restored ? '会话记忆' : info.partial ? '部分结果' : '刚刚识别';
  const u = payload?.run_usage && payload.run_usage.span_count ? formatUsage(payload.run_usage) : '';
  $('model-usage').textContent = u;
  $('model-usage').hidden = !u;
  lastModel = info.name;
  if (opts.replay) {
    renderRecent();
    return;
  }
  recent = pushRecent(recent, { name: info.name, provider: info.provider, at: Date.now() });
  store.set('ak_recent', recent);
  renderRecent();
  setStatus('已识别服务端模型', 'ok');
}

$('copy-model').addEventListener('click', async () => {
  const text = $('model-name').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制模型名');
  } catch {
    toast('复制失败');
  }
});

// ── credit gauge ─────────────────────────────────────────────────────────
let resetAt = null;
function renderReset() {
  $('credit-reset').textContent = formatReset(resetAt);
}
setInterval(renderReset, 30_000);

function showCredits(payload) {
  const pct = creditPercent(payload?.remaining, payload?.total);
  const band = creditBand(pct);
  const gauge = $('gauge');
  gauge.dataset.band = band;
  $('credit-pct').textContent = pct === null ? '—' : String(pct);
  $('credit-unit').hidden = pct === null;
  $('credit-sub').textContent =
    pct === null
      ? '等待数据'
      : `${Math.round(Number(payload.remaining))} / ${Math.round(Number(payload.total))}`;
  const fill = $('bar-fill');
  fill.style.width = (pct ?? 0) + '%';
  $('bar').setAttribute('aria-valuenow', String(pct ?? 0));
  resetAt = payload?.resetAt ?? payload?.reset_at ?? null;
  renderReset();
}

// ── page state (modules / unlock / eni / hud) ────────────────────────────
let syncing = false;
function applyPageState(state) {
  if (!state || typeof state !== 'object') return;
  syncing = true;
  try {
    const mods = state.modules || {};
    document.querySelectorAll('input[data-module]').forEach((input) => {
      const key = input.dataset.module;
      if (key in mods) input.checked = mods[key] !== false;
    });
    if (state.hud !== undefined) {
      const hud = document.querySelector('input[data-module="hud"]');
      if (hud) hud.checked = !!state.hud;
    }
    const unlock = state.unlock || {};
    document.querySelectorAll('input[data-unlock]').forEach((input) => {
      const key = input.dataset.unlock;
      if (key in unlock) input.checked = !!unlock[key];
    });
    if (state.eni) {
      $('eni-on').checked = !!state.eni.on;
      if (typeof state.eni.text === 'string' && document.activeElement !== $('eni-text')) {
        $('eni-text').value = state.eni.text;
      }
    }
    const enabled = Object.values(mods).filter((v) => v !== false).length;
    $('modules-aside').textContent = enabled ? `${enabled} 项启用` : '';
    updateEniAside();
    $('eni-count').textContent = charCount($('eni-text').value);
  } finally {
    syncing = false;
  }
}

function updateEniAside() {
  $('eni-aside').textContent = $('eni-on').checked ? '开启' : '关闭';
}

// ── 回复监控: turns / session memory / usage ───────────────────────────
function setTurnState(state, text) {
  $('turn-state').dataset.state = state;
  $('turn-state-text').textContent = text;
}
function renderTurnHistory(history) {
  const ol = $('turn-history');
  const items = Array.isArray(history) ? history.filter((h) => h && h.model) : [];
  ol.hidden = items.length === 0;
  ol.innerHTML = '';
  const first = items.length ? items[0].model : '';
  for (const h of items) {
    const li = document.createElement('li');
    li.dataset.routed = first && h.model !== first ? 'true' : 'false';
    const b = document.createElement('b');
    b.textContent = `R${h.turn}`;
    const span = document.createElement('span');
    span.textContent = h.model;
    li.append(b, span);
    ol.appendChild(li);
  }
}
function showTurnToken(p) {
  // A new run token = a new turn; the trace is still being fetched.
  setTurnState('live', `第 ${p?.turn ?? '?'} 轮 · 识别中`);
  $('turn-session').textContent = shortSession(p?.session_id);
  $('turn-aside').textContent = p?.switched ? '新会话' : '';
  if (p?.switched) {
    $('turn-headline').textContent = '—';
    $('turn-headline').dataset.empty = 'true';
    delete $('turn-headline').dataset.routed;
    renderTurnHistory([]);
  }
}
function showTurnResolved(report) {
  const view = report?.turn;
  if (report?.session_id) $('turn-session').textContent = shortSession(report.session_id);
  if (view) {
    $('turn-headline').textContent = turnHeadline(view);
    $('turn-headline').dataset.empty = 'false';
    $('turn-headline').dataset.routed = view.routed ? 'true' : 'false';
    renderTurnHistory(view.history);
    setTurnState('live', view.routed ? '模型已切换' : '已识别');
    $('turn-aside').textContent = `${view.turn} 轮`;
  } else if (report?.restored) {
    setTurnState('idle', '会话记忆');
    $('turn-aside').textContent = '已恢复';
  }
  const run = report?.run_usage && report.run_usage.span_count ? formatUsage(report.run_usage) : '';
  const all = report?.usage && report.usage.span_count ? formatUsage(report.usage) : '';
  $('usage-run').textContent = run ? `本轮 · ${run}` : '本轮 · Token / 费用:未提供';
  $('usage-session').textContent = all ? `本会话累计 · ${all}` : '本会话累计 · 未提供';
}
function resetTurns(cleared) {
  setTurnState('idle', cleared ? '新对话' : '等待会话流');
  $('turn-session').textContent = shortSession(cleared?.session_id);
  $('turn-headline').textContent = '—';
  $('turn-headline').dataset.empty = 'true';
  delete $('turn-headline').dataset.routed;
  $('turn-aside').textContent = '';
  renderTurnHistory([]);
  $('usage-run').textContent = '本轮 · Token / 费用:未提供';
  $('usage-session').textContent = '本会话累计 · 未提供';
}

// ── 自动探针 / 清理 / 快捷发送 / 设置 ─────────────────────────────────────
let settings = { auto_rename: false, rename_prefix: '', probe: { targets: 'opus5, fable5, gpt6', max_rounds: 5, find_all: true, auto_rename: true, prefix: '', suffix: true }, quick_text: '' };
let saveTimer = 0;

function readProbeConfig() {
  return {
    targets: $('probe-targets').value,
    max_rounds: Math.min(200, Math.max(1, Number($('probe-rounds').value) || 5)),
    find_all: $('probe-find-all').checked,
    auto_rename: $('probe-rename').checked,
    prefix: $('probe-prefix').value,
    suffix: $('probe-suffix').checked,
  };
}
function fillSettings(s) {
  settings = s || settings;
  const p = settings.probe || {};
  $('probe-targets').value = p.targets ?? '';
  $('probe-rounds').value = p.max_rounds ?? 5;
  $('probe-prefix').value = p.prefix ?? settings.rename_prefix ?? '';
  $('probe-find-all').checked = p.find_all !== false;
  $('probe-rename').checked = p.auto_rename !== false;
  $('probe-suffix').checked = p.suffix !== false;
  $('auto-rename').checked = !!settings.auto_rename;
  $('quick-text').value = settings.quick_text || '';
  $('quick-count').textContent = charCount($('quick-text').value);
}
function scheduleSaveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const probe = readProbeConfig();
    settings = { auto_rename: $('auto-rename').checked, rename_prefix: probe.prefix, probe, quick_text: $('quick-text').value };
    if (tauri) tauri.core.invoke('save_settings', { settings }).catch((e) => setStatus('设置保存失败: ' + (e?.message || e), 'error'));
  }, 400);
}

function renderProbe(payload) {
  const st = payload?.status;
  const text = payload?.text;
  if (!st) return;
  const aside = $('probe-aside');
  if (st.active && st.kind === 'probe') {
    aside.textContent = `第 ${st.round}/${st.max_rounds} 轮 · 命中 ${st.hits.length}`;
    aside.dataset.tone = 'live';
  } else if (st.active && st.kind === 'cleanup') {
    aside.textContent = `清理中 · 已归档 ${st.archived}`;
    aside.dataset.tone = 'live';
  } else {
    aside.textContent = st.hits && st.hits.length ? `上次命中 ${st.hits.length}` : '空闲';
    delete aside.dataset.tone;
  }
  $('probe-start').hidden = st.active;
  $('probe-stop').hidden = !st.active;
  $('cleanup-start').disabled = st.active;
  $('quick-send').disabled = st.active;
  $('probe-progress').textContent = text || st.last || '';
  const log = $('probe-log');
  log.textContent = (st.log || []).join('\n');
  log.hidden = !st.log || !st.log.length;
  log.scrollTop = log.scrollHeight;
  for (const id of ['probe-targets', 'probe-rounds', 'probe-prefix', 'probe-find-all', 'probe-rename', 'probe-suffix']) $(id).disabled = st.active;
}

function wireAutomation() {
  for (const id of ['probe-targets', 'probe-rounds', 'probe-prefix', 'probe-find-all', 'probe-rename', 'probe-suffix', 'auto-rename']) {
    $(id).addEventListener('change', scheduleSaveSettings);
    $(id).addEventListener('input', scheduleSaveSettings);
  }
  $('quick-text').addEventListener('input', () => {
    $('quick-count').textContent = charCount($('quick-text').value);
    scheduleSaveSettings();
  });
  $('probe-start').addEventListener('click', async () => {
    const config = readProbeConfig();
    if (!config.targets.trim()) {
      toast('请先填写探针目标');
      return;
    }
    if (!window.confirm(`自动探针会新建对话并发送真实消息(消耗额度)。\n目标:${config.targets}\n最多 ${config.max_rounds} 轮 · ${config.find_all ? '命中全部才停' : '命中即停'}${config.auto_rename ? ' · 命中后重命名' : ''}\n\n开始?`)) return;
    if (!tauri) {
      renderProbe({ status: { active: true, kind: 'probe', round: 1, max_rounds: config.max_rounds, hits: [], archived: 0, log: ['开始探针(预览)'], last: '' } });
      return;
    }
    try {
      renderProbe({ status: await tauri.core.invoke('probe_start', { config }) });
    } catch (e) {
      toast(String(e?.message || e));
    }
  });
  $('probe-stop').addEventListener('click', async () => {
    if (!tauri) { renderProbe({ status: { active: false, kind: 'idle', round: 0, max_rounds: 0, hits: [], archived: 0, log: ['已停止(预览)'], last: '' } }); return; }
    try {
      renderProbe({ status: await tauri.core.invoke('probe_stop') });
    } catch (e) {
      toast(String(e?.message || e));
    }
  });
  $('cleanup-start').addEventListener('click', async () => {
    if (!window.confirm('清理侧栏里标题为算式的对话(探针残留):仅归档、不删除,跳过当前打开的对话。\n\n开始?')) return;
    if (!tauri) return;
    try {
      renderProbe({ status: await tauri.core.invoke('cleanup_start') });
    } catch (e) {
      toast(String(e?.message || e));
    }
  });
  $('quick-send').addEventListener('click', async () => {
    const text = $('quick-text').value;
    if (!text.trim()) { toast('请先填写要发送的内容'); return; }
    if (!tauri) { toast('预览模式:未发送'); return; }
    $('quick-send').disabled = true;
    try {
      await tauri.core.invoke('quick_send', { text });
      toast('已发送到当前对话');
    } catch (e) {
      toast('发送失败: ' + String(e?.message || e));
    } finally {
      $('quick-send').disabled = false;
    }
  });
}

// ── Tauri bridge ─────────────────────────────────────────────────────────
const tauri = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event ? window.__TAURI__ : null;

function pageCall(js) {
  if (!tauri) return Promise.resolve();
  return tauri.core.invoke('arena_command', { js }).catch((e) => {
    setStatus('命令失败: ' + (e?.message || e), 'error');
  });
}

// Every call is guarded so a page that has not finished loading is a no-op.
const AK = 'window.__ARENAKIT__&&window.__ARENAKIT__.';

function wireControls() {
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'manager') {
        pageCall(`${AK}toggleManager()`);
      } else if (a === 'save-eni') {
        const text = $('eni-text').value;
        const on = $('eni-on').checked;
        pageCall(`${AK}setEni(${on ? 'true' : 'false'},${JSON.stringify(text)})`);
        toast(on ? '提示词已保存并启用' : '提示词已保存');
        updateEniAside();
      }
    });
  });

  $('eni-on').addEventListener('change', () => {
    if (syncing) return;
    const on = $('eni-on').checked;
    const text = $('eni-text').value;
    pageCall(`${AK}setEni(${on ? 'true' : 'false'},${JSON.stringify(text)})`);
    updateEniAside();
  });
  $('eni-text').addEventListener('input', () => {
    $('eni-count').textContent = charCount($('eni-text').value);
  });

  document.querySelectorAll('input[data-unlock]').forEach((input) => {
    input.addEventListener('change', () => {
      if (syncing) return;
      pageCall(`${AK}setUnlock(${JSON.stringify(input.dataset.unlock)},${input.checked})`);
      toast('已应用,页面将刷新');
    });
  });

  document.querySelectorAll('input[data-module]').forEach((input) => {
    input.addEventListener('change', () => {
      if (syncing) return;
      const key = input.dataset.module;
      if (key === 'hud') {
        pageCall(`${AK}setHud(${input.checked})`);
      } else {
        pageCall(`${AK}setModule(${JSON.stringify(key)},${input.checked})`);
        toast('已应用,页面将刷新');
      }
    });
  });
}

// ── tabs: the dock mirrors ONE arena tab at a time ───────────────────────
// Core events arrive tagged `{ tab, data }` (tab = null on mobile / unknown).
// Events for background tabs are cached and replayed when that tab becomes
// active, so switching tabs never shows another account's model or credits.
const perTab = new Map(); // tab id -> { models, credits, state }
let activeTab = null; // number | null (null = home / mobile)
let tabsKnown = false; // desktop shell told us about tabs at least once

export function unwrapEvent(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload && 'tab' in payload) {
    return { tab: payload.tab ?? null, data: payload.data };
  }
  return { tab: null, data: payload };
}

function cacheFor(tab) {
  const key = tab ?? 'mobile';
  if (!perTab.has(key)) perTab.set(key, { models: null, credits: null, state: null, token: null, probe: null });
  return perTab.get(key);
}

function isCurrent(tab) {
  // Mobile / untagged events always render; on desktop only the active tab does.
  return tab === null || !tabsKnown || tab === activeTab;
}

function resetCards() {
  showModels(null);
  showCredits(null);
  $('model-when').textContent = '';
  resetTurns(null);
  renderProbe({ status: { active: false, kind: 'idle', round: 0, max_rounds: 0, hits: [], archived: 0, log: [], last: '' } });
  setStatus('就绪');
}

function replay(tab) {
  const c = perTab.get(tab ?? 'mobile');
  if (!c) {
    resetCards();
    return;
  }
  if (c.models) showModels(c.models, { replay: true });
  else showModels(null);
  if (c.models && !c.models.cleared) showTurnResolved(c.models);
  else resetTurns(c.models);
  if (c.credits) showCredits(c.credits);
  else showCredits(null);
  if (c.state) applyPageState(c.state);
  if (c.probe) renderProbe(c.probe);
}

/** Called by the shell whenever tabs change. */
export function setActiveTab(view) {
  tabsKnown = true;
  const next = view && view.active != null ? Number(view.active) : null;
  const tab = view && next != null ? (view.tabs || []).find((t) => Number(t.id) === next) : null;
  const header = $('dock-tab');
  if (header) {
    header.hidden = !tab;
    if (tab) {
      $('dock-tab-dot').style.background = tab.color || 'var(--fg-3)';
      $('dock-tab-name').textContent = tab.name || '';
      $('dock-tab-proxy').textContent = tab.proxy || '直连';
    }
  }
  if (next === activeTab) return;
  activeTab = next;
  if (next === null) {
    replay(null);
    resetCards();
    setConn('idle', '未打开页面');
    return;
  }
  replay(next);
  setConn('idle', '等待页面');
  // Ask the now-visible page for its switches (it also reports on load).
  pageCall(`${AK}reportState()`);
  if (tauri) tauri.core.invoke('probe_status').then((status) => renderProbe({ status })).catch(() => {});
}

async function boot() {
  wireControls();
  wireAutomation();
  renderRecent();
  fillSettings(settings);
  $('eni-count').textContent = charCount($('eni-text').value);

  if (!tauri) {
    preview();
    return;
  }

  try {
    fillSettings(await tauri.core.invoke('get_settings'));
  } catch {
    /* older core */
  }

  const { listen } = tauri.event;
  await listen('arenakit://models', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).models = data;
    if (isCurrent(tab)) {
      showModels(data);
      if (data?.cleared) resetTurns(data);
      else showTurnResolved(data);
    }
  });
  await listen('arenakit://turn', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).token = data;
    if (isCurrent(tab)) showTurnToken(data);
  });
  await listen('arenakit://probe', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).probe = data;
    if (isCurrent(tab)) renderProbe(data);
  });
  await listen('arenakit://credits', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).credits = data;
    if (isCurrent(tab)) showCredits(data);
  });
  await listen('arenakit://state', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).state = data;
    if (isCurrent(tab)) {
      applyPageState(data);
      setConn('live', '已连接');
    }
  });
  await listen('arenakit://error', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    if (!isCurrent(tab)) return;
    const msg = data?.message || '未知错误';
    setStatus('错误: ' + msg, 'error');
    setConn('error', '出错');
  });

  try {
    const info = await tauri.core.invoke('get_app_info');
    $('app-info').textContent = `v${info.version} · ${info.platform}`;
  } catch {
    /* older core without the command */
  }

  setConn('idle', '等待页面');
  setStatus('就绪');
  // Ask the page for its current switches; it also reports on every load.
  pageCall(`${AK}reportState()`);
}

// ── preview (no Tauri runtime) ───────────────────────────────────────────
function preview() {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'light' || params.get('theme') === 'dark') {
    themeMode = params.get('theme');
    applyTheme();
  }
  setConn('preview', '预览模式');
  setStatus('浏览器预览 · 无 Tauri 运行时');
  $('app-info').textContent = 'v0.1.0 · preview';

  if (params.get('empty') === '1') return;

  // Sample data so the layout can be judged with real content.
  recent = [
    { name: 'gpt-5-chat', provider: 'openai', at: Date.now() - 12 * 60_000 },
    { name: 'gemini-2.5-pro', provider: 'google', at: Date.now() - 48 * 60_000 },
    { name: 'claude-sonnet-4', provider: 'anthropic', at: Date.now() - 3 * 3_600_000 },
  ];
  showModels({
    run_id: 'run_0f3a9c2d7e1b',
    models: [{ model: 'claude-opus-4-1', provider: 'anthropic', partial: false }],
  });
  showCredits({ remaining: 72, total: 100, resetAt: Date.now() + (2 * 60 + 15) * 60_000 });
  applyPageState({
    modules: { manager: true, unlock: true, plus: true, leaderboard: false, eni: false },
    unlock: { opus: true, hidden: false },
    hud: false,
    eni: { on: false, text: '' },
  });
  showTurnResolved({
    session_id: 'a1b2c3d4e5f6',
    run_usage: { span_count: 1, tokens: 1284, tokens_approximate: false, cost_usd: 0.0031, token_coverage: 1, cost_coverage: 1, partial: false },
    usage: { span_count: 3, tokens: 4120, tokens_approximate: true, cost_usd: 0.0104, token_coverage: 3, cost_coverage: 2, partial: false },
    turn: { turn: 3, model: 'claude-opus-4-1', routed: true, changed: true, history: [{ turn: 1, model: 'gpt-5-chat' }, { turn: 2, model: 'gpt-5-chat' }, { turn: 3, model: 'claude-opus-4-1' }] },
  });
  renderProbe({ status: { active: false, kind: 'idle', round: 0, max_rounds: 5, hits: [{ target: 'opus5', model: 'claude-opus-4-1' }], archived: 0, log: ['开始探针 · 目标 opus5、gpt6 · 命中全部才停 · 最多 5 轮', '第 1 轮 · 发送 "473×82=" · 待命中 opus5、gpt6', '识别到:claude-opus-4-1', '命中目标 opus5 → claude-opus-4-1', '已重命名为 claude-opus-4-1-001', '探针结束 · 命中:opus5→claude-opus-4-1'], last: '' } });
  if (params.get('band') === 'warning') showCredits({ remaining: 15, total: 100, resetAt: Date.now() + 40 * 60_000 });
  if (params.get('band') === 'danger') showCredits({ remaining: 4, total: 100, resetAt: Date.now() + 9 * 60_000 });
}

boot();
