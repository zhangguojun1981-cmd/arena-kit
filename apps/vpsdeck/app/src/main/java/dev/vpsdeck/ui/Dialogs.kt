@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.vpsdeck.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.vpsdeck.*
import dev.vpsdeck.data.*
import dev.vpsdeck.ops.*
import dev.vpsdeck.ssh.ExecResult
import java.io.ByteArrayOutputStream

@Composable fun FullDialog(title: String, onClose: () -> Unit, actions: @Composable RowScope.() -> Unit = {}, content: @Composable (PaddingValues) -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(topBar = { TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "关闭") } }, actions = actions) }, content = content)
    }
}
@Composable fun ServerDialog(old: Server?, vm: DeckViewModel, onClose: () -> Unit) {
    val original = remember { old ?: Server(name = "", host = "") }
    var name by remember { mutableStateOf(original.name) }; var host by remember { mutableStateOf(original.host) }
    var port by remember { mutableStateOf(original.port.toString()) }; var user by remember { mutableStateOf(original.username) }
    var group by remember { mutableStateOf(original.group) }; var production by remember { mutableStateOf(original.production) }
    var favorite by remember { mutableStateOf(original.favorite) }; var auth by remember { mutableStateOf(original.auth) }
    var replace by remember { mutableStateOf(old == null) }; var password by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }; var passphrase by remember { mutableStateOf("") }
    var resetPin by remember { mutableStateOf(false) }; var confirmReset by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val importKey = rememberLauncherForActivityResult(PrivateKeyDocument()) { uri -> if(uri != null) {
        runCatching {
            context.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input); val out = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while(true) { val n = input.read(buffer); if(n < 0) break; out.write(buffer, 0, n); require(out.size() <= 65536) { "私钥文件不能超过64KB" } }
                out.toString("UTF-8").also { require(it.contains("PRIVATE KEY")) { "未识别为 PEM/OpenSSH 私钥" } }
            }
        }.onSuccess { key = it }.onFailure { vm.error = it.message }
    } }
    FullDialog(if(old == null) "添加服务器" else "编辑服务器", onClose) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Hint("只保存连接资料，不会自动安装软件或修改 VPS。凭据不进入系统备份。")
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("名称") }, singleLine = true)
            OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text("主机 IP / 域名") }, placeholder = { Text("不含 ssh://，IPv6不加方括号") }, singleLine = true)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(user, { user = it }, Modifier.weight(2f), label = { Text("SSH 用户") }, singleLine = true)
                OutlinedTextField(port, { port = it.filter(Char::isDigit) }, Modifier.weight(1f), label = { Text("端口") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
            }
            OutlinedTextField(group, { group = it }, Modifier.fillMaxWidth(), label = { Text("分组 / 标签") }, singleLine = true)
            Row { FilterChip(production, { production = !production }, label = { Text("生产环境") }); Spacer(Modifier.width(8.dp)); FilterChip(favorite, { favorite = !favorite }, label = { Text("置顶") }) }
            HorizontalDivider(); SectionTitle("认证方式")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(auth == "password", { auth = "password"; if(old?.auth != auth) replace = true }, label = { Text("密码") }); FilterChip(auth == "key", { auth = "key"; if(old?.auth != auth) replace = true }, label = { Text("私钥") }) }
            if(old != null) Row { Checkbox(replace, { replace = it }); Text("替换已保存凭据（不回显旧凭据）", Modifier.padding(top = 12.dp)) }
            if(replace) {
                if(auth == "password") OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("SSH 密码") }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
                else {
                    OutlinedButton(onClick = { importKey.launch(arrayOf("*/*")) }) { Icon(Icons.Outlined.Key, null); Spacer(Modifier.width(8.dp)); Text(if(key.isBlank()) "从文件导入私钥" else "已导入私钥 · 重新选择") }
                    Hint("支持库可解析的 OpenSSH/PEM 私钥；不显示私钥内容，不复制到下载目录。")
                    OutlinedTextField(passphrase, { passphrase = it }, Modifier.fillMaxWidth(), label = { Text("私钥口令（可选）") }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
                }
            }
            if(original.fingerprint.isNotBlank()) Panel {
                Hint("已固定主机指纹"); SelectionContainer { Text(original.fingerprint, fontFamily = FontFamily.Monospace) }
                TextButton(onClick = { confirmReset = true }) { Text(if(resetPin) "保存后将重新核对指纹" else "重置固定指纹", color = MaterialTheme.colorScheme.error) }
            }
            Button(onClick = {
                if(auth != original.auth && !replace) { vm.error = "切换认证方式时需要提供新凭据"; return@Button }
                if(replace && (if(auth == "key") key.isBlank() else password.isBlank())) { vm.error = "请填写认证凭据"; return@Button }
                vm.save(original.copy(name = name.trim(), host = host.trim(), port = port.toIntOrNull() ?: 0, username = user.trim(), group = group.trim().ifBlank { "默认" }, production = production, favorite = favorite, auth = auth, fingerprint = if(resetPin) "" else original.fingerprint),
                    if(replace) Credentials(password = if(auth == "password") password else "", privateKey = if(auth == "key") key else "", passphrase = if(auth == "key") passphrase else "") else null, onClose)
            }, modifier = Modifier.fillMaxWidth(), enabled = name.isNotBlank() && host.isNotBlank()) { Text("加密保存") }
            Hint("首次连接必须核对主机指纹。变更地址或端口会清除旧固定指纹并断开旧连接。")
        }
    }
    if(confirmReset) AlertDialog(onDismissRequest = { confirmReset = false }, title = { Text("重置主机信任？") }, text = { Text("仅在通过服务商控制台等可信渠道核实新密钥后使用。保存后断开旧连接，下次必须重新核对。") }, confirmButton = { TextButton(onClick = { resetPin = true; confirmReset = false }) { Text("已了解，标记重置") } }, dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("取消") } })
}

@Composable fun OperationDialog(server: Server, operation: Operation, onDismiss: () -> Unit, onExecute: () -> Unit) {
    var confirmed by remember { mutableStateOf(false) }; var typed by remember { mutableStateOf("") }
    val high = operation.risk == "高风险"
    AlertDialog(onDismissRequest = onDismiss, title = { Text(operation.title) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("目标：${server.name}\n${server.endpoint}", color = if(server.production) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            Text("风险：${operation.risk}")
            if(operation.explanation.isNotBlank()) Text(operation.explanation)
            SelectionContainer { Text(operation.command, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
            if(operation.risk != "只读") Row { Checkbox(confirmed, { confirmed = it }); Text("我确认在上述服务器执行", Modifier.padding(top = 12.dp)) }
            if(high) OutlinedTextField(typed, { typed = it }, label = { Text("输入服务器名称确认") }, singleLine = true)
            Hint("执行失败或超时时不自动重试；服务器端任务可能仍在运行。")
        }
    }, confirmButton = { Button(onClick = onExecute, enabled = (operation.risk == "只读" || confirmed) && (!high || typed == server.name)) { Text("执行") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable fun OutputDialog(title: String, output: ExecResult, onClose: () -> Unit) {
    FullDialog(title, onClose) { padding -> Column(Modifier.padding(padding).padding(16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("exit ${output.code} · ${if(output.code == 0) "执行完成" else "未成功，请检查输出"}", color = if(output.code == 0) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error)
        Hint("输出仅在当前页面保留，可能包含敏感信息。${if(output.truncated) "输出已截断。" else ""}")
        SelectionContainer(Modifier.weight(1f).verticalScroll(rememberScrollState())) { Text(output.output.ifBlank { "（没有输出）" }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    } }
}

@Composable fun FileEditor(edit: RemoteEdit, vm: DeckViewModel) {
    var text by remember(edit.file.path) { mutableStateOf(edit.original) }
    var nginx by remember { mutableStateOf(edit.file.path.startsWith("/etc/nginx/")) }
    var confirm by remember { mutableStateOf(false) }
    FullDialog("编辑 ${edit.file.name}", { vm.editor = null }, actions = { TextButton(onClick = { confirm = true }, enabled = text != edit.original) { Text("保存") } }) { padding ->
        Column(Modifier.padding(padding).padding(12.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Hint(edit.file.path); Hint("使用当前 SSH 用户权限；保存前校验原文件摘要并备份，不自动重载服务。")
            Row { Checkbox(nginx, { nginx = it }); Text("保存后 nginx -t；失败恢复原配置", Modifier.padding(top = 12.dp)) }
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().weight(1f), textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
    }
    if(confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("保存远端文件？") }, text = { Text("${edit.server.name}\n${edit.file.path}\n\n创建同目录 .vpsdeck-时间戳.bak 备份。文件若被其他操作修改，将拒绝覆盖。") }, confirmButton = { TextButton(onClick = { runCatching { vm.saveEdit(edit, text, nginx) }.onFailure { vm.error = it.message }; confirm = false }) { Text("备份并保存") } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text("取消") } })
}
