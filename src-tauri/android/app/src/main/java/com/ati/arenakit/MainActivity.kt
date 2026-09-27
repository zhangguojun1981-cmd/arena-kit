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
 *
 * It also hosts the in-app link tab (LinkTab.kt, port of the reference app's
 * LinkTab): onWebViewCreate() — called by Wry right after the page webview is
 * set as the content view and BEFORE the first load — installs the
 * `ArenaKitAndroid` page bridge (WebMessageListener restricted to arena.ai,
 * JavascriptInterface fallback on old WebViews) that injected/links.js posts
 * {cmd:'openTab'|'closeTab'|'external', url} to, and registers a back handler
 * AFTER Wry's own so it runs first: link tab → dock panel (JS handleBack) →
 * page history → system.
 */

import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var pageView: WebView? = null
  private var linkTab: LinkTab? = null

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

  // ---------------------------------------------------------------- page webview hooks

  /** Wry: the page webview exists (content view set), nothing loaded yet. */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    pageView = webView
    // Google's sign-in refuses embedded WebViews by user agent (403
    // disallowed_useragent). Drop the "; wv" token and the "Version/4.0" marker
    // — the rest (Android version, device, Chrome/xx) stays truthful. The
    // desktop build does the equivalent with a Safari UA (lib.rs).
    webView.settings.userAgentString = webView.settings.userAgentString
      .replace("; wv", "")
      .replace(Regex("\\bVersion/\\d+(\\.\\d+)*\\s*"), "")
    linkTab = LinkTab(this) { open ->
      webView.evaluateJavascript("window.__ARENAKIT_LINKS__&&window.__ARENAKIT_LINKS__.setOpen($open)", null)
    }
    installPageBridge(webView)
    // Registered after Wry's own callback (setWebView) → LIFO → ours runs first.
    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  /**
   * `ArenaKitAndroid.postMessage(json)` for injected/links.js. The modern channel
   * only accepts messages from arena.ai; the legacy interface (WebView < 87) is
   * exposed to every page in this webview, which is why the commands are limited
   * to opening URLs the LinkTab / ExternalLinks policies accept.
   */
  private fun installPageBridge(webView: WebView) {
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(
        webView,
        BRIDGE_NAME,
        setOf("https://arena.ai", "https://*.arena.ai"),
      ) { _, message, _, _, _ -> message.data?.let { onPageMessage(it) } }
    } else {
      webView.addJavascriptInterface(LegacyBridge(::onPageMessage), BRIDGE_NAME)
    }
  }

  private class LegacyBridge(private val handler: (String) -> Unit) {
    @JavascriptInterface
    fun postMessage(json: String) {
      handler(json)
    }
  }

  private fun onPageMessage(json: String) {
    if (json.length > 16_384) return
    val o = runCatching { JSONObject(json) }.getOrNull() ?: return
    val cmd = o.optString("cmd")
    val url = o.optString("url").trim()
    runOnUiThread {
      if (isFinishing || isDestroyed) return@runOnUiThread
      val tab = linkTab ?: return@runOnUiThread
      when (cmd) {
        "openTab" -> tab.open(url)
        "closeTab" -> tab.close()
        "external" -> {
          val uri = Uri.parse(url)
          val scheme = uri.scheme.orEmpty().lowercase()
          if (url.isNotEmpty() && scheme !in FORBIDDEN_SCHEMES && !LinkTab.isWebUrl(url)) {
            ExternalLinks.open(this, uri) { fallback -> tab.open(fallback) }
          }
        }
      }
    }
  }

  /** Back: link tab history/close → dock sheet/menu/dialog (JS) → page history → system. */
  private val backCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      if (linkTab?.handleBack() == true) return
      val web = pageView
      if (web == null) {
        fallThrough()
        return
      }
      web.evaluateJavascript(PANEL_BACK_JS) { result ->
        if (result == "true") return@evaluateJavascript
        if (web.canGoBack()) web.goBack() else fallThrough()
      }
    }

    private fun fallThrough() {
      isEnabled = false
      onBackPressedDispatcher.onBackPressed()
      isEnabled = true
    }
  }

  override fun onResume() {
    super.onResume()
    linkTab?.onResume()
  }

  override fun onPause() {
    linkTab?.onPause()
    super.onPause()
  }

  override fun onDestroy() {
    linkTab?.release()
    linkTab = null
    pageView = null
    super.onDestroy()
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

  private companion object {
    const val BRIDGE_NAME = "ArenaKitAndroid"
    val FORBIDDEN_SCHEMES = setOf("file", "content", "javascript", "vbscript")
    const val PANEL_BACK_JS =
      "(function(){try{var e=window.__ARENAKIT_EMBED__;return !!(e&&typeof e.handleBack==='function'&&e.handleBack())}catch(_){return false}})()"
  }
}
