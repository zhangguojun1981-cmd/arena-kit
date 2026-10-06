package dev.vpsdeck.panel

import dev.vpsdeck.DeckApp
import dev.vpsdeck.data.Server
import dev.vpsdeck.data.TaskRecord
import dev.vpsdeck.ops.Shell
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

data class Website(val spec: String, val revision: String, val drift: Boolean, val pending: Boolean) {
    val json get() = JSONObject(spec)
    val id get() = json.getString("id")
    val domain get() = json.getString("domain")
    val enabled get() = json.optBoolean("enabled")
}
data class WebsiteState(val rows: List<Website> = emptyList(), val unmanaged: List<String> = emptyList(),
    val sockets: List<String> = emptyList(), val loaded: Boolean = false, val busy: String? = null,
    val error: String? = null, val notice: String? = null, val backups: List<String> = emptyList())
data class WebsitePlan(val spec: String, val expected: String, val createRoot: Boolean, val diff: String)

object WebsiteProtocol {
    fun fresh(): String {
        val id = UUID.randomUUID().toString().replace("-", "")
        return JSONObject().put("id",id).put("domain","").put("kind","static").put("port",80)
            .put("root","/var/www/vpsdeck/$id").put("enabled",true).put("tls",false)
            .put("upstream","http://127.0.0.1:3000").put("phpSocket","/run/php/php8.2-fpm.sock")
            .put("cert","").put("key","").toString()
    }
    fun command(script: String, request: JSONObject, sudo: Boolean): String {
        val payload = Base64.getEncoder().encodeToString(request.toString().toByteArray(Charsets.UTF_8))
        return (if(sudo) "sudo -n -- " else "") + "python3 -c ${Shell.quote(script)} ${Shell.quote(payload)}"
    }
    fun strings(j: JSONObject, key: String): List<String> = j.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
}

class WebsiteController(private val app: DeckApp) {
    private val mutable = MutableStateFlow<Map<String, WebsiteState>>(emptyMap())
    val states = mutable.asStateFlow()
    private val script by lazy { app.assets.open("vpsdeck_sites.py").bufferedReader().use { it.readText() } }
    private fun update(s: Server, f: (WebsiteState) -> WebsiteState) { mutable.update { it + (s.id to f(it[s.id] ?: WebsiteState())) } }
    private suspend fun call(s: Server, request: JSONObject, sudo: Boolean): JSONObject {
        val r = app.ssh.exec(s, WebsiteProtocol.command(script, request, sudo), 150)
        check(!r.truncated) { "服务器响应已截断，请使用高级配置核查" }
        val j = try { JSONObject(r.output.trim()) } catch(_: Exception) {
            error("网站适配器无法运行：需服务器Python3及对应权限；不会自动安装。exit ${r.code}")
        }
        check(r.code == 0 && j.optBoolean("ok")) { j.optString("message", "操作失败") }
        return j
    }
    private fun job(s: Server, title: String, block: suspend () -> Unit) {
        val lock = app.operationLocks.getOrPut(s.id) { Mutex() }
        if(!lock.tryLock()) { update(s) { it.copy(error = "该服务器有其他资源操作正在执行，请稍后重试") }; return }
        update(s) { it.copy(busy = title, error = null, notice = null) }
        app.appScope.launch {
            try { check(app.ssh.isConnected(s.id)) { "请先连接服务器" }; block() }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { update(s) { it.copy(error = e.message ?: "执行失败") } }
            finally { update(s) { it.copy(busy = null) }; lock.unlock() }
        }
    }
    private suspend fun refresh(s: Server, sudo: Boolean) {
        val j = call(s,JSONObject().put("op","list"),sudo)
        val a = j.getJSONArray("sites")
        val rows = (0 until a.length()).map { a.getJSONObject(it).let { r -> Website(r.getJSONObject("spec").toString(),r.getString("revision"),r.getBoolean("drift"),r.getBoolean("pending")) } }
        update(s) { it.copy(rows = rows, unmanaged = WebsiteProtocol.strings(j,"unmanaged"), sockets = WebsiteProtocol.strings(j,"phpSockets"), loaded = true) }
    }
    fun load(s: Server, sudo: Boolean) = job(s,"发现网站与PHP运行时") { refresh(s,sudo) }
    fun preview(s: Server, spec: String, expected: String, create: Boolean, sudo: Boolean, ready: (WebsitePlan) -> Unit) = job(s,"生成配置差异") {
        val j = call(s,JSONObject().put("op","preview").put("spec",JSONObject(spec)).put("expected",expected),sudo)
        ready(WebsitePlan(spec,expected,create,j.getString("diff")))
    }
    fun apply(s: Server, plan: WebsitePlan, sudo: Boolean, done: () -> Unit) = mutate(s,"发布网站配置",sudo,JSONObject().put("op","apply").put("spec",JSONObject(plan.spec)).put("expected",plan.expected).put("createRoot",plan.createRoot),done)
    fun recover(s: Server, row: Website, sudo: Boolean) = mutate(s,"恢复未完成网站变更",sudo,JSONObject().put("op","recover").put("id",row.id)) { }
    fun backups(s: Server, row: Website, sudo: Boolean) = job(s,"读取配置备份") {
        val j = call(s,JSONObject().put("op","backups").put("id",row.id),sudo)
        update(s) { it.copy(backups = WebsiteProtocol.strings(j,"backups")) }
    }
    fun certificate(s: Server, row: Website, sudo: Boolean, ready: (String) -> Unit) = job(s,"读取公有证书信息") {
        val j = call(s,JSONObject().put("op","certificate").put("id",row.id),sudo)
        update(s) { it.copy(notice=j.getString("info")) }
        ready(row.json.put("tls",true).put("port",443).put("cert",j.getString("cert")).put("key",j.getString("key")).toString())
    }
    fun issue(s: Server, row: Website, email: String, sudo: Boolean, done: () -> Unit) = mutate(s,"申请或更新网站证书",sudo,JSONObject().put("op","issue").put("id",row.id).put("email",email).put("agreeTerms",true),done)
    fun renewal(s: Server, row: Website, sudo: Boolean) = mutate(s,"启用系统已有certbot续期timer",sudo,JSONObject().put("op","renewal").put("id",row.id)) { }
    fun health(s: Server, row: Website, sudo: Boolean) = job(s,"检查网站HTTP响应") {
        val j = call(s,JSONObject().put("op","health").put("id",row.id),sudo)
        update(s) { it.copy(notice=j.getString("message")) }
    }
    fun clearBackups(s: Server) { update(s) { it.copy(backups = emptyList()) } }
    fun restore(s: Server, row: Website, backup: String, sudo: Boolean, done: () -> Unit) = mutate(s,"恢复网站配置备份",sudo,JSONObject().put("op","restore").put("id",row.id).put("expected",row.revision).put("backup",backup),done)
    private fun mutate(s: Server, title: String, sudo: Boolean, request: JSONObject, done: () -> Unit) = job(s,title) {
        check(!app.projects.hasActive(s)) { "该主机有已知远端任务，请先查询并等待其结束再修改网站" }
        val dao = app.database.dao()
        val task = TaskRecord(serverId=s.id,serverName=s.name,label=title)
        dao.task(task)
        try {
            val j = call(s,request,sudo)
            // This verifies the adapter completed nginx validation/reload and metadata commit,
            // not the remote application's HTTP business health.
            dao.task(task.copy(state="成功",exitCode=0,detail=j.optString("message")))
            update(s) { it.copy(notice=j.optString("message") + "。不等于业务HTTP健康检查通过。") }
            done()
            refresh(s,sudo)
        } catch(e: CancellationException) { throw e }
        catch(e: Exception) {
            dao.task(task.copy(state="需核查",detail="变更未完整确认，可能已部分执行。先刷新并检查未完成事务，禁止直接重复提交。"))
            update(s) { it.copy(error=(e.message ?: "执行异常") + "\n可能已有部分效果；请刷新后核对，不自动重试。") }
        } finally { dao.trimTasks() }
    }
}
