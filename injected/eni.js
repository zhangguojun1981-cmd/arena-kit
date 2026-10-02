/* ArenaKit injected/eni.js
 * System-prompt injector for arena.ai — both classic (create-evaluation /
 * post-to-evaluation) and agent mode (create-chat / realtime append).
 *
 * This is a CLEAN rewrite of the upstream peyton2065/Arena-Ai ENI userscript:
 *   • OFF by default and empty prompt by default — no upstream persona.
 *   • Hooks are installed directly (no <script> tag injection: the bridge
 *     runs in the MAIN world, same as arena.ai's own JS).
 *   • `window.__AK_ENI_SET__(on, text)` is the public API the dock uses to
 *     push prefs (on every change + on every boot via applyPageFlags).
 *   • `prefs.eniOn` controls whether injection runs; the prompt is taken
 *     from `prefs.eniText` (saved from the dock's 更多 → 提示词注入
 *     panel) or, as a fallback, `window.__AK_ENI_TEXT__` (set the same
 *     way as a localStorage mirror).
 *
 * Endpoints matched:
 *   • POST /nextjs-api/stream/create-evaluation   body.userMessage.content
 *   • POST /nextjs-api/stream/post-to-evaluation/{id}   body.userMessage.content
 *   • POST /nextjs-api/stream/create-chat         body.message.parts[0].text
 *   • POST /ai-proxy/realtime/v1/sessions/{id}/in/append
 *         body.payload.message (only when INJECT_ON_REPLIES is set)
 *
 * The agent realtime endpoint is matched last: its body shape is unique
 * (kind:'message', payload:{message, chatId, …}). Media mode (Image / Video
 * buttons with data-state=open) is skipped on every endpoint, matching the
 * upstream behaviour.
 *
 * A small status badge ("ENI") floats at the composer's top-right corner
 * (fixed, mounted on <html> — never inside the page's React tree) while the
 * injection is ON — nothing is shown when it is off, the default (heuristic
 * anchor — contenteditable / textarea / role=textbox). Clicking it opens
 * the dock 更多 tab via the dock's `openDock` page event so the user can
 * edit the prompt there. */
(function () {
  'use strict';

  // ── state ────────────────────────────────────────────────────────────
  let on = false;
  let prompt = '';
  // Per-reply injection for the agent realtime endpoint (off by default —
  // it tends to surprise the model on follow-ups). Dock can flip it later
  // if we expose the toggle.
  let INJECT_ON_REPLIES = false;

  function setOn(nextOn, nextText) {
    on = !!nextOn;
    if (typeof nextText === 'string') prompt = nextText;
    // Persist a localStorage mirror so a SPA navigation that wipes the page
    // context still has the last value to re-apply from (bridge.js is
    // re-injected on every navigation, and it will reinstall this hook).
    try {
      localStorage.setItem('ak_arena_eni_on', on ? '1' : '0');
      localStorage.setItem('ak_arena_eni_text', prompt || '');
    } catch (_) { /* storage blocked */ }
  }

  // Re-hydrate from localStorage (sandbox-survival across hard navigation).
  try {
    on = (localStorage.getItem('ak_arena_eni_on') === '1');
    prompt = localStorage.getItem('ak_arena_eni_text') || '';
  } catch (_) { /* ignore */ }

  // ── public API the dock uses (`page('eniSet', on, text)`) ─────────────
  window.__AK_ENI_SET__ = function (nextOn, nextText) {
    setOn(nextOn, nextText);
    return { on, promptLen: prompt.length };
  };

  // ── media-mode guard (same DOM read as upstream) ──────────────────────
  function isMediaModeActive() {
    try {
      return !!document.querySelector(
        'button[aria-label="Image"][data-state="open"],' +
        'button[aria-label="Video"][data-state="open"]'
      );
    } catch (_) { return false; }
  }

  // ── body-shape matching ──────────────────────────────────────────────
  // Each matcher returns true + an object describing how to inject, or false.
  const MATCHERS = [
    {
      // Classic: create-evaluation + post-to-evaluation
      //   { userMessage: { content: '…' } }
      name: 'evaluation',
      match: (url, body) => body && body.userMessage && typeof body.userMessage.content === 'string',
      inject: (body, p) => { body.userMessage.content = p + '\n\n' + body.userMessage.content; },
    },
    {
      // Agent new chat: create-chat
      //   { message: { id, role:'user', parts:[{type:'text', text}|{type:'file',…}] } }
      name: 'agent-create-chat',
      match: (url, body) =>
        body && body.message && Array.isArray(body.message.parts) &&
        body.message.parts.length > 0 &&
        typeof body.message.parts[0].text === 'string',
      inject: (body, p) => { body.message.parts[0].text = p + '\n\n' + body.message.parts[0].text; },
    },
    {
      // Agent realtime input: append to a session
      //   { kind:'message', payload:{ message:'…', chatId, … } }
      name: 'agent-append',
      // only considered when INJECT_ON_REPLIES is true
      gate: () => INJECT_ON_REPLIES,
      match: (url, body) =>
        body && body.kind === 'message' && body.payload && typeof body.payload.message === 'string',
      inject: (body, p) => { body.payload.message = p + '\n\n' + body.payload.message; },
    },
  ];

  function findMatcher(url) {
    if (!on || !prompt) return null;
    if (isMediaModeActive()) return null;
    if (url.indexOf('/nextjs-api/stream/create-evaluation') !== -1) return MATCHERS[0];
    if (url.indexOf('/nextjs-api/stream/post-to-evaluation/') !== -1) return MATCHERS[0];
    if (url.indexOf('/nextjs-api/stream/create-chat') !== -1) return MATCHERS[1];
    if (url.indexOf('/ai-proxy/realtime/v1/sessions/') !== -1 && url.indexOf('/in/append') !== -1) {
      return INJECT_ON_REPLIES ? MATCHERS[2] : null;
    }
    return null;
  }

  // ── fetch hook ───────────────────────────────────────────────────────
  if (!window.fetch) {
    console.warn('[ArenaKit] eni: window.fetch unavailable — hook not installed.');
  } else {
    const realFetch = window.fetch.bind(window);
    window.fetch = function (resource, config) {
      // Skip injection if the toggle is off / prompt is empty / wrong URL.
      let url = '';
      try {
        if (typeof resource === 'string') url = resource;
        else if (resource && resource.url) url = resource.url;
      } catch (_) { url = ''; }
      const matcher = findMatcher(url);
      if (!matcher) return realFetch(resource, config);

      // Read the body, parse, mutate, rebuild.
      try {
        const isRequestObj = (typeof Request !== 'undefined' && resource instanceof Request);
        const getBodyText = () => {
          if (isRequestObj) {
            // Clone — body stream can only be consumed once.
            const cloned = resource.clone();
            return cloned.text();
          }
          return Promise.resolve(config && config.body ? String(config.body) : null);
        };
        return getBodyText().then((bodyText) => {
          if (!bodyText) return realFetch(resource, config);
          let body;
          try { body = JSON.parse(bodyText); } catch (_) { return realFetch(resource, config); }
          if (!matcher.match(url, body)) return realFetch(resource, config);
          matcher.inject(body, prompt);
          const newBodyText = JSON.stringify(body);
          if (isRequestObj) {
            const newReq = new Request(resource, { body: newBodyText });
            return realFetch(newReq);
          }
          const newConfig = Object.assign({}, config, { body: newBodyText });
          return realFetch(resource, newConfig);
        }).catch((err) => {
          console.error('[ArenaKit] eni intercept error:', err);
          return realFetch(resource, config);
        });
      } catch (err) {
        console.error('[ArenaKit] eni intercept error:', err);
        return realFetch(resource, config);
      }
    };
  }

  // ── badge next to the composer ───────────────────────────────────────
  // Heuristic anchor: agent mode uses contenteditable / role=textbox, the
  // classic composer is textarea[name="message"]. We try the most-likely
  // match first and fall back.
  function findComposer() {
    const sel = [
      'textarea[name="message"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
    ];
    for (const s of sel) {
      try {
        const el = document.querySelector(s);
        if (el && el.parentElement) return el;
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  function injectBadge() {
    if (document.getElementById('ak-eni-badge')) return;
    if (!on) return; // off (the default) → nothing next to the composer
    const composer = findComposer();
    if (!composer) return;
    const badge = document.createElement('button');
    badge.id = 'ak-eni-badge';
    badge.type = 'button';
    badge.title = on
      ? `ArenaKit ENI 已开启（注入 ${prompt.length} 字）— 点击打开面板`
      : 'ArenaKit ENI 已关闭 — 点击打开面板';
    badge.dataset.on = on ? 'true' : 'false';
    Object.assign(badge.style, {
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '2px 8px', marginLeft: '6px', borderRadius: '99px',
      fontSize: '11px', fontWeight: '700', letterSpacing: '0.04em',
      background: 'rgba(30,33,40,0.92)', // floats over the page: opaque
      color: on ? 'var(--ak-brand, #2F6BFF)' : 'var(--ak-muted, #888)',
      border: '1px solid currentColor',
      cursor: 'pointer', flexShrink: '0', lineHeight: '1.6',
      verticalAlign: 'middle',
    });
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '6px', height: '6px', borderRadius: '50%',
      background: on ? 'var(--ak-ok, #10b981)' : 'var(--ak-muted, #888)',
      display: 'inline-block', flexShrink: '0',
    });
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(on ? 'ENI' : 'ENI off'));
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Tell the dock to open the 更多 tab so the user can edit.
      try { window.__ARENAKIT__ && window.__ARENAKIT__.dispatch('openDock', { tab: 'more' }); } catch (_) { /* ignore */ }
    });
    // Mount OUTSIDE the page's React tree: a fixed chip on <html>, placed at
    // the composer's top-right corner. Inserting a foreign node inside the
    // composer's React-owned container broke reconciliation (insertBefore /
    // removeChild on a moved child) — the composer then re-mounted, the URL
    // update of a new chat lagged, and the pill lost its model label.
    Object.assign(badge.style, { position: 'fixed', zIndex: '2147483000', marginLeft: '0', left: '-9999px', top: '-9999px' });
    try { (document.documentElement || document.body).appendChild(badge); } catch (_) { return; }
    placeBadge();
  }

  // Keep the chip on the composer's top-right edge (hidden when there is no
  // visible composer, e.g. while a dialog replaced the page).
  function placeBadge() {
    const badge = document.getElementById('ak-eni-badge');
    if (!badge) return;
    const composer = findComposer();
    const r = composer && typeof composer.getBoundingClientRect === 'function' ? composer.getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) { badge.style.display = 'none'; return; }
    badge.style.display = 'inline-flex';
    const w = badge.offsetWidth || 44;
    const h = badge.offsetHeight || 20;
    const vw = window.innerWidth || 0;
    let left = r.right - w;
    if (vw) left = Math.min(left, vw - w - 4);
    badge.style.left = Math.max(4, Math.round(left)) + 'px';
    badge.style.top = Math.max(4, Math.round(r.top - h - 4)) + 'px';
  }

  function refreshBadge() {
    const existing = document.getElementById('ak-eni-badge');
    if (existing) existing.remove();
    injectBadge();
  }

  // Re-publish the badge whenever the dock changes the toggle, so the dot
  // colour + label flip without needing a SPA reload.
  const origSet = window.__AK_ENI_SET__;
  window.__AK_ENI_SET__ = function (nextOn, nextText) {
    const r = origSet(nextOn, nextText);
    try { refreshBadge(); } catch (_) { /* ignore */ }
    return r;
  };

  // SPA observer: re-anchor the badge when the composer moves.
  let badgePending = false;
  const observer = (typeof MutationObserver !== 'undefined') ? new MutationObserver(() => {
    if (badgePending) return;
    badgePending = true;
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => {
      badgePending = false;
      if (!document.getElementById('ak-eni-badge')) injectBadge(); else placeBadge();
    });
  }) : null;
  if (typeof window.addEventListener === 'function') {
    const reposition = () => { try { placeBadge(); } catch (_) { /* ignore */ } };
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
  }

  function onBodyReady() {
    injectBadge();
    if (observer && document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.body) onBodyReady();
  else document.addEventListener('DOMContentLoaded', onBodyReady);
})();
