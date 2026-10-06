@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.vpsdeck.RemoteFile

fun toggleFileSelection(paths: Set<String>, path: String): Set<String> = if(path in paths) paths-path else paths+path
fun matchesFileSnapshot(file: RemoteFile, directory: Boolean, link: Boolean, size: Long, modified: Long, permissions: Int): Boolean =
    directory==file.directory && link==file.link && size==file.size && modified==file.modified && permissions==file.permissions

@Composable fun SelectableFileRow(file: RemoteFile, selected: Boolean, selectionMode: Boolean, enabled: Boolean,
    onToggle: () -> Unit, onOpen: () -> Unit, onMenu: () -> Unit) {
    ListItem(modifier=Modifier.clip(RoundedCornerShape(10.dp)).combinedClickable(enabled=enabled,onLongClick=onToggle,
        onClick={if(selectionMode) onToggle() else onOpen()}),
        leadingContent={if(selectionMode) Checkbox(selected,{onToggle()},enabled=enabled) else Icon(if(file.link) Icons.Outlined.Link else if(file.directory) Icons.Outlined.Folder else Icons.Outlined.Description,null,tint=MaterialTheme.colorScheme.primary)},
        headlineContent={Text(file.name,maxLines=1,overflow=TextOverflow.Ellipsis)},
        supportingContent={Text("${file.mode} · ${if(file.directory) "目录" else bytes(file.size)}${if(file.link) " · 链接" else ""}",style=MaterialTheme.typography.labelSmall)},
        trailingContent={if(!selectionMode) IconButton(onClick=onMenu,enabled=enabled) {Icon(Icons.Outlined.MoreVert,"文件操作")}},
        colors=ListItemDefaults.colors(containerColor=if(selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface))
}
