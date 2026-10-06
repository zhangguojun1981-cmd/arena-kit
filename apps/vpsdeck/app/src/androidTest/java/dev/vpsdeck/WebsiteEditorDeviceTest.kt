package dev.vpsdeck

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.panel.WebsiteProtocol
import dev.vpsdeck.ui.WebsiteEditor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WebsiteEditorDeviceTest {
    @get:Rule val ui=createComposeRule()
    @Test fun websiteFormProducesAPlanNotAnImmediateWrite() {
        var submitted: String?=null
        val seed=WebsiteProtocol.fresh()
        ui.setContent { MaterialTheme { WebsiteEditor(seed,emptyList(),false,null,{}) {spec,_ -> submitted=spec} } }
        ui.onNodeWithText("域名（ASCII，不含协议）").performTextInput("example.test")
        ui.onNodeWithText("反向代理").performClick()
        ui.onNodeWithText("预览配置差异").performScrollTo().performClick()
        ui.runOnIdle { assertEquals("example.test",JSONObject(submitted!!).getString("domain"));assertEquals("proxy",JSONObject(submitted!!).getString("kind")) }
    }
}
