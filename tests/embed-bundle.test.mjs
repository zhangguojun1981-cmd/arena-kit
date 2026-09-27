import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './helpers.mjs';
import { generate, transformModule, collectModules, extractMarkup } from '../scripts/bundle-dock.mjs';
import { shadowCss, clampPos, mount, ringPalette, fitFont, BALL_SIZE } from '../src/embed/shell.js';
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

test('clampPos keeps the floating button inside the viewport', () => {
  assert.deepEqual(clampPos({ x: -20, y: 5000 }, 360, 640), { x: 0, y: 640 - BALL_SIZE });
  assert.deepEqual(clampPos({ x: -20, y: 5000 }, 360, 640, 46), { x: 0, y: 594 });
  assert.deepEqual(clampPos({ x: 100, y: 100 }, 360, 640), { x: 100, y: 100 });
  assert.deepEqual(clampPos(null, 360, 640), { x: 0, y: 0 });
});

test('ringPalette follows the reference quota health bands (blue ≥20, amber 10–19, red <10, dim unknown)', () => {
  assert.equal(ringPalette(null).dim, true);
  assert.equal(ringPalette(undefined).base, '#2563FF');
  assert.deepEqual(ringPalette(0), { base: '#E11D2A', bright: '#FF7A7A', dim: false });
  assert.equal(ringPalette(9).base, '#E11D2A');
  assert.equal(ringPalette(10).base, '#FF8A00');
  assert.equal(ringPalette(19).base, '#FF8A00');
  assert.equal(ringPalette(20).base, '#2563FF');
  assert.equal(ringPalette(100).base, '#2563FF');
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

test('mount() builds the shadow host once and publishes the embed API', () => {
  const { doc, shadow } = fakeDom();
  const store = new Map();
  const win = { document: doc, innerWidth: 360, innerHeight: 640, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  assert.equal(mount(win), true);
  const api = win.__ARENAKIT_EMBED__;
  assert.equal(api.root, shadow);
  assert.ok(shadow.innerHTML.includes('<style>') && shadow.innerHTML.includes('id="ak-status"') && shadow.innerHTML.includes('class="ak-fab"'));
  assert.ok(shadow.innerHTML.includes(':host {') && !shadow.innerHTML.includes('html, body'));
  assert.equal(doc.body.children.length, 1);
  assert.equal(api.isOpen(), false);
  api.toggle(); assert.equal(api.isOpen(), true);
  api.close(); assert.equal(api.isOpen(), false);
  // ball API: percent → arc + palette; model → centre lines
  const arc = shadow.querySelector('.ak-ring-arc');
  api.setBall({ percent: 15, top: '15%', bottom: 'gpt 5', isModel: true, routed: true });
  assert.equal(arc.attr_stroke, '#FF8A00');
  assert.ok(String(arc['attr_stroke-dasharray']).startsWith((0.15 * 2 * Math.PI * 27).toFixed(3).slice(0, 5)));
  let fired = null; api.onAction((n) => { fired = n; });
  assert.equal(typeof api.setBusy, 'function');
  assert.equal(fired, null);
  // second mount is a no-op (idempotent across re-injection)
  assert.equal(mount(win), false);
  assert.equal(doc.body.children.length, 1);
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
  const top = shadow.querySelector('.ak-fab-top');
  const bottom = shadow.querySelector('.ak-fab-bottom');
  const fab = shadow.querySelector('.ak-fab');
  const arc = shadow.querySelector('.ak-ring-arc');

  // quota → header text + ball centre percent (default ballCenter = percent + model)
  emit('arenakit://page', { name: 'pulse', payload: { ok: true, percent: 72, refreshedAt: Date.now() - 3600e3, at: Date.now() } });
  assert.match(byId['ak-hud-pulse'].textContent, /^剩余额度 72%/);
  assert.equal(top.textContent, '72%');
  assert.equal(arc.attr_stroke, '#2563FF');
  assert.equal(fab.dataset.dim, 'false');

  // turn 1: token → status line; model → header (green) + ball bottom line
  emit('arenakit://trace', { stage: 'token', sessionId: 's1', runId: 'run_1' });
  assert.equal(byId['ak-hud-status'].textContent, '第 1 轮 · 已截获令牌，正在识别模型…');
  emit('arenakit://trace', { stage: 'model', sessionId: 's1', runId: 'run_1', complete: true, models: [{ model: 'claude-opus-4-1', provider: 'anthropic' }], spans: [] });
  await settle();
  assert.equal(byId['ak-hud-model'].textContent, 'claude-opus-4-1');
  assert.equal(byId['ak-hud-model'].dataset.known, 'true');
  assert.equal(byId['ak-hud-model'].dataset.routed, 'false');
  assert.equal(byId['ak-hud-status'].textContent, '第 1 轮 · claude-opus-4-1'); // reference TurnTracker wording
  assert.equal(top.textContent, '72%');
  assert.equal(bottom.textContent, 'claude-opus'); // 'claude-opus 4-1' is > 12 chars → name part only
  assert.equal(fab.dataset.model, 'mixed');
  assert.equal(fab.dataset.routed, 'false');

  // turn 2 routed to another model → orange-yellow flag on header + ball
  emit('arenakit://trace', { stage: 'token', sessionId: 's1', runId: 'run_2' });
  emit('arenakit://trace', { stage: 'model', sessionId: 's1', runId: 'run_2', complete: true, models: [{ model: 'gpt-5', provider: 'openai' }], spans: [] });
  await settle();
  assert.equal(byId['ak-hud-model'].dataset.routed, 'true');
  assert.match(byId['ak-hud-status'].textContent, /^第 2 轮 · 已切换模型 → gpt-5/);
  assert.equal(bottom.textContent, 'gpt 5');
  assert.equal(fab.dataset.routed, 'true');

  // low quota → red ring
  emit('arenakit://page', { name: 'pulse', payload: { ok: true, percent: 6, refreshedAt: Date.now() - 3600e3, at: Date.now() } });
  assert.equal(arc.attr_stroke, '#E11D2A');
  assert.equal(top.textContent, '6%');

  // reply anomaly → alert rim
  emit('arenakit://page', { name: 'reply-monitor', payload: { sessionId: 's1', runId: 'run_2', frames: 3, textChars: 0, errorFrames: 0, ended: 'done', durationMs: 1200, at: Date.now() } });
  assert.equal(fab.dataset.alert, 'true');

  // new conversation → placeholder again
  emit('arenakit://page', { name: 'nav', payload: { sessionId: null, path: '/agent', title: '', agentPath: true } });
  assert.equal(byId['ak-hud-model'].textContent, '模型待确认');
  assert.equal(byId['ak-hud-status'].textContent, '等待会话流…');
  assert.equal(top.textContent, '6%');
  assert.equal(bottom.textContent, '');

  // settings switches: page flags pushed on boot, 截获会话流 off gates the dock too
  assert.equal(JSON.stringify(sandbox.__ARENAKIT_FLAGS__), JSON.stringify({ capture: true, pulse: true, monitor: true }));
  assert.equal(byId['ak-ball-field'].hidden, false, 'ball centre picker shown in embedded mode');
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
});
