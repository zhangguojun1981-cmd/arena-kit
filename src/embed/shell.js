/* Embedded dock shell (Android).
 *
 * Mobile Tauri gives us exactly one webview per window, so the side dock that
 * desktop renders in its own webview is mounted INSIDE the arena.ai page
 * instead: a floating "AK" button plus a bottom sheet that hosts the very same
 * dock markup (dock.html body) and stylesheet (dock.css), isolated in a shadow
 * root so arena's CSS and ours never touch. scripts/bundle-dock.mjs packs this
 * file, dock.js and src/lib into one classic script (src/embed/dock-embedded.gen.js)
 * that Rust appends to the mobile init bundle.
 *
 * mount(win) builds the DOM and publishes `win.__ARENAKIT_EMBED__`
 * ({ root, host, open, close, toggle, isOpen }) which dock.js reads at module
 * evaluation time — so the bundle must call mount() BEFORE requiring dock.js. */
import { CSS, MARKUP } from './assets.gen.js';

export const HOST_ID = 'arenakit-embed';
const FAB_POS_KEY = 'arenakit.fab.pos';

/* dock.css targets a standalone document; retarget its document-level rules to
 * the shadow root (`:host` carries the CSS variables, `.ak-shell` is "body"). */
export function shadowCss(css) {
  return String(css)
    .replace(/(^|\n):root\s*\{/g, '$1:host {')
    .replace(/(^|\n)html,\s*body\s*\{/g, '$1.ak-shell {');
}

export const EMBED_CSS = `
:host { all: initial; }
.ak-fab {
  position: fixed; right: 12px; bottom: calc(96px + env(safe-area-inset-bottom, 0px));
  width: 46px; height: 46px; border-radius: 50%; border: 0;
  background: var(--ak-accent); color: #fff; font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.35); z-index: 2147483000;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.ak-fab[data-alert="true"] { box-shadow: 0 0 0 3px rgba(239,68,68,.7), 0 4px 14px rgba(0,0,0,.35); }
.ak-panel {
  position: fixed; left: 0; right: 0; bottom: 0; height: 72vh; max-height: 720px;
  z-index: 2147483001; background: var(--ak-bg); color: var(--ak-fg);
  border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(0,0,0,.45);
  display: flex; flex-direction: column; overflow: hidden;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transform: translateY(105%); transition: transform .18s ease-out;
}
.ak-panel[data-open="true"] { transform: translateY(0); }
.ak-shell { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; height: auto; }
.ak-close { margin-left: auto; background: none; border: 0; color: var(--ak-sub); font-size: 18px; line-height: 1; padding: 2px 6px; cursor: pointer; }
@media (min-width: 720px) {
  .ak-panel { left: auto; width: 380px; height: 100vh; max-height: none; border-radius: 14px 0 0 14px; transform: translateX(105%); }
}
`;

/* Clamp a saved/dragged FAB position to the viewport. */
export function clampPos(pos, vw, vh, size = 46) {
  const x = Math.min(Math.max(0, Number(pos && pos.x) || 0), Math.max(0, vw - size));
  const y = Math.min(Math.max(0, Number(pos && pos.y) || 0), Math.max(0, vh - size));
  return { x, y };
}

export function mount(win = globalThis) {
  const doc = win.document;
  if (!doc || !doc.documentElement) return false;
  if (win.__ARENAKIT_EMBED__ && win.__ARENAKIT_EMBED__.root) return false; // already mounted (idempotent)
  if (typeof doc.createElement !== 'function') return false;
  const existing = doc.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('style', 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');
  const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = `<style>${shadowCss(CSS)}\n${EMBED_CSS}</style>`
    + '<button class="ak-fab" type="button" aria-label="ArenaKit">AK</button>'
    + `<div class="ak-panel" data-open="false" role="dialog" aria-label="ArenaKit"><div class="ak-shell">${MARKUP}</div></div>`;
  (doc.body || doc.documentElement).appendChild(host);

  const fab = root.querySelector('.ak-fab');
  const panel = root.querySelector('.ak-panel');
  const head = root.querySelector('.ak-head');
  const close = doc.createElement('button');
  close.className = 'ak-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  if (head) head.appendChild(close);

  const isOpen = () => panel.dataset.open === 'true';
  const setOpen = (v) => { panel.dataset.open = v ? 'true' : 'false'; fab.style.display = v ? 'none' : ''; };
  const api = {
    root, host,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    isOpen,
    alert: (on) => { fab.dataset.alert = on ? 'true' : 'false'; },
  };
  close.addEventListener('click', api.close);

  // FAB: tap toggles, drag moves (pointer events; a 6px threshold separates the two).
  let drag = null;
  const place = (pos) => {
    const p = clampPos(pos, win.innerWidth || 360, win.innerHeight || 640);
    fab.style.left = p.x + 'px'; fab.style.top = p.y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
    return p;
  };
  try {
    const saved = JSON.parse(win.localStorage.getItem(FAB_POS_KEY) || 'null');
    if (saved && typeof saved === 'object') place(saved);
  } catch (_) { /* storage blocked: default corner */ }
  fab.addEventListener('pointerdown', (e) => {
    const r = fab.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    try { fab.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.last = place({ x: drag.ox + dx, y: drag.oy + dy });
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (d.moved) { try { win.localStorage.setItem(FAB_POS_KEY, JSON.stringify(d.last)); } catch (_) { /* ignore */ } }
    else api.toggle();
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) drag = null; });

  win.__ARENAKIT_EMBED__ = api;
  return true;
}
