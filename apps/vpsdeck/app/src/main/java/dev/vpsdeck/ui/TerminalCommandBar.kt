package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

fun normalizedCommand(command: String) = command.replace("\r\n","\n").replace('\r','\n')
/** Only explicit submission calls this. No quoting, trimming or shell wrapping of the user's script. */
fun terminalCommandBytes(command: String): ByteArray {
    val text=normalizedCommand(command)
    require(text.isNotBlank() && text.length<=64000 && text.none {(it<' ' && it!='\n') || it=='\u007f' || it in '\u0080'..'\u009f'}) {
        "允许多行命令，不接受制表符、ESC 或其他控制字符"
    }
    return (text.replace('\n','\r')+if(text.endsWith('\n')) "" else "\r").toByteArray(Charsets.UTF_8)
}
class TerminalDraftState { val command=mutableStateOf("");val failed=mutableStateOf(false) }
@Composable fun TerminalCommandBar(connected: Boolean, maxLines: Int = 6, draft: TerminalDraftState = remember {TerminalDraftState()}, onSend: (ByteArray) -> Boolean) {
    var command by draft.command
    var failed by draft.failed
    var pending by remember {mutableStateOf<String?>(null)}
    val bytes=remember(command) {runCatching {terminalCommandBytes(command)}.getOrNull()}
    fun send(text: String) {
        if(!connected) return
        val data=runCatching {terminalCommandBytes(text)}.getOrNull() ?: return
        if(onSend(data)) {if(command==text) command="";failed=false} else failed=true
    }
    Column(Modifier.fillMaxWidth().padding(horizontal=12.dp,vertical=4.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=androidx.compose.ui.Alignment.Bottom) {
            OutlinedTextField(command,{command=it;failed=false},Modifier.weight(1f),enabled=connected,
                singleLine=false,minLines=1,maxLines=maxLines,label={Text("输入命令")},placeholder={Text("支持多行，回车换行")},
                keyboardOptions=KeyboardOptions(autoCorrect=false,imeAction=ImeAction.Default))
            QuietAction(onClick={if(normalizedCommand(command).contains('\n')) pending=command else send(command)},enabled=connected && bytes!=null) {ActionLabel("执行")}
        }
        if(command.isNotEmpty() && bytes==null) Hint("最多64000字符；允许换行，不接受制表符和控制序列。")
        if(failed) Hint("未发送，连接不可用或输入队列已满；输入已保留，不会自动重试。")
    }
    pending?.let {snapshot -> AlertDialog(onDismissRequest={pending=null},title={Text("发送多行命令？")},text={
        Column(Modifier.heightIn(max=320.dp).verticalScroll(rememberScrollState())) {
            Text("将发送到当前终端，可能依次执行多条命令；不是事务，失败不会自动停止后续命令。请确认终端正处于正确的 shell 提示符。")
            CopyableOutput(snapshot,"待发送内容")
        }
    },confirmButton={TextButton(onClick={pending=null;send(snapshot)},enabled=connected) {ActionLabel("确认发送")}},dismissButton={TextButton(onClick={pending=null}) {ActionLabel("继续编辑")}})}
}
