# VPS Deck · 掌上运维 — 0.1.0 验收与交付

## 本次版本

- 原生 Android：Kotlin、Jetpack Compose、Room、Android Keystore；不是网页面板套壳。
- Android 8.0（API 26）及以上；包名 `dev.vpsdeck`。
- 构建源码：`631da95b4c01925d77b146e344eeddcee8b5f63d`。
- 工程目录：`apps/vpsdeck/`；开发方案与逐段记录：`VPSDECK_PLAN.md`。

## 已验证

| 项目 | 结果 | 依据 |
|---|---|---|
| Kotlin/Java 编译、debug/release APK、lint | 通过 | [构建 37329392468](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37329392468) |
| 命令转义、参数/采样解析及本机 SSH/SFTP 夹具 | 工作流通过，具体计数见归档 JUnit 报告 | 同上 |
| Android 34 模拟器：加密存储、Room、终端仿真、IME、原生添加服务器、编辑目标保护 | 通过 | [设备测试 37329358117](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37329358117) |
| 用户手机同步/安装 | **待完成：设备代理离线** | 2026-10-05 再次检查仅 host/mac 在线 |
| 用户实际 VPS | **待验收** | 未取得、也未使用用户生产 SSH 凭据 |

模拟器测试提交为 `f9d812e`；与构建提交 `631da95` 的差异仅为 `.gitignore` 及移除误入的 Python 字节码缓存，Android 源码与测试完全相同。模拟器通过不代表所有厂商手机及所有 Linux 发行版都已验证。

## 功能范围

服务器分组/置顶，密码/私钥 SSH，显式主机指纹信任与变更拒绝；多会话 PTY 命令行、VT/ANSI/UTF-8；Linux 资源采样；SFTP 文件与文本配置编辑；systemd、Docker/Compose、Nginx/证书与原生数据库的运维操作计划。危险结构化操作先展示目标、命令与风险，再确认；不自动安装软件、不静默 sudo、不重放中断命令。

命令行直接执行用户输入，不能等同于所有终端命令都有结构化确认。配置备份/摘要检查不是多管理员事务，操作期间避免他人并发修改。数据库恢复没有自动回滚。

## 交付目录规范

```text
VPSDeck/
  README.md
  project/                 完整独立 Android 工程与许可
  docs/                    方案、验收说明、CI 测试报告
  releases/
    VPSDeck-0.1.0.apk       本地长期密钥签名后生成
    VPSDeck-source.zip
    SHA256SUMS.txt
```

目标手机目录：`/storage/emulated/0/Download/VPSDeck/`。手机离线时不会假定写入成功；源码与 APK 先准备在 Mac。私钥、密码、Android 签名密钥不进入上述目录。**此目录结构是交付规范，不是手机已收到的声明。**

## 首次使用验收

1. 安装同一长期签名的 APK；首次允许连接通知。不要为切换 debug/release 而贸然卸载保存了凭据的应用。
2. 添加一台授权测试 VPS；通过独立可信渠道比对 SSH 主机指纹后再信任。
3. 终端先执行 `whoami`、`uname -a`；验证交互输入、中文输出、缩放与前后台切换。
4. 使用可删除的测试文件夹验证上传/下载/重命名；不要用真实站点配置做第一次保存测试。
5. 先查看资源与服务状态；再在测试环境验证 Docker/Compose、Nginx 检查及数据库备份。数据库恢复须先有独立可恢复备份。
6. 长任务放入服务器 `tmux`。手机断网后先确认远端状态，不要直接重复有副作用的命令。

详细构建、签名与功能限制见 `apps/vpsdeck/README.md`。
