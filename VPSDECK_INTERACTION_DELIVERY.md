# VPS Deck 0.3.1 管理交互与终端重构交付记录

## 固定候选
- 源码：`69611bccaadb0ee17f3f7a7b0b93f2ec46d40ad4`
- 应用：`dev.vpsdeck`，versionCode **7**，`0.3.1-interaction-preview`
- APK：`VPSDeck-0.3.1-interaction-preview-69611bc.apk`，13,881,009 字节
- APK SHA-256：`a8aba166a8a829137c8a3f2501a1f390c7b77e52f0403f615f730856cf14cf3b`
- 签名证书 SHA-256：`f7ad243ac633980138c483db24bf2909833ea95bc8fef2259097f8f951405be6`（与前版相同）
- 源码 ZIP：`VPSDeck-source-interaction-69611bc.zip`，298,203 字节，100 个文件
- 源码 ZIP SHA-256：`04cf7f4f5e720714955e2866008af89cf24c181049b75ea95ae3bc27514dd20f`

## 本轮实现
- 服务、网站、Compose 项目、环境、数据库、应用部署六类页面统一标题、工具区、资源信息和操作组；补齐适用的搜索、计数及空状态。
- 操作组按可用宽度整颗按钮换行，按钮文字本身单行；资源名、路径、容器名称不再堆进操作按钮。保持11–14sp字号及系统无障碍缩放。
- 命令结果、错误、日志、任务详情、配置差异、操作预览、采样错误、部署提示、终端状态均提供复制入口；敏感剪贴板标记、成功/失败反馈、空输出提示。
- 超过64,000个UTF-16字符的输出分段复制，边界不截断代理对；复制的是当前保留内容，不能恢复上游已截断或终端滚动缓冲已淘汰的内容。
- 终端可在命令栏输入并点“执行”或键盘发送；发送UTF-8及回车到原SSH PTY，不另开exec，不模拟输出。
- 保留直接终端输入、软键盘、回车、Tab、Esc、Ctrl及方向键；键盘出现时减少次要工具条占用，切换会话只释放对应的原生终端视图。
- 复制终端历史/屏幕在点击时读取最新文本，避免Compose未重组造成旧快照。
- 断线不自动重放，离线不能执行，发送队列拒绝时保留输入；确认对话框、备份、校验、独立数据库认证保持原有边界。
- 预览复制只提取展示字段，不复制原始请求、认证对象或环境变量对象。

## 验证证据
- [构建、单元测试、lint及一次性环境后端验收](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37470648583)：**SUCCESS**。
- [Android API34设备自动化](https://github.com/zhangguojun1981-cmd/arena-kit/actions/runs/37470648819)：**SUCCESS**。
- 新增覆盖：窄屏/放大字体单行按钮、剪贴板内容与实时快照、命令执行与IME、离线/拒绝发送保留输入、Unicode分段、原生IME回车/Tab、SSH shell PTY传输。
- SSH shell测试使用一次性回环服务验证PTY/UTF-8/ANSI传输，不等同于在用户生产VPS实际执行命令。
- Python后端单元测试：78项通过；`git diff --check`通过。
- Mac从固定候选源码运行`:app:assembleRelease :app:compileDebugAndroidTestKotlin`成功；zipalign、apksigner验证通过，包名/版本号核对完成。
- 初稿03a1d2f的组件命名编译问题、c714101的测试API链式调用问题已修复；两者不是验收版本。被后续提交取消的流水线不计作通过。

## 交付状态
- 手机源码：`Download/VPSDeck/stages/interaction-69611bc/project/`，100个文件解压后逐一比对通过。
- 手机源码ZIP：`Download/VPSDeck/releases/VPSDeck-source-interaction-69611bc.zip`，SHA-256核对通过。
- 手机APK：`Download/VPSDeck/releases/VPSDeck-0.3.1-interaction-preview-69611bc.apk`，27个分块及合并文件SHA-256全部核对通过；交付完成。
- 手机回执：`Download/VPSDeck/docs/INTERACTION-DELIVERY-69611bc.json`。
- 已通过系统文件打开方式请求覆盖安装，命令返回0；不将其当作已显示安装界面或安装成功。
- Mac构建：`~/VPSDeck-build/interaction/69611bc/`；桌面候选包：`~/Desktop/VPSDeck-Interaction-preview-69611bc/`。
- 顶层旧`project/`及既有冲突文件未覆盖；历史快照保留，03a1d2f草稿已标注被替代。
- 未卸载、未清数据、未重新配SSH密钥、未重置主机指纹、未修改生产VPS。
- 安装请求之后Android代理离线；最后一次目录入口说明和回执安装字段补记未获确认。APK、源码及初始传输回执已在掉线前交付并校验。暂以本记录中的0.3.1路径为准，旧入口说明可能仍指向0.3.0。
- **此候选尚未确认安装；模拟器通过不等于用户手机交互验收完成。**

## 安装后检查
1. 原位覆盖安装，勿卸载旧版。确认服务器配置仍在，版本为0.3.1。
2. 连接服务器后打开终端，命令栏输入`pwd`，点“执行”；确认真实输出后点“复制历史”。
3. 使用键盘/终端区域直接输入；使用底栏回车、Tab、方向键及Ctrl-C；交互程序使用直接输入模式。
4. 命令栏和直接输入共用当前PTY，不要混用未提交的输入。“执行”仅表示提交到发送队列，不是远端执行成功的确认；断线时执行结果可能未知，不会自动重发。
5. 逐个检查六类管理页的操作卡片。排障请使用输出/错误旁的复制按钮；分享前检查是否含敏感信息。

## 仓库同步
功能代码69611bc已推送并完成CI。最后一笔交付说明的远端推送因GitHub认证失效未完成；本地文件已保存，待Arena重新连接GitHub后推送当前工作分支。此问题不影响已交付到手机的APK与源码。


## 待恢复连接后的收尾
- 在Arena重新连接GitHub后，只推送当前工作分支的交付说明提交；无需重新构建已验证的69611bc候选。
- 安卓代理恢复后，先确认安装情况；目录说明/回执补记脚本已缓存于Mac `~/VPSDeck-build/interaction/69611bc/transfer/finish.py`，SHA-256为`85532c6f8a1dbba814cad7545523fa58be90188c6953f0eee62713402cc50c88`。运行前确认未覆盖后续安装确认记录，并在完成后读回核对。
- APK下载进程13378已成功退出0，不要重新启动传输。安装请求195返回0不是安装成功凭证。
