package dev.vpsdeck.panel

import dev.vpsdeck.ops.Shell
import org.json.JSONObject

enum class ResourceKind(val title: String) { SERVICE("系统服务"), CONTAINER("Docker 容器") }
data class Resource(
    val id: String, val name: String, val state: String, val summary: String = "",
    val enabled: String = "", val version: String = "", val facts: Map<String, String> = emptyMap()
)
enum class ResourceAction(val title: String) { START("启动"), STOP("停止"), RESTART("重启"), ENABLE("启用自启"), DISABLE("关闭自启") }

object ResourceProtocol {
    const val units = "systemctl list-units --all --type=service --plain --no-legend --no-pager"
    const val unitFiles = "systemctl list-unit-files --type=service --no-legend --no-pager"
    const val containers = "docker ps -a --no-trunc --format '{{json .}}'"
    fun services(units: String, files: String): List<Resource> {
        val result = linkedMapOf<String, Resource>()
        units.lineSequence().filter { it.isNotBlank() }.forEach { line ->
            val p = line.trim().split(Regex("\\s+"), limit = 5)
            require(p.size >= 4 && p[0].endsWith(".service")) { "无法识别服务列表，拒绝显示不完整状态" }
            result[p[0]] = Resource(p[0], p[0].removeSuffix(".service"), p[2], p.getOrElse(4) { "" }, facts = mapOf("加载" to p[1], "子状态" to p[3]))
        }
        files.lineSequence().filter { it.isNotBlank() }.forEach { line ->
            val p = line.trim().split(Regex("\\s+"))
            require(p.size >= 2 && p[0].endsWith(".service")) { "无法识别自启列表" }
            result[p[0]] = (result[p[0]] ?: Resource(p[0], p[0].removeSuffix(".service"), "未载入")).copy(enabled = p[1])
        }
        return result.values.sortedBy { it.name }
    }
    fun containers(text: String): List<Resource> = text.lineSequence().filter { it.isNotBlank() }.map {
        val j = JSONObject(it); val id = j.getString("ID"); containerId(id)
        Resource(id, j.getString("Names"), j.getString("State"), j.optString("Status"), facts = linkedMapOf("镜像" to j.getString("Image"), "端口" to j.optString("Ports"), "容器ID" to id))
    }.toList()
    fun serviceDetail(text: String): Resource {
        val p = text.lineSequence().filter { it.contains('=') }.associate { it.substringBefore('=') to it.substringAfter('=') }
        val id = p["Id"] ?: error("服务详情缺少身份")
        require(p["LoadState"] != "not-found") { "服务已不存在，请刷新列表" }
        return Resource(id, id.removeSuffix(".service"), p["ActiveState"] ?: error("缺少服务状态"), p["Description"].orEmpty(), p["UnitFileState"].orEmpty(), p["InvocationID"].orEmpty(), linkedMapOf("子状态" to p["SubState"].orEmpty(), "进程PID" to p["MainPID"].orEmpty(), "配置位置" to p["FragmentPath"].orEmpty()))
    }
    fun containerDetail(row: Resource, text: String): Resource {
        val j = JSONObject(text.trim())
        return row.copy(state = j.getString("Status"), version = j.getString("StartedAt"), facts = row.facts + linkedMapOf("启动时间" to j.getString("StartedAt"), "退出码" to j.optInt("ExitCode").toString(), "健康状态" to (j.optJSONObject("Health")?.optString("Status") ?: "未配置健康检查")))
    }
    fun detail(kind: ResourceKind, id: String): String = when(kind) {
        ResourceKind.SERVICE -> "systemctl show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p Description -p UnitFileState -p MainPID -p FragmentPath -p InvocationID -- ${Shell.quote(Shell.unit(id))}"
        ResourceKind.CONTAINER -> "docker inspect --format '{{json .State}}' -- ${Shell.quote(containerId(id))}"
    }
    fun protected(id: String): Boolean = id.removeSuffix(".service").lowercase().let {
        it in setOf("ssh", "sshd", "dropbear", "networking", "networkmanager", "dbus", "polkit", "systemd-logind") || it.startsWith("systemd-") || it.startsWith("ssh@") || it.startsWith("sshd@")
    }
    fun actions(kind: ResourceKind, row: Resource): List<ResourceAction> {
        if(kind == ResourceKind.SERVICE && (protected(row.id) || '@' in row.id && row.id.endsWith("@.service"))) return emptyList()
        val run = row.state in setOf("active", "running")
        val result = mutableListOf<ResourceAction>()
        if(row.state in setOf("active", "inactive", "failed", "running", "exited", "created", "dead")) {
            if(!run) result += ResourceAction.START
            if(run) { result += ResourceAction.STOP; result += ResourceAction.RESTART }
        }
        if(kind == ResourceKind.SERVICE) when(row.enabled) {
            "enabled" -> result += ResourceAction.DISABLE
            "disabled" -> result += ResourceAction.ENABLE
        }
        return result
    }
    fun action(kind: ResourceKind, row: Resource, action: ResourceAction): String {
        require(action in actions(kind, row)) { "该对象当前不允许此操作，请刷新状态" }
        val verb = action.name.lowercase()
        return if(kind == ResourceKind.SERVICE) "systemctl $verb -- ${Shell.quote(Shell.unit(row.id))}"
        else "docker $verb -- ${Shell.quote(containerId(row.id))}"
    }
    fun verified(kind: ResourceKind, action: ResourceAction, before: Resource, after: Resource): Boolean {
        if(before.id != after.id) return false
        val running = if(kind == ResourceKind.SERVICE) "active" else "running"
        return when(action) {
            ResourceAction.START -> after.state == running
            ResourceAction.STOP -> after.state in setOf("inactive", "exited")
            ResourceAction.RESTART -> after.state == running && after.version.isNotBlank() && after.version != before.version
            ResourceAction.ENABLE -> after.enabled == "enabled"
            ResourceAction.DISABLE -> after.enabled == "disabled"
        }
    }
    fun logs(kind: ResourceKind, id: String): String = if(kind == ResourceKind.SERVICE)
        "journalctl --no-pager -o short-iso -n 200 -u ${Shell.quote(Shell.unit(id))}"
        else "docker logs --timestamps --tail 200 -- ${Shell.quote(containerId(id))}"
    private fun containerId(id: String): String { require(id.matches(Regex("[a-f0-9]{64}"))) { "容器身份无效，请刷新列表" }; return id }
}
