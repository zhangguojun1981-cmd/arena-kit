package dev.vpsdeck

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.vpsdeck.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InteractionDeviceTest {
    @get:Rule val ui=createComposeRule()
    @Test fun narrowActionsRemainSingleLineAtLargeFontScale() {
        ui.setContent {MaterialTheme(typography=DeckTypography) {
            val density=LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density,1.4f)) {
                Column(Modifier.width(280.dp)) {ActionGroup {
                    listOf("登记已有目录","查询远端任务","预览安装 / 升级","启用自动续期").forEach {label -> OutlinedButton(onClick={}) {ActionLabel(label)}}
                }}
            }
        }}
        listOf("登记已有目录","查询远端任务","预览安装 / 升级","启用自动续期").forEach {label ->
            val results=mutableListOf<TextLayoutResult>()
            ui.onNodeWithText(label,useUnmergedTree=true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {it(results)}
            assertEquals(1,results.single().lineCount)
            assertFalse(results.single().isLineEllipsized(0))
        }
    }
    @Test fun copyButtonCopiesCompleteRetainedOutput() {
        val text="exit 1\nfirst\n错误：permission denied\nlast"
        ui.setContent {MaterialTheme {CopyableOutput(text,"错误详情",true)}}
        ui.onNodeWithText("复制输出").performClick()
        ui.onNodeWithText("已复制").assertIsDisplayed()
        ui.runOnIdle {
            val context=ApplicationProvider.getApplicationContext<Context>()
            val clipboard=context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals(text,clipboard.primaryClip!!.getItemAt(0).text.toString())
        }
    }
    @Test fun resourceActionsAreNotShownBeforeOpeningDetails() {
        var performed=false
        ui.setContent {MaterialTheme(typography=DeckTypography) {ResourceDetail("示例网站","HTTPS · :443","启用") {
            ResourceActions(listOf(ResourceMenuAction("编辑网站") {performed=true},ResourceMenuAction("停用网站") {performed=true}))
        }}}
        ui.onNodeWithText("编辑网站").assertDoesNotExist()
        ui.onNodeWithText("示例网站").performClick()
        ui.onNodeWithText("编辑网站").assertIsDisplayed()
        ui.onNodeWithText("停用网站").assertDoesNotExist()
        ui.onNodeWithContentDescription("更多操作").performClick()
        ui.onNodeWithText("停用网站").assertIsDisplayed()
        ui.runOnIdle {assertFalse(performed)}
    }
    @Test fun fileLongPressEntersSelectionWithoutOpeningFile() {
        var opened=false
        ui.setContent {MaterialTheme {
            var selected by remember {mutableStateOf(false)}
            SelectableFileRow(RemoteFile("example.txt","/example.txt",false,false,10,"-rw-------"),selected,selected,true,
                {selected=!selected},{opened=true},{opened=true})
        }}
        ui.onNodeWithText("example.txt").performTouchInput {longClick()}
        ui.onNode(isToggleable()).assertIsOn()
        ui.runOnIdle {assertFalse(opened)}
    }
    @Test fun terminalCopyReadsLatestOutputAtClickTime() {
        var transcript="old output"
        ui.setContent {MaterialTheme {CopyButton("","复制历史",readText={transcript})}}
        ui.runOnIdle {transcript="new output\n中文"}
        ui.onNodeWithText("复制历史").performClick()
        ui.runOnIdle {
            val context=ApplicationProvider.getApplicationContext<Context>()
            val clipboard=context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals(transcript,clipboard.primaryClip!!.getItemAt(0).text.toString())
        }
    }
    @Test fun resourceActionButtonsAlignToRowEndAndAreCompact() {
        var performed=false
        ui.setContent {MaterialTheme(typography=DeckTypography) {
            Column(Modifier.fillMaxSize()) {
                ResourceActions(listOf(ResourceMenuAction("编辑网站"){performed=true},ResourceMenuAction("停用网站"){performed=true}))
            }
        }}
        val root=ui.onRoot().fetchSemanticsNode().boundsInRoot
        val primary=ui.onNodeWithText("编辑网站").fetchSemanticsNode().boundsInRoot
        val more=ui.onNodeWithContentDescription("更多操作").fetchSemanticsNode().boundsInRoot
        assertTrue(primary.right >= root.right - 12, "primary action must sit at the row end")
        assertTrue(primary.left > root.width/2, "action row must not be anchored left")
        assertTrue(primary.right >= more.right)
        assertTrue(primary.height * 2f < root.height)
        ui.onNodeWithContentDescription("更多操作").performClick()
        ui.onNodeWithText("停用网站").assertIsDisplayed()
        ui.runOnIdle {assertFalse(performed)}
    }

}
