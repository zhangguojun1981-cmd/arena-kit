package com.ati.arenakit

/*
 * In-app "new tab" for links opened from the Arena page — port of the
 * reference app's ui/LinkTab.kt + web/ExternalLinks.kt (arena-trace-android).
 *
 * The tab is a separate WebView layered over the conversation (added to the
 * activity's content frame above Wry's webview), which keeps running
 * underneath. It shares cookies with Arena (links to Arena and sign-in pages
 * work) but gets none of the page bridges or injected scripts. Back walks the
 * tab's own history, then closes it; ✕ closes it at once. Closing destroys the
 * WebView. One tab at a time.
 *
 * Built in code (no layout XML) so the overlay stays a drop-in for the
 * generated project: header 52dp (✕ · title / host · ⟳ · ⋮), 2dp progress bar,
 * the WebView; slide + fade 200 / 160 ms; Material-3 flat palette in both
 * light and dark mode.
 */

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.widget.PopupMenu

class LinkTab(
  private val activity: Activity,
  private val onOpenChanged: (open: Boolean) -> Unit,
) {
  private val density = activity.resources.displayMetrics.density
  private val night = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
    Configuration.UI_MODE_NIGHT_YES
  private val surface = if (night) Color.parseColor("#16181D") else Color.WHITE
  private val onSurface = if (night) Color.parseColor("#E6E8ED") else Color.parseColor("#15171C")
  private val muted = if (night) Color.parseColor("#9BA2AF") else Color.parseColor("#5F6673")
  private val outline = if (night) Color.parseColor("#353A45") else Color.parseColor("#D8DBE2")
  private val brand = if (night) Color.parseColor("#9DB8FF") else Color.parseColor("#2F6BFF")

  private val layer = LinearLayout(activity)
  private val titleView = TextView(activity)
  private val hostView = TextView(activity)
  private val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal)
  private val holder = FrameLayout(activity)
  private var web: WebView? = null

  var isOpen: Boolean = false
    private set

  init {
    buildLayer()
    activity.addContentView(
      layer,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  /** Open [url] in the tab (a tapped link to another site, target=_blank, window.open). */
  fun open(url: String) {
    if (!isWebUrl(url)) return
    val view = newWebView() ?: return
    showAddress(url)
    view.loadUrl(url)
    show()
  }

  /** Back press: tab history first, then close. Returns true when consumed. */
  fun handleBack(): Boolean {
    if (!isOpen) return false
    val view = web
    if (view != null && view.canGoBack()) view.goBack() else close()
    return true
  }

  fun close() {
    if (!isOpen) return
    isOpen = false
    hideKeyboard()
    layer.animate().cancel()
    layer.animate()
      .alpha(0f)
      .translationY(slideDistance())
      .setDuration(CLOSE_MS)
      .withEndAction {
        if (!isOpen) {
          layer.visibility = View.GONE
          destroyWebView()
        }
      }
      .start()
    onOpenChanged(false)
  }

  fun onResume() {
    web?.onResume()
  }

  fun onPause() {
    web?.onPause()
  }

  fun release() {
    layer.animate().cancel()
    destroyWebView()
  }

  // ---------------------------------------------------------------- layout

  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  private fun iconButton(glyph: String, description: String, onClick: (View) -> Unit): TextView {
    val b = TextView(activity)
    b.text = glyph
    b.contentDescription = description
    b.setTextColor(onSurface)
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
    b.gravity = Gravity.CENTER
    b.minWidth = dp(44f)
    b.minHeight = dp(44f)
    b.isClickable = true
    b.isFocusable = true
    val ripple = TypedValue()
    activity.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)
    b.setBackgroundResource(ripple.resourceId)
    b.setOnClickListener(onClick)
    return b
  }

  private fun buildLayer() {
    layer.orientation = LinearLayout.VERTICAL
    layer.setBackgroundColor(surface)
    layer.isClickable = true
    layer.isFocusable = true
    layer.visibility = View.GONE
    layer.elevation = dp(8f).toFloat()

    val header = LinearLayout(activity)
    header.orientation = LinearLayout.HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.minimumHeight = dp(52f)
    header.setPadding(dp(4f), 0, dp(4f), 0)

    header.addView(iconButton("✕", "关闭标签页") { close() })

    val texts = LinearLayout(activity)
    texts.orientation = LinearLayout.VERTICAL
    val textsLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    textsLp.marginStart = dp(4f)
    titleView.text = "加载中…"
    titleView.setTextColor(onSurface)
    titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    titleView.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    titleView.isSingleLine = true
    titleView.ellipsize = TextUtils.TruncateAt.END
    hostView.setTextColor(muted)
    hostView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    hostView.isSingleLine = true
    hostView.ellipsize = TextUtils.TruncateAt.MIDDLE
    texts.addView(titleView)
    texts.addView(hostView)
    header.addView(texts, textsLp)

    header.addView(iconButton("⟳", "刷新标签页") { web?.reload() })
    header.addView(iconButton("⋮", "更多") { showMenu(it) })
    layer.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    val divider = View(activity)
    divider.setBackgroundColor(outline)
    layer.addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))

    // 2dp determinate bar in the brand colour; hidden between loads.
    progress.max = 100
    progress.progressDrawable = buildProgressDrawable()
    progress.visibility = View.INVISIBLE
    layer.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2f)))

    layer.addView(holder, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
  }

  private fun buildProgressDrawable(): android.graphics.drawable.LayerDrawable {
    val track = GradientDrawable().apply { setColor(Color.TRANSPARENT) }
    val bar = android.graphics.drawable.ClipDrawable(
      GradientDrawable().apply { setColor(brand) },
      Gravity.START,
      android.graphics.drawable.ClipDrawable.HORIZONTAL,
    )
    val layers = android.graphics.drawable.LayerDrawable(arrayOf(track, bar))
    layers.setId(0, android.R.id.background)
    layers.setId(1, android.R.id.progress)
    return layers
  }

  // ---------------------------------------------------------------- internals

  private fun show() {
    hideKeyboard()
    layer.animate().cancel()
    if (!isOpen) {
      layer.alpha = 0f
      layer.translationY = slideDistance()
    }
    layer.visibility = View.VISIBLE
    layer.bringToFront()
    layer.animate()
      .alpha(1f)
      .translationY(0f)
      .setDuration(OPEN_MS)
      .setInterpolator(DecelerateInterpolator())
      .start()
    web?.requestFocus()
    if (!isOpen) {
      isOpen = true
      onOpenChanged(true)
    }
  }

  /** A fresh WebView replacing the current one (one tab at a time). */
  private fun newWebView(): WebView? {
    destroyWebView()
    val view = try {
      WebView(activity)
    } catch (e: RuntimeException) {
      // WebView provider missing or being updated.
      Toast.makeText(activity, "无法打开新标签页（WebView 不可用）", Toast.LENGTH_SHORT).show()
      return null
    }
    configure(view)
    holder.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    web = view
    titleView.text = "加载中…"
    hostView.text = ""
    setProgress(0)
    return view
  }

  private fun configure(view: WebView) {
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      loadWithOverviewMode = true
      useWideViewPort = true
      builtInZoomControls = true
      displayZoomControls = false
      allowFileAccess = false
      allowContentAccess = false
      // Links inside the tab stay in the tab.
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        val uri = request.url
        return when (routeTab(uri.scheme, request.hasGesture())) {
          Route.IN_PLACE -> false
          Route.EXTERNAL_APP -> {
            ExternalLinks.open(activity, uri) { fallback -> v.loadUrl(fallback) }
            true
          }
          Route.BLOCK -> true
        }
      }

      override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
        if (v === web) showAddress(url)
      }

      override fun doUpdateVisitedHistory(v: WebView, url: String?, isReload: Boolean) {
        if (v === web) showAddress(url)
      }
    }
    view.webChromeClient = object : WebChromeClient() {
      override fun onReceivedTitle(v: WebView, title: String?) {
        if (v === web && !title.isNullOrBlank()) titleView.text = title
      }

      override fun onProgressChanged(v: WebView, newProgress: Int) {
        if (v === web) setProgress(newProgress)
      }

      // window.close() from the page (e.g. a sign-in pop-up that is done).
      override fun onCloseWindow(window: WebView) {
        if (window === web) close()
      }
    }
    view.setDownloadListener { url, _, _, _, _ -> ExternalLinks.download(activity, url) }
  }

  private fun showAddress(url: String?) {
    val host = runCatching { Uri.parse(url).host }.getOrNull()
    hostView.text = host?.removePrefix("www.").orEmpty().ifEmpty { url.orEmpty() }
  }

  private fun setProgress(value: Int) {
    if (value in 0..99) {
      if (progress.visibility != View.VISIBLE) progress.visibility = View.VISIBLE
      progress.progress = maxOf(value, MIN_VISIBLE_PROGRESS)
    } else {
      progress.visibility = View.INVISIBLE
    }
  }

  private fun showMenu(anchor: View) {
    val url = web?.url
    val popup = PopupMenu(activity, anchor)
    popup.menu.add(0, MENU_BROWSER, 0, "在浏览器中打开")
    popup.menu.add(0, MENU_COPY, 1, "复制链接")
    popup.menu.add(0, MENU_SHARE, 2, "分享链接")
    val isWeb = isWebUrl(url)
    for (i in 0 until popup.menu.size()) popup.menu.getItem(i).isEnabled = isWeb
    popup.setOnMenuItemClickListener { item ->
      when (item.itemId) {
        MENU_BROWSER -> ExternalLinks.openInBrowser(activity, url)
        MENU_COPY -> ExternalLinks.copy(activity, url)
        MENU_SHARE -> ExternalLinks.share(activity, url, titleView.text?.toString())
      }
      true
    }
    popup.show()
  }

  private fun destroyWebView() {
    val view = web ?: return
    web = null
    view.stopLoading()
    view.webChromeClient = null
    holder.removeView(view)
    view.destroy()
  }

  private fun hideKeyboard() {
    val focused = activity.currentFocus ?: return
    activity.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(focused.windowToken, 0)
  }

  private fun slideDistance(): Float = SLIDE_DP * density

  enum class Route { IN_PLACE, EXTERNAL_APP, BLOCK }

  companion object {
    const val OPEN_MS = 200L
    const val CLOSE_MS = 160L
    const val SLIDE_DP = 32f
    const val MIN_VISIBLE_PROGRESS = 8
    private const val MENU_BROWSER = 1
    private const val MENU_COPY = 2
    private const val MENU_SHARE = 3

    private val WEB_SCHEMES = setOf("http", "https")
    private val PASSIVE_SCHEMES = setOf("about", "blob", "data")
    private val FORBIDDEN_SCHEMES = setOf("file", "content", "javascript", "vbscript")

    /** A main-frame navigation inside the tab: web pages stay in the tab (LinkPolicy.routeTab). */
    fun routeTab(scheme: String?, hasGesture: Boolean): Route {
      val s = scheme.orEmpty().lowercase()
      return when {
        s.isEmpty() || s in WEB_SCHEMES || s in PASSIVE_SCHEMES -> Route.IN_PLACE
        s in FORBIDDEN_SCHEMES -> Route.BLOCK
        hasGesture -> Route.EXTERNAL_APP
        else -> Route.BLOCK
      }
    }

    /** Only http(s) URLs are ever loaded in the tab, handed to a browser, copied or shared. */
    fun isWebUrl(url: String?): Boolean {
      val u = url.orEmpty().trim()
      val colon = u.indexOf(':')
      return colon > 0 && u.substring(0, colon).lowercase() in WEB_SCHEMES && u.length > colon + 3
    }
  }
}

/**
 * Hands links to other apps: browser, mail, dialer, store, intent: deep links,
 * the share sheet and the clipboard. Every launch is BROWSABLE-only with no
 * explicit component/selector (a page can't target an arbitrary, non-exported
 * activity), and a missing handler is a toast, never a crash.
 */
object ExternalLinks {

  /**
   * Open [uri] in whatever app handles it. For an intent: URI with no installed
   * handler, its http(s) `browser_fallback_url` is passed to [onFallback].
   */
  fun open(activity: Activity, uri: Uri, onFallback: (String) -> Unit = {}): Boolean {
    val intent = if (uri.scheme.equals("intent", ignoreCase = true)) {
      runCatching { Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) }.getOrNull()
        ?: return notHandled(activity)
    } else {
      Intent(Intent.ACTION_VIEW, uri)
    }
    intent.addCategory(Intent.CATEGORY_BROWSABLE)
    intent.component = null
    intent.selector = null
    return try {
      activity.startActivity(intent)
      true
    } catch (_: ActivityNotFoundException) {
      val fallback = intent.getStringExtra("browser_fallback_url")
      if (LinkTab.isWebUrl(fallback)) {
        onFallback(fallback!!)
        true
      } else {
        notHandled(activity)
      }
    } catch (_: SecurityException) {
      notHandled(activity)
    }
  }

  /** Open an http(s) URL in the user's browser. */
  fun openInBrowser(activity: Activity, url: String?): Boolean {
    if (!LinkTab.isWebUrl(url)) return notHandled(activity)
    return open(activity, Uri.parse(url))
  }

  fun copy(activity: Activity, url: String?) {
    if (!LinkTab.isWebUrl(url)) return
    val clipboard = activity.getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("链接", url))
    // Android 13+ shows its own clipboard confirmation.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      Toast.makeText(activity, "已复制链接", Toast.LENGTH_SHORT).show()
    }
  }

  fun share(activity: Activity, url: String?, title: String?) {
    if (!LinkTab.isWebUrl(url)) return
    val send = Intent(Intent.ACTION_SEND)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, url)
    if (!title.isNullOrBlank()) send.putExtra(Intent.EXTRA_SUBJECT, title)
    try {
      activity.startActivity(Intent.createChooser(send, null))
    } catch (_: ActivityNotFoundException) {
      notHandled(activity)
    }
  }

  /** WebView download request: let the browser (download manager) take http(s) files. */
  fun download(activity: Activity, url: String?) {
    if (!LinkTab.isWebUrl(url)) {
      Toast.makeText(activity, "不支持下载此类型", Toast.LENGTH_SHORT).show()
      return
    }
    if (openInBrowser(activity, url)) {
      Toast.makeText(activity, "已交给浏览器下载", Toast.LENGTH_SHORT).show()
    }
  }

  private fun notHandled(activity: Activity): Boolean {
    Toast.makeText(activity, "没有可以打开此链接的应用", Toast.LENGTH_SHORT).show()
    return false
  }
}
