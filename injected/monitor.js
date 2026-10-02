/* ArenaKit injected/monitor.js — reply monitor (回复监控), page side.
 * MAIN world, document_start, after snoop.js.
 *
 * snoop.js hands every SSE frame of a realtime session stream to
 * window.__ARENAKIT_MONITOR__ (onOpen / onFrame / onEnd / onHttpError). This
 * module reduces a stream to numbers and flags — frame count, bytes, streamed
 * text length, error frames, how the stream ended, idle time — and posts ONLY
 * that summary to the dock as a `reply-monitor` page event. No conversation
 * text ever crosses the bridge; the only string forwarded is a server error
 * message (≤160 chars) when one is present.
 *
 * The dock (src/lib/monitor.js) turns a summary into anomaly badges on the
 * matching turn: empty reply, error, truncated (stream cut), stalled
 * (no frame for 2 min while Arena still shows its Stop button).
 */
(() => {
  if (window.__ARENAKIT_MONITOR__) return;

  const STALL_MS = 120_000;
  const TICK_MS = 5_000;
  const MAX_DEPTH = 6;
  const TEXT_KEYS = /^(?:delta|text|textDelta|text_delta|content|output_text|outputText|token|chunk|message|answer|response|value)$/i;
  const ERROR_KEYS = /^(?:error|errorMessage|error_message|err|failure|reason)$/i;
  const STATUS_KEYS = /^(?:status|state|type|event)$/i;
  const BAD_STATUS = /(?:^|[_.:\s-])(?:error|errored|failed|failure|crash|crashed|canceled|cancelled|timed?_?out|system_failure|interrupted)(?:$|[_.:\s-])/i;
  const STOP_LABEL = /^(?:stop generating|stop|停止生成|停止回复|停止)$/i;

  const streams = new Map(); // sessionId → stat

  // ArenaKit 设置 → 回复监控 off: observe nothing outward (the tap stays passive).
  const send = (payload) => { try { if (window.__ARENAKIT_FLAGS__ && window.__ARENAKIT_FLAGS__.monitor === false) return; window.__ARENAKIT__ && window.__ARENAKIT__.send('reply-monitor', payload); } catch { } };
  const visible = (e) => !!e && e.isConnected && e.getClientRects().length > 0;
  const isGenerating = () => [...document.querySelectorAll('button[aria-label]')].some((b) => visible(b) && STOP_LABEL.test(b.getAttribute('aria-label') || ''));

  function fresh(sessionId, now) {
    return { sessionId, startedAt: now, lastFrameAt: now, frames: 0, bytes: 0, textChars: 0, errorFrames: 0, lastError: '', lastStatus: '', ended: null, reported: false };
  }
  function stat(sessionId, now = Date.now()) {
    let s = streams.get(sessionId);
    if (!s || s.ended) { s = fresh(sessionId, now); streams.set(sessionId, s); }
    return s;
  }

  /* Sum the lengths of streamed-text-looking string fields (schema-agnostic). */
  function textLen(node, depth = 0) {
    if (depth > MAX_DEPTH || node == null) return 0;
    if (typeof node === 'string') return depth === 0 ? node.length : 0;
    if (Array.isArray(node)) { let n = 0; for (const x of node) n += textLen(x, depth + 1); return n; }
    if (typeof node !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') { if (TEXT_KEYS.test(k)) n += v.length; }
      else if (v && typeof v === 'object') n += textLen(v, depth + 1);
    }
    return n;
  }
  /* First error-looking field: an `error`/`reason` string or a failed status. */
  function errorOf(node, depth = 0) {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return null;
    for (const [k, v] of Object.entries(node)) {
      if (ERROR_KEYS.test(k)) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (v && typeof v === 'object') return String(v.message || v.error || v.code || JSON.stringify(v)).slice(0, 200);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (STATUS_KEYS.test(k) && typeof v === 'string' && BAD_STATUS.test(v)) return v;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') { const e = errorOf(v, depth + 1); if (e) return e; }
    }
    return null;
  }
  function statusOf(node) {
    if (!node || typeof node !== 'object') return '';
    for (const [k, v] of Object.entries(node)) if (STATUS_KEYS.test(k) && typeof v === 'string') return v.slice(0, 40);
    return '';
  }

  function parseFrame(raw) {
    let event = '';
    const data = [];
    for (const line of String(raw || '').split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    const text = data.join('\n');
    let obj = null;
    if (text) { try { obj = JSON.parse(text); } catch { obj = null; } }
    return { event, text, obj };
  }

  function onOpen(sessionId) { stat(sessionId, Date.now()); }

  function onFrame(sessionId, raw, bytes) {
    const now = Date.now();
    const s = stat(sessionId, now);
    const { event, text, obj } = parseFrame(raw);
    s.frames += 1;
    s.bytes += Number(bytes) || (text ? text.length : 0);
    s.lastFrameAt = now;
    if (obj !== null) {
      s.textChars += typeof obj === 'string' ? obj.length : textLen(obj);
      const st = statusOf(obj); if (st) s.lastStatus = st;
      const err = errorOf(obj);
      if (err || /error/i.test(event)) { s.errorFrames += 1; s.lastError = String(err || event).slice(0, 160); }
    } else if (/error/i.test(event)) {
      s.errorFrames += 1; s.lastError = (event + ' ' + text).trim().slice(0, 160);
    } else if (text) {
      s.textChars += text.length; // plain-text SSE
    }
  }

  function finish(s, how, now = Date.now()) {
    if (s.reported) return;
    s.ended = how;
    s.reported = true;
    send({
      sessionId: s.sessionId, ended: how, frames: s.frames, bytes: s.bytes, textChars: s.textChars,
      errorFrames: s.errorFrames, lastError: s.lastError, lastStatus: s.lastStatus,
      durationMs: Math.max(0, now - s.startedAt), idleMs: Math.max(0, now - s.lastFrameAt),
      generating: isGenerating(), at: now,
    });
  }

  function onEnd(sessionId, how) {
    const s = streams.get(sessionId);
    if (!s || s.reported) return;
    if (how === 'retry') return; // EventSource auto-reconnect; not final
    finish(s, how === 'abort' ? 'abort' : 'done');
  }

  function onHttpError(sessionId, status) {
    const s = stat(sessionId, Date.now());
    s.errorFrames += 1;
    s.lastError = 'HTTP ' + status;
    finish(s, 'http');
  }

  /* Stall check: an open stream with no frame for STALL_MS while Arena still
   * shows Stop → report once as 'stalled'. Exposed for tests (check(now)). */
  function check(now = Date.now()) {
    for (const s of streams.values()) {
      if (s.reported || s.ended) continue;
      if (now - s.lastFrameAt >= STALL_MS && isGenerating()) finish(s, 'stalled', now);
    }
    // forget finished streams older than 10 minutes
    for (const [id, s] of streams) if (s.reported && now - s.lastFrameAt > 600_000) streams.delete(id);
  }
  const timer = setInterval(() => { try { check(); } catch { } }, TICK_MS);

  window.__ARENAKIT_MONITOR__ = { onOpen, onFrame, onEnd, onHttpError, check, STALL_MS, _streams: streams, _timer: timer };
})();
