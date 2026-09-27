/* ArenaKit in-page HUD.
 *
 * Injected into the arena.ai page (both desktop and mobile) by the Rust init
 * script, after DOMContentLoaded. Renders inside a Shadow DOM so arena's CSS
 * can neither style nor break it. Fed by Rust through
 * `window.__AK_HUD__.push(kind, payload)` (eval, no IPC permission needed).
 *
 * Kinds: 'models' {run_id, models:[{model,provider,partial}]}
 *        'credits' {remaining, total, resetAt}
 *        'error'   {scope, message}
 *
 * Classic script (not a module) — keep it dependency-free.
 */
(function () {
  'use strict';
  if (window.__AK_HUD__) return;

  var env = window.__ARENAKIT_ENV__ || {};
  var css = window.__ARENAKIT_HUD_CSS__ || '';
  var STORE_VIS = 'ak_hud';
  var STORE_POS = 'ak_hud_pos';

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  // ── view helpers (mirror src/lib/format.js) ─────────────────────────
  function pct(remaining, total) {
    var r = Number(remaining), t = Number(total);
    if (!isFinite(r) || !isFinite(t) || t <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((r / t) * 100)));
  }
  function band(p) {
    if (p === null) return 'none';
    return p < 10 ? 'danger' : p < 20 ? 'warning' : 'ok';
  }
  function resetLabel(resetAt) {
    if (resetAt === null || resetAt === undefined || resetAt === '') return '';
    var ts = typeof resetAt === 'number' ? resetAt : Date.parse(String(resetAt));
    if (!isFinite(ts)) return String(resetAt);
    if (ts < 1e12) ts *= 1000;
    var mins = Math.round((ts - Date.now()) / 60000);
    if (mins <= 0) return '即将重置';
    if (mins < 60) return mins + ' 分钟后重置';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + ' 小时 ' + m + ' 分后重置' : h + ' 小时后重置';
  }
  function shortRun(id) {
    return typeof id === 'string' && id.length > 10 ? id.slice(0, 10) + '…' : (id || '');
  }

  // ── DOM ─────────────────────────────────────────────────────────────
  var host = document.createElement('div');
  host.id = 'arenakit-hud';
  var root = host.attachShadow({ mode: 'open' });

  var MARK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 17.2 12 6.8l5.4 10.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle class="dot" cx="12" cy="14.6" r="1.9"/></svg>';

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="wrap">' +
      '<div class="card" id="card" hidden>' +
        '<div class="card-head"><span class="label">服务端模型</span>' +
          '<button class="close" id="close" aria-label="收起"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>' +
        '<div class="model empty" id="model">等待识别</div>' +
        '<div class="meta"><span id="provider"></span><span class="run" id="run"></span></div>' +
        '<div class="hr"></div>' +
        '<div class="gauge" id="gauge" data-band="none">' +
          '<div class="gauge-row"><span class="gauge-val empty" id="pct">—</span><span class="gauge-sub" id="reset">今日额度</span></div>' +
          '<div class="bar"><div class="fill" id="fill"></div></div>' +
        '</div>' +
        '<div class="error" id="error"></div>' +
        '<div class="foot"><span>ArenaKit</span><span id="ver"></span></div>' +
      '</div>' +
      '<button class="chip empty no-pct" id="chip" aria-label="ArenaKit HUD">' +
        '<span class="mark">' + MARK + '</span>' +
        '<span class="chip-text" id="chip-text"></span>' +
        '<span class="chip-sep"></span>' +
        '<span class="chip-pct" id="chip-pct"></span>' +
        '<span class="badge"></span>' +
      '</button>' +
    '</div>';

  var $ = function (id) { return root.getElementById(id); };
  var wrap = root.querySelector('.wrap');
  var chip = $('chip');
  var card = $('card');
  $('ver').textContent = env.version ? 'v' + env.version : '';

  // ── theme: follow arena's html.dark, else the OS ────────────────────
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function syncTheme() {
    var html = document.documentElement;
    var dark = html.classList.contains('dark') || html.dataset.theme === 'dark' ||
      html.getAttribute('data-color-mode') === 'dark' || (mq && mq.matches);
    if (html.classList.contains('light') || html.dataset.theme === 'light') dark = false;
    host.dataset.theme = dark ? 'dark' : 'light';
  }
  syncTheme();
  if (mq && mq.addEventListener) mq.addEventListener('change', syncTheme);
  try {
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style'],
    });
  } catch (e) { /* ignore */ }

  // ── position (persisted as right/bottom offsets) ────────────────────
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function applyPos(pos) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = clamp(pos.right, 8, Math.max(8, vw - 60));
    var b = clamp(pos.bottom, 8, Math.max(8, vh - 60));
    host.style.right = r + 'px';
    host.style.bottom = b + 'px';
    return { right: r, bottom: b };
  }
  var pos = { right: 20, bottom: 20 };
  try { pos = Object.assign(pos, JSON.parse(read(STORE_POS) || '{}')); } catch (e) { /* ignore */ }
  pos = applyPos(pos);
  window.addEventListener('resize', function () { pos = applyPos(pos); });

  var drag = null;
  chip.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
    try { chip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  chip.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    chip.classList.add('dragging');
    pos = applyPos({ right: drag.right - dx, bottom: drag.bottom - dy });
  });
  function endDrag(e) {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    chip.classList.remove('dragging');
    if (moved) write(STORE_POS, JSON.stringify(pos));
    else toggle();
  }
  chip.addEventListener('pointerup', endDrag);
  chip.addEventListener('pointercancel', function () { drag = null; chip.classList.remove('dragging'); });
  chip.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  $('close').addEventListener('click', function () { setOpen(false); });

  var open = false;
  function setOpen(v) {
    open = !!v;
    if (open) card.hidden = false;
    // next frame so the transition runs
    requestAnimationFrame(function () {
      wrap.classList.toggle('open', open);
      if (!open) setTimeout(function () { if (!open) card.hidden = true; }, 220);
    });
    if (open) chip.classList.remove('has-error');
  }
  function toggle() { setOpen(!open); }

  // ── data ────────────────────────────────────────────────────────────
  var state = { models: null, credits: null, error: null };

  function renderModels(p) {
    var list = (p && p.models) || [];
    var names = [];
    var providers = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && m.model && names.indexOf(m.model) < 0) names.push(m.model);
      if (m && m.provider && providers.indexOf(m.provider) < 0) providers.push(m.provider);
    }
    var name = names.join(' · ');
    $('model').textContent = name || '等待识别';
    $('model').classList.toggle('empty', !name);
    $('provider').textContent = providers.join(' / ');
    $('run').textContent = shortRun(p && (p.run_id || p.runId));
    $('chip-text').textContent = name;
    chip.classList.toggle('empty', !name && !state.credits);
    chip.title = name ? '服务端模型:' + name : 'ArenaKit';
  }

  function renderCredits(p) {
    var v = pct(p && p.remaining, p && p.total);
    var b = band(v);
    $('gauge').dataset.band = b;
    $('pct').innerHTML = v === null ? '—' : v + '<small>%</small>';
    $('pct').classList.toggle('empty', v === null);
    $('fill').style.width = (v === null ? 0 : v) + '%';
    $('reset').textContent = v === null ? '今日额度' : (resetLabel(p.resetAt !== undefined ? p.resetAt : p.reset_at) || '今日额度');
    var cp = $('chip-pct');
    cp.textContent = v === null ? '' : v + '%';
    cp.dataset.band = b;
    chip.classList.toggle('no-pct', v === null || !$('chip-text').textContent);
    chip.classList.toggle('empty', !$('chip-text').textContent && v === null);
    if (!$('chip-text').textContent && v !== null) {
      // credits but no model yet: show the percentage as the chip text
      $('chip-text').textContent = v + '%';
      chip.classList.remove('empty');
      chip.classList.add('no-pct');
    }
  }

  function renderError(p) {
    var msg = (p && p.message) || '';
    $('error').textContent = msg;
    if (msg && !open) chip.classList.add('has-error');
  }

  function push(kind, payload) {
    try {
      if (kind === 'models') { state.models = payload; state.error = null; renderError(null); renderModels(payload); }
      else if (kind === 'credits') { state.credits = payload; renderCredits(payload); }
      else if (kind === 'error') { state.error = payload; renderError(payload); }
    } catch (e) {
      console.warn('[ArenaKit] hud push', e);
    }
  }

  // ── visibility ──────────────────────────────────────────────────────
  var stored = read(STORE_VIS);
  var visible = stored === null ? !!env.mobile : stored === '1';
  function setVisible(v) {
    visible = !!v;
    host.hidden = !visible;
    write(STORE_VIS, visible ? '1' : '0');
    return visible;
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 50); return; }
    document.body.appendChild(host);
    host.hidden = !visible;
    // arena is a SPA that occasionally re-renders <body>; re-attach if dropped.
    try {
      new MutationObserver(function () {
        if (!host.isConnected && document.body) document.body.appendChild(host);
      }).observe(document.documentElement, { childList: true, subtree: false });
    } catch (e) { /* ignore */ }
  }
  mount();

  window.__AK_HUD__ = {
    push: push,
    setVisible: setVisible,
    isVisible: function () { return visible; },
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    state: state,
  };
})();
