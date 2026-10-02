/* ArenaKit injected/fingerprint.js
 * MAIN world, document_start. The page-only reducer for the model-fingerprint
 * feature. It receives the SAME raw SSE frames the reply monitor does
 * (snoop.js → window.__ARENAKIT_FINGERPRINT__.{onOpen,onFrame,onEnd}) but it
 * NEVER forwards reply text. It reduces a FIXED-PROBE answer to a structured,
 * numeric-only feature and hands only that to the dock:
 *
 *   histogram  protocol → { counts:[…], n, dims }          (integer run tallies)
 *   categorical protocol → { questionId, value }            (one normalized pick)
 *
 * No conversation text, token, header or raw frame crosses the bridge. The
 * reduction mirrors src/lib/fingerprint.js (parseIntegers/histogram and the
 * answer-normalization) so the dock scores the same features it would offline.
 *
 * BINDING: the reducer only looks at a stream once the dock has ARMED it for a
 * specific {sessionId, probeId, protocolId, kind}. A frame on any other session,
 * or any frame received while disarmed, is ignored. If an armed stream cannot be
 * reduced to the expected feature shape (wrong protocol frame, un-parseable
 * body), the reducer reports a parse-error CODE and STOPS — it never guesses a
 * value. The send is flag-gated exactly like the monitor:
 * window.__ARENAKIT_FLAGS__.fingerprint === false silences it.
 */
(() => {
  if (window.__ARENAKIT_FINGERPRINT__) return;

  // Keep in lockstep with data/fingerprint/protocols/modeltrace-long-integers-v1.json
  // and src/lib/fingerprint.js. Hard-coded here (not fetched) so a remote config
  // can never widen the parse surface of a page-world reducer.
  const HISTOGRAM_DIMS = 355;
  const HISTOGRAM_MIN = 1;
  const HISTOGRAM_MAX = 355;
  const MAX_TEXT = 1 << 20;              // in-page accumulation cap (never sent)
  const MAX_FRAMES = 4000;               // give up binding a run after this many
  const MAX_VALUE_LEN = 64;              // normalized categorical pick cap
  const FORGET_MS = 600000;              // drop idle armed streams after 10 min

  // Parse-error codes carried in the sample (numbers only — no text):
  //  0 ok · 1 no-valid-numbers · 2 too-few-numbers · 3 empty-answer
  //  4 bind-failed (frames never matched the armed probe shape)
  const ERR = { OK: 0, NO_NUMBERS: 1, FEW_NUMBERS: 2, EMPTY: 3, BIND_FAILED: 4 };

  // Flag-gated, content-free handoff to the dock (bridge → Rust page_event →
  // dock 'fingerprint-sample'). Identical gate to injected/monitor.js.
  function send(payload) {
    try {
      if (window.__ARENAKIT_FLAGS__ && window.__ARENAKIT_FLAGS__.fingerprint === false) return;
      if (window.__ARENAKIT__ && typeof window.__ARENAKIT__.send === 'function') {
        window.__ARENAKIT__.send('fingerprint-sample', payload);
      }
    } catch {}
  }

  // --- answer-reduction helpers (mirror src/lib/fingerprint.js) --------------

  // Longest run of in-range integers in the text. Mirrors parseIntegers():
  // split on any gap that contains a letter so "model 7 says 42" does not glue
  // the model number onto the sequence; keep only values in [min,max].
  function parseIntegers(text, min, max) {
    if (typeof text !== 'string' || !text) return [];
    let best = [];
    for (const segment of text.split(/[^\d\s,./×÷+\-]*\p{L}[^\d]*/u)) {
      const nums = [];
      const re = /-?\d+/g;
      let m;
      while ((m = re.exec(segment))) {
        const v = Number(m[0]);
        if (Number.isInteger(v) && v >= min && v <= max) nums.push(v);
      }
      if (nums.length > best.length) best = nums;
    }
    return best;
  }

  function histogram(numbers, dims) {
    const counts = new Array(dims).fill(0);
    for (const v of numbers) {
      const i = v - HISTOGRAM_MIN;
      if (i >= 0 && i < dims) counts[i] += 1;
    }
    return counts;
  }

  // One categorical answer → a single normalized token. We DO NOT ship the
  // reply; we ship at most one short lowercase word/number the page extracted
  // for the single question this probe asked. Anything longer than a short pick
  // is treated as an un-reducible answer (STOP, not guess).
  function normalizePick(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim().toLowerCase();
    if (!t) return null;
    // Prefer a bare integer answer (e.g. "1-100" question → "47").
    const n = t.match(/-?\d+/);
    if (n && /^\D*-?\d+\D*$/.test(t)) return n[0].slice(0, MAX_VALUE_LEN);
    // Otherwise a single short word (e.g. "blue", "cat", "heads").
    const w = t.match(/[\p{L}]+/u);
    if (w && w[0].length <= MAX_VALUE_LEN && t.replace(/[^\p{L}]/gu, '').length <= MAX_VALUE_LEN) {
      return w[0];
    }
    return null;
  }

  // --- SSE frame parsing (clone of injected/monitor.js parseFrame) -----------
  // Accumulates ONLY the reply text, in the page, for the armed stream. The
  // text is reduced on finish and then discarded; it never leaves this closure.
  const MAX_DEPTH = 6;
  const TEXT_KEYS = /^(?:delta|text|textDelta|text_delta|content|output_text|outputText|token|chunk|message|answer|response|value)$/i;

  function collectText(node, depth, out) {
    if (node == null || depth > MAX_DEPTH) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) { for (const v of node) collectText(v, depth + 1, out); return; }
    if (typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && TEXT_KEYS.test(k)) out.push(v);
      else collectText(v, depth + 1, out);
    }
  }

  function frameText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return '';
    let obj;
    try { obj = JSON.parse(data); } catch { return ''; }
    const out = [];
    collectText(obj, 0, out);
    return out.join('');
  }

  // --- armed-stream state ----------------------------------------------------
  // At most one probe is armed at a time. A frame on any other session is
  // ignored outright.
  let armed = null; // { sessionId, probeId, protocolId, kind, questionId, buf, frames, boundFrames, startedAt, lastAt }

  function reset() { armed = null; }

  function arm(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const kind = c.kind === 'categorical' ? 'categorical' : c.kind === 'histogram' ? 'histogram' : null;
    // sessionId may be absent while the fresh conversation is still /agent.
    // In that case this is a one-shot pending arm: onOpen() binds it to the
    // very next stream. The runner establishes this arm before clicking Send,
    // avoiding the Android race where reply frames arrive before its RPC returns.
    if (!c.probeId || !c.protocolId || !kind) { reset(); return; }
    armed = {
      sessionId: c.sessionId ? String(c.sessionId).slice(0, 128) : null,
      probeId: String(c.probeId).slice(0, 128),
      protocolId: String(c.protocolId).slice(0, 128),
      kind,
      questionId: c.questionId ? String(c.questionId).slice(0, 64) : null,
      buf: '',
      frames: 0,
      boundFrames: 0,
      startedAt: Date.now(),
      lastAt: Date.now(),
      opened: false,
      lastEnd: null,
    };
  }

  function reduce(a, ended) {
    const base = {
      sessionId: a.sessionId,
      probeId: a.probeId,
      protocolId: a.protocolId,
      kind: a.kind,
      frames: a.frames,
      ended,
      at: new Date().toISOString(),
    };
    if (a.boundFrames === 0) return { ...base, parseError: ERR.BIND_FAILED };
    if (a.kind === 'histogram') {
      const nums = parseIntegers(a.buf, HISTOGRAM_MIN, HISTOGRAM_MAX);
      if (!nums.length) return { ...base, counts: null, n: 0, dims: HISTOGRAM_DIMS, parseError: ERR.NO_NUMBERS };
      return {
        ...base,
        counts: histogram(nums, HISTOGRAM_DIMS),
        n: nums.length,
        dims: HISTOGRAM_DIMS,
        parseError: ERR.OK,
      };
    }
    // categorical
    const pick = normalizePick(a.buf);
    if (pick == null) return { ...base, questionId: a.questionId, value: null, parseError: a.buf ? ERR.NO_NUMBERS : ERR.EMPTY };
    return { ...base, questionId: a.questionId, value: pick, parseError: ERR.OK };
  }

  function finish(a, ended) {
    const sample = reduce(a, ended);
    reset();
    send(sample);
  }

  // --- snoop.js hook surface (same shape as window.__ARENAKIT_MONITOR__) -----
  function onOpen(sessionId) {
    if (!armed) return;
    // A pending pre-send arm binds exactly once to the next opened stream.
    // Once bound, every other session remains ignored as before.
    if (!armed.sessionId) armed.sessionId = String(sessionId || '').slice(0, 128);
    if (!armed.sessionId || armed.sessionId !== sessionId) return;
    // Agent replies may open/end several streams (thinking, tool work, final
    // answer). Initialise only the first one; never erase earlier/final chunks
    // merely because another stream phase opened for the same turn.
    if (!armed.opened) {
      armed.buf = '';
      armed.frames = 0;
      armed.boundFrames = 0;
      armed.startedAt = Date.now();
      armed.opened = true;
    }
    armed.lastAt = Date.now();
  }

  function onFrame(sessionId, raw, _bytes) {
    if (!armed || armed.sessionId !== sessionId) return; // bind to armed probe only
    armed.frames += 1;
    armed.lastAt = Date.now();
    if (armed.frames > MAX_FRAMES) { finish(armed, 'overflow'); return; }
    const text = frameText(raw);
    if (text) {
      armed.boundFrames += 1;
      if (armed.buf.length < MAX_TEXT) armed.buf += text;
    }
  }

  function onEnd(sessionId, how) {
    if (!armed || armed.sessionId !== sessionId) return;
    // SSE ending is NOT reply completion in Agent Mode: thinking/tool/final
    // phases can end separately. Keep accumulating until probe.js observes the
    // platform's task-feedback popup and explicitly calls complete().
    armed.lastEnd = how || 'stream-end';
    armed.lastAt = Date.now();
  }

  function complete(sessionId) {
    if (!armed || armed.sessionId !== sessionId) return false;
    finish(armed, 'feedback-popup');
    return true;
  }

  function onHttpError(sessionId, _status) {
    if (!armed || armed.sessionId !== sessionId) return;
    armed.lastEnd = 'http-error';
    armed.lastAt = Date.now();
  }

  // Housekeeping: drop a stale armed stream that never ended.
  function check(now) {
    if (armed && (now - armed.lastAt) > FORGET_MS) finish(armed, 'stall');
  }
  const timer = setInterval(() => { try { check(Date.now()); } catch {} }, 5000);

  // Dock → page arming bus (bridge.dispatch → on handlers). The dock arms the
  // reducer right before it sends a fixed probe and disarms when the runner
  // stops / is cancelled / changes page.
  try {
    const b = window.__ARENAKIT__;
    if (b && typeof b.on === 'function') {
      b.on('fingerprint-arm', (payload) => arm(payload));
      b.on('fingerprint-disarm', () => reset());
    }
  } catch {}

  window.__ARENAKIT_FINGERPRINT__ = {
    onOpen, onFrame, onEnd, onHttpError, check, complete,
    arm, disarm: reset,
    ERR, HISTOGRAM_DIMS, FORGET_MS,
    _state: () => armed,
    _timer: timer,
  };
})();
