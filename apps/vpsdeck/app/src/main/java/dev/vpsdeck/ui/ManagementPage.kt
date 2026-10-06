@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.ops.*

@Composable fun ManagementPage(vm: DeckViewModel, server: Server, request: (Operation) -> Unit) {
    var legacy by remember(server.id) { mutableStateOf(false) }
    var tab by remember(server.id) { mutableIntStateOf(0) }
    if(!legacy) {
        Column(Modifier.fillMaxSize()) {
            FlowRow(Modifier.padding(horizontal=16.dp), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                FilterChip(tab==0,{tab=0},label={Text("服务与容器")})
                FilterChip(tab==1,{tab=1},label={Text("网站")})
                FilterChip(tab==2,{tab=2},label={Text("Compose")})
                FilterChip(tab==3,{tab=3},label={Text("环境")})
                FilterChip(tab==4,{tab=4},label={Text("数据库")})
                FilterChip(tab==5,{tab=5},label={Text("创建/重建")})
            }
            Box(Modifier.weight(1f)) { when(tab) { 1 -> WebsitesPage(vm,server); 2 -> ProjectsPage(vm,server); 3 -> EnvironmentPage(vm,server); 4 -> DatabasesPage(vm,server); 5 -> DeploymentsPage(vm,server); else -> ResourcePanel(vm, server, legacy = { legacy = true }) } }
        }
        return
    }
    var sudo by remember(server.id) { mutableStateOf(false) }
    val connected by vm.connected.collectAsState()
    fun run(block: () -> Operation) { runCatching { block().privileged(sudo) }.onSuccess(request).onFailure { vm.error = it.message } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        TextButton(onClick = { legacy = false }) { Text("← 返回资源管理面板") }
        SectionTitle("高级诊断 / 主机操作", "普通资源操作请用对应面板；这里保留原始诊断输出，不代表业务健康")
        if(server.id !in connected) { Button(onClick={vm.connect(server)},enabled=!vm.busy) {Text("连接")}; return@Column }
        Row { Switch(sudo,{sudo=it});Text("明确使用已有 sudo -n 授权") }
        Panel {
            SectionTitle("只读诊断")
            OutlinedButton(onClick={run {Operations.services}}) {Text("systemd原始列表")}
            OutlinedButton(onClick={run {Operations.dockerStats}}) {Text("容器资源快照")}
            OutlinedButton(onClick={run {Operations.dockerImages}}) {Text("镜像诊断")}
            OutlinedButton(onClick={run {Operations.dockerVolumes}}) {Text("卷与网络诊断")}
            OutlinedButton(onClick={run {Operations.nativeServices}}) {Text("原生运行时服务诊断")}
            OutlinedButton(onClick={run {Operations.nginxTest}}) {Text("Nginx完整配置检查")}
        }
        Panel {
            SectionTitle("非托管Nginx配置")
            Hint("不自动接管或覆盖。可在文件页编辑并备份，配置检查后再明确重载；输出成功不等于业务HTTP健康。")
            OutlinedButton(onClick={vm.page=2;vm.browse("/etc/nginx")}) {Text("浏览原始配置")}
            OutlinedButton(onClick={run {Operations.nginxReload}},enabled=!vm.app.projects.hasActive(server)) {Text("高级：检查并重载Nginx")}
        }
        Panel {
            SectionTitle("主机重启")
            Hint("会中断所有连接；断线不能作为重启成功。必须重新连接并核对运行时间。")
            OutlinedButton(onClick={run {Operations.reboot}},enabled=!vm.app.projects.hasActive(server)) {Text("重启服务器",color=MaterialTheme.colorScheme.error)}
        }
    }
}

@Composable fun ActionRow(labels: List<String>, action: (String) -> Unit) { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { labels.forEach { OutlinedButton(onClick = { action(it) }) { Text(it) } } } }
