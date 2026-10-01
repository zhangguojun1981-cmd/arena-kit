import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enableMinify } from '../scripts/patch-android-gradle.mjs';

// A trimmed stand-in for the Tauri template's release buildType block.
const TEMPLATE = `android {
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }.files.toTypedArray()
            )
        }
    }
}
`;

test('isMinifyEnabled = true is inserted into the release block', () => {
  const out = enableMinify(TEMPLATE);
  assert.match(out, /getByName\("release"\)\s*\{\s*\n\s*isMinifyEnabled = true/);
  // exactly one release-side minify flag added (the debug false stays)
  assert.equal(out.match(/isMinifyEnabled = true/g).length, 1);
  // the optimization block and proguardFiles are preserved
  assert.match(out, /optimization\s*\{\s*\n\s*enable = true/);
  assert.match(out, /proguardFiles\(/);
});

test('enableMinify is idempotent', () => {
  const once = enableMinify(TEMPLATE);
  assert.equal(enableMinify(once), once);
});

test('the debug buildType false flag is never flipped', () => {
  const out = enableMinify(TEMPLATE);
  assert.match(out, /getByName\("debug"\)\s*\{\s*\n\s*isMinifyEnabled = false/);
});

test('a build.gradle.kts without a release block fails loudly', () => {
  assert.throws(
    () => enableMinify('android { buildTypes { getByName("debug") {} } }'),
    /no getByName\("release"\)/,
  );
});

test('CI patches the gradle after the overlay copy and before the android build', () => {
  const yml = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const overlay = yml.indexOf('cp -Rv src-tauri/android/.');
  const patch = yml.indexOf('scripts/patch-android-gradle.mjs');
  const build = yml.indexOf('cargo tauri android build');
  assert.ok(overlay > 0 && patch > overlay, 'gradle patch must run after the overlay copy');
  assert.ok(patch < build, 'and before the android build');
});

test('the R8 keep rules overlay covers our JS bridges and native entry points', () => {
  const pro = readFileSync(new URL('../src-tauri/android/app/proguard-rules.pro', import.meta.url), 'utf8');
  assert.match(pro, /@android\.webkit\.JavascriptInterface <methods>;/);
  assert.match(pro, /-keep class com\.ati\.arenakit\.MainActivity \{/);
  assert.match(pro, /-keep class com\.ati\.arenakit\.MainActivity\$\* \{/);
  assert.match(pro, /-keep class com\.ati\.arenakit\.DebugHooks \{/);
  assert.match(pro, /native <methods>;/);
});
