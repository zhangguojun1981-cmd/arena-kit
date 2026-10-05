package dev.vpsdeck

import android.Manifest
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import dev.vpsdeck.data.*
import dev.vpsdeck.ssh.ShellSession
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DeviceAcceptanceTest {
    @get:Rule(order = 0) val notification = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
    @get:Rule(order = 1) val ui = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<DeckApp>()

    @Test fun encryptedCredentialRoundTripAndTamperRejection() {
        val id = UUID.randomUUID().toString(); val fixture = Credentials("not-a-real-password-7319", "fixture-private-material", "test-only")
        try {
            app.vault.put(id, fixture); assertEquals(fixture, app.vault.get(id))
            val file = File(app.noBackupFilesDir, "vault/$id"); val data = file.readBytes()
            assertFalse(String(data, Charsets.ISO_8859_1).contains(fixture.password))
            assertFalse(String(data, Charsets.ISO_8859_1).contains(fixture.privateKey))
            data[data.lastIndex] = (data.last().toInt() xor 1).toByte(); file.writeBytes(data)
            try { app.vault.get(id); fail("Altered ciphertext must fail authentication") } catch(_: javax.crypto.AEADBadTagException) { }
        } finally { app.vault.delete(id) }
    }
    @Test fun roomProfileRoundTrip() = runBlocking {
        val server = Server(name = "DB fixture", host = "example.invalid", username = "fixture")
        try { app.database.dao().save(server); assertEquals(server, app.database.dao().server(server.id)) }
        finally { app.database.dao().delete(server.id) }
    }
    @Test fun vtEmulatorHandlesAnsiUtf8AndResize() {
        ui.runOnUiThread {
            val shell = ShellSession(Server(name = "VT fixture", host = "example.invalid"), app.ssh, app.appScope)
            val bytes = "hello\r\n\u001b[31m红色\u001b[0m".toByteArray()
            shell.emulator.append(bytes, bytes.size)
            assertTrue(shell.emulator.screen.transcriptText.contains("hello"))
            assertTrue(shell.emulator.screen.transcriptText.contains("红色"))
            shell.emulator.resize(120, 32); assertEquals(120, shell.emulator.mColumns); assertEquals(32, shell.emulator.mRows)
            shell.close()
        }
    }
    @Test fun terminalImeDoesNotSendUncommittedComposition() {
        ui.runOnUiThread {
            val shell = ShellSession(Server(name = "IME fixture", host = "example.invalid"), app.ssh, app.appScope)
            val sent = StringBuilder()
            val canvas = com.termux.view.TerminalCanvas(ui.activity)
            canvas.attach(shell.emulator, object : com.termux.view.TerminalCanvas.Client {
                override fun write(bytes: ByteArray) { sent.append(String(bytes, Charsets.UTF_8)) }
                override fun resized(columns: Int, rows: Int) { }
            })
            val input = canvas.onCreateInputConnection(android.view.inputmethod.EditorInfo())
            input.setComposingText("zhong", 1); assertEquals("", sent.toString())
            input.commitText("中", 1); input.finishComposingText(); assertEquals("中", sent.toString())
            input.setComposingText("文", 1); input.finishComposingText(); assertEquals("中文", sent.toString())
            input.deleteSurroundingText(1, 0); assertEquals("中文\u007f", sent.toString())
            canvas.detach(); shell.close()
        }
    }
    @Test fun staleEditorCannotSaveToAnotherServer() {
        ui.runOnUiThread {
            val vm = DeckViewModel(app)
            val store = androidx.lifecycle.ViewModelStore(); store.put("fixture", vm)
            try {
                val original = Server(name = "Original", host = "original.invalid")
                val edit = RemoteEdit(original, RemoteFile("config", "/tmp/config", false, false, 0, ""), "old", "fixture")
                vm.choose(Server(name = "Other", host = "other.invalid"))
                try { vm.saveEdit(edit, "new", false); fail("A stale editor must reject a different server") }
                catch(e: IllegalArgumentException) { assertTrue(e.message!!.contains("服务器已切换")) }
            } finally { store.clear() }
        }
    }
    @Test fun privateKeyPickerUsesSystemSafWithoutSharedStorage() {
        val intent = dev.vpsdeck.ui.PrivateKeyDocument().createIntent(app, arrayOf("*/*"))
        assertEquals(android.content.Intent.ACTION_OPEN_DOCUMENT, intent.action)
        assertTrue(intent.hasCategory(android.content.Intent.CATEGORY_OPENABLE))
        assertTrue(intent.getBooleanExtra("android.content.extra.SHOW_ADVANCED", false))
        assertNull(intent.data)
        val systemPicker = android.content.Intent(intent).setComponent(android.content.ComponentName(
            "com.google.android.documentsui", "com.android.documentsui.picker.PickActivity"))
        val platformPicker = android.content.Intent(intent).setComponent(android.content.ComponentName(
            "com.android.documentsui", "com.android.documentsui.picker.PickActivity"))
        val available = listOf(platformPicker, systemPicker).any {
            val info = it.resolveActivityInfo(app.packageManager, 0)
            info != null && info.enabled && info.exported &&
                (info.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
        }
        if (available) assertNotNull(intent.component)
        intent.component?.let {
            assertTrue(it.packageName in listOf("com.android.documentsui", "com.google.android.documentsui"))
        }
    }
    @Test fun addServerThroughNativeUiWithoutConnecting() {
        ui.onNodeWithContentDescription("添加服务器").performClick()
        ui.onNodeWithText("名称").performTextInput("UI Fixture")
        ui.onNodeWithText("主机 IP / 域名").performTextInput("example.invalid")
        ui.onNodeWithText("SSH 密码").performScrollTo().performTextInput("test-fixture-only")
        ui.onNodeWithText("加密保存").performScrollTo().performClick()
        ui.waitUntil(10000) { ui.onAllNodesWithText("UI Fixture").fetchSemanticsNodes().isNotEmpty() }
        ui.onNodeWithText("UI Fixture").assertIsDisplayed()
        runBlocking {
            app.database.dao().servers().first().filter { it.name == "UI Fixture" }.forEach {
                assertEquals("test-fixture-only", app.vault.get(it.id).password)
                app.vault.delete(it.id); app.database.dao().delete(it.id)
            }
        }
    }
}
