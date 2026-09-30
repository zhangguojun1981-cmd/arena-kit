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

test('the bundled dock page runs under a restrictive CSP', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const csp = conf.app.security.csp;
  assert.equal(typeof csp, 'string', 'csp must not be null');
  assert.match(csp, /(^|; )default-src 'self'/);
  assert.match(csp, /(^|; )script-src 'self'(;|$)/, 'no inline or remote scripts');
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /connect-src ipc: http:\/\/ipc\.localhost(;|$)/, 'only Tauri IPC, no network from the dock');
  // dock.html must not rely on anything the policy forbids
  const html = read('src/dock.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'no inline event handlers');
});

test('debug hooks require a per-install nonce and write only to private app files', () => {
  const src = read('src-tauri/android/app/src/main/java/com/ati/arenakit/DebugHooks.kt');
  assert.match(src, /SecureRandom\(\)/);
  assert.match(src, /getStringExtra\("nonce"\)/);
  assert.match(src, /getStringExtra\("nonce"\)\s*!=\s*nonce/);
  assert.match(src, /context\.filesDir/);
  assert.doesNotMatch(src, /getExternalFilesDir\(null\)/);
});

test('Cargo.lock is tracked policy, not ignored', () => {
  const ignore = read('.gitignore');
  assert.doesNotMatch(ignore, /^Cargo\.lock\s*$/m);
});

test('second-audit Rust hardening is implemented and events are dock-targeted', () => {
  const lib = read('src-tauri/src/lib.rs');
  const store = read('src-tauri/src/store.rs');
  const menu = read('src-tauri/src/menu.rs');
  assert.match(lib, /TRACE_MAX_INFLIGHT:\s*usize\s*=\s*8/);
  assert.match(lib, /read_capped_to\(r,\s*4\s*\*\s*1024\s*\*\s*1024\)/);
  assert.match(lib, /vet_gist_body\(&mut b\)/);
  assert.match(store, /STORE_MAX_VALUE_BYTES:\s*usize\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(lib, /emit_to\(tauri::EventTarget::labeled\(dock_label\(\)\)/);
  assert.match(menu, /emit_to\([\s\S]*EventTarget::labeled\(crate::dock_label\(\)\)/);
  assert.doesNotMatch(lib, /app\.emit\("arenakit:\/\/(?:trace|page)"/);
});

test('watchdog reload protects human drafts and unlock reports rewrite hits', () => {
  const dock = read('src/dock.js');
  const unlock = read('injected/unlock.js');
  assert.match(dock, /source === 'watchdog'[\s\S]*rpc\.call\('precheck'\)[\s\S]*pre\?\.hasDraft[\s\S]*return false/);
  assert.match(unlock, /send\('unlock-report',\{hits:rewriteHits/);
  assert.match(dock, /onPage\('unlock-report'/);
});

test('both page capabilities grant the Gist commands and nothing wider', () => {
  for (const f of ['arena', 'arena-mobile']) {
    const cap = JSON.parse(read(`src-tauri/capabilities/${f}.json`));
    for (const p of ['allow-gist-request', 'allow-gist-token-set', 'allow-gist-token-status']) {
      assert.ok(cap.permissions.includes(p), `${f} has ${p}`);
    }
  }
  const dock = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.ok(!dock.permissions.some((p) => p.startsWith('allow-gist-')), 'the dock has no use for the Gist token');
});

// ── second-opinion audit (docs/AUDIT-2.md) ──────────────────────────────

test('desktop arena.json grants the page no event subscription and no login_set', () => {
  // On desktop the dock is its own webview: nothing in the page ever calls
  // listen(), and only the dock starts a re-login. Mobile embeds the dock in
  // the page and legitimately keeps both.
  const remote = JSON.parse(read('src-tauri/capabilities/arena.json'));
  const mobile = JSON.parse(read('src-tauri/capabilities/arena-mobile.json'));
  const dock = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.ok(!remote.permissions.some((p) => p.startsWith('core:event:')), 'desktop page: no core:event:*');
  assert.ok(!remote.permissions.includes('allow-login-set'), 'desktop page: no login_set');
  assert.ok(remote.permissions.includes('allow-login-clear'), 'account.js ends a re-login from the page');
  assert.ok(dock.permissions.includes('allow-login-set'), 'the dock starts re-logins');
  for (const p of ['core:event:allow-listen', 'allow-login-set', 'allow-store-get']) {
    assert.ok(mobile.permissions.includes(p), `embedded dock keeps ${p}`);
  }
  // No page script subscribes to Tauri events (the grant would be dead weight
  // on desktop and is what makes removing it safe).
  for (const f of ['bridge', 'snoop', 'monitor', 'pulse', 'unlock', 'eni', 'conversation-rename', 'probe', 'watchdog', 'links', 'account', 'gm-shim', 'manager', 'plus']) {
    const src = read(`injected/${f}.js`);
    assert.ok(!/\.event\.listen\(|plugin:event\|listen|__TAURI__\.event/.test(src), `${f}.js does not listen to Tauri events`);
  }
});

test('manager.js: remote config strings are plain text and icons are escaped at the innerHTML sink', () => {
  const src = read('injected/manager.js');
  const method = (name) => src.match(new RegExp(`\\n {8}${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {8}\\}\\n`))[0];
  const dm = new Function(`return new (class { ${method('plainRemoteText')} })()`)();
  assert.equal(dm.plainRemoteText(' Anthropic ', 64), 'Anthropic');
  assert.equal(dm.plainRemoteText('🅰️', 8), '🅰️');
  for (const bad of ['<img src=x onerror=alert(1)>', 'a"b', "a'b", 'a&b', 'x'.repeat(65), 42, null, undefined, 'tab\there']) {
    assert.equal(dm.plainRemoteText(bad, 64), '', `rejected: ${String(bad).slice(0, 20)}`);
  }
  // loadRemoteConfig vets both strings and drops rules without a company.
  const load = src.slice(src.indexOf('async loadRemoteConfig()'), src.indexOf('async loadRemoteConfig()') + 2500);
  assert.match(load, /company: this\.plainRemoteText\(r && r\.company, 64\)/);
  assert.match(load, /icon: this\.plainRemoteText\(r && r\.icon, 8\) \|\| '❔'/);
  assert.match(load, /\.filter\(r => r\.company\)/);

  // getOrgLogoHtml (innerHTML sink for rule / model icons) escapes what it returns.
  const ui = new Function(`
    const COMPANY_RULES = [{ company: 'Evil', icon: '<img src=x onerror=alert(1)>', patterns: [] }, { company: 'OpenAI', icon: '🤖', patterns: [] }];
    return new (class {
      constructor() { this.logoCache = { OpenAI: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }; }
      ${method('esc')}
      sanitizeSvg() { return ''; }
      ${method('getOrgLogoHtml')}
    })()`)();
  assert.equal(ui.getOrgLogoHtml('Evil'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(ui.getOrgLogoHtml('Nobody', '<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(ui.getOrgLogoHtml('Nobody', 42), '42', 'esc() copes with non-string icons');
  assert.equal(ui.getOrgLogoHtml('Nobody', null), '', 'null icon renders nothing, not "null"');
  assert.equal(ui.getOrgLogoHtml('OpenAI'), '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" class="lmm-org-icon" alt="OpenAI">');

  // The recommended-config diff modal and the group topbar escape names too.
  const diff = src.slice(src.indexOf('showDiffModal(diff, remote) {'), src.indexOf('showDiffModal(diff, remote) {') + 6000);
  assert.match(diff, /arr\.slice\(0, max\)\.map\(x => this\.esc\(String\(x\)\)\)/);
  assert.ok(!/diff\.groups\.(added|modified)\.join\(/.test(diff), 'group names go through trunc()/esc');
  assert.match(src, /data-mode="group_\$\{this\.esc\(name\)\}"/);
});
