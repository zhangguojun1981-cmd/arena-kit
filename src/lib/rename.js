/* Conversation title rules shared by auto-rename, manual rename, the probe
 * ("<prefix><model>-NNN") and the session probe. Pure functions.
 *
 * The optional global prefix is an ArenaKit addition on top of the extension /
 * Android behaviour (which always used the bare model name). Arena caps titles
 * at 100 characters (conversation-rename.js validate), so a long prefix
 * shortens the model part rather than failing the rename. */

export const MAX_TITLE = 100;
export const MAX_PREFIX = 40;

const CONTROL = /[\u0000-\u001f\u007f]/g;

export function sanitizePrefix(prefix) {
  return String(prefix ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trimStart().slice(0, MAX_PREFIX);
}

/* "<prefix><model>[-<suffix>]" within Arena's 100-char limit. */
export function buildTitle({ prefix = '', model, suffix = '' } = {}) {
  const m = String(model ?? '').replace(CONTROL, '').trim();
  if (!m) throw new Error('尚未识别模型，不能重命名');
  const p = sanitizePrefix(prefix);
  const s = String(suffix ?? '').replace(CONTROL, '').trim();
  const tail = s ? '-' + s : '';
  let title = p + m + tail;
  if (title.length > MAX_TITLE) {
    const room = MAX_TITLE - p.length - tail.length;
    if (room < 8) throw new Error('前缀过长，标题超过 Arena 的 100 字符上限');
    title = p + m.slice(0, room - 1).trimEnd() + '…' + tail;
  }
  return title.trim();
}

/* 3-digit suffix counter (ProbeLogic.nextSuffixFor). Every distinct
 * "<prefix><model>" name counts independently (001, 002, …); without a prefix
 * the key is the legacy per-model key, so existing counters keep counting.
 * `counters` is a plain object persisted by the caller; returns the padded
 * suffix + new map (most recently used names are evicted last). */
export const normalizeModel = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const MAX_COUNTERS = 300;
export function counterKey(prefix, model) {
  const modelKey = normalizeModel(model) || 'model';
  const p = sanitizePrefix(prefix).trim().toLowerCase();
  return p ? `p:${p}|${modelKey}` : modelKey;
}
export function nextSuffix(model, counters = {}, prefix = '') {
  const key = counterKey(prefix, model);
  const current = Number.isInteger(counters[key]) && counters[key] >= 0 ? counters[key] : 0;
  const n = current + 1;
  const updated = { ...counters };
  delete updated[key];
  updated[key] = n; // re-insert so the most recently used names are evicted last
  const keys = Object.keys(updated);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_COUNTERS))) delete updated[k];
  return { suffix: String(n).padStart(3, '0'), counters: updated };
}

/* Once-per-conversation gate for auto-rename (extension createAutoRenameStore
 * .claim): deleting history must not re-arm it, so it lives in its own key. */
export function createRenameGate(store, { key = 'rename-attempted', max = 500 } = {}) {
  let queue = Promise.resolve();
  const enqueue = (task) => { const work = queue.then(task); queue = work.catch(() => {}); return work; };
  return {
    claim: (sessionId) => enqueue(async () => {
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('会话 ID 无效');
      const list = Array.isArray(await store.get(key)) ? await store.get(key) : [];
      if (list.includes(sessionId)) return false;
      list.push(sessionId);
      await store.set(key, list.slice(-max));
      return true;
    }),
    release: (sessionId) => enqueue(async () => {
      const list = Array.isArray(await store.get(key)) ? await store.get(key) : [];
      await store.set(key, list.filter((s) => s !== sessionId));
    }),
  };
}
