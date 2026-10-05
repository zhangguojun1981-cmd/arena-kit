@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.ops.*

@Composable fun ManagementPage(vm: DeckViewModel, server: Server, request: (Operation) -> Unit) {
    var section by remember { mutableIntStateOf(0) }; var sudo by remember { mutableStateOf(false) }
    val connected by vm.connected.collectAsState()
    fun run(block: () -> Operation) { runCatching { block().privileged(sudo) }.onSuccess(request).onFailure { vm.error = it.message } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionTitle("服务器管理", "每次操作先展示计划；缺少工具时显示真实失败，不自动安装")
        if(server.id !in connected) { Panel { Text("请先连接服务器"); Button(onClick = { vm.connect(server) }, enabled = !vm.busy) { Text("连接") } }; return@Column }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("服务", "Docker", "网站", "数据库").forEachIndexed { i, name -> FilterChip(section == i, { section = i }, label = { Text(name) }) } }
        Row { Switch(sudo, { sudo = it }); Spacer(Modifier.width(12.dp)); Column { Text("sudo -n 提权"); Hint("仅使用远端现有免密授权；不自动提交密码") } }
        when(section) {
            0 -> {
                var service by remember { mutableStateOf("nginx") }
                Panel { SectionTitle("systemd 服务"); OutlinedTextField(service, { service = it }, Modifier.fillMaxWidth(), label = { Text("服务名，例如 nginx / ssh / php8.3-fpm") }, singleLine = true)
                    ActionRow(listOf("状态", "日志", "启动", "停止", "重启", "开机启用", "取消开机")) { action -> run { Operations.service(service.trim(), action) } }
                    OutlinedButton(onClick = { run { Operations.services } }) { Text("查看全部服务") }
                }
                Panel { SectionTitle("主机操作"); Hint("重启会中断所有连接。断线不能作为重启成功的依据。")
                    OutlinedButton(onClick = { run { Operations.reboot } }) { Text("重启服务器", color = MaterialTheme.colorScheme.error) }
                }
            }
            1 -> {
                var container by remember { mutableStateOf("") }; var directory by remember { mutableStateOf("/opt/app") }
                Panel { SectionTitle("Docker 容器"); ActionRow(listOf("容器列表", "资源", "镜像", "卷与网络")) { action -> run { when(action) { "资源" -> Operations.dockerStats; "镜像" -> Operations.dockerImages; "卷与网络" -> Operations.dockerVolumes; else -> Operations.containers } } }
                    OutlinedTextField(container, { container = it }, Modifier.fillMaxWidth(), label = { Text("容器名称或 ID") }, singleLine = true)
                    ActionRow(listOf("详情", "日志", "启动", "停止", "重启", "删除容器")) { action -> run { Operations.container(container.trim(), action) } }
                    Hint("删除不带 --force 和 -v，不删除持久化卷。")
                }
                Panel { SectionTitle("Compose 项目"); OutlinedTextField(directory, { directory = it }, Modifier.fillMaxWidth(), label = { Text("现有项目的绝对目录") }, singleLine = true)
                    ActionRow(listOf("状态", "配置检查", "日志", "拉取镜像", "应用配置", "停止", "移除服务")) { action -> run { Operations.compose(directory.trim(), action) } }
                    Hint("拉取与应用分开执行，不自动更新生产服务。使用 Docker Compose v2。")
                }
            }
            2 -> {
                var certificate by remember { mutableStateOf("/etc/letsencrypt/live/example.com/fullchain.pem") }
                Panel { SectionTitle("原生网站服务"); ActionRow(listOf("站点列表", "关联服务", "配置检查", "检查并重载")) { action -> run { when(action) { "关联服务" -> Operations.nativeServices; "配置检查" -> Operations.nginxTest; "检查并重载" -> Operations.nginxReload; else -> Operations.nginxSites } } }
                    Text("通过文件页面编辑 Nginx 配置：自动备份，可选语法检查，检查失败恢复。重载需在这里单独确认。")
                    OutlinedButton(onClick = { vm.page = 2; vm.browse("/etc/nginx") }) { Text("浏览 Nginx 配置目录") }
                    Hint("支持现有配置与混合部署；不猜测站点关联，不自动覆盖配置或安装 PHP。PHP-FPM 可在服务页管理。")
                }
                Panel { SectionTitle("证书检查"); OutlinedTextField(certificate, { certificate = it }, Modifier.fillMaxWidth(), label = { Text("远端证书 PEM 绝对路径") }); Button(onClick = { run { Operations.certificate(certificate.trim()) } }) { Text("查看有效期与签发信息") }; Hint("只读取公有证书信息。证书自动签发/续期不由手机后台承担。") }
            }
            else -> {
                var engine by remember { mutableStateOf("PostgreSQL") }; var name by remember { mutableStateOf("") }; var path by remember { mutableStateOf("/var/backups/database.sql") }
                Panel { SectionTitle("数据库备份与恢复", "使用服务器已经配置好的数据库认证")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("PostgreSQL", "MySQL", "MariaDB").forEach { FilterChip(engine == it, { engine = it }, label = { Text(it) }) } }
                    OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("数据库名称") }, singleLine = true)
                    OutlinedTextField(path, { path = it }, Modifier.fillMaxWidth(), label = { Text("远端备份文件绝对路径") }, singleLine = true)
                    ActionRow(listOf("创建备份", "从文件恢复")) { action -> run { Operations.database(engine, name.trim(), path.trim(), action == "从文件恢复") } }
                    Hint("备份不覆盖已有文件。恢复可能覆盖数据，必须核对服务器名称。PostgreSQL 使用普通 SQL 备份格式；数据库角色、权限和完整集群备份请使用终端。容器内数据库请在终端采用对应 docker exec 流程。")
                }
                Panel { SectionTitle("数据库服务"); Text("服务状态与日志可从 systemd 页查看。App 不假设 SSH 用户就是数据库管理员。")
                    OutlinedButton(onClick = { run { Operations.nativeServices } }) { Text("发现原生数据库服务") }
                }
            }
        }
    }
}
@Composable fun ActionRow(labels: List<String>, action: (String) -> Unit) { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { labels.forEach { OutlinedButton(onClick = { action(it) }) { Text(it) } } } }
