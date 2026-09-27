#!/usr/bin/env node
/* Syntax gate for the frontend + injected scripts (no bundler, no Rust needed).
 *
 *  - injected/*.js and src/hud.js are CLASSIC scripts that Rust concatenates
 *    into one WebView init script. We parse each one with `new vm.Script()`
 *    (sloppy mode, exactly like the WebView) and then parse the assembled
 *    bundle using the same wrapper shape as `build_init_script` in
 *    src-tauri/src/lib.rs, so a stray brace can never ship.
 *  - src/*.js ESM files are parsed with `node --check`.
 *  - JSON config (tauri.conf.json, capabilities) must parse.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import vm from 'node:vm';

const root = resolve(new URL('..', import.meta.url).pathname);
const rel = (p) => p.replace(root + '/', '');
let failures = 0;
const ok = (msg) => console.log('  ✓ ' + msg);
const bad = (msg, err) => {
  failures++;
  console.error('  ✗ ' + msg + (err ? '\n    ' + String(err.message || err).split('\n')[0] : ''));
};

function classic(path) {
  const src = readFileSync(path, 'utf8');
  try {
    new vm.Script(src, { filename: rel(path) });
    ok(rel(path));
  } catch (e) {
    bad(rel(path), e);
  }
  return src;
}

console.log('classic scripts');
const injectedDir = join(root, 'injected');
const injected = readdirSync(injectedDir).filter((f) => f.endsWith('.js')).sort();
const sources = {};
for (const f of injected) sources[f] = classic(join(injectedDir, f));
sources['hud.js'] = classic(join(root, 'src', 'hud.js'));

// Mirror of lib.rs::wrap(name, src) — keep in sync.
const wrap = (name, src) =>
  `;(function(){try{if(!(window.__ARENAKIT__&&window.__ARENAKIT__.moduleOn(${JSON.stringify(name)})))return;var chrome=window.__AK_CHROME__||window.chrome;\n${src}\n}catch(e){console.warn('[ArenaKit] ${name} failed',e);}})();\n`;

console.log('assembled init bundle');
{
  const css = readFileSync(join(root, 'src', 'hud.css'), 'utf8');
  // Mirror of lib.rs::build_init_script — the whole bundle is guarded to
  // arena.ai hosts because the same webview also shows the bundled shell.
  let bundle = "(function(){if(!/(^|\\.)(arena|lmarena)\\.ai$/.test(location.hostname))return;\n";
  bundle += `window.__ARENAKIT_ENV__=${JSON.stringify({ platform: 'test', version: '0.0.0', mobile: false })};\n`;
  bundle += `window.__ARENAKIT_HUD_CSS__=${JSON.stringify(css)};\n`;
  bundle += sources['bootstrap.js'] + '\n;';
  bundle += sources['gm-shim.js'] + '\n;';
  bundle += sources['snoop.js'] + '\n;';
  bundle += wrap('unlock', sources['unlock.js']);
  bundle += wrap('eni', sources['eni.js']);
  bundle += '(function(){var run=function(){\n';
  bundle += wrap('manager', sources['manager.js']);
  bundle += wrap('plus', sources['plus.js']);
  bundle += wrap('leaderboard', sources['leaderboard.js']);
  bundle += wrap('hud', sources['hud.js']);
  bundle += "};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();\n";
  bundle += '})();\n';
  try {
    new vm.Script(bundle, { filename: 'init-bundle.js' });
    ok(`bundle parses (${(bundle.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    bad('bundle', e);
  }
}

console.log('ES modules');
for (const f of ['src/shell.js', 'src/dock.js', 'src/lib/format.js']) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    bad(f, e.stderr?.toString() || e);
  }
}

console.log('JSON');
for (const f of ['src-tauri/tauri.conf.json', 'src-tauri/capabilities/default.json', 'src-tauri/capabilities/arena.json', 'package.json']) {
  try {
    JSON.parse(readFileSync(join(root, f), 'utf8'));
    ok(f);
  } catch (e) {
    bad(f, e);
  }
}

console.log('HTML references');
for (const html of ['src/shell.html', 'src/index.html']) {
  const text = readFileSync(join(root, html), 'utf8');
  const refs = [...text.matchAll(/(?:src|href)="([^"?#]+)/g)].map((m) => m[1]).filter((r) => !/^https?:/.test(r));
  for (const r of refs) {
    try {
      readFileSync(join(root, 'src', r));
    } catch {
      bad(`${html} → missing ${r}`);
    }
  }
  ok(`${html} (${refs.length} local refs)`);
}

if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
