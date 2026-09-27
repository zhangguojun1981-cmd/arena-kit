import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charCount,
  creditBand,
  creditPercent,
  describeModels,
  formatReset,
  nextThemeMode,
  pushRecent,
  relativeTime,
  resolveTheme,
  shortRun,
} from '../src/lib/format.js';

test('creditPercent clamps and rounds', () => {
  assert.equal(creditPercent(72, 100), 72);
  assert.equal(creditPercent(1, 3), 33);
  assert.equal(creditPercent(150, 100), 100);
  assert.equal(creditPercent(-5, 100), 0);
  assert.equal(creditPercent(5, 0), null);
  assert.equal(creditPercent(undefined, 100), null);
  assert.equal(creditPercent('7', '10'), 70);
});

test('creditBand mirrors pulse.rs thresholds', () => {
  assert.equal(creditBand(5), 'danger');
  assert.equal(creditBand(9.9), 'danger');
  assert.equal(creditBand(10), 'warning');
  assert.equal(creditBand(19), 'warning');
  assert.equal(creditBand(20), 'ok');
  assert.equal(creditBand(100), 'ok');
  assert.equal(creditBand(null), 'none');
  assert.equal(creditBand(NaN), 'none');
});

test('shortRun truncates long ids only', () => {
  assert.equal(shortRun('run_0f3a9c2d7e1b'), 'run_0f3a9c…');
  assert.equal(shortRun('run_1'), 'run_1');
  assert.equal(shortRun(undefined), '');
  assert.equal(shortRun(''), '');
});

test('describeModels dedupes and flags partial', () => {
  const d = describeModels([
    { model: 'claude-opus-4-1', provider: 'anthropic', partial: false },
    { model: 'claude-opus-4-1', provider: 'anthropic', partial: true },
    { model: 'gpt-5', provider: 'openai' },
  ]);
  assert.equal(d.name, 'claude-opus-4-1 · gpt-5');
  assert.equal(d.provider, 'anthropic / openai');
  assert.equal(d.partial, true);
  assert.equal(d.count, 2);
  assert.deepEqual(describeModels(undefined), { name: '', provider: '', partial: false, count: 0 });
  assert.equal(describeModels([{ provider: 'x' }]).name, '');
});

test('formatReset handles ms, seconds, ISO and past', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  assert.equal(formatReset(now + 40 * 60_000, now), '40 分钟后重置');
  assert.equal(formatReset(now + 135 * 60_000, now), '2 小时 15 分后重置');
  assert.equal(formatReset(now + 3 * 3_600_000, now), '3 小时后重置');
  assert.equal(formatReset(Math.floor((now + 40 * 60_000) / 1000), now), '40 分钟后重置');
  assert.equal(formatReset(new Date(now + 40 * 60_000).toISOString(), now), '40 分钟后重置');
  assert.equal(formatReset(now - 1000, now), '即将重置');
  assert.equal(formatReset(null, now), '');
  assert.equal(formatReset('', now), '');
  assert.match(formatReset(now + 30 * 3_600_000, now), /重置$/);
});

test('relativeTime buckets', () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 10_000, now), '刚刚');
  assert.equal(relativeTime(now - 3 * 60_000, now), '3 分钟前');
  assert.match(relativeTime(now - 2 * 3_600_000, now), /^\d\d:\d\d$/);
  assert.match(relativeTime(now - 3 * 86_400_000, now), /^\d+\/\d+ \d\d:\d\d$/);
});

test('pushRecent bounds and collapses duplicates', () => {
  let list = [];
  list = pushRecent(list, { name: 'a', at: 1 });
  list = pushRecent(list, { name: 'a', at: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, 2);
  for (let i = 0; i < 10; i++) list = pushRecent(list, { name: 'm' + i, at: i }, 5);
  assert.equal(list.length, 5);
  assert.equal(list[0].name, 'm9');
});

test('theme cycle and resolution', () => {
  assert.equal(nextThemeMode('system'), 'light');
  assert.equal(nextThemeMode('light'), 'dark');
  assert.equal(nextThemeMode('dark'), 'system');
  assert.equal(nextThemeMode('garbage'), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('charCount counts code points', () => {
  assert.equal(charCount(''), '0 字');
  assert.equal(charCount('你好😀'), '3 字');
  assert.equal(charCount(undefined), '0 字');
});
