@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

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
import java.util.UUID
import java.text.DateFormat
import java.util.Date

@Composable fun DeploymentsPage(vm: DeckViewModel, server: Server) {
    val controller=vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state=all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online=server.id in connected
    var sudo by remember(server.id) {mutableStateOf(false)}
    var editor by remember(server.id) {mutableStateOf<String?>(null)}
    var plan by remember(server.id) {mutableStateOf<ProjectPlan?>(null)}
    var query by remember(server.id) {mutableStateOf("")}
    RemoteTaskRefresh(vm,server,sudo) {controller.loadDeployments(server,sudo)}
    LaunchedEffect(server.id,online) {if(online) controller.loadDeployments(server,sudo)}
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        ManagementHeading("创建与重建", "表单创建容器和Compose项目 · 固定镜像ID · 配置快照 · 保留命名卷")
        if(!online) {Button(onClick={vm.connect(server)}) {ActionLabel("连接服务器")};return@Column}
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item { Panel {
                PrivilegeControl(sudo,enabled=!state.busy && editor==null && plan==null) {sudo=it}
                ActionGroup {
                    Button(onClick={editor=JSONObject().put("operation","create-container").put("id",UUID.randomUUID().toString().replace("-","")).toString()},enabled=!state.busy) {ActionLabel("新建部署")}
                    OutlinedButton(onClick={controller.loadDeployments(server,sudo)},enabled=!state.busy) {ActionLabel("刷新")}
                }
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
                OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("筛选App托管部署")},singleLine=true)
            } }
            item {HelpDisclosure("仅重建本面板创建的单服务项目。既有容器仍在服务与容器页管理；不无损反推复杂容器，不覆盖外部改动。镜像拉取与应用分开确认，不删除卷。")}
            if(state.deployments.isEmpty() && !state.busy) item {Panel {Hint("暂无托管部署，请使用上方操作获取或创建资源")}}
            items(state.deployments.filter {JSONObject(it).getString("name").contains(query,true)},key={JSONObject(it).getString("name")}) {raw ->
                val row=JSONObject(raw)
                Panel {
                    ResourceHeading(row.getString("name"),row.optString("phase"),row.optString("image"))
                    row.optJSONObject("runtime")?.let {runtime -> Text("实际状态：${runtime.optString("state")} · ${runtime.optString("health")}");Hint("容器ID：${runtime.optString("id")}")}
                    if(row.has("notice")) CopyableOutput(row.getString("notice"),"部署提示",error=true)
                    OutlinedButton(onClick={editor=JSONObject(raw).put("operation","rebuild-container").put("expected",row.getString("revision")).toString()},enabled=!state.busy && row.has("revision")) {ActionLabel("预览重建")}
                    var snapshotsOpen by remember(row.getString("name")) {mutableStateOf(false)}
                    TextButton(onClick={snapshotsOpen=!snapshotsOpen}) {ActionLabel("配置快照 (${JobProtocol.rows(row,"backups").size}) · ${if(snapshotsOpen) "收起" else "展开"}")}
                    if(snapshotsOpen) Hint("仅恢复配置，不回滚数据；每次恢复需预览和确认。")
                    if(snapshotsOpen) JobProtocol.rows(row,"backups").sortedByDescending {JSONObject(it).optLong("created")}.forEach {value ->
                        val backup=JSONObject(value)
                        Text("配置快照：${DateFormat.getDateTimeInstance().format(Date(backup.getLong("created")*1000))}\n${backup.getString("image")} · ${backup.getString("phase")}")
                        TextButton(onClick={val spec=JSONObject().put("kind","deployment").put("operation","restore-container").put("name",row.getString("name")).put("expected",row.getString("revision")).put("backup",backup.getString("id"));controller.preview(server,spec.toString(),"restore-container",sudo) {plan=it}},enabled=!state.busy) {ActionLabel("预览恢复配置")}
                    }
                }
            }
            item {SectionTitle("远端任务");OutlinedButton(onClick={controller.load(server,sudo,true)},enabled=!state.busy) {ActionLabel("查询最新进度")}}
            items(state.jobs,key={JSONObject(it).getString("id")}) {raw -> RemoteJobCard(raw)}
        }
    }
    editor?.let {seed -> DeploymentEditor(seed,state.busy,state.error,{editor=null}) {spec -> controller.preview(server,spec,JSONObject(spec).getString("operation"),sudo) {plan=it}}}
    plan?.let {p ->
        val spec=JSONObject(p.project)
        var confirmation by remember(p) {mutableStateOf("")}
        val target=if(p.action=="pull-image") spec.getString("image") else spec.getString("name")
        AlertDialog(onDismissRequest={plan=null},title={Text(if(p.action=="pull-image") "确认拉取镜像" else "确认创建 / 重建")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("${server.name} · ${server.endpoint}\n目标：$target")
            JobProtocol.rows(JSONObject(p.result),"services").forEach {raw -> val row=JSONObject(raw);Text("镜像：${row.optString("image")} · 挂载：${row.optInt("mounts")} · 发布端口：${row.optInt("ports")}")}
            if(spec.optBoolean("publish")) Text("发布 ${spec.optString("bind")}:${spec.optString("hostPort")} → 容器 ${spec.optString("containerPort")}")
            if(p.action!="pull-image") {Text("镜像ID：${JSONObject(p.result).optString("previousImageID")} → ${JSONObject(p.result).optString("newImageID")}");Text("${JSONObject(p.result).optString("binding")} · 卷路径：${JSONObject(p.result).optString("volumePath")}")}
            CopyButton(previewReport(JSONObject(p.result)),"复制预览结果")
            Text(JSONObject(p.result).getString("warning"))
            Text("凭据不会进入SSH命令行；环境变量保存在服务器私有配置，Docker管理员仍能查看它们。重建前请单独备份业务数据。")
            OutlinedTextField(confirmation,{confirmation=it},label={Text("输入目标名称确认")},singleLine=true)
        }},confirmButton={Button(onClick={plan=null;if(p.action!="pull-image") editor=null;controller.submit(server,p,sudo)},enabled=online && !state.busy && confirmation==target) {ActionLabel("确认执行")}},dismissButton={TextButton(onClick={plan=null}) {ActionLabel("取消")}})
    }
}

@Composable fun DeploymentEditor(seed: String, busy: Boolean, error: String?, close: () -> Unit, preview: (String) -> Unit) {
    val initial=remember(seed) {JSONObject(seed)}
    val create=initial.getString("operation")=="create-container"
    var name by remember(seed) {mutableStateOf(initial.optString("name"))}
    var image by remember(seed) {mutableStateOf(initial.optString("image","nginx:alpine"))}
    var memory by remember(seed) {mutableStateOf("512")}
    var cpus by remember(seed) {mutableStateOf("1")}
    var publish by remember(seed) {mutableStateOf(false)}
    var publicPort by remember(seed) {mutableStateOf(false)}
    var hostPort by remember(seed) {mutableStateOf("8080")}
    var containerPort by remember(seed) {mutableStateOf("80")}
    var volume by remember(seed) {mutableStateOf(false)}
    var volumePath by remember(seed) {mutableStateOf("/data")}
    var environment by remember(seed) {mutableStateOf("")}
    var command by remember(seed) {mutableStateOf("")}
    var restart by remember(seed) {mutableStateOf("unless-stopped")}
    FullDialog(if(create) "新建容器与Compose项目" else "重建 · $name",{if(!busy) close()}) {padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name,{name=it},Modifier.fillMaxWidth(),label={Text("容器名称（小写）")},singleLine=true,enabled=create && !busy)
            OutlinedTextField(image,{image=it},Modifier.fillMaxWidth(),label={Text("镜像引用")},singleLine=true,enabled=!busy)
            OutlinedButton(onClick={preview(JSONObject().put("kind","deployment").put("name",image).put("operation","pull-image").put("image",image).toString())},enabled=!busy) {ActionLabel("预览拉取镜像")}
            if(create) {
                OutlinedTextField(memory,{memory=it},Modifier.fillMaxWidth(),label={Text("内存上限MiB（128–32768）")},singleLine=true,enabled=!busy)
                OutlinedTextField(cpus,{cpus=it},Modifier.fillMaxWidth(),label={Text("CPU上限（0.1–16）")},singleLine=true,enabled=!busy)
                Row {Switch(publish,{publish=it},enabled=!busy);Text("发布一个TCP端口")}
                if(publish) {
                    Row {Switch(publicPort,{publicPort=it},enabled=!busy);Text("监听0.0.0.0（关闭则仅127.0.0.1）")}
                    OutlinedTextField(hostPort,{hostPort=it},Modifier.fillMaxWidth(),label={Text("宿主机端口")},singleLine=true,enabled=!busy)
                    OutlinedTextField(containerPort,{containerPort=it},Modifier.fillMaxWidth(),label={Text("容器端口")},singleLine=true,enabled=!busy)
                }
                Row {Switch(volume,{volume=it},enabled=!busy);Text("创建专用持久化命名卷（不绑定宿主机路径）")}
                if(volume) OutlinedTextField(volumePath,{volumePath=it},Modifier.fillMaxWidth(),label={Text("容器内持久数据路径")},singleLine=true,enabled=!busy)
                Hint("数据库镜像须选对数据目录（如postgres:16的/var/lib/postgresql/data、MySQL的/var/lib/mysql）；容器层/匿名卷不等于可靠备份。")
                OutlinedTextField(environment,{environment=it},Modifier.fillMaxWidth(),label={Text("环境变量，每行KEY=VALUE（不会回显到任务输出）")},minLines=3,enabled=!busy)
                OutlinedTextField(command,{command=it},Modifier.fillMaxWidth(),label={Text("可选启动参数，每行一个；留空用镜像默认CMD")},minLines=2,enabled=!busy)
                FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {listOf("unless-stopped","no","always","on-failure").forEach {value -> FilterChip(restart==value,{restart=value},label={ActionLabel(value)},enabled=!busy)}}
            } else Hint("仅替换镜像；保留原端口、环境变量、卷、资源限制及启动参数。环境变量不会回传手机。旧配置/镜像会保留，但不回滚数据。")
            error?.let { CopyableOutput(it,"错误详情",error=true) }
            if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Button(onClick={val spec=JSONObject(seed).put("kind","deployment").put("name",name).put("image",image);if(create) spec.put("memory",memory).put("cpus",cpus).put("publish",publish).put("bind",if(publicPort) "0.0.0.0" else "127.0.0.1").put("hostPort",hostPort).put("containerPort",containerPort).put("volume",volume).put("volumePath",volumePath).put("environment",environment).put("command",command).put("restart",restart);preview(spec.toString())},enabled=!busy) {ActionLabel("预览部署与风险")}
        }
    }
}
