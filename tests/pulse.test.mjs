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
function loadPulse({ responses = [], cookie = 'a=1' } = {}) {
  const page = fakePage({ pathname: '/agent' });
  const sent = [], fetches = [], handlers = {};
  page.sandbox.__ARENAKIT__ = { send: (n, p) => sent.push({ name: n, payload: plain(p) }), on: (n, fn) => { handlers[n] = fn; } };
  page.sandbox.setInterval = () => 0;
  page.sandbox.setTimeout = () => 0;
  page.document.cookie = cookie;
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
  assert.equal(handlers['pulse-refresh'](), true, 'dock-requested refresh (real clock is far past every gap)');
  await flush();
  assert.equal(sent[4].payload.error, '未登录 Arena');
  assert.equal(fetches.length, 5);
  assert.equal(P.tick(Date.now() + 14_000), false, 'refresh requests still respect the 15 s floor');
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
