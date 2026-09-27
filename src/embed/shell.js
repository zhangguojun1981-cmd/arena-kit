/* Embedded dock shell (Android).
 *
 * Mobile Tauri gives us exactly one webview per window, so the side dock that
 * desktop renders in its own webview is mounted INSIDE the arena.ai page
 * instead, following the reference app's (arena-trace-android) UI:
 *
 *   floating ball  neon quota ring (arc length = remaining %, blue ≥ 20 %,
 *                  amber 10–19 %, red < 10 %) on an obsidian core; the centre
 *                  shows the quota % and/or the model (orange-yellow when the
 *                  turn was routed to a different model). Draggable.
 *   gestures       single tap → radial dock (探针 / 清理 / 刷新)
 *                  double tap → panel · long press → 会话探针 quick send
 *   panel          floating card (rounded, elevated, draggable by its header)
 *                  hosting the very same dock markup (dock.html body) and
 *                  stylesheet (dock.css) in a shadow root, so arena's CSS and
 *                  ours never touch. A scrim behind it collapses everything.
 *
 * scripts/bundle-dock.mjs packs this file, dock.js and src/lib into one classic
 * script (src/embed/dock-embedded.gen.js) that Rust appends to the mobile init
 * bundle. mount(win) builds the DOM and publishes `win.__ARENAKIT_EMBED__`
 * ({ root, host, open, close, toggle, isOpen, alert, setBall, onAction }) which
 * dock.js reads at module evaluation time — the bundle calls mount() first. */
import { CSS, MARKUP } from './assets.gen.js';

export const HOST_ID = 'arenakit-embed';
const FAB_POS_KEY = 'arenakit.fab.pos';
const PANEL_POS_KEY = 'arenakit.panel.pos';
export const BALL_SIZE = 64;      // reference: 64dp core + glow band
const TAP_SLOP = 6;               // px before a press becomes a drag
const DOUBLE_TAP_MS = 260;
const LONG_PRESS_MS = 550;
const RING_R = 27;                // ring radius in the 76×76 viewBox
const RING_C = 2 * Math.PI * RING_R;

/* dock.css targets a standalone document; retarget its document-level rules to
 * the shadow root (`:host` carries the CSS variables, `.ak-shell` is "body"). */
export function shadowCss(css) {
  return String(css)
    // :root[data-theme="light"] → :host([data-theme="light"]), :root:not(…) → :host(:not(…))
    .replace(/:root(\[[^\]]*\])/g, ':host($1)')
    .replace(/:root:not\(([^)]*)\)/g, ':host(:not($1))')
    .replace(/(^|[\n\s]):root\s*\{/g, '$1:host {')
    .replace(/(^|\n)html,\s*body\s*\{/g, '$1.ak-shell {');
}

/* Neon palette by quota health (reference FloatingBallView.neonPalette /
 * PulseBar.colorFor). Unknown percent → dim blue full circle. */
export function ringPalette(percent) {
  const p = percent === null || percent === undefined || percent === '' ? NaN : Number(percent);
  if (!Number.isFinite(p)) return { base: '#2563FF', bright: '#4CE3FF', dim: true };
  if (p < 10) return { base: '#E11D2A', bright: '#FF7A7A', dim: false };
  if (p < 20) return { base: '#FF8A00', bright: '#FFC85C', dim: false };
  return { base: '#2563FF', bright: '#4CE3FF', dim: false };
}

/* Font size (px) that fits `text` into `maxWidth` at ~0.58 em per char (CJK counts double). */
export function fitFont(text, base, maxWidth, min = 7) {
  const t = String(text || '');
  let units = 0;
  for (const ch of t) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.58;
  const w = units * base;
  return w > maxWidth && w > 0 ? Math.max(min, Math.floor(base * maxWidth / w)) : base;
}

export const EMBED_CSS = `
:host { all: initial; }
.ak-wrap {
  position: fixed; right: 12px; bottom: calc(96px + env(safe-area-inset-bottom, 0px));
  width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; z-index: 2147483001;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
}
.ak-fab {
  position: absolute; inset: 0; width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; padding: 0; margin: 0;
  border: 0; border-radius: 50%; background: transparent; cursor: pointer; overflow: visible;
  font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  -webkit-tap-highlight-color: transparent; touch-action: none;
}
.ak-fab svg { position: absolute; left: -6px; top: -6px; width: ${BALL_SIZE + 12}px; height: ${BALL_SIZE + 12}px; overflow: visible; pointer-events: none; }
.ak-ring-glow { transform-origin: 38px 38px; transform: rotate(-90deg); opacity: .55; animation: ak-breathe 2.6s ease-in-out infinite; }
.ak-ring-arc { transform-origin: 38px 38px; transform: rotate(-90deg); }
.ak-ring-comet { transform-origin: 38px 38px; animation: ak-sweep 2.4s linear infinite; }
.ak-ring-track { opacity: .18; }
.ak-fab[data-dim="true"] .ak-ring-arc, .ak-fab[data-dim="true"] .ak-ring-glow { opacity: .35; animation: none; }
.ak-fab[data-dim="true"] .ak-ring-comet { display: none; }
.ak-fab[data-alert="true"] .ak-core-rim { stroke: #E11D2A; stroke-width: 2; animation: ak-blink 1s steps(2, start) infinite; }
.ak-fab-text {
  position: absolute; inset: 7px; border-radius: 50%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1px; color: #fff; text-align: center; pointer-events: none;
}
.ak-fab-top { font-weight: 700; font-size: 15px; line-height: 1.1; white-space: nowrap; max-width: 100%; overflow: hidden; }
.ak-fab-bottom { font-weight: 400; font-size: 9px; line-height: 1.1; color: #B7C4D6; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.ak-fab:not([data-model="false"]) .ak-fab-bottom { font-weight: 700; color: #fff; }
.ak-fab[data-routed="true"] .ak-fab-top, .ak-fab[data-routed="true"] .ak-fab-bottom { color: #FFB300; }
.ak-fab[data-routed="true"][data-model="mixed"] .ak-fab-top { color: #fff; }
@keyframes ak-sweep { to { transform: rotate(360deg); } }
@keyframes ak-breathe { 0%, 100% { opacity: .35; } 50% { opacity: .8; } }
@keyframes ak-blink { 50% { opacity: .2; } }

/* radial dock: neon pill with the three quick actions, hugging the ball */
.ak-dock {
  position: absolute; top: 50%; right: calc(100% - 6px); transform: translateY(-50%) scale(.6); transform-origin: right center;
  display: flex; gap: 8px; padding: 6px 14px 6px 8px; border-radius: 28px;
  background: linear-gradient(90deg, rgba(10,12,18,.9), rgba(22,27,38,.95)); border: 1px solid rgba(76,227,255,.3);
  box-shadow: 0 6px 18px rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: transform .16s ease-out, opacity .16s ease-out;
}
.ak-wrap[data-side="right"] .ak-dock { right: auto; left: calc(100% - 6px); transform-origin: left center; padding: 6px 8px 6px 14px; }
.ak-wrap[data-dock="true"] .ak-dock { transform: translateY(-50%) scale(1); opacity: 1; pointer-events: auto; }
.ak-dock button {
  width: 44px; height: 44px; border-radius: 22px; border: 1px solid rgba(76,227,255,.2); padding: 0; cursor: pointer;
  background: radial-gradient(circle at 50% 40%, #20283A, #0A0C12); color: #fff; display: flex; align-items: center; justify-content: center;
  -webkit-tap-highlight-color: transparent;
}
.ak-dock button:active { border-color: #4CE3FF; }
.ak-dock button svg { width: 22px; height: 22px; fill: #fff; }
.ak-dock button[data-busy="true"] { border-color: #FFB300; }

/* scrim behind the open panel / dock (tap collapses) */
.ak-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.28); z-index: 2147483000; opacity: 0; pointer-events: none; transition: opacity .16s; }
.ak-scrim[data-show="true"] { opacity: 1; pointer-events: auto; }

/* the panel card (reference: rounded 16dp card anchored top-right, draggable) */
.ak-panel {
  position: fixed; top: calc(12px + env(safe-area-inset-top, 0px)); right: 12px;
  width: min(380px, calc(100vw - 24px)); max-height: min(78vh, 680px);
  z-index: 2147483002; background: var(--ak-bg); color: var(--ak-fg);
  border-radius: 16px; box-shadow: var(--ak-shadow); border: 1px solid var(--ak-line);
  display: flex; flex-direction: column; overflow: hidden;
  opacity: 0; transform: scale(.96); transform-origin: top right; pointer-events: none;
  transition: transform .16s ease-out, opacity .16s ease-out;
}
.ak-panel[data-open="true"] { opacity: 1; transform: none; pointer-events: auto; }
.ak-shell { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; height: auto; overscroll-behavior: contain; }
.ak-shell .ak-head { cursor: grab; touch-action: none; }
.ak-close { margin-left: 2px; }
`;

const ICONS = {
  probe: '<svg viewBox="0 0 24 24"><path d="M12,2 A10,10 0 1 0 12,22 A10,10 0 1 0 12,2 Z M12,4 A8,8 0 1 1 12,20 A8,8 0 1 1 12,4 Z"/><path d="M12,7 A5,5 0 1 0 12,17 A5,5 0 1 0 12,7 Z M12,9 A3,3 0 1 1 12,15 A3,3 0 1 1 12,9 Z"/><path d="M11,11 h2 v2 h-2 z"/></svg>',
  cleanup: '<svg viewBox="0 0 24 24"><path d="M19.4,4.6 L21,6.2 L14.8,12.4 L13.2,10.8 Z"/><path d="M12.4,11.6 L14,13.2 L11.5,15.7 C10.2,17 8.4,17.6 6.5,17.4 L3,20 L3.6,16.2 C3.4,14.4 4,12.6 5.3,11.3 L7.8,8.8 L9.4,10.4 Z M6.7,15.7 C7.7,15.8 8.7,15.4 9.4,14.7 L11.2,12.9 L10.9,12.6 L9,14.5 C8.3,15.2 7.6,15.5 6.7,15.7 Z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M12,5 V2 L8,6 L12,10 V7 C14.76,7 17,9.24 17,12 C17,14.76 14.76,17 12,17 C9.24,17 7,14.76 7,12 H5 C5,15.87 8.13,19 12,19 C15.87,19 19,15.87 19,12 C19,8.13 15.87,5 12,5 Z"/></svg>',
};

function ballSvg() {
  return '<svg viewBox="0 0 76 76" aria-hidden="true">'
    + '<defs>'
    + '<radialGradient id="ak-core" cx="50%" cy="42%" r="55%"><stop offset="0" stop-color="#161B26"/><stop offset="1" stop-color="#0A0C12"/></radialGradient>'
    + '<filter id="ak-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>'
    + `<mask id="ak-lit"><circle class="ak-ring-mask" cx="38" cy="38" r="${RING_R}" fill="none" stroke="#fff" stroke-width="6" stroke-dasharray="${RING_C} ${RING_C}" transform="rotate(-90 38 38)"/></mask>`
    + '</defs>'
    + `<circle cx="38" cy="38" r="${RING_R - 3.5}" fill="url(#ak-core)"/>`
    + `<circle class="ak-core-rim" cx="38" cy="38" r="${RING_R - 3.5}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="1"/>`
    + `<circle class="ak-ring-track" cx="38" cy="38" r="${RING_R}" fill="none" stroke="#fff" stroke-width="3.2"/>`
    + `<circle class="ak-ring-glow" cx="38" cy="38" r="${RING_R}" fill="none" stroke="#2563FF" stroke-width="5" stroke-linecap="round" stroke-dasharray="${RING_C} ${RING_C}" filter="url(#ak-blur)"/>`
    + `<circle class="ak-ring-arc" cx="38" cy="38" r="${RING_R}" fill="none" stroke="#2563FF" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="${RING_C} ${RING_C}"/>`
    + `<g mask="url(#ak-lit)"><circle class="ak-ring-comet" cx="38" cy="38" r="${RING_R}" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="10 ${RING_C}" opacity=".9"/></g>`
    + '</svg>';
}

/* Clamp a saved/dragged position to the viewport. */
export function clampPos(pos, vw, vh, size = BALL_SIZE) {
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
    + '<div class="ak-scrim" data-show="false"></div>'
    + '<div class="ak-wrap" data-dock="false" data-side="left">'
    + '<div class="ak-dock" role="toolbar" aria-label="快捷操作">'
    + `<button type="button" data-dock-action="probe" aria-label="探针" title="自动探针">${ICONS.probe}</button>`
    + `<button type="button" data-dock-action="cleanup" aria-label="清理" title="自动清理">${ICONS.cleanup}</button>`
    + `<button type="button" data-dock-action="refresh" aria-label="刷新" title="刷新页面">${ICONS.refresh}</button>`
    + '</div>'
    + `<button class="ak-fab" type="button" aria-label="ArenaKit" data-dim="true" data-model="false" data-routed="false">${ballSvg()}`
    + '<span class="ak-fab-text"><span class="ak-fab-top">…</span><span class="ak-fab-bottom"></span></span></button>'
    + '</div>'
    + `<div class="ak-panel" data-open="false" role="dialog" aria-label="ArenaKit"><div class="ak-shell">${MARKUP}</div></div>`;
  (doc.body || doc.documentElement).appendChild(host);

  const wrap = root.querySelector('.ak-wrap');
  const fab = root.querySelector('.ak-fab');
  const panel = root.querySelector('.ak-panel');
  const scrim = root.querySelector('.ak-scrim');
  const tools = root.querySelector('.ak-head-tools') || root.querySelector('.ak-head');
  const close = doc.createElement('button');
  close.className = 'ak-icon-btn ak-close';
  close.type = 'button';
  close.setAttribute('aria-label', '收起');
  close.textContent = '✕';
  if (tools) tools.appendChild(close);

  const vw = () => win.innerWidth || 360;
  const vh = () => win.innerHeight || 640;
  let actionHandler = null;
  const fire = (name) => { if (typeof actionHandler === 'function') { try { actionHandler(name); } catch (e) { console.warn('[arenakit] embed action', name, e); } } };

  const isOpen = () => panel.dataset.open === 'true';
  const dockOpen = () => wrap.dataset.dock === 'true';
  const syncScrim = () => { scrim.dataset.show = isOpen() || dockOpen() ? 'true' : 'false'; };
  const setDock = (v) => { wrap.dataset.dock = v ? 'true' : 'false'; syncScrim(); };
  const setOpen = (v) => {
    panel.dataset.open = v ? 'true' : 'false';
    if (v) setDock(false);
    wrap.style.visibility = v ? 'hidden' : '';
    syncScrim();
  };

  const api = {
    root, host,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    isOpen,
    /* reply-monitor anomaly: red blinking rim (reference alert ring). */
    alert: (on) => { fab.dataset.alert = on ? 'true' : 'false'; },
    /* Ball display: { percent (0..100 | null), top, bottom, isModel, routed }. */
    setBall: (b) => setBall(b || {}),
    /* Quick actions: 'probe' | 'cleanup' | 'refresh' (radial dock), 'quick' (long press), 'panel' (double tap). */
    onAction: (fn) => { actionHandler = fn; },
    /* Mark a dock button busy (probe / cleanup running). */
    setBusy: (name, on) => { const b = root.querySelector(`[data-dock-action="${name}"]`); if (b) b.dataset.busy = on ? 'true' : 'false'; },
    ballSize: BALL_SIZE,
  };
  close.addEventListener('click', api.close);
  scrim.addEventListener('click', () => { setDock(false); setOpen(false); });
  root.querySelectorAll('[data-dock-action]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const name = b.dataset.dockAction;
    setDock(false);
    fire(name);
  }));

  // ── ball rendering ──────────────────────────────────────────────────
  const arc = root.querySelector('.ak-ring-arc');
  const glow = root.querySelector('.ak-ring-glow');
  const maskArc = root.querySelector('.ak-ring-mask');
  const comet = root.querySelector('.ak-ring-comet');
  const topEl = root.querySelector('.ak-fab-top');
  const bottomEl = root.querySelector('.ak-fab-bottom');
  function setBall({ percent = null, top = '…', bottom = '', isModel = false, routed = false } = {}) {
    const p = percent !== null && percent !== undefined && percent !== '' && Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
    const pal = ringPalette(p);
    const lit = (p === null ? 1 : p / 100) * RING_C;
    const dash = `${lit} ${RING_C}`;
    if (arc) { arc.setAttribute('stroke', pal.base); arc.setAttribute('stroke-dasharray', dash); }
    if (glow) { glow.setAttribute('stroke', pal.bright); glow.setAttribute('stroke-dasharray', dash); }
    if (maskArc) maskArc.setAttribute('stroke-dasharray', dash);
    if (comet) comet.setAttribute('stroke', pal.bright);
    fab.dataset.dim = pal.dim ? 'true' : 'false';
    const t = String(top || '…');
    const btm = String(bottom || '');
    const maxW = BALL_SIZE - 18;
    topEl.textContent = t;
    topEl.style.fontSize = fitFont(t, btm ? 12 : 15, maxW) + 'px';
    bottomEl.textContent = btm;
    bottomEl.style.fontSize = fitFont(btm, 9, maxW) + 'px';
    bottomEl.style.display = btm ? '' : 'none';
    // 'mixed' = quota % on top, model below (only the model line takes the routed colour)
    fab.dataset.model = isModel ? (btm && /%$/.test(t) ? 'mixed' : 'true') : 'false';
    fab.dataset.routed = isModel && routed ? 'true' : 'false';
    fab.setAttribute('aria-label', 'ArenaKit ' + t + (btm ? ' ' + btm : ''));
  }
  setBall({});

  // ── ball: drag / tap / double tap / long press ───────────────────────
  let drag = null;
  let tapTimer = 0;
  let longTimer = 0;
  const place = (pos) => {
    const p = clampPos(pos, vw(), vh(), BALL_SIZE);
    wrap.style.left = p.x + 'px'; wrap.style.top = p.y + 'px'; wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
    wrap.dataset.side = p.x + BALL_SIZE / 2 < vw() / 2 ? 'right' : 'left'; // dock opens toward the free side
    return p;
  };
  try {
    const saved = JSON.parse(win.localStorage.getItem(FAB_POS_KEY) || 'null');
    if (saved && typeof saved === 'object') place(saved);
  } catch (_) { /* storage blocked: default corner */ }
  fab.addEventListener('pointerdown', (e) => {
    const r = wrap.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, long: false };
    try { fab.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    clearTimeout(longTimer);
    longTimer = setTimeout(() => {
      if (!drag || drag.moved) return;
      drag.long = true;
      clearTimeout(tapTimer); tapTimer = 0;
      setDock(false);
      fire('quick');
    }, LONG_PRESS_MS);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || drag.long) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    if (!drag.moved) { drag.moved = true; clearTimeout(longTimer); setDock(false); }
    drag.last = place({ x: drag.ox + dx, y: drag.oy + dy });
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(longTimer);
    if (d.long) return;
    if (d.moved) { try { win.localStorage.setItem(FAB_POS_KEY, JSON.stringify(d.last)); } catch (_) { /* ignore */ } return; }
    if (tapTimer) {            // second tap within the window → panel
      clearTimeout(tapTimer); tapTimer = 0;
      setDock(false);
      fire('panel');
      setOpen(true);
      return;
    }
    tapTimer = setTimeout(() => { tapTimer = 0; setDock(!dockOpen()); }, DOUBLE_TAP_MS);
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; clearTimeout(longTimer); } });

  // ── panel: drag by the header (buttons / inputs inside still work) ──
  const head = root.querySelector('.ak-head');
  let pdrag = null;
  const placePanel = (pos) => {
    const r = panel.getBoundingClientRect();
    const x = Math.min(Math.max(0, pos.x), Math.max(0, vw() - (r.width || 300)));
    const y = Math.min(Math.max(0, pos.y), Math.max(0, vh() - Math.min(r.height || 200, 120)));
    panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
    panel.style.transformOrigin = 'top left';
    return { x, y };
  };
  try {
    const saved = JSON.parse(win.localStorage.getItem(PANEL_POS_KEY) || 'null');
    if (saved && typeof saved === 'object' && Number.isFinite(saved.x) && Number.isFinite(saved.y)) placePanel(saved);
  } catch (_) { /* ignore */ }
  if (head) {
    head.addEventListener('pointerdown', (e) => {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('button, input, select, textarea, a')) return;
      const r = panel.getBoundingClientRect();
      pdrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, last: null };
      try { head.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    head.addEventListener('pointermove', (e) => {
      if (!pdrag || e.pointerId !== pdrag.id) return;
      const dx = e.clientX - pdrag.sx, dy = e.clientY - pdrag.sy;
      if (!pdrag.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      pdrag.moved = true;
      pdrag.last = placePanel({ x: pdrag.ox + dx, y: pdrag.oy + dy });
    });
    const pend = (e) => {
      if (!pdrag || e.pointerId !== pdrag.id) return;
      const d = pdrag; pdrag = null;
      if (d.moved && d.last) { try { win.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(d.last)); } catch (_) { /* ignore */ } }
    };
    head.addEventListener('pointerup', pend);
    head.addEventListener('pointercancel', () => { pdrag = null; });
  }

  win.__ARENAKIT_EMBED__ = api;
  return true;
}
