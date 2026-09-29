/* Per-run usage view — port of arena-trace-inspector view-model.js `build()`
 * (popup "查看运行" picker, metric cards with coverage notes, 完成状态,
 * 证据来源 fold). Pure functions over the same shapes usage.js / history.js
 * produce; the dock only renders the result.
 *
 *   runsFor(record | {runs, observations})  every run of a conversation, newest first
 *   buildRunView(...)                        one run as display strings + calls
 *   runLabel(run)                            "<runId> · <time> · 第 N 轮" for a <select> */
import { completion, formatTokens, formatMoney } from './usage.js';

const number = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const stampOf = (run, observations) => run.checkedAt
  || observations.filter((o) => o.runId === run.runId).map((o) => o.lastSeen || '').sort().at(-1)
  || '';

/* Runs of a conversation: stored usage runs plus observation-only runs (older
 * records without usage), newest first. */
export function runsFor(source) {
  const runs = [...(source?.runs || [])].filter((r) => r && typeof r.runId === 'string').map((r) => ({ ...r, spans: [...(r.spans || [])] }));
  const observations = Array.isArray(source?.observations) ? source.observations : [];
  for (const o of observations) {
    if (typeof o?.runId !== 'string' || !o.runId) continue;
    if (!runs.some((r) => r.runId === o.runId)) runs.push({ runId: o.runId, spans: [], checkedAt: o.lastSeen || undefined, turn: o.turn ?? null });
  }
  return runs.sort((a, b) => stampOf(b, observations).localeCompare(stampOf(a, observations)));
}

/* Build the view of one run.
 *   runs / observations  the conversation's data (see runsFor)
 *   runId                which run; '' → newest
 *   live                 true when this is the run currently being captured
 *                        (anything else is shown as a local record, never as re-verification) */
export function buildRunView({ runs = [], observations = [], runId = '', live = false } = {}) {
  const list = runsFor({ runs, observations });
  const run = (runId ? list.find((r) => r.runId === runId) : list[0]) || null;
  const obs = run ? observations.filter((o) => o.runId === run.runId) : [];
  const calls = [...new Map((run?.spans || []).map((s) => [s.spanId, s])).values()]
    .map((s) => ({ ...s, provider: s.provider || obs.find((o) => o.spanId === s.spanId)?.provider || '' }));
  const models = calls.length
    ? calls.filter((c) => c.model).map((c) => ({ model: c.model, provider: c.provider }))
    : obs.map((o) => ({ model: o.model, provider: o.provider || '' }));
  const uniqueModels = models.filter((m, i, a) => a.findIndex((n) => n.model === m.model && n.provider === m.provider) === i);
  const tokenCalls = calls.filter((c) => number(c.tokens));
  const costCalls = calls.filter((c) => number(c.costUsd));
  const tokenSum = tokenCalls.length ? tokenCalls.reduce((n, c) => n + c.tokens, 0) : null;
  const costSum = costCalls.length ? Math.round(costCalls.reduce((n, c) => n + c.costUsd, 0) * 1e9) / 1e9 : null;
  const historical = !live;
  return {
    runId: run?.runId || '',
    turn: run?.turn ?? obs.find((o) => Number.isInteger(o.turn))?.turn ?? null,
    checkedAt: run ? stampOf(run, observations) : '',
    historical,
    models: uniqueModels,
    calls,
    completion: completion(calls),
    tokens: formatTokens(tokenSum, tokenCalls.some((c) => c.tokensApproximate)),
    cost: formatMoney(costSum),
    tokenCoverage: `${tokenCalls.length}/${calls.length}`,
    costCoverage: `${costCalls.length}/${calls.length}`,
    tokenMissing: tokenCalls.length < calls.length,
    costMissing: costCalls.length < calls.length,
    count: calls.length ? String(calls.length) : run?.runId ? '未提供' : '—',
    evidenceCount: calls.filter((c) => c.evidence?.schemaVersion === 1).length,
    source: run?.runId ? (historical ? '本地记录 · 非重新验证' : '本次捕获') : '等待捕获',
  };
}

/* Notes under the metric cards — same wording as the extension popup. */
export function metricNotes(view) {
  return {
    tokens: view.tokenMissing ? `部分缺失 · 覆盖 ${view.tokenCoverage} 次调用` : '缩写标为约数；不推算输入／输出',
    cost: view.costMissing ? `部分缺失 · 覆盖 ${view.costCoverage} 次调用` : 'trace 展示值，非实际账单',
    count: view.calls.length ? '按 runId + spanId 去重' : '尚无调用明细',
    completion: '仅指已捕获的模型调用',
  };
}

const fmtTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '未记录时间'; };

/* <option> label for a run. */
export function runLabel(run, observations = []) {
  const turn = run.turn ?? observations.find((o) => o.runId === run.runId && Number.isInteger(o.turn))?.turn;
  const when = stampOf(run, observations);
  return [String(run.runId).slice(0, 14), when ? fmtTime(when) : '', Number.isInteger(turn) ? `第 ${turn} 轮` : ''].filter(Boolean).join(' · ');
}

/* Evidence rows for the 证据来源 fold: one entry per call that kept its raw labels. */
export const EVIDENCE_LABELS = [['model', '模型原始标签'], ['provider', '供应商原始标识'], ['tokens', 'Token 原始标签'], ['cost', '费用原始标签']];
export function evidenceRows(view) {
  return view.calls.map((c, i) => {
    if (c.evidence?.schemaVersion !== 1) return { index: i + 1, model: c.model || '模型未提供', spanId: c.spanId, legacy: true, fields: [], flags: null };
    const fields = EVIDENCE_LABELS.map(([key, label]) => {
      const v = c.evidence[key];
      return { key, label, value: v?.value || '未提供', path: v?.path || '', observedAt: v?.observedAt ? fmtTime(v.observedAt) : '' };
    });
    const f = c.evidence.flags;
    const flags = f ? `isPartial=${String(f.isPartial)} · isError=${String(f.isError)} · isCancelled=${String(f.isCancelled)}` : null;
    return { index: i + 1, model: c.model || '模型未提供', spanId: c.spanId, legacy: false, fields, flags };
  });
}
