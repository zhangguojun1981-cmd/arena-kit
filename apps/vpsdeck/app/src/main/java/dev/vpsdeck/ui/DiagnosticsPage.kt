package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.ops.*
import dev.vpsdeck.ssh.ExecResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable fun DiagnosticsPage(vm: DeckViewModel, server: Server, back: () -> Unit, request: (Operation) -> Unit) {
    val connected by vm.connected.collectAsState()
    var sudo by remember(server.id) {mutableStateOf(false)}
    var busy by remember(server.id) {mutableStateOf<String?>(null)}
    val results=remember(server.id) {mutableStateMapOf<String,ExecResult>()}
    val failures=remember(server.id) {mutableStateMapOf<String,String>()}
    var selected by remember(server.id) {mutableStateOf<String?>(null)}
    var hostTools by remember(server.id) {mutableStateOf(false)}
    val scope=rememberCoroutineScope()
    val checks=listOf(
        Triple("服务", "systemd 服务",Operations.services),
        Triple("服务", "原生运行时",Operations.nativeServices),
        Triple("容器", "资源占用快照",Operations.dockerStats),
        Triple("容器", "镜像清单",Operations.dockerImages),
        Triple("容器", "存储与网络",Operations.dockerVolumes),
        Triple("网站", "Nginx 配置校验",Operations.nginxTest))
    fun read(label: String, operation: Operation) {
        if(busy!=null || server.id !in connected) return
        selected=label;busy=label
        scope.launch {
            try {
                failures.remove(label)
                results[label]=vm.app.ssh.exec(server,operation.privileged(sudo).command)
            } catch(e: CancellationException) {throw e}
            catch(e: Exception) {failures[label]=e.message ?: "读取失败"}
            finally {busy=null}
        }
    }
    LazyColumn(Modifier.fillMaxSize(),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        item {QuietAction(back) {Icon(Icons.Outlined.ArrowBack,null,Modifier.size(18.dp));ActionLabel("返回服务")}}
        item {ManagementHeading("只读诊断","按需读取 · 结果仅反映此次检查，不代表业务健康")}
        item {Panel {
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {ConnectionBadge(server.id in connected);Text("${results.size} / ${checks.size} 已读取")}
            Hint(if(results.isEmpty()) "尚未采集。选择下方项目查看输出，不会批量执行。" else "历史结果是本页缓存；重新读取可更新。")
            if(server.id !in connected) QuietAction({vm.connect(server)},!vm.busy) {ActionLabel("连接服务器")}
            PrivilegeControl(sudo,enabled=busy==null) {sudo=it}
        }}
        checks.groupBy {it.first}.forEach { (group,items) ->
            item {SectionTitle(group)}
            items.forEach { (_,label,operation) -> item {
                Column {
                    ResourceIndexRow(label,when {busy==label -> "正在读取…"; failures.containsKey(label) -> "读取失败 · 点按重试";results.containsKey(label) -> "已保留结果 · 点按展开";else -> "尚未读取 · 点按检查"},
                        results[label]?.let {"exit ${it.code}"}.orEmpty()) {
                        if(results.containsKey(label) || failures.containsKey(label)) selected=if(selected==label) null else label else read(label,operation)
                    }
                    if(selected==label) Panel {
                        if(busy==label) LinearProgressIndicator(Modifier.fillMaxWidth())
                        results[label]?.let {CopyableOutput(it.output.ifBlank {"（没有输出）"},"诊断结果 · exit ${it.code}",error=it.code!=0);if(it.truncated) Hint("上游输出已截断，复制仅包含保留部分。")}
                        failures[label]?.let {CopyableOutput(it,"读取错误",error=true)}
                        QuietAction({read(label,operation)},busy==null && server.id in connected) {ActionLabel("重新读取")}
                    }
                }
            }}
        }
        item {HorizontalDivider();ResourceIndexRow("主机维护","非只读操作 · 与诊断分开，执行仍需确认") {hostTools=!hostTools}}
        if(hostTools) item {Panel {
            Hint("重载或重启可能中断业务。既有复杂Nginx配置不自动接管。")
            ResourceActions(listOf(
                ResourceMenuAction("浏览 Nginx 配置") {vm.page=2;vm.browse("/etc/nginx")},
                ResourceMenuAction("检查并重载 Nginx",server.id in connected && !vm.app.projects.hasActive(server)) {request(Operations.nginxReload.privileged(sudo))},
                ResourceMenuAction("重启服务器",server.id in connected && !vm.app.projects.hasActive(server)) {request(Operations.reboot.privileged(sudo))}
            ))
        }}
    }
}
