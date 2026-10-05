@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.vpsdeck.ui

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.vpsdeck.*
import dev.vpsdeck.data.Server

@Composable fun FilesPage(vm: DeckViewModel, server: Server) {
    var path by remember(server.id, vm.currentPath) { mutableStateOf(vm.currentPath) }
    var activeFile by remember { mutableStateOf<RemoteFile?>(null) }
    var download by remember { mutableStateOf<RemoteFile?>(null) }
    var remove by remember { mutableStateOf<RemoteFile?>(null) }
    var rename by remember { mutableStateOf<RemoteFile?>(null) }
    var mkdir by remember { mutableStateOf(false) }
    var entry by remember { mutableStateOf("") }
    val context = LocalContext.current
    val createDocument = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if(uri != null && vm.selected?.id == server.id) download?.let { vm.download(it, uri) }
        download = null
    }
    var uploadLocation by remember { mutableStateOf("") }
    val pickDocument = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if(uri != null && vm.selected?.id == server.id && vm.currentPath == uploadLocation) {
            runCatching {
                var name = "upload.bin"
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if(c.moveToFirst()) name = c.getString(0) ?: name }
                vm.upload(uri, name)
            }.onFailure { vm.error = it.message }
        }
    }
    val connected by vm.connected.collectAsState()
    LaunchedEffect(server.id, connected.contains(server.id)) { if(server.id in connected && vm.files.isEmpty()) vm.browse() }
    Column(Modifier.fillMaxSize()) {
        if(server.id !in connected) { Panel(Modifier.padding(20.dp)) { Text("SFTP 需要活动 SSH 连接"); Button(onClick = { vm.connect(server) }, enabled = !vm.busy) { Text("连接") } }; return@Column }
        OutlinedTextField(path, { path = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp), label = { Text("远端路径") }, singleLine = true, trailingIcon = { IconButton(onClick = { vm.browse(path) }, enabled = !vm.busy) { Icon(Icons.Outlined.ArrowForward, "前往路径") } })
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = { vm.browse(vm.currentPath.substringBeforeLast('/', "").ifBlank { "/" }) }, enabled = !vm.busy) { Text("上一级") }
            TextButton(onClick = { vm.browse() }, enabled = !vm.busy) { Text("刷新") }
            TextButton(onClick = { entry = ""; mkdir = true }) { Text("新建目录") }
            TextButton(onClick = { uploadLocation = vm.currentPath; pickDocument.launch(arrayOf("*/*")) }, enabled = vm.currentPath.startsWith('/') && vm.transfer == null) { Text("上传") }
        }
        vm.transfer?.let { text -> Row(Modifier.padding(horizontal = 16.dp)) { Text(text, Modifier.weight(1f)); TextButton(onClick = { vm.cancelTransfer() }) { Text("取消") } } }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if(vm.files.isEmpty() && !vm.busy) item { Panel { Text("此目录暂无条目"); Hint("也可能尚未完成读取，点击刷新获取实际结果。") } }
            items(vm.files, key = { it.path }) { file ->
                ListItem(modifier = Modifier.clickable { if(file.directory && !file.link) vm.browse(file.path) else activeFile = file },
                    leadingContent = { Icon(if(file.link) Icons.Outlined.Link else if(file.directory) Icons.Outlined.Folder else Icons.Outlined.Description, null, tint = if(file.directory) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
                    headlineContent = { Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text("${file.mode} · ${if(file.directory) "目录" else bytes(file.size)}${if(file.link) " · 链接" else ""}", style = MaterialTheme.typography.labelSmall) },
                    trailingContent = { IconButton(onClick = { activeFile = file }) { Icon(Icons.Outlined.MoreVert, "文件操作") } }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface))
            }
            item { Hint("上传拒绝覆盖已有目标；删除目录只允许空目录。权限依赖 SSH 用户，不静默提权。") }
        }
    }
    activeFile?.let { file -> AlertDialog(onDismissRequest = { activeFile = null }, title = { Text(file.name) }, text = { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(file.path)
        if(file.directory || file.link) TextButton(onClick = { vm.browse(file.path); activeFile = null }) { Text("尝试进入目录") }
        if(!file.directory && !file.link) {
            TextButton(onClick = { download = file; activeFile = null; createDocument.launch(file.name) }) { Text("下载到手机") }
            TextButton(onClick = { activeFile = null; vm.edit(file) }) { Text("编辑文本（最大512KB）") }
        }
        TextButton(onClick = { rename = file; entry = file.name; activeFile = null }) { Text("重命名") }
        TextButton(onClick = { remove = file; activeFile = null }) { Text("删除", color = MaterialTheme.colorScheme.error) }
    } }, confirmButton = { TextButton(onClick = { activeFile = null }) { Text("关闭") } }) }
    if(mkdir || rename != null) AlertDialog(onDismissRequest = { mkdir = false; rename = null }, title = { Text(if(mkdir) "新建目录" else "重命名") }, text = { OutlinedTextField(entry, { entry = it }, label = { Text("名称") }, singleLine = true) }, confirmButton = { TextButton(onClick = { runCatching { if(mkdir) vm.mkdir(entry) else rename?.let { vm.rename(it, entry) } }.onFailure { vm.error = it.message }; mkdir = false; rename = null }) { Text("确认") } }, dismissButton = { TextButton(onClick = { mkdir = false; rename = null }) { Text("取消") } })
    remove?.let { file -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("删除远端条目？") }, text = { Text("${server.name}\n${file.path}\n\n不可撤销。非空目录会拒绝删除，不使用递归删除。") }, confirmButton = { TextButton(onClick = { vm.remove(file); remove = null }) { Text("确认删除", color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = { remove = null }) { Text("取消") } }) }
}
