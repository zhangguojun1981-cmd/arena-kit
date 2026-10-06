package dev.vpsdeck.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** A resource index contains information, not a dashboard of mutation buttons. */
@Composable fun ResourceIndexRow(title: String, subtitle: String, status: String = "", enabled: Boolean = true, onOpen: () -> Unit) {
    Surface(shape=MaterialTheme.shapes.medium,color=MaterialTheme.colorScheme.surface) {
        ListItem(modifier=Modifier.clickable(enabled=enabled,onClick=onOpen),
            headlineContent={Text(title,maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.titleSmall)},
            supportingContent={Text(subtitle,maxLines=2,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.bodySmall)},
            trailingContent={Row(verticalAlignment=Alignment.CenterVertically) {
                if(status.isNotBlank()) Text(status,Modifier.widthIn(max=96.dp),maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Icon(Icons.Outlined.ChevronRight,"查看详情",Modifier.size(20.dp))
            }},colors=ListItemDefaults.colors(containerColor=MaterialTheme.colorScheme.surface))
    }
}

@Composable fun ResourceDetail(title: String, subtitle: String, status: String = "", content: @Composable ColumnScope.() -> Unit) {
    var open by remember(title) {mutableStateOf(false)}
    ResourceIndexRow(title,subtitle,status) {open=true}
    if(open) FullDialog(title,{open=false}) {padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement=Arrangement.spacedBy(12.dp),content=content)
    }
}

@Composable fun QuietAction(onClick: () -> Unit, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    TextButton(onClick=onClick,enabled=enabled,contentPadding=PaddingValues(horizontal=12.dp,vertical=4.dp),content=content)
}

data class ResourceMenuAction(val label: String, val enabled: Boolean = true, val run: () -> Unit)
@Composable fun ResourceActions(actions: List<ResourceMenuAction>) {
    if(actions.isEmpty()) return
    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
        val first=actions.first()
        QuietAction(first.run,first.enabled) {ActionLabel(first.label)}
        if(actions.size>1) {
            Spacer(Modifier.weight(1f))
            var open by remember {mutableStateOf(false)}
            Box {
                IconButton(onClick={open=true}) {Icon(Icons.Outlined.MoreHoriz,"更多操作")}
                DropdownMenu(open,{open=false}) {actions.drop(1).forEach {action ->
                    DropdownMenuItem(text={ActionLabel(action.label)},enabled=action.enabled,onClick={open=false;action.run()})
                }}
            }
        }
    }
}

@Composable fun ConnectionBadge(connected: Boolean, connecting: Boolean = false) {
    StatusBadge(if(connected) "在线 · SSH" else if(connecting) "连接中" else "离线 · SSH",positive=connected,danger=!connected && !connecting)
}

@Composable fun CollectionToolbar(count: Int, primary: String? = null, onPrimary: () -> Unit = {}, onRefresh: () -> Unit, enabled: Boolean = true, settings: @Composable () -> Unit = {}) {
    var showSettings by remember {mutableStateOf(false)}
    Column {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
            Text("$count 项",Modifier.weight(1f),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onClick=onRefresh,enabled=enabled) {Icon(Icons.Outlined.Refresh,"刷新",Modifier.size(20.dp))}
            if(primary!=null) QuietAction(onPrimary,enabled) {Icon(Icons.Outlined.Add,null,Modifier.size(16.dp));Spacer(Modifier.width(4.dp));ActionLabel(primary)}
            IconButton(onClick={showSettings=!showSettings},enabled=enabled) {Icon(Icons.Outlined.Tune,"显示执行设置",Modifier.size(20.dp))}
        }
        if(showSettings) settings()
    }
}
