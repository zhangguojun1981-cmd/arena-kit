package com.ati.arenakit

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * ArenaKit's activity. Replaces the Tauri template's MainActivity (copied over
 * `gen/android` by CI, see .github/workflows/build.yml → "Apply Android overlay").
 *
 * Tauri enables edge-to-edge, which on Android 15+ is mandatory anyway: the
 * WebView then draws under the status bar and the gesture bar. arena.ai does
 * not use `env(safe-area-inset-*)`, so its header collided with the clock.
 * We keep edge-to-edge (system bars stay translucent) but pad the content
 * root by the system-bar / display-cutout / keyboard insets, so the page
 * always starts below the status bar and ends above the navigation bar.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    applyChrome(content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyChrome(findViewById(android.R.id.content))
  }

  /** Background behind the insets + status-bar icon contrast follow the OS theme. */
  private fun applyChrome(content: View) {
    val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    // Same tokens as src/theme.css (--bg light / dark).
    content.setBackgroundColor(Color.parseColor(if (dark) "#0b0c0f" else "#f5f6f8"))
    val controller = WindowCompat.getInsetsController(window, content)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
  }
}
