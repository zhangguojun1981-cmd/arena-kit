package dev.vpsdeck

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.*
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.SftpException
import com.jcraft.jsch.SftpProgressMonitor
import dev.vpsdeck.data.*
import dev.vpsdeck.ops.*
import dev.vpsdeck.ssh.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.security.MessageDigest
import java.util.UUID

data class RemoteFile(val name: String, val path: String, val directory: Boolean, val link: Boolean, val size: Long, val mode: String, val permissions: Int = 0, val modified: Long = 0)
data class RemoteEdit(val server: Server, val file: RemoteFile, val original: String, val digest: String)

class DeckViewModel(application: Application) : AndroidViewModel(application) {
    val app = application as DeckApp
    private val dao = app.database.dao()
    val servers = dao.servers().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val tasks = dao.tasks().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val connected = app.ssh.connected
    var selected by mutableStateOf<Server?>(null); private set
    var page by mutableStateOf(0)
    var managementSection by mutableIntStateOf(-1)
    val metricHistory = mutableStateMapOf<String, List<Snapshot>>()
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var challenge by mutableStateOf<HostChallenge?>(null)
    var snapshot by mutableStateOf<Snapshot?>(null); private set
    var snapshotError by mutableStateOf<String?>(null); private set
    private val snapshots = mutableMapOf<String, Snapshot>()
    var files by mutableStateOf<List<RemoteFile>>(emptyList()); private set
    var currentPath by mutableStateOf("."); private set
    var editor by mutableStateOf<RemoteEdit?>(null)
    var result by mutableStateOf<Pair<String, ExecResult>?>(null)
    var transfer by mutableStateOf<String?>(null); private set
    var shellVersion by mutableIntStateOf(0); private set
    private var transferJob: Job? = null
    var dark by mutableStateOf<Boolean?>(null)
    fun home() { selected = null }
    fun choose(server: Server) { selected = server; managementSection = -1; snapshot = snapshots[server.id]; files = emptyList(); currentPath = "."; page = 0; snapshotError = null }
    fun save(server: Server, credentials: Credentials?, onSaved: () -> Unit) = viewModelScope.launch {
        try {
            require(server.name.isNotBlank() && server.name.length <= 100) { "请输入服务器名称" }
            require(server.host.isNotBlank() && !server.host.any { it.isWhitespace() || it == '/' || it == '\u0000' }) { "主机填写域名或 IP，不含协议与空格" }
            require(server.port in 1..65535) { "端口范围 1–65535" }
            require(server.username.matches(Regex("[A-Za-z0-9_.@-]{1,80}"))) { "SSH 用户名无效" }
            val old = dao.server(server.id)
            val changed = old != null && (old.host != server.host || old.port != server.port || old.username != server.username || old.auth != server.auth)
            if(credentials != null) withContext(Dispatchers.IO) { app.vault.put(server.id, credentials) }
            val saved = if(old != null && (old.host != server.host || old.port != server.port)) server.copy(fingerprint = "") else server
            dao.save(saved)
            if(changed || old?.fingerprint != saved.fingerprint) {
                snapshots.remove(server.id); metricHistory.remove(server.id)
                if(selected?.id==server.id) snapshot=null
            }
            if(changed || credentials != null || old?.fingerprint != saved.fingerprint) app.closeServer(server.id)
            if(selected?.id == saved.id) selected = saved
            onSaved()
        } catch(e: Exception) { error = e.message ?: "保存失败" }
    }
    fun delete(server: Server) = viewModelScope.launch {
        try { app.closeServer(server.id); withContext(Dispatchers.IO) { app.vault.delete(server.id) }; dao.delete(server.id); snapshots.remove(server.id); metricHistory.remove(server.id); if(selected?.id == server.id) selected = null }
        catch(e: Exception) { error = e.message }
    }
    fun connect(server: Server? = selected) {
        if(server == null) return
        if(busy) return
        if(server.id in app.connecting.value) return
        busy = true
        app.connecting.value = app.connecting.value + server.id
        // Start while the user's connect gesture is still foreground, before slow SSH authentication.
        try { ContextCompat.startForegroundService(app, Intent(app, ConnectionService::class.java)) }
        catch(e: Exception) {app.connecting.value=app.connecting.value-server.id;busy=false;error="无法启动后台连接服务：${e.message}";return}
        app.connectionAttempts[server.id]=app.appScope.launch {
            try {
                app.ssh.connect(server)
                if(selected?.id == server.id) selected = server
                refresh(server)
            } catch(c: HostChallenge) { challenge = c }
            catch(e: CancellationException) {throw e}
            catch(e: Exception) { error = "连接失败：${e.message ?: e.javaClass.simpleName}" }
            finally {
                if(app.connectionAttempts[server.id]===currentCoroutineContext()[Job]) {
                    app.connectionAttempts.remove(server.id);app.connecting.value=app.connecting.value-server.id
                }
                busy = false
            }
        }
    }

    fun trust() {
        val c = challenge ?: return
        if(c.changed) { error = "已固定指纹发生变化，不能在连接窗口直接接受；请先独立核对服务器。"; return }
        challenge = null
        viewModelScope.launch { val saved = c.server.copy(fingerprint = c.observed); dao.save(saved); if(selected?.id == saved.id) selected = saved; connect(saved) }
    }
    fun disconnect(server: Server? = selected) { if(server == null) return; app.closeServer(server.id); shellVersion++; if(app.ssh.connected.value.isEmpty() && app.connecting.value.isEmpty()) app.stopService(Intent(app, ConnectionService::class.java)) }
    suspend fun refresh(server: Server? = selected) {
        if(server == null) return
        if(!app.ssh.isConnected(server.id)) return
        try {
            val r = app.ssh.exec(server, Metrics.command, 20)
            if(r.code != 0) throw IllegalStateException("指标采集返回 ${r.code}")
            if(dao.server(server.id) != server) return // Never chart a response under a changed/deleted host identity.
            val snap = Metrics.parse(r.output, System.currentTimeMillis(), snapshots[server.id]); snapshots[server.id] = snap
            metricHistory[server.id] = ((metricHistory[server.id] ?: emptyList()) + snap).takeLast(40)
            if(selected?.id == server.id) { snapshot = snap; snapshotError = null }
        } catch(e: CancellationException) { throw e }
        catch(e: Exception) { if(selected?.id == server.id) snapshotError = "更新失败：${e.message}；下方可能为历史采样" }
    }
    fun newShell(): ShellSession? {
        val server = selected ?: return null
        if(!app.ssh.isConnected(server.id)) { error = "请先连接服务器"; return null }
        if(app.terminals.size >= 8) { error = "最多同时保留 8 个终端，请关闭不需要的会话"; return null }
        val shell = ShellSession(server, app.ssh, app.appScope); app.terminals[shell.id] = shell; shell.open(); shellVersion++; return shell
    }
    fun closeShell(id: String) { app.terminals.remove(id)?.close(); shellVersion++ }
    fun perform(server: Server, operation: Operation) {
        app.appScope.launch {
            val task = TaskRecord(serverId = server.id, serverName = server.name, label = operation.title)
            dao.task(task)
            try {
                val r = app.ssh.exec(server, operation.command, operation.timeoutSeconds)
                dao.task(task.copy(state = if(r.code == 0) "成功" else "失败", exitCode = r.code, detail = if(r.truncated) "输出较长，本次显示已截断；未持久化原始输出。" else "原始输出仅在本次页面显示。"))
                result = operation.title to r
            } catch(e: Exception) {
                dao.task(task.copy(state = "中断", detail = "连接异常或超时，远端结果未知，请核对状态。"))
                error = "${operation.title}：${e.message}。远端结果可能未知，请勿直接重复破坏操作。"
            } finally { dao.trimTasks() }
        }
    }
    private fun supportedPath(path: String): String {
        require(!path.any { it == '\u0000' || it == '*' || it == '?' || it == '\\' }) { "该路径含 SFTP 通配符或反斜杠，请使用终端处理，避免选错文件" }; return path
    }
    fun browse(path: String = currentPath) {
        val server = selected ?: return
        if(busy) return; busy = true
        viewModelScope.launch {
            try {
                val listing = app.ssh.sftp(server) { s ->
                    val full = s.realpath(supportedPath(path)); val values = s.ls(supportedPath(full))
                    full to values.filterIsInstance<ChannelSftp.LsEntry>().filter { it.filename !in listOf(".", "..") }.map { RemoteFile(it.filename, full.trimEnd('/') + "/" + it.filename, it.attrs.isDir, it.attrs.isLink, it.attrs.size, it.attrs.permissionsString, it.attrs.permissions, (it.attrs.mTime.toLong() and 0xffffffffL) * 1000) }.sortedWith(compareByDescending<RemoteFile> { it.directory }.thenBy { it.name.lowercase() })
                }
                if(selected?.id == server.id) { currentPath = listing.first; files = listing.second }
            } catch(e: Exception) { error = "文件读取失败：${e.message}" } finally { busy = false }
        }
    }
    fun mkdir(name: String) {
        val server = selected ?: return; val path = Shell.child(currentPath, name)
        fileTask(server, "新建目录") { app.ssh.sftp(server) { it.mkdir(supportedPath(path)) } }
    }
    fun remove(file: RemoteFile) { val server = selected ?: return; fileTask(server, "删除 ${file.name}") { app.ssh.sftp(server) { if(file.directory && !file.link) it.rmdir(supportedPath(file.path)) else it.rm(supportedPath(file.path)) } } }
    fun rename(file: RemoteFile, name: String) {
        val server = selected ?: return; val to = Shell.child(currentPath, name)
        fileTask(server, "重命名 ${file.name}") { app.ssh.sftp(server) { s ->
            try { s.lstat(supportedPath(to)); error("目标已存在，拒绝覆盖") } catch(e: SftpException) { if(e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e }
            s.rename(supportedPath(file.path), supportedPath(to))
        } }
    }
    private fun fileTask(server: Server, label: String, work: suspend () -> Unit) {
        app.appScope.launch {
            val task = TaskRecord(serverId = server.id, serverName = server.name, label = label); dao.task(task)
            try { work(); dao.task(task.copy(state = "成功", exitCode = 0)); if(selected?.id == server.id) browse() }
            catch(e: Exception) { dao.task(task.copy(state = "失败", detail = "SFTP 操作未完成，请核对远端状态。")); error = "$label：${e.message}" }
            finally { dao.trimTasks() }
        }
    }
    fun createTextFile(name: String) {
        val server = selected ?: return
        val path = Shell.child(currentPath, name)
        fileTask(server, "新建文件 $name") {
            supportedPath(path)
            val temp = Shell.child(path.substringBeforeLast('/'), ".vpsdeck-${UUID.randomUUID()}.new")
            val r = app.ssh.exec(server, "(umask 077; set -C; : > ${Shell.quote(temp)}) || exit 71; ln -T -- ${Shell.quote(temp)} ${Shell.quote(path)}; code=\$?; rm -- ${Shell.quote(temp)}; exit \$code")
            check(r.code == 0) { "目标已存在或没有写权限；未覆盖文件" }
        }
    }
    fun changePermissions(file: RemoteFile, octal: String) {
        val server = selected ?: return
        require(octal.matches(Regex("[0-7]{3}"))) { "请输入三位普通权限，例如644或755" }
        require(!file.link && file.permissions and 0xe00 == 0) { "符号链接或特殊权限文件请使用高级工具处理" }
        val wanted = octal.toInt(8)
        fileTask(server,"修改权限 ${file.name}") {
            app.ssh.sftp(server) { s ->
                val path = supportedPath(file.path); val before = s.lstat(path)
                check(!before.isLink && before.permissions == file.permissions) { "文件权限或类型已变化，请刷新后重试" }
                s.chmod(wanted,path)
                val after = s.lstat(path)
                check(!after.isLink && after.permissions and 511 == wanted) { "权限核验失败，请刷新检查" }
            }
        }
    }
    var fileSnapBusy by mutableStateOf(false); private set
    var fileSnapMeta by mutableStateOf<dev.vpsdeck.ops.FileIndex.Meta?>(null); private set
    var fileHits by mutableStateOf<List<dev.vpsdeck.ops.FileIndex.Hit>>(emptyList()); private set
    var fileSnapNote by mutableStateOf(""); private set
    private var fileSnapJob: Job? = null
    fun fileSnapshot(server: Server, root: String, maxEntries: String) {
        if(fileSnapBusy) return
        val parsed=runCatching {dev.vpsdeck.ops.FileIndex.maxEntries(maxEntries)}
        if(parsed.isFailure) {error=parsed.exceptionOrNull()?.message;return}
        val n=parsed.getOrThrow()
        fileSnapBusy=true;fileSnapNote="正在服务器端建立索引（不传输文件内容）…";fileHits=emptyList()
        fileSnapJob=app.appScope.launch {
            val record=TaskRecord(serverId=server.id,serverName=server.name,label="建立文件快照")
            try {
                dao.task(record)
                val r=app.ssh.exec(server,dev.vpsdeck.ops.FileIndex.buildCommand(root,n),300)
                check(r.code==0) {"索引建立失败（exit ${r.code}）：${r.output.take(300)}"}
                fileSnapMeta=dev.vpsdeck.ops.FileIndex.parseMeta(r.output,n)
                fileSnapNote=""
                dao.task(record.copy(state="成功",exitCode=0))
            } catch(e:Exception) {
                fileSnapNote=e.message ?: "失败"
                withContext(NonCancellable){dao.task(record.copy(state="失败",detail="文件快照未完成；旧索引可能仍在服务器，刷新可重建"))}
            } finally {
                fileSnapBusy=false
                withContext(NonCancellable){dao.trimTasks()}
            }
        }
    }
    fun searchFiles(server: Server, pattern: String, ignoreCase: Boolean) {
        if(fileSnapBusy) return
        if(server.id !in app.ssh.connected.value) {error="连接已断开";return}
        fileSnapNote="搜索中（服务器端，最多${dev.vpsdeck.ops.FileIndex.SEARCH_LIMIT}条）…"
        app.appScope.launch {
            try {
                val r=app.ssh.exec(server,dev.vpsdeck.ops.FileIndex.searchCommand(pattern,ignoreCase),60)
                fileHits=dev.vpsdeck.ops.FileIndex.parseHits(r)
                fileSnapNote=""
            } catch(e:Exception) {
                fileHits=emptyList();fileSnapNote=e.message ?: "搜索失败"
            }
        }
    }
    fun clearFileHits() {fileHits=emptyList();fileSnapNote=""}
    var fileBatchBusy by mutableStateOf(false); private set
    var fileBatchReport by mutableStateOf(""); private set
    private var fileBatchJob: Job? = null
    fun cancelFileBatch() { fileBatchJob?.cancel() }
    fun runFileBatch(server: Server, entries: List<RemoteFile>, destination: Uri? = null) {
        if(fileBatchBusy || transfer!=null) {error="请先等待当前文件任务完成";return}
        if(entries.isEmpty() || entries.size>1000) {error="请选择1–1000个条目";return}
        if(destination!=null && entries.any {it.directory || it.link || !it.mode.startsWith("-")}) {error="批量下载仅支持普通文件，不跟随符号链接或递归目录";return}
        val snapshot=entries.distinctBy {it.path}.toList()
        val action=if(destination==null) "批量删除" else "批量下载"
        fileBatchBusy=true;fileBatchReport="${server.name} · ${server.endpoint}\n$action · ${snapshot.size} 项\n"
        fileBatchJob=app.appScope.launch {
            val record=TaskRecord(serverId=server.id,serverName=server.name,label=action)
            var completed=0
            try {
                dao.task(record)
                val folder=destination?.let {androidx.documentfile.provider.DocumentFile.fromTreeUri(app,it)}
                if(destination!=null) require(folder!=null && folder.canWrite()) {"目标目录不可写"}
                for(file in snapshot) {
                    ensureActive()
                    fileBatchReport+="处理中：${file.path}\n"
                    val batchContext=currentCoroutineContext()
                    app.ssh.sftp(server) {s ->
                        val path=supportedPath(file.path);val now=s.lstat(path)
                        check(dev.vpsdeck.ui.matchesFileSnapshot(file,now.isDir,now.isLink,now.size,(now.mTime.toLong() and 0xffffffffL)*1000,now.permissions)) {"文件属性已变化，请刷新后重新选择"}
                        if(folder==null) {
                            if(file.directory && !file.link) s.rmdir(path) else s.rm(path)
                            try {s.lstat(path);error("删除后路径仍存在，请核查")}
                            catch(e:SftpException) {if(e.id!=ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e}
                        } else {
                            check(now.isReg) {"批量下载只接受普通文件"}
                            check(folder.findFile(file.name)==null) {"本地同名文件已存在，不覆盖"}
                            val doc=requireNotNull(folder.createFile("application/octet-stream",file.name)) {"无法创建本地文件"}
                            val active=batchContext
                            try {
                                app.contentResolver.openOutputStream(doc.uri,"wt").use {out ->
                                    requireNotNull(out)
                                    s.get(path,out,object:SftpProgressMonitor {
                                        override fun init(op:Int,src:String?,dest:String?,max:Long)=Unit
                                        override fun count(count:Long)=active.isActive
                                        override fun end()=Unit
                                    })
                                }
                                check(active.isActive) {"下载已取消"}
                                check(doc.length()==file.size) {"下载大小核验失败"}
                            } catch(e:Exception) {runCatching {doc.delete()};throw e}
                        }
                    }
                    completed++;fileBatchReport+="已核验：${file.path}\n"
                }
                fileBatchReport+="完成 $completed / ${snapshot.size}\n"
                dao.task(record.copy(state="成功",exitCode=0,detail="已完成 $completed 项；详细路径仅保留于当前进程"))
            } catch(e:Exception) {
                fileBatchReport+="已停止：${e.message ?: "取消"}\n已核验 $completed 项；当前项可能未完成或结果未知，其余未执行。已完成部分不回滚、不重试；下载失败时请检查本地是否残留不完整文件。"
                withContext(NonCancellable) {dao.task(record.copy(state="中断",detail="已核验 $completed 项，其余需核查；未自动重放"))}
            } finally {
                fileBatchBusy=false
                withContext(NonCancellable) {dao.trimTasks()}
                if(selected?.id==server.id) browse()
            }
        }
    }
    fun cancelTransfer() { transferJob?.cancel() }
    private fun transferTask(server: Server, label: String, work: suspend (SftpProgressMonitor) -> Unit) {
        if(transferJob?.isActive == true) { error = "已有传输任务，请等待或取消"; return }
        transferJob = app.appScope.launch {
            val task = TaskRecord(serverId = server.id, serverName = server.name, label = label); dao.task(task); transfer = label
            val activeContext = currentCoroutineContext(); var done = 0L; var last = 0L; var total = 0L
            val monitor = object : SftpProgressMonitor {
                override fun init(op: Int, src: String?, dest: String?, max: Long) { total = max.coerceAtLeast(0) }
                override fun count(count: Long): Boolean { done += count; if(System.currentTimeMillis() - last > 400) { last = System.currentTimeMillis(); app.appScope.launch { transfer = "$label · ${server.name} · ${done / 1024} KB${if(total > 0) " / ${total / 1024} KB · ${(done.toDouble() / total * 100).toInt().coerceIn(0,100)}%" else "（总大小未知）"}" } }; return activeContext.isActive }
                override fun end() = Unit
            }
            try { work(monitor); ensureActive(); dao.task(task.copy(state = "成功", exitCode = 0)); if(selected?.id == server.id) browse() }
            catch(e: Exception) { withContext(NonCancellable) { dao.task(task.copy(state = "失败", detail = "传输未完成；本地下载文件可能不完整。")) }; error = "$label 未完成：${e.message}" }
            finally { transfer = null; withContext(NonCancellable) { dao.trimTasks() } }
        }
    }
    fun download(file: RemoteFile, uri: Uri) {
        val server = selected ?: return
        transferTask(server, "下载 ${file.name}") { monitor -> app.ssh.sftp(server) { s ->
            app.contentResolver.openOutputStream(uri, "wt").use { output -> requireNotNull(output); s.get(supportedPath(file.path), output, monitor) }
        } }
    }
    fun upload(uri: Uri, filename: String) {
        val server = selected ?: return; val target = Shell.child(currentPath, filename)
        val temp = currentPath.trimEnd('/') + "/.vpsdeck-${UUID.randomUUID()}.upload"
        transferTask(server, "上传 $filename") { monitor ->
            try {
                app.ssh.sftp(server) { s -> app.contentResolver.openInputStream(uri).use { input -> requireNotNull(input); s.put(input, supportedPath(temp), monitor, ChannelSftp.OVERWRITE); s.chmod(384, temp) } }
                // Same-directory hard link atomically rejects existing destinations, including symlinks.
                val r = app.ssh.exec(server, "ln -T -- ${Shell.quote(temp)} ${Shell.quote(target)} && rm -- ${Shell.quote(temp)}")
                check(r.code == 0) { "目标可能已存在或文件系统不支持硬链接；未覆盖原文件。${r.output}" }
            } finally { withContext(NonCancellable) { runCatching { app.ssh.sftp(server) { it.rm(temp) } } } }
        }
    }
    fun edit(file: RemoteFile) {
        val server = selected ?: return
        viewModelScope.launch {
            try {
                require(!file.link && !file.directory && file.size <= 512 * 1024) { "仅支持编辑 512KB 内的普通文本文件，符号链接请使用终端" }
                val bytes = app.ssh.sftp(server) { s -> s.get(supportedPath(file.path)).use { input -> val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192); while(output.size() <= 512 * 1024) { val n = input.read(buffer, 0, minOf(buffer.size, 512 * 1024 + 1 - output.size())); if(n < 0) break; output.write(buffer, 0, n) }; output.toByteArray() } }
                require(bytes.size <= 512 * 1024 && !bytes.contains(0)) { "文件过大或为二进制" }
                val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                if(selected == server) editor = RemoteEdit(server, file, text, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
            } catch(e: Exception) { error = "无法编辑：${e.message}" }
        }
    }
    fun saveEdit(edit: RemoteEdit, text: String, nginx: Boolean) {
        val server = edit.server
        require(selected == server) { "服务器已切换或资料已修改，请在原服务器重新打开文件" }
        require(text.toByteArray().size <= 512 * 1024)
        val temp = edit.file.path.substringBeforeLast('/') + "/.vpsdeck-${UUID.randomUUID()}.edit"
        val backup = edit.file.path + ".vpsdeck-${System.currentTimeMillis()}.bak"
        fileTask(server, "保存配置 ${edit.file.name}") {
            try {
                app.ssh.sftp(server) { s -> s.put(text.byteInputStream(), temp); s.chmod(384, temp) }
                val p = Shell.quote(edit.file.path); val b = Shell.quote(backup); val t = Shell.quote(temp)
                val validation = if(nginx) "if nginx -t; then echo '语法检查通过，尚未重载'; else cp -p -- $b $p || { echo '恢复失败，请立即检查备份'; exit 76; }; echo '语法错误，已恢复原配置'; exit 75; fi" else ":"
                val cmd = "test -f $p && test ! -L $p || exit 71; current=\$(sha256sum -- $p); current=\${current%% *}; test \"\$current\" = ${Shell.quote(edit.digest)} || { echo '文件已被其他操作修改，请重新读取'; exit 73; }; cp -p -- $p $b || exit 74; cat -- $t > $p || { cp -p -- $b $p || { echo '写入与恢复均失败，请立即检查备份'; exit 76; }; echo '写入失败，已恢复原文件'; exit 74; }; $validation; echo ${Shell.quote("备份：$backup")}" 
                val r = app.ssh.exec(server, cmd); result = "保存配置" to r; check(r.code == 0) { "退出码 ${r.code}，请查看执行结果" }; editor = null
            } finally { withContext(NonCancellable) { runCatching { app.ssh.sftp(server) { it.rm(temp) } } } }
        }
    }
}
