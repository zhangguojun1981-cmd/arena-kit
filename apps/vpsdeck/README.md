# VPS Deck — 原生 Android SSH 运维工作台

Kotlin / Compose，面向无面板 Linux VPS。**不会自动安装软件，也不会修改未确认的远端配置。**

## 源码与进度

根仓库 `VPSDECK_PLAN.md` 是持续更新的方案与真实验收记录。源码在本目录，与原 ArenaKit 应用独立。

## 构建

- JDK 17、Android SDK Platform 34 / Build Tools 34.0.0
- `local.properties`：`sdk.dir=/你的/android-sdk`
- 执行 `./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug`
- 输出 `app/build/outputs/apk/debug/app-debug.apk`。
- Debug APK仅用于首次验收；正式发行需你掌控的长期签名密钥。密钥不要放下载目录或Git。

Gradle wrapper固定8.7；依赖版本固定。首次构建需要联网获取依赖。Android Termux构建还需要与设备ABI匹配的aapt2：设置 `-Pandroid.aapt2FromMavenOverride=/绝对路径/aapt2`。CI使用GitHub Actions的Linux/Android工具链交叉编译；Mac也可按上述命令本地构建。

## 功能

- 服务器分组/置顶、密码/私钥认证、SHA256主机密钥固定与变化拒绝。
- Keystore AES-GCM凭据存储；关闭Android备份和截图；不采集遥测。
- SSH PTY终端，Termux VT仿真/渲染、多会话、特殊键、复制可见文本、粘贴确认。
- Linux资源采样（无采样时显示未知而非假数据）。
- SFTP上传/下载/浏览/目录/重命名/空目录删除；512KB内UTF-8文本编辑。
- systemd、Docker/Compose、Nginx/证书、原生数据库备份恢复的可预览操作计划。
- 操作记录只保存任务元信息；终端与远端输出不写入数据库。

## 使用

1. 添加服务器，录入SSH凭据。私钥通过Android文件选择器导入。
2. 连接时通过可信渠道核对服务器主机指纹。不能仅凭网络连接窗口判断真实性。
3. 先打开终端，验证 `whoami`、`uname -a`；再根据实际权限使用管理工具。
4. 非root用户可选择 `sudo -n`，只使用已经授予的远端免密权限。不自动发送sudo密码。
5. 数据库工具依赖服务器现有数据库认证（peer/socket/.pgpass/.my.cnf）。不复用SSH密码。

## 限制与安全边界

- 无Agent，无全天候可靠后台监控；Android可停止后台服务。长任务使用远端tmux。
- 不自动重连或重放有副作用的命令；连接中断/超时后远端结果可能未知。
- UI发现命令不代表其有执行权限。systemd仅适用于systemd系统；Compose要求v2。
- 备份拒绝覆盖，失败时可能留下不完整备份，必须检查任务退出码。数据库恢复不提供自动回滚。
- 文件编辑不处理符号链接，不自动重载服务；Nginx语法检查并不能证明业务配置正确。
- 配置编辑使用摘要作乐观并发检查，不是跨管理员的强事务；操作期间仍应避免并发改配置。
- SFTP含 `* ? \\` 的路径请使用终端，防止库通配符误选目标。上传使用同目录暂存+GNU `ln -T` 排他落盘；不支持硬链接的文件系统会明确失败。
- 没有SSH跳板机、端口转发、云同步、可视化SQL编辑器、自动安装/证书签发等后续扩展。
- 当前使用GPL-3.0源码交付；终端上游与依赖见 THIRD_PARTY.md。

## 测试边界

单元测试覆盖命令转义、参数验证、采样解析。SSH集成测试只启动127.0.0.1临时MINA服务器，验证实际JSch握手/指纹/密码/exec/SFTP，不连接真实VPS、不使用你的密码。编译或这些测试通过不等于安卓真机验收。

## 本地签名与后续升级

CI输出debug APK与未签名release APK；正式安装优先使用你掌控的长期密钥签名release版本。

```sh
export JAVA_HOME=/你的/JDK17
python3 scripts/sign_release.py app-release-unsigned.apk VPSDeck-0.1.0.apk \
  --sdk /你的/android-sdk --create-key
```

首次显式传入 `--create-key` 时，脚本在 `~/.vpsdeck-signing/` 生成专用密钥及随机密码文件（目录0700、文件0600），不读取任何现有第三方签名密钥，不上传密钥。后续省略该参数即可复用；需要安全离线备份整个私有目录。丢失密钥不能原位升级。密码不会出现在命令行或日志中。源工程/交付目录不得存放该私有目录。

debug与release签名不同，不能互相覆盖安装；不要为了切换版本贸然卸载含有未另行保管凭据的应用。卸载会删除Keystore与本地数据。CI每次生成的debug签名也可能不同。
