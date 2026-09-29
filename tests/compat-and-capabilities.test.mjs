// Regression tests for the 0.5.0 audit (docs/AUDIT.md):
//  * plus.js is a ported extension script and calls chrome.*;
//    they must run as (function (chrome) {…})(window.__AK_CHROME__) and every
//    member they touch must exist on the shim (a missing `chrome` used to kill
//    the whole "排行榜性价比列" module with a ReferenceError).
//  * GM_xmlhttpRequest keeps request headers and never calls back twice.
//  * The remote arena.ai capability stays narrow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { read, plain } from './helpers.mjs';

function shimContext(extra = {}) {
  const mem = new Map();
  const ctx = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
    document: {},
    Response, URL, Promise, JSON, Object, Array, console,
    ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('injected/gm-shim.js'), ctx, { filename: 'injected/gm-shim.js' });
  return ctx;
}

const codeOf = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('plus.js runs with a local chrome = __AK_CHROME__', () => {
  for (const file of ['plus']) {
    const src = read(`injected/${file}.js`);
    assert.match(src, /\(function \(chrome\) \{/, `${file}.js must take chrome as a parameter`);
    assert.match(src.trimEnd(), /\}\)\(window\.__AK_CHROME__\);$/, `${file}.js must be invoked with __AK_CHROME__`);
  }
});

test('__AK_CHROME__ provides every chrome.* member the ported scripts use', () => {
  const ctx = shimContext();
  assert.equal(ctx.chrome, undefined, 'no global `chrome` may leak into the page');
  const used = new Set();
  for (const file of ['plus']) {
    for (const m of codeOf(`injected/${file}.js`).matchAll(/\bchrome((?:\.[A-Za-z]+)+)/g)) used.add(m[1].slice(1));
  }
  assert.ok(used.size >= 3, 'expected several chrome.* member paths, got ' + [...used]);
  for (const path of used) {
    const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx.__AK_CHROME__);
    assert.notEqual(value, undefined, `chrome.${path} is missing from __AK_CHROME__`);
  }
});

test('chrome.storage shim round-trips JSON in promise and callback style', async () => {
  const { storage, runtime } = shimContext().__AK_CHROME__;
  await storage.sync.set({ a: { n: 1 } });
  assert.deepEqual(plain(await storage.sync.get(['a', 'b'])), { a: { n: 1 } });
  await new Promise((resolve) => storage.local.get(['nothing'], (r) => { assert.deepEqual(plain(r), {}); resolve(); }));
  assert.match(runtime.getURL('icons/text.svg'), /^data:image\/svg\+xml/);
  assert.equal(runtime.getURL('icons/unknown.svg'), '');
  assert.doesNotThrow(() => runtime.onMessage.addListener(() => {}));
});

test('GM_xmlhttpRequest: header-less GET → native proxy, headers → fetch, one callback', async () => {
  const proxied = [];
  const fetched = [];
  const ctx = shimContext({
    __ARENAKIT__: { proxyGet: async (url) => { proxied.push(url); return { ok: true }; } },
    fetch: async (url, init) => { fetched.push({ url, init }); return new Response('body', { status: 200 }); },
  });
  const call = (opts) => new Promise((resolve) => ctx.GM_xmlhttpRequest({ ...opts, onload: resolve, onerror: resolve }));

  const plainGet = await call({ method: 'GET', url: 'https://raw.githubusercontent.com/x' });
  assert.equal(plainGet.status, 200);
  assert.deepEqual(proxied, ['https://raw.githubusercontent.com/x']);

  const authed = await call({ method: 'GET', url: 'https://api.github.com/gists/1', headers: { Authorization: 'token t' } });
  assert.equal(authed.status, 200);
  assert.equal(proxied.length, 1, 'a request with headers must not go through the header-less proxy');
  assert.equal(fetched[0].init.headers.Authorization, 'token t');

  // Exactly one callback per request (a success never also fires onerror).
  const seen = [];
  await new Promise((resolve) => {
    ctx.GM_xmlhttpRequest({
      method: 'GET', url: 'https://openrouter.ai/x',
      onload() { seen.push('load'); },
      onerror() { seen.push('error'); },
    });
    setTimeout(resolve, 20);
  });
  assert.deepEqual(seen, ['load']);

  // A proxy rejection reaches onerror with status 0.
  ctx.__ARENAKIT__.proxyGet = async () => { throw new Error('denied'); };
  const failed = await call({ method: 'GET', url: 'https://openrouter.ai/y' });
  assert.equal(failed.status, 0);
});

test('capabilities: the remote arena.ai page stays narrow', () => {
  const remote = JSON.parse(read('src-tauri/capabilities/arena.json'));
  const mobile = JSON.parse(read('src-tauri/capabilities/arena-mobile.json'));
  const dock = JSON.parse(read('src-tauri/capabilities/default.json'));

  for (const cap of [remote, mobile]) {
    assert.deepEqual(cap.remote.urls, ['https://arena.ai/*']);
    assert.ok(!cap.permissions.includes('allow-arena-command'), `${cap.identifier} must not eval into itself`);
    assert.ok(!cap.permissions.some((p) => /^core:(window|webview)/.test(p)), `${cap.identifier} has no window APIs`);
  }
  // Desktop: the dock is its own webview and owns the store; no page script reads
  // it (it holds every saved login session). Mobile embeds the dock in the page,
  // so it legitimately needs it there.
  assert.ok(!remote.permissions.some((p) => /^allow-store-/.test(p)), 'desktop arena page must not reach the store');
  for (const p of ['allow-store-get', 'allow-store-set', 'allow-store-keys']) {
    assert.ok(dock.permissions.includes(p), `dock keeps ${p}`);
    assert.ok(mobile.permissions.includes(p), `embedded dock keeps ${p}`);
  }
  assert.ok(dock.permissions.includes('allow-arena-command'));
  assert.ok(!dock.permissions.some((p) => p.startsWith('http:')), 'the dock uses no HTTP plugin (nothing calls it)');
});

test('every allow-* permission names a command declared in build.rs', () => {
  const declared = new Set([...read('src-tauri/build.rs').matchAll(/"([a-z_]+)"/g)].map((m) => m[1].replace(/_/g, '-')));
  for (const file of ['arena', 'arena-mobile', 'default']) {
    const cap = JSON.parse(read(`src-tauri/capabilities/${file}.json`));
    for (const perm of cap.permissions.filter((p) => p.startsWith('allow-'))) {
      assert.ok(declared.has(perm.slice('allow-'.length)), `${file}.json: ${perm} is not a declared command`);
    }
  }
});

test('Cargo.toml only lists the plugins lib.rs registers', () => {
  const cargo = read('src-tauri/Cargo.toml');
  const lib = read('src-tauri/src/lib.rs');
  const registered = /tauri_plugin_http::/.test(lib);
  assert.equal(/^tauri-plugin-http\b/m.test(cargo), registered, 'tauri-plugin-http must be a dependency iff it is registered');
});

test('manager.js: remote company-rule patterns are vetted, the admin token stays out of storage', () => {
  const src = read('injected/manager.js');
  const body = src.match(/compileRemotePattern\(p\) \{[\s\S]*?\n {8}\}\n/)[0];
  const rules = new Function(`return new (class { ${body} })()`)();
  const ok = (p) => rules.compileRemotePattern(p) instanceof RegExp;

  // Every built-in pattern must survive its own vetting (no false positives).
  const start = src.indexOf('COMPANY_RULES = [');
  const literals = [...src.slice(start, start + 30000).matchAll(/patterns:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/\/((?:[^/\\\n]|\\.)+)\/([gimuy]*)/g)].map((x) => x[0]));
  assert.ok(literals.length > 50, 'expected the built-in rule table');
  for (const l of literals) assert.ok(ok(l), `built-in pattern rejected: ${l}`);

  for (const good of ['/^gpt-\\d+/i', 'claude', '/(gemini|palm)-?\\d/i']) assert.ok(ok(good), good);
  for (const evil of ['/^(a+)+$/', '/(x+x+)+y/', '/(.*a){10}/', '/(a|b)\\1/', '/[', '/' + 'a'.repeat(300) + '/']) {
    assert.ok(!ok(evil), `should be rejected: ${evil.slice(0, 30)}`);
  }

  assert.ok(!/settings\.adminToken\s*=[^=]/.test(src), 'the admin token must not be written into persisted settings');
  assert.match(src, /delete this\.data\.settings\.adminToken/, 'a token saved by an older build is dropped on load');
});
