/* ArenaKit shell controller.
 *
 * Desktop: renders the tab strip and the home page (accounts) and drives the
 * Rust session commands (open_tab / close_tab / activate_tab / accounts). The
 * arena.ai tabs themselves are native child webviews — the shell only tells
 * Rust which one to show. The dock (right column) is `dock.js`, which this
 * module imports and keeps informed about the active tab.
 *
 * Mobile: hides tabs + dock and shows a start page; "打开 Arena" navigates the
 * single webview to arena.ai.
 *
 * Without a Tauri runtime (npm run preview) everything runs against sample
 * data so the layout can be judged in a browser.
 */
import { toast, setActiveTab } from './dock.js';

const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event ? window.__TAURI__ : null;
const params = new URLSearchParams(location.search);

/** Same flat palette as sessions::PALETTE (Rust) — first swatch is the default. */
export const PALETTE = ['#5b5bd6', '#1f9d6a', '#d48806', '#e0434a', '#0e8ab0', '#b0489a', '#6b7c3f', '#7a5c3e'];

const shell = $('shell');
let accounts = [];
let tabsView = { tabs: [], active: null };
let info = { platform: 'preview', version: '0.1.0', mobile: false, multi_account: true, per_tab_proxy: true };
const unread = new Set();

// ── helpers ──────────────────────────────────────────────────────────────
function invoke(cmd, args) {
  if (!tauri) return previewInvoke(cmd, args || {});
  return tauri.core.invoke(cmd, args || {});
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export function openCount(tabs, accountId) {
  return (tabs || []).filter((t) => t.account_id === accountId).length;
}

export function proxyLabel(proxy) {
  return proxy ? proxy : '直连';
}

// ── tabs (top bar) ───────────────────────────────────────────────────────
function renderTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';
  for (const t of tabsView.tabs) {
    const selected = tabsView.active === t.id;
    const tab = el(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': selected ? 'true' : 'false',
        title: `${t.name} · ${proxyLabel(t.proxy)}`,
        dataset: { id: String(t.id), unread: unread.has(t.id) && !selected ? 'true' : 'false' },
      },
      [
        el('span', { class: 'dot', style: `background:${t.color}` }),
        el('span', { class: 'name', text: t.name }),
        el('span', { class: 'badge', 'aria-hidden': 'true' }),
        el('button', {
          class: 'close',
          type: 'button',
          title: '关闭此页面',
          'aria-label': `关闭 ${t.name}`,
          html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
          dataset: { close: String(t.id) },
        }),
      ]
    );
    nav.appendChild(tab);
  }
  $('home-btn').setAttribute('aria-pressed', tabsView.active == null ? 'true' : 'false');
  const n = tabsView.tabs.length;
  $('topbar-hint').textContent = n ? `${n} 个页面` : '';
  const active = tabsView.tabs.find((t) => t.id === tabsView.active);
  if (active) {
    unread.delete(active.id);
    const selectedEl = nav.querySelector(`.tab[data-id="${active.id}"]`);
    selectedEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  renderAccounts(); // open counts
}

async function applyTabs(view) {
  tabsView = { tabs: view?.tabs || [], active: view?.active ?? null };
  renderTabs();
  setActiveTab(tabsView);
}

async function activate(id) {
  try {
    await applyTabs(await invoke('activate_tab', { id }));
  } catch (e) {
    toast(String(e?.message || e));
  }
}

async function closeTab(id) {
  try {
    await applyTabs(await invoke('close_tab', { id }));
  } catch (e) {
    toast(String(e?.message || e));
  }
}

export async function openTab(accountId) {
  try {
    const view = await invoke('open_tab', { accountId });
    if (!info.mobile) await applyTabs(view);
  } catch (e) {
    toast('打开失败: ' + String(e?.message || e));
  }
}

function wireTopbar() {
  $('home-btn').addEventListener('click', () => activate(null));
  $('tab-add').addEventListener('click', async () => {
    if (!accounts.length) {
      await activate(null);
      openDialog();
      return;
    }
    try {
      await invoke('pick_account');
    } catch (e) {
      toast(String(e?.message || e));
    }
  });
  const nav = $('tabs');
  nav.addEventListener('click', (ev) => {
    const close = ev.target.closest('[data-close]');
    if (close) {
      ev.stopPropagation();
      closeTab(Number(close.dataset.close));
      return;
    }
    const tab = ev.target.closest('.tab');
    if (tab) activate(Number(tab.dataset.id));
  });
  nav.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return;
    const tab = ev.target.closest('.tab');
    if (tab) {
      ev.preventDefault();
      closeTab(Number(tab.dataset.id));
    }
  });
}

// ── home: accounts ───────────────────────────────────────────────────────
function renderAccounts() {
  const grid = $('acct-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const a of accounts) {
    const n = openCount(tabsView.tabs, a.id);
    const card = el('article', { class: 'acct-card', dataset: { id: a.id } }, [
      el('div', { class: 'acct-top' }, [
        el('span', { class: 'swatch', style: `background:${a.color}` }),
        el('span', { class: 'acct-name', text: a.name, title: a.name }),
        el('span', { class: 'acct-open', text: n ? `${n} 个页面` : '未打开', dataset: { n: String(n) } }),
      ]),
      el('div', { class: 'acct-proxy mono', text: proxyLabel(a.proxy), title: proxyLabel(a.proxy), dataset: { direct: a.proxy ? 'false' : 'true' } }),
      a.note ? el('div', { class: 'acct-note', text: a.note, title: a.note }) : null,
      el('div', { class: 'acct-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', text: n ? '再开一页' : '打开 arena', onclick: () => openTab(a.id) }),
        el('button', { class: 'btn', type: 'button', text: '编辑', onclick: () => openDialog(a) }),
      ]),
    ]);
    grid.appendChild(card);
  }
  grid.appendChild(
    el('button', { class: 'acct-add', type: 'button', text: accounts.length ? '+ 添加账号' : '+ 添加第一个账号', onclick: () => openDialog() })
  );
}

// ── dialog ───────────────────────────────────────────────────────────────
let dlgColor = PALETTE[0];

function renderSwatches() {
  const box = $('f-colors');
  box.innerHTML = '';
  for (const c of PALETTE) {
    box.appendChild(
      el('button', {
        class: 'swatch-btn',
        type: 'button',
        role: 'radio',
        'aria-checked': c === dlgColor ? 'true' : 'false',
        'aria-label': c,
        style: `background:${c}`,
        onclick: () => {
          dlgColor = c;
          renderSwatches();
        },
      })
    );
  }
}

function setDlgError(msg) {
  const e = $('f-error');
  e.hidden = !msg;
  e.textContent = msg || '';
}

function openDialog(account) {
  const dlg = $('account-dialog');
  $('dlg-title').textContent = account ? '编辑账号' : '添加账号';
  $('f-id').value = account?.id || '';
  $('f-name').value = account?.name || '';
  $('f-proxy').value = account?.proxy || '';
  $('f-note').value = account?.note || '';
  $('f-delete').hidden = !account;
  dlgColor = account?.color || PALETTE[accounts.length % PALETTE.length];
  renderSwatches();
  setDlgError('');
  const help = $('f-proxy-help');
  help.textContent = '留空 = 直连。支持 http / socks5,不支持带密码。';
  delete help.dataset.tone;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  setTimeout(() => $('f-name').focus(), 0);
}

function closeDialog() {
  const dlg = $('account-dialog');
  if (dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}

function wireDialog() {
  $('f-cancel').addEventListener('click', closeDialog);
  $('account-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      id: $('f-id').value || null,
      name: $('f-name').value,
      proxy: $('f-proxy').value.trim() || null,
      color: dlgColor,
      note: $('f-note').value,
    };
    if (!payload.name.trim()) {
      setDlgError('请填写名称');
      return;
    }
    $('f-save').disabled = true;
    try {
      accounts = await invoke('save_account', { account: payload });
      renderAccounts();
      closeDialog();
      toast(payload.id ? '已保存' : '账号已添加');
    } catch (e) {
      setDlgError(String(e?.message || e));
    } finally {
      $('f-save').disabled = false;
    }
  });
  $('f-delete').addEventListener('click', async () => {
    const id = $('f-id').value;
    if (!id) return;
    const acc = accounts.find((a) => a.id === id);
    const n = openCount(tabsView.tabs, id);
    const msg = `删除账号“${acc?.name || ''}”?${n ? `\n它打开的 ${n} 个页面会一并关闭。` : ''}\n(登录数据会保留在本机,直到清理应用数据)`;
    if (!window.confirm(msg)) return;
    try {
      accounts = await invoke('delete_account', { id });
      closeDialog();
      renderAccounts();
      toast('账号已删除');
    } catch (e) {
      setDlgError(String(e?.message || e));
    }
  });
  $('f-probe').addEventListener('click', async () => {
    const help = $('f-proxy-help');
    const proxy = $('f-proxy').value.trim() || null;
    help.textContent = proxy ? `正在通过 ${proxy} 测试…` : '正在测试直连…';
    delete help.dataset.tone;
    $('f-probe').disabled = true;
    try {
      const r = await invoke('probe_proxy', { proxy });
      if (r.ok) {
        help.textContent = `可用 · 出口 IP ${r.ip || '?'} · ${r.ms} ms`;
        help.dataset.tone = 'ok';
      } else {
        help.textContent = `不可用 · ${r.error || '未知错误'}`;
        help.dataset.tone = 'error';
      }
    } catch (e) {
      help.textContent = String(e?.message || e);
      help.dataset.tone = 'error';
    } finally {
      $('f-probe').disabled = false;
    }
  });
}

// ── mobile ───────────────────────────────────────────────────────────────
function wireMobile() {
  $('m-open').addEventListener('click', () => openTab('mobile'));
  $('m-version').textContent = `v${info.version} · ${info.platform}`;
}

// ── boot ─────────────────────────────────────────────────────────────────
async function boot() {
  if (params.get('view') === 'dock') shell.dataset.view = 'dock';

  try {
    info = await invoke('get_app_info');
  } catch {
    /* preview */
  }
  const mobile = params.get('mode') === 'mobile' || !!info.mobile;
  shell.dataset.mode = mobile ? 'mobile' : 'desktop';
  $('m-home').hidden = !mobile;
  $('home').hidden = mobile;

  if (mobile) {
    wireMobile();
    return;
  }

  wireTopbar();
  wireDialog();
  accounts = (await invoke('list_accounts')) || [];
  await applyTabs(await invoke('list_tabs'));

  if (tauri) {
    const { listen } = tauri.event;
    await listen('arenakit://tabs', (e) => applyTabs(e.payload));
    await listen('arenakit://home', () => {
      // "管理账号…" from the native menu.
      $('add-account')?.focus();
    });
    await listen('arenakit://models', (e) => {
      const p = e.payload;
      const tab = p && typeof p === 'object' && 'tab' in p ? p.tab : null;
      if (tab != null && tab !== tabsView.active) {
        unread.add(tab);
        renderTabs();
      }
    });
    await listen('arenakit://error', (e) => {
      const p = e.payload;
      if (p && typeof p === 'object' && p.data && p.data.scope === 'tab') toast(String(p.data.message || '打开失败'));
    });
  }
  $('add-account').addEventListener('click', () => openDialog());
}

// ── preview (no Tauri runtime) ───────────────────────────────────────────
const preview = {
  accounts: [
    { id: 'a1', name: '主号', proxy: 'socks5://127.0.0.1:1081', color: PALETTE[0], note: 'me@example.com', created: 0 },
    { id: 'a2', name: '工作号', proxy: 'http://127.0.0.1:7890', color: PALETTE[1], note: '', created: 0 },
    { id: 'a3', name: '直连备用', proxy: null, color: PALETTE[3], note: '不走代理', created: 0 },
  ],
  tabs: [],
  active: null,
  next: 1,
};
if (params.get('tabs') === '1') {
  preview.tabs = [
    { id: 1, label: 'arena-1', account_id: 'a1', name: '主号', color: PALETTE[0], proxy: 'socks5://127.0.0.1:1081' },
    { id: 2, label: 'arena-2', account_id: 'a1', name: '主号', color: PALETTE[0], proxy: 'socks5://127.0.0.1:1081' },
    { id: 3, label: 'arena-3', account_id: 'a2', name: '工作号', color: PALETTE[1], proxy: 'http://127.0.0.1:7890' },
  ];
  preview.active = params.get('active') === 'none' ? null : 2;
  preview.next = 4;
}

function previewView() {
  return { tabs: preview.tabs.map((t) => ({ ...t })), active: preview.active };
}

async function previewInvoke(cmd, args) {
  await new Promise((r) => setTimeout(r, 60));
  switch (cmd) {
    case 'get_app_info':
      return { platform: 'preview', version: '0.1.0', arch: 'wasm', mobile: params.get('mode') === 'mobile', multi_account: true, per_tab_proxy: true };
    case 'list_accounts':
      return preview.accounts.map((a) => ({ ...a }));
    case 'list_tabs':
      return previewView();
    case 'open_tab': {
      const a = preview.accounts.find((x) => x.id === args.accountId);
      if (!a) throw new Error('账号不存在');
      const id = preview.next++;
      preview.tabs.push({ id, label: `arena-${id}`, account_id: a.id, name: a.name, color: a.color, proxy: a.proxy });
      preview.active = id;
      return previewView();
    }
    case 'close_tab': {
      const pos = preview.tabs.findIndex((t) => t.id === args.id);
      if (pos >= 0) {
        preview.tabs.splice(pos, 1);
        if (preview.active === args.id) preview.active = preview.tabs.length ? preview.tabs[Math.max(0, pos - 1)].id : null;
      }
      return previewView();
    }
    case 'activate_tab':
      preview.active = args.id ?? null;
      return previewView();
    case 'pick_account': {
      const a = preview.accounts[0];
      return previewInvoke('open_tab', { accountId: a.id }).then((v) => applyTabs(v));
    }
    case 'save_account': {
      const inp = args.account;
      if (inp.proxy && !/^(https?|socks5):\/\//.test(inp.proxy) && !/^[\w.-]+:\d+$/.test(inp.proxy)) throw new Error('代理地址无法解析');
      if (inp.id) {
        const a = preview.accounts.find((x) => x.id === inp.id);
        Object.assign(a, { name: inp.name.trim(), proxy: inp.proxy, color: inp.color, note: inp.note || '' });
      } else {
        preview.accounts.push({ id: 'a' + Math.random().toString(16).slice(2, 8), name: inp.name.trim(), proxy: inp.proxy, color: inp.color, note: inp.note || '', created: 0 });
      }
      return preview.accounts.map((a) => ({ ...a }));
    }
    case 'delete_account':
      preview.accounts = preview.accounts.filter((a) => a.id !== args.id);
      preview.tabs = preview.tabs.filter((t) => t.account_id !== args.id);
      if (preview.active && !preview.tabs.some((t) => t.id === preview.active)) preview.active = null;
      applyTabs(previewView());
      return preview.accounts.map((a) => ({ ...a }));
    case 'probe_proxy':
      return args.proxy ? { ok: true, ip: '203.0.113.7', ms: 412, error: null } : { ok: true, ip: '198.51.100.2', ms: 88, error: null };
    default:
      throw new Error('preview: unknown command ' + cmd);
  }
}

boot();
