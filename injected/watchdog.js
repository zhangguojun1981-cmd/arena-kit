/* ArenaKit injected/watchdog.js — conversation watchdog, page side.
 * Source: arena-trace-android assets/watchdog.js (v3), adapted to the ArenaKit
 * bridge. MAIN world, document_start, after probe.js.
 *
 * Reports reply errors and empty-reply states in the OPEN conversation to the
 * dock (auto-refresh policy lives dock-side: src/lib/watchdog.js, port of the
 * reference ReplyWatchdog). An IDLE conversation is never touched: the
 * watchdog only evaluates while there has been recent conversation activity —
 * the user sent a message, a Stop button showed, the reply text grew, or a
 * session-stream request was observed, within the last 2 min. A chat you just
 * read, or a failed card left on screen from a previous turn, stays silent.
 * The freshness stamps survive a reload in sessionStorage, so the legit
 * "model done, page shows nothing — reload fixes it" case still works after
 * the first auto reload.
 *
 * Short polling (setInterval) is intentional: the failure mode it watches is
 * exactly a page whose React / observers / event loops have stalled.
 *
 * Only status crosses the bridge ({ k, path, generating, len, at, act } as the
 * `watch` page event); conversation text never does (24-char error snippet,
 * capped again dock-side). Idempotent; re-injection bumps the version.
 * Switched off (工具 → 回复出错或空白时自动刷新) the scan is skipped entirely
 * (window.__ARENAKIT_FLAGS__.autoRefresh === false). */
(() => {
  const VERSION = 3;
  if ((window.__ARENAKIT_WATCHDOG__?.version || 0) >= VERSION) return;

  const FRESH_MS = 120_000;
  const ERROR_GRACE_MS = 1000;
  const EMPTY_GRACE_MS = 15000;
  const TAIL_ROUNDS = 3; // ×600ms: last-checkpoint tail emitting nothing ⇒ "ended"
  const STABLE_STREAK = 3; // a problem must persist 3 scans before it is reported
  const SCAN_MS = 600;
  const MAX_MESSAGE_CHARS = 50000;
  const ACTIVITY_KEY = 'arenakit.watchdog.activity';
  const SEND_KEY = 'arenakit.watchdog.send';

  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const enabled = () => !(window.__ARENAKIT_FLAGS__ && window.__ARENAKIT_FLAGS__.autoRefresh === false);
  const report = (payload) => { try { window.__ARENAKIT__ && window.__ARENAKIT__.send('watch', payload); } catch { } };

  // ---- activity tracking (the freshness gate) ----
  let lastActivityAt = (() => { try { return Number(sessionStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; } })();
  function touchActivity() {
    lastActivityAt = Date.now();
    try { sessionStorage.setItem(ACTIVITY_KEY, String(lastActivityAt)); } catch { }
  }
  // A SEND is the only evidence that a reply is owed.
  let lastSendAt = (() => { try { return Number(sessionStorage.getItem(SEND_KEY)) || 0; } catch { return 0; } })();
  function touchSend() {
    lastSendAt = Date.now();
    touchActivity();
    try { sessionStorage.setItem(SEND_KEY, String(lastSendAt)); } catch { }
  }
  const fresh = () => Date.now() - lastActivityAt <= FRESH_MS;

  const SEND_LABEL = /^(send( message)?|submit|发送(消息)?)$/i;
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && ev.target?.closest?.('textarea,[contenteditable="true"]')) touchSend();
  }, true);
  addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('button');
    if (!b) return;
    const label = (b.getAttribute('aria-label') || '').trim() || clean(b.textContent);
    if (SEND_LABEL.test(label) || b.type === 'submit') touchSend();
  }, true);

  // Session-stream requests show up as resource timing entries — the only
  // reliable "the model is talking" signal when the UI never shows Stop.
  let lastSeenResource = 0;
  function scanStreamResources(now) {
    try {
      const origin = performance.timeOrigin || 0;
      if (!origin) return;
      for (const e of performance.getEntriesByType('resource')) {
        if (!/\/sessions\/|\/ai-proxy\//.test(e.name || '')) continue;
        const end = Math.round(origin + (e.responseEnd || e.startTime || 0));
        if (end > lastSeenResource) {
          lastSeenResource = end;
          if (now - end < FRESH_MS) touchActivity();
        }
      }
    } catch { }
  }

  // ---- error picker ----
  const ERROR_PATTERNS = [
    /something\s+went\s+wrong(\s+with\s+this\s+response)?[,\s]*\s*(please\s+)?try\s+again/i,
    /no\s+preview\s+available/i,
    /network\s+error[^\n]{0,80}(try\s+again|please)/i,
    /\berror\b[^\n]{0,80}please\s+try\s+again/i,
    /request\s+failed[^\n]{0,80}(try\s+again|please)/i,
    /rate\s*limit(ed)?\b/i,
    /too\s+many\s+requests/i,
    /出现了一点?问题[，,。\s]*.*(重试|再试)/,
    /出了点?问题[，,。\s]*.*(重试|再试)/,
    /遇到问题[，,。\s]*.*(重试|再试)/,
    /出了些问题[，,。\s]*.*(重试|再试)/,
    /出现了问题/,
    /发生错误[，,。\s]*.*(重试|再试)/,
    /网络错误[^\n]{0,40}(重试|再试|稍后)/,
    /请求失败[^\n]{0,40}(重试|再试|稍后)/,
    /(操作)?过于频繁/,
  ];
  const matchError = (t) => ERROR_PATTERNS.find((re) => re.test(t));
  const after = (a, b) => { try { return !!(b.compareDocumentPosition(a) & 4); } catch { return false; } };

  // The last TAIL error element (deepest match). Empty when the newest error
  // has a healthy, non-trivial reply below it — that's an OLD card.
  function tailErrorText() {
    const body = document.body;
    if (!body) return '';
    const bodyText = clean(body.innerText || body.textContent || '');
    const hit = matchError(bodyText);
    if (!hit) return '';
    let last = null;
    for (const el of body.querySelectorAll('div, p, span, section, article')) {
      if (el.children.length > 0) continue; // deepest containers only
      const t = clean(el.textContent);
      if (t && t.length <= 400 && hit.test(t)) last = el;
    }
    if (!last) return bodyText.slice(0, 40);
    for (const m of replyContainers()) {
      if (m.text.length > 40 && after(m.el, last)) return ''; // a reply below the error ⇒ earlier turn
    }
    return clean(last.textContent).slice(0, 40); // capped again dock-side
  }

  // ---- answer containers ----
  const REPLY_SEL = 'div[class*="prose"], div[class*="message"], article, [data-message], [class*="assistant"], [class*="answer"]';
  const CHROME_SEL = '[contenteditable="true"], textarea, button, [role="button"], form, nav, header, footer';

  function slideWindow() {
    const slides = document.querySelectorAll(':is([aria-roledescription="slide"], [data-carousel-item])');
    let best = null;
    for (const s of slides) {
      if (s.getAttribute('aria-hidden') === 'true') continue;
      const r = s.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.left < -8) continue; // slid away to the left
      if (!best || r.left < best.getBoundingClientRect().left + 8) best = s;
    }
    return best;
  }

  // {el, text} of every plausible reply block on the page, document order.
  function replyContainers() {
    const roots = [];
    const scoped = slideWindow();
    if (scoped) roots.push(scoped);
    else roots.push(document.querySelector('main') || document.body);
    const out = [];
    const seen = new Set();
    for (const root of roots) {
      if (!root?.querySelectorAll) continue;
      for (const el of root.querySelectorAll(REPLY_SEL)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.closest?.(CHROME_SEL)) continue; // vote bar / composer / chrome
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        let skip = false;
        for (const parent of out) { if (parent.el.contains(el)) { skip = true; break; } }
        if (skip) continue; // keep the outermost match, not nested dupes
        const t = clean(el.innerText || el.textContent);
        if (t && t.length <= MAX_MESSAGE_CHARS) out.push({ el, text: t });
      }
    }
    return out;
  }

  // "Generating" only counts when a Stop button is actually VISIBLE.
  const isGenerating = () => [...document.querySelectorAll('button[aria-label]')].some((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && /^(stop generating|stop|停止生成|停止回复|停止)$/i.test((b.getAttribute('aria-label') || '').trim());
  });
  const onAgentPath = () => /^\/agent|^\/c\//.test(location.pathname);

  // ---- reporter ----
  let lastPath = '';
  let generatingStreak = 0;
  let lastRawLen = -1, prevRawLen = -1, tailQuiet = 0;
  let errorSince = 0, emptySince = 0, lastKey = '';
  let stableKey = '', stableStreak = 0;
  let sendBaselineAt = 0, baselineTotal = -1;

  function resetAccumulators() {
    lastKey = '';
    errorSince = 0;
    emptySince = 0;
    generatingStreak = 0;
    tailQuiet = 0;
    stableKey = '';
    stableStreak = 0;
  }

  function scan() {
    if (!enabled()) return;
    const path = location.pathname;
    if (!onAgentPath() || !document.body) {
      lastPath = '';
      resetAccumulators();
      lastRawLen = -1; prevRawLen = -1;
      return;
    }
    if (path !== lastPath) { // SPA conversation switch: never carry verdicts over
      lastPath = path;
      resetAccumulators();
      lastRawLen = -1; prevRawLen = -1;
    }
    const now = Date.now();
    scanStreamResources(now);

    // Evidence gathering happens BEFORE the freshness gate.
    const stop = isGenerating();
    if (stop) touchActivity();
    const replies = replyContainers();
    const rawLen = replies.at(-1)?.text.length || 0;
    const totalLen = replies.reduce((a, m) => a + m.text.length, 0);
    if (lastRawLen >= 0 && rawLen > lastRawLen) touchActivity();
    lastRawLen = rawLen;
    // Only a SEND moves the "nothing rendered yet" baseline.
    if (lastSendAt > sendBaselineAt) {
      sendBaselineAt = lastSendAt;
      baselineTotal = totalLen;
    }

    if (!fresh()) { // idle conversation: stay silent
      resetAccumulators();
      return;
    }

    generatingStreak = stop ? 0 : generatingStreak + 1;
    const generatingLikely = stop || generatingStreak < 2;

    // Tail: streaming ended once the last checkpoint stops growing.
    if (!stop && rawLen === prevRawLen) tailQuiet = Math.min(tailQuiet + 1, TAIL_ROUNDS);
    else tailQuiet = 0;
    prevRawLen = rawLen;
    const ended = !stop && tailQuiet >= TAIL_ROUNDS;

    const err = tailErrorText();
    let key = '';
    if (err && !generatingLikely) {
      if (!errorSince) errorSince = now;
      if (now - errorSince >= ERROR_GRACE_MS) key = 'error:' + err;
    } else errorSince = 0;

    // "Empty" = we sent a message, streaming has ended, and NOTHING new appeared
    // since the send for the whole grace period. Short valid replies ("好",
    // "OK") are legitimate and must never reload the page.
    const noGrowth = baselineTotal >= 0 && totalLen <= baselineTotal;
    if (!key && ended && noGrowth) {
      if (!emptySince) emptySince = now;
      if (now - emptySince >= EMPTY_GRACE_MS) key = 'empty';
    } else if (!noGrowth) emptySince = 0;

    if (key !== stableKey) { stableKey = key; stableStreak = 0; }
    if (key) stableStreak++;
    if (!key || stableStreak < STABLE_STREAK || key === lastKey) return;
    lastKey = key;
    report({ k: key, path, generating: stop, len: rawLen, at: now, act: lastActivityAt });
  }

  window.__ARENAKIT_WATCHDOG__ = { scan, touchActivity, touchSend, version: VERSION };
  scan();
  setInterval(scan, SCAN_MS);
})();
