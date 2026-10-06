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

@Composable fun EnvironmentPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connected
    var sudo by remember(server.id) { mutableStateOf(false) }
    var plan by remember(server.id) { mutableStateOf<ProjectPlan?>(null) }
    RemoteTaskRefresh(vm,server,sudo) {controller.loadEnvironments(server,sudo)}
    LaunchedEffect(server.id, online) { if(online) controller.loadEnvironments(server,sudo) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        ManagementHeading("环境与安装", "Debian 12 · 先预览再确认 · Docker分步安装向导")
        if(!online) { Button(onClick={vm.connect(server)}) { ActionLabel("连接服务器") }; return@Column }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item { Panel {
                CollectionToolbar(state.environments.size,onRefresh={controller.loadEnvironments(server,sudo)},enabled=!state.busy) {
                    PrivilegeControl(sudo,enabled=!state.busy && plan==null) {sudo=it}
                    QuietAction({controller.preview(server,JSONObject().put("kind","environment").put("name","apt-index").toString(),"install",sudo) {plan=it}},!state.busy) {ActionLabel("预览刷新索引")}
                }
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
            } }
            item { HelpDisclosure("此面板需要服务器已有Python3。安装可能自动启动服务或监听端口，不会自动放行防火墙。其他发行版不执行安装。Docker向导：1安装前置组件 → 2配置并校验官方源 → 3上方刷新索引 → 4预览安装。每一步独立确认，不运行curl安装脚本、不自动迁移发行版Docker。Docker可能改变网络规则，发布端口可能绕过ufw；不自动开放公网端口。") }
            if(state.environments.isEmpty() && !state.busy) item {Panel {Hint("暂无环境检测结果，请使用上方操作获取或创建资源")}}
            items(state.environments.sortedBy {listOf("docker-prerequisites","docker-repository","docker").indexOf(JSONObject(it).getString("name")).let { i -> if(i<0) 10 else i }},key={JSONObject(it).getString("name")}) { raw ->
                val row = JSONObject(raw)
                ResourceDetail(row.getString("title"),row.optString("platform"),if(JobProtocol.rows(row,"packages").any {JSONObject(it).optString("installed").isNotBlank()}) "已检测" else "待配置") {
                    Text(row.getString("title"),style=MaterialTheme.typography.titleMedium)
                    val packages=JobProtocol.rows(row,"packages")
                    val installed=packages.count {JSONObject(it).optString("installed").isNotBlank()}
                    StatusBadge(if(packages.isEmpty()) "源配置入口" else "$installed / ${packages.size} 软件包已配置",positive=packages.isNotEmpty() && installed==packages.size)
                    var expanded by remember(raw) {mutableStateOf(false)}
                    TextButton(onClick={expanded=!expanded}) {ActionLabel(if(expanded) "收起包详情" else "查看包详情")}
                    if(expanded) Hint(row.optString("platform"))
                    if(expanded) packages.forEach { p ->
                        val item = JSONObject(p)
                        Text("${item.getString("name")}：${item.optString("installed").ifEmpty { "未检测到已配置版本" }}")
                        Hint("候选版本：${item.optString("candidate").ifEmpty { "现有索引中无候选" }}")
                    }
                    QuietAction(onClick={controller.preview(server,raw,"install",sudo) { plan=it }},enabled=!state.busy && row.optBoolean("supported")) { ActionLabel(if(row.optString("name")=="docker-repository") "预览源配置" else "预览安装 / 升级") }
                }
            }
            item { SectionTitle("该主机远端任务"); QuietAction(onClick={controller.load(server,sudo,true)},enabled=!state.busy) { ActionLabel("查询最新进度") } }
            items(state.jobs,key={JSONObject(it).getString("id")}) {raw -> RemoteJobCard(raw)}
        }
    }
    plan?.let { p ->
        var confirmation by remember(p) { mutableStateOf("") }
        val result = JSONObject(p.result)
        AlertDialog(onDismissRequest={plan=null},title={Text("确认环境变更")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("${server.name} · ${server.endpoint}")
            CopyButton(previewReport(result),"复制预览结果")
            Text(result.getString("warning"))
            val changes = JobProtocol.rows(result,"services")
            if(changes.isEmpty()) Text("模拟未列出软件包变更；仍会执行所确认的校验/索引动作。")
            changes.forEach { raw -> val change=JSONObject(raw); Text("${change.getString("name")} → ${change.getString("image")}") }
            Text("任务独立运行，记录在服务器私有目录。失败、超时或断线不自动重试；若包管理被中断需人工核查，不能承诺回滚。")
            OutlinedTextField(confirmation,{confirmation=it},label={Text("输入服务器名称确认")},singleLine=true)
        }},confirmButton={Button(onClick={plan=null;controller.submit(server,p,sudo)},enabled=online && !state.busy && confirmation==server.name) {ActionLabel("确认执行")}},dismissButton={TextButton(onClick={plan=null}) {ActionLabel("取消")}})
    }
}
