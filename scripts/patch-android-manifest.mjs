#!/usr/bin/env node
// Sets android:allowBackup="false" on the generated Android manifest.
// `tauri android init` regenerates src-tauri/gen/android each build, so the
// setting cannot be committed; CI runs this after init. Without it `adb backup`
// / cloud backup could copy the app's private data (saved logins, cookies).
// With --debug it also adds <meta-data android:name="arenakit.debug" .../> so
// MainActivity turns on WebView remote debugging + the DEBUG_EVAL broadcast
// (test builds only; CI does this for the android_debug dispatch input).
// Usage: node scripts/patch-android-manifest.mjs [--debug] <AndroidManifest.xml>
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

const DEBUG_META = '<meta-data android:name="arenakit.debug" android:value="true" />';

/** Adds the debug marker as the first child of <application> (idempotent). */
export function addDebugMarker(xml) {
  if (xml.includes('android:name="arenakit.debug"')) return xml;
  const tag = /<application\b[^>]*?(\/?)>/.exec(xml);
  if (!tag) throw new Error('no <application> element in the manifest');
  if (tag[1] === '/') { // <application ... /> → give it a body
    return xml.slice(0, tag.index) + tag[0].replace(/\s*\/>$/, '>') + DEBUG_META + '</application>' + xml.slice(tag.index + tag[0].length);
  }
  return xml.slice(0, tag.index + tag[0].length) + DEBUG_META + xml.slice(tag.index + tag[0].length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const debug = args.includes('--debug');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: patch-android-manifest.mjs [--debug] <AndroidManifest.xml>'); process.exit(2); }
  if (debug) {
    fs.writeFileSync(file, addDebugMarker(fs.readFileSync(file, 'utf8')));
    console.log(`patched ${file}: arenakit.debug marker`);
    process.exit(0);
  }
  const out = disableBackup(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, out);
  if (!/<application\b[^>]*android:allowBackup="false"/.test(out)) { console.error('patch did not apply'); process.exit(1); }
  console.log(`patched ${file}: android:allowBackup="false"`);
}
