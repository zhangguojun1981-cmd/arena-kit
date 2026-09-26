/* ArenaKit HUD overlay — M0 scaffold.
 * Listens for Rust events and paints the floating model/credit card.
 * Ported UI logic will come from arena-trace-inspector hud.js / view-model.js. */

const q = (id) => document.getElementById(id);

function showModel(models) {
  const names = (models || []).map((m) => m.model).join(', ');
  q('ak-model').textContent = names || '未识别';
}

function showCredit({ remaining, total, resetAt }) {
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  q('ak-credit').textContent = `${pct}%` + (resetAt ? ` · 重置 ${resetAt}` : '');
  const fill = q('ak-bar-fill');
  fill.style.width = pct + '%';
  fill.dataset.band = pct < 10 ? 'danger' : pct < 20 ? 'warning' : 'ok';
}

// Tauri event wiring (present only inside the app runtime).
async function wire() {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('arenakit://models', (e) => showModel(e.payload.models));
    await listen('arenakit://credits', (e) => showCredit(e.payload));
    await listen('arenakit://error', (e) => console.warn('[ArenaKit]', e.payload));
    q('arenakit-hud').hidden = false;
  } catch {
    // Running outside Tauri (plain browser preview) — leave HUD hidden.
    console.info('[ArenaKit] Tauri runtime not detected; HUD idle.');
  }
}
wire();
