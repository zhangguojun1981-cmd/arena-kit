/* ArenaKit injected/probe.js
 * Source: arena-trace-android assets/probe.js (page-side discrete DOM actions,
 * ported from the extension's auto-draw.js + conversation-rename.js).
 * MAIN world, document_start. Stateless RPC layer: the dock
 * (src/lib/fingerprint-runner.js) drives the loop one safe DOM step per call,
 * and gets model names from the snoop → Rust trace pipeline.
 *
 * Call:   window.ArenaProbe.call(action, argsJson, reqId)      (dock → arena_command eval)
 * Result: __ARENAKIT__.send('probe-result', {reqId, ok, data|error})  (page → dock)
 *
 * Every safety guard from the extension is preserved:
 *   - never overwrite a human draft (noDraft)
 *   - only clear our own arithmetic probe prompt
 *   - confirm Agent Mode before sending (isAgentLabel, never a hardcoded label)
 *   - rename/archive strictly through Arena's own menus, no private endpoints
 * PORT NOTE: identical to the Android asset except the result channel and the
 * extra precheck fields (hasDraft / draftIsOwnPrompt / title).
 */
(() => {
  const ARENA = 'https://arena.ai';
  const NEW_CHAT_LABELS = ['New Chat', 'New chat', '新建聊天', '新对话', '新建对话'];

  const visible = e => !!e?.isConnected && e.getClientRects().length > 0;
  const session = () => location.pathname.match(/^\/(?:agent|c)\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const agentPath = () => location.pathname.replace(/\/$/, '') === '/agent';
  const clean = t => String(t ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  const text = e => (e?.textContent || '').trim();

  // Our own probe prompts are bare arithmetic ("N op N ="). A human names/writes
  // with words, so this never matches real user content.
  const isOwnPrompt = t => /^\s*\d{1,4}\s*[+\-*/×÷]\s*\d{1,4}\s*=\s*$/.test(String(t || ''));

  const sessionFromPath = path => path.match(/^\/(?:agent|c)\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const labelOf = e => ((e?.getAttribute?.('aria-label') || e?.placeholder || '') + ' ' + (e?.textContent || '')).trim();
  const isSearch = e => /search|搜索|查找/i.test(labelOf(e)) || e?.closest?.('[data-sidebar]');

  function editors() {
    const nodes = [];
    for (const sel of ['[contenteditable="true"]', 'textarea', '[role="textbox"]']) nodes.push(...document.querySelectorAll(sel));
    return [...new Set(nodes)].filter(e => visible(e) && !isSearch(e));
  }
  function placeholderText(e) {
    const own = e.getAttribute?.('data-placeholder') || e.getAttribute?.('aria-placeholder') || '';
    if (own) return String(own).trim();
    const inner = e.querySelector?.('[data-placeholder]');
    return String(inner?.getAttribute?.('data-placeholder') || '').trim();
  }
  function composerScore(e) {
    let s = 0;
    if (/message|prompt|发送|消息|提问|ask|chat/i.test(labelOf(e))) s += 4;
    if (e.closest?.('form')) s += 2;
    if (placeholderText(e)) s += 1;
    return s;
  }
  function composer() {
    const all = editors();
    if (!all.length) return null;
    let best = all.at(-1), score = composerScore(best);
    for (const e of all) { const s = composerScore(e); if (s > score) { best = e; score = s; } }
    return best;
  }
  function editorText(e) {
    if (!e) return '';
    const tag = (e.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return clean(e.value);
    if (/\bis-(?:editor-)?empty\b/.test(String(e.className || ''))) return '';
    const t = clean(e.innerText ?? e.textContent);
    const ph = placeholderText(e);
    if (t && ph && t === ph) return '';
    if (t && e.childElementCount === 1 && /placeholder|hint/i.test(String(e.firstElementChild?.className || ''))) return '';
    return t;
  }
  function noDraft(allowPrompt = false) {
    const all = editors();
    const main = composer();
    const suspects = main ? [main] : all;
    const offender = suspects.find(e => { const t = editorText(e); return t && !(allowPrompt && isOwnPrompt(t)); });
    if (offender) {
      const dump = all.map(e => `${String(e.tagName || '?').toLowerCase()}${e.id ? '#' + e.id : ''}:"${editorText(e).slice(0, 10)}…"`).join(' ');
      throw Error(`输入框有未发送内容（"${editorText(offender).slice(0, 24)}" · 共${all.length}个输入区 ${dump}），已停止；不会覆盖草稿`);
    }
  }
  function expandSidebar() {
    const buttons = [...document.querySelectorAll('button[aria-label]')].filter(b => visible(b) && !b.disabled);
    const opener = buttons.find(b => ['Open sidebar', '展开侧栏', '打开侧边栏', '展开侧边栏'].includes(b.getAttribute('aria-label')))
      || buttons.find(b => ['Toggle Sidebar', 'Toggle sidebar', '切换侧栏'].includes(b.getAttribute('aria-label')) && b.closest?.('[data-state="collapsed"]'));
    opener?.click();
  }
  function collapseSidebar() {
    const buttons = [...document.querySelectorAll('button[aria-label]')].filter(b => visible(b) && !b.disabled);
    const closer = buttons.find(b => ['Close sidebar', '收起侧栏', '关闭侧边栏', '收起侧边栏'].includes(b.getAttribute('aria-label')))
      || buttons.find(b => ['Toggle Sidebar', 'Toggle sidebar', '切换侧栏'].includes(b.getAttribute('aria-label')));
    closer?.click();
    return { closed: true };
  }
  function newChatControl() {
    const agentLink = a => { try { const u = new URL(a.href, location.origin); return u.origin === ARENA && u.pathname.replace(/\/$/, '') === '/agent'; } catch { return false; } };
    const links = [...document.querySelectorAll('a[href]')].filter(agentLink);
    const named = links.filter(a => NEW_CHAT_LABELS.includes((a.textContent || '').trim()) || NEW_CHAT_LABELS.includes((a.getAttribute?.('aria-label') || '').trim()));
    if (named.length) return named.find(visible) || named[0];
    const buttons = [...document.querySelectorAll('button,[role="button"]')];
    const labeled = buttons.filter(e => NEW_CHAT_LABELS.includes((e.textContent || '').trim()) || NEW_CHAT_LABELS.includes((e.getAttribute?.('aria-label') || '').trim()));
    return labeled.find(visible) || labeled[0] || null;
  }

  const isAgentLabel = txt => { const t = String(txt || '').trim(); return /^Agent(\s+Mode)?\b/i.test(t) || /agent\s*mode/i.test(t); };

  function fillPrompt(editor, value) {
    editor.focus();
    if (editorText(editor) === value) return true;
    const tag = (editor.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(editor, value); else editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) {
        editor.textContent = value;
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
    }
    return editorText(editor) === value;
  }
  function clearOwnDraft(editor) {
    if (!editor || !isOwnPrompt(editorText(editor))) return;
    editor.focus();
    const tag = (editor.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(editor, ''); else editor.value = '';
      editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('delete', false);
    }
  }
  function findSend(editor) {
    const ok = b => visible(b) && !b.disabled;
    const exactBtn = [...document.querySelectorAll('button[aria-label="Send message"]')].find(ok);
    if (exactBtn) return exactBtn;
    const buttons = [...document.querySelectorAll('button')].filter(ok);
    const named = buttons.find(b => /^(send( message)?|submit|发送(消息)?)$/i.test((b.getAttribute?.('aria-label') || '').trim()) || /^(send|发送)$/i.test((b.textContent || '').trim()));
    if (named) return named;
    const form = editor?.closest?.('form');
    if (form) { const submit = [...form.querySelectorAll('button[type="submit"], button')].find(b => ok(b) && b.getAttribute('type') !== 'reset'); if (submit) return submit; }
    const host = editor?.parentElement;
    if (host) { const local = [...host.querySelectorAll('button')].filter(ok); if (local.length === 1) return local[0]; }
    return null;
  }
  // "Generating" only counts when a Stop button is actually VISIBLE. Arena can
  // leave a hidden Stop button in the DOM after a reply finishes; matching on mere
  // presence made quick-send wrongly report "当前回复仍在生成". Also match zh labels.
  const isGenerating = () => [...document.querySelectorAll('button[aria-label]')]
    .some(b => visible(b) && /^(stop generating|stop|停止生成|停止回复|停止)$/i.test((b.getAttribute('aria-label') || '').trim()));

  const waitFor = (check, message, ms = 15000) => new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      let v; try { v = check(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() >= end) { let m = message; try { if (typeof m === 'function') m = m(); } catch { m = String(message); } return reject(Error(m)); }
      setTimeout(tick, 200);
    };
    tick();
  });

  // ---- discrete actions invoked by the native controller ----

  function precheck() {
    const editor = composer();
    const draft = editor ? editorText(editor) : '';
    return {
      onArena: location.origin === ARENA,
      session: session(),
      agentPath: agentPath(),
      hasComposer: !!editor,
      hasDraft: !!draft,
      draftIsOwnPrompt: !!draft && isOwnPrompt(draft),
      isGenerating: isGenerating(),
      renameBusy: !!(globalThis.ArenaConversationRename?.isBusy?.()),
      dialogOpen: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible),
      title: String(document.title || '').slice(0, 300),
    };
  }

  async function newChat() {
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    noDraft(true);
    if (isGenerating()) throw Error('当前回复仍在生成，已停止');
    // Already on a fresh /agent composer with no session → nothing to do.
    if (!session() && agentPath() && composer()) { noDraft(true); return { session: null }; }
    // Prefer the New Chat control without opening the sidebar; only expand if it
    // isn't reachable, so probe rounds don't keep toggling the sidebar.
    let control = newChatControl();
    if (!control) { expandSidebar(); control = await waitFor(() => newChatControl(), '未找到 New Chat 入口，已停止'); }
    control.click();
    await waitFor(() => !session() && agentPath(), '新建聊天超时');
    await waitFor(() => composer(), '等待新聊天输入框超时');
    noDraft(true);
    return { session: null };
  }

  // ---- Agent Mode / GitHub connector / project (repo + branch) ----
  // 0.4.8. Arena's composer controls are found by text / ARIA, never by
  // generated class names: the mode selector ("Agent Mode ⌄", a combobox),
  // the GitHub connector switch below the composer, and the repo / branch
  // pickers that appear once the connector is on. All steps are idempotent
  // (already right → no click) and never touch a draft.
  const MODE_WORDS = /^\s*(agent|battle|direct|side[\s-]*by[\s-]*side|search|chat)(\s+(mode|chat))?\b|\bmode\s*$|模式/i;
  function modeCombo() {
    const combos = [...document.querySelectorAll('button[role="combobox"]')].filter(e => visible(e) && !e.closest?.('[data-sidebar]'));
    return combos.find(e => MODE_WORDS.test(text(e))) || combos[0] || null;
  }
  const outsideChrome = e => !e.closest?.('[data-sidebar],nav,aside');
  const ownText = e => clean(((e?.getAttribute?.('aria-label') || '') + ' ' + (e?.getAttribute?.('title') || '') + ' ' + (e?.textContent || '')).replace(/\s+/g, ' '));
  /* Text that labels a control: its own text/ARIA, an aria-labelledby target,
   * a <label for>, or a short enclosing row (switch next to "GitHub"). */
  function labelText(e) {
    let t = ownText(e);
    const by = e.getAttribute?.('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) { const l = document.getElementById(id); if (l) t += ' ' + text(l); }
    if (e.id) { try { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) t += ' ' + text(l); } catch { } }
    let row = e.parentElement;
    for (let i = 0; row && i < 3; i++, row = row.parentElement) {
      const rt = clean(row.textContent || '');
      if (rt && rt.length <= 60) { t += ' ' + rt; break; }
    }
    return t;
  }
  function toggleState(e) {
    const a = k => e.getAttribute?.(k);
    if (a('aria-checked') === 'true' || a('aria-pressed') === 'true') return true;
    if (a('aria-checked') === 'false' || a('aria-pressed') === 'false') return false;
    if (typeof e.checked === 'boolean' && (e.tagName || '').toUpperCase() === 'INPUT') return e.checked;
    const ds = a('data-state');
    if (ds === 'checked' || ds === 'on' || ds === 'active') return true;
    if (ds === 'unchecked' || ds === 'off' || ds === 'inactive') return false;
    return null;
  }
  const TOGGLE_SEL = '[role="switch"],[role="checkbox"],[role="menuitemcheckbox"],button[aria-pressed],button[aria-checked],input[type="checkbox"],button[data-state="on"],button[data-state="off"],button[data-state="checked"],button[data-state="unchecked"]';
  function githubToggle() {
    const all = [...document.querySelectorAll(TOGGLE_SEL)].filter(e => visible(e) && outsideChrome(e) && /github/i.test(labelText(e)));
    return all.find(e => toggleState(e) !== null) || null;
  }
  const connectBanner = () => [...document.querySelectorAll('button,a,[role="button"]')]
    .find(e => visible(e) && /^connect$/i.test(text(e)) && /connect your github/i.test(clean(e.parentElement?.parentElement?.textContent || e.parentElement?.textContent || '')));
  /* What we could see — reported to the dock log when a step fails. */
  function composerDiag() {
    const seen = [];
    for (const e of document.querySelectorAll('button,[role="switch"],[role="combobox"],[role="checkbox"],input[type="checkbox"],a')) {
      if (seen.length >= 8) break;
      if (!visible(e) || !outsideChrome(e)) continue;
      const t = ownText(e);
      if (!/github|repo|branch|仓库|分支|项目|project/i.test(t + ' ' + (e.getAttribute?.('data-testid') || ''))) continue;
      const attrs = ['role', 'aria-checked', 'aria-pressed', 'data-state', 'aria-haspopup'].map(k => e.getAttribute?.(k) ? `${k}=${e.getAttribute(k)}` : '').filter(Boolean).join(',');
      seen.push(`${(e.tagName || '?').toLowerCase()}[${attrs}]"${t.slice(0, 32)}"`);
    }
    return seen.join(' | ') || '（输入框附近未见 GitHub / 仓库相关控件）';
  }

  /* GitHub "switch" = the account's GitHub connection
   * (docs arena-agent-github-automation.md §2.3: GET /api/coding/github/connection
   * → {status: disconnected|installed|connected}). A visible connector toggle
   * that is off is still switched on; the OAuth "Connect" is never clicked
   * (first authorisation must be done by hand on github.com). */
  async function githubConnection() {
    try {
      const r = await fetch('/api/coding/github/connection', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) return { status: '', http: r.status };
      const j = await r.json();
      return { status: String(j?.status || ''), http: r.status };
    } catch { return { status: '', http: 0 }; }
  }
  async function ensureGithub() {
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    let changed = false;
    const sw = githubToggle();
    if (sw && toggleState(sw) === false) {
      sw.click();
      changed = true;
      await waitFor(() => { const e = githubToggle() || sw; return toggleState(e) === true; }, '已点击 GitHub 开关，但未确认打开 · 看到：' + composerDiag(), 5000);
    }
    const conn = await githubConnection();
    if (conn.status === 'connected') return { github: true, changed };
    if (conn.status === 'disconnected' || conn.status === 'installed' || connectBanner())
      throw Error('GitHub 尚未连接（状态 ' + (conn.status || '横条 Connect your GitHub') + '），请先手动点 Connect 授权一次');
    // endpoint unavailable: trust a toggle that is on
    const now = githubToggle();
    if (now && toggleState(now) === true) return { github: true, changed };
    throw Error('无法确认 GitHub 连接（接口 HTTP ' + conn.http + '） · 看到：' + composerDiag());
  }

  /* ---- project = GitHub repository, fuzzy by name ----
   * The user types just a project name ("arena-kit", "arenakit", "kit"…);
   * the repo list (GET /api/coding/github/repos, cursor paged) resolves it
   * to one repository, which is then picked in the "Select a repository"
   * dropdown by its exact name. */
  const norm = t => clean(t).toLowerCase().replace(/\s+/g, ' ');
  const squash = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const repoQuery = r => String(r || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  function isSubsequence(q, s) { let i = 0; for (const ch of s) if (ch === q[i]) i++; return i === q.length; }
  /* 0 = no match; higher = better. `name` / `fullName` as in the repos API. */
  function fuzzyScore(query, repo) {
    const q = repoQuery(query).toLowerCase();
    if (!q) return 0;
    const name = String(repo?.name || String(repo?.fullName || '').split('/').pop() || '').toLowerCase();
    const full = String(repo?.fullName || name).toLowerCase();
    if (q.includes('/')) {
      if (full === q) return 100;
      const [, qn] = q.split('/');
      if (qn && name === qn) return 90;
    }
    if (name === q) return 100;
    const qs = squash(q), ns = squash(name), fs = squash(full);
    if (!qs) return 0;
    if (ns === qs) return 95;
    if (ns.startsWith(qs)) return 80;
    if (ns.includes(qs)) return 70;
    if (fs.includes(qs)) return 60;
    if (qs.length >= 3 && isSubsequence(qs, ns)) return 40;
    return 0;
  }
  function pickRepo(query, repos) {
    let best = null, score = 0;
    for (const r of repos || []) {
      const sc = fuzzyScore(query, r);
      if (sc > score || (sc === score && sc > 0 && best && String(r.name || '').length < String(best.name || '').length)) { best = r; score = sc; }
    }
    return best ? { repo: best, score } : null;
  }
  /* All repositories the account's GitHub connection can see (doc §3.1:
   * GET /api/coding/github/repos?limit=100[&cursor=], {repos, nextCursor,
   * hasNextPage}). Returns {repos, http, note}: note explains an empty list
   * (HTTP error / unexpected shape / really no repos) for the probe log. */
  const reposOf = (j) => (Array.isArray(j) ? j : Array.isArray(j?.repos) ? j.repos : Array.isArray(j?.data?.repos) ? j.data.repos : Array.isArray(j?.items) ? j.items : Array.isArray(j?.repositories) ? j.repositories : null);
  async function fetchRepos(url) {
    try {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      const body = await r.text();
      let j = null;
      try { j = JSON.parse(body); } catch { }
      return { http: r.status, ok: r.ok, j, body: body.slice(0, 160) };
    } catch (e) { return { http: 0, ok: false, j: null, body: String(e?.message || e).slice(0, 160) }; }
  }
  async function listRepos() {
    const out = [];
    let cursor = null, http = 0, note = '';
    for (let page = 0; page < 10; page++) {
      let res = await fetchRepos('/api/coding/github/repos?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      // a server that rejects limit=100 → its default page size
      if (!res.ok && res.http >= 400 && res.http < 500 && res.http !== 401 && res.http !== 403 && !page) res = await fetchRepos('/api/coding/github/repos');
      http = res.http;
      if (!res.ok) { note = `仓库接口 HTTP ${res.http || '失败'}${res.body ? '：' + res.body : ''}`; break; }
      const list = reposOf(res.j);
      if (!list) { note = '仓库接口返回格式无法识别：' + res.body; break; }
      out.push(...list.filter(x => x && (x.name || x.fullName || x.full_name)).map(x => (x.fullName || !x.full_name ? x : { ...x, fullName: x.full_name })));
      const next = res.j?.nextCursor ?? res.j?.next_cursor ?? null;
      if (!(res.j?.hasNextPage ?? res.j?.has_next_page ?? !!next) || !next) break;
      cursor = next;
    }
    if (!out.length && !note) note = '仓库接口返回 0 个仓库（GitHub 授权里没有可用仓库：到 GitHub → Settings → Applications 给 Arena 的 GitHub App 授权该仓库）';
    return { repos: out, http, note };
  }
  const OPTION_SEL = '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item],[role="listbox"] li,[role="treeitem"]';
  const pickers = () => [...document.querySelectorAll('button[role="combobox"],button[aria-haspopup],[role="combobox"],[placeholder="Select a repository"]')]
    .filter(e => visible(e) && outsideChrome(e) && e !== modeCombo() && (e.tagName || '').toUpperCase() !== 'INPUT');
  /* text shows the chosen repo: "arena-kit", "owner/arena-kit", "arena-kit · main" */
  const showsRepo = (el, target) => {
    const t = norm(ownText(el));
    const name = String(target?.name || '').toLowerCase(), full = String(target?.fullName || '').toLowerCase();
    if (full && t.includes(full)) return true;
    return !!name && new RegExp('(^|[\\s/:·•|(\\[])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s)\\]·•|,])').test(t);
  };
  function repoPicker(target) {
    const list = pickers();
    return (target && list.find(e => showsRepo(e, target)))
      || list.find(e => /select a repository|repositor|仓库|项目/i.test(ownText(e) + ' ' + (e.getAttribute?.('placeholder') || '')))
      || list.find(e => /^[\w.-]+\/[\w.-]+$/.test(text(e)))
      || null;
  }
  function branchPicker() {
    return pickers().find(e => /branch|分支/i.test(ownText(e) + ' ' + (e.getAttribute?.('data-testid') || ''))) || null;
  }
  function typeFilter(value) {
    const inputs = [...document.querySelectorAll('input[placeholder^="Search repositories"],input[placeholder^="Search branches"],[role="dialog"] input,[role="listbox"] input,[cmdk-input],[data-radix-popper-content-wrapper] input,input[role="combobox"]')]
      .filter(e => visible(e) && (e.tagName || '').toUpperCase() === 'INPUT');
    const box = inputs[0];
    if (!box) return false;
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set;
      box.focus();
      if (setter) setter.call(box, value); else box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch { return false; }
  }
  async function choose(opener, filter, scoreFn, what) {
    opener.click();
    await waitFor(() => [...document.querySelectorAll(OPTION_SEL)].some(visible), `${what}列表未打开 · 看到：` + composerDiag(), 5000);
    typeFilter(filter);
    const opt = await waitFor(() => {
      const opts = [...document.querySelectorAll(OPTION_SEL)].filter(e => visible(e) && e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('data-disabled'));
      let best = null, score = 0;
      for (const o of opts) { const sc = scoreFn(ownText(o)); if (sc > score) { best = o; score = sc; } }
      return best;
    }, () => `${what}列表里没有匹配「${filter}」的项 · 列表里看到：` + ([...document.querySelectorAll(OPTION_SEL)].filter(visible).slice(0, 8).map(o => clean(ownText(o)).slice(0, 40)).join('、') || '（空）'), 8000).catch((e) => {
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch { }
      throw e;
    });
    const label = ownText(opt);
    opt.click();
    return label;
  }

  /* Agent composer: GitHub connected + the project (repo, fuzzy name) and
   * optional branch selected. Idempotent: already selected → no clicks. */
  async function ensureProject(args) {
    const query = repoQuery(args?.repo);
    const branch = String(args?.branch || '').trim();
    if (!query) throw Error('未指定项目（仓库）');
    const gh = await ensureGithub();
    // resolve the fuzzy name against the account's repositories
    const { repos, note } = await listRepos();
    let target = null;
    if (repos.length) {
      const hit = pickRepo(query, repos);
      if (!hit) throw Error(`没有与「${query}」匹配的仓库（共 ${repos.length} 个：${repos.slice(0, 6).map(r => r.name || r.fullName).join('、')}${repos.length > 6 ? '…' : ''}）`);
      target = { name: hit.repo.name || String(hit.repo.fullName).split('/').pop(), fullName: hit.repo.fullName || hit.repo.name, defaultBranch: hit.repo.defaultBranch || '' };
    }
    let picker = await waitFor(() => repoPicker(target), '未找到仓库选择器（Select a repository） · 看到：' + composerDiag(), 6000);
    let changed = gh.changed;
    if (!(target && showsRepo(picker, target))) {
      // repo list unavailable → fuzzy against the dropdown's own option texts
      const scoreFn = target
        ? (t => {
          const s = norm(t), name = target.name.toLowerCase();
          if (s.includes(target.fullName.toLowerCase())) return 3;
          return s.split(/[\s·•|]+/).some(w => w === name || w.endsWith('/' + name)) ? 2 : 0;
        })
        : (t => fuzzyScore(query, { name: norm(t).split(/[\s·•|]+/)[0].split('/').pop(), fullName: norm(t).split(/[\s·•|]+/)[0] }));
      const label = await choose(picker, target ? target.name : query, scoreFn, '仓库').catch((e) => {
        throw Error((e?.message || e) + (note ? ' · ' + note : ''));
      });
      if (!target) { const w = norm(label).split(/[\s·•|]+/)[0]; target = { name: w.split('/').pop(), fullName: w }; }
      picker = await waitFor(() => { const p = repoPicker(target); return p && showsRepo(p, target) ? p : null; }, `未能确认已选中仓库「${target.fullName}」 · 看到：` + composerDiag(), 6000);
      changed = true;
    }
    if (branch) {
      const b = norm(branch);
      const bScore = t => { const s = norm(t); return s === b ? 3 : (s.split(/[\s·•|]+/).includes(b) ? 2 : 0); };
      const bp = await waitFor(() => branchPicker(), '未找到分支选择器 · 看到：' + composerDiag(), 6000);
      if (!bScore(ownText(bp)) && !norm(ownText(bp)).includes(b)) {
        await choose(bp, branch, bScore, '分支');
        await waitFor(() => { const p = branchPicker(); return p && norm(ownText(p)).includes(b); }, `未能确认已选中分支「${branch}」`, 6000);
        changed = true;
      }
    }
    return { github: true, repo: target.fullName, name: target.name, branch: branch || null, changed };
  }

  /* App open / after an account switch: Agent Mode + GitHub on (+ project).
   * Each part reports separately; nothing here ever sends a message. */
  async function applyDefaults(args) {
    const out = { agent: null, github: null, project: null, errors: [] };
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    if (session()) return { skipped: 'conversation' }; // only a fresh composer
    try { await ensureAgentMode(); out.agent = true; } catch (e) { out.agent = false; out.errors.push('Agent 模式：' + (e?.message || e)); }
    if (args?.github !== false) {
      try {
        if (args?.repo) { const r = await ensureProject(args); out.github = true; out.project = r.repo; }
        else { await ensureGithub(); out.github = true; }
      } catch (e) { out.errors.push((args?.repo ? '项目：' : 'GitHub：') + (e?.message || e)); if (out.github === null) out.github = !!githubToggle() && toggleState(githubToggle()) === true; }
    }
    return out;
  }

  async function ensureAgentMode() {
    const combo = await waitFor(() => modeCombo(), '未找到模式选择器');
    if (!isAgentLabel(combo.textContent)) {
      combo.click();
      const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(e => visible(e) && /agent\s*mode/i.test(e.textContent.trim()) && !e.hasAttribute('data-disabled') && e.getAttribute('aria-disabled') !== 'true'), '未找到 Agent Mode 选项');
      if (option.getAttribute('aria-selected') === 'true') combo.click(); else option.click();
    }
    await waitFor(() => { const c = modeCombo(); return c && isAgentLabel(c.textContent); }, '未能确认 Agent Mode');
    // Arena sometimes restores the just-sent prompt as the new draft; clear only ours.
    clearOwnDraft(composer());
    return { ok: true };
  }

  // Fill our probe prompt and send it. Returns the new session id after navigation.
  async function send(args) {
    const prompt = String(args?.prompt || '');
    if (!isOwnPrompt(prompt)) throw Error('探针只发送算式提示');
    if (location.origin !== ARENA || !agentPath()) throw Error('页面已变化，未发送');
    if (session()) throw Error('新聊天状态已变化，未发送');
    noDraft(true);
    const editor = composer();
    if (!editor) throw Error('输入框不可用');
    if (!fillPrompt(editor, prompt)) throw Error('输入消息失败；未发送');
    const button = await waitFor(() => findSend(editor), '发送按钮不可用；未发送');
    if (editorText(editor) !== prompt || session()) throw Error('输入或页面已变化；未发送');
    if (![...document.querySelectorAll('button[role="combobox"]')].some(b => visible(b) && isAgentLabel(b.textContent))) throw Error('模式已变化；未发送');
    button.click();
    const id = await waitFor(() => session(), '发送后未确认新会话；不重发', 30000);
    return { session: id };
  }

  // Fill the CURRENT conversation's composer with arbitrary text and send it.
  // Unlike send() this is NOT restricted to arithmetic and does NOT require a
  // fresh /agent — it targets whatever conversation is open. Triggered by an
  // explicit user long-press, so it may replace an existing draft.
  async function sendToCurrent(args) {
    const value = String(args?.text || '');
    if (!value.trim()) throw Error('发送内容为空');
    if (value.length > 8000) throw Error('内容过长（上限 8000 字）');
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    if (isGenerating()) throw Error('当前回复仍在生成，已停止');
    const editor = composer();
    if (!editor) throw Error('未找到输入框');
    if (!fillPrompt(editor, value)) throw Error('输入内容失败；未发送');
    const button = await waitFor(() => findSend(editor), '发送按钮不可用；未发送');
    if (editorText(editor) !== value) throw Error('输入已变化；未发送');
    button.click();
    return { sent: true };
  }

  // ---- model fingerprint: fixed-probe sender --------------------------------
  // The dock's fingerprint-runner can only ask us to send a FIXED, built-in
  // prompt chosen from this hard-coded allowlist. The runner passes a protocol
  // id and probe id — NEVER a prompt string — so a compromised or malicious
  // dock message can never make the page send arbitrary text to a real model.
  // Each prompt is bare, model-neutral and matches the protocol's declared
  // shape (ModelTrace long-integer sequence / fpverify categorical battery).
  // Keep this table in sync with data/fingerprint/protocols/*.json; the repo
  // JSON deliberately does NOT inline the prompt text (its `prompt.note` says it
  // lives page-side in an allowlist) so remote config can't swap the probe body.
  const FINGERPRINT_PROMPTS = {
    'modeltrace-long-integers-v1': {
      // One probe id; the runner may repeat it up to the user-confirmed budget.
      // A long run of plain integers in [1,355]; parsed page-side into a
      // histogram, never forwarded as text.
      'seq-1-355': 'Output 120 random integers, each between 1 and 355 inclusive, separated by single spaces. Only the numbers, nothing else.',
    },
    'fpverify-battery-v1': {
      // One fixed question per probe id; the runner walks the battery in order.
      'random_1_100': 'Pick a random integer between 1 and 100. Reply with only the number.',
      'random_color': 'Name a random color. Reply with only the single color word.',
      'animal': 'Name a random animal. Reply with only the single animal word.',
      'city': 'Name a random city. Reply with only the single city name.',
      'coin': 'Flip a fair coin. Reply with only "heads" or "tails".',
    },
  };

  // Send a built-in fingerprint probe. Params are ONLY {protocolId, probeId};
  // the prompt comes from FINGERPRINT_PROMPTS, never from the caller. Clones
  // send()'s guard chain (fresh /agent, Agent Mode, no draft overwrite, stable
  // page) and returns {session, probeId} — never a cookie, token or reply text.
  async function sendFingerprintProbe(args) {
    const protocolId = String(args?.protocolId || '');
    const probeId = String(args?.probeId || '');
    const table = FINGERPRINT_PROMPTS[protocolId];
    if (!table) throw Error('未知指纹协议；未发送');
    const prompt = table[probeId];
    if (typeof prompt !== 'string' || !prompt) throw Error('未登记的指纹探针；未发送');
    // The caller must not smuggle a prompt in; we ignore any args.prompt field.
    if (location.origin !== ARENA || !agentPath()) throw Error('页面已变化，未发送');
    if (session()) throw Error('新聊天状态已变化，未发送');
    if (isGenerating()) throw Error('当前回复仍在生成，已停止');
    noDraft(true);
    const editor = composer();
    if (!editor) throw Error('输入框不可用');
    if (!fillPrompt(editor, prompt)) throw Error('输入消息失败；未发送');
    const button = await waitFor(() => findSend(editor), '发送按钮不可用；未发送');
    if (editorText(editor) !== prompt || session()) throw Error('输入或页面已变化；未发送');
    if (![...document.querySelectorAll('button[role="combobox"]')].some(b => visible(b) && isAgentLabel(b.textContent))) throw Error('模式已变化；未发送');
    button.click();
    const id = await waitFor(() => session(), '发送后未确认新会话；不重发', 30000);
    return { session: id, probeId };
  }

  // Send a built-in fingerprint probe into the CURRENT, already identified
  // conversation. Used by the automatic labelled-sample collector: every reply
  // is paired with that same turn's server trace model before it is admitted to
  // the local sample bank. Still allowlist-only; callers cannot supply text.
  async function sendFingerprintProbeCurrent(args) {
    const protocolId = String(args?.protocolId || '');
    const probeId = String(args?.probeId || '');
    const prompt = FINGERPRINT_PROMPTS[protocolId]?.[probeId];
    if (typeof prompt !== 'string' || !prompt) throw Error('未登记的指纹探针；未发送');
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    const id = session();
    if (!id) throw Error('请先打开一个旧对话');
    if (isGenerating()) throw Error('当前回复仍在生成，已停止');
    noDraft(false);
    const editor = composer();
    if (!editor) throw Error('输入框不可用');
    if (!fillPrompt(editor, prompt)) throw Error('输入消息失败；未发送');
    const button = await waitFor(() => findSend(editor), '发送按钮不可用；未发送');
    if (editorText(editor) !== prompt || session() !== id) throw Error('输入或对话已变化；未发送');
    button.click();
    return { session: id, probeId };
  }

  // Sidebar snapshot for title-based cleanup: [{sessionId, title}].
  // The list is virtualized (only visible links exist in the DOM), so scroll it
  // to the bottom until the count stops growing before snapshotting.
  function sidebarScroller() {
    if (typeof getComputedStyle !== 'function') return null;
    for (const a of document.querySelectorAll('a[data-sidebar="menu-button"][href]')) {
      let p = a.parentElement;
      while (p) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 40) return p;
        p = p.parentElement;
      }
    }
    return null;
  }
  function collectSidebar() {
    const seen = new Set(), out = [];
    for (const a of document.querySelectorAll('a[data-sidebar="menu-button"][href]')) {
      let id = null;
      try { const u = new URL(a.href, location.origin); if (u.origin === ARENA) id = sessionFromPath(u.pathname); } catch { id = null; }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // clean(): strip zero-width chars Arena sometimes injects into titles —
      // otherwise the Kotlin arithmetic-title regex misses those rows (residue).
      out.push({ sessionId: id, title: clean(text(a)).slice(0, 300) });
    }
    return out;
  }
  async function loadAllSidebar() {
    const scroller = sidebarScroller();
    if (!scroller) return;
    // Step DOWN gradually instead of jumping to scrollHeight: virtualized lists
    // often only fetch/render more rows in response to incremental scrolling.
    let last = -1, stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      scroller.scrollTop = atBottom ? scroller.scrollHeight
        : scroller.scrollTop + Math.max(200, scroller.clientHeight);
      await new Promise(r => setTimeout(r, 350));
      const n = collectSidebar().length;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
  }

  /**
   * Scroll the (virtualized) sidebar until the row for sessionId is actually
   * MOUNTED in the DOM. The cleanup sweep must do this before archiving:
   * loadAllSidebar leaves the list scrolled to the bottom, so top rows are
   * unmounted and archive()'s link lookup would fail, leaving residue behind.
   */
  async function revealSidebarItem(args) {
    const sessionId = String(args?.sessionId || '');
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw Error('会话 id 无效');
    if (sidebarLink(sessionId)) return { found: true };
    const scroller = sidebarScroller();
    if (!scroller) throw Error('侧栏列表未加载');
    for (let pass = 0; pass < 2; pass++) {
      scroller.scrollTop = pass === 0 ? 0 : scroller.scrollHeight;
      const step = Math.max(200, scroller.clientHeight);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 150));
        const link = sidebarLink(sessionId);
        if (link) {
          link.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          return { found: true };
        }
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        if (pass === 0) { if (atBottom) break; scroller.scrollTop += step; }
        else { if (scroller.scrollTop <= 0) break; scroller.scrollTop -= step; }
      }
    }
    if (sidebarLink(sessionId)) return { found: true };
    throw Error('侧栏未找到该对话');
  }
  async function sidebarList(args) {
    // expand defaults true; cleanup opens the sidebar ONCE up front and passes
    // expand:false on subsequent scans so we don't toggle it every pass.
    if (args?.expand !== false) expandSidebar();
    if (!collectSidebar().length) await waitFor(() => collectSidebar().length > 0, '侧栏对话列表未加载', 6000).catch(() => {});
    await loadAllSidebar();
    return { items: collectSidebar() };
  }

  // Navigate to a saved conversation by clicking its sidebar link (SPA nav keeps
  // this injected script alive). Required before archive, whose guard demands
  // being on that conversation's own page.
  function sidebarLink(sessionId) {
    return [...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].find(a => {
      try { const u = new URL(a.href, location.origin); return u.origin === ARENA && sessionFromPath(u.pathname) === sessionId; } catch { return false; }
    }) || null;
  }
  async function openConversation(args) {
    const sessionId = String(args?.sessionId || '');
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw Error('会话 id 无效');
    if (session() === sessionId) return { session: sessionId };
    // On a phone the sidebar Sheet auto-closes after a selection, so between
    // archives the target link may not be in the DOM. Reopen and wait for it,
    // retrying a few times (scroll the virtualized list) before giving up.
    let link = null;
    for (let attempt = 0; attempt < 3 && !link; attempt++) {
      expandSidebar();
      link = await waitFor(() => sidebarLink(sessionId), '', 2500).catch(() => null);
      if (!link) { await loadAllSidebar(); link = sidebarLink(sessionId); }
    }
    if (!link) throw Error('侧栏未找到该对话');
    link.click();
    await waitFor(() => session() === sessionId, '切换到该对话超时', 8000);
    return { session: sessionId };
  }

  async function rename(args) {
    const api = globalThis.ArenaConversationRename;
    if (!api) throw Error('重命名模块未加载');
    const r = await api.rename({ sessionId: String(args?.sessionId || ''), model: String(args?.title || ''), isCurrent: () => true });
    return r || { ok: true };
  }
  async function archive(args) {
    const api = globalThis.ArenaConversationRename;
    if (!api) throw Error('归档模块未加载');
    // Cleanup archives from the sidebar ⋯ menu without opening the chat, so it
    // must not require being on the chat's own URL, and must not toggle the
    // sidebar (the sweep opens/closes it exactly once around the whole loop).
    const requireCurrentUrl = args?.requireCurrentUrl !== false;
    const manageSidebar = args?.manageSidebar !== false;
    const r = await api.archive({ sessionId: String(args?.sessionId || ''), isCurrent: () => true, requireCurrentUrl, manageSidebar });
    return r || { archived: true };
  }

  const ACTIONS = { precheck, newChat, ensureAgentMode, ensureGithub, ensureProject, applyDefaults, send, sendToCurrent, sendFingerprintProbe, sendFingerprintProbeCurrent, sidebarList, collapseSidebar, openConversation, revealSidebarItem, rename, archive };

  async function call(action, argsJson, reqId) {
    let res;
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const fn = ACTIONS[action];
      if (!fn) throw Error('unknown action: ' + action);
      const data = await fn(args);
      res = { ok: true, data: data ?? {} };
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    try {
      const bridge = globalThis.__ARENAKIT__;
      if (bridge && typeof bridge.send === 'function') bridge.send('probe-result', { reqId, ...res });
      else if (typeof ArenaProbeBridge !== 'undefined') ArenaProbeBridge.onResult(reqId, JSON.stringify(res));
    } catch (_) { }
    return res;
  }

  // Expose the allowlisted protocol→probe ids (NOT the prompt text) so the dock
  // runner and tests can enumerate the fixed plan without being able to inject a
  // prompt. The values are the probe ids only.
  const fingerprintProbeIds = () => {
    const out = {};
    for (const p of Object.keys(FINGERPRINT_PROMPTS)) out[p] = Object.keys(FINGERPRINT_PROMPTS[p]);
    return out;
  };

  globalThis.ArenaProbe = { call, isOwnPrompt, isArithmeticTitle: isOwnPrompt, fuzzyScore, pickRepo, listRepos, fingerprintProbeIds };
})();
