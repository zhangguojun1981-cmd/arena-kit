/* Embedded dock shell (Android only — macOS runs the dock in its own webview
 * next to the page and has no floating ball).
 *
 * Mobile Tauri gives us exactly one webview per window, so the dock is mounted
 * INSIDE the arena.ai page, following the reference app's (arena-trace-android)
 * overlay:
 *
 *   floating ball neon quota ring (arc = remaining %, blue ≥ 20 %, amber
 *                 10–19 %, red < 10 %, breathing glow + comet sweep) on an
 *                 obsidian core hugging a screen edge. The centre shows the
 *                 quota % and/or the model per 设置 → 悬浮球显示 (百分比 + 模型 /
 *                 百分比 / 模型; lib/pill-layout.js ballCentre); a running task
 *                 or a flash message takes the bottom line. Reply anomaly →
 *                 the rim and glow blink red (alert). Drag to move; on release
 *                 it snaps to the nearer side. Position = (side, yFraction).
 *   gestures      tap → panel · long press → quick menu (probe / session
 *                 probe / cleanup / reload / account / panel). No ⟳ zone: a
 *                 tap anywhere on the ball opens the panel (reload lives in
 *                 the quick menu, the 工具 page and pull-up).
 *   panel         bottom sheet flush with the bottom edge (grabber bar,
 *                 header with ✕, tabs); scrim tap, swipe-down on the grabber /
 *                 header or the back key closes it. It
 *                 hosts the very same dock markup (dock.html body) and
 *                 stylesheet (dock.css) in a shadow root, so arena's CSS and
 *                 ours never touch. The ball fades out while the sheet is open.
 *   extras        2 dp page-load progress bar at the top, in-shadow confirm
 *                 dialog, pull-up-to-refresh at the bottom of the conversation.
 *   keyboard      (kept for hardware keyboards / the browser preview) Esc
 *                 closes dialog → menu → sheet, ⌘/Ctrl+R / F5 reload via the
 *                 dock, ⌘[ / ⌘] page history; mouse right-click on the ball =
 *                 long press.
 *
 * scripts/bundle-dock.mjs packs this file, dock.js and src/lib into one classic
 * script (src/embed/dock-embedded.gen.js) that Rust appends to the mobile init
 * bundle. mount(win) builds the DOM and publishes `win.__ARENAKIT_EMBED__`
 * (see `api` below) which dock.js reads at module evaluation time — the bundle
 * calls mount() first. */
import { CSS, MARKUP } from './assets.gen.js';
import { pillPlacement, releasePosition, normalizeFraction, ringBand, ballCentre, PILL_MARGIN, PILL_DEFAULT_Y, SNAP_MS } from '../lib/pill-layout.js';

export const HOST_ID = 'arenakit-embed';
const PILL_POS_KEY = 'arenakit.pill.pos';
export const BALL_SIZE = 60;      // ball diameter (reference FloatingBallView: 64 dp incl. glow)
const GLOW = 8;                   // glow band drawn outside the ball box
const VB = BALL_SIZE + 2 * GLOW;  // svg viewBox / pixel size (1 unit = 1 px)
const CX = VB / 2;
export const RING_R = 29;         // neon ring radius
const CORE_R = 25;                // obsidian core radius
const RING_STROKE = 3.2;
export const RING_C = 2 * Math.PI * RING_R;
export const TAP_SLOP = 12;       // px a press may wander and still count as a tap (Android touch slop ≈ 8 dp + finger jitter)
export const TAP_MAX_MS = 700;    // click-fallback window after a pointer tap
const LONG_PRESS_MS = 500;
const PULL_THRESHOLD = 90;        // px of upward drag at the bottom → refresh
const LOAD_STALL_MS = 30_000;     // reference: give up on a stalled load
/* Backwards-compatible aliases (older tests / callers). */
export const PILL_HEIGHT = BALL_SIZE;
export const RING_SIZE = 2 * RING_R;

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
 * PulseBar.colorFor): base = arc, bright = glow / comet. Unknown percent →
 * dim blue full circle (no comet). */
export function ringPalette(percent) {
  const band = ringBand(percent);
  if (band === 'danger') return { band, base: '#E11D2A', bright: '#FF7A7A', dim: false };
  if (band === 'warning') return { band, base: '#FF8A00', bright: '#FFC85C', dim: false };
  if (band === 'ok') return { band, base: '#2F6BFF', bright: '#4CE3FF', dim: false };
  return { band, base: '#2F6BFF', bright: '#4CE3FF', dim: true };
}

/* Font size (px) that fits `text` into `maxWidth` at ~0.58 em per char (CJK counts double). */
export function fitFont(text, base, maxWidth, min = 7) {
  const t = String(text || '');
  let units = 0;
  for (const ch of t) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.58;
  const w = units * base;
  return w > maxWidth && w > 0 ? Math.max(min, Math.floor(base * maxWidth / w)) : base;
}

/* Keep a free-floating box inside the viewport (used while dragging). */
export function clampPos(pos, vw, vh, size = BALL_SIZE, w = size) {
  const x = Number(pos && pos.x) || 0;
  const y = Number(pos && pos.y) || 0;
  return {
    x: Math.max(0, Math.min(x, Math.max(0, vw - w))),
    y: Math.max(0, Math.min(y, Math.max(0, vh - size))),
  };
}

export const EMBED_CSS = `
:host { all: initial; }
.ak-ball-wrap {
  position: fixed; left: auto; right: ${PILL_MARGIN}px; top: 120px; z-index: 2147483001;
  width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  transition: opacity .15s ease-out;
}
.ak-ball-wrap[data-snap="true"] { transition: left ${SNAP_MS}ms cubic-bezier(.2,.8,.3,1), top ${SNAP_MS}ms cubic-bezier(.2,.8,.3,1), opacity .15s ease-out; }
.ak-ball-wrap[data-hidden="true"] { opacity: 0; pointer-events: none; }
.ak-ball {
  position: absolute; inset: 0; width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; padding: 0; margin: 0; border: 0; border-radius: 50%;
  background: transparent; cursor: pointer; overflow: visible; -webkit-tap-highlight-color: transparent; touch-action: none;
  font: 700 15px/1.1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif;
}
.ak-ball:active .ak-ball-core { filter: brightness(1.25); }
.ak-ball svg { position: absolute; left: -${GLOW}px; top: -${GLOW}px; width: ${VB}px; height: ${VB}px; overflow: visible; pointer-events: none; }
.ak-ball-track { fill: none; stroke: #fff; stroke-width: ${RING_STROKE}; opacity: .16; }
.ak-ball-glow { fill: none; stroke-width: 6; stroke-linecap: round; transform-origin: ${CX}px ${CX}px; transform: rotate(-90deg); opacity: .6; animation: ak-breathe 2.6s ease-in-out infinite; transition: stroke-dasharray .4s; }
.ak-ball-arc { fill: none; stroke-width: ${RING_STROKE}; stroke-linecap: round; transform-origin: ${CX}px ${CX}px; transform: rotate(-90deg); transition: stroke-dasharray .4s; }
.ak-ball-comet { fill: none; stroke: #fff; stroke-width: ${RING_STROKE}; stroke-linecap: round; transform-origin: ${CX}px ${CX}px; animation: ak-sweep 2.4s linear infinite; opacity: .9; }
.ak-ball-rim { fill: none; stroke: rgba(255,255,255,.1); stroke-width: 1; }
.ak-ball[data-dim="true"] .ak-ball-arc, .ak-ball[data-dim="true"] .ak-ball-glow { opacity: .3; animation: none; }
.ak-ball[data-dim="true"] .ak-ball-comet { display: none; }
.ak-ball[data-busy="true"] .ak-ball-comet { animation-duration: .9s; display: block; }
.ak-ball[data-refreshing="true"] .ak-ball-comet { animation-duration: .6s; display: block; stroke: #fff; }
.ak-ball-text {
  position: absolute; inset: 7px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; color: #fff; text-align: center; pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,.6);
}
.ak-ball-top { font-weight: 700; font-size: 15px; line-height: 1.1; white-space: nowrap; max-width: 100%; overflow: hidden; }
.ak-ball-bottom { font-weight: 500; font-size: 9px; line-height: 1.15; color: #B7C4D6; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.ak-ball-bottom:empty { display: none; }
.ak-ball[data-kind="model"] .ak-ball-bottom { color: #E6EDF7; font-weight: 600; }
.ak-ball[data-tone="routed"][data-kind="model"] .ak-ball-bottom, .ak-ball[data-tone="routed"][data-mode="model"] .ak-ball-top { color: #FFB300; }
.ak-ball[data-kind="transient"] .ak-ball-bottom, .ak-ball[data-kind="transient"][data-mode="model"] .ak-ball-top { color: #4CE3FF; }
.ak-ball[data-kind="hint"] .ak-ball-bottom { color: #8FA0B8; }
/* alert (reply anomaly, dock EMBED.alert): the whole ball blinks red */
.ak-ball[data-alert="true"] .ak-ball-rim { stroke: #FF3B30; stroke-width: 2.4; animation: ak-blink .8s steps(2, start) infinite; }
.ak-ball[data-alert="true"] .ak-ball-arc, .ak-ball[data-alert="true"] .ak-ball-glow, .ak-ball[data-alert="true"] .ak-ball-comet { stroke: #FF3B30; opacity: 1; animation: none; }
.ak-ball[data-alert="true"] .ak-ball-glow { animation: ak-blink .8s steps(2, start) infinite; }
.ak-ball[data-alert="true"] .ak-ball-text { color: #FF7A7A; }
@keyframes ak-sweep { to { transform: rotate(360deg); } }
@keyframes ak-breathe { 0%, 100% { opacity: .35; } 50% { opacity: .85; } }
@keyframes ak-blink { 50% { opacity: .15; } }

/* page-load progress: 2 dp brand bar at the very top (reference page_progress) */
.ak-progress { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 2147483005; pointer-events: none; opacity: 0; transition: opacity .25s; }
.ak-progress[data-show="true"] { opacity: 1; }
.ak-progress-fill { height: 100%; width: 0; background: var(--ak-brand); transition: width .3s ease-out; }

/* scrim behind the open sheet / menu / dialog */
.ak-scrim { position: fixed; inset: 0; background: var(--ak-scrim); z-index: 2147483000; opacity: 0; pointer-events: none; transition: opacity .2s; }
.ak-scrim[data-show="true"] { opacity: 1; pointer-events: auto; }

/* bottom sheet (reference panel_sheet.xml: flush with the bottom, 20 dp top corners) */
.ak-sheet {
  position: fixed; left: 50%; bottom: 0; width: min(560px, 100vw); max-height: 85vh; max-height: min(85vh, 85dvh);
  z-index: 2147483002; background: var(--ak-bg); color: var(--ak-fg);
  border-radius: 20px 20px 0 0; box-shadow: 0 -6px 30px rgba(0,0,0,.28);
  display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transform: translate(-50%, 102%); pointer-events: none;
  transition: transform .2s cubic-bezier(.2,.8,.3,1);
}
.ak-sheet[data-open="true"] { transform: translate(-50%, 0); pointer-events: auto; }
.ak-sheet[data-dragging="true"] { transition: none; }
.ak-sheet-handle { flex: none; display: flex; justify-content: center; padding: 8px 0 2px; touch-action: none; cursor: grab; }
.ak-sheet-handle i { display: block; width: 32px; height: 4px; border-radius: 2px; background: var(--ak-surface-high); }
.ak-sheet-top { flex: none; touch-action: none; }
.ak-sheet-top #ak-log { touch-action: pan-y; }
.ak-shell { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; height: auto; overscroll-behavior: contain; }
.ak-close { margin-left: 2px; }

/* long-press quick menu (reference PopupMenu) */
.ak-menu {
  position: fixed; z-index: 2147483003; min-width: 188px; padding: 6px 0; border-radius: 12px;
  background: var(--ak-bg); color: var(--ak-fg); box-shadow: 0 8px 28px rgba(0,0,0,.28); border: 1px solid var(--ak-line);
  opacity: 0; transform: scale(.96); transform-origin: top right; pointer-events: none; transition: opacity .12s, transform .12s;
  font: 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif;
}
.ak-menu[data-show="true"] { opacity: 1; transform: none; pointer-events: auto; }
.ak-menu button { display: block; width: 100%; padding: 12px 18px; margin: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ak-menu button:active { background: var(--ak-surface-low); }
.ak-menu button[data-danger="true"] { color: var(--ak-danger); }
.ak-menu button[disabled] { opacity: .4; }

/* confirm dialog (reference MaterialAlertDialog) */
.ak-dialog { position: fixed; inset: 0; z-index: 2147483004; display: none; align-items: center; justify-content: center; padding: 24px; }
.ak-dialog[data-show="true"] { display: flex; }
.ak-dialog-card { width: min(340px, 100%); border-radius: 20px; padding: 20px 20px 12px; background: var(--ak-bg); color: var(--ak-fg); box-shadow: 0 12px 40px rgba(0,0,0,.35); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.ak-dialog-title { font-size: 17px; font-weight: 600; margin-bottom: 8px; }
.ak-dialog-msg { color: var(--ak-sub); white-space: pre-line; }
.ak-dialog-btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 16px; }
.ak-dialog-btns button { border: 0; background: transparent; color: var(--ak-brand); font: 600 14px/1 inherit; font-family: inherit; padding: 10px 14px; border-radius: 20px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ak-dialog-btns button[data-ok] { background: var(--ak-brand); color: var(--ak-on-brand); }

/* pull-up-to-refresh hint (bottom of the conversation) */
.ak-pull { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 20px); z-index: 2147483001;
  padding: 8px 14px; border-radius: 18px; background: var(--ak-pill-bg); border: 1px solid var(--ak-pill-stroke); color: var(--ak-sub); box-shadow: 0 2px 8px rgba(0,0,0,.14);
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif; opacity: 0; pointer-events: none; transition: opacity .12s, transform .12s; display: flex; align-items: center; gap: 8px; }
.ak-pull[data-show="true"] { opacity: 1; transform: translate(-50%, 0); }
.ak-pull[data-armed="true"] { color: var(--ak-brand); border-color: var(--ak-brand); }
.ak-pull svg { width: 16px; height: 16px; fill: currentColor; transition: transform .15s; }
.ak-pull[data-armed="true"] svg { transform: rotate(180deg); }
`;

export const ICONS = {
  refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>',
};

function ballSvg() {
  const full = `${RING_C.toFixed(3)} ${RING_C.toFixed(3)}`;
  return `<svg viewBox="0 0 ${VB} ${VB}" aria-hidden="true">`
    + '<defs>'
    + '<radialGradient id="ak-core" cx="50%" cy="42%" r="55%"><stop offset="0" stop-color="#161B26"/><stop offset="1" stop-color="#0A0C12"/></radialGradient>'
    + '<filter id="ak-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>'
    + `<mask id="ak-lit"><circle class="ak-ball-mask" cx="${CX}" cy="${CX}" r="${RING_R}" fill="none" stroke="#fff" stroke-width="6" stroke-dasharray="${full}" transform="rotate(-90 ${CX} ${CX})"/></mask>`
    + '</defs>'
    + `<circle class="ak-ball-core" cx="${CX}" cy="${CX}" r="${CORE_R}" fill="url(#ak-core)"/>`
    + `<circle class="ak-ball-rim" cx="${CX}" cy="${CX}" r="${CORE_R}"/>`
    + `<circle class="ak-ball-track" cx="${CX}" cy="${CX}" r="${RING_R}"/>`
    + `<circle class="ak-ball-glow" cx="${CX}" cy="${CX}" r="${RING_R}" stroke="#4CE3FF" stroke-dasharray="${full}" filter="url(#ak-blur)"/>`
    + `<circle class="ak-ball-arc" data-band="unknown" cx="${CX}" cy="${CX}" r="${RING_R}" stroke="#2F6BFF" stroke-dasharray="${full}"/>`
    + `<g mask="url(#ak-lit)"><circle class="ak-ball-comet" cx="${CX}" cy="${CX}" r="${RING_R}" stroke-dasharray="10 ${RING_C.toFixed(3)}"/></g>`
    + '</svg>';
}

/* Build the shell inside `win.document`. Returns false when already mounted. */
export function mount(win) {
  const doc = win && win.document;
  if (!doc || typeof doc.createElement !== 'function') return false;
  if (win.__ARENAKIT_EMBED__ && win.__ARENAKIT_EMBED__.root) return false;
  const existing = doc.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('style', 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');
  const root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = `<style>${shadowCss(CSS)}\n${EMBED_CSS}</style>`
    + '<div class="ak-progress" data-show="false"><div class="ak-progress-fill"></div></div>'
    + '<div class="ak-scrim" data-show="false"></div>'
    + '<div class="ak-ball-wrap" data-side="right" data-hidden="false" data-snap="false">'
    + '<div class="ak-ball" role="button" tabindex="0" aria-label="ArenaKit" data-busy="false" data-refreshing="false" data-alert="false" data-dim="true" data-mode="percent-model" data-kind="percent" data-tone="muted">'
    + ballSvg()
    + '<span class="ak-ball-text"><span class="ak-ball-top">…</span><span class="ak-ball-bottom"></span></span>'
    + '</div></div>'
    + '<div class="ak-menu" data-show="false" role="menu" aria-label="快捷操作"></div>'
    + '<div class="ak-sheet" data-open="false" data-dragging="false" role="dialog" aria-label="ArenaKit">'
    + '<div class="ak-sheet-handle" aria-hidden="true"><i></i></div>'
    + '<div class="ak-sheet-top"></div>'
    + `<div class="ak-shell">${MARKUP}</div></div>`
    + '<div class="ak-dialog" data-show="false" role="alertdialog"><div class="ak-dialog-card"><div class="ak-dialog-title"></div><div class="ak-dialog-msg"></div>'
    + '<div class="ak-dialog-btns"><button type="button" data-cancel>取消</button><button type="button" data-ok>确定</button></div></div></div>'
    + `<div class="ak-pull" data-show="false" data-armed="false">${ICONS.arrowUp}<span>上拉刷新</span></div>`;
  (doc.body || doc.documentElement).appendChild(host);

  const wrap = root.querySelector('.ak-ball-wrap');
  const pill = root.querySelector('.ak-ball');
  const sheet = root.querySelector('.ak-sheet');
  const shell = root.querySelector('.ak-shell');
  const scrim = root.querySelector('.ak-scrim');
  const menu = root.querySelector('.ak-menu');
  const dialog = root.querySelector('.ak-dialog');
  const progress = root.querySelector('.ak-progress');
  const progressFill = root.querySelector('.ak-progress-fill');
  const pullHint = root.querySelector('.ak-pull');
  // Reference sheet: header / quota / activity / tabs stay put, only the
  // page content scrolls — move those blocks above the scroll container.
  const sheetTop = root.querySelector('.ak-sheet-top');
  if (sheetTop && shell && typeof shell.querySelector === 'function') {
    for (const sel of ['.ak-head', '.ak-activity', '#ak-log', '.ak-tabs']) {
      const el = shell.querySelector(sel);
      if (el) sheetTop.appendChild(el);
    }
  }
  // ✕ (收起) sits in the header's right-side slot (dock.html .ak-head-tools);
  // the grabber bar above the header stays (swipe it down to close).
  const tools = root.querySelector('.ak-head-tools') || root.querySelector('.ak-head-row') || root.querySelector('.ak-head');
  const close = doc.createElement('button');
  close.className = 'ak-icon-btn ak-close';
  close.type = 'button';
  close.setAttribute('aria-label', '收起');
  close.textContent = '✕';
  if (tools) tools.appendChild(close);

  const vw = () => win.innerWidth || 360;
  const vh = () => win.innerHeight || 640;
  const later = (fn, ms) => setTimeout(fn, ms);
  const rectOf = (el) => {
    const r = el.getBoundingClientRect() || {};
    const left = Number(r.left) || 0, top = Number(r.top) || 0, width = Number(r.width) || 0, height = Number(r.height) || 0;
    return { left, top, width, height, right: Number.isFinite(r.right) ? r.right : left + width, bottom: Number.isFinite(r.bottom) ? r.bottom : top + height };
  };
  const onWin = (type, fn, opts) => { if (typeof win.addEventListener === 'function') win.addEventListener(type, fn, opts); };
  let actionHandler = null;
  let menuProvider = null;
  const fire = (name, arg) => { if (typeof actionHandler === 'function') { try { actionHandler(name, arg); } catch (e) { console.warn('[arenakit] embed action', name, e); } } };
  /* Native shell (Android MainActivity overlay) — optional one-way channel. */
  const native = (msg) => {
    const n = win.ArenaKitAndroid;
    if (n && typeof n.postMessage === 'function') { try { n.postMessage(JSON.stringify(msg)); } catch (_) { /* ignore */ } }
  };

  // ── open / close state ────────────────────────────────────────────────
  const isOpen = () => sheet.dataset.open === 'true';
  const menuOpen = () => menu.dataset.show === 'true';
  const dialogOpen = () => dialog.dataset.show === 'true';
  const syncScrim = () => { scrim.dataset.show = isOpen() || menuOpen() ? 'true' : 'false'; };
  const syncPillHidden = () => { wrap.dataset.hidden = isOpen() ? 'true' : 'false'; }; // ball fades out under the sheet
  // After a pointer-initiated open, swallow the synthetic click Blink dispatches
  // on the same touch point (it would otherwise hit the scrim/sheet under the
  // finger and immediately close the panel we just opened). Window is ~600 ms
  // to cover slow pointerup→click on Android WebView.
  let pointerGuardUntil = 0;
  const guardWindowMs = 600;
  const consumeGuard = () => pointerGuardUntil > Date.now();
  const armGuard = () => { pointerGuardUntil = Date.now() + guardWindowMs; };
  // Capture-phase click listener inside the shadow root: anything during the
  // guard is consumed before our scrim/sheet listeners run. This is the only
  // fix that survives both the scrim and the sheet (sheet children also get a
  // synthesized click when the touch lands on the new overlay). When the guard
  // has expired, the listener is a no-op so real scrim taps still close.
  root.addEventListener('click', (e) => {
    if (consumeGuard()) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  const setMenu = (show) => { menu.dataset.show = show ? 'true' : 'false'; if (!show) menu.innerHTML = ''; syncScrim(); };
  const setOpen = (v, opts) => {
    const was = isOpen();
    sheet.dataset.open = v ? 'true' : 'false';
    sheet.style.transform = '';
    if (v) setMenu(false);
    syncPillHidden();
    syncScrim();
    if (v && (opts && opts.pointer)) armGuard();
    if (was !== !!v) { native({ cmd: 'panel', open: !!v }); fire(v ? 'open' : 'close'); }
  };

  // ── ball rendering ────────────────────────────────────────────────────
  const arc = root.querySelector('.ak-ball-arc');
  const glow = root.querySelector('.ak-ball-glow');
  const maskArc = root.querySelector('.ak-ball-mask');
  const comet = root.querySelector('.ak-ball-comet');
  const topEl = root.querySelector('.ak-ball-top');
  const bottomEl = root.querySelector('.ak-ball-bottom');
  const TEXT_W = BALL_SIZE - 14; // .ak-ball-text inset 7 px each side
  let pillState = { percent: null, label: '', tone: 'muted', busy: false, mode: 'percent-model' };
  /* { percent (0..100 | null), label, tone ('normal'|'routed'|'muted'|'active'), busy, mode } */
  function setPill(p = {}) {
    pillState = { ...pillState, ...p };
    const raw = pillState.percent;
    const pct = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Math.min(100, Math.round(Number(raw)))) : null;
    const pal = ringPalette(pct);
    const lit = ((pct === null ? 100 : pct) / 100) * RING_C;
    const dash = `${lit.toFixed(3)} ${RING_C.toFixed(3)}`;
    if (arc) { arc.setAttribute('data-band', pal.band); arc.dataset.band = pal.band; arc.setAttribute('stroke', pal.base); arc.setAttribute('stroke-dasharray', dash); }
    if (glow) { glow.setAttribute('stroke', pal.bright); glow.setAttribute('stroke-dasharray', dash); }
    if (maskArc) maskArc.setAttribute('stroke-dasharray', dash);
    if (comet) comet.setAttribute('stroke', pal.bright);
    pill.dataset.dim = pal.dim ? 'true' : 'false';
    const mode = ['percent-model', 'percent', 'model'].includes(pillState.mode) ? pillState.mode : 'percent-model';
    const tone = ['normal', 'routed', 'muted', 'active'].includes(pillState.tone) ? pillState.tone : 'normal';
    const c = ballCentre({ mode, percent: pct, text: pillState.label, tone });
    topEl.textContent = c.top;
    topEl.style.fontSize = fitFont(c.top, c.bottom ? 13 : 15, TEXT_W) + 'px';
    bottomEl.textContent = c.bottom;
    bottomEl.style.fontSize = fitFont(c.bottom, 9, TEXT_W, 7) + 'px';
    pill.dataset.mode = mode;
    pill.dataset.kind = c.kind;
    pill.dataset.tone = tone;
    pill.dataset.busy = pillState.busy ? 'true' : 'false';
    pill.setAttribute('aria-label', 'ArenaKit ' + [pct === null ? '' : pct + '%', pillState.label].filter(Boolean).join(' '));
  }
  /* The ball has no ⟳ zone any more (a tap anywhere opens the panel); kept
   * as a no-op so older dock builds / tests can still call it. */
  const setRefreshButton = () => {};

  // ── page-load progress + fast comet on the ring ──────────────────────
  let loadTimer = 0;
  let stallTimer = 0;
  let loadValue = 0;
  const showProgress = (v) => { loadValue = v; progressFill.style.width = v + '%'; };
  function setLoading(on) {
    clearInterval(loadTimer); loadTimer = 0;
    clearTimeout(stallTimer); stallTimer = 0;
    pill.dataset.refreshing = on ? 'true' : 'false';
    if (on) {
      progress.dataset.show = 'true';
      showProgress(8);
      loadTimer = setInterval(() => showProgress(Math.min(90, loadValue + (90 - loadValue) * 0.08)), 200);
      stallTimer = later(() => setLoading(false), LOAD_STALL_MS);
    } else {
      showProgress(100);
      later(() => { if (!loadTimer) { progress.dataset.show = 'false'; showProgress(0); } }, 250);
    }
  }

  // ── confirm dialog ────────────────────────────────────────────────────
  let dialogResolve = null;
  const closeDialog = (result) => {
    dialog.dataset.show = 'false';
    const r = dialogResolve; dialogResolve = null;
    if (r) r(result);
  };
  function confirm({ title = '', message = '', ok = '确定', cancel = '取消' } = {}) {
    if (dialogResolve) closeDialog(false);
    root.querySelector('.ak-dialog-title').textContent = title;
    root.querySelector('.ak-dialog-msg').textContent = message;
    root.querySelector('.ak-dialog-btns [data-ok]').textContent = ok;
    root.querySelector('.ak-dialog-btns [data-cancel]').textContent = cancel;
    dialog.dataset.show = 'true';
    return new Promise((resolve) => { dialogResolve = resolve; });
  }
  root.querySelector('.ak-dialog-btns [data-ok]').addEventListener('click', () => closeDialog(true));
  root.querySelector('.ak-dialog-btns [data-cancel]').addEventListener('click', () => closeDialog(false));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(false); });

  // ── quick menu (long press) ───────────────────────────────────────────
  function openMenu(opts) {
    const items = typeof menuProvider === 'function' ? (menuProvider() || []) : [];
    if (!items.length) return;
    if (opts && opts.pointer) armGuard();
    menu.innerHTML = items.map((it) => `<button type="button" role="menuitem" data-menu="${String(it.id).replace(/"/g, '')}"${it.danger ? ' data-danger="true"' : ''}${it.disabled ? ' disabled' : ''}>${String(it.label).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</button>`).join('');
    menu.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.menu; setMenu(false); fire('menu', id); }));
    // Anchor next to the pill, on the free side of the screen.
    const r = rectOf(wrap);
    menu.style.top = '0px'; menu.style.left = '0px'; menu.style.right = 'auto';
    menu.dataset.show = 'true';
    const mh = menu.offsetHeight || 240;
    const mw = menu.offsetWidth || 200;
    let top = r.bottom + 6;
    if (top + mh > vh() - 8) top = Math.max(8, r.top - mh - 6);
    let left = wrap.dataset.side === 'left' ? r.left : r.right - mw;
    left = Math.max(8, Math.min(left, vw() - mw - 8));
    menu.style.top = top + 'px'; menu.style.left = left + 'px';
    menu.style.transformOrigin = (wrap.dataset.side === 'left' ? 'left' : 'right') + ' ' + (top > r.top ? 'top' : 'bottom');
    syncScrim();
  }

  // ── ball placement (side + y fraction, snap on release) ──────────────
  let pos = { side: 'right', y: PILL_DEFAULT_Y };
  try {
    const saved = JSON.parse(win.localStorage.getItem(PILL_POS_KEY) || 'null');
    if (saved && typeof saved === 'object') pos = { side: saved.side === 'left' ? 'left' : 'right', y: normalizeFraction(saved.y) };
  } catch (_) { /* storage blocked: default position */ }
  function place(animate = false) {
    const p = pillPlacement(pos, vw(), vh(), BALL_SIZE, BALL_SIZE);
    wrap.dataset.snap = animate ? 'true' : 'false';
    wrap.dataset.side = p.side;
    wrap.style.left = p.x + 'px'; wrap.style.top = p.y + 'px'; wrap.style.right = 'auto';
    return p;
  }
  const savePos = () => { try { win.localStorage.setItem(PILL_POS_KEY, JSON.stringify(pos)); } catch (_) { /* ignore */ } };
  onWin('resize', () => place(false));
  if (win.visualViewport && typeof win.visualViewport.addEventListener === 'function') win.visualViewport.addEventListener('resize', () => place(false));

  // ── ball gestures: tap / long press / drag ───────────────────────────
  // Tap = pointerdown … pointerup within TAP_SLOP px and before the long-press
  // timer. Android WebView jitters a few px under a finger, so the slop is
  // generous (12 px). If the WebView never delivers pointer events (or ate
  // them with a pointercancel), the plain `click` that follows a touch still
  // opens the panel — the fallback only runs when no pointer tap was handled
  // in the last TAP_MAX_MS.
  let drag = null;
  let longTimer = 0;
  let lastPointerType = 'touch';
  let lastTapAt = 0;
  const tap = () => {
    lastTapAt = Date.now();
    fire('panel');
    setOpen(true, { pointer: true });
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== null && e.button !== 0) return;
    lastPointerType = e.pointerType || 'touch';
    const r = wrap.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, long: false, last: null, at: Date.now() };
    try { wrap.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    clearTimeout(longTimer);
    longTimer = later(() => {
      if (!drag || drag.moved) return;
      drag.long = true;
      openMenu({ pointer: true });
      fire('longpress');
    }, LONG_PRESS_MS);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || drag.long) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    if (!drag.moved) { drag.moved = true; clearTimeout(longTimer); wrap.dataset.snap = 'false'; }
    drag.last = clampPos({ x: drag.ox + dx, y: drag.oy + dy }, vw(), vh(), BALL_SIZE, BALL_SIZE);
    wrap.style.left = drag.last.x + 'px'; wrap.style.top = drag.last.y + 'px'; wrap.style.right = 'auto';
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(longTimer);
    if (d.long) return;
    if (d.moved) {
      if (d.last) { pos = releasePosition(d.last, vw(), vh(), BALL_SIZE, BALL_SIZE); place(true); savePos(); }
      return;
    }
    tap();
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; clearTimeout(longTimer); place(true); } });
  // Fallback for WebViews that never delivered the pointer pair (see above).
  wrap.addEventListener('click', (e) => {
    if (Date.now() - lastTapAt < TAP_MAX_MS) return; // already handled through pointerup
    if (drag) return; // a press is still in progress (multi-touch / capture oddities)
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!isOpen()) tap();
  });
  pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire('panel'); setOpen(true); } });
  // Mouse right-click = the long-press quick menu. Android also fires
  // `contextmenu` after a touch long press — by then the pointer timer has
  // already opened the menu, so a touch-born contextmenu must only be
  // suppressed, never toggle the menu back off.
  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const mouse = (e.pointerType || lastPointerType) === 'mouse' || (typeof e.button === 'number' && e.button === 2);
    if (!mouse) return;
    clearTimeout(longTimer); drag = null;
    if (menuOpen()) setMenu(false); else { openMenu(); fire('longpress'); }
  });
  place(false);

  // ── keyboard (desktop): Esc closes dialog → menu → sheet; ⌘/Ctrl+R / F5
  // reload through the dock's requestReload (debounce, confirm while busy,
  // progress bar) — WKWebView has no reload shortcut of its own. Capture
  // phase so arena's handlers don't see an Esc we consumed.
  const isEditable = (el) => !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName || ''));
  onWin('keydown', (e) => {
    if (!e || e.defaultPrevented) return;
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (api.handleBack()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if ((mod && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')) || e.key === 'F5') {
      e.preventDefault(); e.stopPropagation();
      fire('refresh');
      return;
    }
    // ⌘[ / ⌘] page history (not inside editors, where they may mean indent).
    if (mod && !e.shiftKey && !e.altKey && (e.key === '[' || e.key === ']') && !isEditable(e.target)) {
      e.preventDefault();
      try { if (e.key === '[') win.history.back(); else win.history.forward(); } catch (_) { /* ignore */ }
    }
  }, true);

  // ── sheet: swipe down on the handle / header closes it ───────────────
  const grabs = [root.querySelector('.ak-sheet-handle'), sheetTop || root.querySelector('.ak-head')].filter(Boolean);
  let sdrag = null;
  for (const g of grabs) {
    g.addEventListener('pointerdown', (e) => {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('button, input, select, textarea, a, pre, [role="tablist"]')) return;
      sdrag = { id: e.pointerId, sy: e.clientY, dy: 0, t0: Date.now(), moved: false };
      try { g.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    g.addEventListener('pointermove', (e) => {
      if (!sdrag || e.pointerId !== sdrag.id) return;
      const dy = Math.max(0, e.clientY - sdrag.sy);
      if (!sdrag.moved && dy < TAP_SLOP) return;
      sdrag.moved = true; sdrag.dy = dy;
      sheet.dataset.dragging = 'true';
      sheet.style.transform = `translate(-50%, ${dy}px)`;
    });
    const sEnd = (e) => {
      if (!sdrag || e.pointerId !== sdrag.id) return;
      const d = sdrag; sdrag = null;
      sheet.dataset.dragging = 'false';
      const h = sheet.getBoundingClientRect().height || 400;
      const fast = d.dy > 40 && (Date.now() - d.t0) < 300;
      if (d.moved && (d.dy > h * 0.25 || fast)) setOpen(false); else sheet.style.transform = '';
    };
    g.addEventListener('pointerup', sEnd);
    g.addEventListener('pointercancel', sEnd);
  }
  close.addEventListener('click', () => setOpen(false));
  scrim.addEventListener('click', () => { if (menuOpen()) setMenu(false); else setOpen(false); });

  // ── pull-up-to-refresh at the bottom of the conversation ─────────────
  let pull = null;
  const scrollParentOf = (el) => {
    let n = el;
    while (n && n !== doc.body && n !== doc.documentElement && n.nodeType === 1) {
      let oy = '';
      try { oy = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(n).overflowY : ''; } catch (_) { oy = ''; }
      if (/(auto|scroll)/.test(oy) && n.scrollHeight > n.clientHeight + 1) return n;
      n = n.parentElement;
    }
    return null;
  };
  const atBottom = (el) => {
    if (el) return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const se = doc.scrollingElement || doc.documentElement;
    if (!se) return true;
    return (win.scrollY || 0) + vh() >= se.scrollHeight - 2;
  };
  const showPull = (dy) => {
    const armed = dy >= PULL_THRESHOLD;
    pullHint.dataset.show = dy > 10 ? 'true' : 'false';
    pullHint.dataset.armed = armed ? 'true' : 'false';
    const span = pullHint.querySelector('span');
    if (span) span.textContent = armed ? '松开刷新' : '上拉刷新';
  };
  const onTouchStart = (e) => {
    if (isOpen() || menuOpen() || dialogOpen() || !e.touches || e.touches.length !== 1) { pull = null; return; }
    const t = e.touches[0];
    const target = e.target;
    if (!target || target === host || (typeof target.closest === 'function' && (target.closest('#' + HOST_ID) || target.closest('textarea, input, select, [contenteditable="true"], button, a, [role="button"], [role="slider"]')))) { pull = null; return; }
    const scroller = typeof target.closest === 'function' ? scrollParentOf(target) : null;
    if (!atBottom(scroller)) { pull = null; return; }
    pull = { x: t.clientX, y: t.clientY, scroller, top: scroller ? scroller.scrollTop : (win.scrollY || 0), armed: false };
  };
  const onTouchMove = (e) => {
    if (!pull || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dy = pull.y - t.clientY;
    const dx = Math.abs(t.clientX - pull.x);
    const nowTop = pull.scroller ? pull.scroller.scrollTop : (win.scrollY || 0);
    if (nowTop !== pull.top || (dx > 40 && dx > dy)) { pull = null; showPull(0); return; }
    pull.armed = dy >= PULL_THRESHOLD;
    showPull(dy);
  };
  const onTouchEnd = () => {
    if (!pull) return;
    const armed = pull.armed; pull = null;
    showPull(0);
    if (armed) fire('pull-refresh');
  };
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    doc.addEventListener('touchcancel', () => { pull = null; showPull(0); }, { passive: true, capture: true });
  }

  const api = {
    root, host,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    isOpen,
    /* Back key (Android MainActivity → JS): true when consumed. */
    handleBack: () => {
      if (dialogOpen()) { closeDialog(false); return true; }
      if (menuOpen()) { setMenu(false); return true; }
      if (isOpen()) { setOpen(false); return true; }
      return false;
    },
    /* The native in-app link tab (Android MainActivity overlay) covers the
     * page; injected/links.js keeps its open state. Gates the reply watchdog. */
    linkTabOpen: () => { try { const l = win.__ARENAKIT_LINKS__; return !!(l && typeof l.isOpen === 'function' && l.isOpen()); } catch { return false; } },
    /* Open a web URL in the in-app link tab (desktop: separate window). */
    openLink: (url) => { try { const l = win.__ARENAKIT_LINKS__; return !!(l && typeof l.open === 'function' && l.open(url)); } catch { return false; } },
    /* reply-monitor anomaly: the ball blinks red (rim + glow + text). */
    alert: (on) => { pill.dataset.alert = on ? 'true' : 'false'; },
    /* Ball display: { percent (0..100 | null), label, tone ('normal'|'routed'|'muted'|'active'), busy, mode ('percent-model'|'percent'|'model') }. */
    setPill,
    /* Legacy alias for the old ball API: {percent, top, bottom, isModel, routed}. */
    setBall: (b = {}) => setPill({ percent: b.percent ?? null, label: [b.top && !/%$/.test(String(b.top)) ? b.top : '', b.bottom].filter(Boolean).join(' '), tone: b.routed ? 'routed' : (b.isModel ? 'normal' : 'muted'), busy: false, mode: b.mode || 'percent-model' }),
    /* No ⟳ zone on the ball any more — kept as a no-op for older callers. */
    setRefreshButton,
    /* Page load in progress: fast comet sweep on the ring + top progress bar. */
    setLoading,
    /* Quick actions: 'panel' | 'refresh' | 'pull-refresh' | 'menu' (id) | 'longpress' | 'open' | 'close'. */
    onAction: (fn) => { actionHandler = fn; },
    /* Long-press menu items: () => [{ id, label, danger?, disabled? }]. */
    setMenuProvider: (fn) => { menuProvider = fn; },
    /* Legacy: mark a quick action busy (now reflected by the pill label). */
    setBusy: () => {},
    /* Modal confirm inside the shadow root; resolves true on 确定. */
    confirm,
    /* Native Android shell channel (no-op elsewhere). */
    native,
    scrollTo: (el) => { if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' }); else if (shell) shell.scrollTop = 0; },
    ballSize: BALL_SIZE,
    pillSize: BALL_SIZE,
  };
  setPill({});
  win.__ARENAKIT_EMBED__ = api;
  native({ cmd: 'ready' });
  return true;
}
