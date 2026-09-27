/* Conversation → model history (local only).
 * Port of arena-trace-inspector history.js (mergeRecord, schemaVersion 1:
 * observations + runs + totals) on top of the Rust JSON store, with the
 * Android HistoryLogic cap (newest 200 sessions kept) and a "carry" bucket so
 * the all-time Token/cost total survives eviction.
 *
 * Explicit allowlist: never persist the token, raw trace or message text. */

import { mergeUsage, summarizeUsage } from './usage.js';

export const HISTORY_PREFIX = 'history.';
export const CARRY_KEY = 'history-carry';
export const MAX_ENTRIES = 200;

export function conversationUrl(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('会话 ID 无效');
  return 'https://arena.ai/agent/' + sessionId;
}

export function mergeRecord(previous, input) {
  const url = conversationUrl(input.sessionId);
  if (!Array.isArray(input.models) || !input.models.length) throw new Error('没有已确认模型，不能保存');
  const time = input.checkedAt || new Date().toISOString();
  const old = previous?.sessionId === input.sessionId ? previous : null;
  const observations = [...(old?.observations || [])];
  for (const model of input.models) {
    if (typeof model.model !== 'string' || !model.model.trim()) continue;
    const entry = { model: model.model.slice(0, 200), provider: String(model.provider || '').slice(0, 100), runId: String(input.runId || '').slice(0, 128), spanId: String(model.spanId || '').slice(0, 128), partial: !!model.partial, turn: Number.isInteger(input.turn) && input.turn > 0 ? input.turn : (old?.observations || []).find((x) => x.runId === String(input.runId || ''))?.turn ?? null, firstSeen: time, lastSeen: time };
    const index = observations.findIndex((x) => x.runId === entry.runId && x.model === entry.model && x.provider === entry.provider);
    if (index < 0) observations.push(entry);
    else observations[index] = { ...entry, firstSeen: observations[index].firstSeen };
  }
  if (!observations.length) throw new Error('没有有效模型标签');
  const usage = input.usage ? { ...input.usage, ...(Number.isInteger(input.turn) && input.turn > 0 ? { turn: input.turn } : {}) } : null;
  const runs = mergeUsage(old?.runs, usage);
  const title = String(input.title || old?.title || 'Arena 会话').slice(0, 300);
  return { schemaVersion: 1, sessionId: input.sessionId, url, title, firstSeen: old?.firstSeen || time, lastSeen: time, observations, runs, totals: summarizeUsage(runs) };
}

export function isRecord(r) {
  try { return r?.schemaVersion === 1 && Array.isArray(r.observations) && r.url === conversationUrl(r.sessionId); } catch { return false; }
}

/* Unique models of a record, latest run first (for the restore-on-switch display). */
export function recordModels(record) {
  const obs = [...(record?.observations || [])].sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  const latestRun = obs[0]?.runId;
  const pick = latestRun ? obs.filter((o) => o.runId === latestRun) : obs;
  const out = [];
  for (const o of pick) if (!out.some((m) => m.model === o.model && m.provider === o.provider)) out.push({ model: o.model, provider: o.provider });
  return out;
}

/* Per-turn model line of a record ("R1 gpt-6 · R2 claude-opus-5"), newest last. */
export function recordTurns(record) {
  const byRun = new Map();
  for (const o of record?.observations || []) {
    if (!byRun.has(o.runId)) byRun.set(o.runId, { runId: o.runId, turn: o.turn ?? null, models: [], lastSeen: o.lastSeen || '' });
    const r = byRun.get(o.runId);
    if (!r.models.includes(o.model)) r.models.push(o.model);
    if ((o.lastSeen || '') > r.lastSeen) r.lastSeen = o.lastSeen;
    if (r.turn === null && Number.isInteger(o.turn)) r.turn = o.turn;
  }
  return [...byRun.values()].sort((a, b) => (a.turn ?? 1e9) - (b.turn ?? 1e9) || a.lastSeen.localeCompare(b.lastSeen));
}

export function searchRecords(records, query) {
  const qs = String(query || '').trim().toLowerCase();
  if (!qs) return records;
  return records.filter((r) => (r.title || '').toLowerCase().includes(qs) || r.sessionId.toLowerCase().includes(qs) || (r.observations || []).some((o) => (o.model || '').toLowerCase().includes(qs) || (o.provider || '').toLowerCase().includes(qs)));
}

const emptyCarry = () => ({ tokens: 0, costUsd: 0, spanCount: 0, runCount: 0, sessions: 0 });
export function addToCarry(carry, record) {
  const c = { ...emptyCarry(), ...(carry && typeof carry === 'object' ? carry : {}) };
  const t = record?.totals || summarizeUsage(record?.runs || []);
  c.tokens += t.tokens || 0;
  c.costUsd = Math.round((c.costUsd + (t.costUsd || 0)) * 1e9) / 1e9;
  c.spanCount += t.spanCount || 0;
  c.runCount += t.runCount || (record?.runs || []).length || 0;
  c.sessions += 1;
  return c;
}

/* All-time totals = live records + evicted carry. */
export function grandTotals(records, carry) {
  const live = summarizeUsage(records.flatMap((r) => r.runs || []));
  const c = { ...emptyCarry(), ...(carry && typeof carry === 'object' ? carry : {}) };
  const tokens = live.tokens === null && !c.tokens && !c.sessions ? null : (live.tokens || 0) + c.tokens;
  const costUsd = live.costUsd === null && !c.costUsd && !c.sessions ? null : Math.round(((live.costUsd || 0) + c.costUsd) * 1e9) / 1e9;
  return { ...live, tokens, costUsd, spanCount: live.spanCount + c.spanCount, runCount: live.runCount + c.runCount, sessions: records.length + c.sessions, tokenCoverage: live.tokenCoverage + c.spanCount, costCoverage: live.costCoverage + c.spanCount };
}

/* Models-only export (Android HistoryLogic parity) plus per-run usage totals. */
export function exportHistory(records, now = new Date()) {
  return {
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    scope: '仅会话→模型与 trace 用量标签；不含令牌、原始 trace 或消息内容',
    sessions: records.map((r) => ({
      sessionId: r.sessionId, url: r.url, title: r.title, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
      models: recordModels(r).map((m) => m.model),
      turns: recordTurns(r).map((t) => ({ turn: t.turn, runId: t.runId, models: t.models })),
      totals: r.totals || summarizeUsage(r.runs || []),
    })),
  };
}

/* Store-backed history with a serialised write queue (concurrent saves for the
 * same session must not lose observations). `store` = createStore() result. */
export function createHistoryStore(store, { max = MAX_ENTRIES } = {}) {
  let queue = Promise.resolve();
  const enqueue = (task) => { const work = queue.then(task); queue = work.catch(() => {}); return work; };
  const key = (sessionId) => HISTORY_PREFIX + sessionId;
  async function loadAll() {
    const keys = await store.keys(HISTORY_PREFIX);
    const out = [];
    for (const k of keys) { const r = await store.get(k); if (isRecord(r)) out.push(r); }
    return out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  }
  async function evict() {
    const all = await loadAll();
    if (all.length <= max) return 0;
    let carry = await store.get(CARRY_KEY);
    const gone = all.slice(max);
    for (const r of gone) { carry = addToCarry(carry, r); await store.set(key(r.sessionId), null); }
    await store.set(CARRY_KEY, carry);
    return gone.length;
  }
  return {
    save: (input) => enqueue(async () => {
      const old = await store.get(key(input.sessionId));
      const record = mergeRecord(isRecord(old) ? old : null, input);
      await store.set(key(record.sessionId), record);
      if (!isRecord(old)) await evict();
      return record;
    }),
    /* Title-only update after a rename; no-op when the conversation has no record. */
    retitle: (sessionId, title) => enqueue(async () => {
      const old = await store.get(key(sessionId));
      if (!isRecord(old) || old.sessionId !== sessionId) return null;
      const record = { ...old, title: String(title || old.title).slice(0, 300) };
      await store.set(key(sessionId), record);
      return record;
    }),
    get: (sessionId) => enqueue(async () => { conversationUrl(sessionId); const r = await store.get(key(sessionId)); return isRecord(r) && r.sessionId === sessionId ? r : null; }),
    list: () => enqueue(loadAll),
    remove: (sessionId) => enqueue(async () => { conversationUrl(sessionId); await store.set(key(sessionId), null); }),
    clear: () => enqueue(async () => { for (const k of await store.keys(HISTORY_PREFIX)) await store.set(k, null); await store.set(CARRY_KEY, null); }),
    carry: () => enqueue(() => store.get(CARRY_KEY)),
  };
}
