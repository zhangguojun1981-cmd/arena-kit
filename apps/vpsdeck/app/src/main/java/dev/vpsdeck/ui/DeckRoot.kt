@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.vpsdeck.*
import dev.vpsdeck.data.*
import dev.vpsdeck.ops.*
import kotlinx.coroutines.delay
import java.util.Locale

@Composable fun DeckRoot(vm: DeckViewModel) {
    val dark = vm.dark ?: isSystemInDarkTheme()
    MaterialTheme(colorScheme = if(dark) DeckDark else DeckLight) {
        var rootTab by remember { mutableIntStateOf(0) }
        var edit by remember { mutableStateOf<Server?>(null) }
        var adding by remember { mutableStateOf(false) }
        var delete by remember { mutableStateOf<Server?>(null) }
        var pending by remember { mutableStateOf<Pair<Server, Operation>?>(null) }
        val servers by vm.servers.collectAsStateWithLifecycle()
        val tasks by vm.tasks.collectAsStateWithLifecycle()
        val connected by vm.connected.collectAsStateWithLifecycle()
        val server = vm.selected
        Scaffold(containerColor = MaterialTheme.colorScheme.background,
            topBar = { TopAppBar(title = {
                Column { Text(server?.name ?: "VPS Deck", fontWeight = FontWeight.Bold); Text(server?.endpoint ?: "掌上运维工作台", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }, navigationIcon = { if(server != null) IconButton(onClick = { vm.home() }) { Icon(Icons.Outlined.ArrowBack, "返回服务器") } },
                actions = {
                    if(server != null) { IconButton(onClick = { edit = server }) { Icon(Icons.Outlined.Edit, "编辑服务器") }; IconButton(onClick = { if(server.id in connected) vm.disconnect(server) else vm.connect(server) }, enabled = !vm.busy) { Icon(if(server.id in connected) Icons.Outlined.LinkOff else Icons.Outlined.Link, "连接或断开") } }
                    else if(rootTab == 0) IconButton(onClick = { adding = true }) { Icon(Icons.Outlined.Add, "添加服务器") }
                }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) },
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    if(server == null) listOf("服务器" to Icons.Outlined.Dns, "任务" to Icons.Outlined.TaskAlt, "设置" to Icons.Outlined.Settings).forEachIndexed { index, item -> NavigationBarItem(selected = rootTab == index, onClick = { rootTab = index }, icon = { Icon(item.second, null) }, label = { Text(item.first) }) }
                    else listOf("概览" to Icons.Outlined.Dashboard, "终端" to Icons.Outlined.Terminal, "文件" to Icons.Outlined.Folder, "管理" to Icons.Outlined.Tune).forEachIndexed { index, item -> NavigationBarItem(selected = vm.page == index, onClick = { vm.page = index }, icon = { Icon(item.second, null) }, label = { Text(item.first) }) }
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                if(server == null) when(rootTab) {
                    0 -> ServerList(servers, connected, { vm.choose(it) }, { edit = it }, { delete = it }, { adding = true })
                    1 -> TaskList(tasks)
                    else -> Settings(vm)
                } else when(vm.page) {
                    0 -> Overview(vm, server, server.id in connected)
                    1 -> TerminalPage(vm, server)
                    2 -> FilesPage(vm, server)
                    else -> ManagementPage(vm, server) { op -> pending = server to op }
                }
                if(vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
        if(adding || edit != null) ServerDialog(edit, vm, onClose = { adding = false; edit = null })
        delete?.let { target -> AlertDialog(onDismissRequest = { delete = null }, title = { Text("移除 ${target.name}？") }, text = { Text("仅删除手机中的连接资料和加密凭据，断开该连接；不会删除 VPS 或远端数据。") }, confirmButton = { TextButton(onClick = { vm.delete(target); delete = null }) { Text("移除本机资料") } }, dismissButton = { TextButton(onClick = { delete = null }) { Text("取消") } }) }
        vm.challenge?.let { c -> AlertDialog(onDismissRequest = { vm.challenge = null }, title = { Text(if(c.changed) "主机指纹发生变化" else "核对 SSH 主机指纹") }, text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(c.server.endpoint); Text("算法：${c.algorithm}")
            SelectionContainer { Text(c.observed, fontFamily = FontFamily.Monospace) }
            if(c.changed) { Text("已保存：${c.server.fingerprint}"); Text("可能是服务器重装，也可能是中间人攻击。连接已拒绝，请从服务商控制台独立核对后，在编辑页面显式重置。", color = MaterialTheme.colorScheme.error) }
            else Text("请通过服务商控制台或可信渠道独立核对上述 SHA256 指纹。接受后固定保存，后续变化将阻止连接。")
        } }, confirmButton = { if(!c.changed) TextButton(onClick = { vm.trust() }) { Text("已核对，信任并连接") } else TextButton(onClick = { vm.challenge = null }) { Text("拒绝连接") } }, dismissButton = { if(!c.changed) TextButton(onClick = { vm.challenge = null }) { Text("取消") } }) }
        pending?.let { (target, op) -> OperationDialog(target, op, onDismiss = { pending = null }, onExecute = { vm.perform(target, op); pending = null }) }
        vm.error?.let { text -> AlertDialog(onDismissRequest = { vm.error = null }, title = { Text("操作提示") }, text = { SelectionContainer { Text(text) } }, confirmButton = { TextButton(onClick = { vm.error = null }) { Text("知道了") } }) }
        vm.result?.let { (title, output) -> OutputDialog(title, output) { vm.result = null } }
        vm.editor?.let { editFile -> FileEditor(editFile, vm) }
    }
}

@Composable private fun ServerList(servers: List<Server>, connected: Set<String>, onSelect: (Server) -> Unit, onEdit: (Server) -> Unit, onDelete: (Server) -> Unit, onAdd: () -> Unit) {
    var query by remember { mutableStateOf("") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text("掌控每一台服务器", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold); Spacer(Modifier.height(8.dp)); Hint("SSH 直连 · 无需安装面板 · 凭据本机加密") }
        item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Panel(Modifier.weight(1f)) { Text("${servers.size}", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Hint("已添加服务器") }
            Panel(Modifier.weight(1f)) { Text("${connected.size}", style = MaterialTheme.typography.headlineMedium, color = DeckGreen, fontWeight = FontWeight.Bold); Hint("活动连接") }
        } }
        if(servers.isEmpty()) item { Panel {
            Icon(Icons.Outlined.Dns, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
            Text("你的第一台 VPS", style = MaterialTheme.typography.titleLarge)
            Text("添加主机地址与 SSH 认证方式，即可使用终端、文件和运维工具。不会自动安装任何软件。")
            Button(onClick = onAdd, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("添加服务器") }
        } } else {
            item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("搜索名称、主机或分组") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true, shape = RoundedCornerShape(16.dp)) }
            val filtered = servers.filter { query.isBlank() || "${it.name} ${it.host} ${it.group}".contains(query, true) }
            if(filtered.isEmpty()) item { Hint("没有匹配的服务器") }
            items(filtered, key = { it.id }) { s ->
                Surface(onClick = { onSelect(s) }, shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer) { Icon(Icons.Outlined.Dns, null, Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.primary) }
                            Spacer(Modifier.width(12.dp)); Column(Modifier.weight(1f)) { Text(s.name, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium); Text(s.endpoint, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            var menu by remember { mutableStateOf(false) }; Box { IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "服务器操作") }; DropdownMenu(menu, { menu = false }) { DropdownMenuItem(text = { Text("编辑连接") }, onClick = { menu = false; onEdit(s) }); DropdownMenuItem(text = { Text("移除本机资料") }, onClick = { menu = false; onDelete(s) }) } }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("${s.group} · ${if(s.production) "生产" else "常规"}", style = MaterialTheme.typography.labelMedium, color = if(s.production) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant); Text(if(s.id in connected) "● 已连接" else "○ 未连接", style = MaterialTheme.typography.labelMedium, color = if(s.id in connected) DeckGreen else MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
        item { Hint("主机是否在线以实际连接为准。未连接不等于 VPS 离线。") }
    }
}

@Composable private fun Overview(vm: DeckViewModel, server: Server, connected: Boolean) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(server.id, connected) { if(connected) owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while(true) { vm.refresh(server); delay(15_000) } } }
    val s = vm.snapshot
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Panel {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(if(server.production) "生产环境" else "常规环境", color = if(server.production) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary); Text(if(connected) "● 已连接" else "○ 未连接", color = if(connected) DeckGreen else MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(if(s?.os.isNullOrBlank()) "等待环境探测" else s!!.os, style = MaterialTheme.typography.titleLarge)
            Hint(s?.kernel?.ifBlank { "系统信息暂不可用" } ?: "连接后只读识别系统，不自动安装软件")
            Button(onClick = { if(connected) vm.page = 1 else vm.connect(server) }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) { Icon(if(connected) Icons.Outlined.Terminal else Icons.Outlined.Link, null); Spacer(Modifier.width(8.dp)); Text(if(connected) "打开终端" else "安全连接") }
        }
        vm.snapshotError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { MetricCard("CPU", s?.cpuPercent, Modifier.weight(1f)); MetricCard("内存", s?.memoryUsedPercent, Modifier.weight(1f)) }
        MetricCard("根分区磁盘", s?.diskUsedPercent, Modifier.fillMaxWidth())
        Panel { SectionTitle("网络与运行状态"); Text("接收  ${bytes(s?.rxPerSecond)}/s      发送  ${bytes(s?.txPerSecond)}/s", fontFamily = FontFamily.Monospace); Hint("CPU和网络速率需要两次有效采样，不含 lo 回环。")
            HorizontalDivider(); Text("负载   ${s?.load?.ifBlank { "—" } ?: "—"}"); val seconds = s?.uptime?.toDoubleOrNull(); Text("运行   ${if(seconds != null) "${(seconds / 86400).toInt()} 天 ${(seconds % 86400 / 3600).toInt()} 小时" else "—"}")
            Hint("采样：${s?.let { time(it.sampled) } ?: "尚未采集"} · 前台每15秒更新") }
        Panel { SectionTitle("已发现工具", "发现命令不等于当前用户有执行权限")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { s?.capabilities?.forEach { AssistChip(onClick = { vm.page = 3 }, label = { Text(it) }) } }
            if(s?.capabilities.isNullOrEmpty()) Hint("连接后显示可用工具；未知环境可通过终端自行检查。")
        }
    }
}
@Composable private fun MetricCard(title: String, value: Float?, modifier: Modifier) { Panel(modifier) { Hint(title); Text(value?.let { String.format(Locale.ROOT, "%.1f%%", it) } ?: "—", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold); LinearProgressIndicator(progress = { (value ?: 0f) / 100f }, modifier = Modifier.fillMaxWidth(), color = if((value ?: 0f) > 85) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) } }

@Composable private fun TaskList(tasks: List<TaskRecord>) {
    LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("操作记录", "仅保留最近200条元信息，不持久化终端内容、命令输出或密码") }
        if(tasks.isEmpty()) item { Panel { Icon(Icons.Outlined.TaskAlt, null); Text("还没有执行任务"); Hint("通过管理页面或文件页面执行操作后，结果会出现在这里。") } }
        items(tasks, key = { it.id }) { t -> Panel { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(t.serverName, color = MaterialTheme.colorScheme.primary); Text(t.state, color = if(t.state == "成功") DeckGreen else if(t.state == "运行中") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }; Text(t.label, fontWeight = FontWeight.SemiBold); Hint("${time(t.started)}${t.exitCode?.let { " · exit $it" } ?: ""}"); if(t.detail.isNotBlank()) Hint(t.detail) } }
    }
}
@Composable private fun Settings(vm: DeckViewModel) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Panel { SectionTitle("外观"); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(vm.dark == null, { vm.dark = null }, label = { Text("系统") }); FilterChip(vm.dark == true, { vm.dark = true }, label = { Text("深色") }); FilterChip(vm.dark == false, { vm.dark = false }, label = { Text("浅色") }) } }
        Panel { SectionTitle("安全与隐私"); Text("凭据使用 Android Keystore 加密，仅存于本机私有目录。系统备份与截图已禁用。首次 SSH 连接核对指纹，后续变化拒绝连接。"); Hint("不采集遥测，不使用中央服务器。任务记录不保存完整输出。复制输出或粘贴内容由你主动决定。") }
        Panel { SectionTitle("连接与后台"); Text("活动 SSH 连接通过前台通知保持。安卓系统仍可能终止后台运行；长任务请在 VPS 中使用 tmux。应用不会自动重放断线前的命令。"); OutlinedButton(onClick = { vm.app.closeAll(); vm.app.stopService(Intent(vm.app, dev.vpsdeck.ssh.ConnectionService::class.java)) }) { Text("断开全部 SSH 连接") } }
        Panel { SectionTitle("VPS Deck 0.1.0"); Text("原生 Android · SSH / SFTP · Linux 运维"); Hint("终端使用 Termux v0.118.0 仿真器与渲染器。SSH 使用 mwiede JSch。源码按 GPL-3.0 提供，完整许可和依赖说明随源码交付。"); TextButton(onClick = { vm.app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.gnu.org/licenses/gpl-3.0.html")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }) { Text("查看 GPL-3.0 许可") } }
    }
}
