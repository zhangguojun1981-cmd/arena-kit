@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.activity.compose.BackHandler
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
    MaterialTheme(colorScheme = if(dark) DeckDark else DeckLight, typography = DeckTypography) {
        var rootTab by remember { mutableIntStateOf(0) }
        var edit by remember { mutableStateOf<Server?>(null) }
        var adding by remember { mutableStateOf(false) }
        var delete by remember { mutableStateOf<Server?>(null) }
        var pending by remember { mutableStateOf<Pair<Server, Operation>?>(null) }
        val servers by vm.servers.collectAsStateWithLifecycle()
        val tasks by vm.tasks.collectAsStateWithLifecycle()
        val connected by vm.connected.collectAsStateWithLifecycle()
        val server = vm.selected
        BackHandler(enabled=server!=null) {if(vm.page!=0) vm.page=0 else vm.home()}
        Scaffold(containerColor = MaterialTheme.colorScheme.background,
            topBar = { TopAppBar(title = {
                Column { Text(server?.name ?: "VPS Deck", style=MaterialTheme.typography.titleLarge); Text(server?.endpoint ?: "掌上运维工作台", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }, navigationIcon = { if(server != null) IconButton(onClick = { vm.home() }) { Icon(Icons.Outlined.ArrowBack, "返回服务器") } },
                actions = {
                    if(server != null) { IconButton(onClick = { edit = server }) { Icon(Icons.Outlined.Edit, "编辑服务器") }; IconButton(onClick = { if(server.id in connected) vm.disconnect(server) else vm.connect(server) }, enabled = !vm.busy) { Icon(if(server.id in connected) Icons.Outlined.LinkOff else Icons.Outlined.Link, "连接或断开") } }
                    else if(rootTab == 0) IconButton(onClick = { adding = true }) { Icon(Icons.Outlined.Add, "添加服务器") }
                }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) },
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
                    if(server == null) listOf("服务器" to Icons.Outlined.Dns, "任务" to Icons.Outlined.TaskAlt, "设置" to Icons.Outlined.Settings).forEachIndexed { index, item -> NavigationBarItem(selected = rootTab == index, onClick = { rootTab = index }, icon = { Icon(item.second, null) }, label = { Text(item.first) }) }
                    else listOf(Triple(0,"概览",Icons.Outlined.Dashboard),Triple(3,"管理",Icons.Outlined.Widgets),Triple(2,"文件",Icons.Outlined.Folder),Triple(1,"终端",Icons.Outlined.Terminal)).forEach { (index,label,icon) -> NavigationBarItem(selected=vm.page==index,onClick={if(index==3 && vm.page==3) vm.managementSection=-1;vm.page=index},icon={Icon(icon,null)},label={Text(label)}) }
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
        delete?.let { target -> AlertDialog(onDismissRequest = { delete = null }, title = { Text("移除 ${target.name}？") }, text = { Text("仅删除手机中的连接资料和加密凭据，断开该连接；不会删除 VPS 或远端数据。") }, confirmButton = { TextButton(onClick = { vm.delete(target); delete = null }) { ActionLabel("移除本机资料") } }, dismissButton = { TextButton(onClick = { delete = null }) { ActionLabel("取消") } }) }
        vm.challenge?.let { c -> AlertDialog(onDismissRequest = { vm.challenge = null }, title = { Text(if(c.changed) "主机指纹发生变化" else "核对 SSH 主机指纹") }, text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(c.server.endpoint); Text("算法：${c.algorithm}")
            SelectionContainer { Text(c.observed, fontFamily = FontFamily.Monospace) }
            if(c.changed) { Text("已保存：${c.server.fingerprint}"); Text("可能是服务器重装，也可能是中间人攻击。连接已拒绝，请从服务商控制台独立核对后，在编辑页面显式重置。", color = MaterialTheme.colorScheme.error) }
            else Text("请通过服务商控制台或可信渠道独立核对上述 SHA256 指纹。接受后固定保存，后续变化将阻止连接。")
        } }, confirmButton = { if(!c.changed) TextButton(onClick = { vm.trust() }) { ActionLabel("已核对，信任并连接") } else TextButton(onClick = { vm.challenge = null }) { ActionLabel("拒绝连接") } }, dismissButton = { if(!c.changed) TextButton(onClick = { vm.challenge = null }) { ActionLabel("取消") } }) }
        pending?.let { (target, op) -> OperationDialog(target, op, onDismiss = { pending = null }, onExecute = { vm.perform(target, op); pending = null }) }
        vm.error?.let { text -> AlertDialog(onDismissRequest = { vm.error = null }, title = { Text("操作提示") }, text = { CopyableOutput(text,"错误详情",error=true) }, confirmButton = { TextButton(onClick = { vm.error = null }) { ActionLabel("知道了") } }) }
        vm.result?.let { (title, output) -> OutputDialog(title, output) { vm.result = null } }
        vm.editor?.let { editFile -> FileEditor(editFile, vm) }
    }
}

@Composable private fun ServerList(servers: List<Server>, connected: Set<String>, onSelect: (Server) -> Unit, onEdit: (Server) -> Unit, onDelete: (Server) -> Unit, onAdd: () -> Unit) {
    var query by remember { mutableStateOf("") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("服务器资产", "SSH 直连 · 本机加密 · 无需远端面板") }
        item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Panel(Modifier.weight(1f)) { Text("${servers.size}", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Hint("已添加服务器") }
            Panel(Modifier.weight(1f)) { Text("${connected.size}", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.secondary, fontWeight = FontWeight.Bold); Hint("活动连接") }
        } }
        if(servers.isEmpty()) item { Panel {
            Icon(Icons.Outlined.Dns, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
            Text("你的第一台 VPS", style = MaterialTheme.typography.titleLarge)
            Text("添加主机地址与 SSH 认证方式，即可使用终端、文件和运维工具。不会自动安装任何软件。")
            Button(onClick = onAdd, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); ActionLabel("添加服务器") }
        } } else {
            item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("搜索名称、主机或分组") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, singleLine = true, shape = RoundedCornerShape(16.dp)) }
            val filtered = servers.filter { query.isBlank() || "${it.name} ${it.host} ${it.group}".contains(query, true) }
            if(filtered.isEmpty()) item { Hint("没有匹配的服务器") }
            filtered.groupBy {it.group}.forEach { (group, members) ->
            item(key="group:$group") {SectionTitle(group,"${members.size} 台服务器")}
            items(members, key = { it.id }) { s ->
                Surface(onClick = { onSelect(s) }, shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surface) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primaryContainer) { Icon(Icons.Outlined.Dns, null, Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.primary) }
                            Spacer(Modifier.width(12.dp)); Column(Modifier.weight(1f)) { Text(s.name, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium); Text(s.endpoint, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            var menu by remember { mutableStateOf(false) }; Box { IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "服务器操作") }; DropdownMenu(menu, { menu = false }) { DropdownMenuItem(text = { Text("编辑连接") }, onClick = { menu = false; onEdit(s) }); DropdownMenuItem(text = { Text("移除本机资料") }, onClick = { menu = false; onDelete(s) }) } }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("${s.group} · ${if(s.production) "生产" else "常规"}", style = MaterialTheme.typography.labelMedium, color = if(s.production) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant); Text(if(s.id in connected) "● 已连接" else "○ 未连接", style = MaterialTheme.typography.labelMedium, color = if(s.id in connected) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
            }
        }
        item { Hint("主机是否在线以实际连接为准。未连接不等于 VPS 离线。") }
    }
}

@Composable private fun Overview(vm: DeckViewModel, server: Server, connected: Boolean) {
    val owner=LocalLifecycleOwner.current
    LaunchedEffect(server,connected) {if(connected) owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {while(true) {vm.refresh(server);delay(15_000)}}}
    val s=vm.snapshot
    val history=vm.metricHistory[server.id].orEmpty()
    fun manage(section: Int) {vm.managementSection=section;vm.page=3}
    LazyColumn(Modifier.fillMaxSize(),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            SectionTitle("运行概览",s?.let {"最近采样 ${time(it.sampled)}"} ?: "尚未采样")
            StatusBadge(if(connected) "SSH 已连接" else "未连接",connected)
        }}
        if(!connected) item {Panel {
            Text("连接后查看实时资源",style=MaterialTheme.typography.titleMedium)
            Hint("下方已有数据仅为历史采样；连接不会安装软件。")
            Button(onClick={vm.connect(server)},enabled=!vm.busy,modifier=Modifier.fillMaxWidth()) {Icon(Icons.Outlined.Link,null);Spacer(Modifier.width(8.dp));ActionLabel("安全连接")}
        }}
        vm.snapshotError?.let {error -> item {Panel {CopyableOutput(error,"采样错误",error=true)}}}
        item {Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            MetricTrendCard("CPU",s?.cpuPercent,history.map {it.sampled to it.cpuPercent},Modifier.weight(1f))
            MetricTrendCard("内存",s?.memoryUsedPercent,history.map {it.sampled to it.memoryUsedPercent},Modifier.weight(1f))
        }}
        item {Hint(if(history.isEmpty()) "尚无趋势数据；不会用模拟曲线填充。" else "${time(history.first().sampled)} — ${time(history.last().sampled)} · ${history.size}次采样 · 缺测不连线")}
        item {Panel {
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(16.dp)) {
                DiskRing(s?.diskUsedPercent)
                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                    SectionTitle("根分区磁盘","实际使用率 · 不包含其他挂载点")
                    Hint(if(s?.diskUsedPercent==null) "尚无磁盘数据" else if(s.diskUsedPercent>85f) "空间使用率较高，建议核查" else "在文件面板查看目录与文件")
                }
                IconButton(onClick={vm.page=2}) {Icon(Icons.Outlined.Folder,"打开文件")}
            }
        }}
        item {Panel {
            SectionTitle("网络吞吐","两次有效采样计算，不含 lo 回环")
            Row(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {Hint("↓ 接收");Text(s?.rxPerSecond?.let {"${bytes(it)}/s"} ?: "—",style=MaterialTheme.typography.titleMedium)}
                Column(Modifier.weight(1f)) {Hint("↑ 发送");Text(s?.txPerSecond?.let {"${bytes(it)}/s"} ?: "—",style=MaterialTheme.typography.titleMedium)}
            }
            val scale=history.flatMap {listOfNotNull(it.rxPerSecond,it.txPerSecond)}.maxOrNull()?.toFloat()?.coerceAtLeast(1f) ?: 1f
            Box {
                TrendChart("网络接收",history.map {it.sampled to it.rxPerSecond?.toFloat()},MaterialTheme.colorScheme.primary,scale)
                TrendChart("网络发送",history.map {it.sampled to it.txPerSecond?.toFloat()},MaterialTheme.colorScheme.secondary,scale)
            }
            Hint("蓝色 接收 · 绿色 发送 · 当前纵轴上限 ${bytes(scale.toLong())}/s")
        }}
        item {SectionTitle("常用管理","从资源列表进入详情，变更仍需单独确认")}
        item {Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick={manage(0)},modifier=Modifier.weight(1f)) {ActionLabel("服务 / 容器")}
            OutlinedButton(onClick={manage(1)},modifier=Modifier.weight(1f)) {ActionLabel("网站")}
            OutlinedButton(onClick={manage(4)},modifier=Modifier.weight(1f)) {ActionLabel("数据库")}
        }}
        item {Panel {
            SectionTitle("系统信息")
            DetailRow("系统",s?.os?.ifBlank {"—"} ?: "—")
            DetailRow("内核",s?.kernel?.ifBlank {"—"} ?: "—")
            DetailRow("负载",s?.load?.ifBlank {"—"} ?: "—")
            val seconds=s?.uptime?.toDoubleOrNull()
            DetailRow("运行时间",seconds?.let {"${(it/86400).toInt()} 天 ${(it%86400/3600).toInt()} 小时"} ?: "—")
            DetailRow("环境",if(server.production) "生产环境" else "常规环境")
        }}
        item {Panel {
            var expanded by remember(server.id) {mutableStateOf(false)}
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
                SectionTitle("工具清单","${s?.capabilities?.size ?: 0} 项已发现")
                TextButton(onClick={expanded=!expanded}) {ActionLabel(if(expanded) "收起" else "展开")}
            }
            if(expanded) {
                s?.capabilities?.sorted()?.forEach {DetailRow(it,"已发现命令")}
                Hint("发现命令不等于具备权限或服务健康；安装请进入环境面板。")
                OutlinedButton(onClick={manage(3)}) {ActionLabel("打开环境面板")}
            }
        }}
        item {Hint("仅前台每15秒读取 · 当前进程最多40次采样 · 断线不重放操作")}
    }
}

@Composable private fun TaskList(tasks: List<TaskRecord>) {
    var filter by remember {mutableIntStateOf(0)}
    val active=setOf("运行中","远端排队","远端执行中","提交待确认")
    val filtered=tasks.filter {when(filter) {1 -> it.state in active;2 -> it.state!="成功" && it.state !in active;else -> true}}
    LazyColumn(contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        item {SectionTitle("任务记录","最近 ${tasks.size} 条 · 结果未知时不自动重试")}
        item {Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("全部","进行中","需关注").forEachIndexed {i,label -> FilterChip(filter==i,{filter=i},label={ActionLabel(label)})}
        }}
        if(filtered.isEmpty()) item {Panel {Text("暂无符合条件的任务");Hint("完成资源操作后，状态会记录在这里。")}}
        items(filtered,key={it.id}) {t -> Panel {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Text(t.label,Modifier.weight(1f),style=MaterialTheme.typography.titleSmall)
                StatusBadge(t.state,positive=t.state=="成功",danger=t.state !in active && t.state!="成功")
            }
            Hint("${t.serverName} · ${time(t.started)}${t.exitCode?.let {" · exit $it"} ?: ""}")
            if(t.detail.isNotBlank()) {
                var expanded by remember(t.id) {mutableStateOf(false)}
                TextButton(onClick={expanded=!expanded},contentPadding=PaddingValues(0.dp)) {ActionLabel(if(expanded) "收起记录" else "查看记录")}
                if(expanded) CopyableOutput(t.detail,"任务记录")
            }
        }}
        item {Hint("仅保存元信息，不持久化终端内容、命令输出或密码。")}
    }
}
@Composable private fun Settings(vm: DeckViewModel) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Panel { SectionTitle("外观"); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(vm.dark == null, { vm.dark = null }, label = { ActionLabel("系统") }); FilterChip(vm.dark == true, { vm.dark = true }, label = { ActionLabel("深色") }); FilterChip(vm.dark == false, { vm.dark = false }, label = { ActionLabel("浅色") }) } }
        Panel { SectionTitle("安全与隐私"); Text("凭据使用 Android Keystore 加密，仅存于本机私有目录。系统备份与截图已禁用。首次 SSH 连接核对指纹，后续变化拒绝连接。"); Hint("不采集遥测，不使用中央服务器。任务记录不保存完整输出。复制输出或粘贴内容由你主动决定。") }
        Panel { SectionTitle("连接与后台"); Text("活动 SSH 连接通过前台通知保持。安卓系统仍可能终止后台运行；长任务请在 VPS 中使用 tmux。应用不会自动重放断线前的命令。"); OutlinedButton(onClick = { vm.app.closeAll(); vm.app.stopService(Intent(vm.app, dev.vpsdeck.ssh.ConnectionService::class.java)) }) { ActionLabel("断开全部 SSH 连接") } }
        Panel { SectionTitle("VPS Deck ${BuildConfig.VERSION_NAME}"); Text("原生 Android · SSH / SFTP · Linux 运维"); Hint("终端使用 Termux v0.118.0 仿真器与渲染器。SSH 使用 mwiede JSch。源码按 GPL-3.0 提供，完整许可和依赖说明随源码交付。"); TextButton(onClick = { vm.app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.gnu.org/licenses/gpl-3.0.html")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }) { ActionLabel("查看 GPL-3.0 许可") } }
    }
}
