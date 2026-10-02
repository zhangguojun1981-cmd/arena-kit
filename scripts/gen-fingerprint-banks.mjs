#!/usr/bin/env node
/* Regenerate src/lib/fingerprint-banks.js from data/fingerprint/*.
 *
 * The dock must load fingerprint reference banks from an in-repo import (never
 * over the network) so the estimate works fully offline and no remote host can
 * swap a reference distribution. This script freezes the JSON under
 * data/fingerprint into a named-export ES module the dock bundler can inline.
 *
 *   node scripts/gen-fingerprint-banks.mjs            # rewrite the module
 *   node scripts/gen-fingerprint-banks.mjs --check    # fail if it is stale
 *
 * Keep the data files (data/fingerprint/*) as the single source of truth; this
 * module is a derived, committed artifact (mirrors scripts/bundle-dock.mjs). */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/lib/fingerprint-banks.js');
const CHECK = process.argv.includes('--check');

const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const manifest = read('data/fingerprint/manifest.json');
const protoMT = read('data/fingerprint/protocols/modeltrace-long-integers-v1.json');
const protoFP = read('data/fingerprint/protocols/fpverify-battery-v1.json');
const refMT = read('data/fingerprint/references/modeltrace-summary-v1.json');
const refFP = read('data/fingerprint/references/fpverify-summary-v1.json');

// Sanity: the protocol / reference ids must line up before we freeze them.
const problems = [];
if (protoMT.id !== 'modeltrace-long-integers-v1') problems.push('modeltrace protocol id mismatch');
if (protoFP.id !== 'fpverify-battery-v1') problems.push('fpverify protocol id mismatch');
if (refMT.protocolId !== protoMT.id) problems.push('modeltrace reference protocolId mismatch');
if (refFP.protocolId !== protoFP.id) problems.push('fpverify reference protocolId mismatch');
const manifestIds = new Set((manifest.protocols || []).map((p) => p.id));
if (!manifestIds.has(protoMT.id) || !manifestIds.has(protoFP.id)) problems.push('manifest protocols out of sync');
if (problems.length) { console.error('gen-fingerprint-banks: ' + problems.join('; ')); process.exit(1); }

// Compact JSON keeps the generated bundle small (the big payload is the
// modeltrace 355-bin count vectors). JSON.stringify preserves source key order.
const j = (o) => JSON.stringify(o);

const header = `/* GENERATED — do not edit by hand.
 *
 * Bundled offline fingerprint reference banks + protocol/manifest metadata,
 * frozen copies of data/fingerprint/*. The dock loads references from HERE
 * (an in-repo import), never over the network: the fingerprint estimate must
 * work fully offline and no remote host may swap a reference distribution.
 *
 * Regenerate with:  node scripts/gen-fingerprint-banks.mjs
 * (that script re-reads data/fingerprint/* and rewrites this file verbatim).
 *
 * These are STARTING PRIORS from author-reported third-party channels, NOT
 * calibrated current-Arena accuracy. Two protocols are kept strictly separate:
 * their candidate probabilities must never be merged. */
`;

const body = `
export const FINGERPRINT_MANIFEST = ${j(manifest)};

export const FINGERPRINT_PROTOCOLS = {
  ${j(protoMT.id)}: ${j(protoMT)},
  ${j(protoFP.id)}: ${j(protoFP)},
};

export const FINGERPRINT_REFERENCES = {
  ${j(refMT.protocolId)}: ${j(refMT)},
  ${j(refFP.protocolId)}: ${j(refFP)},
};

/* loadReference(protocolId) → the frozen reference bank for that protocol, or
 * null if unknown. Pure, synchronous; the runner wraps it in a Promise. */
export function fingerprintReference(protocolId) {
  return FINGERPRINT_REFERENCES[protocolId] || null;
}

/* The protocol metadata (kind / questions / channel) the runner surfaces as
 * advisory compatibility info. Never carries probe PROMPT text — those live in
 * the page-side allowlist (injected/probe.js FINGERPRINT_PROMPTS). */
export function fingerprintProtocolMeta(protocolId) {
  return FINGERPRINT_PROTOCOLS[protocolId] || null;
}
`;

const next = header + body + '\n';

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== next) {
    console.error('src/lib/fingerprint-banks.js is stale — run: node scripts/gen-fingerprint-banks.mjs');
    process.exit(1);
  }
  console.log('fingerprint-banks.js up to date');
} else {
  fs.writeFileSync(OUT, next);
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
}
