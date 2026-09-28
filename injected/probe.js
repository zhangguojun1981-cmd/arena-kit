/* ArenaKit injected/probe.js
 * Source: arena-trace-android assets/probe.js (page-side discrete DOM actions,
 * ported from the extension's auto-draw.js + conversation-rename.js).
 * MAIN world, document_start. Stateless RPC layer: the dock (src/lib/probe-runner.js)
 * drives the loop the way the Android ProbeController does, one safe DOM step
 * per call, and gets model names from the snoop → Rust trace pipeline.
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
  const exact = (e, words) => words.includes(text(e));

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
      if (Date.now() >= end) return reject(Error(message));
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

  async function ensureGithub() {
    if (location.origin !== ARENA) throw Error('已离开 Arena');
    let sw = null;
    try { sw = await waitFor(() => githubToggle() || (connectBanner() ? 'banner' : null), '', 6000); } catch { }
    if (sw === 'banner') throw Error('GitHub 尚未连接（输入框下方显示「Connect your GitHub」），请先手动点 Connect 授权一次');
    if (!sw) throw Error('未找到 GitHub 开关 · 看到：' + composerDiag());
    if (toggleState(sw) === true) return { github: true, changed: false };
    sw.click();
    await waitFor(() => { const e = githubToggle() || sw; return toggleState(e) === true; }, '已点击 GitHub 开关，但未确认打开 · 看到：' + composerDiag(), 5000);
    return { github: true, changed: true };
  }

  const norm = t => clean(t).toLowerCase().replace(/\s+/g, ' ');
  const repoName = r => String(r || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const repoMatches = (t, repo) => {
    const full = norm(repoName(repo)), short = full.split('/').pop();
    const s = norm(t);
    if (!short) return false;
    if (full.includes('/') && s.includes(full)) return 2;
    return new RegExp('(^|[\\s/:·•|(\\[])' + short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s)\\]·•|,])').test(s) ? 1 : false;
  };
  const OPTION_SEL = '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item],[role="listbox"] li,[role="treeitem"]';
  const pickers = () => [...document.querySelectorAll('button[role="combobox"],button[aria-haspopup],[role="combobox"]')]
    .filter(e => visible(e) && outsideChrome(e) && e !== modeCombo());
  function repoPicker(repo) {
    const list = pickers();
    return list.find(e => repoMatches(ownText(e), repo))
      || list.find(e => /repo|repository|仓库|项目|project/i.test(ownText(e) + ' ' + (e.getAttribute?.('data-testid') || '')))
      || list.find(e => /^[\w.-]+\/[\w.-]+$/.test(text(e)))
      || null;
  }
  function branchPicker() {
    return pickers().find(e => /branch|分支/i.test(ownText(e) + ' ' + (e.getAttribute?.('data-testid') || ''))) || null;
  }
  function typeFilter(value) {
    const box = [...document.querySelectorAll('[role="dialog"] input,[role="listbox"] input,[cmdk-input],[data-radix-popper-content-wrapper] input,input[role="combobox"]')]
      .find(e => visible(e) && (e.tagName || '').toUpperCase() === 'INPUT');
    if (!box) return false;
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')?.set;
      box.focus();
      if (setter) setter.call(box, value); else box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch { return false; }
  }
  async function choose(opener, wanted, matchFn, what) {
    opener.click();
    await waitFor(() => [...document.querySelectorAll(OPTION_SEL)].some(visible), `${what}列表未打开 · 看到：` + composerDiag(), 5000);
    typeFilter(wanted);
    const opt = await waitFor(() => {
      const opts = [...document.querySelectorAll(OPTION_SEL)].filter(e => visible(e) && e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('data-disabled'));
      let best = null, score = 0;
      for (const o of opts) { const sc = matchFn(ownText(o)); if (sc && sc > score) { best = o; score = sc; } }
      return best;
    }, `${what}列表里没有「${wanted}」`, 8000).catch((e) => {
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch { }
      throw e;
    });
    opt.click();
  }

  /* GitHub on + the requested repo (and branch, when given) selected. */
  async function ensureProject(args) {
    const repo = repoName(args?.repo);
    const branch = String(args?.branch || '').trim();
    if (!repo) throw Error('未指定项目（仓库）');
    const gh = await ensureGithub();
    let picker = await waitFor(() => repoPicker(repo), '未找到仓库选择器 · 看到：' + composerDiag(), 6000);
    let changed = gh.changed;
    if (!repoMatches(ownText(picker), repo)) {
      await choose(picker, repo.split('/').pop(), t => repoMatches(t, repo), '仓库');
      picker = await waitFor(() => { const p = repoPicker(repo); return p && repoMatches(ownText(p), repo) ? p : null; }, `未能确认已选中仓库「${repo}」 · 看到：` + composerDiag(), 6000);
      changed = true;
    }
    if (branch) {
      const bMatch = t => { const s = norm(t); const b = norm(branch); return s === b ? 2 : (s.split(/[\s·•|]+/).includes(b) ? 1 : false); };
      const bp = await waitFor(() => branchPicker(), '未找到分支选择器 · 看到：' + composerDiag(), 6000);
      if (!bMatch(ownText(bp)) && !norm(ownText(bp)).includes(norm(branch))) {
        await choose(bp, branch, bMatch, '分支');
        await waitFor(() => { const p = branchPicker(); return p && norm(ownText(p)).includes(norm(branch)); }, `未能确认已选中分支「${branch}」`, 6000);
        changed = true;
      }
    }
    return { github: true, repo, branch: branch || null, changed };
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

  const ACTIONS = { precheck, newChat, ensureAgentMode, ensureGithub, ensureProject, applyDefaults, send, sendToCurrent, sidebarList, collapseSidebar, openConversation, revealSidebarItem, rename, archive };

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

  globalThis.ArenaProbe = { call, isOwnPrompt, isArithmeticTitle: isOwnPrompt };
})();
