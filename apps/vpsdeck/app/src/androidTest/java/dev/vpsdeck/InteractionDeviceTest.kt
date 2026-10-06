package dev.vpsdeck

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
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
    @Test fun terminalTypingWaitsForExplicitExecutionAndClearsOnlyAfterSend() {
        val sent=mutableListOf<String>()
        ui.setContent {MaterialTheme {TerminalCommandBar(true) {sent+=it.toString(Charsets.UTF_8);true}}}
        ui.onNodeWithText("输入命令").performTextInput("echo 中文")
        ui.runOnIdle {assertTrue(sent.isEmpty())}
        ui.onNodeWithText("执行").performClick()
        ui.runOnIdle {assertEquals(listOf("echo 中文\r"),sent)}
        ui.onNodeWithText("输入命令").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText,androidx.compose.ui.text.AnnotatedString("")))
        ui.onNodeWithText("输入命令").performTextInput("pwd").performImeAction()
        ui.runOnIdle {assertEquals("pwd\r",sent.last())}
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
    @Test fun disconnectedTerminalCannotSubmit() {
        ui.setContent {MaterialTheme {TerminalCommandBar(false) {error("must not send")}}}
        ui.onNodeWithText("执行").assertIsNotEnabled()
        ui.onNodeWithText("输入命令").assertIsNotEnabled()
    }
    @Test fun failedTerminalSubmissionPreservesInput() {
        ui.setContent {MaterialTheme {TerminalCommandBar(true) {false}}}
        ui.onNodeWithText("输入命令").performTextInput("pwd")
        ui.onNodeWithText("执行").performClick()
        ui.onNodeWithText("输入命令").assertTextContains("pwd")
    }
}
