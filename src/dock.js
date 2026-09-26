/* ArenaKit native side dock logic.
 * Runs in its own webview. Talks to Rust via Tauri IPC, and to the arena.ai
 * webview via Rust commands (arena_command) that eval into the page webview. */

const q = (id) => document.getElementById(id);
const setStatus = (t) => { q('ak-status').textContent = t; };

// Collapsible modules
document.querySelectorAll('.ak-mod-head').forEach((h) => {
  h.addEventListener('click', () => {
    const mod = h.parentElement;
    mod.dataset.open = mod.dataset.open === 'true' ? 'false' : 'true';
  });
});

let tauri = null;
async function boot() {
  try {
    const evt = await import('@tauri-apps/api/event');
    const core = await import('@tauri-apps/api/core');
    tauri = { listen: evt.listen, invoke: core.invoke };
  } catch {
    setStatus('浏览器预览模式(无 Tauri 运行时)');
    return;
  }

  // Rust → dock events
  await tauri.listen('arenakit://models', (e) => {
    const models = (e.payload.models || []).map((m) => m.model);
    q('ak-model').textContent = models.join(', ') || '未识别';
    q('ak-model-sub').textContent = 'run ' + (e.payload.run_id || '').slice(0, 12);
    setStatus('已识别服务端模型');
  });
  await tauri.listen('arenakit://credits', (e) => {
    const { remaining, total, resetAt } = e.payload;
    const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
    q('ak-credit').textContent = pct + '%';
    q('ak-reset').textContent = resetAt ? '重置 ' + resetAt : '';
    const fill = q('ak-bar-fill');
    fill.style.width = pct + '%';
    fill.dataset.band = pct < 10 ? 'danger' : pct < 20 ? 'warning' : 'ok';
  });
  await tauri.listen('arenakit://error', (e) => setStatus('错误: ' + (e.payload.message || '')));

  wireControls();
  setStatus('就绪');
}

// Send a command into the arena.ai page webview via Rust.
function arenaCmd(js) {
  if (tauri) tauri.invoke('arena_command', { js }).catch((e) => setStatus('命令失败: ' + e));
}

function wireControls() {
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action;
      if (a === 'manager') {
        arenaCmd('window.__AK_MANAGER_TOGGLE__ && window.__AK_MANAGER_TOGGLE__()');
      } else if (a === 'save-eni') {
        const text = JSON.stringify(q('ak-eni-text').value);
        const on = q('ak-eni-on').checked;
        arenaCmd(`window.__AK_ENI_SET__ && window.__AK_ENI_SET__(${on}, ${text})`);
        setStatus('提示词已保存');
      }
    });
  });

  // Unlock / plus toggles → set the page-side config and reload the page state.
  const bind = (id, fn) => q(id).addEventListener('change', (e) => fn(e.target.checked));
  bind('ak-unlock-opus', (v) => arenaCmd(`window.__AK_UNLOCK_SET__ && window.__AK_UNLOCK_SET__('opus', ${v})`));
  bind('ak-unlock-hidden', (v) => arenaCmd(`window.__AK_UNLOCK_SET__ && window.__AK_UNLOCK_SET__('hidden', ${v})`));
  bind('ak-plus', (v) => arenaCmd(`window.__AK_PLUS_SET__ && window.__AK_PLUS_SET__(${v})`));
}

boot();
