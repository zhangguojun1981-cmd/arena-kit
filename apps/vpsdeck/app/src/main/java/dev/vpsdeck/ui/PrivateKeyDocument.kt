package dev.vpsdeck.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.activity.result.contract.ActivityResultContracts

/** Prefer the system SAF picker, which exposes private DocumentsProviders (e.g. Termux).
 * Some OEM file managers claim OPEN_DOCUMENT but hide those providers. Never stage a key
 * in shared storage to work around that limitation. The user still selects the file.
 */
class PrivateKeyDocument : ActivityResultContracts.OpenDocument() {
    override fun createIntent(context: Context, input: Array<String>): Intent {
        val base = super.createIntent(context, input)
            .putExtra("android.content.extra.SHOW_ADVANCED", true)
        for (pkg in listOf("com.android.documentsui", "com.google.android.documentsui")) {
            val candidate = Intent(base).setComponent(ComponentName(pkg, "com.android.documentsui.picker.PickActivity"))
            val activity = candidate.resolveActivityInfo(context.packageManager, 0)
            if (activity != null && activity.enabled && activity.exported &&
                (activity.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0) return candidate
        }
        return base
    }
}
