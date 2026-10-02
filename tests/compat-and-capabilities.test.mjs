// Regression tests for the 0.5.0 audit (docs/AUDIT.md):
//  * The remote arena.ai capability stays narrow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { read } from './helpers.mjs';

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

test('watchdog reload protects human drafts', () => {
  const dock = read('src/dock.js');
  assert.match(dock, /source === 'watchdog'[\s\S]*rpc\.call\('precheck'\)[\s\S]*pre\?\.hasDraft[\s\S]*return false/);
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
  for (const f of ['bridge', 'snoop', 'monitor', 'pulse', 'eni', 'conversation-rename', 'probe', 'watchdog', 'links', 'account']) {
    const src = read(`injected/${f}.js`);
    assert.ok(!/\.event\.listen\(|plugin:event\|listen|__TAURI__\.event/.test(src), `${f}.js does not listen to Tauri events`);
  }
});
