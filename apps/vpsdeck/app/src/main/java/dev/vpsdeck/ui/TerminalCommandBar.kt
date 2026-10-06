package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/** A line submitted explicitly to the current PTY. Pasted control bytes must not execute silently. */
fun terminalCommandBytes(command: String): ByteArray {
    require(command.isNotBlank() && command.length<=64000 && command.none {it<' ' || it=='\u007f'}) {"请输入单行命令，不包含换行或控制字符"}
    return (command+"\r").toByteArray(Charsets.UTF_8)
}
@Composable fun TerminalCommandBar(connected: Boolean, onSend: (ByteArray) -> Boolean) {
    var command by remember {mutableStateOf("")}
    var failed by remember {mutableStateOf(false)}
    val bytes=remember(command) {runCatching {terminalCommandBytes(command)}.getOrNull()}
    fun send() {
        val data=bytes ?: return
        if(!connected) return
        if(onSend(data)) {command="";failed=false} else failed=true
    }
    Column(Modifier.fillMaxWidth().padding(horizontal=12.dp,vertical=4.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
            OutlinedTextField(command,{command=it;failed=false},Modifier.weight(1f),enabled=connected,singleLine=true,
                label={Text("输入命令")},placeholder={Text("例如：pwd")},
                keyboardOptions=KeyboardOptions(autoCorrect=false,imeAction=ImeAction.Send),
                keyboardActions=KeyboardActions(onSend={send()}))
            Button(onClick={send()},enabled=connected && bytes!=null) {ActionLabel("执行")}
        }
        if(command.isNotEmpty() && bytes==null) Hint("仅支持单行命令，不接受换行或控制字符；不会自动执行粘贴内容。")
        if(failed) Hint("未发送，连接不可用或输入队列已满；输入已保留，不会自动重试。")
    }
}
