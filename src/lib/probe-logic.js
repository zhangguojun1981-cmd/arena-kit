/* Pure probe logic — port of arena-trace-android probe/ProbeLogic.kt (itself
 * the extension's auto-draw.js). Target parsing / matching, arithmetic-title
 * detection, cleanup candidate selection and the per-model suffix counter.
 * No DOM, no timers, no IPC, so it is unit-tested directly. */
import { normalizeModel, nextSuffix } from './rename.js';

export const DEFAULT_TARGETS = ['opus5', 'fable5', 'gpt6'];
export const MAX_TARGETS = 20;

/* 50 short, cheap, unambiguous arithmetic probe prompts ("1+1=" … "50+50=").
 * Deterministic reference set; live probing uses randomPrompt(). */
export const PROMPTS = Array.from({ length: 50 }, (_, i) => `${i + 1}+${i + 1}=`);

const PROMPT_OPERATORS = ['+', '-', '*', '/', '×', '÷'];

/* A fresh random arithmetic prompt ("473×82=", "57+906="). Every round sends a
 * DIFFERENT expression so probe-created chats don't all share one title; the
 * shape stays `N op N =`, which both the page send-guard (isOwnPrompt in
 * probe.js) and the cleanup sweep (isArithmeticTitle) accept. */
export function randomPrompt(rng = Math.random) {
  const int = (min, max) => min + Math.floor(rng() * (max - min)); // [min, max)
  const a = int(1, 1000), b = int(1, 1000);
  const op = PROMPT_OPERATORS[int(0, PROMPT_OPERATORS.length)];
  return `${a}${op}${b}=`;
}

const FAMILIES = {
  opus5: String.raw`(?:claude[-_\s.]*)?opus[-_\s.]*5(?:[-_.]\d+)?(?!\d)`,
  fable5: String.raw`(?:claude[-_\s.]*)?fable[-_\s.]*5(?:[-_.]\d+)?(?!\d)`,
  gpt6: String.raw`(?:chat)?gpt[-_\s.]*6(?:[-_\s.]*astra|[-_\s.]*pro)?(?!\d)`,
};

const ALIASES = {
  opus5: 'opus5', claudeopus5: 'opus5',
  fable5: 'fable5', claudefable5: 'fable5', fable51: 'fable5', claudefable51: 'fable5',
  gpt6: 'gpt6', chatgpt6: 'gpt6', gpt6astra: 'gpt6', gpt6pro: 'gpt6', astra: 'gpt6',
};

/* lower-case + strip everything non-alphanumeric. */
export const normalize = normalizeModel;

/* Split a user target string into 2..80-char tokens, deduped, max 20. */
export function parseTargets(text) {
  const parts = String(text ?? '').split(/[,，;；\n]+/)
    .map((t) => t.trim().replace(/[.\s]+$/, ''))
    .filter((t) => t.length >= 2 && t.length <= 80);
  return [...new Set(parts)].slice(0, MAX_TARGETS);
}

/* Compile one target into a case-insensitive RegExp:
 *  - /body/flags  → literal user regex (i is forced on; body ≤120)
 *  - known alias  → the model family pattern
 *  - otherwise    → the literal escaped, with separators made fuzzy ([-_\s.]*)
 * Returns null when the target can't produce a usable pattern. */
export function compileTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) return null;
  if (raw.length >= 3 && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/');
    const body = raw.slice(1, last);
    const flags = raw.slice(last + 1).replace(/[^gimsuy]/g, '');
    if (!body || body.length > 120) return null;
    const f = [...new Set(('i' + flags).split(''))].filter((c) => 'imsu'.includes(c)).join('');
    try { return new RegExp(body, f); } catch { return null; }
  }
  const fam = ALIASES[normalize(raw)];
  if (fam) return new RegExp(FAMILIES[fam], 'i');
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(?:\\\.|[-_\s])+/g, String.raw`[-_\s.]*`);
  try { return new RegExp(escaped, 'i'); } catch { return null; }
}

/* For each target, the first model it matches (raw or normalized): [{target, model}]. */
export function matchTargets(models, targets) {
  const hits = [];
  for (const target of targets || []) {
    const regex = compileTarget(target);
    if (!regex) continue;
    const model = (models || []).find((name) => regex.test(String(name)) || regex.test(normalize(name)));
    if (model !== undefined) hits.push({ target, model });
  }
  return hits;
}

/* Targets not yet hit (by normalized name). */
export function remainingTargets(targets, hits) {
  const found = new Set((hits || []).map((h) => normalize(h.target)));
  return (targets || []).filter((t) => !found.has(normalize(t)));
}

/* findAll stop condition: every target hit at least once across all rounds.
 * Hit targets are never removed from the matching pool. */
export function allTargetsHit(targets, hits) {
  return (targets || []).length > 0 && remainingTargets(targets, hits).length === 0;
}

const ARITH = /^\s*\d{1,4}\s*[+\-*/×÷]\s*\d{1,4}\s*=\s*$/;

/* A pure-arithmetic conversation title ("1+1=", "12 - 4 ="). Only our own probe
 * sends produce these. Hardened against zero-width characters and fullwidth /
 * unicode operators; an ANSWERED title ("1+1=2") is never matched. */
export function isArithmeticTitle(t) {
  const s = String(t ?? '').replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/＋/g, '+').replace(/[－−]/g, '-').replace(/＊/g, '*').replace(/／/g, '/').replace(/＝/g, '=');
  return ARITH.test(s);
}

/* Any prompt shape the probe may send (in sync with isOwnPrompt in probe.js). */
export const isOwnPrompt = (t) => ARITH.test(String(t ?? ''));

/* Sidebar entries whose title is bare arithmetic, deduped by session,
 * optionally keeping the currently open chat. */
export function arithmeticCleanupCandidates(sidebar, keepSessionId = null) {
  const seen = new Set();
  const out = [];
  for (const c of sidebar || []) {
    const id = String(c?.sessionId || '');
    if (!id || seen.has(id)) continue;
    if (keepSessionId && id === keepSessionId) continue;
    if (!isArithmeticTitle(c.title)) continue;
    seen.add(id);
    out.push({ sessionId: id, title: String(c.title).slice(0, 300) });
  }
  return out;
}

export { nextSuffix };
