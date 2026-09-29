#!/usr/bin/env node
// Sets android:allowBackup="false" on the generated Android manifest.
// `tauri android init` regenerates src-tauri/gen/android each build, so the
// setting cannot be committed; CI runs this after init. Without it `adb backup`
// / cloud backup could copy the app's private data (saved logins, cookies).
// Usage: node scripts/patch-android-manifest.mjs <AndroidManifest.xml>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Returns the manifest text with allowBackup forced to "false". Throws if there is no <application>. */
export function disableBackup(xml) {
  const tag = /<application\b[^>]*>/.exec(xml);
  if (!tag) throw new Error('no <application> element in the manifest');
  const attr = /\sandroid:allowBackup\s*=\s*("[^"]*"|'[^']*')/;
  const patched = attr.test(tag[0])
    ? tag[0].replace(attr, ' android:allowBackup="false"')
    : tag[0].replace(/<application\b/, '<application android:allowBackup="false"');
  return xml.slice(0, tag.index) + patched + xml.slice(tag.index + tag[0].length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: patch-android-manifest.mjs <AndroidManifest.xml>'); process.exit(2); }
  const out = disableBackup(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, out);
  if (!/<application\b[^>]*android:allowBackup="false"/.test(out)) { console.error('patch did not apply'); process.exit(1); }
  console.log(`patched ${file}: android:allowBackup="false"`);
}
