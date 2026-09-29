/* Token / trace-cost bookkeeping for the dock.
 * Port of arena-trace-inspector usage.js (mergeUsage / summarizeUsage /
 * formatUsage), evidence.js (label allowlist) and the usage parts of
 * view-model.js (completion / exportEvidence).
 *
 * Extraction from the raw trace happens in Rust (src-tauri/src/usage.rs); this
 * module only merges snapshots, sums them and formats. Pure functions, no DOM.
 * Only observed trace labels are ever kept — never the token, raw trace or
 * message text. */

const number = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const time = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
const isoOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return time(v);
};

// ── evidence (evidence.js) ─────────────────────────────────────────────
const FIELDS = {
  model: ['style.accessory.items[icon=tabler-cube].text', 200],
  provider: ['style.icon', 100],
  tokens: ['style.accessory.items[icon=tabler-hash].text', 40],
  cost: ['style.accessory.items[icon=tabler-currency-dollar].text', 40],
};
export function sanitizeEvidence(input) {
  if (input?.schemaVersion !== 1) return null;
  const out = { schemaVersion: 1, source: 'Trigger.dev run events', spanName: 'ai.streamText.doStream' };
  for (const [name, [path, max]] of Object.entries(FIELDS)) {
    const entry = input[name];
    if (!entry || typeof entry.value !== 'string' || !entry.value.trim() || entry.value.length > max) continue;
    if (name === 'provider' && !/^ai-provider-[\w.-]+$/.test(entry.value)) continue;
    if (name === 'tokens' && !/^\d[\d,.]*\s*[kmb]?$/i.test(entry.value.trim())) continue;
    if (name === 'cost' && !/^\$\s*\d+(?:\.\d+)?$/.test(entry.value.trim())) continue;
    out[name] = { path, value: entry.value, observedAt: time(entry.observedAt) };
  }
  if (input.flags && typeof input.flags === 'object') {
    out.flags = { observedAt: time(input.flags.observedAt) };
    for (const name of ['isPartial', 'isError', 'isCancelled']) out.flags[name] = typeof input.flags[name] === 'boolean' ? input.flags[name] : null;
  }
  return out;
}
export function mergeEvidence(oldValue, incoming) {
  const old = sanitizeEvidence(oldValue), next = sanitizeEvidence(incoming);
  if (!next) return old;
  // Keep each label's own observation time when a later snapshot omits a field.
  return sanitizeEvidence({ ...old, ...next });
}

/* Convert one Rust snapshot ({runId, checkedAt(ms|iso), spans:[SpanUsage]}) into
 * the inspector's usage shape, attaching the evidence envelope built from the
 * raw observed labels. */
export function usageFromReport(report) {
  if (!report || typeof report.runId !== 'string') return null;
  const checkedAt = isoOf(report.checkedAt) || new Date().toISOString();
  const spans = [];
  for (const s of Array.isArray(report.spans) ? report.spans : []) {
    if (!s || typeof s.spanId !== 'string') continue;
    const flags = { isPartial: s.partial, isError: s.error, isCancelled: s.cancelled, observedAt: checkedAt };
    const evidence = sanitizeEvidence({
      schemaVersion: 1,
      flags,
      ...(s.model ? { model: { value: String(s.model), observedAt: checkedAt } } : {}),
      ...(s.providerIcon ? { provider: { value: String(s.providerIcon), observedAt: checkedAt } } : {}),
      ...(s.tokenLabel ? { tokens: { value: String(s.tokenLabel), observedAt: checkedAt } } : {}),
      ...(s.costLabel ? { cost: { value: String(s.costLabel), observedAt: checkedAt } } : {}),
    });
    spans.push({
      spanId: s.spanId,
      model: String(s.model || '').slice(0, 200),
      provider: String(s.provider || '').slice(0, 100),
      tokens: number(s.tokens) ? s.tokens : null,
      tokensApproximate: number(s.tokens) ? !!s.tokensApproximate : false,
      costUsd: number(s.costUsd) ? s.costUsd : null,
      partial: typeof s.partial === 'boolean' ? s.partial : null,
      error: typeof s.error === 'boolean' ? s.error : null,
      cancelled: typeof s.cancelled === 'boolean' ? s.cancelled : null,
      evidence,
    });
  }
  return { runId: report.runId, checkedAt, spans };
}

// ── merge / summarize / format (usage.js) ──────────────────────────────
export function mergeUsage(oldRuns = [], incoming) {
  if (!incoming?.runId || !Array.isArray(incoming.spans)) return oldRuns;
  const runs = oldRuns.map((r) => ({ runId: r.runId, ...(r.checkedAt ? { checkedAt: r.checkedAt } : {}), ...(r.turn ? { turn: r.turn } : {}), spans: [...(r.spans || [])] }));
  let run = runs.find((r) => r.runId === incoming.runId);
  if (!run) { run = { runId: incoming.runId, spans: [] }; runs.push(run); }
  if (typeof incoming.checkedAt === 'string' && incoming.checkedAt.length <= 40 && Number.isFinite(Date.parse(incoming.checkedAt))) run.checkedAt = incoming.checkedAt;
  if (Number.isInteger(incoming.turn) && incoming.turn > 0) run.turn = incoming.turn;
  for (const span of incoming.spans) {
    if (typeof span.spanId !== 'string') continue;
    const index = run.spans.findIndex((s) => s.spanId === span.spanId);
    const old = run.spans[index];
    const flag = (key) => typeof span[key] === 'boolean' ? span[key] : old?.[key] ?? null;
    const entry = {
      spanId: span.spanId,
      model: String(span.model || old?.model || '').slice(0, 200),
      provider: String(span.provider || old?.provider || '').slice(0, 100),
      tokens: number(span.tokens) ? span.tokens : old?.tokens ?? null,
      tokensApproximate: number(span.tokens) ? !!span.tokensApproximate : old?.tokensApproximate ?? false,
      costUsd: number(span.costUsd) ? span.costUsd : old?.costUsd ?? null,
      partial: old?.partial === false ? false : flag('partial'),
      error: old?.error === true ? true : flag('error'),
      cancelled: old?.cancelled === true ? true : flag('cancelled'),
      evidence: mergeEvidence(old?.evidence, span.evidence),
    };
    if (index < 0) run.spans.push(entry); else run.spans[index] = entry;
  }
  return runs;
}

export function summarizeUsage(runs = []) {
  const unique = new Map();
  for (const r of runs) for (const s of r?.spans || []) unique.set(r.runId + ':' + s.spanId, s);
  const spans = [...unique.values()];
  const tokenSpans = spans.filter((s) => typeof s.tokens === 'number');
  const costSpans = spans.filter((s) => typeof s.costUsd === 'number');
  return {
    spanCount: spans.length,
    runCount: runs.filter((r) => r && r.runId).length,
    tokens: tokenSpans.length ? tokenSpans.reduce((n, s) => n + s.tokens, 0) : null,
    costUsd: costSpans.length ? Math.round(costSpans.reduce((n, s) => n + s.costUsd, 0) * 1e9) / 1e9 : null,
    tokensApproximate: tokenSpans.some((s) => s.tokensApproximate),
    tokenCoverage: tokenSpans.length,
    costCoverage: costSpans.length,
    partial: spans.some((s) => s.partial),
  };
}

export const formatTokens = (n, approximate) => number(n) ? (approximate ? '≈' : '') + n.toLocaleString('zh-CN') : '未提供';
export const formatMoney = (n) => number(n) ? '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '未提供';

export function formatUsage(t) {
  if (!t || !t.spanCount) return 'Token / 费用：未提供';
  const tokens = t.tokens === null ? '未提供' : (t.tokensApproximate ? '≈' : '') + t.tokens.toLocaleString('zh-CN');
  const cost = t.costUsd === null ? '未提供' : '≈$' + t.costUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const missing = t.tokenCoverage < t.spanCount || t.costCoverage < t.spanCount;
  return `Token ${tokens} · trace 费用 ${cost}` + (missing ? '（部分缺失）' : '') + (t.partial ? '（进行中）' : '');
}

/* Completion state of one run's model calls (view-model.js). */
export function completion(calls) {
  if (!calls || !calls.length) return '等待数据';
  if (calls.some((c) => c.error === true)) return '调用报错';
  if (calls.some((c) => c.cancelled === true)) return '调用已取消';
  if (calls.some((c) => c.partial === true)) return '调用进行中';
  return calls.every((c) => c.partial === false) ? '调用已完成' : '状态未提供';
}

function cleanEvidence(e) {
  if (e?.schemaVersion !== 1) return null;
  const out = { schemaVersion: 1, source: 'Trigger.dev run events', spanName: 'ai.streamText.doStream' };
  for (const k of ['model', 'provider', 'tokens', 'cost']) if (e[k]) out[k] = { path: String(e[k].path || '').slice(0, 200), value: String(e[k].value || '').slice(0, 200), observedAt: e[k].observedAt || null };
  if (e.flags) out.flags = { isPartial: e.flags.isPartial ?? null, isError: e.flags.isError ?? null, isCancelled: e.flags.isCancelled ?? null, observedAt: e.flags.observedAt || null };
  return out;
}

/* Evidence export: only captured model-call labels, never the raw trace. */
export function exportEvidence({ sessionId = '', title = '', runs = [] } = {}, now = new Date()) {
  const list = runs.filter((r) => r && r.runId);
  return {
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    sessionId,
    title,
    scope: '仅已捕获的 ai.streamText.doStream 调用；非原始 trace 全文',
    totals: summarizeUsage(list),
    runs: list.map((r) => ({
      runId: r.runId,
      turn: r.turn ?? null,
      checkedAt: r.checkedAt || null,
      completion: completion(r.spans || []),
      calls: (r.spans || []).map((c) => ({
        spanId: c.spanId, model: c.model, provider: c.provider,
        tokens: c.tokens ?? null, tokensApproximate: !!c.tokensApproximate, costUsd: c.costUsd ?? null,
        partial: c.partial ?? null, error: c.error ?? null, cancelled: c.cancelled ?? null,
        evidence: cleanEvidence(c.evidence),
        provenance: c.evidence?.schemaVersion === 1 ? 'observed-trace-labels' : 'legacy-local-record-no-raw-labels',
      })),
    })),
  };
}
