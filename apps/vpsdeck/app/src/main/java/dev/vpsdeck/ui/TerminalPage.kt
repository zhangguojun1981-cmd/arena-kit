@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.termux.view.TerminalCanvas
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.ssh.ShellSession

@Composable fun TerminalPage(vm: DeckViewModel, server: Server) {
    val version = vm.shellVersion
    val shells = remember(version, server.id) { vm.app.terminals.values.filter { it.server.id == server.id } }
    var selected by remember(server.id) { mutableStateOf<String?>(shells.lastOrNull()?.id) }
    val shell = shells.firstOrNull { it.id == selected } ?: shells.lastOrNull()
    var paste by remember { mutableStateOf<String?>(null) }
    var close by remember { mutableStateOf<ShellSession?>(null) }
    var ctrl by remember { mutableStateOf(false) }
    var font by remember { mutableFloatStateOf(13f) }
    var canvas by remember { mutableStateOf<TerminalCanvas?>(null) }
    val context = LocalContext.current
    val clipboard = remember { context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            shells.forEachIndexed { i, s -> FilterChip(shell?.id == s.id, { selected = s.id }, label = { ActionLabel("终端 ${i + 1}") }) }
            TextButton(onClick = { vm.newShell()?.let { selected = it.id } }) { Icon(Icons.Outlined.Add, null); ActionLabel("新建") }
        }
        if(shell == null) {
            Panel(Modifier.padding(20.dp)) { Icon(Icons.Outlined.Terminal, null, Modifier.size(40.dp)); SectionTitle("交互式 SSH 终端"); Text("支持 vim、top、sudo、Tab补全与特殊按键。命令只在你输入时执行，断线不会自动重放。"); Button(onClick = { vm.newShell()?.let { selected = it.id } }) { ActionLabel("打开终端") }; Hint("长任务建议使用 tmux。服务器未连接时请先在概览中连接。") }
        } else {
            val state by shell.state.collectAsState()
            val ready=state=="已连接"
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(state, style = MaterialTheme.typography.labelMedium, color = if(state == "已连接") MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error)
                TextButton(onClick = { close = shell }) { ActionLabel("关闭此会话") }
            }
            Hint("命令栏输入后点执行；密码、vim、top 等交互请点键盘或终端区域。")
            key(shell.id) {
                AndroidView(factory = { ctx -> TerminalCanvas(ctx).apply {
                    attach(shell.emulator, object : TerminalCanvas.Client {
                        override fun write(bytes: ByteArray) = shell.writeBytes(bytes)
                        override fun resized(columns: Int, rows: Int) = shell.resize(columns, rows)
                    }); shell.onChanged = { changed() }; canvas = this
                } }, update = { it.setCtrl(ctrl); it.setFontSp(font) }, modifier = Modifier.weight(1f).fillMaxWidth())
                DisposableEffect(shell.id) { onDispose { shell.onChanged = null; canvas?.detach(); canvas = null } }
            }
            key(shell.id) {TerminalCommandBar(ready) { bytes ->
                val accepted=shell.sendInput(bytes);if(accepted) canvas?.bottom();accepted
            }}
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                TextButton(onClick={canvas?.showKeyboard()},enabled=ready) {ActionLabel("键盘")}
                TextButton(onClick={shell.write("\r");canvas?.bottom()},enabled=ready) {ActionLabel("回车")}

                listOf("Esc" to "\u001b", "Tab" to "\t", "^C" to "\u0003", "^D" to "\u0004", "↑" to "\u001b[A", "↓" to "\u001b[B", "←" to "\u001b[D", "→" to "\u001b[C").forEach { (label, text) -> TextButton(enabled=ready,onClick = { shell.write(if(text.startsWith("\u001b[") && shell.emulator.isCursorKeysApplicationMode) text.replace("\u001b[", "\u001bO") else text); canvas?.bottom() }, contentPadding = PaddingValues(horizontal = 12.dp)) { ActionLabel(label) } }
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                FilterChip(ctrl, { ctrl = !ctrl }, enabled=ready, label = { ActionLabel("Ctrl") })
                TextButton(enabled=ready,onClick = { val value = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty(); if(value.length > 64000) vm.error = "粘贴内容超过64000字符" else if(value.isNotBlank()) paste = value }) { ActionLabel("粘贴") }
                TextButton(onClick = { clipboard.setPrimaryClip(ClipData.newPlainText("SSH 当前可见文本", canvas?.visibleText().orEmpty())) }) { ActionLabel("复制屏幕") }
                CopyButton("","复制历史",readText={shell.emulator.screen.transcriptText})
                TextButton(onClick = { font = (font - 1).coerceAtLeast(11f) }) { ActionLabel("A−") }
                TextButton(onClick = { font = (font + 1).coerceAtMost(14f) }) { ActionLabel("A+") }
            }
        }
    }
    paste?.let { text -> AlertDialog(onDismissRequest = { paste = null }, title = { Text("向 ${server.name} 粘贴？") }, text = { Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) { Text("包含换行的文本可能立即执行命令。请核对目标与内容。", color = MaterialTheme.colorScheme.error); Spacer(Modifier.height(12.dp)); Text(text.take(4000)); if(text.length > 4000) Hint("预览已截断，共 ${text.length} 字符") } }, confirmButton = { TextButton(onClick = { runCatching { shell?.paste(text); canvas?.bottom() }.onFailure { vm.error = it.message }; paste = null }) { ActionLabel("确认粘贴") } }, dismissButton = { TextButton(onClick = { paste = null }) { ActionLabel("取消") } }) }
    close?.let { s -> AlertDialog(onDismissRequest = { close = null }, title = { Text("关闭终端会话？") }, text = { Text("未使用 tmux/nohup 的前台任务可能随 SSH 会话结束。") }, confirmButton = { TextButton(onClick = { vm.closeShell(s.id); close = null }) { ActionLabel("关闭") } }, dismissButton = { TextButton(onClick = { close = null }) { ActionLabel("取消") } }) }
}
