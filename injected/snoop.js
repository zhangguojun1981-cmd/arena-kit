/* ArenaKit injected/snoop.js
 * Source: arena-trace-android/assets/snoop.js v2 (itself the extension's snoop.js)
 * MAIN world, document_start. Taps the arena session stream for the Trigger.dev
 * public run token. Never captures conversation text — only the token.
 *
 * v2: arena can move the session stream between transports. We tap ALL of them:
 * fetch streaming, EventSource, XMLHttpRequest progressive reads and WebSocket
 * frames — plus a raw JWT-shape fallback inside those session-stream payloads,
 * so a token nested in a non-SSE (plain JSON) body is found too.
 *
 * PORT: tokens go to window.__ARENAKIT__.onToken({sessionId, token, page})
 * (bridge.js → routing guard → Rust `on_token`), falling back to the original
 * postMessage channel outside Tauri. `page` is location.pathname AT CAPTURE
 * TIME, so a late stream of a conversation the user already left is not
 * attributed to the chat now on screen. Stream activity without a new token
 * (arena streams many replies through ONE run) is reported as a throttled,
 * content-free ping → bridge.onActivity → the last lookup is re-run.
 *
 * ArenaKit addition kept from v1: a frame hook for the reply monitor
 * (injected/monitor.js): window.__ARENAKIT_MONITOR__.{onOpen,onFrame,onEnd,
 * onHttpError} receive the raw SSE frames IN THE PAGE ONLY — the monitor
 * reduces them to counts/flags before anything crosses the bridge.
 */
(() => {
  if (window.__ATI_SNOOP__) return;
  window.__ATI_SNOOP__ = true;
  const TOKEN_KEY = /^public[-_]access[-_]?token$/i;
  // A JWT-shaped publicAccessToken: three base64url segments, first one starts
  // with eyJ ("{\"…" — every JWT does). Long ones are capped in emit().
  const JWT_LIKE = /eyJ[A-Za-z0-9_-]{6,2000}\.[A-Za-z0-9_-]{6,4000}\.[A-Za-z0-9_-]{6,2000}/g;
  const MAX_SEEN = 256;
  const seen = new Set();
  const lastPingAt = new Map();
  const bridge = () => window.__ARENAKIT__;

  // ArenaKit 设置 → 截获会话流 off: keep the taps installed but hand nothing over.
  const captureOff = () => !!(window.__ARENAKIT_FLAGS__ && window.__ARENAKIT_FLAGS__.capture === false);

  // Every new frame on a session stream is "activity" the dock may want to
  // refetch for. Pings are throttled hard (bridge.js applies its own 45 s
  // cooldown too) and carry no content — only the session id and the page path.
  function pingActivity(sessionId) {
    const now = Date.now();
    if (now - (lastPingAt.get(sessionId) || 0) < 15000) return;
    lastPingAt.set(sessionId, now);
    if (lastPingAt.size > 64) lastPingAt.delete(lastPingAt.keys().next().value);
    if (captureOff()) return;
    try {
      const b = bridge();
      if (b && typeof b.onActivity === 'function') b.onActivity({ sessionId, page: location.pathname });
    } catch {}
  }
  function sessionFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      // Arena is always served over HTTPS to the page; realtime WebSockets use
      // wss:// — match by hostname + the two page-legal protocol families.
      if (u.hostname !== 'arena.ai') return null;
      if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null;
      // Must stay in lockstep with the extension's core.js streamSession so this
      // page-world tap covers exactly the URLs the debugger path does.
      return u.pathname.match(/^\/ai-proxy\/realtime\/v\d+\/sessions\/([a-zA-Z0-9-]+)\/(?:out|stream)\/?$/)?.[1]
        || u.pathname.match(/^\/ai-proxy\/(?:v\d+\/)?realtime\/sessions\/([a-zA-Z0-9-]+)\/(?:out|stream)\/?$/)?.[1]
        || null;
    } catch { return null; }
  }
  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (typeof URL === 'function' && input instanceof URL) return input.href;
    return input?.url;
  }
  function emit(token, sessionId) {
    if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) return;
    if (captureOff()) return;
    const page = location.pathname;
    // The stream repeats a run's token on many records; forward each
    // (page, session, token) once. The page is part of the key so a token first
    // seen on another chat is re-sent once the user opens its own chat.
    const key = page + '|' + sessionId + '|' + token;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    // ArenaKit: hand the token to the Rust bridge if present, else fall back to
    // the original postMessage channel (keeps this file usable as a plain userscript).
    const b = bridge();
    if (b && typeof b.onToken === 'function') {
      try { b.onToken({ sessionId, token, page }); return; } catch {}
    }
    window.postMessage({ source: 'ati-snoop', sessionId, token }, 'https://arena.ai');
  }
  function takeTokens(obj, sessionId) {
    const records = Array.isArray(obj?.records) ? obj.records : obj ? [obj] : [];
    for (const record of records) {
      const headers = record?.headers;
      const pairs = Array.isArray(headers) ? headers : headers && typeof headers === 'object' ? Object.entries(headers) : [];
      for (const pair of pairs) {
        if (Array.isArray(pair) && TOKEN_KEY.test(String(pair[0] || '')) && typeof pair[1] === 'string') emit(pair[1], sessionId);
      }
      if (typeof record?.publicAccessToken === 'string') emit(record.publicAccessToken, sessionId);
    }
  }
  function scanSse(text, sessionId) {
    if (typeof text !== 'string' || !text) return;
    for (const chunk of text.split(/\r?\n\r?\n/)) {
      const data = chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let obj; try { obj = JSON.parse(data); } catch { continue; }
      takeTokens(obj, sessionId);
    }
  }
  // Fallback: scan raw payload text for JWT-shaped tokens (covers non-SSE
  // bodies such as a plain JSON response on the stream endpoints).
  function scanRaw(text, sessionId) {
    if (typeof text !== 'string' || text.length < 40) return;
    if (!/eyJ/.test(text)) return;
    JWT_LIKE.lastIndex = 0;
    let m;
    let budget = 8;
    while ((m = JWT_LIKE.exec(text)) && budget-- > 0) emit(m[0], sessionId);
  }
  function scanChunk(text, sessionId) {
    pingActivity(sessionId);
    scanSse(text, sessionId);
    scanRaw(text, sessionId);
  }
  // Reply-monitor hook (optional, page-world only). Guarded so a monitor bug
  // can never break token capture.
  const monitor = () => window.__ARENAKIT_MONITOR__;
  const mon = (fn, ...args) => { try { const m = monitor(); if (m && typeof m[fn] === 'function') m[fn](...args); } catch {} };
  async function tapBody(body, sessionId) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    mon('onOpen', sessionId);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 2 * 1024 * 1024) buf = buf.slice(-65536);
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() || '';
        for (const part of parts) { scanChunk(part + '\n\n', sessionId); mon('onFrame', sessionId, part, value ? value.byteLength : 0); }
        // Scan the remainder too, so a token split across a chunk boundary is
        // still caught by the raw fallback (data lines are retried on the next
        // read through buf).
        if (buf.length > 40 && /eyJ/.test(buf)) scanRaw(buf.slice(-131072), sessionId);
      }
      if (buf.trim()) { scanChunk(buf + '\n\n', sessionId); mon('onFrame', sessionId, buf, 0); }
      mon('onEnd', sessionId, 'done');
    } catch (e) {
      mon('onEnd', sessionId, 'abort');
      throw e;
    }
  }
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      const sessionId = sessionFromUrl(urlOf(args[0]));
      if (!sessionId) return response;
      if (!response.ok) { mon('onHttpError', sessionId, response.status); return response; }
      if (!response.body) return response;
      try {
        const [page, probe] = response.body.tee();
        tapBody(probe, sessionId).catch(() => {});
        const copy = new Response(page, { headers: response.headers, status: response.status, statusText: response.statusText });
        // Keep the properties a Response built from a stream would otherwise lose.
        try { Object.defineProperty(copy, 'url', { value: response.url }); } catch {}
        try { Object.defineProperty(copy, 'redirected', { value: response.redirected }); } catch {}
        return copy;
      } catch { return response; }
    };
  }
  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    window.EventSource = function (url, config) {
      const es = new OrigES(url, config);
      const sessionId = sessionFromUrl(urlOf(url));
      if (sessionId) {
        mon('onOpen', sessionId);
        es.addEventListener('message', ev => { if (typeof ev.data === 'string') { scanChunk('data: ' + ev.data + '\n\n', sessionId); mon('onFrame', sessionId, 'data: ' + ev.data, ev.data.length); } });
        es.addEventListener('error', () => mon('onEnd', sessionId, es.readyState === OrigES.CLOSED ? 'abort' : 'retry'));
      }
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
    window.EventSource.CONNECTING = OrigES.CONNECTING;
    window.EventSource.OPEN = OrigES.OPEN;
    window.EventSource.CLOSED = OrigES.CLOSED;
  }
  // XMLHttpRequest progressive read: the classic way to stream a POSTed SSE,
  // and a path the fetch tap cannot see.
  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function' && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    if (typeof origOpen === 'function' && typeof origSend === 'function') {
      OrigXHR.prototype.open = function () {
        try { this.__atiSid = sessionFromUrl(urlOf(arguments[1])); } catch { this.__atiSid = null; }
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function () {
        const sid = this.__atiSid;
        if (sid) {
          let offset = 0;
          try {
            this.addEventListener('readystatechange', () => {
              if (this.readyState < 3) return;
              let text;
              try { text = this.responseText; } catch { return; }
              if (typeof text !== 'string') return;
              const chunk = text.slice(offset);
              offset = text.length;
              if (chunk.length) scanChunk(chunk, sid);
              else scanRaw(text.slice(-131072), sid);
            });
          } catch {}
        }
        return origSend.apply(this, arguments);
      };
    }
  }
  // WebSocket frames on the session-stream endpoints (arena's realtime).
  const OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    window.WebSocket = function (url, protocols) {
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      const sessionId = sessionFromUrl(urlOf(url));
      if (sessionId) {
        ws.addEventListener('message', ev => { if (typeof ev.data === 'string') scanChunk(ev.data + '\n\n', sessionId); });
      }
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }
})();
