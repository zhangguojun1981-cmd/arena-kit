import test from 'node:test';
import assert from 'node:assert/strict';
import { resetTimeFromRefreshedAt, anchorReset, band, formatCountdown, formatReset, createPulseState, QUOTA_WINDOW_MS } from '../src/lib/pulse.js';
import { runInjected, fakePage, plain } from './helpers.mjs';

const hour = 3_600_000, day = 24 * hour, now = 1_000_000_000_000;

test('resetTimeFromRefreshedAt (PulseTiming port)', () => {
  const refreshed = now - 3 * hour;
  assert.equal(resetTimeFromRefreshedAt(refreshed, now), refreshed + day);
  assert.equal(resetTimeFromRefreshedAt(now + 5 * hour, now), now + 5 * hour);
  assert.equal(resetTimeFromRefreshedAt(0, now), 0);
  assert.equal(resetTimeFromRefreshedAt(-1, now), 0);
  assert.equal(resetTimeFromRefreshedAt(NaN, now), 0);
  assert.equal(QUOTA_WINDOW_MS, day);
});

test('anchorReset keeps the countdown stable across refetches', () => {
  const candidate = now + 20 * hour;
  assert.equal(anchorReset(0, candidate, now), candidate, 'first anchor adopts');
  const anchor = now + 21 * hour;
  const later = now + 60_000;
  assert.equal(anchorReset(anchor, resetTimeFromRefreshedAt(later - 3 * hour, later), later), anchor, 'forward drift does not restart');
  assert.equal(anchorReset(anchor, anchor + 30_000, now), anchor, 'within tolerance keeps');
  assert.equal(anchorReset(anchor, now + 18 * hour, now), now + 18 * hour, 'earlier adopts');
  assert.equal(anchorReset(now - 60_000, now + day, now), now + day, 'after rollover adopts');
  assert.equal(anchorReset(now + 10 * hour, 0, now), now + 10 * hour, 'zero candidate keeps');
});

test('band / countdown / reset formatting', () => {
  assert.equal(band(5), 'danger');
  assert.equal(band(15), 'warning');
  assert.equal(band(50), 'ok');
  assert.equal(band(NaN), 'unknown');
  assert.equal(formatCountdown(3_723_000), '1:02:03');
  assert.equal(formatCountdown(-5), '0:00:00');
  assert.equal(formatReset(0, now), '');
  assert.equal(formatReset(now + 90_000, now), '0:01:30 后重置');
  assert.equal(formatReset(now - 1, now), '已到重置时间，正在重新读取…');
});

test('pulse state: pending + transient errors keep the last value', () => {
  let now = 1_000_000;
  const st = createPulseState({ now: () => now });
  st.ingest({ ok: true, percent: 64, at: now });
  let v = st.ingest({ pending: true, at: now });
  assert.equal(v.pending, true);
  assert.equal(v.percent, 64);
  assert.match(v.text, /64% · 刷新中/);
  v = st.ingest({ ok: false, transient: true, error: '额度接口限流（429），60 秒后自动重试', at: now });
  assert.equal(v.pending, false);
  assert.equal(v.percent, 64, '429 keeps the known value');
  assert.equal(v.transient, true);
  const fresh = createPulseState({ now: () => now });
  assert.equal(fresh.ingest({ pending: true }).text, '额度刷新中…');
});

test('pulse state ingests page events and renders like the Android HUD', () => {
  let t = now;
  const ps = createPulseState({ now: () => t });
  assert.equal(ps.view().text, '额度读取中…');
  let v = ps.ingest({ ok: true, percent: 87, refreshedAt: now - 3 * hour, at: now });
  assert.equal(v.percent, 87);
  assert.equal(v.band, 'ok');
  assert.equal(v.text, '剩余额度 87% · 21:00:00 后重置');
  t = now + 60_000;
  v = ps.ingest({ ok: true, percent: 86, refreshedAt: now - 3 * hour + 60_000, at: t });
  assert.equal(v.text, '剩余额度 86% · 20:59:00 后重置', 'anchor kept: countdown keeps falling');
  v = ps.ingest({ ok: false, error: '额度接口限流（429）', retryAfterMs: 120_000, at: t });
  assert.equal(v.text, '剩余额度 86% · 20:59:00 后重置 · 额度接口限流（429）');
  assert.equal(ps.state.blockedUntil, t + 120_000);
  v = ps.ingest({ ok: true, percent: 9, refreshedAt: 0, at: t });
  assert.equal(v.band, 'danger');
  assert.equal(v.error, '');
  const fresh = createPulseState({ now: () => t });
  assert.equal(fresh.ingest({ ok: false, error: '未登录 Arena', at: t }).text, '额度：未登录 Arena');
  assert.equal(fresh.ingest({ ok: true, percent: 150, at: t }).percent, 100);
});

/* ── injected/pulse.js ───────────────────────────────────────────────── */
function loadPulse({ responses = [], cookie = 'a=1', login = 'logged-in' } = {}) {
  const page = fakePage({ pathname: '/agent' });
  const sent = [], fetches = [], handlers = {};
  page.sandbox.__ARENAKIT__ = { send: (n, p) => sent.push({ name: n, payload: plain(p) }), on: (n, fn) => { handlers[n] = fn; } };
  page.sandbox.setInterval = () => 0;
  page.sandbox.setTimeout = () => 0;
  page.sandbox.clearTimeout = () => {};
  page.document.cookie = cookie;
  page.sandbox.ArenaAccount = { snapshot: () => ({ state: typeof login === 'function' ? login() : login }) };
  page.sandbox.fetch = async (url, opts) => {
    fetches.push({ url, opts });
    const r = responses.shift() || { status: 200, json: { pulse: 42, refreshedAt: '2026-09-27T00:00:00Z' } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (k) => r.headers?.[k] ?? null }, json: async () => r.json };
  };
  runInjected('injected/pulse.js', page.sandbox);
  return { P: page.sandbox.__ARENAKIT_PULSE__, sent, fetches, handlers, page };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('page pulse poller: same-origin GET, 60 s cadence, cookie change → 15 s, 429 back-off', async () => {
  const { P, sent, fetches, handlers, page } = loadPulse({ responses: [
    { status: 200, json: { pulse: 87, refreshedAt: '2026-09-27T01:02:03Z' } },
    { status: 429, headers: { 'Retry-After': '90' } },
    { status: 200, json: { pulse: 86, refreshedAt: '2026-09-27T01:02:03Z' } },
    { status: 200, json: { nope: 1 } },
    { status: 401 },
  ] });
  assert.equal(P.PULSE_URL, 'https://arena.ai/api/me/pulse');
  let t = 1_000_000;
  assert.equal(P.tick(t), true);
  await flush();
  assert.equal(fetches[0].url, P.PULSE_URL);
  assert.equal(fetches[0].opts.credentials, 'include');
  assert.deepEqual(sent[0], { name: 'pulse', payload: { ok: true, percent: 87, refreshedAt: Date.parse('2026-09-27T01:02:03Z'), at: t } });
  assert.equal(P.tick(t + 59_000), false, 'within the 60 s gap');
  t += 60_000;
  assert.equal(P.tick(t), true);
  await flush();
  assert.equal(sent[1].payload.ok, false);
  assert.equal(sent[1].payload.retryAfterMs, 90_000);
  assert.equal(P.tick(t + 60_000), false, 'blocked until Retry-After elapses even after the normal gap');
  t += 90_001;
  assert.equal(P.tick(t), true);
  await flush();
  assert.equal(sent[2].payload.percent, 86);
  page.document.cookie = 'a=2; session=other';
  assert.equal(P.tick(t + 14_000), false);
  assert.equal(P.tick(t + 15_000), true, 'account switch → earlier refetch');
  await flush();
  assert.equal(sent[3].payload.error, '额度返回格式未识别');
  assert.equal(typeof handlers['pulse-refresh'], 'function');
  assert.equal(P.requestRefresh(Date.now()), true, 'dock-requested refresh (real clock is far past every gap)');
  await flush();
  assert.deepEqual(sent[4].payload.pending, true, 'a manual refresh answers at once');
  assert.equal(sent[5].payload.error, '登录会话刷新中，稍后自动重试', '401 while the cookie says logged in is transient');
  assert.equal(sent[5].payload.transient, true);
  assert.equal(fetches.length, 5);
  assert.equal(P.tick(Date.now() + 2_000), false, 'transient retry waits 5 s');
  assert.equal(P.tick(Date.now() + 5_500), true, 'transient retry after 5 s');
});

test('page pulse: 429 is rate limiting (transient), manual refresh answers while blocked', async () => {
  const { P, sent, fetches } = loadPulse({ responses: [
    { status: 429, headers: { 'Retry-After': '300' } },
    { status: 429 },
    { status: 200, json: { pulse: 70 } },
  ] });
  let t = 5_000_000;
  assert.equal(P.tick(t), true);
  await flush();
  assert.equal(sent[0].payload.transient, true);
  assert.match(sent[0].payload.error, /限流（429），300 秒/);
  assert.doesNotMatch(sent[0].payload.error, /未登录/);
  // explicit Retry-After: a manual refresh cannot override it, but it answers
  assert.equal(P.requestRefresh(t + 20_000), false);
  assert.match(sent[1].payload.error, /限流中，280 秒后自动重试/);
  assert.equal(fetches.length, 1);
  t += 300_001;
  assert.equal(P.tick(t), true, 'the pending manual request runs once the block ends');
  await flush();
  // guessed back-off (no Retry-After, 60 s): manual may retry after 15 s
  assert.equal(P.requestRefresh(t + 10_000), false);
  assert.equal(P.requestRefresh(t + 15_000), true);
  await flush();
  assert.equal(sent.at(-1).payload.percent, 70);
});

test('page pulse: 401 is "未登录" only for a guest page; logged-in retries 3× then says reload', async () => {
  let who = 'guest';
  const { P, sent } = loadPulse({ login: () => who, responses: [{ status: 401 }, { status: 401 }, { status: 401 }, { status: 401 }, { status: 401 }] });
  let t = 9_000_000;
  P.tick(t); await flush();
  assert.equal(sent[0].payload.error, '未登录 Arena');
  who = 'logged-in';
  t += 60_000; P.tick(t); await flush();
  assert.equal(sent[1].payload.transient, true);
  t += 5_000; assert.equal(P.tick(t), true); await flush();
  t += 10_000; assert.equal(P.tick(t), true); await flush();
  t += 15_000; assert.equal(P.tick(t), true); await flush();
  assert.match(sent[4].payload.error, /拒绝访问（HTTP 401），请重新加载页面/);
  assert.equal(sent.filter((x) => x.payload.error === '未登录 Arena').length, 1, 'never "未登录" while logged in');
});

test('page pulse: a hung fetch times out instead of parking the poller', async () => {
  const page = fakePage({ pathname: '/agent' });
  const sent = [];
  const timers = [];
  page.sandbox.__ARENAKIT__ = { send: (n, p) => sent.push(plain(p)), on: () => {} };
  page.sandbox.setInterval = () => 0;
  page.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  page.sandbox.clearTimeout = () => {};
  page.sandbox.fetch = () => new Promise(() => {});
  runInjected('injected/pulse.js', page.sandbox);
  const P = page.sandbox.__ARENAKIT_PULSE__;
  assert.equal(P.tick(1_000_000), true);
  const to = timers.find((x) => x.ms === 15_000);
  assert.ok(to, '15 s timeout armed');
  to.fn();
  await flush();
  assert.match(sent.at(-1).error, /超时/);
  assert.equal(sent.at(-1).transient, true);
});

test('page pulse parse accepts only the documented shape', () => {
  const { P } = loadPulse();
  assert.deepEqual(plain(P.parse({ pulse: 99, refreshedAt: '2026-09-27T00:00:00Z' })), { percent: 99, refreshedAt: Date.parse('2026-09-27T00:00:00Z') });
  assert.deepEqual(plain(P.parse({ pulse: '12.6' })), { percent: 13, refreshedAt: 0 });
  assert.deepEqual(plain(P.parse({ pulse: 50, refreshedAt: 1_700_000_000 })), { percent: 50, refreshedAt: 1_700_000_000_000 });
  assert.equal(P.parse({ pulse: 101 }), null);
  assert.equal(P.parse({ percent: 5 }), null);
  assert.equal(P.parse(null), null);
});
