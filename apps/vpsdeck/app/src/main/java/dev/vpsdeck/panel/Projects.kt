package dev.vpsdeck.panel

import dev.vpsdeck.DeckApp
import dev.vpsdeck.data.Server
import dev.vpsdeck.data.TaskRecord
import dev.vpsdeck.ops.Shell
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject
import java.util.UUID

data class ProjectState(val projects: List<String> = emptyList(), val environments: List<String> = emptyList(), val database: String? = null, val databaseContainers: List<String> = emptyList(), val deployments: List<String> = emptyList(), val jobs: List<String> = emptyList(), val busy: Boolean = false, val error: String? = null)
data class ProjectPlan(val project: String, val result: String, val action: String, val binding: String)

object JobProtocol {
    // Only this fixed bootstrap is visible in argv; configuration and future secrets use SSH stdin.
    fun binding(s: Server): String = "${s.host}:${s.port}:${s.username}:${s.fingerprint}"
    fun command(sudo: Boolean): String = (if(sudo) "sudo -n -- " else "") + "python3 -c " + Shell.quote(
        "import json,sys; envelope=json.load(sys.stdin); SOURCE=envelope.pop('adapter'); exec(compile(SOURCE,'vpsdeck-adapter','exec'))")
    fun rows(j: JSONObject, key: String): List<String> = j.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getJSONObject(it).toString() } } ?: emptyList()
    fun action(value: String): String = mapOf("register" to "登记项目（不部署）", "pull" to "拉取镜像", "up" to "应用配置", "stop" to "停止项目", "install" to "环境变更", "backup" to "数据库备份", "restore" to "数据库恢复", "create-database" to "建库", "create-user" to "创建账号", "drop-database" to "备份后删库", "drop-user" to "删除账号", "grant" to "授权", "revoke" to "撤销直接授权", "password" to "修改账号密码", "create-container" to "创建容器", "rebuild-container" to "重建容器", "restore-container" to "恢复容器配置", "pull-image" to "拉取镜像")[value] ?: value
    fun state(value: String): String = when(value) {
        "queued" -> "远端排队"; "running" -> "远端执行中"; "succeeded" -> "成功"
        "needs_review" -> "需核查"; else -> "结果未知"
    }
}

class ProjectController(private val app: DeckApp) {
    private val mutable = MutableStateFlow<Map<String, ProjectState>>(emptyMap())
    val states = mutable.asStateFlow()
    private val script by lazy { listOf("vpsdeck_environment.py", "vpsdeck_databases.py", "vpsdeck_deployments.py", "vpsdeck_jobs.py").joinToString("\n") { file -> app.assets.open(file).bufferedReader().use { it.readText() } } }
    private fun update(s: Server, f: (ProjectState) -> ProjectState) { mutable.update { it + (s.id to f(it[s.id] ?: ProjectState())) } }
    private suspend fun call(s: Server, request: JSONObject, sudo: Boolean): JSONObject {
        val bytes = request.put("adapter",script).toString().toByteArray(Charsets.UTF_8)
        val r = try { app.ssh.exec(s,JobProtocol.command(sudo),150,bytes) } finally { bytes.fill(0) }
        check(!r.truncated) { "响应超出上限；请核查服务器，不要重复提交" }
        val result = try { JSONObject(r.output.trim()) } catch(_: Exception) { error("适配器未返回有效状态；需要Python3、Docker Compose v2和相应权限。不会自动安装。") }
        check(r.code == 0 && result.optBoolean("ok")) { result.optString("message","请求失败") }
        return result
    }
    private fun job(s: Server, block: suspend () -> Unit) {
        val lock = app.operationLocks.getOrPut(s.id) { Mutex() }
        if(!lock.tryLock()) { update(s) { it.copy(error="该主机有其他请求，请稍后刷新") }; return }
        update(s) { it.copy(busy=true,error=null) }
        app.appScope.launch {
            try { check(app.ssh.isConnected(s.id)) { "请先连接服务器" }; block() }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { update(s) { it.copy(error=e.message ?: "请求失败") } }
            finally { lock.unlock(); update(s) { it.copy(busy=false) } }
        }
    }
    private suspend fun record(s: Server, rows: List<String>) {
        rows.forEach { raw ->
            val j = JSONObject(raw)
            app.database.dao().task(TaskRecord(id="remote:${s.id}:${j.getString("id")}", serverId=s.id,serverName=s.name,
                label="远端任务 ${j.optString("project")} · ${JobProtocol.action(j.optString("action"))}",started=j.optLong("created",System.currentTimeMillis()/1000)*1000,
                state=JobProtocol.state(j.optString("state")), detail=j.optString("message") + "\n远端任务ID：" + j.getString("id")))
        }
    }
    fun load(s: Server, sudo: Boolean, jobsOnly: Boolean = false) = job(s) {
        val result = call(s,JSONObject().put("op",if(jobsOnly) "jobs" else "list"),sudo)
        val rows = JobProtocol.rows(result,"jobs")
        record(s,rows)
        update(s) { it.copy(projects=if(jobsOnly) it.projects else JobProtocol.rows(result,"projects"),jobs=rows) }
    }
    fun loadEnvironments(s: Server, sudo: Boolean) = job(s) {
        val result = call(s,JSONObject().put("op","environments"),sudo)
        val rows = JobProtocol.rows(result,"jobs")
        record(s,rows)
        update(s) { it.copy(environments=JobProtocol.rows(result,"environments"),jobs=rows) }
    }
    fun loadDatabaseContainers(s: Server, sudo: Boolean) = job(s) {
        val result = call(s,JSONObject().put("op","database-containers"),sudo)
        update(s) { it.copy(databaseContainers=JobProtocol.rows(result,"containers"),error=result.optString("notice").ifEmpty { null }) }
    }
    fun clearDatabase(s: Server) { update(s) { it.copy(database=null) } }
    fun loadDatabase(s: Server, auth: String, sudo: Boolean) = job(s) {
        update(s) { it.copy(database=null) }
        val result = call(s,JSONObject().put("op","database").put("auth",JSONObject(auth)),sudo)
        val rows = JobProtocol.rows(result,"jobs")
        record(s,rows)
        update(s) { it.copy(database=result.getJSONObject("database").toString(),jobs=rows) }
    }
    fun loadDeployments(s: Server, sudo: Boolean) = job(s) {
        val result = call(s,JSONObject().put("op","deployments"),sudo)
        val rows = JobProtocol.rows(result,"jobs")
        record(s,rows)
        update(s) { it.copy(deployments=JobProtocol.rows(result,"deployments"),jobs=rows) }
    }
    fun preview(s: Server, project: String, action: String, sudo: Boolean, ready: (ProjectPlan) -> Unit) = job(s) {
        val result = call(s,JSONObject().put("op","plan").put("project",JSONObject(project)),sudo)
        ready(ProjectPlan(project,result.toString(),action,JobProtocol.binding(s)))
    }
    fun hasActive(s: Server): Boolean = mutable.value[s.id]?.jobs?.any { JSONObject(it).optString("state") in listOf("queued","running") } == true
    fun submit(s: Server, plan: ProjectPlan, sudo: Boolean) = job(s) {
        check(!hasActive(s)) { "该主机有已知远端任务，先查询并等待其结束，不并行提交变更" }
        check(plan.binding == JobProtocol.binding(s)) { "服务器身份已变化，请重新预览，不提交旧计划" }
        val id = UUID.randomUUID().toString().replace("-", "")
        val task = TaskRecord(id="remote:${s.id}:$id",serverId=s.id,serverName=s.name,label="远端任务 ${JSONObject(plan.project).getString("name")} · ${JobProtocol.action(plan.action)}",state="提交待确认",detail="远端任务ID：$id；断线后只查询，不自动重放。")
        app.database.dao().task(task)
        try {
            val result = call(s,JSONObject().put("op","submit").put("id",id).put("action",plan.action)
                .put("project",JSONObject(plan.project)).put("revision",JSONObject(plan.result).getString("revision")),sudo)
            val row = result.getJSONObject("job").toString()
            record(s,listOf(row))
            update(s) { it.copy(jobs=listOf(row)+it.jobs) }
        } catch(e: Exception) {
            app.database.dao().task(task.copy(state="需核查",detail="远端任务ID：$id；提交结果未确认，先刷新远端任务和资源，禁止重复提交。"))
            throw e
        }
    }
}
