import test from 'node:test';
import assert from 'node:assert/strict';
import { disableBackup, addDebugMarker } from '../scripts/patch-android-manifest.mjs';

const app = (out) => /<application\b[^>]*>/.exec(out)[0];

test('allowBackup is inserted when the manifest does not mention it', () => {
  const out = disableBackup('<manifest>\n  <application android:label="A" android:theme="@style/T">\n  <activity/></application></manifest>');
  assert.match(app(out), /android:allowBackup="false"/);
  assert.match(app(out), /android:label="A"/);
  assert.equal(out.match(/allowBackup/g).length, 1);
});

test('an existing allowBackup="true" is replaced, not duplicated', () => {
  const out = disableBackup('<manifest><application android:allowBackup="true" android:label="A"></application></manifest>');
  assert.equal(out.match(/allowBackup/g).length, 1);
  assert.match(app(out), /android:allowBackup="false"/);
});

test('a bare <application> and a self-closing one both work; a missing one fails', () => {
  assert.match(app(disableBackup('<manifest><application></application></manifest>')), /allowBackup="false"/);
  assert.match(app(disableBackup('<manifest><application/></manifest>')), /allowBackup="false"/);
  assert.throws(() => disableBackup('<manifest></manifest>'), /no <application>/);
});

test('CI runs the patch right after tauri android init', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const init = yml.indexOf('cargo tauri android init');
  const patch = yml.indexOf('scripts/patch-android-manifest.mjs');
  assert.ok(init > 0 && patch > init, 'patch step must come after init');
  assert.ok(patch < yml.indexOf('cargo tauri android build'), 'and before the build');
});

test('the debug marker is added once, inside <application>, for open and self-closing tags', () => {
  const a = addDebugMarker('<manifest><application android:label="A"><activity/></application></manifest>');
  assert.equal(a.match(/arenakit\.debug/g).length, 1);
  assert.ok(a.indexOf('arenakit.debug') > a.indexOf('<application') && a.indexOf('arenakit.debug') < a.indexOf('<activity'));
  assert.equal(addDebugMarker(a), a, 'idempotent');
  const b = addDebugMarker('<manifest><application android:label="A" /></manifest>');
  assert.match(b, /<application android:label="A">.*arenakit\.debug.*<\/application>/);
  assert.throws(() => addDebugMarker('<manifest/>'), /no <application>/);
});

test('the debug build never leaves the real-build path: own tag, no pruning, no dmg', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.match(yml, /tag="debug-android"/);
  assert.match(yml, /tags: \["build-\*", "debug-\*"\]/);
  assert.match(yml, /macos-dmg:[\s\S]*?startsWith\(github\.ref, 'refs\/tags\/build-'\)/, 'a debug-* tag must not build dmgs');
  assert.match(yml, /if \[ "\$DEBUG_BUILD" != "true" \]; then\n\s+gh release list/);
  assert.match(yml, /macos-dmg:[\s\S]*?!inputs\.android_debug/);
});
