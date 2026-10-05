# VPS Deck · 掌上运维 — 0.1.0 验收与交付

## 本次版本

- 原生 Android：Kotlin、Jetpack Compose、Room、Android Keystore；不是网页面板套壳。
- Android 8.0（API 26）及以上；包名 `dev.vpsdeck`。
- 构建源码：`2322582b7fb5b2d24be1f88d2626a7be113487bd`。
- 工程目录：`apps/vpsdeck/`；开发方案与逐段记录：`VPSDECK_PLAN.md`。

## 已验证

| 项目 | 结果 | 依据 |
|---|---|---|
| Kotlin/Java 编译、debug/release APK、lint | 通过 | [构建 37330614349](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37330614349) |
| 命令转义、参数/采样解析及本机 SSH/SFTP 夹具 | 23/23 通过（16 项核心 + 7 项 SSH/SFTP） | 同上 |
| Android 34 模拟器：加密存储、Room、终端仿真、IME、原生添加服务器、编辑目标保护 | 6/6 通过 | [设备测试 37329358117](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37329358117) |
| 用户手机同步/安装 | **已复制并校验；尚未安装** | 2026-10-06 安卓在线，89个文件逐项校验一致 |
| 用户实际 VPS | **待验收** | 未取得、也未使用用户生产 SSH 凭据 |

模拟器测试提交为 `f9d812e`；与构建提交 `2322582` 的差异仅为交付文档/归档工作流、`.gitignore` 及移除误入的 Python 字节码缓存，Android 源码与测试完全相同。模拟器通过不代表所有厂商手机及所有 Linux 发行版都已验证。

## 功能范围

服务器分组/置顶，密码/私钥 SSH，显式主机指纹信任与变更拒绝；多会话 PTY 命令行、VT/ANSI/UTF-8；Linux 资源采样；SFTP 文件与文本配置编辑；systemd、Docker/Compose、Nginx/证书与原生数据库的运维操作计划。危险结构化操作先展示目标、命令与风险，再确认；不自动安装软件、不静默 sudo、不重放中断命令。

命令行直接执行用户输入，不能等同于所有终端命令都有结构化确认。配置备份/摘要检查不是多管理员事务，操作期间避免他人并发修改。数据库恢复没有自动回滚。

## 已完成的 Mac 交付

```text
VPSDeck/
  README.md
  project/                 完整独立 Android 工程与许可
  docs/                    方案、验收说明、CI 测试报告
  releases/
    VPSDeck-0.1.0.apk       已签名，可安装 release
    VPSDeck-source.zip
    SHA256SUMS.txt
```

目标手机目录：`/storage/emulated/0/Download/VPSDeck/`。Mac 已实际保存于 `/Users/zhangguojun/Desktop/VPSDeck-0.1.0/`。2026-10-06 已复制到安卓下载目录并校验；尚未安装或进行真机/VPS功能验收。私钥、密码、Android 签名密钥不进入上述交付目录。

## 首次使用验收

1. 安装同一长期签名的 APK；首次允许连接通知。不要为切换 debug/release 而贸然卸载保存了凭据的应用。
2. 添加一台授权测试 VPS；通过独立可信渠道比对 SSH 主机指纹后再信任。
3. 终端先执行 `whoami`、`uname -a`；验证交互输入、中文输出、缩放与前后台切换。
4. 使用可删除的测试文件夹验证上传/下载/重命名；不要用真实站点配置做第一次保存测试。
5. 先查看资源与服务状态；再在测试环境验证 Docker/Compose、Nginx 检查及数据库备份。数据库恢复须先有独立可恢复备份。
6. 长任务放入服务器 `tmux`。手机断网后先确认远端状态，不要直接重复有副作用的命令。

详细构建、签名与功能限制见 `apps/vpsdeck/README.md`。

## 安装包核验与签名身份

Mac 上的 release APK 已通过 `apksigner verify`，v2/v3 签名均有效。

```text
APK SHA-256
19ce1cf97dcbb79d7761fe7efbdc84694cdd01df288fad972ad25ff519320e76

源码ZIP SHA-256（Mac交付包内的CI原始归档）
c6c54a6a019ce61fae0d179dc578f933707c5816a7949b3bfa14696fae26303f

签名证书 SHA-256
f7ad243ac633980138c483db24bf2909833ea95bc8fef2259097f8f951405be6
```

专用长期签名身份由 Mac 本地新建，RSA 3072 位。私密目录为 `/Users/zhangguojun/.vpsdeck-signing/`（目录0700、文件0600），没有上传到仓库或复制进交付目录。请将整个私密目录另行安全离线备份；后续版本必须使用相同密钥才能原位升级。不要把该目录复制到手机Download。

交付保留最新构建的JUnit/lint XML、构建日志及模拟器报告；测试零失败、零错误、零跳过。未对用户生产VPS执行操作，未宣称真机或真实站点管理已经验收。

## 安卓交付状态（2026-10-06）
已保存到 `/storage/emulated/0/Download/VPSDeck/`。安装文件为 `releases/VPSDeck-0.1.0.apk`。89个交付文件均已比对，APK和源码ZIP的SHA256验证通过。本次没有执行安装或任何VPS操作。Termux编译时请先将project复制到Termux私有home，避免共享存储的noexec限制。

## 补充交付（2026-10-06）
根据用户要求，APK签名私钥库和密码文件已另行复制到安卓Termux私有 `~/.vpsdeck-signing/`（目录0700，文件0600）。安卓keytool确认签名证书指纹一致，Mac原件保留。它们不是SSH凭据，也未进入公共Download目录。卸载Termux可能删除私有目录，请另行安全备份。下载目录的VPSDeck文件夹新增 `00-先看这里.txt`。
