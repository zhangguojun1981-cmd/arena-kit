#!/usr/bin/env node
/* Offline fingerprint calibration/evaluation report (PR5).
 *
 *   node scripts/fingerprint-calibrate.mjs                 # text report, both banks
 *   node scripts/fingerprint-calibrate.mjs --json          # machine-readable JSON
 *   node scripts/fingerprint-calibrate.mjs --json --out report.json
 *   node scripts/fingerprint-calibrate.mjs --sweep         # threshold sweep table
 *   node scripts/fingerprint-calibrate.mjs --protocol fpverify-battery-v1
 *   node scripts/fingerprint-calibrate.mjs --holdout       # leave-one-model-out
 *   node scripts/fingerprint-calibrate.mjs --seed 42 --sessions 80 --budget 8 --integers 600
 *
 * Runs the bundled reference banks through classify() with SEEDED synthetic
 * answers (no model calls, fully deterministic) and prints the metric set the
 * modification plan mandates (阶段5): a 三系列 confusion matrix, Opus↔Fable
 * mutual misclassification, GPT‑6 version drift, accept-accuracy, conclusion
 * coverage, unknown rejection on non-targets, and probe-count-to-decision
 * stats, with the bank's sampling date + version.
 *
 * HONESTY: these are parametric-bootstrap self-consistency numbers (synthetic
 * answers drawn from the SAME aggregated bank classify() scores against), i.e.
 * an optimistic UPPER BOUND of the bank's internal separability — NOT current
 * Arena accuracy. softmax confidence is NOT a calibrated correctness
 * probability. Do not relabel these as real accuracy anywhere. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, DEFAULT_THRESHOLDS } from '../src/lib/fingerprint.js';
import { evaluate, sweepThresholds } from '../src/lib/fingerprint-calibration.js';
import { FINGERPRINT_REFERENCES } from '../src/lib/fingerprint-banks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const has = (flag) => process.argv.includes(flag);

const asJson = has('--json');
const doSweep = has('--sweep');
const holdOutModel = has('--holdout');
const onlyProtocol = argVal('--protocol', null);
const outFile = argVal('--out', null);
const seed = Number(argVal('--seed', 1)) || 1;
const sessionsPerModel = Number(argVal('--sessions', 80)) || 80;
const budget = Number(argVal('--budget', 8)) || 8;
const integersPerReply = Number(argVal('--integers', 600)) || 600;

const protocolIds = onlyProtocol
  ? [onlyProtocol]
  : Object.keys(FINGERPRINT_REFERENCES);

function pct(x) { return x == null ? '  —  ' : (x * 100).toFixed(1).padStart(5) + '%'; }
function num(x) { return x == null ? '—' : (Number.isInteger(x) ? String(x) : x.toFixed(2)); }

function printConfusion(confusion) {
  const cols = ['opus', 'fable', 'gpt6', 'unknown'];
  const trueRows = Object.keys(confusion);
  const w = Math.max(10, ...trueRows.map((r) => r.length + 2));
  console.log('  混淆矩阵（行=真实家族，列=判定）：');
  console.log('    ' + '真实\\判定'.padEnd(w) + cols.map((c) => c.padStart(9)).join(''));
  for (const r of trueRows) {
    const row = confusion[r];
    const total = cols.reduce((a, c) => a + (row[c] || 0), 0);
    const cells = cols.map((c) => String(row[c] || 0).padStart(9)).join('');
    console.log('    ' + (r + ` (${total})`).padEnd(w) + cells);
  }
}

function textReport(reference, label) {
  const r = evaluate({ reference, classify, seed, sessionsPerModel, budget, integersPerReply, holdOutModel });
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`协议：${label}`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  参考库版本：${r.bank.referenceVersion}  类型：${r.bank.kind}`);
  console.log(`  采样来源：${r.bank.project || '—'}（${r.bank.license || '—'}）  渠道：${r.bank.channel || '—'}`);
  console.log(`  bank 采样日期：${r.bank.sampledAt || '未记录'}`);
  console.log(`  入库模型数：${r.bank.modelCount}  家族：${r.bank.families.join(', ')}`);
  if (r.bank.partialModels.length) console.log(`  稀疏/部分模型：${r.bank.partialModels.join(', ')}`);
  console.log(`  评估设计：${r.design}`);
  console.log(`  seed=${r.seed}  每模型会话=${r.sessionsPerModel}  预算=${r.budget}  整数/条=${r.integersPerReply}  总会话=${r.totalSessions}`);
  console.log(`  阈值：minMargin=${r.thresholds.minMargin} minConfidence=${r.thresholds.minConfidence} calibrated=${r.thresholds.calibrated}`);
  console.log('');
  printConfusion(r.confusion);
  console.log('');
  console.log(`  可给结论覆盖率（任意目标家族归因）：${pct(r.coverage)}`);
  console.log(`  接受预测时正确率（attributed 中家族正确）：${pct(r.acceptAccuracy)}`);
  console.log(`  unknown 拒识率（非目标家族被正确拒识）：${pct(r.unknownRejection)}`);
  if (r.mutualMisclass.note) {
    console.log(`  Opus↔Fable 互相误判：${r.mutualMisclass.note}`);
  } else {
    console.log(`  Opus→Fable 误判率：${pct(r.mutualMisclass.opusAsFableRate)}   Fable→Opus 误判率：${pct(r.mutualMisclass.fableAsOpusRate)}`);
  }
  if (r.versionDrift.wrongVersionRate !== undefined && r.versionDrift.gpt6CorrectFamily !== undefined) {
    console.log(`  GPT‑6 版本漂移（家族对、版本错）：${pct(r.versionDrift.wrongVersionRate)}  （基数 ${r.versionDrift.gpt6CorrectFamily}）`);
  } else {
    console.log(`  GPT‑6 版本漂移：${r.versionDrift.note}`);
  }
  const ps = r.probeCountStats;
  console.log(`  探针数到首次正确判定：均值 ${num(ps.mean)} · P95 ${num(ps.p95)} · 最大 ${num(ps.max)}  （已判定 ${ps.decided} / 无结论 ${ps.noDecision}）`);
  console.log('');
  console.log('  诚实边界：');
  for (const h of r.honesty) console.log('   - ' + h);
  return r;
}

function sweepReport(reference, label) {
  const rows = sweepThresholds({ reference, classify, seed, sessionsPerModel: Math.min(sessionsPerModel, 40), budget });
  console.log('');
  console.log(`阈值扫描 — ${label}（coverage ↔ accept-accuracy 权衡，供人工对真实盲测集后选阈值）：`);
  console.log('  minMargin  minConf   coverage  acceptAcc  unknownRej');
  for (const r of rows) {
    console.log(
      '  ' + String(r.minMargin).padStart(8)
      + String(r.minConfidence).padStart(9)
      + pct(r.coverage).padStart(11)
      + pct(r.acceptAccuracy).padStart(11)
      + pct(r.unknownRejection).padStart(12),
    );
  }
  return rows;
}

const out = { generatedAt: new Date().toISOString(), seed, sessionsPerModel, budget, integersPerReply, holdOutModel, protocols: {} };

for (const pid of protocolIds) {
  const reference = FINGERPRINT_REFERENCES[pid];
  if (!reference) { console.error(`unknown protocol: ${pid}`); process.exit(1); }
  if (asJson) {
    out.protocols[pid] = {
      report: evaluate({ reference, classify, seed, sessionsPerModel, budget, integersPerReply, holdOutModel }),
      ...(doSweep ? { sweep: sweepThresholds({ reference, classify, seed, sessionsPerModel: Math.min(sessionsPerModel, 40), budget }) } : {}),
    };
  } else {
    textReport(reference, pid);
    if (doSweep) sweepReport(reference, pid);
  }
}

if (asJson) {
  const json = JSON.stringify(out, null, 2);
  if (outFile) {
    const abs = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
    fs.writeFileSync(abs, json + '\n');
    console.error('wrote ' + path.relative(ROOT, abs));
  } else {
    console.log(json);
  }
} else {
  console.log('');
  console.log('提示：这些是参数化自举的内部可分性上界，不是当前 Arena 真实准确率；');
  console.log('      softmax 置信度不是标定后的正确概率。真正的校准需要同渠道、同协议、');
  console.log('      同推理档位的真实盲测集。此脚本仅用于暴露 coverage/precision 权衡与回归检测。');
}
