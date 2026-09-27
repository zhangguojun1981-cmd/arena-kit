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
        '<div class="turn" id="turn" hidden><div class="turn-head" id="turn-head"></div><div class="turn-hist" id="turn-hist"></div></div>' +
        '<div class="usage" id="usage" hidden></div>' +
        '<div class="error" id="error"></div>' +
        '<div class="probe" id="probe" hidden>' +
          '<div class="probe-line" id="probe-line"></div>' +
          '<div class="probe-btns" id="probe-btns" hidden>' +
            '<button type="button" id="p-start">开始探针</button>' +
            '<button type="button" id="p-stop" hidden>停止</button>' +
            '<button type="button" id="p-clean">清理算式标题</button>' +
            '<button type="button" id="p-quick">快捷发送</button>' +
          '</div>' +
        '</div>' +
        '<div class="foot"><span>ArenaKit</span><button class="home" id="home" type="button" hidden>首页</button><span id="ver"></span></div>' +
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
  // Mobile has no tab strip: the HUD is the way back to the app's home page.
  if (env.mobile) {
    $('home').hidden = false;
    $('home').addEventListener('click', function () {
      var ak = window.__ARENAKIT__;
      if (ak && ak.invoke) ak.invoke('page_event', { kind: 'home', payload: {} }).catch(function () {});
    });
  }

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

  // ── 回复监控: per-turn line + token/cost labels ─────────────────────
  function fmtUsage(t) {
    if (!t || !t.span_count) return '';
    var tokens = t.tokens === null || t.tokens === undefined ? '未提供' : (t.tokens_approximate ? '≈' : '') + Number(t.tokens).toLocaleString('zh-CN');
    var cost = t.cost_usd === null || t.cost_usd === undefined ? '未提供' : '≈$' + Number(t.cost_usd).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    var missing = t.token_coverage < t.span_count || t.cost_coverage < t.span_count;
    return 'Token ' + tokens + ' · 费用 ' + cost + (missing ? '(部分缺失)' : '') + (t.partial ? '(进行中)' : '');
  }
  function renderTurn(p) {
    var box = $('turn');
    if (!p) { box.hidden = true; $('turn-head').textContent = ''; $('turn-hist').textContent = ''; return; }
    var head = '';
    if (p.phase === 'token') head = '第 ' + p.turn + ' 轮 · 识别中…';
    else if (p.headline) head = p.headline;
    var hist = '';
    if (p.history && p.history.length) {
      var parts = [];
      for (var i = 0; i < p.history.length; i++) parts.push('R' + p.history[i].turn + ' ' + p.history[i].model);
      hist = '本会话: ' + parts.join(' · ');
    }
    $('turn-head').textContent = head;
    $('turn-head').classList.toggle('routed', !!p.routed);
    $('turn-hist').textContent = hist;
    box.hidden = !head && !hist;
  }
  function renderUsage(p) {
    var run = fmtUsage(p && p.run_usage);
    var all = fmtUsage(p && p.usage);
    var text = run ? '本轮 ' + run : '';
    if (all && all !== run) text += (text ? '\n' : '') + '累计 ' + all;
    $('usage').textContent = text;
    $('usage').hidden = !text;
  }
  function renderProbe(p) {
    var st = (p && p.status) || null;
    var line = (p && p.text) || '';
    if (st && st.active) {
      line = (st.kind === 'cleanup' ? '清理中 · 已归档 ' + st.archived : '探针 第 ' + st.round + '/' + st.max_rounds + ' 轮 · 命中 ' + st.hits.length) + (line ? ' · ' + line : '');
    }
    $('probe-line').textContent = line;
    $('probe').hidden = !line && !env.mobile;
    if (env.mobile) {
      $('p-start').hidden = !!(st && st.active);
      $('p-stop').hidden = !(st && st.active);
      $('p-clean').disabled = !!(st && st.active);
    }
  }

  function push(kind, payload) {
    try {
      if (kind === 'models') {
        state.models = payload; state.error = null; renderError(null); renderModels(payload);
        if (payload && payload.cleared) { renderTurn(null); renderUsage(null); }
        else { if (payload && payload.turn) renderTurn(payload.turn); renderUsage(payload); }
      }
      else if (kind === 'turn') { renderTurn(payload); }
      else if (kind === 'credits') { state.credits = payload; renderCredits(payload); }
      else if (kind === 'error') { state.error = payload; renderError(payload); }
      else if (kind === 'probe') { renderProbe(payload); }
    } catch (e) {
      console.warn('[ArenaKit] hud push', e);
    }
  }

  // Mobile has no shell: the HUD drives the automation through the same
  // commands (capabilities/mobile-hud.json), using the saved settings.
  if (env.mobile) {
    $('probe').hidden = false;
    $('probe-btns').hidden = false;
    var call = function (cmd, args) {
      var ak = window.__ARENAKIT__;
      if (!ak || !ak.invoke) return Promise.reject(new Error('no runtime'));
      return ak.invoke(cmd, args || {});
    };
    var say = function (t) { $('probe-line').textContent = t; };
    // No native confirm() in every WebView: arm on first tap, run on the second.
    var armed = { id: null, at: 0 };
    var arm = function (id, label, run) {
      var now = Date.now();
      if (armed.id === id && now - armed.at < 5000) { armed.id = null; run(); return; }
      armed.id = id; armed.at = now;
      say(label + ' · 再点一次确认(5 秒内)');
    };
    $('p-start').addEventListener('click', function () {
      call('get_settings').then(function (s) {
        var cfg = (s && s.probe) || {};
        arm('start', '探针会新建对话、发送真实消息(消耗额度);目标 ' + (cfg.targets || '未设置') + ' · 最多 ' + (cfg.max_rounds || 5) + ' 轮', function () {
          call('probe_start', { config: cfg }).then(function () { setOpen(true); }).catch(function (e) { say('启动失败:' + (e && e.message || e)); });
        });
      }).catch(function (e) { say('读取设置失败:' + (e && e.message || e)); });
    });
    $('p-stop').addEventListener('click', function () { call('probe_stop').catch(function (e) { say(String(e && e.message || e)); }); });
    $('p-clean').addEventListener('click', function () {
      arm('clean', '清理算式标题对话(仅归档,跳过当前对话)', function () {
        call('cleanup_start').catch(function (e) { say('清理失败:' + (e && e.message || e)); });
      });
    });
    $('p-quick').addEventListener('click', function () {
      call('get_settings').then(function (s) {
        var text = (s && s.quick_text) || '';
        if (!text.trim()) { say('请先在首页"自动化设置"里填写快捷发送内容'); return; }
        arm('quick', '发送到当前对话:' + text.slice(0, 40), function () {
          call('quick_send', { text: text }).then(function () { say('已发送到当前对话'); }).catch(function (e) { say('发送失败:' + (e && e.message || e)); });
        });
      }).catch(function (e) { say('读取设置失败:' + (e && e.message || e)); });
    });
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
