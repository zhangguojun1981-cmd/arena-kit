import test from 'node:test';
import assert from 'node:assert/strict';
import { disableBackup } from '../scripts/patch-android-manifest.mjs';

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
