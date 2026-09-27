/* ArenaKit — pure view helpers shared by the dock (and unit-tested in Node).
 * No DOM, no Tauri: every function here is a plain (input) -> output map. */

/** Integer percentage 0..100, or null when total is unknown/zero. */
export function creditPercent(remaining, total) {
  const r = Number(remaining);
  const t = Number(total);
  if (!Number.isFinite(r) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((r / t) * 100)));
}

/** Mirrors pulse.rs credit_band: <10% danger, <20% warning, else ok. */
export function creditBand(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return 'none';
  const p = Number(pct);
  if (p < 10) return 'danger';
  if (p < 20) return 'warning';
  return 'ok';
}

/** "run_0f3a9c…" from a Trigger.dev run id; empty string when absent. */
export function shortRun(runId, keep = 10) {
  if (typeof runId !== 'string' || !runId) return '';
  return runId.length > keep ? runId.slice(0, keep) + '…' : runId;
}

/** Collapse a trace model list into what the dock shows. */
export function describeModels(models) {
  const list = Array.isArray(models) ? models.filter((m) => m && typeof m.model === 'string' && m.model) : [];
  if (!list.length) return { name: '', provider: '', partial: false, count: 0 };
  const names = [...new Set(list.map((m) => m.model))];
  const providers = [...new Set(list.map((m) => m.provider).filter(Boolean))];
  return {
    name: names.join(' · '),
    provider: providers.join(' / '),
    partial: list.some((m) => m.partial === true),
    count: names.length,
  };
}

/** Countdown / clock label for the credit reset; '' when unknown. */
export function formatReset(resetAt, now = Date.now()) {
  if (resetAt === null || resetAt === undefined || resetAt === '') return '';
  let ts = typeof resetAt === 'number' ? resetAt : Date.parse(String(resetAt));
  if (!Number.isFinite(ts)) return typeof resetAt === 'string' ? `重置 ${resetAt}` : '';
  if (ts < 1e12) ts *= 1000; // seconds → ms
  const diff = ts - now;
  if (diff <= 0) return '即将重置';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} 分钟后重置`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分后重置` : `${h} 小时后重置`;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} 重置`;
}

/** "刚刚" / "3 分钟前" / "14:05" for the recent list. */
export function relativeTime(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (diff < 86_400_000) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** Prepend to a bounded recent list, collapsing consecutive duplicates. */
export function pushRecent(list, item, max = 5) {
  const cur = Array.isArray(list) ? list.slice() : [];
  if (cur.length && cur[0] && cur[0].name === item.name) {
    cur[0] = { ...cur[0], ...item };
  } else {
    cur.unshift(item);
  }
  return cur.slice(0, max);
}

/** Theme preference cycle used by the header button. */
export const THEME_MODES = ['system', 'light', 'dark'];

export function nextThemeMode(mode) {
  const i = Math.max(0, THEME_MODES.indexOf(mode)); // unknown → treated as 'system'
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}

/** Effective theme for a preference given the OS setting. */
export function resolveTheme(mode, systemDark) {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDark ? 'dark' : 'light';
}

export function themeLabel(mode) {
  return mode === 'light' ? '主题:浅色' : mode === 'dark' ? '主题:深色' : '主题:跟随系统';
}

/** Character count label for the prompt textarea. */
export function charCount(text) {
  const n = typeof text === 'string' ? [...text].length : 0;
  return `${n} 字`;
}
