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
import org.json.JSONArray

@Composable fun ProjectsPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connected
    var sudo by remember(server.id) { mutableStateOf(false) }
    var selected by remember(server.id) { mutableStateOf<String?>(null) }
    var plan by remember(server.id) { mutableStateOf<ProjectPlan?>(null) }
    var registration by remember(server.id) { mutableStateOf(false) }
    var query by remember(server.id) { mutableStateOf("") }
    RemoteTaskRefresh(vm,server,sudo) {controller.load(server,sudo)}
    LaunchedEffect(server.id,online) { if(online) controller.load(server,sudo) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        ManagementHeading("Compose 项目", "发现原始项目 · 风险预览 · 独立远端任务 · 断线后查状态")
        if(!online) { Button(onClick={vm.connect(server)}) { ActionLabel("连接服务器") }; return@Column }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item { Panel {
                PrivilegeControl(sudo,enabled=!state.busy && plan==null && selected==null) {sudo=it}
                ActionGroup {
                    ActionGroup {
                        OutlinedButton(onClick={registration=true},enabled=!state.busy) {ActionLabel("登记已有目录")}
                        OutlinedButton(onClick={controller.load(server,sudo)},enabled=!state.busy) { ActionLabel("刷新项目") }
                        OutlinedButton(onClick={controller.load(server,sudo,true)},enabled=!state.busy) { ActionLabel("查询远端任务") }
                    }
                }
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
                OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("筛选项目")},singleLine=true)
            } }
            if(state.projects.isEmpty() && !state.busy) item { Hint("暂无项目。可登记已有Compose目录，或通过容器标签发现；不猜测路径，不自动重写配置。") }
            items(state.projects.filter { JSONObject(it).getString("name").contains(query,true) },key={JSONObject(it).getString("name")}) { raw ->
                val row = JSONObject(raw)
                Panel(Modifier.clickable(enabled=!state.busy) { selected=raw }) {
                    ResourceHeading(row.getString("name"),row.optString("status"),row.getString("directory"))
                    OutlinedButton(onClick={selected=raw},enabled=!state.busy) {ActionLabel("管理项目")}
                    Hint("查看服务、镜像与风险，再单独确认操作")
                }
            }
            item { SectionTitle("远端持久任务", "任务文件仅执行身份可访问；App退出后不自动重放。点查询刷新进度。") }
            items(state.jobs,key={JSONObject(it).getString("id")}) {raw -> RemoteJobCard(raw)}
        }
    }
    if(registration) {
        var name by remember {mutableStateOf("")}
        var directory by remember {mutableStateOf("/opt/")}
        var files by remember {mutableStateOf("")}
        AlertDialog(onDismissRequest={registration=false},title={Text("登记Compose目录")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
            Hint("不启动容器、不改写文件。先在文件页创建或编辑YAML；按原顺序填写已有配置绝对路径，每行一个。预览将校验Compose配置。")
            OutlinedTextField(name,{name=it},label={Text("项目名称")},singleLine=true)
            OutlinedTextField(directory,{directory=it},label={Text("原始工作目录")},singleLine=true)
            OutlinedTextField(files,{files=it},label={Text("配置文件绝对路径（每行一个）")})
        }},confirmButton={Button(enabled=!state.busy && name.isNotBlank() && files.isNotBlank(),onClick={
            val spec=JSONObject().put("name",name.trim()).put("directory",directory.trim()).put("files",JSONArray(files.lines().map {it.trim()}.filter {it.isNotEmpty()}))
            controller.preview(server,spec.toString(),"register",sudo) {registration=false;plan=it}
        }) {ActionLabel("校验并预览")}},dismissButton={TextButton(onClick={registration=false}) {ActionLabel("取消")}})
    }
    selected?.let { raw ->
        val row = JSONObject(raw)
        FullDialog("项目 · ${row.getString("name")}",{if(!state.busy) selected=null}) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("服务器：${server.name} · ${server.endpoint}")
                Text("目录：${row.getString("directory")}")
                val files = row.getJSONArray("files")
                for(i in 0 until files.length()) Text(files.getString(i))
                if(!row.optBoolean("managed")) {
                    for(i in 0 until files.length()) {
                        val path=files.getString(i)
                        Hint(path.substringAfterLast('/'))
                        OutlinedButton(onClick={selected=null;vm.page=2;vm.browse(path.substringBeforeLast('/').ifEmpty { "/" })},enabled=!state.busy && !controller.hasActive(server)) {ActionLabel("编辑配置文件")}
                    }
                    Hint("文件编辑会备份并检查原内容是否变化；保存后返回此项目预览，Compose配置校验通过后再单独确认应用。不会保存即部署。")
                }
                Hint("先验证原配置并显示服务风险；不会覆盖Compose文件，不删除卷。应用可能重新创建容器，停止会中断业务。仅支持已有镜像，不隐式执行build。")
                listOf("pull" to "预览拉取", "up" to "预览应用", "stop" to "预览停止").forEach { (action,label) ->
                    OutlinedButton(onClick={controller.preview(server,raw,action,sudo) { plan=it }},enabled=!state.busy && online && !(action=="pull" && row.optBoolean("managed"))) { ActionLabel(label) }
                }
                if(row.optBoolean("managed")) Hint("此项目固定本机镜像。更换/拉取镜像请用创建/重建面板；不要手改托管配置。")
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
            }
        }
    }
    plan?.let { value ->
        var confirmation by remember(value) { mutableStateOf("") }
        val info = JSONObject(value.result)
        AlertDialog(onDismissRequest={plan=null},title={Text("确认远端任务 · ${JobProtocol.action(value.action)}")},text={
            Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                Text("${server.name} · ${server.endpoint}")
                CopyButton(previewReport(info),"复制预览结果")
                JobProtocol.rows(info,"services").forEach { raw ->
                    val service = JSONObject(raw)
                    Text("${service.getString("name")} · ${service.optString("image")}")
                    Hint("特权：${service.optBoolean("privileged")} · 挂载：${service.optInt("mounts")} · 端口：${service.optInt("ports")}")
                }
                Text(if(value.action=="register") "仅登记现有路径和项目名，不部署、不拉取、不改写配置。配置校验成功不等于服务健康。" else info.getString("warning"))
                Text("将创建 /var/lib/vpsdeck-private/jobs 私有任务记录和按需systemd执行器，不开放端口。任务最长2小时；断线或超时不能当作成功，必须查询结果。")
                OutlinedTextField(confirmation,{confirmation=it},label={Text("输入项目名确认")},singleLine=true)
            }
        },confirmButton={Button(onClick={plan=null;selected=null;controller.submit(server,value,sudo)},enabled=online && !state.busy && confirmation==JSONObject(value.project).getString("name")) { ActionLabel("确认执行") }},dismissButton={TextButton(onClick={plan=null}) { ActionLabel("取消") }})
    }
}
