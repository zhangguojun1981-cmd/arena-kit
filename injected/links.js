/* ArenaKit injected/links.js — in-app link tab, page side.
 * Port of the reference app's link handling (arena-trace-android LinkPolicy +
 * LinkTab): links never navigate the conversation away.
 *
 *  - a tap on a link to another site, a target=_blank link, or window.open()
 *    → the in-app link tab (Android: native WebView layer driven through the
 *    `ArenaKitAndroid` bridge the MainActivity overlay installs; desktop: a
 *    separate window via the `open_tab` command);
 *  - Arena itself, sign-in / challenge hosts, passive schemes → load in place
 *    (server redirects and script navigations are left alone as well);
 *  - mailto: / tel: / intent: … → other apps (navigation-level, src-tauri
 *    links.rs → `external()` below on Android);
 *  - file: / content: / javascript: → never.
 *
 * The Rust `on_navigation` hook (links.rs) is the safety net behind this
 * interceptor for navigations that never went through a click. MAIN world,
 * document_start (after bridge.js). Idempotent; no conversation text leaves
 * the page — only the URL that was tapped. */
(() => {
  const VERSION = 1;
  if ((window.__ARENAKIT_LINKS__?.version || 0) >= VERSION) return;

  const ARENA_DOMAINS = ['arena.ai', 'lmarena.ai'];
  const WEB_SCHEMES = new Set(['http', 'https']);
  const PASSIVE_SCHEMES = new Set(['about', 'blob', 'data']);
  const FORBIDDEN_SCHEMES = new Set(['file', 'content', 'javascript', 'vbscript']);
  const AUTH_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com', 'challenges.cloudflare.com']);
  const AUTH_SUFFIXES = ['.supabase.co', '.auth0.com', '.clerk.accounts.dev', '.firebaseapp.com'];
  const AUTH_PATHS = { 'github.com': ['/login', '/session'], 'discord.com': ['/oauth2', '/api/oauth2'], 'x.com': ['/i/oauth2'], 'twitter.com': ['/i/oauth2'] };

  const normalizeHost = (h) => String(h || '').trim().replace(/\.+$/, '').toLowerCase();
  const isArenaHost = (h) => { const x = normalizeHost(h); return !!x && ARENA_DOMAINS.some((d) => x === d || x.endsWith('.' + d)); };
  const isAuthFlow = (h, path) => {
    const x = normalizeHost(h);
    if (!x) return false;
    if (AUTH_HOSTS.has(x) || AUTH_SUFFIXES.some((s) => x.endsWith(s))) return true;
    const p = String(path || '');
    return (AUTH_PATHS[x.replace(/^www\./, '')] || []).some((a) => p === a || p.startsWith(a + '/'));
  };
  const schemeOf = (url) => { const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; };
  const isWebUrl = (url) => { const u = String(url || '').trim(); const s = schemeOf(u); return WEB_SCHEMES.has(s) && u.length > s.length + 3; };

  /* Where a same-window navigation of the arena page should go:
   * 'in-place' | 'tab' | 'external' | 'block'. (LinkPolicy.routeMain.) */
  function routeMain(url, { gesture = true, redirect = false, linkClick = true, newWindow = false } = {}) {
    const s = schemeOf(url);
    if (!s || PASSIVE_SCHEMES.has(s)) return 'in-place';
    if (FORBIDDEN_SCHEMES.has(s)) return 'block';
    if (WEB_SCHEMES.has(s)) {
      let host = '', path = '';
      try { const u = new URL(url); host = u.hostname; path = u.pathname; } catch { return 'in-place'; }
      // A window the page opens itself (target=_blank / window.open) always
      // goes to the tab — except sign-in pop-ups, which must keep their opener.
      if (newWindow) return isAuthFlow(host, path) ? 'in-place' : 'tab';
      if (isArenaHost(host) || redirect || isAuthFlow(host, path)) return 'in-place';
      return gesture && linkClick ? 'tab' : 'in-place';
    }
    return gesture ? 'external' : 'block';
  }

  // ---- transports ----
  // Android: the MainActivity overlay injects `ArenaKitAndroid` (WebMessageListener,
  // or a JavascriptInterface on old WebViews) — both take postMessage(json).
  const nativeBridge = () => { const n = window.ArenaKitAndroid; return n && typeof n.postMessage === 'function' ? n : null; };
  const nativeSend = (msg) => { const n = nativeBridge(); if (!n) return false; try { n.postMessage(JSON.stringify(msg)); return true; } catch { return false; } };
  const nativeOpen = window.open.bind(window);
  let tabOpen = false;

  function openTab(url) {
    const u = String(url || '');
    if (!isWebUrl(u)) return false;
    if (nativeSend({ cmd: 'openTab', url: u })) return true;
    // Desktop: Rust opens a separate window.
    const ak = window.__ARENAKIT__;
    if (ak && typeof ak.invoke === 'function') {
      ak.invoke('open_tab', { url: u }).then((ok) => { if (ok === false) nativeOpen(u, '_blank', 'noopener'); }).catch(() => { nativeOpen(u, '_blank', 'noopener'); });
      return true;
    }
    nativeOpen(u, '_blank', 'noopener'); // plain browser / userscript: a real new tab
    return true;
  }
  function external(url) {
    const u = String(url || '');
    if (!u || FORBIDDEN_SCHEMES.has(schemeOf(u)) || isWebUrl(u)) return false;
    return nativeSend({ cmd: 'external', url: u });
  }

  // ---- interception ----
  function absolute(href) { try { return new URL(href, location.href).href; } catch { return ''; } }
  function onClick(ev, middle = false) {
    if (ev.defaultPrevented || (middle ? ev.button !== 1 : ev.button !== 0)) return;
    const a = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    if (a.closest && a.closest('#arenakit-embed')) return; // the dock's own links
    const href = absolute(a.getAttribute('href'));
    if (!href) return;
    const target = (a.getAttribute('target') || '').toLowerCase();
    // ⌘/ctrl-click and middle-click mean "new tab" like target=_blank does.
    const newWindow = middle || ev.metaKey || ev.ctrlKey || target === '_blank'
      || (!!target && target !== '_self' && target !== '_top' && target !== '_parent');
    const route = routeMain(href, { gesture: ev.isTrusted !== false, linkClick: true, newWindow });
    if (route === 'tab') {
      if (openTab(href)) ev.preventDefault();
    } else if (route === 'block') {
      ev.preventDefault();
    }
    // 'external' and 'in-place' are left to the navigation (links.rs routes them).
  }
  document.addEventListener('click', (ev) => onClick(ev, false), true);
  document.addEventListener('auxclick', (ev) => onClick(ev, true), true);

  // window.open: pages call it for "open in new tab" buttons and share links.
  window.open = function (url, target, features) {
    const href = url == null || url === '' ? '' : absolute(String(url));
    if (href && routeMain(href, { newWindow: true }) === 'tab' && openTab(href)) return null;
    return nativeOpen(url, target, features);
  };

  window.__ARENAKIT_LINKS__ = {
    version: VERSION,
    routeMain, isArenaHost, isAuthFlow, isWebUrl,
    /* Rust links.rs (navigation-level) / dock → open the tab. */
    open: openTab,
    /* Rust links.rs → hand a mailto:/tel:/intent: URL to another app (Android). */
    external,
    /* Native LinkTab → page: keep the open state here for the dock (watchdog gate). */
    setOpen(v) { tabOpen = !!v; try { window.__ARENAKIT__ && window.__ARENAKIT__.send('link-tab', { open: tabOpen }); } catch { } },
    isOpen: () => tabOpen,
    close: () => nativeSend({ cmd: 'closeTab' }),
    hasNativeTab: () => !!nativeBridge(),
  };
})();
