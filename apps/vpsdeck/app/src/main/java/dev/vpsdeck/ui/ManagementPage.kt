@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.BorderStroke
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.ui.Alignment
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
    val tab=vm.managementSection
    BackHandler(enabled=legacy || tab>=0) {if(legacy) legacy=false else vm.managementSection=-1}
    if(!legacy) {
        if(tab<0) ManagementHub {vm.managementSection=it}
        else Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal=8.dp),verticalAlignment=Alignment.CenterVertically) {
                TextButton(onClick={vm.managementSection=-1}) {Icon(Icons.Outlined.ArrowBack,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));ActionLabel("管理分类")}
                Text("/ ${managementTitles.getOrElse(tab) {"服务与容器"}}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(Modifier.weight(1f)) {when(tab) {
                1 -> WebsitesPage(vm,server)
                2 -> ProjectsPage(vm,server)
                3 -> EnvironmentPage(vm,server)
                4 -> DatabasesPage(vm,server)
                5 -> DeploymentsPage(vm,server)
                else -> ResourcePanel(vm,server,legacy={legacy=true})
            }}
        }
        return
    }
    var sudo by remember(server.id) { mutableStateOf(false) }
    val connected by vm.connected.collectAsState()
    fun run(block: () -> Operation) { runCatching { block().privileged(sudo) }.onSuccess(request).onFailure { vm.error = it.message } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        TextButton(onClick = { legacy = false }) { ActionLabel("← 返回资源管理面板") }
        SectionTitle("高级诊断 / 主机操作", "普通资源操作请用对应面板；这里保留原始诊断输出，不代表业务健康")
        if(server.id !in connected) { Button(onClick={vm.connect(server)},enabled=!vm.busy) {ActionLabel("连接")}; return@Column }
        Row { Switch(sudo,{sudo=it});Text("明确使用已有 sudo -n 授权") }
        Panel {
            SectionTitle("只读诊断")
            OutlinedButton(onClick={run {Operations.services}}) {ActionLabel("systemd原始列表")}
            OutlinedButton(onClick={run {Operations.dockerStats}}) {ActionLabel("容器资源快照")}
            OutlinedButton(onClick={run {Operations.dockerImages}}) {ActionLabel("镜像诊断")}
            OutlinedButton(onClick={run {Operations.dockerVolumes}}) {ActionLabel("卷与网络诊断")}
            OutlinedButton(onClick={run {Operations.nativeServices}}) {ActionLabel("原生运行时服务诊断")}
            OutlinedButton(onClick={run {Operations.nginxTest}}) {ActionLabel("Nginx完整配置检查")}
        }
        Panel {
            SectionTitle("非托管Nginx配置")
            Hint("不自动接管或覆盖。可在文件页编辑并备份，配置检查后再明确重载；输出成功不等于业务HTTP健康。")
            OutlinedButton(onClick={vm.page=2;vm.browse("/etc/nginx")}) {ActionLabel("浏览原始配置")}
            OutlinedButton(onClick={run {Operations.nginxReload}},enabled=!vm.app.projects.hasActive(server)) {ActionLabel("高级：检查并重载Nginx")}
        }
        Panel {
            SectionTitle("主机重启")
            Hint("会中断所有连接；断线不能作为重启成功。必须重新连接并核对运行时间。")
            OutlinedButton(onClick={run {Operations.reboot}},enabled=!vm.app.projects.hasActive(server)) {ActionLabel("重启服务器",color=MaterialTheme.colorScheme.error)}
        }
    }
}

@Composable fun ActionRow(labels: List<String>, action: (String) -> Unit) { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { labels.forEach { OutlinedButton(onClick = { action(it) }) { ActionLabel(it) } } } }


private val managementTitles=listOf("服务与容器","网站","Compose","环境","数据库","创建/重建")
@Composable fun ManagementHub(onSelect: (Int) -> Unit) {
    val descriptions=listOf("运行状态、自启与日志","站点、反向代理与证书","目录登记、配置与部署","运行时检测、分步安装","实例、账号与备份恢复","容器表单、配置快照")
    val icons=listOf(Icons.Outlined.Dns,Icons.Outlined.Language,Icons.Outlined.Layers,Icons.Outlined.Download,Icons.Outlined.Storage,Icons.Outlined.Widgets)
    LazyVerticalGrid(columns=GridCells.Adaptive(150.dp),contentPadding=PaddingValues(16.dp),
        horizontalArrangement=Arrangement.spacedBy(12.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        item(span={GridItemSpan(maxLineSpan)}) {SectionTitle("管理中心","按资源分类进入，不在首页执行变更")}
        items(managementTitles.size) { index ->
            Surface(onClick={onSelect(index)},shape=RoundedCornerShape(14.dp),color=MaterialTheme.colorScheme.surface,
                border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant)) {
                Column(Modifier.heightIn(min=140.dp).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                        Icon(icons[index],null,Modifier.size(24.dp),tint=MaterialTheme.colorScheme.primary)
                        Icon(Icons.Outlined.ChevronRight,null,Modifier.size(18.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(managementTitles[index],style=MaterialTheme.typography.titleMedium)
                    Hint(descriptions[index])
                }
            }
        }
        item(span={GridItemSpan(maxLineSpan)}) {Panel {
            SectionTitle("安全操作流程")
            Hint("选择资源  →  预览变更  →  明确确认  →  核验结果")
            Hint("高级诊断位于服务与容器页；终端保留在底部导航，不再作为日常管理入口。")
        }}
    }
}
