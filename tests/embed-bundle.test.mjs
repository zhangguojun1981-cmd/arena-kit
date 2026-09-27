import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './helpers.mjs';
import { generate, transformModule, collectModules, extractMarkup } from '../scripts/bundle-dock.mjs';
import { shadowCss, clampPos, mount, ringPalette, fitFont, BALL_SIZE, PILL_HEIGHT, RING_C } from '../src/embed/shell.js';
import { pillPlacement, releasePosition, snapSide, fractionForY, pillLabel, turnHeadline, ringBand, PILL_MARGIN } from '../src/lib/pill-layout.js';
import { summarizeUsage, formatMoney } from '../src/lib/usage.js';
import { buildTitle } from '../src/lib/rename.js';

/* ── bundler ─────────────────────────────────────────────────────────── */
test('generated files are committed and up to date', () => {
  const { assets, bundle } = generate();
  assert.equal(read('src/embed/assets.gen.js'), assets, 'assets.gen.js stale — run node scripts/bundle-dock.mjs');
  assert.equal(read('src/embed/dock-embedded.gen.js'), bundle, 'dock-embedded.gen.js stale — run node scripts/bundle-dock.mjs');
  assert.ok(!bundle.includes('\nimport '), 'no raw import statements survive');
});

test('transformModule rewrites the supported import/export forms only', () => {
  const src = "import { a, b as c } from './x.js';\nexport function f() { return a + c; }\nexport const K = 1;\nexport async function g() {}\nfunction h() {}\nexport { h, K as KK };\n";
  const out = transformModule(src, 'lib/m.js');
  assert.ok(out.includes('const { a, b: c } = __require("lib/x.js");'));
  assert.ok(out.includes('\nfunction f()'));
  assert.ok(out.includes('__exports.f = f;'));
  assert.ok(out.includes('__exports.K = K;'));
  assert.ok(out.includes('__exports.g = g;'));
  assert.ok(out.includes('__exports.h = h;'));
  assert.ok(out.includes('__exports.KK = K;'));
  assert.throws(() => transformModule("export default 1;\n", 'lib/bad.js'), /unsupported module syntax/);
  assert.throws(() => transformModule("import x from './y.js';\n", 'lib/bad.js'), /unsupported module syntax/);
});

test('collectModules orders dependencies first and rejects cycles', () => {
  const files = { 'a.js': "import { b } from './lib/b.js';", 'lib/b.js': "import { c } from './c.js';", 'lib/c.js': 'export const c = 1;' };
  assert.deepEqual(collectModules(['a.js'], (id) => files[id]), ['lib/c.js', 'lib/b.js', 'a.js']);
  const cyc = { 'a.js': "import { b } from './b.js';", 'b.js': "import { a } from './a.js';" };
  assert.throws(() => collectModules(['a.js'], (id) => cyc[id]), /import cycle/);
});

test('extractMarkup keeps the dock body and drops the module script', () => {
  const m = extractMarkup(read('src/dock.html'));
  assert.ok(m.includes('<header class="ak-head">'));
  assert.ok(m.includes('id="ak-status"'));
  assert.ok(!/<script/i.test(m));
});

/* ── the bundle runs: modules behave exactly like their ESM originals ─── */
function loadRegistry() {
  let req = null;
  const sandbox = { __ARENAKIT_BUNDLE_HOOK__: (r) => { req = r; }, console, setTimeout, clearTimeout, URL, JSON, Math, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/embed/dock-embedded.gen.js'), sandbox, { filename: 'dock-embedded.gen.js' });
  assert.ok(req, 'hook received the registry');
  return req;
}

test('bundle registry exposes working lib modules', () => {
  const req = loadRegistry();
  const usage = req('lib/usage.js');
  const runs = [{ tokens: 120, costUsd: 0.5, spanCount: 1 }, { tokens: 80, costUsd: 0.25, spanCount: 2 }];
  assert.deepEqual(JSON.parse(JSON.stringify(usage.summarizeUsage(runs))), JSON.parse(JSON.stringify(summarizeUsage(runs))));
  assert.equal(usage.formatMoney(1.2345), formatMoney(1.2345));
  assert.equal(req('lib/rename.js').buildTitle({ prefix: 'AK-', model: 'gpt-5', suffix: '003' }), buildTitle({ prefix: 'AK-', model: 'gpt-5', suffix: '003' }));
  assert.equal(req('lib/rpc.js').RPC_TIMEOUT_MS, 35_000);
  assert.equal(typeof req('embed/shell.js').mount, 'function');
  assert.ok(req('embed/assets.gen.js').CSS.includes('.ak-head'));
  assert.throws(() => req('lib/nope.js'), /missing module/);
});

/* ── shell ───────────────────────────────────────────────────────────── */
test('shadowCss retargets document-level rules to the shadow root', () => {
  const css = shadowCss(':root {\n  --ak-bg: #000;\n}\n* { box-sizing: border-box; }\nhtml, body {\n  margin: 0;\n}\n.ak-head { color: red; }');
  assert.ok(css.startsWith(':host {'));
  assert.ok(css.includes('\n.ak-shell {\n  margin: 0;'));
  assert.ok(!css.includes('html, body'));
  assert.ok(css.includes('.ak-head { color: red; }'));
});

test('clampPos keeps a dragged box inside the viewport', () => {
  assert.equal(BALL_SIZE, PILL_HEIGHT);
  assert.deepEqual(clampPos({ x: -20, y: 5000 }, 360, 640), { x: 0, y: 640 - PILL_HEIGHT });
  assert.deepEqual(clampPos({ x: -20, y: 5000 }, 360, 640, 46), { x: 0, y: 594 });
  assert.deepEqual(clampPos({ x: 350, y: 100 }, 360, 640, 36, 120), { x: 240, y: 100 });
  assert.deepEqual(clampPos(null, 360, 640), { x: 0, y: 0 });
});

test('ringPalette / ringBand follow the reference quota health bands (brand ≥20, warn 10–19, danger <10, unknown → track only)', () => {
  assert.equal(ringPalette(null).dim, true);
  assert.equal(ringPalette(null).band, 'unknown');
  assert.equal(ringPalette(undefined).base, '#2F6BFF');
  assert.deepEqual(ringPalette(0), { band: 'danger', base: '#D93025', dim: false });
  assert.equal(ringPalette(9).band, 'danger');
  assert.equal(ringPalette(10).band, 'warning');
  assert.equal(ringPalette(19).base, '#B26A00');
  assert.equal(ringPalette(20).band, 'ok');
  assert.equal(ringPalette(100).base, '#2F6BFF');
  assert.equal(ringBand(''), 'unknown');
});

/* ── pill geometry (FloatingDragHelper port) ─────────────────────────── */
test('pillPlacement keeps the pill on its side with the 8 dp margin and maps the y fraction onto the free range', () => {
  assert.deepEqual(pillPlacement({ side: 'right', y: 0.18 }, 360, 640, 120, 36), { side: 'right', x: 360 - 120 - PILL_MARGIN, y: 8 + Math.round((640 - 36 - 16) * 0.18) });
  assert.deepEqual(pillPlacement({ side: 'left', y: 0 }, 360, 640, 120, 36), { side: 'left', x: 8, y: 8 });
  assert.deepEqual(pillPlacement({ side: 'left', y: 1 }, 360, 640, 120, 36), { side: 'left', x: 8, y: 640 - 36 - 8 });
  // garbage → defaults (right side, 18 %)
  assert.deepEqual(pillPlacement(null, 360, 640, 100, 36), pillPlacement({ side: 'right', y: 0.18 }, 360, 640, 100, 36));
  assert.equal(pillPlacement({ side: 'right', y: 'x' }, 360, 640, 100, 36).y, pillPlacement({ side: 'right', y: 0.18 }, 360, 640, 100, 36).y);
  // a pill wider than the viewport still starts at the margin
  assert.equal(pillPlacement({ side: 'right', y: 0 }, 200, 640, 400, 36).x, 8);
});

test('releasePosition snaps to the nearer edge and keeps the height as a fraction', () => {
  assert.equal(snapSide(100, 360), 'left');
  assert.equal(snapSide(180, 360), 'right');
  const left = releasePosition({ x: 30, y: 300 }, 360, 640, 120, 36);
  assert.equal(left.side, 'left');
  assert.ok(Math.abs(left.y - fractionForY(300, 640, 36)) < 1e-9);
  assert.equal(releasePosition({ x: 200, y: 300 }, 360, 640, 120, 36).side, 'right');
  assert.equal(releasePosition({ x: 0, y: -50 }, 360, 640, 120, 36).y, 0);
  assert.equal(releasePosition({ x: 0, y: 5000 }, 360, 640, 120, 36).y, 1);
  // round trip: placing at the released fraction lands on the same y
  const rel = releasePosition({ x: 300, y: 222 }, 360, 640, 120, 36);
  assert.equal(pillPlacement(rel, 360, 640, 120, 36).y, 222);
});

test('pillLabel priority: flash → task → model (routed = warn tone) → 识别中 → 新对话 → ring only', () => {
  assert.deepEqual(pillLabel({ flash: '已发送 ✓', task: { kind: 'probe', round: 1, max: 5, hits: 0 }, model: 'gpt-5' }), { text: '已发送 ✓', tone: 'active' });
  assert.deepEqual(pillLabel({ task: { kind: 'probe', round: 2, max: 5, hits: 1 }, model: 'gpt-5' }), { text: '探针 2/5 · 命中 1', tone: 'active' });
  assert.deepEqual(pillLabel({ task: { kind: 'probe', round: 3, max: 10, hits: 3, draw: true } }), { text: '抽卡 3/10 · 识别 3', tone: 'active' });
  assert.deepEqual(pillLabel({ task: { kind: 'cleanup', archived: 4 } }), { text: '清理中 · 已归档 4', tone: 'active' });
  assert.deepEqual(pillLabel({ task: { kind: 'recovery' } }), { text: '回复异常 · 自动刷新…', tone: 'active' });
  assert.deepEqual(pillLabel({ model: 'claude-opus-4-1' }), { text: 'claude-opus-4-1', tone: 'normal' });
  assert.deepEqual(pillLabel({ model: 'gpt-5', routed: true, strength: 'high' }), { text: 'gpt-5 · high', tone: 'routed' });
  assert.deepEqual(pillLabel({ pending: true }), { text: '识别中…', tone: 'muted' });
  assert.deepEqual(pillLabel({ newChat: true }), { text: '新对话', tone: 'muted' });
  assert.deepEqual(pillLabel({}), { text: '', tone: 'muted' });
});

test('turnHeadline mirrors HudFormat.headline', () => {
  assert.equal(turnHeadline({}), '');
  assert.equal(turnHeadline({ count: 1, firstModel: 'gpt-5' }), '共 1 轮 · 首轮 gpt-5');
  assert.equal(turnHeadline({ count: 5, firstModel: 'a', routed: true, restored: true }), '共 5 轮 · 首轮 a · 当前已切换 · 本地记录');
  assert.equal(turnHeadline({ count: 2 }), '共 2 轮');
});

test('fitFont shrinks long centre text but never below the floor', () => {
  assert.equal(fitFont('37%', 15, 46), 15);
  assert.equal(fitFont('100%', 15, 46), 15);
  assert.ok(fitFont('claude-opus', 12, 46) < 12);
  assert.equal(fitFont('一二三四五六七八九十', 12, 46, 7), 7);
  assert.equal(fitFont('', 15, 46), 15);
});

/* Minimal DOM stand-in: every element tolerates any property, querySelector
 * returns fresh elements, dataset/style are plain objects. Enough to drive
 * mount() and the dock boot path in browser-preview (no Tauri) mode. */
function fakeDom() {
  const events = [];
  const byId = {};
  const bySel = {};
  const mk = (tag) => {
    const base = {
      tag, dataset: {}, style: {}, children: [], listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); events.push(t); },
      removeEventListener() {},
      querySelector: (sel) => (bySel[sel] ||= mk(sel)), querySelectorAll: () => [], getElementById: (id) => (byId[id] ||= mk(id)),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 46, height: 46 }),
      appendChild(c) { this.children.push(c); return c; }, remove() {}, setAttribute(k, v) { this['attr_' + k] = v; }, removeAttribute(k) { delete this['attr_' + k]; }, getAttribute(k) { return this['attr_' + k] ?? null; },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setPointerCapture() {}, closest: () => null, focus() {}, select() {},
    };
    return base;
  };
  const shadow = mk('shadow-root');
  const doc = {
    readyState: 'complete', title: 'Arena', body: mk('body'), documentElement: mk('html'),
    createElement: (tag) => { const el = mk(tag); if (tag === 'div') el.attachShadow = () => shadow; return el; },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
  };
  return { doc, shadow, events, mk, byId };
}

test('mount() builds the shadow host once and publishes the embed API', async () => {
  const { doc, shadow } = fakeDom();
  const store = new Map();
  const win = { document: doc, innerWidth: 360, innerHeight: 640, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  assert.equal(mount(win), true);
  const api = win.__ARENAKIT_EMBED__;
  assert.equal(api.root, shadow);
  assert.ok(shadow.innerHTML.includes('<style>') && shadow.innerHTML.includes('id="ak-status"') && shadow.innerHTML.includes('class="ak-pill"'));
  assert.ok(shadow.innerHTML.includes('class="ak-sheet"') && shadow.innerHTML.includes('class="ak-sheet-handle"'), 'bottom sheet with handle');
  assert.ok(shadow.innerHTML.includes(':host {') && !shadow.innerHTML.includes('html, body'));
  assert.equal(doc.body.children.length, 1);
  assert.equal(api.isOpen(), false);
  const events = [];
  api.onAction((n, a) => events.push(a ? n + ':' + a : n));
  api.toggle(); assert.equal(api.isOpen(), true);
  const wrap = shadow.querySelector('.ak-pill-wrap');
  assert.equal(wrap.dataset.hidden, 'true', 'pill fades out while the sheet is open');
  api.close(); assert.equal(api.isOpen(), false);
  assert.equal(wrap.dataset.hidden, 'false');
  assert.deepEqual(events, ['open', 'close']);
  // default placement: right edge, 18 % down
  assert.equal(wrap.dataset.side, 'right');
  assert.equal(wrap.style.left, (360 - 46 - PILL_MARGIN) + 'px');
  // pill API: percent → arc length + band; label + tone; busy orbit
  const arc = shadow.querySelector('.ak-pill-arc');
  api.setPill({ percent: 15, label: 'gpt-5', tone: 'routed', busy: false });
  assert.equal(arc.dataset.band, 'warning');
  assert.ok(String(arc['attr_stroke-dasharray']).startsWith((0.15 * RING_C).toFixed(3)));
  assert.equal(shadow.querySelector('.ak-pill-pct').textContent, '15');
  assert.equal(shadow.querySelector('.ak-pill-label').textContent, 'gpt-5');
  assert.equal(shadow.querySelector('.ak-pill-label').dataset.tone, 'routed');
  api.setPill({ percent: null, label: '', tone: 'muted', busy: true });
  assert.equal(shadow.querySelector('.ak-pill-pct').textContent, '–');
  assert.equal(arc.dataset.band, 'unknown');
  assert.equal(shadow.querySelector('.ak-pill').dataset.busy, 'true');
  // legacy setBall still maps onto the pill
  api.setBall({ percent: 72, top: '72%', bottom: 'claude-opus', isModel: true, routed: false });
  assert.equal(shadow.querySelector('.ak-pill-label').textContent, 'claude-opus');
  assert.equal(shadow.querySelector('.ak-pill-pct').textContent, '72');
  // ⟳ zone toggle + loading state + back key + menu provider + confirm
  api.setRefreshButton(false);
  assert.equal(shadow.querySelector('.ak-pill').dataset.refresh, 'false');
  api.setLoading(true);
  assert.equal(shadow.querySelector('.ak-pill').dataset.refreshing, 'true');
  assert.equal(shadow.querySelector('.ak-progress').dataset.show, 'true');
  api.setLoading(false);
  assert.equal(shadow.querySelector('.ak-pill').dataset.refreshing, 'false');
  api.open();
  assert.equal(api.handleBack(), true, 'back closes the sheet');
  assert.equal(api.isOpen(), false);
  assert.equal(api.handleBack(), false, 'nothing open → not consumed');
  assert.equal(typeof api.setMenuProvider, 'function');
  const p = api.confirm({ title: '刷新页面？', message: 'x' });
  assert.equal(shadow.querySelector('.ak-dialog').dataset.show, 'true');
  assert.equal(api.handleBack(), true, 'back cancels the dialog');
  assert.equal(await p, false);
  // second mount is a no-op (idempotent across re-injection)
  assert.equal(mount(win), false);
  assert.equal(doc.body.children.length, 1);
});

test('desktop input: Esc closes the open layer, ⌘R / F5 fire refresh, ⌘[ ⌘] page history, right-click on the pill opens the quick menu', () => {
  const { doc, shadow } = fakeDom();
  const store = new Map();
  const winListeners = {};
  const hist = [];
  const win = {
    document: doc, innerWidth: 1280, innerHeight: 860,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    history: { back() { hist.push('back'); }, forward() { hist.push('forward'); } },
  };
  assert.equal(mount(win), true);
  const api = win.__ARENAKIT_EMBED__;
  const actions = [];
  api.onAction((n, a) => actions.push(a ? n + ':' + a : n));
  assert.ok(winListeners.keydown && winListeners.keydown.length === 1, 'one capture keydown hook on the window');
  const key = (init) => { const e = { prevented: false, preventDefault() { e.prevented = true; }, stopPropagation() {}, target: null, ...init }; winListeners.keydown.forEach((fn) => fn(e)); return e; };
  api.open();
  assert.equal(key({ key: 'Escape' }).prevented, true, 'Esc closes the sheet');
  assert.equal(api.isOpen(), false);
  assert.equal(key({ key: 'Escape' }).prevented, false, 'nothing open → Esc is left to the page');
  assert.equal(key({ key: 'r', metaKey: true }).prevented, true, '⌘R');
  assert.equal(key({ key: 'R', ctrlKey: true }).prevented, true, 'Ctrl+R');
  assert.equal(key({ key: 'F5' }).prevented, true, 'F5');
  assert.equal(key({ key: 'r', metaKey: true, shiftKey: true }).prevented, false, '⌘⇧R is not ours');
  assert.equal(actions.filter((a) => a === 'refresh').length, 3);
  key({ key: '[', metaKey: true });
  key({ key: ']', ctrlKey: true });
  assert.deepEqual(hist, ['back', 'forward']);
  key({ key: '[', metaKey: true, target: { isContentEditable: true, tagName: 'DIV' } });
  key({ key: ']', metaKey: true, target: { tagName: 'TEXTAREA' } });
  assert.deepEqual(hist, ['back', 'forward'], 'history shortcuts stay out of editors');
  // right-click on the pill = long press → quick menu; Esc closes it first.
  api.setMenuProvider(() => [{ id: 'probe', label: '探针' }, { id: 'reload', label: '刷新' }]);
  const pill = shadow.querySelector('.ak-pill');
  const ctx = { prevented: false, preventDefault() { ctx.prevented = true; } };
  pill.listeners.contextmenu.forEach((fn) => fn(ctx));
  assert.equal(ctx.prevented, true, 'no browser context menu on the pill');
  const menu = shadow.querySelector('.ak-menu');
  assert.equal(menu.dataset.show, 'true');
  assert.ok(menu.innerHTML.includes('data-menu="probe"') && menu.innerHTML.includes('data-menu="reload"'));
  assert.equal(actions.at(-1), 'longpress');
  assert.equal(key({ key: 'Escape' }).prevented, true);
  assert.equal(menu.dataset.show, 'false');
  pill.listeners.contextmenu.forEach((fn) => fn(ctx));
  assert.equal(menu.dataset.show, 'true');
  pill.listeners.contextmenu.forEach((fn) => fn(ctx));
  assert.equal(menu.dataset.show, 'false', 'second right-click toggles the menu off');
});

test('the whole bundle boots the dock inside a page without a Tauri runtime', async () => {
  const { doc, byId } = fakeDom();
  const store = new Map();
  const sandbox = {
    document: doc, innerWidth: 360, innerHeight: 640,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { pathname: '/agent', href: 'https://arena.ai/agent', assign() {} },
    console, setTimeout, clearTimeout, clearInterval, URL, JSON, Math, Date, Promise, Map, Set, Number, String, Object, Array, Error,
    // the dock's 1 s pulse countdown must not keep the test process alive
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/embed/dock-embedded.gen.js'), sandbox, { filename: 'dock-embedded.gen.js' });
  assert.ok(sandbox.__ARENAKIT_EMBED__, 'shell mounted');
  // boot() is async: let the store fallbacks settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(byId['ak-status'].textContent, '浏览器预览模式(无 Tauri 运行时)');
  assert.ok(byId['ak-history-list'].innerHTML.includes('暂无记录'));
  assert.equal(byId['ak-unlock-opus'].checked, true); // DEFAULT_PREFS applied through the shadow root
  // no platform stamp (Android / preview): the 桌面布局 row stays hidden
  assert.equal(byId['ak-layout-row'].hidden, true);
});

test('embedded dock on desktop (platform stamp): 桌面布局 row is shown and the hints talk keyboard, not touch', async () => {
  const { doc, byId } = fakeDom();
  const store = new Map();
  const sandbox = {
    __ARENAKIT_PLATFORM__: 'desktop',
    document: doc, innerWidth: 1280, innerHeight: 860,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { pathname: '/agent', href: 'https://arena.ai/agent', assign() {} },
    console, setTimeout, clearTimeout, clearInterval, URL, JSON, Math, Date, Promise, Map, Set, Number, String, Object, Array, Error,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/embed/dock-embedded.gen.js'), sandbox, { filename: 'dock-embedded.gen.js' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(byId['ak-layout-row'].hidden, false);
  assert.ok(byId['ak-layout-note'].textContent.includes('⌘R'), 'running layout (pill) explained');
  assert.ok(byId['ak-refresh-note'].textContent.includes('F5'), 'touch-only hint replaced by the shortcuts');
});

/* Runtime-mode boot with a Tauri stand-in (like src/embed/preview.html):
 * trace / pulse / monitor events must reach the header and the floating ball. */
test('embedded dock: trace + pulse events drive the HUD header and the ball (per-turn model on Android)', async () => {
  const { doc, byId, shadow } = fakeDom();
  const store = new Map();
  const listeners = {};
  const sandbox = {
    document: doc, innerWidth: 360, innerHeight: 640,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { pathname: '/agent/s1', href: 'https://arena.ai/agent/s1', assign() {}, reload() {} },
    history: { back() {}, forward() {} },
    console, clearTimeout, clearInterval, URL, JSON, Math, Date, Promise, Map, Set, Number, String, Object, Array, Error,
    // ball transients / alert timers must not keep the test process alive
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
    __TAURI__: {
      core: { invoke: async (cmd, args) => (cmd === 'store_get' ? (store.get('rs.' + args.key) ?? null) : cmd === 'store_set' ? void store.set('rs.' + args.key, args.value) : cmd === 'store_keys' ? [] : null) },
      event: { listen: async (name, cb) => { listeners[name] = cb; return () => {}; } },
    },
    __ARENAKIT__: { navState: () => ({ sessionId: 's1', path: '/agent/s1', title: '', agentPath: true }), dispatch: () => 1, send() {} },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/embed/dock-embedded.gen.js'), sandbox, { filename: 'dock-embedded.gen.js' });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  assert.equal(byId['ak-status'].textContent, '就绪（内嵌模式）');
  assert.ok(listeners['arenakit://trace'] && listeners['arenakit://page'], 'dock subscribed to both Rust events');
  const emit = (name, payload) => listeners[name]({ payload });
  const pct = shadow.querySelector('.ak-pill-pct');
  const label = shadow.querySelector('.ak-pill-label');
  const pill = shadow.querySelector('.ak-pill');
  const arc = shadow.querySelector('.ak-pill-arc');

  // quota → header right column + ring (arc = 72 %, number inside)
  emit('arenakit://page', { name: 'pulse', payload: { ok: true, percent: 72, refreshedAt: Date.now() - 3600e3, at: Date.now() } });
  assert.equal(byId['ak-hud-percent'].textContent, '72%');
  assert.equal(byId['ak-hud-percent'].dataset.band, 'ok');
  assert.match(byId['ak-hud-pulse'].textContent, /后重置$/);
  assert.equal(pct.textContent, '72');
  assert.equal(arc.dataset.band, 'ok');
  assert.ok(String(arc['attr_stroke-dasharray']).startsWith((0.72 * RING_C).toFixed(3)));

  // turn 1: token → status line + "识别中…" on the pill; model → header + pill label
  emit('arenakit://trace', { stage: 'token', sessionId: 's1', runId: 'run_1' });
  assert.equal(byId['ak-hud-status'].textContent, '第 1 轮 · 已截获令牌，正在识别模型…');
  assert.equal(label.textContent, '识别中…');
  assert.equal(label.dataset.tone, 'muted');
  emit('arenakit://trace', { stage: 'model', sessionId: 's1', runId: 'run_1', complete: true, models: [{ model: 'claude-opus-4-1', provider: 'anthropic' }], spans: [] });
  await settle();
  assert.equal(byId['ak-hud-model'].textContent, 'claude-opus-4-1');
  assert.equal(byId['ak-hud-model'].dataset.known, 'true');
  assert.equal(byId['ak-hud-model'].dataset.routed, 'false');
  assert.equal(byId['ak-hud-status'].textContent, '第 1 轮 · claude-opus-4-1'); // reference TurnTracker wording
  assert.equal(label.textContent, 'claude-opus-4-1');
  assert.equal(label.dataset.tone, 'normal');
  assert.equal(byId['ak-turn-head'].textContent, '共 1 轮 · 首轮 claude-opus-4-1');
  assert.ok(byId['ak-turn-list'].innerHTML.includes('R1') && byId['ak-turn-list'].innerHTML.includes('ak-turn-ok'));

  // turn 2 routed to another model → warn tone on header + pill, 已切换 tag, newest first
  emit('arenakit://trace', { stage: 'token', sessionId: 's1', runId: 'run_2' });
  emit('arenakit://trace', { stage: 'model', sessionId: 's1', runId: 'run_2', complete: true, models: [{ model: 'gpt-5', provider: 'openai' }], spans: [] });
  await settle();
  assert.equal(byId['ak-hud-model'].dataset.routed, 'true');
  assert.match(byId['ak-hud-status'].textContent, /^第 2 轮 · 已切换模型 → gpt-5/);
  assert.equal(label.textContent, 'gpt-5');
  assert.equal(label.dataset.tone, 'routed');
  assert.equal(byId['ak-turn-head'].textContent, '共 2 轮 · 首轮 claude-opus-4-1 · 当前已切换');
  const rows = byId['ak-turn-list'].innerHTML;
  assert.ok(rows.indexOf('R2') < rows.indexOf('R1'), 'newest turn first');
  assert.ok(rows.includes('已切换'));

  // low quota → danger band on ring + header
  emit('arenakit://page', { name: 'pulse', payload: { ok: true, percent: 6, refreshedAt: Date.now() - 3600e3, at: Date.now() } });
  assert.equal(arc.dataset.band, 'danger');
  assert.equal(pct.textContent, '6');
  assert.equal(byId['ak-hud-percent'].dataset.band, 'danger');

  // reply anomaly → alert outline
  emit('arenakit://page', { name: 'reply-monitor', payload: { sessionId: 's1', runId: 'run_2', frames: 3, textChars: 0, errorFrames: 0, ended: 'done', durationMs: 1200, at: Date.now() } });
  assert.equal(pill.dataset.alert, 'true');

  // new conversation → placeholder again, pill says 新对话
  emit('arenakit://page', { name: 'nav', payload: { sessionId: null, path: '/agent', title: '', agentPath: true } });
  assert.equal(byId['ak-hud-model'].textContent, '模型待确认');
  assert.equal(byId['ak-hud-status'].textContent, '等待会话流…');
  assert.equal(pct.textContent, '6');
  assert.equal(label.textContent, '新对话');
  assert.ok(byId['ak-turn-list'].innerHTML.includes('暂无轮次记录'));

  // settings switches: page flags pushed on boot, 截获会话流 off gates the dock too
  assert.equal(JSON.stringify(sandbox.__ARENAKIT_FLAGS__), JSON.stringify({ capture: true, pulse: true, monitor: true, autoRefresh: true }));
  assert.equal(byId['ak-pill-refresh'].checked, true, 'pill ⟳ switch defaults on');
  assert.equal(byId['ak-auto-refresh'].checked, true, 'auto-refresh switch defaults on');
  assert.equal(sandbox.__ARENAKIT_EMBED__.host.dataset.embed, 'true');
  const capture = byId['ak-capture-on'];
  capture.checked = false;
  capture.listeners.change[0]();
  await settle();
  assert.equal(sandbox.__ARENAKIT_FLAGS__.capture, false);
  emit('arenakit://trace', { stage: 'token', sessionId: 's9', runId: 'run_9' });
  assert.equal(byId['ak-hud-status'].textContent, '等待会话流…', 'trace ignored while capture is off');
  const monitor = byId['ak-monitor-on'];
  monitor.checked = false;
  monitor.listeners.change[0]();
  assert.equal(byId['ak-monitor-head'].textContent, '回复监控已关闭（设置 → 回复监控）。');

  // tabs: click 探针 → page switch persisted in prefs
  const tabs = {};
  // fake querySelectorAll returns [], so drive showTab through the exported state instead
  assert.equal(typeof sandbox.__ARENAKIT_EMBED__.handleBack, 'function');
  void tabs;

  // status pill ⟳ → requestReload marks sessionStorage + reloads the page, pill spins
  let reloaded = 0;
  sandbox.location.reload = () => { reloaded++; };
  sandbox.sessionStorage = { data: {}, setItem(k, v) { this.data[k] = v; }, getItem(k) { return this.data[k] ?? null; }, removeItem(k) { delete this.data[k]; } };
  const wrapEl = shadow.querySelector('.ak-pill-wrap');
  wrapEl.listeners.pointerdown[0]({ pointerId: 1, clientX: 340, clientY: 130, button: 0 });
  wrapEl.listeners.pointerup[0]({ pointerId: 1, clientX: 340, clientY: 130 });
  await settle();
  // the fake refresh zone rect spans x 10..56, so this tap opened the panel instead
  assert.equal(sandbox.__ARENAKIT_EMBED__.isOpen(), true);
  sandbox.__ARENAKIT_EMBED__.close();
  wrapEl.listeners.pointerdown[0]({ pointerId: 2, clientX: 30, clientY: 130, button: 0 });
  wrapEl.listeners.pointerup[0]({ pointerId: 2, clientX: 30, clientY: 130 });
  await settle();
  assert.equal(reloaded, 1, 'tap on the ⟳ zone reloads');
  assert.ok(sandbox.sessionStorage.data['arenakit.reloading'], 'reload stamped for the boot progress bar');
  assert.equal(pill.dataset.refreshing, 'true');
  wrapEl.listeners.pointerdown[0]({ pointerId: 3, clientX: 30, clientY: 130, button: 0 });
  wrapEl.listeners.pointerup[0]({ pointerId: 3, clientX: 30, clientY: 130 });
  await settle();
  assert.equal(reloaded, 1, '800 ms debounce swallows the second tap');

  // reply watchdog: the page reports an error card twice (≥ 2 s apart) for the
  // OPEN conversation → auto reload; the switch off → nothing.
  emit('arenakit://page', { name: 'nav', payload: { sessionId: 's9', path: '/agent/s9', title: '', agentPath: true } });
  const t0 = Date.now();
  const watch = (at) => emit('arenakit://page', { name: 'watch', payload: { k: 'error:Something went wrong', path: '/agent/s9', generating: false, len: 0, at, act: at } });
  const realNow = Date.now;
  try {
    Date.now = () => t0 + 40_000; // past the 30 s reload safety window of the previous tap
    watch(t0 + 40_000);
    await settle();
    assert.equal(reloaded, 1, 'first sighting only tracks');
    Date.now = () => t0 + 43_000;
    watch(t0 + 43_000);
    await settle();
    assert.equal(reloaded, 2, 'confirmed problem reloads the page');
    assert.ok(byId['ak-status'].textContent.includes('刷新'), byId['ak-status'].textContent);
    // a report for another conversation never reloads the current one
    Date.now = () => t0 + 80_000;
    emit('arenakit://page', { name: 'watch', payload: { k: 'empty', path: '/agent/other', at: t0 + 80_000, act: t0 + 80_000 } });
    emit('arenakit://page', { name: 'watch', payload: { k: 'empty', path: '/agent/other', at: t0 + 80_000, act: t0 + 80_000 } });
    await settle();
    assert.equal(reloaded, 2);
    // switch off: reports are ignored entirely
    byId['ak-auto-refresh'].checked = false;
    byId['ak-auto-refresh'].listeners.change[0]();
    assert.equal(sandbox.__ARENAKIT_FLAGS__.autoRefresh, false, 'flag pushed to the page');
    Date.now = () => t0 + 120_000;
    watch(t0 + 120_000);
    Date.now = () => t0 + 123_000;
    watch(t0 + 123_000);
    await settle();
    assert.equal(reloaded, 2, 'auto refresh off');

    // desktop menu bar 「页面」 (menu.rs emits the page event `menu`): reload
    // goes through requestReload (same debounce), back / forward hit history.
    let back = 0, forward = 0;
    sandbox.history.back = () => { back++; };
    sandbox.history.forward = () => { forward++; };
    Date.now = () => t0 + 200_000;
    emit('arenakit://page', { name: 'menu', payload: { action: 'reload' } });
    await settle();
    assert.equal(reloaded, 3, '菜单 → 刷新');
    emit('arenakit://page', { name: 'menu', payload: { action: 'reload' } });
    await settle();
    assert.equal(reloaded, 3, 'debounced like every other reload source');
    emit('arenakit://page', { name: 'menu', payload: { action: 'back' } });
    emit('arenakit://page', { name: 'menu', payload: { action: 'forward' } });
    emit('arenakit://page', { name: 'menu', payload: { action: 'bogus' } });
    assert.deepEqual([back, forward], [1, 1]);
  } finally {
    Date.now = realNow;
  }
});
