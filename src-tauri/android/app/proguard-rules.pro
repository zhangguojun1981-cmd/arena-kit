# ArenaKit R8 keep rules (overlay).
#
# The Tauri release buildType runs R8 code shrinking
# (`optimization { enable = true }` in app/build.gradle.kts), and the Android
# test APK is built from that release profile, so these rules ship in every
# APK. gen/android is regenerated each build and is not committed; CI copies
# src-tauri/android/ over it (see .github/workflows/build.yml), and the
# template's release proguardFiles pulls in every **/*.pro under the app
# module — including this file and Wry's generated proguard-wry.pro.
#
# Wry's generated proguard-wry.pro already keeps the Wry/Rust JNI classes
# (RustWebView, Ipc, WryActivity, …). The rules below cover OUR overlay only:
# the page bridges reached from JavaScript by name, which R8 would otherwise
# rename or remove — the APK would still build but the link tab and the
# debug-eval channel would break at runtime.

# Any method annotated @JavascriptInterface is invoked from JS by its exact
# name; never rename or strip these (the default Android rules do NOT keep
# them). Covers MainActivity.LegacyBridge.postMessage (the ArenaKitAndroid
# link-tab bridge) and DebugHooks.Sink.done (the __akdbg DEBUG_EVAL sink).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The overlay activity (referenced from the manifest) and its inner classes,
# including the JS bridge. Keeping it whole is cheap (one class) and keeps the
# Wry lifecycle overrides (onWebViewCreate, back handling) intact.
-keep class com.ati.arenakit.MainActivity { *; }
-keep class com.ati.arenakit.MainActivity$* { *; }

# Test-build-only hooks: the DEBUG_EVAL broadcast receiver and the __akdbg
# sink. Present in debug test builds; harmless to keep in any build.
-keep class com.ati.arenakit.DebugHooks { *; }
-keep class com.ati.arenakit.DebugHooks$* { *; }

# Belt-and-suspenders for any JNI native entry points declared in our code
# (Wry's own natives are already covered by proguard-wry.pro).
-keepclasseswithmembernames class * {
    native <methods>;
}
