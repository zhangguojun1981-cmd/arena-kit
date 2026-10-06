# VPS Deck · 掌上运维 — 验收与交付

## 当前交付：0.2.0-stageB / code4（2026-10-06）

- 阶段A服务/容器面板及阶段B网站/文件管理已构建并在用户手机原位覆盖安装；原服务器、私钥、主机指纹保留，升级后SSH连接成功。
- 当前已交付源码：`5a84a3d392574d65139964fcd8a66266cd341b8f`。后续Git中的stageC-dev仅开发状态，不等于手机交付版本。
- 服务/容器支持资源列表、详情、状态动作、自启管理、日志；网站支持静态/反代/PHP表单、配置diff、启停、配置备份及事务恢复、实际HTTP检查、现有证书配置及显式certbot申请/已有续期timer入口。
- 文件管理补齐面包屑、筛选、排序、新建空文件、普通权限修改及核验、已知总大小的传输百分比；不递归修改权限，不删除非空目录。
- 现有非托管Nginx配置只读发现，不自动转换成表单或覆盖。网站操作需要原生Nginx/Python3及权限；PHP需运行中的FPM，证书申请需已有certbot、用户自己的公网域名/DNS与80端口。不会自动安装软件或修改防火墙。
- 构建CI37395459786、设备CI37395459768均通过；16项Python测试与独立真实Nginx静态站HTTP200/反代HTTP200/停用源站后502验收通过；JVM/SSH和设备表单回归成功。
- 真机已验证：同签名升级、旧凭据连接、新服务列表、新网站页面发现既有配置、新建网站表单、文件导航/筛选/排序页面。未在用户生产VPS创建站点或重载Nginx；真实PHP动态请求、公网ACME签发和证书实际续期尚未验收。
- **阶段C尚未完成：** 容器创建/重建、Compose项目面板、数据库/账号/授权/备份恢复面板、环境安装向导、远端持久任务与断线续查仍待实现。当前只开始SSH stdin安全请求通道；旧高级入口明确保留，不能视为阶段C已交付。

### 安卓文件位置

```text
Download/VPSDeck/
  project/                                     当前阶段B完整源码（70项文件）
  stages/stage-A-a7f0b5d/project/                阶段A源码快照
  stages/stage-B-5a84a3d/project/                阶段B源码快照
  releases/VPSDeck-0.2.0-stageB.apk              当前已安装的同签名APK
  releases/VPSDeck-source-0.2.0-stageB-5a84a3d.zip
  docs/PANEL-UPGRADE.md                          完整方案和阶段验收记录
```

更新project前与旧源码ZIP逐项核对，无用户修改冲突；新旧阶段ZIP与旧APK均保留。Mac副本在 `~/Desktop/VPSDeck-0.2.0-stageB/`。

APK SHA256：`bc320aca75e776689e8e844c1246df7ce82eb642f06625b16a496c27936d93e3`（13,716,878字节）。
源码ZIP SHA256：`88ac7b038645e1e95274646b3995a8f36b54236351b85aa7b3013bb4a8c8ae94`（214,176字节）。
签名身份保持原证书不变；不要卸载App或清除数据。旧APK是历史归档，不承诺直接降级安装。

以下为历史交付记录，以本节为准。

## 历史进度：0.1.1（2026-10-06）

- 修复OEM私钥导入入口，优先使用可用的系统DocumentsUI；版本0.1.1/code2，源码 `2973a7b7e3e0c50601d3438178e4d1c4b011a92b`。
- CI构建37388163894、设备回归37388163794成功：23项核心/SSH/SFTP + 7项Android设备测试通过。Mac本地构建、lint和23项测试也通过，签名前已逐一核对工程源码。
- 新版实际保存于Mac `~/Desktop/VPSDeck-0.1.1/`。APK使用原签名身份，证书SHA256与下方原版相同；仅允许原位覆盖升级，不要卸载旧版。
- APK `releases/VPSDeck-0.1.1.apk` SHA256：`25b95f36498f9c384d1fd65a47abf56095227229f616a520cfed651955de4fdb`。
- 源码 `releases/VPSDeck-source-0.1.1.zip` SHA256：`d813cc99a98e5858b1f028bdfe58340569f7609914254fbcbf40488f17dbcac5`。
- **安卓更新交付、原位升级和真实App连接均已完成。** 63个更新文件逐项校验，整包SHA256一致；系统确认0.1.1/code2。保留原版安装包/源码归档以及已有服务器资料和主机信任。新版APK位于手机 `Download/VPSDeck/releases/VPSDeck-0.1.1.apk`。
- **真实App私钥登录与跨进程持久化验证通过：** 系统SAF成功从Termux私有目录导入已有手机专用密钥（空口令），完成加密保存；App实际连接授权VPS，识别Debian12并显示内存/磁盘状态。断开、停止并重启App后，未重新导入凭据仍可连接，CPU/网络采样出现有效值。原主机指纹保持固定，未启用密码登录或修改服务。私钥原件在Termux私有目录，App副本经Keystore加密，不进入Download或Git。
- 本次真机验收范围为升级、导入、凭据持久化、SSH连接及只读概览；PTY/SFTP及有副作用的生产运维操作没有在本次实机验收中执行。

以下为0.1.0历史交付记录，其中“未安装/未操作VPS”描述的是当时状态，以本节最新状态为准。

## 0.1.0版本记录

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

## UI重写候选更新（2026-10-06）
用户已确认阶段C新版安装。新的UI候选为`b94d549`（0.3.0-ui-preview/code6），构建37457010717、设备测试37457010723均通过，签名证书不变。具体内容及SHA256见`VPSDECK_UI_REDESIGN.md`。

手机已收到较早的`fc1a2c8` UI源码独立快照，但最终候选交付时Android agent已离线。因此**b94d549 APK/源码/截图尚未交付手机，也未安装**；不要把CI成功或Mac签名完成等同于手机验收。旧版本、顶层阶段C源码、A/B/C快照均保留。
