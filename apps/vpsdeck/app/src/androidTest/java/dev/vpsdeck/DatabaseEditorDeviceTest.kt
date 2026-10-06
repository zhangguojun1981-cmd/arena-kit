package dev.vpsdeck

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.ui.DatabaseEditor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DatabaseEditorDeviceTest {
    @get:Rule val ui=createComposeRule()
    private fun seed(operation: String) = JSONObject().put("kind","database").put("operation",operation)
        .put("database",if(operation=="restore") "demo" else "").put("backup","a".repeat(32))
        .put("auth",JSONObject().put("engine","postgresql").put("user","postgres").put("container",""))
    @Test fun createDatabaseFormProducesPreviewNotImmediateMutation() {
        var submitted: String?=null
        ui.setContent { MaterialTheme { DatabaseEditor(seed("create-database").toString(),"{}",false,null,{}) {submitted=it} } }
        ui.onNodeWithText("数据库名称").performTextInput("demo")
        ui.runOnIdle {assertNull(submitted)}
        ui.onNodeWithText("预览操作与风险").performScrollTo().performClick()
        ui.runOnIdle {assertEquals("demo",JSONObject(submitted!!).getString("database"));assertEquals("postgres",JSONObject(submitted!!).getString("owner"))}
    }
    @Test fun restoreRequiresExplicitTargetAcknowledgementBeforePreview() {
        var submitted: String?=null
        ui.setContent { MaterialTheme { DatabaseEditor(seed("restore").toString(),"{}",false,null,{}) {submitted=it} } }
        ui.onNodeWithText("预览操作与风险").performScrollTo().assertIsNotEnabled()
        ui.onNode(isToggleable()).performScrollTo().performClick()
        ui.onNodeWithText("预览操作与风险").performScrollTo().performClick()
        ui.runOnIdle {assertTrue(JSONObject(submitted!!).getBoolean("confirmRestoreTarget"))}
    }
}
