package dev.vpsdeck.panel

import dev.vpsdeck.DeckApp
import dev.vpsdeck.data.Server
import dev.vpsdeck.data.TaskRecord
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex

data class PanelState(
    val kind: ResourceKind = ResourceKind.SERVICE, val rows: List<Resource> = emptyList(),
    val loaded: Boolean = false, val detail: Resource? = null, val busy: String? = null,
    val error: String? = null, val notice: String? = null, val logs: String? = null,
    val loadedAt: Long? = null
)

/** App-scoped: leaving a page never replays or cancels a submitted write. No credentials or logs persisted. */
class PanelController(private val app: DeckApp) {
    private val _states = MutableStateFlow<Map<String, PanelState>>(emptyMap())
    val states = _states.asStateFlow()
    private fun state(s: Server) = _states.value[s.id] ?: PanelState()
    private fun update(s: Server, f: (PanelState) -> PanelState) { _states.update { it + (s.id to f(it[s.id] ?: PanelState())) } }
    private fun repository(s: Server) = ResourceRepository { app.ssh.exec(s, it, 60) }
    private fun job(s: Server, label: String, block: suspend () -> Unit) {
        val lock = app.operationLocks.getOrPut(s.id) { Mutex() }
        if(!lock.tryLock()) return
        update(s) { it.copy(busy = label, error = null) }
        app.appScope.launch {
            try { check(app.ssh.isConnected(s.id)) { "连接已断开，请重新连接；未提交新操作" }; block() }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { update(s) { it.copy(error = e.message ?: "读取失败") } }
            finally { update(s) { it.copy(busy = null) }; lock.unlock() }
        }
    }
    fun load(s: Server, kind: ResourceKind = state(s).kind) = job(s, "读取资源列表") {
        update(s) { if(it.kind != kind) PanelState(kind = kind, busy = "读取资源列表") else it.copy(detail = null, logs = null, notice = null) }
        val rows = repository(s).list(kind)
        update(s) { it.copy(rows = rows, loaded = true, loadedAt = System.currentTimeMillis()) }
    }
    fun open(s: Server, row: Resource) = job(s, "核对资源详情") {
        val detail = repository(s).detail(state(s).kind, row)
        update(s) { it.copy(detail = detail, logs = null, notice = null) }
    }
    fun close(s: Server) { if(state(s).busy == null) update(s) { it.copy(detail = null, logs = null) } }
    fun logs(s: Server) {
        val row = state(s).detail ?: return
        job(s, "读取最近日志") {
            val r = repository(s).logs(state(s).kind, row)
            check(r.code == 0) { "日志读取失败（exit ${r.code}），检查日志权限" }
            update(s) { it.copy(logs = (if(r.truncated) "[输出已截断]\n" else "") + r.output) }
        }
    }
    fun act(s: Server, expected: Resource, action: ResourceAction, sudo: Boolean) = job(s, "检查操作前状态") {
        val kind = state(s).kind
        val repo = repository(s)
        val dao = app.database.dao()
        val task = TaskRecord(serverId = s.id, serverName = s.name, label = "${action.title} · ${expected.name}")
        var submitted = false
        var code: Int? = null
        dao.task(task)
        try {
            val (before, result) = repo.act(kind, expected, action, sudo) {
                submitted = true
                update(s) { it.copy(busy = "正在${action.title}，请勿重复提交", notice = null, logs = null) }
            }
            code = result.code
            if(result.code != 0) {
                dao.task(task.copy(state = "失败", exitCode = code, detail = "远端返回非零退出码，可能已有部分效果，请刷新状态。"))
                update(s) { it.copy(error = "操作失败（exit $code），请刷新核实；下方为本次诊断，不写入任务历史。", logs = result.output) }
                // Failure may have partial effects. Do not show the old detail as a new verified state.
                val after = runCatching { repo.detail(kind, expected) }.getOrNull()
                update(s) { it.copy(detail = after) }
                return@job
            }
            update(s) { it.copy(busy = "命令已返回，正在验证真实状态") }
            dao.task(task.copy(detail = "命令退出码为0，正在核验资源状态；尚未判定成功。", exitCode = code))
            var after = repo.detail(kind, expected)
            // Always observe after a short settling window, including initially successful starts.
            repeat(3) { delay(1000); after = repo.detail(kind, expected) }
            val verified = ResourceProtocol.verified(kind, action, before, after)
            val message = if(verified) "${action.title}已验证：${after.state} · 自启 ${after.enabled.ifBlank { "不适用" }}" else "未通过验证：当前 ${after.state} / ${after.enabled}，请检查日志；不会自动重试。"
            dao.task(task.copy(state = if(verified) "成功" else "未通过验证", exitCode = code, detail = message))
            update(s) { it.copy(detail = after, rows = it.rows.map { r -> if(r.id == after.id) after else r }, notice = message, loadedAt = System.currentTimeMillis()) }
        } catch(e: CancellationException) { throw e }
        catch(e: Exception) {
            val message = if(submitted) "操作已提交，但结果未能确认。请刷新核实，不要直接重试。" else "操作未提交：${e.message}"
            dao.task(task.copy(state = if(submitted) "结果未知" else "未执行", exitCode = code, detail = message))
            update(s) { it.copy(error = message, detail = null) }
        } finally { dao.trimTasks() }
    }
}
