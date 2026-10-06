package dev.vpsdeck

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import dev.vpsdeck.ssh.ConnectionService
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class BackgroundConnectionDeviceTest {
    @get:Rule val ui=createAndroidComposeRule<ComponentActivity>()
    @Test fun pendingConnectionServiceSurvivesActivityStop() {
        val app=ApplicationProvider.getApplicationContext<DeckApp>()
        ui.setContent {Text("连接服务生命周期测试")}
        try {
            ui.runOnIdle {
                app.connecting.value=setOf("disposable-background-fixture")
                ContextCompat.startForegroundService(app,Intent(app,ConnectionService::class.java))
            }
            ui.waitUntil(10000) {app.connectionServiceActive.value}
            ui.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            // More than one 5-second monitor period; no server connection or credential involved.
            Thread.sleep(6200)
            assertTrue(app.connectionServiceActive.value)
            assertTrue(app.connecting.value.contains("disposable-background-fixture"))
        } finally {
            ui.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            ui.runOnIdle {app.connecting.value=emptySet();app.stopService(Intent(app,ConnectionService::class.java))}
            ui.waitUntil(10000) {!app.connectionServiceActive.value}
        }
    }
}
