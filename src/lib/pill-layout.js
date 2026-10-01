/* Floating status-pill geometry — port of arena-trace-android
 * ui/FloatingDragHelper.kt (edge-snapping) + ui/HudFormat.pill. Pure.
 *
 * The pill's position is stored as (side, yFraction), never as pixels, so it
 * lands on the same edge after a rotation / resize and always hugs a side. */

export const PILL_MARGIN = 8;          // dp from the screen edge (reference EDGE_MARGIN_DP)
export const PILL_DEFAULT_Y = 0.18;    // fraction of the free vertical range
export const SNAP_MS = 180;            // reference snap animation (decelerate)

/* Which side the pill snaps to after a drag: the nearer one. */
export function snapSide(centerX, viewportWidth) {
  return centerX < viewportWidth / 2 ? 'left' : 'right';
}

/* Clamp a y fraction into [0, 1]; anything unusable → the default. */
export function normalizeFraction(y) {
  if (y === null || y === undefined || y === '') return PILL_DEFAULT_Y; // Number(null) is 0, not "unknown"
  const n = Number(y);
  if (!Number.isFinite(n)) return PILL_DEFAULT_Y;
  return Math.max(0, Math.min(1, n));
}

/* Pixel position for a stored (side, yFraction) given the viewport and the
 * pill's own size. Always inside the viewport, margin from the edges. */
export function pillPlacement(pos, vw, vh, w, h, margin = PILL_MARGIN) {
  const side = pos && pos.side === 'left' ? 'left' : 'right';
  const yFrac = normalizeFraction(pos && pos.y);
  const freeY = Math.max(0, vh - h - 2 * margin);
  const x = side === 'left' ? margin : Math.max(margin, vw - w - margin);
  const y = margin + Math.round(freeY * yFrac);
  return { side, x, y };
}

/* Inverse of pillPlacement for the y axis: where (in fraction) a dragged pill
 * ended up, so the release position survives a resize. */
export function fractionForY(y, vh, h, margin = PILL_MARGIN) {
  const freeY = Math.max(0, vh - h - 2 * margin);
  if (freeY === 0) return PILL_DEFAULT_Y;
  return Math.max(0, Math.min(1, (y - margin) / freeY));
}

/* Position after a drag release: snap to the nearer side, keep the y. */
export function releasePosition({ x, y }, vw, vh, w, h, margin = PILL_MARGIN) {
  const side = snapSide(x + w / 2, vw);
  const yFrac = fractionForY(Math.max(margin, Math.min(y, vh - h - margin)), vh, h, margin);
  return { side, y: yFrac };
}

/* Quota ring colour band (reference StatusPillView: brand ≥ 20, warn 10–19,
 * danger < 10, unknown → track only). */
export function ringBand(percent) {
  const p = percent === null || percent === undefined || percent === '' ? NaN : Number(percent);
  if (!Number.isFinite(p)) return 'unknown';
  if (p < 10) return 'danger';
  if (p < 20) return 'warning';
  return 'ok';
}

/* The pill's one-line label + tone (reference HudFormat.pill). Priority:
 * transient flash → running task → model → pending → new chat → nothing
 * (ring only). Tones: 'active' (brand), 'routed' (warn), 'muted', 'normal'.
 * `estimate` marks a statistical fingerprint guess: it is prefixed with "≈"
 * and shown muted so the ball never presents a guess like a confirmed name. */
export function pillLabel({ flash = '', task = null, model = '', strength = '', routed = false, pending = false, newChat = false, estimate = false } = {}) {
  if (flash) return { text: String(flash), tone: 'active' };
  if (task && task.kind === 'probe') {
    const verb = task.draw ? '抽卡' : '探针';
    const count = task.draw ? '识别' : '命中';
    return { text: `${verb} ${task.round || 0}/${task.max || 0} · ${count} ${task.hits || 0}`, tone: 'active' };
  }
  if (task && task.kind === 'cleanup') return { text: `清理中 · 已归档 ${task.archived || 0}`, tone: 'active' };
  if (task && task.kind === 'recovery') return { text: '回复异常 · 自动刷新…', tone: 'active' };
  if (model) {
    if (estimate) return { text: '≈' + String(model), tone: 'muted' };
    return { text: String(model) + (strength ? ' · ' + strength : ''), tone: routed ? 'routed' : 'normal' };
  }
  if (pending) return { text: '识别中…', tone: 'muted' };
  if (newChat) return { text: '新对话', tone: 'muted' };
  return { text: '', tone: 'muted' };
}

/* Turn-list headline (reference HudFormat.headline): "共 5 轮 · 首轮 m · 当前已切换 · 本地记录". */
export function turnHeadline({ count = 0, firstModel = '', routed = false, restored = false } = {}) {
  if (!count) return '';
  const parts = [`共 ${count} 轮`];
  if (firstModel) parts.push(`首轮 ${firstModel}`);
  if (routed) parts.push('当前已切换');
  if (restored) parts.push('本地记录');
  return parts.join(' · ');
}
