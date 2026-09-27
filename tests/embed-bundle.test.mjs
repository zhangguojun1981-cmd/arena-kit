import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './helpers.mjs';
import { generate, transformModule, collectModules, extractMarkup } from '../scripts/bundle-dock.mjs';
import { shadowCss, clampPos, mount } from '../src/embed/shell.js';
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
  assert.deepEqual(clampPos({ x: -20, y: 5000 }, 360, 640), { x: 0, y: 594 });
  assert.deepEqual(clampPos({ x: 100, y: 100 }, 360, 640), { x: 100, y: 100 });
  assert.deepEqual(clampPos(null, 360, 640), { x: 0, y: 0 });
});

/* Minimal DOM stand-in: every element tolerates any property, querySelector
 * returns fresh elements, dataset/style are plain objects. Enough to drive
 * mount() and the dock boot path in browser-preview (no Tauri) mode. */
function fakeDom() {
  const events = [];
  const byId = {};
  const mk = (tag) => {
    const base = {
      tag, dataset: {}, style: {}, children: [], listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); events.push(t); },
      removeEventListener() {},
      querySelector: () => mk('div'), querySelectorAll: () => [], getElementById: (id) => (byId[id] ||= mk(id)),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 46, height: 46 }),
      appendChild(c) { this.children.push(c); return c; }, remove() {}, setAttribute(k, v) { this['attr_' + k] = v; },
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
