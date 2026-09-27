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

test('build.yml applies the overlay after android init and before the build', () => {
  const yml = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
  const init = yml.indexOf('cargo tauri android init');
  const overlay = yml.indexOf('cp -Rv src-tauri/android/. src-tauri/gen/android/');
  const build = yml.indexOf('cargo tauri android build');
  assert.ok(init > 0 && overlay > init && build > overlay, 'init → overlay → build');
});
