import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/* src-tauri/android/ is copied over the generated gen/android/ project in CI.
 * Guard the bits that would silently break that overlay. */
const root = resolve(new URL('..', import.meta.url).pathname);
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const pkgPath = conf.identifier.split('.').join('/');
const mainActivity = resolve(root, `src-tauri/android/app/src/main/java/${pkgPath}/MainActivity.kt`);

test('MainActivity overlay sits at the path tauri android init generates for the app identifier', () => {
  assert.ok(existsSync(mainActivity), mainActivity);
  const src = readFileSync(mainActivity, 'utf8');
  assert.match(src, new RegExp(`^package ${conf.identifier.replace(/\./g, '\\.')}\\s*$`, 'm'));
  assert.match(src, /class MainActivity : TauriActivity\(\)/);
});

test('MainActivity pads the content frame by system-bar and IME insets (page flush with the status bar)', () => {
  const src = readFileSync(mainActivity, 'utf8');
  assert.match(src, /setOnApplyWindowInsetsListener\(content\)/);
  assert.match(src, /Type\.systemBars\(\)/);
  assert.match(src, /Type\.ime\(\)/);
  assert.match(src, /setPadding\(bars\.left, bars\.top, bars\.right, maxOf\(bars\.bottom, ime\.bottom\)\)/);
});

test('MainActivity hosts the in-app link tab: page bridge + back handler wired in onWebViewCreate', () => {
  const src = readFileSync(mainActivity, 'utf8');
  assert.match(src, /override fun onWebViewCreate\(webView: WebView\)/);
  assert.match(src, /super\.onWebViewCreate\(webView\)/, 'Tauri plugin manager still sees the webview');
  assert.match(src, /WebViewCompat\.addWebMessageListener\(/);
  assert.match(src, /"https:\/\/arena\.ai"/, 'message channel restricted to arena.ai');
  assert.match(src, /addJavascriptInterface\(LegacyBridge/, 'fallback for WebViews without WebMessageListener');
  assert.match(src, /BRIDGE_NAME = "ArenaKitAndroid"/, 'the object injected/links.js posts to');
  assert.match(src, /onBackPressedDispatcher\.addCallback\(this, backCallback\)/);
  assert.match(src, /__ARENAKIT_EMBED__/, 'back key reaches the embedded dock (sheet / menu / dialog)');
  assert.match(src, /__ARENAKIT_LINKS__&&window\.__ARENAKIT_LINKS__\.setOpen/, 'tab state mirrored to the page');
  for (const cmd of ['"openTab"', '"closeTab"', '"external"']) assert.ok(src.includes(cmd), cmd);
  const tab = readFileSync(resolve(root, `src-tauri/android/app/src/main/java/${pkgPath}/LinkTab.kt`), 'utf8');
  assert.match(tab, new RegExp(`^package ${conf.identifier.replace(/\./g, '\\.')}\\s*$`, 'm'));
  assert.match(tab, /class LinkTab\(/);
  assert.match(tab, /object ExternalLinks/);
  assert.match(tab, /activity\.addContentView\(/, 'layered over the Wry webview inside the padded content frame');
  assert.match(tab, /setSupportMultipleWindows\(false\)/);
  assert.match(tab, /allowFileAccess = false/);
  for (const label of ['在浏览器中打开', '复制链接', '分享链接', '关闭标签页', '刷新标签页']) assert.ok(tab.includes(label), label);
  // the page-side interceptor + the Rust navigation net exist and agree on the bridge name / API
  const links = readFileSync(resolve(root, 'injected/links.js'), 'utf8');
  assert.ok(links.includes('window.ArenaKitAndroid'));
  assert.ok(links.includes("cmd: 'openTab'") && links.includes("cmd: 'external'") && links.includes("cmd: 'closeTab'"));
  const rs = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
  assert.ok(rs.includes('.on_navigation(move |url| route_navigation(&nav_app, url))'));
  assert.ok(rs.includes('window.__ARENAKIT_LINKS__&&window.__ARENAKIT_LINKS__.{}({})'));
  assert.ok(readFileSync(resolve(root, 'src-tauri/build.rs'), 'utf8').includes('"open_tab"'));
  for (const cap of ['arena.json', 'arena-mobile.json']) {
    assert.ok(JSON.parse(readFileSync(resolve(root, `src-tauri/capabilities/${cap}`), 'utf8')).permissions.includes('allow-open-tab'), cap);
  }
});

test('build.yml applies the overlay after android init and before the build', () => {
  const yml = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
  const init = yml.indexOf('cargo tauri android init');
  const overlay = yml.indexOf('cp -Rv src-tauri/android/. src-tauri/gen/android/');
  const build = yml.indexOf('cargo tauri android build');
  assert.ok(init > 0 && overlay > init && build > overlay, 'init → overlay → build');
});

test('adaptive launcher icon overlay is complete (API 26+ uses it instead of the generated PNGs)', () => {
  const res = resolve(root, 'src-tauri/android/app/src/main/res');
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const xml = readFileSync(resolve(res, `mipmap-anydpi-v26/${name}.xml`), 'utf8');
    for (const ref of xml.matchAll(/@drawable\/([a-z_]+)/g)) {
      assert.ok(existsSync(resolve(res, `drawable/${ref[1]}.xml`)), `${name} → drawable/${ref[1]}.xml`);
      assert.ok(ref[1].startsWith('ak_'), 'ak_ prefix avoids clashing with the template/tauri-icon ic_launcher_* drawables');
    }
  }
  // the adaptive-icon drawables are generated from the same lettermark geometry as the desktop icons
  const fg = readFileSync(resolve(res, 'drawable/ak_launcher_foreground.xml'), 'utf8');
  assert.match(fg, /GENERATED by scripts\/make-icons\.py/);
  assert.match(fg, /android:fillColor="#FFFFFF"/, 'white AK monogram');
  assert.ok((fg.match(/ Z/g) || []).length >= 5, 'A left leg + shared stem + crossbar + two K arms');
  const bg = readFileSync(resolve(res, 'drawable/ak_launcher_background.xml'), 'utf8');
  assert.match(bg, /startColor="#3B78FF"/);
  const svg = readFileSync(resolve(root, 'src-tauri/icons/icon.svg'), 'utf8');
  const dock = readFileSync(resolve(root, 'src/dock.html'), 'utf8');
  const d = /<path fill="#FFFFFF" d="([^"]+)"/.exec(svg)[1];
  assert.ok(dock.includes(`d="${d}"`), 'dock header logo uses the same lettermark path as the icon set');
  // desktop icon set is the rendered artwork, not the old flat placeholder
  const png = readFileSync(resolve(root, 'src-tauri/icons/icon.png'));
  assert.ok(png.length > 20_000, 'icon.png is a real rendering (the placeholder was 2.5 KB)');
  assert.equal(readFileSync(resolve(root, 'src-tauri/icons/icon.icns')).subarray(0, 4).toString(), 'icns');
});
