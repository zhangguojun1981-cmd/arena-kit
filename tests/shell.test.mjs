// Wiring checks for the shell: every element id the controllers touch exists
// in shell.html, and every IPC command is declared consistently in build.rs
// (ACL permissions), lib.rs (handler) and the capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = read('src/shell.html');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

function idsUsedBy(src) {
  return new Set([...src.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
}

test('shell.html has every id dock.js and shell.js address', () => {
  for (const file of ['src/dock.js', 'src/shell.js']) {
    const used = idsUsedBy(read(file));
    const missing = [...used].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `${file} uses ids missing from shell.html`);
  }
  // Controls addressed by attribute selectors.
  for (const sel of ['data-action="manager"', 'data-action="save-eni"', 'data-unlock="opus"', 'data-unlock="hidden"', 'data-module="plus"', 'data-module="leaderboard"', 'data-module="hud"']) {
    assert.ok(html.includes(sel), `missing ${sel}`);
  }
});

test('shell.html declares the layout constants the Rust side assumes', () => {
  const css = read('src/shell.css');
  assert.match(css, /\.topbar\s*\{[^}]*height:\s*44px/s, 'top bar must be 44px (TOPBAR_H)');
  assert.match(css, /\.dock-col\s*\{[^}]*width:\s*340px/s, 'dock column must be 340px (DOCK_W)');
  const rs = read('src-tauri/src/lib.rs');
  assert.match(rs, /const TOPBAR_H: f64 = 44\.0;/);
  assert.match(rs, /const DOCK_W: f64 = 340\.0;/);
});

test('IPC commands are declared consistently (build.rs, handler, capabilities)', () => {
  const build = read('src-tauri/build.rs');
  const declared = [...build.matchAll(/^\s*"([a-z_]+)",\s*$/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 14, 'build.rs COMMANDS list');

  const rs = read('src-tauri/src/lib.rs');
  const handler = rs.match(/generate_handler!\[([\s\S]*?)\]/)[1];
  const registered = handler
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual([...registered].sort(), [...declared].sort(), 'generate_handler! must match build.rs COMMANDS');

  for (const cmd of declared) {
    assert.match(rs, new RegExp(`#\\[tauri::command\\]\\s*(pub\\s+)?(async\\s+)?fn ${cmd}\\b`), `${cmd} must be a #[tauri::command]`);
  }

  const dash = (c) => 'allow-' + c.replace(/_/g, '-');
  const def = JSON.parse(read('src-tauri/capabilities/default.json'));
  const arena = JSON.parse(read('src-tauri/capabilities/arena.json'));
  for (const cmd of declared) {
    assert.ok(def.permissions.includes(dash(cmd)), `default.json must allow ${cmd} for the shell`);
  }
  // The remote page never gets the shell-only commands.
  for (const secret of ['arena_command', 'save_account', 'delete_account', 'open_tab', 'close_tab', 'activate_tab', 'pick_account', 'probe_proxy', 'list_accounts', 'list_tabs']) {
    assert.ok(!arena.permissions.includes(dash(secret)), `arena.json must not allow ${secret}`);
  }
  assert.deepEqual(arena.webviews, ['arena-*', 'main']);
  assert.ok(def.local === true && arena.local === false);
});

test('mobile home and desktop home are both present and gated by data-mode', () => {
  assert.ok(ids.has('m-home') && ids.has('home') && ids.has('m-open'));
  const css = read('src/shell.css');
  assert.match(css, /\.shell\[data-mode="mobile"\] \.topbar/);
  assert.match(css, /\.shell\[data-view="dock"\] \.stage/);
});

test('dock.js keeps its browser preview path (no Tauri runtime)', () => {
  const dock = read('src/dock.js');
  assert.match(dock, /\nfunction preview\(\) \{/, 'preview() must exist — the gallery and npm run preview depend on it');
  assert.ok(dock.trimEnd().endsWith('boot();'), 'boot() must be the last statement');
  assert.ok(dock.indexOf('function preview()') < dock.lastIndexOf('boot();'));
});
