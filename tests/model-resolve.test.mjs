import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecord, createHistoryStore, addPageId, MAX_PAGE_IDS } from '../src/lib/history.js';
import { resolveModel, findRecord, modelsFromRuns, inferModelFromTitle, knownModels, SOURCE_TEXT } from '../src/lib/model-resolve.js';

/* 0.4.9 model-name hardening: every local source, in order of trust. */

const rec = (sessionId, model, extra = {}) => ({ ...mergeRecord(null, { sessionId, models: [{ model, provider: 'p' }], runId: 'run-' + sessionId, checkedAt: '2026-09-01T00:00:00Z', ...extra }) });
const idx = (...records) => new Map(records.map((r) => [r.sessionId, r]));

function memStore(data = {}) {
  const m = new Map(Object.entries(data));
  return { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, structuredClone(v)); }, keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), m };
}

test('history records remember their page ids (capped, no duplicates, never the stream id itself)', async () => {
  const r1 = mergeRecord(null, { sessionId: 'stream-1', models: [{ model: 'gpt-6' }], runId: 'r1', pageId: 'page-1' });
  assert.deepEqual(r1.pageIds, ['page-1']);
  const r2 = mergeRecord(r1, { sessionId: 'stream-1', models: [{ model: 'gpt-6' }], runId: 'r2', pageId: 'page-1' });
  assert.deepEqual(r2.pageIds, ['page-1']);
  assert.equal(mergeRecord(null, { sessionId: 's', models: [{ model: 'm' }], runId: 'r', pageId: 's' }).pageIds, undefined);
  let list = [];
  for (let i = 0; i < 12; i++) list = addPageId(list, 'p' + i, 'x');
  assert.equal(list.length, MAX_PAGE_IDS);
  assert.equal(list.at(-1), 'p11');
  assert.deepEqual(addPageId(['a'], 'bad id!', 'x'), ['a'], 'junk ids ignored');
  // store: linkPage adds to an existing record only
  const h = createHistoryStore(memStore());
  await h.save({ sessionId: 'stream-2', models: [{ model: 'claude-opus-5' }], runId: 'r' });
  assert.deepEqual((await h.linkPage('stream-2', 'page-2')).pageIds, ['page-2']);
  assert.equal(await h.linkPage('nope', 'page-3'), null);
  assert.deepEqual((await h.get('stream-2')).pageIds, ['page-2']);
});

test('resolveModel: live run first, then the history record by stream id / page id / pageIds', () => {
  const history = idx(rec('stream-a', 'gpt-6'), rec('stream-b', 'claude-opus-5', { pageId: 'page-b' }));
  // live identification wins over a record
  const live = resolveModel({ pageId: 'page-a', conversationFor: (id) => (id === 'page-a' ? 'stream-a' : id), sessions: new Map([['stream-a', { models: [{ model: 'gemini-3-pro', provider: '' }], runs: [] }]]), historyIndex: history });
  assert.deepEqual([live.source, live.models[0].model], ['live', 'gemini-3-pro']);
  // alias known → record by stream id
  const viaAlias = resolveModel({ pageId: 'page-a', conversationFor: (id) => (id === 'page-a' ? 'stream-a' : id), historyIndex: history });
  assert.deepEqual([viaAlias.source, viaAlias.sid, viaAlias.models[0].model, viaAlias.pageMatch], ['history', 'stream-a', 'gpt-6', false]);
  // alias LOST (restart, map gone) → record found through pageIds; caller re-learns the alias
  const viaPage = resolveModel({ pageId: 'page-b', historyIndex: history });
  assert.deepEqual([viaPage.source, viaPage.sid, viaPage.models[0].model, viaPage.pageMatch], ['history', 'stream-b', 'claude-opus-5', true]);
  // page id == stream id
  assert.equal(resolveModel({ pageId: 'stream-a', historyIndex: history }).models[0].model, 'gpt-6');
  // a restored (historical) session object does not count as live
  const hist = resolveModel({ pageId: 'stream-a', sessions: new Map([['stream-a', { models: [{ model: 'gpt-6', provider: 'p' }], runs: [], historical: true }]]), historyIndex: history });
  assert.equal(hist.source, 'history');
  assert.deepEqual(resolveModel({ pageId: null, historyIndex: history }).models, []);
});

test('resolveModel falls back to run span labels, then the turn tracker, then the title (标题推断)', () => {
  const noObs = { schemaVersion: 1, sessionId: 's1', url: 'https://arena.ai/agent/s1', title: 't', observations: [], runs: [{ runId: 'r1', spans: [{ spanId: 'x', model: 'old-model-1' }] }, { runId: 'r2', spans: [{ spanId: 'y', model: 'glm-5' }, { spanId: 'z', model: '' }] }] };
  const r1 = resolveModel({ pageId: 's1', historyIndex: idx(noObs) });
  assert.deepEqual([r1.source, r1.models.map((m) => m.model)], ['runs', ['glm-5']]);
  assert.deepEqual(modelsFromRuns([{ spans: [] }, null]), []);
  // live session without labels but with runs
  const r2 = resolveModel({ pageId: 's2', sessions: new Map([['s2', { models: [], runs: [{ runId: 'r', spans: [{ model: 'qwen-4-max' }] }] }]]) });
  assert.deepEqual([r2.source, r2.models[0].model], ['runs', 'qwen-4-max']);
  // turn tracker
  const r3 = resolveModel({ pageId: 's3', tracker: { sessionId: 's3', lastModel: 'kimi-k3' } });
  assert.deepEqual([r3.source, r3.models[0].model], ['turns', 'kimi-k3']);
  assert.equal(resolveModel({ pageId: 's3', tracker: { sessionId: 'other', lastModel: 'kimi-k3' } }).source, '', 'another conversation\'s tracker is ignored');
  // title: a model this device has seen before
  const seen = idx(rec('z1', 'claude-opus-4-1'), rec('z2', 'claude-opus-4'));
  const r4 = resolveModel({ pageId: 's4', historyIndex: seen, title: 'AK·Claude Opus 4.1 测试' });
  assert.deepEqual([r4.source, r4.models[0].model], ['title', 'claude-opus-4-1'], 'longest known name wins');
  assert.equal(SOURCE_TEXT.title.startsWith('标题推断'), true);
  // nothing at all
  assert.deepEqual(resolveModel({ pageId: 's5', title: 'How do I bake bread?' }).models, []);
});

test('inferModelFromTitle: known names anywhere; the "<prefix><model>-NNN" pattern; ordinary titles give nothing', () => {
  assert.equal(inferModelFromTitle('gpt-6-thinking-003', {}), 'gpt-6-thinking');
  assert.equal(inferModelFromTitle('探针·gemini-3-pro-012', { prefix: '探针·' }), 'gemini-3-pro');
  assert.equal(inferModelFromTitle('探针·gemini-3-pro', { prefix: '探针·' }), 'gemini-3-pro', 'prefix alone is enough');
  assert.equal(inferModelFromTitle('Refactor the parser', {}), '');
  assert.equal(inferModelFromTitle('fix-001', {}), '', 'needs a digit and a letter in the model part… and more than a word');
  assert.equal(inferModelFromTitle('Talk about GPT', { vocabulary: ['gpt'] }), '', 'too-short names never match');
  assert.equal(inferModelFromTitle('', { vocabulary: ['gpt-6'] }), '');
  assert.deepEqual(knownModels(idx(rec('a', 'm-1')), new Map([['b', { models: [{ model: 'm-2' }] }]])).sort(), ['m-1', 'm-2']);
  assert.equal(findRecord(idx(rec('a', 'm-1')), [null, 'a']).sessionId, 'a');
  assert.equal(findRecord(null, ['a']), null);
});
