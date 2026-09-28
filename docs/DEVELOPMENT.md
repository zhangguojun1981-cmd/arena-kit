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
| 服务端模型 + **轮次对话解析模型** | 服务端模型 | `src/lib/turns.js`(TurnTracker,按 tokenKey 计轮,可带强度档位) | snoop.js v2 → bridge 路由 → Rust trace | android `TurnTracker.kt` / `TurnIntake.kt`(页面 id → 流 id 别名 `conversationFor`,`/c/{evalId}` 页也能对上轮次与模型) |
| **使用额度(Token / 费用,非百分比)**;覆盖率 / 查看运行 / 证据来源 | 使用额度 | `src/lib/usage.js` + `src/lib/usage-view.js` + `src-tauri/src/usage.rs` | — | inspector `core.js` span 用量标签、`view-model.js` / `popup.js` 运行视图 |
| **会话历史**(搜索/分页/打开/查看运行/删除/导出/清空,累计不因淘汰丢失;**归档当前对话并删除记录**) | 会话历史 | `src/lib/history.js`、`dock.js archiveCurrent` | `conversation-rename.js` archive | inspector `history.js` / `hud.js` 归档聊天及删除记录、android `HistoryLogic.kt` |
| **重命名对话(可加前缀)** | 重命名对话 | `src/lib/rename.js`、`src/lib/rpc.js` | `injected/conversation-rename.js`、`injected/probe.js` | android `conversation-rename.js` / `probe.js` |
| **自动探针(抽卡)** + **自动抽卡**(`mode:'draw'`:无目标,每轮命名为模型名,不消耗序号) | 自动探针 | `src/lib/probe-logic.js`、`src/lib/probe-runner.js` | `injected/probe.js` | android `ProbeLogic.kt` / `ProbeController.kt`、inspector `auto-draw.js` |
| **自动清理**(归档算式标题残留,`onArchived` 钩子同步删本地记录) | 自动清理 | `probe-runner.cleanup` | `probe.js` sidebarList/revealSidebarItem/archive | android `ProbeController.cleanup`、inspector 归档后删记录 |
| **会话探针**(向当前对话发探针,识别本轮模型) | 会话探针 | `src/lib/session-probe.js` | `probe.js` sendToCurrent | android `quickSend` + TurnTracker |
| **回复监控**(空回复/报错/中断/停滞 自动标记轮次) | 回复监控 | `src/lib/monitor.js` | `injected/monitor.js`(snoop 帧钩子) | ArenaKit 新增(用户需求) |
| **回复出错或空白时自动刷新**(页面出现「Something went wrong…please try again / 出现了一些问题…请重试」错误卡,或已发送、流已结束但页面没有任何新输出 → 自动刷新;只在最近 2 分钟有对话活动时评估;同一问题两次观察(≥2 s)才动手,最多自动刷新 2 次(同路径间隔 ≥30 s),再异常只在活动行提醒;链接页 / 加载中 / 探针·清理·会话探针开始 2 分钟内不刷新) | 工具 → 回复监控 开关(`prefs.autoRefresh`,默认开) | `src/lib/watchdog.js`(纯策略,`decide`/`applied`,单测对齐参考 `ReplyWatchdogTest`)+ `dock.js onPage('watch')` → `requestReload('watchdog')` + 悬浮球任务 `recovery` | `injected/watchdog.js`(600 ms 轮询 DOM,仅上报 `{k,path,generating,len,at,act}`;`__ARENAKIT_FLAGS__.autoRefresh===false` 时不扫描) | android `assets/watchdog.js` v3 + `web/ReplyWatchdog.kt` |
| **安卓状态胶囊 + 底部面板**(参考 v0.6.4:扁平胶囊 36 dp = 额度环(% 在环内,忙碌时 80° 弧旋转)+ 13 sp 标签(模型 / 新对话 / 探针·清理进度 / 闪现「已发送 ✓」)+ 可选 ⟳ 区;单击 → 面板(触点抖动 ≤12 px 仍算单击;WebView 没送到指针事件时按随后的 click 兜底,700 ms 内去重),⟳ 区单击 → 刷新,长按 500 ms → 快捷菜单(开始 / 停止探针、会话探针、清理算式标题、刷新页面、切换账号、打开面板;触摸长按后安卓补发的 contextmenu 只拦截不再切换菜单),拖动后 180 ms 贴最近一侧(位置以「边 + 高度比例」记忆,默认右侧 18%);面板为贴底 Bottom Sheet(抓手横条 + 右上 ✕、最大 560 宽 / 85% 高、遮罩、下滑 / 遮罩 / 返回键关闭,表头无刷新按钮)) | 内嵌壳 | `src/embed/shell.js`(mount / setPill / setLoading / confirm / handleBack / pull-up)+ `src/lib/pill-layout.js`(`clampPos` / `ringPalette` / `pillPlacement` / `snapSide` / `pillLabel` / `turnHeadline` 单测)+ `dock.js renderPill / flashPill / setTask` | — | android `StatusPillView.kt` / `FloatingDragHelper.kt` / `ControlPanel.kt` / `panel_sheet.xml` |
| **刷新**(胶囊 ⟳、快捷菜单「刷新页面」、工具页「刷新」、对话滚到底后按住上拉、桌面 ⌘R / F5;面板表头没有刷新按钮)→ `requestReload(source)`:800 ms 去抖,探针 / 清理进行中先弹「刷新页面?/ 停止并刷新」;刷新时胶囊 ⟳ 旋转、顶部 2 dp 进度条(`page-actions reload` 先在 sessionStorage 打 `arenakit.reloading` 戳,新文档的 `bridge.js bootProgress()` 从 document_start 起就画进度条,DOMContentLoaded 70%、load 完成);开关「悬浮窗显示刷新按钮」(`prefs.pillRefresh`) | 内嵌壳 / 工具 | `dock.js requestReload / confirmDialog` + `shell.js setLoading / pull-to-refresh` | `lib/page-actions.js reload`、`injected/bridge.js bootProgress` | android `MainActivity.requestReload` / `ControlPanel.showPageProgress` |
| **页面链接标签**(点到其他站点的链接、`target=_blank`、`window.open` → 应用内「链接页」,不替换对话;Arena 自身、登录 / 验证域名、重定向留在原地;`mailto:` / `tel:` / `intent:` 交给其他应用;`file:` / `content:` / `javascript:` 拦截。安卓:原生 WebView 图层(52 dp 表头 ✕ · 标题 / 域名 · ⟳ · ⋮ 在浏览器中打开 / 复制链接 / 分享链接,2 dp 进度条,滑入 200 / 滑出 160 ms,与 Arena 共享 Cookie,返回键先走标签页历史再关闭);桌面:独立窗口) | 内嵌壳 / 原生 | `src-tauri/src/links.rs`(`route_main` 纯函数 + 单测,`on_navigation` 兜底;`open_tab` 命令)| `injected/links.js`(捕获阶段拦点击 + 覆写 `window.open`,`routeMain` 单测)→ 安卓 `ArenaKitAndroid.postMessage` / 桌面 `open_tab` | android `LinkPolicy.kt` / `LinkTab.kt` / `ExternalLinks.kt`;覆盖层 `src-tauri/android/.../LinkTab.kt` + `MainActivity.onWebViewCreate` |
| **顶部 HUD**(模型绿色 / 路由橙黄、`第 N 轮 · 已截获令牌…` → `第 N 轮 · 模型` / `已切换模型 → m`、额度倒计时、后退/前进/刷新) | 顶部 | `dock.js setModelDisplay / setHudStatus` | `lib/page-actions.js navBack/navForward/reload` | android `hudModel` / `hudStatus` / `hudPulse` / nav 按钮 |
| **设置**(主题 / 悬浮球显示(仅安卓)/ 截获会话流 / 额度轮询 / 回复监控 / 悬浮窗显示刷新按钮 / 自动刷新) | 更多 → 设置、工具 | `dock.js wireTheme / wireSettings` | `page-actions flagSet` → `window.__ARENAKIT_FLAGS__` | android DayNight、inspector 监听开关 |

### M6 — 安卓壳修正 ✅ 代码就位(待真机)
- 状态栏:`src-tauri/android/.../MainActivity.kt`(CI 覆盖到 gen/android)保留 `enableEdgeToEdge()` 但给 `android.R.id.content` 按 systemBars ∪ displayCutout ∪ ime 加 padding → 页面顶部 = 状态栏底部,键盘弹出页面收缩;状态栏底色 / 图标深浅跟随系统。
- 图标:`scripts/make-icons.py` 渲染桌面图标集并生成安卓 API 26+ 自适应图标的矢量(`mipmap-anydpi-v26` + `drawable/ak_launcher_*`,均由脚本产出,勿手改);图形为「AK」字标(白色单字形:A 的右腿即 K 的竖干,品牌蓝渐变底)。
- 验收(真机):首屏顶部不被状态栏压住;桌面图标为蓝底白「AK」字标;状态胶囊显示额度环与百分比,右侧有 ⟳ 区;发一条消息后胶囊标签与面板表头出现模型名,再换模型时变橙黄且轮次行带「已切换」;单击胶囊(含轻微抖动)必须弹出面板,点 ⟳ 刷新,长按弹快捷菜单且不会立刻自动关闭。

- 验收:探针能跑完设定轮数、命中即停/命中全部才停、命中改名「前缀+模型-序号」;清理只归档算式标题且不碰当前对话;会话探针在当前对话内识别本轮模型;回复流异常在轮次列表出现徽标,正常显示「无异常信号」。**待真机确认。**

### M6 — Android 出包 ✅ CI 就位
- 安卓内嵌 UI(`src/embed/shell.js` + `src/dock.html/css/js`)按参考安卓应用 **v0.6.4**(分支 arena/01a0d5e4)还原,Material 3 扁平配色(亮:brand #2F6BFF / surface #FFFFFF / muted #5F6673 / ok #1E8E3E / warn #B26A00 / danger #D93025;暗:#9DB8FF / #16181D / #9BA2AF / #6DD58C / #FFB951 / #FF8A80):
  - 状态胶囊:36 dp 扁平胶囊,左侧 26 dp 额度环(描边 2.5,百分比 9.5 sp 粗体在环内,未知显示 –;≥20% 蓝 / 10–19% 琥珀 / <10% 红;探针 / 清理进行中为 80° 弧 1100 ms 旋转),中间 13 sp 标签(最大 180 dp:模型名;本轮与首轮不同 → 橙黄「已切换」色;`/agent` 无会话 →「新对话」;任务进行中 → `探针 2/5 · 命中 1` / `清理 · 已归档 3`;闪现 `已发送 ✓` 2.5 s、`探针结束 · 命中 n` / `清理完成 · 已归档 n` 4 s;回复异常 → 红色描边闪烁),右侧可选 ⟳ 区(带分隔线,开关「悬浮窗显示刷新按钮」)。手势:单击 → 打开面板(`TAP_SLOP` 12 px 内的抖动仍算单击;指针事件缺席时由 click 兜底,`TAP_MAX_MS` 700 ms 内去重);⟳ 区单击 → 刷新;长按 500 ms → 快捷菜单(开始 / 停止探针、会话探针、清理算式标题、刷新页面、切换账号、打开面板);触摸长按后的 contextmenu 只拦截,鼠标右键才切换菜单;拖动 → 松手后 180 ms 贴最近一侧,位置以 `{side, y(0–1)}` 存 localStorage `arenakit.pill.pos`,默认右侧 18%;面板 / 链接页打开时隐藏。
  - 面板:贴屏幕底部的 Bottom Sheet(顶部 20 dp 圆角、抓手横条 32×4 + 右上 ✕、最大 560 宽 / 85% 高、遮罩 #52000000 / #80000000);表头 = 模型 18 sp(未知「模型待确认」灰、已切换橙黄)+ 状态行(`共 5 轮 · 首轮 m · 当前已切换 · 本地记录` / `新对话 · 等待会话流…` / `打开一个 Arena 对话后自动识别模型`)| 右侧额度 18 sp + `h:mm:ss 后重置` / `额度读取中…` + tonal ⟳;4 dp 额度条;活动行(最新一条日志,点开 40 行等宽日志);分段页签 **对话 / 探针 / 工具 / 更多**(记忆 `prefs.panelTab`):对话 = 轮次行(等宽 `R3`、模型、「已切换」标签、✓ / 转圈 / ⚠,新的在上,空态「暂无轮次记录…」);探针 = 目标 + 最多轮数 −/+ 步进 + 「命中全部目标才停止」「命中后自动重命名会话」开关 + 前缀(预览 `<prefix>model-001`)+ 填充色「开始 / 停止探针」+「会发送真实消息并消耗额度」+ tonal「会话探针」(确认);工具 = 清理算式标题 / 重命名 / 页面 ◀ ▶ 刷新 / 「回复出错或空白时自动刷新」/ 会话历史;更多 = 功能模块 / 提示词注入 / 设置。关闭:下滑拖柄或表头、点遮罩、返回键(`__ARENAKIT_EMBED__.handleBack()`:对话框 → 菜单 → 面板)。
  - 桌面浏览器可开 `src/embed/preview.html` 预览(Tauri 假桩 + 灌事件按钮:额度 / 令牌 / 模型 / 切换 / 异常 / 新对话 / 探针进行中 / 闪现)。桌面 dock(独立 webview)用同一份 dock.html:胶囊相关行由 `.ak-embed-only` 隐藏,表头 sticky。
- 图标:`python3 scripts/make-icons.py` 用纯 Python 从矢量数据渲染 `src-tauri/icons/`(icon.png 1024 / 128@2x / 128 / 32 / icon.icns / icon.svg)并写出安卓 `drawable/ak_launcher_foreground.xml` / `ak_launcher_background.xml`;图形是「AK」字标:白色单字形(A 的右腿与 K 的竖干共用,几何笔画,粗 11 / 高 52),品牌蓝 #3B78FF→#2456E6 对角渐变底;`--print-svg-path` 输出同一路径供 `src/dock.html` 表头 logo 使用(测试会核对二者一致)。安卓 API 26+ 用 `mipmap-anydpi-v26` 的自适应图标,旧设备回退到 `tauri icon` 生成的 PNG。
- `src-tauri/android/` 是覆盖到生成项目 `gen/android/` 上的安卓源码(CI 在 `android init` 之后 `cp -R` 过去):`MainActivity.kt` 保留 edge-to-edge 但按系统栏 / 刘海 / 输入法 insets 给内容加 padding,网页顶部正好与状态栏底部平齐、底部在导航栏之上、键盘弹出时页面收缩(参考项目 targetSdk 34 的原生表现;Tauri 模板 targetSdk 37,Android 15+ 强制 edge-to-edge 不可关闭)。状态栏 / 导航栏底色跟随系统深浅色。
- 覆盖层还承载 **页面链接标签**:`MainActivity.onWebViewCreate(webView)`(Wry 在把页面 WebView 设为 content view 之后、首次加载之前调用)里 (1) 装 `ArenaKitAndroid` 页面桥 —— `WebViewCompat.addWebMessageListener`(仅 arena.ai 来源;旧 WebView 回退 `addJavascriptInterface`),`injected/links.js` 以 `postMessage(JSON)` 发 `{cmd:'openTab'|'closeTab'|'external', url}`;(2) `LinkTab.kt`(参考 `LinkTab.kt` + `ExternalLinks.kt` 的移植,纯代码布局,`activity.addContentView` 叠在 Wry WebView 之上、仍在加过 insets padding 的 content 框内);(3) 在 Wry 自己的 `OnBackPressedCallback` 之后再注册一个(LIFO → 先执行):链接页历史 / 关闭 → `__ARENAKIT_EMBED__.handleBack()`(evaluateJavascript,不受页面 CSP 限制)→ 页面 `goBack()` → 交回系统。链接页开关状态经 `__ARENAKIT_LINKS__.setOpen()` 回写页面,dock 收 `link-tab` 事件(看门狗在链接页打开时不刷新)。Rust 侧 `links.rs` 的 `on_navigation` 是导航级兜底(未经点击的跳转:`NewTab` → 安卓 eval `__ARENAKIT_LINKS__.open(url)` / 桌面新开窗口;`ExternalApp` → 安卓 `__ARENAKIT_LINKS__.external(url)` / 桌面 `open` / `xdg-open` / `rundll32`;`Block` → 丢弃)。
- `cargo tauri android build --apk --target aarch64` 出 release arm64 apk(优化 + strip,debug 包带符号约 190 MB),CI 再用 `zipalign` + `apksigner` 以仓库内固定的调试密钥 `.github/android/debug.keystore`(PKCS12,别名 `arenakitdebug`,密码 `android`)签名——每次构建签名一致,可覆盖安装。这不是商店密钥;正式发布时换成 secrets 里的密钥。
- **dock 内嵌模式(仅 Android)**:mobile Tauri 一窗一 webview(`Window::add_child` 仅桌面),所以安卓不建第二个 webview,而是 `node scripts/bundle-dock.mjs` 把 `src/dock.js` + `src/lib/*` + `src/embed/shell.js` 打成一个经典脚本 `src/embed/dock-embedded.gen.js`(已提交,CI `--check` 防过期),Rust `include_str!` 并追加到 init 脚本末尾;页面加载后挂载状态胶囊 + 底部面板(shadow DOM,样式互不干扰)。改了 `src/` 记得重新跑 bundler(测试 `embed-bundle.test.mjs` 会提示)。
- **macOS 仅分栏**:桌面唯一布局是分栏——`lib.rs` 启动时 `desktop_layout()` 直接返回 `Dock`,起一个 `Window "main"`(1360×900)装两个子 webview:左 `arena`(`https://arena.ai`,init 脚本只含 bridge/snoop/... 等注入,平台标记 `__ARENAKIT_PLATFORM__="desktop"`),右 `dock`(`dock.html`,与安卓同一份前端,通过 WebviewUrl::App 加载)。`prefs.desktopLayout` 已废弃——历史值被忽略,旧 dock 不会读取它。`shell.js` 桌面补齐:window 捕获阶段 `keydown`:Esc → `handleBack()`、⌘/Ctrl+R / F5 → `fire('refresh')`(dock `requestReload`)、⌘[ / ⌘] → `history.back/forward`(编辑框内不拦截);`@media (hover: hover)` 悬停样式。桌面 `capabilities/arena.json` 需 `core:event:allow-listen/unlisten`(内嵌 dock 订阅 `arenakit://trace` / `arenakit://page`)。
- **桌面菜单栏「页面」**(`src-tauri/src/menu.rs`,`Menu::default` + 追加子菜单,保留 Edit 复制粘贴 / Window ⌘W 关窗):刷新 ⌘R、后退 ⌘[、前进 ⌘]、在浏览器中打开 ⌘⇧O、复制链接 ⌘⇧C —— 安卓链接页工具栏(⟳ / 在浏览器中打开 / 复制 / ✕)的桌面对应。分发:焦点在 `tab-*` 链接窗口 → 直接 `eval` / `url()` 处理;否则针对 arena 页面:刷新 / 前进 / 后退经 `arenakit://page` 事件 `menu` 交给 dock(与胶囊 ⟳ 同一条 `requestReload` 路径:防抖、忙碌确认、进度条),在浏览器中打开 / 复制链接用 `get_webview("arena").url()` 原生完成(macOS `pbcopy`,文本走 stdin 不经 shell)。macOS 上菜单快捷键先于网页 keydown,所以 ⌘R 由菜单处理;shell.js 里的 ⌘R / F5 是 Windows / Linux 与无菜单场景的兜底。
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
| `injected/bridge.js` | ArenaKit 新增 + android `SessionRouting.kt` / `TurnIntake.onActivity` | JS | 页面侧 `window.__ARENAKIT__`:`onToken`/`onActivity`/`send`(页面事件→dock)/`on`+`dispatch`(dock→页面)/`storeGet|Set`/`proxyGet`/SPA 导航 `nav` 事件。**必须第一个注入**。对话页正则 `^/(?:agent|c)/{id}`(`/c/{evalId}` 与流 session 可不同)。**令牌路由**:对话页接受所有流;`/agent` 新对话页只认第一条没见过的流(之后只认它,离开再进重新认);其他页丢弃 —— 防止旧对话的迟到流把轮次日志切回旧聊天。**活动刷新**:snoop 的活动 ping(同一 run 多条回复)在 45 s 冷却后用页面里仍持有的上一枚令牌重新 `on_token`(Rust 在上次轮询未结束时会去重),令牌临期不刷 |
| `injected/snoop.js` | android `snoop.js` v2(即 inspector `snoop.js`) | JS→JS | 同时挂 **fetch(tee)/EventSource/XMLHttpRequest 渐进读/WebSocket(wss)** 四种传输 + 原始 JWT 形状兜底(非 SSE 的纯 JSON 体也能找到令牌);每个 (page, session, token) 只上报一次(page = 截获时的 `location.pathname`,随事件一起交给 bridge 路由);每会话 ≤ 1/15 s 的无内容活动 ping。`postMessage` 目标改为 `__ARENAKIT__.onToken`。**sessionFromUrl 正则必须与 trace.rs 的 streamSession 保持 lockstep**。ArenaKit 加了页面内帧钩子 `__ARENAKIT_MONITOR__`(会话文本不出页面) |
| `injected/monitor.js` | ArenaKit 新增 | JS | 把 SSE 帧归约为帧数/字节/文本长度/错误帧/结束方式/空闲时长,只上报摘要(`reply-monitor` 事件);停止按钮仍在且 2 分钟无帧 → 停滞 |
| `injected/links.js` | android `LinkPolicy.kt`(规则)+ `MainActivity.routeNavigation` / `onCreateWindow`(时机) | Kotlin→JS | 捕获阶段拦 `<a>` 点击(⌘/ctrl/中键 = 新窗口)、覆写 `window.open`;`routeMain(url,{gesture,redirect,linkClick,newWindow})` → `'in-place'|'tab'|'external'|'block'`;登录弹窗(`isAuthFlow`)保留 opener 不拦;安卓走 `ArenaKitAndroid.postMessage`,桌面走 `open_tab`,无运行时时退化为真正的新标签页 |
| `injected/watchdog.js` | android `assets/watchdog.js`(v3) | JS→JS | 对话看门狗:错误卡正则 + 「发送后零增长」空回复判定,活动/发送时间戳存 sessionStorage(刷新后仍有参照);`ArenaProbeBridge.onLog('WATCH|…')` 改为 `__ARENAKIT__.send('watch', …)`,`PATH|` 推送省略(bridge.js `nav` 已覆盖) |
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
| `src/dock.*` | inspector `hud.js` `panel.js` + android `ControlPanel.kt` / `panel_sheet.xml`(v0.6.4) | JS→JS | 原生 dock(桌面独立 webview / 安卓内嵌 Bottom Sheet)。表头按参考面板:模型(未知灰「模型待确认」;本轮与首轮不同时橙黄)+ 状态行 + 剩余额度 / 重置倒计时 + 4 dp 额度条 + ⟳;活动行 + 可展开日志;页签 对话 / 探针 / 工具 / 更多:轮次、探针(含会话探针)、清理 / 重命名 / 页面导航 / 刷新开关 / 自动刷新开关 / 会话历史、功能模块 / 提示词注入 / 设置(主题:跟随系统/亮色/暗色,`prefs.theme`,CSS 变量 + `[data-theme]`;开关:截获会话流 / 额度轮询 / 回复监控 / 自动刷新 —— 通过页面动作 `flagSet` 写入 `window.__ARENAKIT_FLAGS__`,`injected/snoop.js` `pulse.js` `monitor.js` `watchdog.js` 读取,每次页面加载(`nav` reason=init)重新下发) |
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
- 侧栏对话列表懒加载,等 `a[href^="/agent/"]` / `a[href^="/c/"]` 出现再判"无可清理"。
- 探针命中标题 `<前缀><模型>-NNN`:序号按 **前缀+模型** 独立计数(`rename.js nextSuffix(model, counters, prefix)`,键 `p:<前缀>|<模型>`;无前缀沿用旧的按模型键),最多保留 300 个名字。
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
- **账号功能真机清单**(沙箱只能用假 DOM / 假 Cookie 罐验证,见 `tests/account-flow.test.mjs`):① 登录后打开「账号」页应自动出现当前账号(邮箱 / 头像 / `Cookie 作用域`);若显示「检测到登录 Cookie,但无法解析」= Cookie 名或编码变了,先看 `document.cookie` 里 `arena-auth-*` 的样子。② 「添加另一个账号」→ 页面应回到未登录 → 登第二个 → 列表两项。③ 点「切换」→ 页面应跳到站点首页并是目标账号,提示「已切换到 …」;若提示「登录状态已失效(页面回到了游客状态)」= 服务端拒绝了换回去的刷新令牌(令牌轮换族被吊销),需要缩短快照间隔或改走登录助手;账号列表里不应出现只有一串 id、没有邮箱的「游客」条目(出现 = 站点匿名会话的识别方式变了,看 JWT 里的 `is_anonymous`)。④ 填好邮箱 / 密码 / 2FA 后点「保存并登录」:看「登录助手」状态行的阶段;Google 页若出现 `disallowed_useragent` = UA 处理失效;若卡在某一步 = 选择器不匹配,把当时的输入框 / 按钮 outerHTML 记下来(现用选择器:`#identifierId` / `input[name=Passwd]` / `#totpPin`,「下一步」= `#identifierNext` / `#passwordNext` / `#totpNext` 包裹 div 里的内层 `<button>`,找不到再按按钮文字 Next / 下一步 / 继续 匹配;沙箱里只能通过 fetch 看到 Google 登录页的文案(Sign in / Email or phone / Next),元素 id 来自公开的自动化脚本,尚未在真机上核对)。⑤ 邮箱验证码流程应弹到账号页要验证码,输入后代填。

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
| `open_tab {url}` | arena 页面(`injected/links.js`) | 桌面:为 http(s) 链接开一个独立窗口(无注入脚本、无 IPC);安卓:返回 false(页面直接走 `ArenaKitAndroid` 原生链接页) |
| `login_set {creds}` | dock(内嵌时即 arena 页面) | 登录助手:把 `{accountId, email, password, totp, provider, startedAt}` 存进 Rust 内存(10 min TTL);之后每次 `on_page_load`(arena 域 + `links.rs` 认定的登录域)eval `window.__AK_LOGIN_APPLY__(creds)` |
| `login_clear` | 两者 | 忘掉待登录凭据(account.js 在会话 Cookie 出现时调用;dock 在切换成功 / 停止时调用) |

capabilities:`capabilities/arena.json`(`remote.urls: https://arena.ai/*`,只给页面必需的 7 个命令)与 `capabilities/default.json`(dock,含 `arena_command`)。远程页面要用 IPC 必须有 `remote` capability,且启用了 app manifest 后所有自定义命令都走 ACL。

Rust → dock 事件:

```
'arenakit://trace'  {stage:'token'|'poll'|'model'|'error'|'done', sessionId, runId, tokenKey, attempt, max,
                     models:[{model, provider, partial}], strength, spans:[SpanUsage], complete, status, fatal, checkedAt(ms)}
                    // tokenKey = 令牌的不可逆哈希:dock 的轮次按它而不是 runId 计(arena 可能整段对话复用同一 run scope,
                    // 按 runId 会把所有轮并成第 1 轮);strength = 可选强度/努力档位("high"/"max"…,trace.rs extract_effort)
'arenakit://page'   {name, payload}   // 页面事件中继
```

页面事件(`__ARENAKIT__.send(name, payload)` → `page_event` → dock `onPage(name)`):

| name | 发出者 | payload |
|---|---|---|
| `nav` | bridge.js | `{path, sessionId, agentPath, title, url, reason}`(SPA 导航) |
| `probe-result` | probe.js | `{reqId, ok, data}` / `{reqId, ok:false, error}` |
| `reply-monitor` | monitor.js | `{sessionId, ended:'done'|'abort'|'stalled'|'http', frames, bytes, textChars, errorFrames, lastError, durationMs, idleMs, generating, at}` |
| `watch` | watchdog.js | `{k:'empty'|'error:<≤40 字>', path, generating, len, at, act}`(仅 `/agent*` `/c/*`;dock 侧再截到 24 字) |
| `link-tab` | links.js(原生 LinkTab 经 `setOpen` 回写) | `{open}` |
| `menu` | Rust `menu.rs`(桌面菜单栏「页面」,非页面发出) | `{action: 'reload' \| 'back' \| 'forward'}` → dock `requestReload('menu')` / `navBack` / `navForward` |
| `pulse` | pulse.js | `{ok:true, percent, refreshedAt, at}` / `{ok:false, error, retryAfterMs, at}` |
| `account` | account.js(监视器,仅 arena 域) | `{reason:'init'|'poll'|'wake', loggedIn(非匿名且有邮箱), anonymous(站点游客态), hasAuthCookie, scope:'host'|'domain'|'', userId, email, name, avatar, provider, expiresAt, cookies:[{name,value}], sig, at}`(仅 auth Cookie 签名变化时发) |
| `account-result` | account.js | `{reqId, ok, data}` / `{reqId, ok:false, error}`(账号 RPC 应答) |
| `login` | account.js(登录助手进度) | `{stage:'arena-open'|'arena-google'|'arena-email'|'need-code'|'google-*'|'done'|'stopped'|'timeout'|…, host, accountId, at, error?}`;`need-code` 时 dock 打开账号页让用户输入邮件验证码 |

dock → 页面:`arena_command` eval;约定入口 `window.__ARENAKIT__.dispatch(name, payload)`(如 `pulse-refresh`)、`window.ArenaProbe.call(action, argsJson, reqId)`(探针 RPC)、`__AK_*_SET__`(增强脚本开关)。

探针 RPC 动作(probe.js):`precheck` `newChat` `ensureAgentMode` `send{prompt}`(仅算式、仅新对话、不覆盖草稿)`sendToCurrent{text}`(当前对话,生成中拒绝)`sidebarList{expand}` `collapseSidebar` `openConversation` `revealSidebarItem{sessionId}` `rename{sessionId,title}` `archive{sessionId,requireCurrentUrl,manageSidebar}`。

账号 RPC 动作(account.js,`window.ArenaAccount.call(action, argsJson, reqId)` → `account-result`,dock 经 `lib/page-actions.js` 的 `accountCall`):`snapshot`(含作用域探测)`restore{cookies, scope, expectSig?, navigate?}`(`expectSig` 与当前 Cookie 签名不符 → 原样返回 `{stale:true, previous}` 不动 Cookie;否则先删旧 auth 块及兄弟块,再按 host / Domain 作用域写入,核对无残留;应答里带 `previous`(换出去的会话),`navigate:'/path'|true` 时应答发出后立刻 `location.replace` 到本站该路径并打 `arenakit.reloading` 戳)`clear{navigate?}`(删所有 auth Cookie 含游客态,不调 signOut)`login{creds}`(启动页面侧登录助手)`fill{code|password}`(把用户输入的验证码填进页面)`stop` `status`。dock 侧状态存 store 键 `accounts`:`{list:[{id,userId,email,name,avatar,provider,label,cookies,sig,expiresAt,capturedAt,lastUsedAt,login:{email,password,totp,auto}}], activeId, pending:{type:'switch'|'add'|'login', id, at}|null}`(`src/lib/accounts.js` 归一化;`pending` 5 min 过期)。

## 8. 测试与本地检查

```bash
node --test 'tests/**/*.test.mjs'   # 纯逻辑库直接 import;注入脚本用 node:vm + fakePage 跑
                                    # 账号:tests/account.test.mjs(account.js 单元)+ tests/account-flow.test.mjs
                                    # (真实 account.js + rpc + account-flow 走完整切换 / 添加 / 登录助手旅程,
                                    #  Cookie 罐懂 Domain / Max-Age;夹具 tests/account-fixture.mjs)+ totp / accounts
node scripts/check-syntax.mjs       # 注入脚本按 script、dock 按 module 做语法检查
cargo test --manifest-path src-tauri/Cargo.toml   # trace/usage/store/pulse 单测 + init 包隔离测试
```

```bash
node scripts/bundle-dock.mjs          # 重新生成安卓内嵌 dock 包(src/embed/*.gen.js);--check 只校验
```

CI(`.github/workflows/build.yml`):`node-test`(含 bundler `--check`)→ `rust-test` → `macos-dmg`(矩阵:`aarch64-apple-darwin` + `x86_64-apple-darwin`,同一台 arm64 runner 交叉编译 Intel 包,产物 `*_aarch64.dmg` / `*_x64.dmg`)/ `android-apk` → `release`(把 `.dmg` / `.apk` 原文件作为 `build-<run>` 预发布的附件发布,只保留最新一个 `build-*`,需 `permissions: contents: write`);`main` 与 `arena/**` 分支推送即触发,也可 `gh workflow run build.yml --ref <branch>` 手动触发。
