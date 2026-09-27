import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTitle, sanitizePrefix, nextSuffix, normalizeModel, createRenameGate, MAX_TITLE } from '../src/lib/rename.js';

test('buildTitle joins prefix, model and probe suffix', () => {
  assert.equal(buildTitle({ model: 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(buildTitle({ prefix: 'AK-', model: 'claude-opus-5' }), 'AK-claude-opus-5');
  assert.equal(buildTitle({ prefix: '【探针】 ', model: ' gpt-6 ', suffix: '007' }), '【探针】 gpt-6-007');
  assert.equal(buildTitle({ prefix: null, model: 'm', suffix: null }), 'm');
  assert.throws(() => buildTitle({ prefix: 'AK', model: '  ' }), /尚未识别模型/);
});

test('prefix is sanitised: control chars stripped, whitespace collapsed, capped at 40', () => {
  assert.equal(sanitizePrefix('  a\u0000b \n\t c  '), 'ab c ');
  assert.equal(sanitizePrefix('x'.repeat(50)).length, 40);
  assert.equal(sanitizePrefix(undefined), '');
  assert.equal(buildTitle({ prefix: 'bad\u0007', model: 'm\u001f' }), 'badm');
});

test('titles respect the Arena 100-char cap by shortening the model part', () => {
  const long = 'm'.repeat(120);
  const t = buildTitle({ prefix: 'AK-', model: long, suffix: '001' });
  assert.equal(t.length, MAX_TITLE);
  assert.ok(t.startsWith('AK-mmm'));
  assert.ok(t.endsWith('…-001'));
  assert.equal(buildTitle({ model: 'x'.repeat(100) }).length, 100);
  assert.throws(() => buildTitle({ prefix: 'p'.repeat(40), model: 'm'.repeat(20), suffix: 'x'.repeat(55) }), /前缀过长/);
});

test('nextSuffix pads to 3 digits and counts per normalised model', () => {
  let r = nextSuffix('claude-opus-5', {});
  assert.equal(r.suffix, '001');
  r = nextSuffix('Claude Opus 5', r.counters);
  assert.equal(r.suffix, '002', 'normalised key shared across spellings');
  r = nextSuffix('gpt-6', r.counters);
  assert.equal(r.suffix, '001');
  assert.deepEqual(r.counters, { claudeopus5: 2, gpt6: 1 });
  assert.equal(nextSuffix('', { model: 9 }).suffix, '010');
  assert.equal(nextSuffix('x', { x: -5 }).suffix, '001');
  assert.equal(normalizeModel('ChatGPT-6 Astra'), 'chatgpt6astra');
});

test('rename gate claims once per conversation and survives history deletion', async () => {
  const data = {};
  const store = { get: async (k) => data[k] ?? null, set: async (k, v) => { data[k] = v; } };
  const gate = createRenameGate(store, { max: 3 });
  assert.equal(await gate.claim('s1'), true);
  assert.equal(await gate.claim('s1'), false);
  await assert.rejects(gate.claim('../x'));
  for (const s of ['s2', 's3', 's4']) assert.equal(await gate.claim(s), true);
  assert.deepEqual(data['rename-attempted'], ['s2', 's3', 's4'], 'oldest claims evicted');
  await gate.release('s3');
  assert.equal(await gate.claim('s3'), true);
});

test('nextSuffix counts every "<prefix><model>" name independently (ProbeLogic.nextSuffixFor)', () => {
  const a = nextSuffix('claude-opus-5', {}, '[探针] ');
  assert.equal(a.suffix, '001');
  assert.equal(a.counters['p:[探针]|claudeopus5'], 1);
  // Legacy per-model key keeps counting when there is no prefix.
  const b = nextSuffix('claude-opus-5', a.counters);
  assert.equal(b.suffix, '001');
  assert.equal(b.counters.claudeopus5, 1);
  // Same prefix (case / whitespace-insensitive) continues the counter.
  const c = nextSuffix('Claude Opus 5', b.counters, '  [探针]');
  assert.equal(c.suffix, '002');
  assert.equal(nextSuffix('claude-opus-5', c.counters, '[抽卡] ').suffix, '001');
  // Corrupt counters are ignored; at most 300 names are kept (oldest evicted first).
  assert.equal(nextSuffix('m', { m: -4 }).suffix, '001');
  let counters = {};
  for (let i = 0; i < 305; i++) counters = nextSuffix('model-' + i, counters).counters;
  assert.equal(Object.keys(counters).length, 300);
  assert.equal(counters.model0, undefined);
  assert.equal(counters.model304, 1);
});
