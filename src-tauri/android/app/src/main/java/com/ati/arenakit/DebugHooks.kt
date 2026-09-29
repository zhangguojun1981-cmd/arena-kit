package com.ati.arenakit

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/**
 * Test-build-only hooks. They do nothing unless the manifest carries
 * `<meta-data android:name="arenakit.debug" android:value="true"/>`, which CI adds
 * only for the `android_debug` dispatch (scripts/patch-android-manifest.mjs --debug).
 * Regular build-<n> releases never contain the marker.
 *
 *  - WebView remote debugging (chrome://inspect, `webview_devtools_remote_<pid>`).
 *  - DEBUG_EVAL: `am broadcast -a com.ati.arenakit.DEBUG_EVAL -p com.ati.arenakit
 *    --es id <name> --es js64 <base64 of a JS expression>` evaluates the expression
 *    in the page (a Promise is awaited) and reports the result to logcat
 *    (tag ArenaKitDebug) and to <external files dir>/debug-<name>.json.
 *    evaluateJavascript is exempt from the page's CSP, so no eval() is involved:
 *    the expression is inlined into the wrapper.
 */
object DebugHooks {
  private const val TAG = "ArenaKitDebug"
  const val ACTION = "com.ati.arenakit.DEBUG_EVAL"

  fun isEnabled(context: Context): Boolean = try {
    @Suppress("DEPRECATION")
    val meta = context.packageManager
      .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    meta != null && meta.getBoolean("arenakit.debug", false)
  } catch (e: Exception) {
    false
  }

  fun enableWebViewDebugging() {
    WebView.setWebContentsDebuggingEnabled(true)
  }

  /** Registers the DEBUG_EVAL receiver; the caller unregisters it in onDestroy. */
  fun install(activity: Activity, webView: WebView): BroadcastReceiver {
    webView.addJavascriptInterface(Sink(activity.applicationContext), "__akdbg")
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val id = cleanId(intent.getStringExtra("id"))
        val code = try {
          String(Base64.decode(intent.getStringExtra("js64") ?: "", Base64.DEFAULT), Charsets.UTF_8)
        } catch (e: Exception) {
          report(activity.applicationContext, id, "ERR bad base64")
          return
        }
        if (code.isBlank()) {
          report(activity.applicationContext, id, "ERR empty js64")
          return
        }
        val quotedId = JSONObject.quote(id)
        val wrapper = "(async()=>{let r;try{r=await(" + code + "\n)}catch(e){r='ERR '+(e&&e.stack||e)}" +
          "try{__akdbg.done(" + quotedId + ",typeof r==='string'?r:JSON.stringify(r===undefined?null:r))}" +
          "catch(e){__akdbg.done(" + quotedId + ",'ERR stringify '+e)}})()"
        webView.post { webView.evaluateJavascript(wrapper, null) }
      }
    }
    ContextCompat.registerReceiver(
      activity, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED
    )
    return receiver
  }

  private fun cleanId(raw: String?): String =
    (raw ?: "last").filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(40).ifEmpty { "last" }

  private fun report(context: Context, id: String, value: String) {
    Log.i(TAG, "[$id] begin")
    value.chunked(3000).forEach { Log.i(TAG, "[$id] $it") }
    Log.i(TAG, "[$id] end")
    try {
      File(context.getExternalFilesDir(null), "debug-$id.json").writeText(value)
    } catch (e: Exception) {
      Log.w(TAG, "could not write debug-$id.json", e)
    }
  }

  private class Sink(private val context: Context) {
    @JavascriptInterface
    fun done(id: String, value: String) {
      report(context, cleanId(id), value)
    }
  }
}
