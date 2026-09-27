/* Embedded dock shell (Android, and the default "pill" layout on desktop).
 *
 * Mobile Tauri gives us exactly one webview per window, so the dock is mounted
 * INSIDE the arena.ai page, following the reference app's (arena-trace-android
 * v0.6.x) overlay; desktop runs the very same shell by default (设置 → 桌面布局
 * switches back to the split view with the dock in its own webview):
 *
 *   status pill   flat 36 dp capsule hugging a screen edge: quota ring (arc =
 *                 remaining %, number inside) + one-line label (model / task
 *                 progress / flash message) + optional ⟳ zone (spins while
 *                 the page loads). Drag to move; on release it snaps to the
 *                 nearer side. Position is stored as (side, yFraction).
 *   gestures      tap → panel · tap on ⟳ → reload · long press → quick menu
 *                 (probe / session probe / cleanup / reload / panel)
 *   panel         bottom sheet flush with the bottom edge (handle, header,
 *                 tabs); scrim tap, swipe-down or the back key closes it. It
 *                 hosts the very same dock markup (dock.html body) and
 *                 stylesheet (dock.css) in a shadow root, so arena's CSS and
 *                 ours never touch. The pill fades out while the sheet is open.
 *   extras        2 dp page-load progress bar at the top, in-shadow confirm
 *                 dialog, pull-up-to-refresh at the bottom of the conversation.
 *   desktop       right-click on the pill = long press, Esc closes dialog →
 *                 menu → sheet, ⌘/Ctrl+R / F5 reload via the dock, ⌘[ / ⌘]
 *                 page history, hover styles.
 *
 * scripts/bundle-dock.mjs packs this file, dock.js and src/lib into one classic
 * script (src/embed/dock-embedded.gen.js) that Rust appends to the mobile init
 * bundle. mount(win) builds the DOM and publishes `win.__ARENAKIT_EMBED__`
 * (see `api` below) which dock.js reads at module evaluation time — the bundle
 * calls mount() first. */
import { CSS, MARKUP } from './assets.gen.js';
import { pillPlacement, releasePosition, normalizeFraction, ringBand, PILL_MARGIN, PILL_DEFAULT_Y, SNAP_MS } from '../lib/pill-layout.js';

export const HOST_ID = 'arenakit-embed';
const PILL_POS_KEY = 'arenakit.pill.pos';
export const PILL_HEIGHT = 36;    // reference StatusPillView height
export const RING_SIZE = 26;      // quota ring diameter
const RING_STROKE = 2.5;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
export const RING_C = 2 * Math.PI * RING_R;
const TAP_SLOP = 6;               // px before a press becomes a drag
const LONG_PRESS_MS = 500;
const PULL_THRESHOLD = 90;        // px of upward drag at the bottom → refresh
const LOAD_STALL_MS = 30_000;     // reference: give up on a stalled load
/* Backwards-compatible alias (older tests / callers). */
export const BALL_SIZE = PILL_HEIGHT;

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

/* Ring colours by quota health (reference StatusPillView / PulseBar). The
 * concrete colours come from the dock palette (CSS variables); this returns
 * the band + a fallback hex for environments without custom properties. */
export function ringPalette(percent) {
  const band = ringBand(percent);
  if (band === 'danger') return { band, base: '#D93025', dim: false };
  if (band === 'warning') return { band, base: '#B26A00', dim: false };
  if (band === 'ok') return { band, base: '#2F6BFF', dim: false };
  return { band, base: '#2F6BFF', dim: true };
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
export function clampPos(pos, vw, vh, size = PILL_HEIGHT, w = size) {
  const x = Number(pos && pos.x) || 0;
  const y = Number(pos && pos.y) || 0;
  return {
    x: Math.max(0, Math.min(x, Math.max(0, vw - w))),
    y: Math.max(0, Math.min(y, Math.max(0, vh - size))),
  };
}

export const EMBED_CSS = `
:host { all: initial; }
.ak-pill-wrap {
  position: fixed; left: auto; right: ${PILL_MARGIN}px; top: 120px; z-index: 2147483001;
  height: ${PILL_HEIGHT}px; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  transition: opacity .15s ease-out;
}
.ak-pill-wrap[data-snap="true"] { transition: left ${SNAP_MS}ms cubic-bezier(.2,.8,.3,1), top ${SNAP_MS}ms cubic-bezier(.2,.8,.3,1), opacity .15s ease-out; }
.ak-pill-wrap[data-hidden="true"] { opacity: 0; pointer-events: none; }
.ak-pill {
  display: flex; align-items: center; height: ${PILL_HEIGHT}px; padding: 0 5px; margin: 0;
  border-radius: ${PILL_HEIGHT / 2}px; border: 1px solid var(--ak-pill-stroke); background: var(--ak-pill-bg); color: var(--ak-fg);
  box-shadow: 0 2px 8px rgba(0,0,0,.14); cursor: pointer; overflow: hidden; box-sizing: border-box;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", sans-serif;
}
.ak-pill:active { filter: brightness(.96); }
@media (hover: hover) {
  .ak-pill:hover { box-shadow: 0 3px 12px rgba(0,0,0,.2); }
  .ak-menu button:hover:not([disabled]) { background: var(--ak-surface-low); }
}
.ak-pill-ring { position: relative; flex: none; width: ${RING_SIZE}px; height: ${RING_SIZE}px; }
.ak-pill-ring svg { position: absolute; inset: 0; width: ${RING_SIZE}px; height: ${RING_SIZE}px; overflow: visible; }
.ak-pill-track { fill: none; stroke: var(--ak-surface-high); stroke-width: ${RING_STROKE}; }
.ak-pill-arc { fill: none; stroke: var(--ak-brand); stroke-width: ${RING_STROKE}; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dasharray .4s; }
.ak-pill-arc[data-band="warning"] { stroke: var(--ak-warn); }
.ak-pill-arc[data-band="danger"] { stroke: var(--ak-danger); }
.ak-pill-arc[data-band="unknown"] { stroke: transparent; }
.ak-pill-orbit { fill: none; stroke: var(--ak-brand); stroke-width: ${RING_STROKE}; stroke-linecap: round; transform-origin: 50% 50%; display: none; }
.ak-pill[data-busy="true"] .ak-pill-orbit { display: block; animation: ak-orbit 1.1s linear infinite; }
.ak-pill[data-busy="true"] .ak-pill-arc { opacity: .35; }
.ak-pill-pct { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 700; letter-spacing: -.2px; color: var(--ak-fg); }
.ak-pill-label { margin-left: 8px; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ak-fg); padding-right: 9px; }
.ak-pill-label:empty { display: none; }
.ak-pill-label[data-tone="routed"] { color: var(--ak-warn); }
.ak-pill-label[data-tone="muted"] { color: var(--ak-sub); }
.ak-pill-label[data-tone="active"] { color: var(--ak-brand); }
.ak-pill-div { flex: none; width: 1px; height: 18px; background: var(--ak-line); margin-left: -1px; }
.ak-pill-label:empty + .ak-pill-div { margin-left: 5px; }
.ak-pill-refresh { flex: none; width: 34px; height: ${PILL_HEIGHT}px; margin-right: -5px; display: flex; align-items: center; justify-content: center; color: var(--ak-sub); }
.ak-pill-refresh svg { width: 18px; height: 18px; fill: currentColor; }
.ak-pill[data-refreshing="true"] .ak-pill-refresh svg { animation: ak-spin 1s linear infinite; color: var(--ak-brand); }
.ak-pill[data-refresh="false"] .ak-pill-div, .ak-pill[data-refresh="false"] .ak-pill-refresh { display: none; }
.ak-pill[data-refresh="false"] .ak-pill-label { padding-right: 9px; }

/* ── ball-centre display mode (设置 → 悬浮球显示) ────────────────────── */
.ak-pill[data-mode="percent"] .ak-pill-label,
.ak-pill[data-mode="percent"] .ak-pill-div { display: none; }
.ak-pill[data-mode="percent"] { padding: 0; width: ${RING_SIZE + 6}px; justify-content: center; }
.ak-pill[data-mode="model"] .ak-pill-ring,
.ak-pill[data-mode="model"] .ak-pill-div { display: none; }
.ak-pill[data-mode="model"] { padding: 0 12px; }
.ak-pill[data-mode="model"] .ak-pill-label { margin-left: 0; padding-right: 0; max-width: 240px; font-size: 14px; font-weight: 600; }
.ak-pill[data-alert="true"] {
  border-color: var(--ak-danger);
  box-shadow: 0 0 0 2px var(--ak-danger-soft), 0 0 14px var(--ak-danger);
  animation: ak-blink 0.8s steps(2, start) infinite;
}
.ak-pill[data-alert="true"] .ak-pill-arc { stroke: var(--ak-danger); }
.ak-pill[data-alert="true"] .ak-pill-pct { color: var(--ak-danger); }
@keyframes ak-orbit { to { transform: rotate(360deg); } }
@keyframes ak-spin { to { transform: rotate(360deg); } }
@keyframes ak-blink { 50% { border-color: var(--ak-pill-stroke); box-shadow: 0 2px 8px rgba(0,0,0,.14); } }

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

function ringSvg() {
  const c = RING_SIZE / 2;
  return `<svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" aria-hidden="true">`
    + `<circle class="ak-pill-track" cx="${c}" cy="${c}" r="${RING_R}"/>`
    + `<circle class="ak-pill-arc" data-band="unknown" cx="${c}" cy="${c}" r="${RING_R}" stroke-dasharray="0 ${RING_C}"/>`
    + `<circle class="ak-pill-orbit" cx="${c}" cy="${c}" r="${RING_R}" stroke-dasharray="${(RING_C * 80 / 360).toFixed(2)} ${RING_C.toFixed(2)}"/>`
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
    + '<div class="ak-pill-wrap" data-side="right" data-hidden="false" data-snap="false">'
    + '<div class="ak-pill" role="button" tabindex="0" aria-label="ArenaKit" data-busy="false" data-refresh="true" data-refreshing="false" data-alert="false">'
    + `<span class="ak-pill-ring">${ringSvg()}<span class="ak-pill-pct">–</span></span>`
    + '<span class="ak-pill-label" data-tone="muted"></span>'
    + '<span class="ak-pill-div"></span>'
    + `<span class="ak-pill-refresh" aria-label="刷新页面" title="刷新页面">${ICONS.refresh}</span>`
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

  const wrap = root.querySelector('.ak-pill-wrap');
  const pill = root.querySelector('.ak-pill');
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
  const tools = root.querySelector('.ak-head-tools') || root.querySelector('.ak-head');
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
  const syncPillHidden = () => { wrap.dataset.hidden = isOpen() ? 'true' : 'false'; };
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

  // ── pill rendering ────────────────────────────────────────────────────
  const arc = root.querySelector('.ak-pill-arc');
  const pctEl = root.querySelector('.ak-pill-pct');
  const labelEl = root.querySelector('.ak-pill-label');
  const refreshEl = root.querySelector('.ak-pill-refresh');
  let pillState = { percent: null, label: '', tone: 'muted', busy: false };
  function setPill(p = {}) {
    pillState = { ...pillState, ...p };
    const raw = pillState.percent;
    const pct = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Math.min(100, Math.round(Number(raw)))) : null;
    const band = ringBand(pct);
    if (arc) {
      arc.setAttribute('data-band', band);
      arc.dataset.band = band;
      arc.setAttribute('stroke-dasharray', `${((pct === null ? 0 : pct / 100) * RING_C).toFixed(3)} ${RING_C.toFixed(3)}`);
    }
    pctEl.textContent = pct === null ? '–' : String(pct);
    const text = String(pillState.label || '');
    labelEl.textContent = text;
    labelEl.dataset.tone = ['normal', 'routed', 'muted', 'active'].includes(pillState.tone) ? pillState.tone : 'normal';
    pill.dataset.busy = pillState.busy ? 'true' : 'false';
    // Display mode drives what shows in the centre of the pill:
    //   'percent-model' (default): ring + label, both visible
    //   'percent'                 : ring only, label hidden
    //   'model'                   : label centred (no ring)
    // CSS hides whichever element does not belong. The flash / alert states
    // override the visual but never the data-mode attr.
    const mode = ['percent-model', 'percent', 'model'].includes(pillState.mode) ? pillState.mode : 'percent-model';
    pill.dataset.mode = mode;
    pill.setAttribute('aria-label', 'ArenaKit ' + (pct === null ? '' : pct + '% ') + text);
    place(); // the label width changed → keep the right-hand edge on the margin
  }
  const setRefreshButton = (on) => { pill.dataset.refresh = on ? 'true' : 'false'; place(); };

  // ── page-load progress + spinning ⟳ ──────────────────────────────────
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

  // ── pill placement (side + y fraction, snap on release) ──────────────
  let pos = { side: 'right', y: PILL_DEFAULT_Y };
  try {
    const saved = JSON.parse(win.localStorage.getItem(PILL_POS_KEY) || 'null');
    if (saved && typeof saved === 'object') pos = { side: saved.side === 'left' ? 'left' : 'right', y: normalizeFraction(saved.y) };
  } catch (_) { /* storage blocked: default position */ }
  const pillWidth = () => wrap.offsetWidth || (wrap.getBoundingClientRect && wrap.getBoundingClientRect().width) || 120;
  function place(animate = false) {
    const p = pillPlacement(pos, vw(), vh(), pillWidth(), PILL_HEIGHT);
    wrap.dataset.snap = animate ? 'true' : 'false';
    wrap.dataset.side = p.side;
    wrap.style.left = p.x + 'px'; wrap.style.top = p.y + 'px'; wrap.style.right = 'auto';
    return p;
  }
  const savePos = () => { try { win.localStorage.setItem(PILL_POS_KEY, JSON.stringify(pos)); } catch (_) { /* ignore */ } };
  onWin('resize', () => place(false));
  if (win.visualViewport && typeof win.visualViewport.addEventListener === 'function') win.visualViewport.addEventListener('resize', () => place(false));

  // ── pill gestures: tap / ⟳ tap / long press / drag ───────────────────
  let drag = null;
  let longTimer = 0;
  const inRefreshZone = (x) => {
    if (pill.dataset.refresh === 'false') return false;
    const rr = rectOf(refreshEl);
    return rr.width > 0 && x >= rr.left - 2 && x <= rr.right + 2;
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false, long: false, last: null };
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
    const w = pillWidth();
    drag.last = clampPos({ x: drag.ox + dx, y: drag.oy + dy }, vw(), vh(), PILL_HEIGHT, w);
    wrap.style.left = drag.last.x + 'px'; wrap.style.top = drag.last.y + 'px'; wrap.style.right = 'auto';
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(longTimer);
    if (d.long) return;
    if (d.moved) {
      if (d.last) { pos = releasePosition(d.last, vw(), vh(), pillWidth(), PILL_HEIGHT); place(true); savePos(); }
      return;
    }
    if (inRefreshZone(e.clientX)) { fire('refresh'); return; }
    fire('panel');
    setOpen(true, { pointer: true });
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; clearTimeout(longTimer); place(true); } });
  pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire('panel'); setOpen(true); } });
  // Desktop (mouse): right-click = the long-press quick menu.
  pill.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(longTimer); drag = null; if (menuOpen()) setMenu(false); else { openMenu(); fire('longpress'); } });
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
    /* reply-monitor anomaly: red blinking outline (reference alert ring). */
    alert: (on) => { pill.dataset.alert = on ? 'true' : 'false'; },
    /* Pill display: { percent (0..100 | null), label, tone ('normal'|'routed'|'muted'|'active'), busy }. */
    setPill,
    /* Legacy alias for the old ball API: {percent, top, bottom, isModel, routed}. */
    setBall: (b = {}) => setPill({ percent: b.percent ?? null, label: [b.top && !/%$/.test(String(b.top)) ? b.top : '', b.bottom].filter(Boolean).join(' '), tone: b.routed ? 'routed' : (b.isModel ? 'normal' : 'muted'), busy: false, mode: b.mode || 'percent-model' }),
    /* Show / hide the ⟳ zone (设置 → 悬浮窗显示刷新按钮). */
    setRefreshButton,
    /* Page load in progress: spinning ⟳ + top progress bar. */
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
    ballSize: PILL_HEIGHT,
    pillSize: PILL_HEIGHT,
  };
  setPill({});
  win.__ARENAKIT_EMBED__ = api;
  native({ cmd: 'ready' });
  return true;
}
