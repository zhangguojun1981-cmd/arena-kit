@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.panel.*
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable fun ResourcePanel(vm: DeckViewModel, server: Server, legacy: () -> Unit) {
    val controller = vm.app.panel
    val states by controller.states.collectAsStateWithLifecycle()
    val state = states[server.id] ?: PanelState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    var query by remember(server.id, state.kind) { mutableStateOf("") }
    var onlyActive by remember(server.id, state.kind) { mutableStateOf(false) }
    var sudo by remember(server.id) { mutableStateOf(false) }
    var pending by remember(server.id) { mutableStateOf<Pair<Resource, ResourceAction>?>(null) }
    var showLogs by remember(server.id, state.detail?.id) { mutableStateOf(false) }
    var follow by remember(server.id, state.detail?.id) { mutableStateOf(false) }
    val owner = LocalLifecycleOwner.current
    val online = server.id in connected
    val busy = state.busy != null
    LaunchedEffect(server.id, online) { if(online) controller.load(server) }
    LaunchedEffect(follow, online, state.detail?.id) {
        if(follow && online && state.detail != null) owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while(true) { controller.logs(server); delay(3000) }
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        SectionTitle("服务与容器", "选择资源查看详情 · 操作后核验状态")
        if(!online) { Text("连接已断开，缓存不是实时状态"); Button(onClick = { vm.connect(server) }) { Text("连接服务器") }; return@Column }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ResourceKind.entries.forEach { kind -> FilterChip(selected = state.kind == kind, onClick = { controller.load(server, kind) }, enabled = !busy, label = { Text(kind.title) }) }
        }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("搜索名称或描述") })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            FilterChip(onlyActive, { onlyActive = !onlyActive }, label = { Text("仅运行中") })
            TextButton(onClick = { controller.load(server) }, enabled = !busy) { Text("刷新列表") }
        }
        state.loadedAt?.let { Hint("上次读取 ${SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(Date(it))} · ${state.rows.size} 个对象") }
        if(busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(state.busy.orEmpty()) }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        state.notice?.let { Text(it) }
        val rows = state.rows.filter { (!onlyActive || it.state in setOf("active", "running")) && (query.isBlank() || (it.name + it.summary).contains(query, true)) }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
            if(state.loaded && rows.isEmpty()) item { Panel { Text(if(state.rows.isEmpty()) "没有发现资源" else "没有符合筛选的资源") } }
            items(rows, key = { it.id }) { row ->
                ResourceCard(row, !busy) { controller.open(server, row) }
            }
        }
        TextButton(onClick = legacy, enabled = !busy) { Text("高级诊断 / 主机操作") }
    }
    state.detail?.let { row ->
        FullDialog(row.name, { if(!busy) { follow = false; controller.close(server) } }) { padding ->
            Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Hint("目标：${server.name} · ${server.endpoint}")
                if(!online) Text("已断开连接，下方为缓存；不可执行操作", color = MaterialTheme.colorScheme.error)
                Panel {
                    SectionTitle("当前状态：${row.state}")
                    if(row.summary.isNotBlank()) Text(row.summary)
                    if(row.enabled.isNotBlank()) Text("开机自启：${row.enabled}")
                    row.facts.forEach { (k, v) -> Text("$k：${v.ifBlank { "—" }}") }
                    if(busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(state.busy.orEmpty()) }
                    state.notice?.let { Text(it) }; state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
                Row { Switch(sudo, { sudo = it }, enabled = !busy); Spacer(Modifier.width(8.dp)); Text("显式使用 sudo -n（需已有免密权限）") }
                val actions = ResourceProtocol.actions(state.kind, row)
                if(actions.isEmpty()) Hint("当前状态不支持动作，或属于受保护的连接/核心服务。模板服务需先创建具体实例。")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    actions.forEach { action -> OutlinedButton(onClick = { follow = false; pending = row to action }, enabled = !busy && online) { Text(action.title) } }
                }
                OutlinedButton(onClick = { controller.open(server, row) }, enabled = !busy && online) { Text("重新读取详情") }
                HorizontalDivider()
                SectionTitle("日志", "最近200行，仅保留在当前进程；日志可能含敏感信息")
                Row {
                    TextButton(onClick = { showLogs = true; controller.logs(server) }, enabled = !busy && online) { Text("读取日志") }
                    Switch(follow, { follow = it; showLogs = true }, enabled = online && pending == null)
                    Text("每3秒刷新")
                }
                if(showLogs) {
                    var filter by remember(row.id) { mutableStateOf("") }
                    OutlinedTextField(filter, { filter = it }, Modifier.fillMaxWidth(), label = { Text("筛选已读取日志") })
                    SelectionContainer { Text(state.logs?.lineSequence()?.filter { it.contains(filter, true) }?.joinToString("\n") ?: "尚未读取日志", style = MaterialTheme.typography.bodySmall) }
                }
                Hint("操作不会因关闭页面而重新提交。详细历史可返回服务器首页的任务页查看。创建/重建与长任务在对应面板管理；此处只删除已停止容器，不强制删除，不删除卷。")
            }
        }
    }
    pending?.let { (row, action) ->
        var advanced by remember { mutableStateOf(false) }
        var deleteConfirmation by remember(row.id,action) { mutableStateOf("") }
        AlertDialog(onDismissRequest = { pending = null }, title = { Text("${action.title} ${row.name}？") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("服务器：${server.name}\n${server.endpoint}\n对象：${row.id}\n当前状态：${row.state}\n\n该操作可能中断依赖此资源的业务。不会删除持久化数据，不会自动重试。${if(sudo) "\n将使用 sudo -n，不提交密码。" else ""}")
                if(action==ResourceAction.REMOVE) { Text("容器可写层会被删除，卷不会被删除但可能变成未关联状态；请先备份业务数据。",color=MaterialTheme.colorScheme.error); OutlinedTextField(deleteConfirmation,{deleteConfirmation=it},label={Text("输入容器名称确认")},singleLine=true) }
                TextButton(onClick = { advanced = !advanced }) { Text("高级执行计划") }
                if(advanced) Text(ResourceProtocol.action(state.kind, row, action))
                Text("提交前重新核对资源状态；执行后读取真实状态，未通过核验不报成功。")
            }
        }, confirmButton = { Button(onClick = { pending = null; controller.act(server, row, action, sudo) }, enabled = !busy && online && (action!=ResourceAction.REMOVE || deleteConfirmation==row.name)) { Text("确认${action.title}") } }, dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } })
    }
}

/** Stateless resource row: clicking selects an object, never executes an operation. */
@Composable fun ResourceCard(row: Resource, enabled: Boolean, onOpen: () -> Unit) {
    Panel(Modifier.clickable(enabled=enabled,onClick=onOpen)) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            Text(row.name,Modifier.weight(1f),style=MaterialTheme.typography.titleSmall,maxLines=2,overflow=TextOverflow.Ellipsis)
            StatusBadge(row.state,positive=row.state in setOf("active","running"),danger=row.state in setOf("failed","dead","unhealthy"))
            Icon(Icons.Outlined.ChevronRight,null,Modifier.size(18.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if(row.summary.isNotBlank()) Text(row.summary,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=2,overflow=TextOverflow.Ellipsis)
        if(row.enabled.isNotBlank()) Hint("开机自启 · ${row.enabled}")
        row.facts["镜像"]?.let {Text(it,style=MaterialTheme.typography.labelSmall,maxLines=1,overflow=TextOverflow.Ellipsis)}
    }
}
