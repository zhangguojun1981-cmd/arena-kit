import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COOLDOWN_MS, CONFIRM_MS, STALE_EMPTY_MS, Reason, RELOAD, IGNORE, track,
  initialState, parseStatus, decide, applied,
} from '../src/lib/watchdog.js';

// Mirrors the reference ReplyWatchdogTest: at=0 → page clock unknown (staleness
// skipped); act=BASE-1000 → recently active; act=0 → idle, never reload.
const BASE = 1_000_000;
const status = ({ key = 'empty', path = '/c/s1', generating = false, len = 0, at = 0, act = BASE - 1_000 } = {}) =>
  ({ key, path, generating, textLen: len, at, act });
const run = ({ state = initialState(), s = status(), now = BASE, ...opts } = {}) => decide(state, s, now, opts);
const sight = (state, s, now) => applied(state, s, decide(state, s, now), now);
const confirmed = (state = initialState(), problem = '/c/s1|empty', at = BASE - 30_000) =>
  ({ ...state, firstSeen: { ...state.firstSeen, [problem]: at } });

test('parseStatus ignores malformed reports and non-conversation paths', () => {
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus('WATCH|x'), null);
  assert.equal(parseStatus({ k: 'empty' }), null);
  assert.equal(parseStatus({ path: '/c/s1' }), null);
  assert.equal(parseStatus({ k: 'bogus', path: '/c/s1' }), null);
  assert.equal(parseStatus({ k: 'empty', path: '/settings' }), null);
});

test('parseStatus accepts valid statuses and caps the error snippet', () => {
  assert.deepEqual(parseStatus({ k: 'empty', path: '/c/s1', generating: false, len: 0, at: 123, act: 99 }),
    { key: 'empty', path: '/c/s1', generating: false, textLen: 0, at: 123, act: 99 });
  const e = parseStatus({ k: 'error:Something went wrong with this response, please try again.', path: '/agent/s2', len: 5, at: 9 });
  assert.equal(e.key, 'error:Something went wrong wit');
  assert.equal(e.textLen, 5);
  assert.equal(e.act, 0);
});

test('a fresh problem is tracked first, reloaded on the confirming sighting', () => {
  const s = status({ key: 'error:x' });
  assert.deepEqual(run({ s }), track(Reason.WAIT));
  const after = sight(initialState(), s, BASE);
  assert.equal(run({ state: after, s, now: BASE + CONFIRM_MS }), RELOAD);
  assert.deepEqual(run({ state: after, s, now: BASE + CONFIRM_MS - 1 }), track(Reason.WAIT));
});

test('no known activity, or an idle conversation, is never reloaded', () => {
  assert.equal(run({ s: status({ act: 0 }) }), IGNORE);
  assert.equal(run({ s: status({ key: 'error:x', act: 0 }) }), IGNORE);
  const now = BASE;
  assert.equal(run({ s: status({ key: 'error:x', act: now - 300_000, at: now - 1_000 }), now }), IGNORE);
  assert.equal(run({ s: status({ act: now - 200_000 }), now }), IGNORE);
  assert.equal(run({ state: confirmed(initialState(), '/c/s1|error:x'), s: status({ key: 'error:x', act: now - 60_000, at: now - 1_000 }), now }), RELOAD);
});

test('an empty reply that is still streaming is ignored', () => {
  assert.equal(run({ s: status({ generating: true }) }), IGNORE);
});

test('link tab / page load / recent task block the reload', () => {
  assert.deepEqual(run({ linkTabOpen: true }), track(Reason.BUSY));
  assert.deepEqual(run({ loading: true }), track(Reason.BUSY));
  const now = BASE;
  assert.deepEqual(run({ taskStartedAt: now - 60_000, now }), track(Reason.TASK_RUNNING));
  assert.deepEqual(run({ taskStartedAt: now - 130_000, now }), track(Reason.WAIT));
  const after = sight(initialState(), status(), now);
  assert.equal(run({ state: after, now: now + CONFIRM_MS, taskStartedAt: now - 130_000 }), RELOAD);
});

test('stale reports: empty goes cold after 20 s, errors stay actionable 45 s', () => {
  const now = BASE;
  assert.deepEqual(run({ s: status({ at: now - STALE_EMPTY_MS - 1 }), now }), track(Reason.STALE));
  assert.deepEqual(run({ s: status({ key: 'error:x', at: now - 40_000 }), now }), track(Reason.WAIT));
  assert.deepEqual(run({ s: status({ key: 'error:x', at: now - 50_000 }), now }), track(Reason.STALE));
});

test('cooldown is per path and does not apply to the first ever reload', () => {
  const now = BASE;
  const state = confirmed({ ...initialState(), lastReloadAt: { '/c/s1': now - 10_000 } });
  assert.deepEqual(run({ state, now }), track(Reason.COOLDOWN));
  assert.equal(run({ state, now: now + 25_000 }), RELOAD);
  const other = confirmed(state, '/c/s2|empty', now - 30_000);
  assert.equal(run({ state: other, s: status({ path: '/c/s2' }), now }), RELOAD);
  assert.equal(run({ state: confirmed({ ...initialState(), lastReloadAt: { '/c/s1': 0 } }), now: BASE + 5_000 }), RELOAD);
});

test('the same problem reloads at most twice, then one nag, then silence', () => {
  let state = initialState();
  let now = BASE;
  const s = status({ key: 'error:x' });
  const step = () => { const d = decide(state, s, now); state = applied(state, s, d, now); return d; };
  const confirm = () => { assert.deepEqual(step(), track(Reason.WAIT)); now += CONFIRM_MS; };
  confirm(); assert.equal(step(), RELOAD); now += COOLDOWN_MS + 1_000;
  confirm(); assert.equal(step(), RELOAD); now += COOLDOWN_MS + 1_000;
  assert.deepEqual(step(), track(Reason.NAG));
  assert.deepEqual(state.nagged, ['/c/s1|error:x']);
  assert.deepEqual(step(), track(Reason.CAPPED)); now += COOLDOWN_MS + 1_000;
  assert.deepEqual(step(), track(Reason.CAPPED));
});

test('a new problem key gets its own budget', () => {
  const problem = '/c/s1|error:x';
  const state = { ...initialState(), reloads: { [problem]: 10 }, nagged: [problem] };
  assert.deepEqual(run({ state, s: status({ key: 'error:x' }) }), track(Reason.CAPPED));
  assert.equal(run({ state: confirmed(state, '/c/s1|error:y'), s: status({ key: 'error:y' }) }), RELOAD);
  assert.equal(run({ state: confirmed(state, '/c/s1|empty'), s: status({ key: 'empty' }) }), RELOAD);
});

test('applied() updates the state without mutating the previous one', () => {
  const state = initialState();
  const now = BASE;
  const s = status({ key: 'error:x' });
  const problem = '/c/s1|error:x';
  const waited = applied(state, s, track(Reason.WAIT), now);
  assert.deepEqual(waited.firstSeen, { [problem]: now });
  assert.deepEqual(state.firstSeen, {}, 'previous state untouched');
  assert.deepEqual(applied(waited, s, track(Reason.WAIT), now + 999_999).firstSeen, { [problem]: now }, 'a second WAIT never rewinds the clock');
  const reloaded = applied(waited, s, RELOAD, now + 2_000 + BASE);
  assert.deepEqual(reloaded.lastReloadAt, { '/c/s1': now + 2_000 + BASE });
  assert.deepEqual(reloaded.reloads, { [problem]: 1 });
  assert.deepEqual(reloaded.firstSeen, {});
  assert.deepEqual(applied(state, s, track(Reason.NAG), now).nagged, [problem]);
  assert.equal(applied(state, s, track(Reason.COOLDOWN), now), state, 'plain tracks change nothing');
});
