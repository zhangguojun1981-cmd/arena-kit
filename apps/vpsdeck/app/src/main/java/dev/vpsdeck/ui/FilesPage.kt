@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.vpsdeck.*
import dev.vpsdeck.data.Server

@Composable fun FilesPage(vm: DeckViewModel, server: Server) {
    var showPath by remember(server.id) { mutableStateOf(false) }
    var tools by remember(server.id) { mutableStateOf(false) }
    var sortMenu by remember(server.id) { mutableStateOf(false) }
    var path by remember(server.id, vm.currentPath) { mutableStateOf(vm.currentPath) }
    var activeFile by remember(server.id) { mutableStateOf<RemoteFile?>(null) }
    var download by remember(server.id) { mutableStateOf<RemoteFile?>(null) }
    var remove by remember(server.id) { mutableStateOf<RemoteFile?>(null) }
    var rename by remember(server.id) { mutableStateOf<RemoteFile?>(null) }
    var search by remember(server.id, vm.currentPath) { mutableStateOf("") }
    var sort by remember(server.id) { mutableStateOf("名称") }
    var createFile by remember(server.id) { mutableStateOf(false) }
    var chmod by remember(server.id) { mutableStateOf<RemoteFile?>(null) }
    var mode by remember(server.id) { mutableStateOf("") }
    var mkdir by remember(server.id) { mutableStateOf(false) }
    var entry by remember(server.id) { mutableStateOf("") }
    val context = LocalContext.current
    val createDocument = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if(uri != null && vm.selected?.id == server.id) download?.let { vm.download(it, uri) }
        download = null
    }
    var uploadLocation by remember(server.id) { mutableStateOf("") }
    val pickDocument = rememberLauncherForActivityResult(PrivateKeyDocument()) { uri ->
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
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal=8.dp)) {
            TextButton(onClick={vm.browse("/")},enabled=!vm.busy) { Text("根目录") }
            val pieces = vm.currentPath.split('/').filter { it.isNotEmpty() && it != "." }
            pieces.forEachIndexed { i, name -> TextButton(onClick={vm.browse("/"+pieces.take(i+1).joinToString("/"))},enabled=!vm.busy) { Text("/ $name") } }
        }
        OutlinedTextField(search,{search=it},Modifier.fillMaxWidth().padding(horizontal=16.dp),label={Text("筛选当前目录文件，不递归扫描")},singleLine=true)
        Row(Modifier.fillMaxWidth().padding(horizontal=8.dp),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
            TextButton(onClick={vm.browse(vm.currentPath.substringBeforeLast('/', "").ifBlank {"/"})},enabled=!vm.busy) {Icon(Icons.Outlined.ArrowUpward,null,Modifier.size(18.dp));Text("上一级")}
            Box {
                TextButton(onClick={sortMenu=true}) {Text("排序 · $sort")}
                DropdownMenu(sortMenu,{sortMenu=false}) {listOf("名称","大小","修改时间").forEach {label ->
                    DropdownMenuItem(text={Text(label)},onClick={sort=label;sortMenu=false})
                }}
            }
            IconButton(onClick={vm.browse()},enabled=!vm.busy) {Icon(Icons.Outlined.Refresh,"刷新目录")}
            Box {
                IconButton(onClick={tools=true}) {Icon(Icons.Outlined.MoreVert,"目录操作")}
                DropdownMenu(tools,{tools=false}) {
                    DropdownMenuItem(text={Text("新建文件")},enabled=!vm.busy,onClick={tools=false;entry="";createFile=true})
                    DropdownMenuItem(text={Text("新建目录")},enabled=!vm.busy,onClick={tools=false;entry="";mkdir=true})
                    DropdownMenuItem(text={Text("上传文件")},enabled=vm.currentPath.startsWith('/') && vm.transfer==null,onClick={tools=false;uploadLocation=vm.currentPath;pickDocument.launch(arrayOf("*/*"))})
                    DropdownMenuItem(text={Text("输入完整路径")},onClick={tools=false;showPath=!showPath})
                }
            }
        }
        if(showPath) OutlinedTextField(path,{path=it},Modifier.fillMaxWidth().padding(horizontal=16.dp),label={Text("远端路径")},singleLine=true,trailingIcon={IconButton(onClick={vm.browse(path)},enabled=!vm.busy) {Icon(Icons.Outlined.ArrowForward,"前往路径")}})
        vm.transfer?.let { text -> Row(Modifier.padding(horizontal = 16.dp)) { Text(text, Modifier.weight(1f)); TextButton(onClick = { vm.cancelTransfer() }) { Text("取消") } } }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if(vm.files.isEmpty() && !vm.busy) item { Panel { Text("此目录暂无条目"); Hint("也可能尚未完成读取，点击刷新获取实际结果。") } }
            val visible = vm.files.filter { it.name.contains(search,true) }.let { list ->
                when(sort) { "大小" -> list.sortedWith(compareByDescending<RemoteFile>{it.directory}.thenByDescending{it.size}); "修改时间" -> list.sortedWith(compareByDescending<RemoteFile>{it.directory}.thenByDescending{it.modified}); else -> list.sortedWith(compareByDescending<RemoteFile>{it.directory}.thenBy{it.name.lowercase()}) }
            }
            if(visible.isEmpty() && vm.files.isNotEmpty()) item { Text("没有符合筛选的文件") }
            items(visible, key = { it.path }) { file ->
                ListItem(modifier = Modifier.clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp)).clickable(enabled=!vm.busy) { if(file.directory && !file.link) vm.browse(file.path) else activeFile = file },
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
        if(!file.link && file.permissions and 0xe00 == 0) TextButton(onClick={chmod=file;mode=(file.permissions and 511).toString(8).padStart(3,'0');activeFile=null}) { Text("修改权限") }
        TextButton(onClick = { rename = file; entry = file.name; activeFile = null }) { Text("重命名") }
        TextButton(onClick = { remove = file; activeFile = null }) { Text("删除", color = MaterialTheme.colorScheme.error) }
    } }, confirmButton = { TextButton(onClick = { activeFile = null }) { Text("关闭") } }) }
    if(mkdir || rename != null || createFile) AlertDialog(onDismissRequest = { mkdir = false; rename = null; createFile = false }, title = { Text(if(mkdir) "新建目录" else if(createFile) "新建空文本文件" else "重命名") }, text = { OutlinedTextField(entry, { entry = it }, label = { Text("名称") }, singleLine = true) }, confirmButton = { TextButton(onClick = { runCatching { if(mkdir) vm.mkdir(entry) else if(createFile) vm.createTextFile(entry) else rename?.let { vm.rename(it, entry) } }.onFailure { vm.error = it.message }; mkdir = false; rename = null; createFile = false }) { Text("确认") } }, dismissButton = { TextButton(onClick = { mkdir = false; rename = null; createFile = false }) { Text("取消") } })
    remove?.let { file -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("删除远端条目？") }, text = { Text("${server.name}\n${file.path}\n\n不可撤销。非空目录会拒绝删除，不使用递归删除。") }, confirmButton = { TextButton(onClick = { vm.remove(file); remove = null }) { Text("确认删除", color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = { remove = null }) { Text("取消") } }) }
    chmod?.let { file -> AlertDialog(onDismissRequest={chmod=null},title={Text("修改远端权限？")},text={Column {
        Text("${server.name}\n${file.path}\n原权限：${file.mode}\n只修改该条目，不递归、不更改属主。")
        OutlinedTextField(mode,{mode=it.filter { c -> c in '0'..'7' }.take(3)},label={Text("三位权限，例如644或755")},singleLine=true)
    }},confirmButton={Button(onClick={vm.changePermissions(file,mode);chmod=null},enabled=mode.length==3) {Text("修改并核验")}},dismissButton={TextButton(onClick={chmod=null}) {Text("取消")}}) }

}
