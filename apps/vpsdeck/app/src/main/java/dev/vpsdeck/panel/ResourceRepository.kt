package dev.vpsdeck.panel

import dev.vpsdeck.ssh.ExecResult
import dev.vpsdeck.ops.Shell

class ResourceRepository(private val exec: suspend (String) -> ExecResult) {
    private suspend fun read(command: String): String {
        val r = exec(command)
        check(r.code == 0) { "读取失败（exit ${r.code}）。请检查工具是否安装以及当前账号权限。" }
        check(!r.truncated) { "资源返回超过读取上限，不能将截断结果视为完整列表" }
        return r.output
    }
    suspend fun list(kind: ResourceKind): List<Resource> = when(kind) {
        ResourceKind.SERVICE -> ResourceProtocol.services(read(ResourceProtocol.units), read(ResourceProtocol.unitFiles))
        ResourceKind.CONTAINER -> ResourceProtocol.containers(read(ResourceProtocol.containers))
    }
    suspend fun detail(kind: ResourceKind, row: Resource): Resource {
        val text = read(ResourceProtocol.detail(kind, row.id))
        return (if(kind == ResourceKind.SERVICE) ResourceProtocol.serviceDetail(text) else ResourceProtocol.containerDetail(row, text)).also {
            check(it.id == row.id) { "资源身份已变化，请重新选择" }
        }
    }
    suspend fun after(kind: ResourceKind, action: ResourceAction, row: Resource): Resource {
        if(action != ResourceAction.REMOVE) return detail(kind,row)
        check(kind == ResourceKind.CONTAINER) { "只允许删除已停止容器" }
        val rows = list(kind)
        return if(rows.none { it.id == row.id }) row.copy(state="removed",version="") else detail(kind,row)
    }
    suspend fun logs(kind: ResourceKind, row: Resource): ExecResult = exec(ResourceProtocol.logs(kind, row.id))
    suspend fun act(kind: ResourceKind, expected: Resource, action: ResourceAction, sudo: Boolean, onSubmit: () -> Unit): Pair<Resource, ExecResult> {
        val before = detail(kind, expected)
        check(before.state == expected.state && before.enabled == expected.enabled && before.version == expected.version) { "确认期间资源状态已变化，操作未提交，请刷新后重试" }
        val command = ResourceProtocol.action(kind, before, action)
        onSubmit()
        return before to exec(if(sudo) "sudo -n -- sh -c ${Shell.quote(command)}" else command)
    }
}
