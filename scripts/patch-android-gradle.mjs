#!/usr/bin/env node
// Forces R8 code shrinking on the generated Android release buildType.
//
// `tauri android init` regenerates src-tauri/gen/android every build and the
// file is not committed, so this cannot live in the project; CI runs it after
// the overlay copy (see .github/workflows/build.yml). The Tauri template's
// release block only carries `optimization { enable = true }` (R8 *optimise*
// pass) — this adds the explicit, AGP-version-stable `isMinifyEnabled = true`
// so R8 actually removes/renames unused classes and methods. Keep rules for
// our JS bridges live in app/proguard-rules.pro (picked up by the template's
// release `proguardFiles(**/*.pro)`), and Wry's JNI classes are kept by its
// generated proguard-wry.pro.
//
// Resource shrinking (isShrinkResources) is deliberately NOT enabled: the web
// payload is embedded on the Rust side, so there is nothing to gain in the
// tiny Android res/, and it risks dropping the adaptive launcher icon.
//
// Usage: node scripts/patch-android-gradle.mjs <app/build.gradle.kts>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Returns the gradle text with `isMinifyEnabled = true` as the first statement
 * inside the release buildType. Idempotent. Throws if no release block exists.
 */
export function enableMinify(text) {
  if (/getByName\("release"\)\s*\{[^]*?isMinifyEnabled\s*=\s*true/.test(text)) {
    return text; // already on
  }
  const marker = /getByName\("release"\)\s*\{/.exec(text);
  if (!marker) throw new Error('no getByName("release") buildType block in build.gradle.kts');
  const at = marker.index + marker[0].length;
  const indent = '\n            ';
  return text.slice(0, at) + indent + 'isMinifyEnabled = true' + text.slice(at);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/patch-android-gradle.mjs <app/build.gradle.kts>');
    process.exit(2);
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = enableMinify(before);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`patched ${file}: isMinifyEnabled = true (R8 shrinking)`);
  } else {
    console.log(`${file}: R8 shrinking already enabled`);
  }
}
