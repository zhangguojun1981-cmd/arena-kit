/* Which model does the conversation on screen belong to? (0.4.9)
 *
 * The header / pill / 服务端模型 module used to know a conversation's model
 * only through ONE path: page id → alias → stream id → live runs or the
 * history record keyed by that stream id. Any gap left "模型待确认":
 *   - the page announced its conversation before the history / aliases were
 *     loaded (app start) and nothing looked again;
 *   - the alias page id → stream id was never learned (conversation opened
 *     from the sidebar after a restart, stream id ≠ /agent/{id});
 *   - the history read failed once;
 *   - a trace arrived without model labels and cleared the display.
 * resolveModel() walks every local source in order of trust and says where
 * the answer came from; the dock re-runs it whenever one of those sources
 * changes. Pure functions, no DOM.
 *
 * Sources, best first:
 *   live      models identified in this app session (trace pipeline)
 *   history   the stored record: by stream id, by page id, or by a record
 *             that lists the page id in `pageIds` (saved since 0.4.9)
 *   runs      the record / live runs' span labels when observations are empty
 *   turns     the turn tracker's last identified model for this conversation
 *   title     last resort: a known model name (or the probe's
 *             "<prefix><model>-NNN" pattern) inside the conversation title —
 *             shown as 标题推断, never saved as an observation
 */
import { recordModels, addPageId, MAX_PAGE_IDS } from './history.js';
import { normalizeModel, sanitizePrefix } from './rename.js';

export { addPageId, MAX_PAGE_IDS };

const uniq = (list) => {
  const out = [];
  for (const m of list) if (m && m.model && !out.some((x) => x.model === m.model && x.provider === m.provider)) out.push(m);
  return out;
};

/* Span model labels of the newest run that has any. */
export function modelsFromRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const spans = Array.isArray(list[i] && list[i].spans) ? list[i].spans : [];
    const models = uniq(spans.map((s) => (s && typeof s.model === 'string' && s.model.trim() ? { model: s.model.trim().slice(0, 200), provider: String(s.provider || '').slice(0, 100) } : null)));
    if (models.length) return models;
  }
  return [];
}

/* The stored record for a page / stream id: direct key, then pageIds. */
export function findRecord(historyIndex, ids) {
  if (!historyIndex || typeof historyIndex.get !== 'function') return null;
  const want = [...new Set((ids || []).filter(Boolean))];
  for (const id of want) { const r = historyIndex.get(id); if (r) return r; }
  for (const r of historyIndex.values()) {
    if (Array.isArray(r && r.pageIds) && want.some((id) => r.pageIds.includes(id))) return r;
  }
  return null;
}

/* Every model name this device has seen (vocabulary for title inference). */
export function knownModels(historyIndex, sessions) {
  const names = new Set();
  if (historyIndex && typeof historyIndex.values === 'function') {
    for (const r of historyIndex.values()) for (const o of (r && r.observations) || []) if (o && o.model) names.add(o.model);
  }
  if (sessions && typeof sessions.values === 'function') {
    for (const s of sessions.values()) for (const m of (s && s.models) || []) if (m && m.model) names.add(m.model);
  }
  return [...names];
}

const MODELISH = /^[a-z0-9][a-z0-9._:/-]{2,99}$/i;
/* Model name from a conversation title, or ''. */
export function inferModelFromTitle(title, { vocabulary = [], prefix = '' } = {}) {
  const t = String(title || '').trim();
  if (!t) return '';
  // 1. a model this device has already identified, anywhere in the title
  //    (longest match wins: "claude-opus-4-1" over "claude-opus-4")
  const nt = normalizeModel(t);
  let best = '';
  for (const m of vocabulary) {
    const nm = normalizeModel(m);
    if (nm.length >= 4 && nt.includes(nm) && nm.length > normalizeModel(best).length) best = m;
  }
  if (best) return best;
  // 2. the probe / auto-rename pattern "<prefix><model>[-NNN]"
  let rest = t;
  const p = sanitizePrefix(prefix);
  const hadPrefix = !!p && rest.startsWith(p);
  if (hadPrefix) rest = rest.slice(p.length);
  const numbered = /-\d{3}$/.test(rest);
  rest = rest.replace(/-\d{3}$/, '').replace(/…$/, '').trim();
  if ((hadPrefix || numbered) && MODELISH.test(rest) && /\d/.test(rest) && /[a-z]/i.test(rest)) return rest;
  return '';
}

/* Resolve the model(s) to show for a page conversation id.
 * → { sid, models:[{model,provider}], source, record, pageMatch } */
export function resolveModel({
  pageId = null,
  conversationFor = (id) => id,
  sessions = new Map(),
  historyIndex = new Map(),
  tracker = null,
  title = '',
  prefix = '',
} = {}) {
  const none = { sid: null, models: [], source: '', record: null, pageMatch: false };
  if (!pageId) return none;
  const sid = conversationFor(pageId) || pageId;
  const live = sessions.get(sid);
  if (live && Array.isArray(live.models) && live.models.length && !live.historical) {
    return { sid, models: live.models, source: 'live', record: null, pageMatch: false };
  }
  const record = findRecord(historyIndex, [sid, pageId]);
  if (record) {
    const pageMatch = record.sessionId !== sid && record.sessionId !== pageId;
    const fromObs = recordModels(record);
    if (fromObs.length) return { sid: record.sessionId, models: fromObs, source: 'history', record, pageMatch };
    const fromRuns = modelsFromRuns(record.runs);
    if (fromRuns.length) return { sid: record.sessionId, models: fromRuns, source: 'runs', record, pageMatch };
  }
  if (live) {
    if (live.models && live.models.length) return { sid, models: live.models, source: 'history', record: null, pageMatch: false };
    const fromRuns = modelsFromRuns(live.runs);
    if (fromRuns.length) return { sid, models: fromRuns, source: 'runs', record: null, pageMatch: false };
  }
  if (tracker && tracker.sessionId && (tracker.sessionId === sid || tracker.sessionId === pageId) && tracker.lastModel) {
    return { sid, models: [{ model: tracker.lastModel, provider: '' }], source: 'turns', record: null, pageMatch: false };
  }
  const guess = inferModelFromTitle(title || (record && record.title) || '', { vocabulary: knownModels(historyIndex, sessions), prefix });
  if (guess) return { sid: record ? record.sessionId : sid, models: [{ model: guess, provider: '' }], source: 'title', record, pageMatch: false };
  return { ...none, sid: record ? record.sessionId : sid, record };
}

export const SOURCE_TEXT = {
  live: '本次运行已识别',
  history: '本地记录 · 非重新验证',
  runs: '本地记录（运行标签）· 非重新验证',
  turns: '本轮追踪 · 最近识别',
  title: '标题推断 · 未验证',
};
