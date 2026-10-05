package dev.vpsdeck.ops

object Shell {
    fun quote(value: String): String { require(!value.contains('\u0000')) { "参数包含 NUL" }; return "'" + value.replace("'", "'\"'\"'") + "'" }
    fun unit(value: String): String { require(value.matches(Regex("[A-Za-z0-9_@.:-]{1,180}"))) { "服务名格式不正确" }; require(!value.startsWith("-")); return value }
    fun absolute(value: String): String { require(value.startsWith("/") && !value.contains('\u0000') && !value.contains('\n') && !value.contains('\r')) { "请输入绝对路径，不允许换行" }; return value }
    fun filename(value: String): String { require(value.isNotBlank() && value !in listOf(".", "..") && !value.contains('/') && !value.contains('\u0000')) { "文件名无效" }; return value }
    fun child(parent: String, name: String) = parent.trimEnd('/') + "/" + filename(name)
}

data class Operation(val title: String, val command: String, val risk: String = "只读", val explanation: String = "", val timeoutSeconds: Int = 45) {
    fun privileged(sudo: Boolean): Operation = if (!sudo) this else copy(command = "sudo -n -- sh -c " + Shell.quote(command), explanation = explanation + "\n使用 sudo -n：无免密权限时会失败；不会记录或自动提交 sudo 密码。")
}

object Operations {
    val services = Operation("服务列表", "systemctl list-units --type=service --all --no-pager --plain")
    fun service(name: String, action: String): Operation {
        val q = Shell.quote(Shell.unit(name))
        return when(action) {
            "日志" -> Operation("服务日志 · $name", "journalctl -u $q -n 150 --no-pager -o short-iso")
            "状态" -> Operation("服务状态 · $name", "systemctl status --no-pager -- $q")
            else -> { val verb = mapOf("启动" to "start", "停止" to "stop", "重启" to "restart", "开机启用" to "enable", "取消开机" to "disable")[action] ?: error("未知动作")
                Operation("$action · $name", "systemctl $verb -- $q", "变更", "可能影响正在使用该服务的连接。") }
        }
    }
    val containers = Operation("Docker 容器", "docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'")
    val dockerStats = Operation("Docker 资源", "docker stats --no-stream")
    val dockerImages = Operation("Docker 镜像", "docker images --digests")
    val dockerVolumes = Operation("Docker 数据卷", "docker volume ls; docker network ls")
    fun container(name: String, action: String): Operation {
        require(name.matches(Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"))) { "容器名无效" }
        val q = Shell.quote(name)
        return when(action) {
            "日志" -> Operation("容器日志 · $name", "docker logs --tail 200 -- $q")
            "详情" -> Operation("容器详情 · $name", "docker inspect -- $q", explanation = "输出可能含环境变量中的秘密，仅在本次页面显示，不保存完整输出。")
            else -> { val verb = mapOf("启动" to "start", "停止" to "stop", "重启" to "restart", "删除容器" to "rm")[action] ?: error("未知动作")
                Operation("$action · $name", "docker $verb -- $q", if(verb == "rm") "高风险" else "变更", "不删除数据卷。运行中的容器不会被强制删除。") }
        }
    }
    fun compose(directory: String, action: String): Operation {
        val cmd = mapOf("状态" to "ps -a", "配置检查" to "config --quiet", "日志" to "logs --tail 150", "拉取镜像" to "pull", "应用配置" to "up -d", "停止" to "stop", "移除服务" to "down")[action] ?: error("未知动作")
        return Operation("Compose · $action", "cd ${Shell.quote(Shell.absolute(directory))} && docker compose $cmd", if(action in listOf("状态", "配置检查", "日志")) "只读" else "变更", "使用目录中现有 Compose 配置。不会添加 -v、强制删除卷或自动安装 Docker。", 180)
    }
    val nginxSites = Operation("Nginx 站点", "for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do if [ -d \"\$d\" ]; then ls -lah -- \"\$d\"; fi; done")
    val nginxTest = Operation("Nginx 配置检查", "nginx -t", explanation = "普通用户可能没有读取证书或配置的权限。")
    val nginxReload = Operation("Nginx 检查并重载", "nginx -t && systemctl reload nginx", "变更", "语法检查失败时不会重载。")
    val nativeServices = Operation("原生网站与数据库服务", "systemctl list-units --type=service --all --no-pager --plain | grep -Ei 'nginx|apache|httpd|php.*fpm|mysql|maria|postgres' || true")
    fun certificate(path: String) = Operation("证书信息", "openssl x509 -in ${Shell.quote(Shell.absolute(path))} -noout -subject -issuer -dates -fingerprint -sha256")
    fun database(engine: String, name: String, file: String, restore: Boolean): Operation {
        require(name.matches(Regex("[A-Za-z_][A-Za-z0-9_]{0,62}"))) { "数据库名只允许字母数字下划线，不能以数字开头" }
        val db = Shell.quote(name); val target = Shell.quote(Shell.absolute(file))
        val command = when(engine) {
            "PostgreSQL" -> if(restore) "psql --no-password --set ON_ERROR_STOP=on --dbname=$db --file=$target" else "pg_dump --no-password --dbname=$db > $target"
            "MariaDB" -> if(restore) "mariadb --database=$db < $target" else "mariadb-dump --single-transaction --databases $db > $target"
            else -> if(restore) "mysql --database=$db < $target" else "mysqldump --single-transaction --databases $db > $target"
        }
        val safe = if(restore) command else "umask 077; set -C; $command"
        return Operation(if(restore) "恢复数据库 · $name" else "备份数据库 · $name", safe, if(restore) "高风险" else "变更", "使用服务器现有 socket/peer/.my.cnf/.pgpass 认证，不复用 SSH 密码。备份拒绝覆盖已有文件；失败的备份可能是不完整文件，必须核对退出码。恢复可能覆盖数据，不自动回滚。", 300)
    }
    val reboot = Operation("重启服务器", "systemctl reboot", "高风险", "所有连接将断开。断线不代表重启成功，需要稍后重新连接确认。")
}
