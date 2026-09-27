# ArenaKit 开发文档

本文件是从零把 ArenaKit 推到"能出 dmg + apk"的完整开发指南:技术栈决策、里程碑、每个模块的移植来源与验收标准、真机验证方法、坑与规避。

---

## 0. 技术栈决策(为什么是 Tauri 2)

需求硬约束:

1. 一份代码同时编译 **macOS 桌面** 和 **Android**。
2. 必须能在 arena.ai 页面注入 **MAIN world** 脚本(截令牌、解锁、提示词都要求在页面脚本之前挂钩子、共享 `window`)。
3. 必须能用**原生 HTTP** 带着 WebView 的登录 Cookie 请求 `api.trigger.dev`(取证链,不能只靠页面 JS,页面 CSP/CORS 拦不住原生请求)。
4. 体积小、启动快(对标那个 337MB Windows exe 的反面)。

候选对比:

| 方案 | 双端 | MAIN world 注入 | 原生 HTTP | 体积 | 结论 |
|---|---|---|---|---|---|
| **Tauri 2** | ✅ macOS + Android(官方 mobile) | ✅ `initialization_script` 页面加载前执行 | ✅ Rust reqwest | ~5–10MB | **选它** |
| Electron | ❌ 无 Android | ✅ | ✅ Node | ~150MB | 出局(无安卓、臃肿) |
| Flutter + WebView | ✅ | ⚠️ `runJavaScript`,MAIN world 时机难保证 | ✅ Dart | 中 | 注入时机不稳,出局 |
| Kotlin Multiplatform + Compose | ✅ | ⚠️ 各端 WebView API 不统一 | ✅ | 中 | 双端 WebView 抽象成本高 |
| 原生 Swift + 原生 Kotlin(两套) | ✅ | ✅ | ✅ | 小 | 代码不共享,维护两份,出局 |

**Tauri 2 胜出理由**:唯一同时满足"双端 + 稳定 MAIN world 注入 + 原生 HTTP + 小体积"且**核心逻辑单份 Rust**的方案。已有的 `core.js`(JS)和 `ArenaProtocol.kt`(Kotlin)两版取证逻辑,移植到 Rust 后成为**唯一真相源**,两端共用。

语言分工:
- **Rust**(`src-tauri/`):trace 取证网络层、JSON 持久化 store、页面↔dock 事件中继、`arena_command`(dock 向 arena 页面 eval)、白名单 `proxy_get`、WebView 初始化与脚本注入。两端共用。
- **JS**(`injected/`):注入 arena.ai 的 MAIN world 脚本(桥、截令牌、回复监控、额度轮询、探针 RPC、增强脚本)。
- **JS**(`src/`):原生 **dock** 面板(独立 webview,ES module,不随 arena 页面刷新)+ `src/lib/*` 纯逻辑库(全部有 node:test 单测)。
- 平台特定代码极少:仅 WebView 宿主创建与权限声明,由 Tauri 封装。

> 设计要点:**dock 是编排者,arena 页面只做无状态的 DOM 动作**。探针/清理/重命名循环都在 dock 里跑(`src/lib/probe-runner.js`),每一步通过 `arena_command` 调页面的 `window.ArenaProbe.call(...)`,结果经桥以 `probe-result` 页面事件回到 dock。Rust 只做薄中继。

---

## 1. 里程碑(建议迭代顺序)

> 每个里程碑独立可验证。禁止跳过验证进入下一阶段。

### M0 — 脚手架(本次初版交付)
- 仓库结构、文档、复用核心 JS(`injected/*.js` 从上游拷贝并标注来源)、Tauri 配置骨架、CI 骨架。
- 验收:`git` 可推送;文档自洽;注入脚本已就位。**尚不保证可编译运行**(Rust 命令为占位/TODO)。

### M1 — 桌面套壳可跑(A 的最小闭环)✅ 代码就位
- `cargo tauri dev` 打开 arena.ai,登录态正常。
- 注入 `manager.js`(筛选助手)生效:能看到筛选面板、`Ctrl+Shift+M` 打开。
- 实现:`lib.rs` `build_init_script` 组装注入管线,`setup` 时 `win.eval` 注入;`gm-shim.js` 提供 `GM_*` 垫片。
- 验收:真机截图,面板出现,能隐藏/排序模型。**待真机跑 `cargo tauri dev` 截图确认。**

### M2 — 前端增强全量注入 ✅ 代码就位
- 追加 `unlock.js`(解锁隐藏模型)、`plus.js`、`leaderboard.js`、`eni.js`(提示词注入,带设置面板)。
- 实现:全部纳入 `build_init_script`;`proxy_get`(白名单原生 GET)绕页面 CORS 供取 Logo/价格/Gist。
- 验收:Direct 模式能选出 Claude Opus;排行榜出现性价比列;新对话带上系统提示词(在 trace 里能看到 prompt 前缀)。**待真机确认。**

### M3 — 取证核心移植到 Rust(B 的核心)✅ 逻辑完成+测试
- 把 `core.js` / `ArenaProtocol.kt` 的 `validate_token` / `extract_models` / SSE 解析移植成 `src-tauri/src/trace.rs`,附单元测试(对齐扩展版 `core.test.mjs` 与安卓 `ArenaProtocolTest.kt` 的用例)。
- `snoop.js` 截令牌 → `__ARENAKIT__.onToken` → `fetch_trace` 命令 → Trigger.dev 8×3s 轮询 → `extract_models` → `emit('arenakit://models')`。
- 状态:10 单测全绿(validate/extract/dedup/fatal-status);实况轮询已接线。**待真机发消息确认 HUD 显示模型名。**

### M4 — 额度百分比(pulse)✅ 代码就位
- `injected/pulse.js` 在 arena 页面内同源 `GET /api/me/pulse`(自带 Cookie,**不导出凭据**):60s 节奏、Cookie 变化(切账号)15s、429 按 `Retry-After` 退避(上限 10 分钟);结果以 `pulse` 页面事件送 dock。
- `src/lib/pulse.js` 移植安卓 `PulseTiming`:`resetTimeFromRefreshedAt` + `anchorReset`(倒计时不再每次刷新回跳 24h)、`<10%` 红 / `<20%` 黄。
- 验收:dock「额度」模块显示百分比 + 三色条 + `H:MM:SS 后重置` 每秒走字;切账号刷新;429 时显示限流并退避。**待真机确认。**

### M5 — 探针 / 清理 / 历史 / 轮次 / 重命名 / 会话探针 / 回复监控 ✅ 代码就位
全部从 arena-trace-android(及其参考的 arena-trace-inspector)移植,对应关系:

| 功能 | dock 模块 | 逻辑库(单测) | 页面侧 | 来源 |
|---|---|---|---|---|
| 服务端模型 + **轮次对话解析模型** | 服务端模型 | `src/lib/turns.js`(TurnTracker) | snoop.js → Rust trace | android `TurnTracker.kt` |
| **使用额度(Token / 费用,非百分比)**;覆盖率 / 查看运行 / 证据来源 | 使用额度 | `src/lib/usage.js` + `src/lib/usage-view.js` + `src-tauri/src/usage.rs` | — | inspector `core.js` span 用量标签、`view-model.js` / `popup.js` 运行视图 |
| **会话历史**(搜索/分页/打开/查看运行/删除/导出/清空,累计不因淘汰丢失;**归档当前对话并删除记录**) | 会话历史 | `src/lib/history.js`、`dock.js archiveCurrent` | `conversation-rename.js` archive | inspector `history.js` / `hud.js` 归档聊天及删除记录、android `HistoryLogic.kt` |
| **重命名对话(可加前缀)** | 重命名对话 | `src/lib/rename.js`、`src/lib/rpc.js` | `injected/conversation-rename.js`、`injected/probe.js` | android `conversation-rename.js` / `probe.js` |
| **自动探针(抽卡)** + **自动抽卡**(`mode:'draw'`:无目标,每轮命名为模型名,不消耗序号) | 自动探针 | `src/lib/probe-logic.js`、`src/lib/probe-runner.js` | `injected/probe.js` | android `ProbeLogic.kt` / `ProbeController.kt`、inspector `auto-draw.js` |
| **自动清理**(归档算式标题残留,`onArchived` 钩子同步删本地记录) | 自动清理 | `probe-runner.cleanup` | `probe.js` sidebarList/revealSidebarItem/archive | android `ProbeController.cleanup`、inspector 归档后删记录 |
| **会话探针**(向当前对话发探针,识别本轮模型) | 会话探针 | `src/lib/session-probe.js` | `probe.js` sendToCurrent | android `quickSend` + TurnTracker |
| **回复监控**(空回复/报错/中断/停滞 自动标记轮次) | 回复监控 | `src/lib/monitor.js` | `injected/monitor.js`(snoop 帧钩子) | ArenaKit 新增(用户需求) |

- 验收:探针能跑完设定轮数、命中即停/命中全部才停、命中改名「前缀+模型-序号」;清理只归档算式标题且不碰当前对话;会话探针在当前对话内识别本轮模型;回复流异常在轮次列表出现徽标,正常显示「无异常信号」。**待真机确认。**

### M6 — Android 出包 ✅ CI 就位
- 图标:`python3 scripts/make-icons.py` 用纯 Python 从矢量数据渲染 `src-tauri/icons/`(icon.png 1024 / 128@2x / 128 / 32 / icon.icns / icon.svg),图形与参考安卓项目的启动图标一致(深色渐变底 + 蓝/翠绿 A 形双翼 + 白色扫描线);安卓 API 26+ 用 `src-tauri/android/.../mipmap-anydpi-v26` 的自适应图标(矢量 `ak_launcher_*`),旧设备回退到 `tauri icon` 生成的 PNG。
- `src-tauri/android/` 是覆盖到生成项目 `gen/android/` 上的安卓源码(CI 在 `android init` 之后 `cp -R` 过去):`MainActivity.kt` 保留 edge-to-edge 但按系统栏 / 刘海 / 输入法 insets 给内容加 padding,网页顶部正好与状态栏底部平齐、底部在导航栏之上、键盘弹出时页面收缩(参考项目 targetSdk 34 的原生表现;Tauri 模板 targetSdk 37,Android 15+ 强制 edge-to-edge 不可关闭)。状态栏 / 导航栏底色跟随系统深浅色。
- `cargo tauri android build --apk --target aarch64` 出 release arm64 apk(优化 + strip,debug 包带符号约 190 MB),CI 再用 `zipalign` + `apksigner` 以仓库内固定的调试密钥 `.github/android/debug.keystore`(PKCS12,别名 `arenakitdebug`,密码 `android`)签名——每次构建签名一致,可覆盖安装。这不是商店密钥;正式发布时换成 secrets 里的密钥。
- **dock 内嵌模式**:mobile Tauri 一窗一 webview(`Window::add_child` 仅桌面),所以安卓不建第二个 webview,而是 `node scripts/bundle-dock.mjs` 把 `src/dock.js` + `src/lib/*` + `src/embed/shell.js` 打成一个经典脚本 `src/embed/dock-embedded.gen.js`(已提交,CI `--check` 防过期),Rust 在 `#[cfg(mobile)]` 下 `include_str!` 并追加到 init 脚本末尾;页面加载后挂载悬浮 AK 按钮 + 底部抽屉(shadow DOM,样式互不干扰)。改了 `src/` 记得重新跑 bundler(测试 `embed-bundle.test.mjs` 会提示)。
- 验收:真机安装,登录、截令牌、额度、注入脚本、抽屉里的全部模块可用。

---

## 2. 模块移植表(来源 → 目标 → 注意)

上游仓库链接(接手对照原始实现):
- Arena-Manager — https://github.com/JimAchievo/Arena-Manager
- Model-Unlocker — https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension
- Arena.ai-Plus — https://github.com/chen-dahan/Arena.ai-Plus
- personal-leaderboard — https://github.com/wrapss/lmarena-personal-leaderboard
- Arena-Ai (ENI) — https://github.com/peyton2065/Arena-Ai
- inspector(取证核心,私有) — https://github.com/AI-modelsAPI/arena-trace-inspector
- android(取证核心,私有) — https://github.com/AI-modelsAPI/arena-trace-android

| 目标文件 | 来源 | 语言 | 移植要点 |
|---|---|---|---|
| `injected/bridge.js` | ArenaKit 新增 | JS | 页面侧 `window.__ARENAKIT__`:`onToken`/`send`(页面事件→dock)/`on`+`dispatch`(dock→页面)/`storeGet|Set`/`proxyGet`/SPA 导航 `nav` 事件。**必须第一个注入** |
| `injected/snoop.js` | inspector `snoop.js` | JS→JS | 几乎原样。`postMessage` 目标改为 `__ARENAKIT__.onToken`。**sessionFromUrl 正则必须与 trace.rs 的 streamSession 保持 lockstep**。ArenaKit 加了页面内帧钩子 `__ARENAKIT_MONITOR__`(会话文本不出页面) |
| `injected/monitor.js` | ArenaKit 新增 | JS | 把 SSE 帧归约为帧数/字节/文本长度/错误帧/结束方式/空闲时长,只上报摘要(`reply-monitor` 事件);停止按钮仍在且 2 分钟无帧 → 停滞 |
| `injected/pulse.js` | inspector `pulse.js` + android `PulseClient.kt`/`startPulseLoop` | JS/Kotlin→JS | 页面内同源 GET(Cookie 留在页面);60s / 切账号 15s / 429 退避;`pulse` 事件 |
| `injected/conversation-rename.js` | android `assets/conversation-rename.js` | JS→JS | 逐字节同源。只走 Arena 自带的侧栏 ⋯ 菜单与 Rename/Archive 对话框;归档≠删除 |
| `injected/probe.js` | android `assets/probe.js` | JS→JS | 无状态 RPC 层 `window.ArenaProbe.call(action, argsJson, reqId)`,结果改由 `__ARENAKIT__.send('probe-result', …)` 回传;`precheck` 增加 `hasDraft/draftIsOwnPrompt/title`。全部安全护栏保留(不覆盖人工草稿、只发算式、发送前确认 Agent Mode) |
| `injected/manager.js` | Arena-Manager `Arena Manager.user.js` | JS→JS | 通过 `gm-shim.js` 提供 `GM_*`;`GM_xmlhttpRequest` 走 `proxy_get` |
| `injected/unlock.js` | Model-Unlocker `main.js` + `boot.js` | JS→JS | 设置由 dock 开关经 `__AK_UNLOCK_SET__` 注入;必须 `document_start` MAIN world |
| `injected/plus.js` | Arena.ai-Plus `content.js` | JS→JS | 价格 fetch 走 `proxy_get` |
| `injected/leaderboard.js` | personal-leaderboard `content.js` | JS→JS | 纯本地统计 |
| `injected/eni.js` | Arena-Ai `arena-prompt-injector.user.js` | JS→JS | fetch 钩子注入 prompt;设置面板在 dock |
| `src-tauri/src/trace.rs` | inspector `core.js` + android `ArenaProtocol.kt` `TraceClient.kt` | JS/Kotlin→Rust | validateToken / extractModels / 8×3s 轮询。**逐条对齐两版规则** |
| `src-tauri/src/usage.rs` | inspector `core.js`(span 用量标签) | JS→Rust | 从 span 抽 Token / 费用;`partial` 时继续轮询补齐 |
| `src-tauri/src/store.rs` | ArenaKit 新增 | Rust | `<app_data_dir>/arenakit-store.json`,`store_get/set/keys`;dock 的 prefs / 会话历史 / 重命名闸门都存这里 |
| `src-tauri/src/pulse.rs` | android `PulseTiming.kt` | Kotlin→Rust | 仅保留阈值/退避常量;实况轮询在页面侧(`injected/pulse.js`),倒计时锚定在 `src/lib/pulse.js` |
| `src/dock.*` | inspector `hud.js` `panel.js` + android `MainActivity` 面板 | JS→JS | 原生 dock(独立 webview),模块:服务端模型/轮次、回复监控、使用额度、额度、会话历史、自动探针、自动清理、会话探针、重命名对话、功能模块、提示词注入 |
| `src/lib/turns.js` | android `TurnTracker.kt` | Kotlin→JS | 每轮 → 模型;`routed` = 与首轮模型不同;历史最多 6 条 |
| `src/lib/history.js` | inspector `history.js` + android `HistoryLogic.kt` | JS/Kotlin→JS | `history.<sessionId>` 记录 + `history-carry` 淘汰累计桶;200 条上限 |
| `src/lib/usage.js` | inspector `view-model.js` | JS→JS | 用量合并/汇总/格式化/证据导出 |
| `src/lib/rename.js` | ArenaKit 新增(前缀) + android `nextSuffix` | JS | `buildTitle({prefix, model, suffix})` ≤100 字符;每对话一次的自动重命名闸门 |
| `src/lib/rpc.js` | android `ProbeController.rpc()` | Kotlin→JS | 35s 超时、`deliver(probe-result)`、`cancelAll` |
| `src/lib/probe-logic.js` | android `ProbeLogic.kt` | Kotlin→JS | 目标解析/别名/模糊匹配、算式标题判定、清理候选、随机算式 |
| `src/lib/probe-runner.js` | android `ProbeController.kt` | Kotlin→JS | 探针循环、清理扫描、quickSend;停止即时生效(每个 await 与取消令牌竞速) |
| `src/lib/session-probe.js` | android `quickSend` + TurnTracker | Kotlin→JS | 前置检查(草稿/生成中/对话框)、等待本会话新一轮被识别 |
| `src/lib/monitor.js` | ArenaKit 新增 | JS | `classifyReply` → 回复报错/中断/停滞/空回复,否则「无异常信号」;标记到当前会话最新一轮 |
| `src/lib/pulse.js` | android `PulseTiming.kt` + inspector `pulse.js` | Kotlin/JS→JS | `resetTimeFromRefreshedAt`/`anchorReset`/`band`/`formatCountdown`/`createPulseState` |

---

## 3. 必须保留的已验证行为(不可回归)

来自 arena-trace-inspector skill,这些每一条都曾导致挂起并已修复,移植时必带对应测试:

- **探针命中才改名**;未命中保留算式标题。抽卡模式每轮都改名。
- **清理只扫算式标题**(`^\s*\d{1,4}\s*[+\-*/×÷]\s*\d{1,4}\s*=\s*$`),保留模型名标题/用户标题/当前打开的对话。
- **模式选择器标签**:折叠态读 `Agent`,展开态读 `Agent ModeBuilt for complex tasks`。用 `isAgentLabel` = `/^Agent(\s+Mode)?\b/i` 匹配两者,**禁止硬编码 `Agent Mode`**(会卡死 modeSelect)。
- **双令牌捕获**:`snoop.js` 的 sessionFromUrl 正则必须与 trace.rs streamSession 同步,页面钩子才是 debugger 通道失效时的真备份。
- 侧栏对话列表懒加载,等 `a[href^="/agent/"]` 出现再判"无可清理"。
- 默认 5 轮(1–100)。停止条件:命中即停(除非 findAll)、连续 3 次失败、或一次不可跳过的失败(草稿冲突/失去监听/导航)。detect 阶段的 token/trace 失败**可跳过**(下一轮是全新对话)。
- **令牌只读**:decode 不是验签;Trigger.dev 在 GET 时校验。本项目绝不写 `/api/**`。

## 4. Arena 事实(移植依据)

- Agent Mode 是 P2L 随机路由,`pinnedModel:null`,但同一对话后续消息保持同一模型(session 粘性)→ 模型名对话是稳定的按模型入口。**Direct 模式可直接选固定模型,无需探针。**
- 令牌是 Trigger.dev 公开运行 JWT(`iss=https://id.trigger.dev`, `pub=true`),scope 形如 `read:runs:run_xxx`。
- 服务端模型名藏在 trace 的 `ai.streamText.doStream` 等 span 的 `style.accessory.items` 里,`icon ∈ {tabler-cube, cube, tabler-box}` 的 `text` 就是模型名。
- Arena 有官方 OpenAI 兼容 API(`https://api.preview.arena.ai/v1`,key 在 `portal.api.preview.arena.ai`),但 arena.ai 主站**无用户 API**;本项目针对主站。
- 每日免费额度模型(CreditGauge,`dailyFreeCredits`/`creditsRemaining`)。

---

## 5. 真机验证方法(用户要求)

- **桌面**:`cargo tauri dev`,用户在自己的浏览器登录态里操作;助手采集截图/日志核对,**不代替用户点击**准备/出牌/支付/授权。区分已验证事实/推断/未知。
- **Android**:CI 出 debug apk(GitHub Actions 跑单测 + 构建),真机安装验证。产物在 **Releases**(每次构建一个 `build-<run>` 预发布,附件就是 `.dmg` / `.apk` 原文件;Actions 的 Artifacts 下载永远是 zip,所以只用作 job 间中转,1 天过期)。
- 排障沿真实会话/请求转储/服务日志对齐;取证先落地(把错误体、状态码写进可见日志)再改;禁"听起来合理"的推测修复。

---

## 6. 已知坑与规避

- **代理/fake-ip**:mihomo 把 `*.arena.ai` 映射到 198.18.0.0/15;`api.trigger.dev` 与 `api.preview.arena.ai` 子域可能路由到死 egress。原生 reqwest 需允许直连或走正确 egress。curl 直连能通则是代理规则问题,不是站点问题。
- **TipTap/ProseMirror 编辑器**:自动填 prompt 时 `Input.insertText` 和 keyDown+char 都失败/重复,只有逐字符 `char` 事件可行(桌面 CDP);`injected/probe.js` 的 `fillPrompt` 沿用安卓版已验证的页面内方案(选中内容后 `execCommand('insertText')`,失败则 textContent + input 事件兜底,写后回读校验),先在真机验证。
- **Shadow DOM 关闭**:读状态用可访问性树/DOM 查询要注意,arena 部分组件 shadow 关闭。
- **WebView 上下文失效**:Android WebView 被系统回收/重建后注入脚本会失联,需在 `onPageFinished`/Tauri page-load 事件里重新注入,并让 HUD 检测失联后提示刷新而非空转。
- **Model-Unlocker 依赖 Next.js 内部结构**(`__next_f`、`disable-opus` 字段);arena 改版会失效,失效时 fetch 钩子静默透传(安全不破坏),需版本探测告警。

---

## 7. IPC 契约(页面 ↔ Rust ↔ dock)

Tauri 命令(`src-tauri/src/lib.rs`,由 `build.rs` 的 `AppManifest::commands` 生成 `permissions/autogenerated/allow-<cmd>.toml`,再在 `capabilities/` 中按 webview 授权):

| 命令 | 谁能调 | 作用 |
|---|---|---|
| `on_token {sessionId, token}` | arena 页面 | snoop 截到令牌 → 校验 → 启动 trace 轮询 |
| `page_event {name, payload}` | arena 页面 | 页面事件中继到 dock(`arenakit://page`) |
| `store_get/set/keys` | 两者 | JSON 持久化 store |
| `proxy_get {url}` | 两者 | 白名单原生 GET(Logo/价格/Gist) |
| `arena_command {js}` | **仅 dock** | 在 arena 页面 eval(远程页面永远拿不到此权限) |

capabilities:`capabilities/arena.json`(`remote.urls: https://arena.ai/*`,只给页面必需的 6 个命令)与 `capabilities/default.json`(dock,含 `arena_command`)。远程页面要用 IPC 必须有 `remote` capability,且启用了 app manifest 后所有自定义命令都走 ACL。

Rust → dock 事件:

```
'arenakit://trace'  {stage:'token'|'poll'|'model'|'error'|'done', sessionId, runId, attempt, max,
                     models:[{model, provider, partial}], spans:[SpanUsage], complete, status, fatal, checkedAt(ms)}
'arenakit://page'   {name, payload}   // 页面事件中继
```

页面事件(`__ARENAKIT__.send(name, payload)` → `page_event` → dock `onPage(name)`):

| name | 发出者 | payload |
|---|---|---|
| `nav` | bridge.js | `{path, sessionId, agentPath, title, url, reason}`(SPA 导航) |
| `probe-result` | probe.js | `{reqId, ok, data}` / `{reqId, ok:false, error}` |
| `reply-monitor` | monitor.js | `{sessionId, ended:'done'|'abort'|'stalled'|'http', frames, bytes, textChars, errorFrames, lastError, durationMs, idleMs, generating, at}` |
| `pulse` | pulse.js | `{ok:true, percent, refreshedAt, at}` / `{ok:false, error, retryAfterMs, at}` |

dock → 页面:`arena_command` eval;约定入口 `window.__ARENAKIT__.dispatch(name, payload)`(如 `pulse-refresh`)、`window.ArenaProbe.call(action, argsJson, reqId)`(探针 RPC)、`__AK_*_SET__`(增强脚本开关)。

探针 RPC 动作(probe.js):`precheck` `newChat` `ensureAgentMode` `send{prompt}`(仅算式、仅新对话、不覆盖草稿)`sendToCurrent{text}`(当前对话,生成中拒绝)`sidebarList{expand}` `collapseSidebar` `openConversation` `revealSidebarItem{sessionId}` `rename{sessionId,title}` `archive{sessionId,requireCurrentUrl,manageSidebar}`。

## 8. 测试与本地检查

```bash
node --test 'tests/**/*.test.mjs'   # 纯逻辑库直接 import;注入脚本用 node:vm + fakePage 跑
node scripts/check-syntax.mjs       # 注入脚本按 script、dock 按 module 做语法检查
cargo test --manifest-path src-tauri/Cargo.toml   # trace/usage/store/pulse 单测 + init 包隔离测试
```

```bash
node scripts/bundle-dock.mjs          # 重新生成安卓内嵌 dock 包(src/embed/*.gen.js);--check 只校验
```

CI(`.github/workflows/build.yml`):`node-test`(含 bundler `--check`)→ `rust-test` → `macos-dmg` / `android-apk` → `release`(把 `.dmg` / `.apk` 原文件作为 `build-<run>` 预发布的附件发布,需 `permissions: contents: write`);`main` 与 `arena/**` 分支推送即触发,也可 `gh workflow run build.yml --ref <branch>` 手动触发。
