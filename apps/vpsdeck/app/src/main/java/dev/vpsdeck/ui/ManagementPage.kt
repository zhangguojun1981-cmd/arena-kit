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
    DiagnosticsPage(vm,server,{legacy=false},request)
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
