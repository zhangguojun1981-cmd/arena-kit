import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TARGETS, PROMPTS, randomPrompt, normalize, parseTargets, compileTarget, matchTargets,
  remainingTargets, allTargetsHit, isArithmeticTitle, isOwnPrompt, arithmeticCleanupCandidates, nextSuffix,
} from '../src/lib/probe-logic.js';

test('parseTargets splits, trims, dedups and caps at 20', () => {
  assert.deepEqual(parseTargets('opus5, fable5; gpt6'), ['opus5', 'fable5', 'gpt6']);
  assert.deepEqual(parseTargets('opus5，fable5；\ngpt6.'), ['opus5', 'fable5', 'gpt6']);
  assert.deepEqual(parseTargets('a, opus5, opus5, x'), ['opus5']);
  assert.equal(parseTargets(Array.from({ length: 30 }, (_, i) => 'model' + (i + 1)).join(',')).length, 20);
  assert.deepEqual(parseTargets(null), []);
  assert.deepEqual(DEFAULT_TARGETS, ['opus5', 'fable5', 'gpt6']);
});

test('model families and aliases', () => {
  let hits = matchTargets(['claude-opus-5', 'gpt-4o'], ['opus5']);
  assert.deepEqual(hits, [{ target: 'opus5', model: 'claude-opus-5' }]);
  assert.equal(matchTargets(['chatgpt-6-astra'], ['gpt6']).length, 1);
  assert.equal(matchTargets(['gpt 6 pro'], ['gpt6']).length, 1);
  assert.equal(matchTargets(['opus-50'], ['opus5']).length, 0, 'negative lookahead guards 5 → 50');
  assert.equal(matchTargets(['ChatGPT-6'], ['chatgpt6']).length, 1);
  assert.equal(matchTargets(['claude-fable-5.1'], ['fable51']).length, 1);
  assert.equal(matchTargets(['gpt-4o'], ['opus5']).length, 0);
  hits = matchTargets(['claude-opus-5', 'chatgpt-6-astra'], ['opus5', 'fable5', 'gpt6']);
  assert.deepEqual(hits.map((h) => h.target), ['opus5', 'gpt6']);
});

test('literal /regex/ targets and fuzzy plain tokens', () => {
  assert.equal(matchTargets(['gemini-2.5-pro'], ['/gemini.*pro/']).length, 1);
  assert.equal(matchTargets(['GEMINI-PRO'], ['/gemini/']).length, 1, 'case-insensitive even without flag');
  assert.equal(matchTargets(['gpt-4o'], ['gpt 4o']).length, 1, 'separators fuzzy');
  assert.equal(matchTargets(['gpt-4o'], ['gpt.4o']).length, 1);
  assert.equal(matchTargets(['gpt4o'], ['gpt-4o']).length, 1);
  assert.equal(compileTarget(''), null);
  assert.equal(compileTarget('  '), null);
  assert.equal(compileTarget('/(/'), null, 'invalid regex → null');
  assert.equal(compileTarget('/' + 'x'.repeat(121) + '/'), null);
  assert.equal(compileTarget('/a/gi').flags, 'i');
  assert.equal(compileTarget('/a/ms').flags, 'ims');
  assert.ok(compileTarget('/a/g').flags.includes('i'));
  assert.ok(!compileTarget('/a/g').flags.includes('g'), 'global flag dropped (stateful lastIndex)');
  assert.equal(matchTargets(['a+b'], ['a+b']).length, 1, 'plain metacharacters escaped');
});

test('remaining / allTargetsHit accumulate across rounds without draining', () => {
  const targets = ['opus5', 'fable5', 'gpt6'];
  const hit = (target, model) => ({ target, model });
  assert.deepEqual(remainingTargets(targets, [hit('opus5', 'claude-opus-5')]), ['fable5', 'gpt6']);
  const partial = [hit('opus5', 'claude-opus-5'), hit('opus5', 'claude-opus-5')];
  assert.equal(allTargetsHit(targets, partial), false);
  assert.equal(allTargetsHit(targets, [...partial, hit('fable5', 'claude-fable-5'), hit('gpt6', 'chatgpt-6')]), true);
  assert.equal(allTargetsHit([], []), false);
});

test('arithmetic titles recognised, user titles left alone', () => {
  for (const t of ['1+1=', ' 12 - 4 = ', '5*5=', '8÷2=', '1+1=\u200B', '\u200B12 - 4 =', '12＋12=', '12－4 =', '6＊7＝', '8−2=']) assert.equal(isArithmeticTitle(t), true, t);
  for (const t of ['claude-opus-5', 'My chat about math 1+1', '', 'gpt6-001', '1+1=2', '3*4=12', null]) assert.equal(isArithmeticTitle(t), false, String(t));
  assert.equal(isOwnPrompt('hello'), false);
  assert.equal(isOwnPrompt('1+1=2'), false);
  assert.equal(isOwnPrompt('473×82='), true);
});

test('cleanup candidates: arithmetic only, deduped, current chat kept', () => {
  const sidebar = [
    { sessionId: 's1', title: '1+1=' }, { sessionId: 's2', title: 'claude-opus-5-001' },
    { sessionId: 's3', title: '3*4=' }, { sessionId: 's4', title: 'My project notes' },
  ];
  assert.deepEqual(arithmeticCleanupCandidates(sidebar).map((c) => c.sessionId), ['s1', 's3']);
  const dup = [{ sessionId: 's1', title: '1+1=' }, { sessionId: 's1', title: '1+1=' }, { sessionId: 'keep', title: '2+2=' }];
  assert.deepEqual(arithmeticCleanupCandidates(dup, 'keep').map((c) => c.sessionId), ['s1']);
  assert.deepEqual(arithmeticCleanupCandidates(null), []);
});

test('prompts: reference set + random prompts are sendable and cleanable', () => {
  assert.equal(PROMPTS.length, 50);
  assert.equal(PROMPTS[0], '1+1=');
  assert.equal(PROMPTS.at(-1), '50+50=');
  assert.ok(PROMPTS.every(isOwnPrompt));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = randomPrompt();
    assert.equal(isOwnPrompt(p), true, p);
    assert.equal(isArithmeticTitle(p), true, p);
    seen.add(p);
  }
  assert.ok(seen.size > 100, 'random');
  assert.equal(randomPrompt(() => 0), '1+1=');
  assert.equal(randomPrompt(() => 0.999999), '999÷999=');
});

test('suffix counters and normalize are shared with rename.js', () => {
  const r = nextSuffix('claude-opus-5', {});
  assert.equal(r.suffix, '001');
  assert.equal(r.counters[normalize('claude-opus-5')], 1);
  const r2 = nextSuffix('opus5', { [normalize('opus5')]: 2 });
  assert.equal(r2.suffix, '003');
  assert.equal(nextSuffix('gpt6', r2.counters).suffix, '001');
});
