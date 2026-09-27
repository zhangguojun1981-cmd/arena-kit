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
  resolveTheme,
  shortRun,
  themeLabel,
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
    $('model-name').textContent = payload ? '未识别' : '—';
    $('model-provider').textContent = '';
    $('model-run').textContent = '';
    $('copy-model').hidden = true;
    $('model-when').textContent = '';
    return;
  }
  block.dataset.empty = 'false';
  $('model-name').textContent = info.name;
  $('model-provider').textContent = info.provider;
  $('model-run').textContent = shortRun(payload?.run_id || payload?.runId);
  $('copy-model').hidden = false;
  $('model-when').textContent = info.partial ? '部分结果' : '刚刚识别';
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
  if (!perTab.has(key)) perTab.set(key, { models: null, credits: null, state: null });
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
  if (c.credits) showCredits(c.credits);
  else showCredits(null);
  if (c.state) applyPageState(c.state);
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
}

async function boot() {
  wireControls();
  renderRecent();
  $('eni-count').textContent = charCount($('eni-text').value);

  if (!tauri) {
    preview();
    return;
  }

  const { listen } = tauri.event;
  await listen('arenakit://models', (e) => {
    const { tab, data } = unwrapEvent(e.payload);
    cacheFor(tab).models = data;
    if (isCurrent(tab)) showModels(data);
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

boot();
