package dev.vpsdeck

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.ui.DeploymentEditor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeploymentEditorDeviceTest {
    @get:Rule val ui=createComposeRule()
    @Test fun createDefaultsDoNotExposePortsAndOnlyProducePreview() {
        var submitted:String?=null
        val seed=JSONObject().put("operation","create-container").put("id","a".repeat(32)).toString()
        ui.setContent { MaterialTheme { DeploymentEditor(seed,false,null,{}) {submitted=it} } }
        ui.onNodeWithText("容器名称（小写）").performTextInput("fixture")
        ui.runOnIdle {assertNull(submitted)}
        ui.onNodeWithText("预览部署与风险").performScrollTo().performClick()
        ui.runOnIdle {
            val result=JSONObject(submitted!!)
            assertEquals("fixture",result.getString("name"))
            assertFalse(result.getBoolean("publish"));assertEquals("127.0.0.1",result.getString("bind"))
            assertEquals("create-container",result.getString("operation"))
        }
    }
}
