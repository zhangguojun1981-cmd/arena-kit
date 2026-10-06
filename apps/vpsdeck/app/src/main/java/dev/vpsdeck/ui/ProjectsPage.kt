@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.panel.*
import org.json.JSONObject

@Composable fun ProjectsPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connected
    var sudo by remember(server.id) { mutableStateOf(false) }
    var selected by remember(server.id) { mutableStateOf<String?>(null) }
    var plan by remember(server.id) { mutableStateOf<ProjectPlan?>(null) }
    var query by remember(server.id) { mutableStateOf("") }
    RemoteTaskRefresh(vm,server,sudo) {controller.load(server,sudo)}
    LaunchedEffect(server.id,online) { if(online) controller.load(server,sudo) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        SectionTitle("Compose 项目", "发现原始项目 · 风险预览 · 独立远端任务 · 断线后查状态")
        if(!online) { Button(onClick={vm.connect(server)}) { Text("连接服务器") }; return@Column }
        Row { Switch(sudo,{sudo=it},enabled=!state.busy && plan==null && selected==null); Text("明确使用已有 sudo -n 授权") }
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick={controller.load(server,sudo)},enabled=!state.busy) { Text("刷新项目") }
            OutlinedButton(onClick={controller.load(server,sudo,true)},enabled=!state.busy) { Text("查询远端任务") }
        }
        if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
        OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("筛选项目")},singleLine=true)
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            if(state.projects.isEmpty() && !state.busy) item { Hint("暂无已发现项目。只管理容器标签中记录的原始工作目录与配置；不猜测路径，不重写现有Compose文件。") }
            items(state.projects.filter { JSONObject(it).getString("name").contains(query,true) },key={JSONObject(it).getString("name")}) { raw ->
                val row = JSONObject(raw)
                Panel(Modifier.clickable(enabled=!state.busy) { selected=raw }) {
                    Text(row.getString("name"),style=MaterialTheme.typography.titleMedium)
                    Text(row.optString("status")); Text(row.getString("directory"))
                    Text("服务与风险 / 拉取 / 应用 / 停止 →",color=MaterialTheme.colorScheme.primary)
                }
            }
            item { SectionTitle("远端持久任务", "任务文件仅执行身份可访问；App退出后不自动重放。点查询刷新进度。") }
            items(state.jobs,key={JSONObject(it).getString("id")}) { raw ->
                val row = JSONObject(raw)
                Panel {
                    Text("${row.optString("project")} · ${JobProtocol.action(row.optString("action"))} · ${JobProtocol.state(row.optString("state"))}")
                    Text(row.optString("message")); Hint("任务ID：${row.getString("id")}")
                    JobProtocol.rows(row,"resources").forEach { value ->
                        val resource = JSONObject(value)
                        Text("${resource.optString("service")}：${resource.optString("state")} ${resource.optString("health")}")
                    }
                }
            }
        }
    }
    selected?.let { raw ->
        val row = JSONObject(raw)
        FullDialog("项目 · ${row.getString("name")}",{if(!state.busy) selected=null}) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("服务器：${server.name} · ${server.endpoint}")
                Text("目录：${row.getString("directory")}")
                val files = row.getJSONArray("files")
                for(i in 0 until files.length()) Text(files.getString(i))
                Hint("先验证原配置并显示服务风险；不会覆盖Compose文件，不删除卷。应用可能重新创建容器，停止会中断业务。仅支持已有镜像，不隐式执行build。")
                listOf("pull" to "预览并拉取镜像", "up" to "预览并应用配置", "stop" to "预览并停止服务").forEach { (action,label) ->
                    OutlinedButton(onClick={controller.preview(server,raw,action,sudo) { plan=it }},enabled=!state.busy && online) { Text(label) }
                }
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
            }
        }
    }
    plan?.let { value ->
        var confirmation by remember(value) { mutableStateOf("") }
        val info = JSONObject(value.result)
        AlertDialog(onDismissRequest={plan=null},title={Text("确认远端任务 · ${JobProtocol.action(value.action)}")},text={
            Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                Text("${server.name} · ${server.endpoint}")
                JobProtocol.rows(info,"services").forEach { raw ->
                    val service = JSONObject(raw)
                    Text("${service.getString("name")} · ${service.optString("image")}")
                    Hint("特权：${service.optBoolean("privileged")} · 挂载：${service.optInt("mounts")} · 端口：${service.optInt("ports")}")
                }
                Text(info.getString("warning"))
                Text("将创建 /var/lib/vpsdeck-private/jobs 私有任务记录和按需systemd执行器，不开放端口。任务最长2小时；断线或超时不能当作成功，必须查询结果。")
                OutlinedTextField(confirmation,{confirmation=it},label={Text("输入项目名确认")},singleLine=true)
            }
        },confirmButton={Button(onClick={plan=null;selected=null;controller.submit(server,value,sudo)},enabled=online && !state.busy && confirmation==JSONObject(value.project).getString("name")) { Text("确认执行") }},dismissButton={TextButton(onClick={plan=null}) { Text("取消") }})
    }
}
