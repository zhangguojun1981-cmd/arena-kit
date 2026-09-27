package com.ati.arenakit

/*
 * Overlay for the file `cargo tauri android init` generates at
 * gen/android/app/src/main/java/com/ati/arenakit/MainActivity.kt.
 * CI copies src-tauri/android/ over gen/android/ right after init
 * (see .github/workflows/build.yml), so this is what actually ships.
 *
 * Why: Tauri's template calls enableEdgeToEdge() and nothing else, so the
 * arena.ai page was laid out UNDER the status bar (and behind the keyboard).
 * The reference app (arena-trace-android, targetSdk 34, plain FrameLayout)
 * starts flush with the bottom of the status bar. Android 15+ enforces
 * edge-to-edge for targetSdk ≥ 35 (Tauri targets 37) so opting out is not an
 * option; instead we keep edge-to-edge and pad the activity's content frame
 * by the system-bar / cutout / IME insets ourselves — same visual result:
 * page top == status-bar bottom, page bottom == navigation-bar top, and the
 * page shrinks above the keyboard instead of being covered by it.
 */

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Legacy soft-input mode: harmless on API 30+ (insets drive the layout
    // there) and required below it so the IME inset is reported at all.
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
    applySystemBarStyle()
  }

  // The manifest declares configChanges=…|uiMode, so a light/dark switch does
  // not recreate the activity; restyle the bars in place instead.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBarStyle()
  }

  /** Solid bar backgrounds following the system light/dark setting (DayNight, like the reference app). */
  private fun applySystemBarStyle() {
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES
    val background = if (night) Color.parseColor("#0F1115") else Color.WHITE
    window.decorView.setBackgroundColor(background)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = !night
    controller.isAppearanceLightNavigationBars = !night
  }
}
