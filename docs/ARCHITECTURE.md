# ArenaKit 架构

## 一句话

一个 Tauri 2 应用:一个原生窗口里并排两个 webview —— 左边是 `https://arena.ai`(用户真实登录态,注入 MAIN world 增强/取证脚本),右边是 **dock**(打包的本地页面,持久不刷新,承载全部原生 UI 与编排逻辑)。Rust 只做薄中继:trace 轮询、JSON store、页面事件转发、dock→页面 eval。macOS 与 Android 共用同一套 Rust + JS,仅 WebView 宿主不同。

## 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│  平台宿主 (Tauri Runtime)  macOS → WKWebView   Android → System WebView │
├───────────────────────────────────┬──────────────────────────────────┤
│  webview "arena": https://arena.ai │  webview "dock": src/dock.html    │
│   [document_start, MAIN world]     │   服务端模型 + 轮次(turns.js)     │
│    bridge.js  __ARENAKIT__ 桥      │   回复监控(monitor.js)            │
│    gm-shim.js GM_* 垫片            │   使用额度 Token/费用(usage.js)   │
│    snoop.js   截 SSE 运行令牌      │   额度 %(pulse.js 锚定倒计时)     │
│    monitor.js 回复流帧归约         │   会话历史(history.js)            │
│    pulse.js   /api/me/pulse 轮询   │   自动探针(probe-logic/runner)    │
│    unlock.js / eni.js              │   自动清理(runner.cleanup)        │
│    conversation-rename.js          │   会话探针(session-probe.js)      │
│    probe.js   ArenaProbe RPC 动作  │   重命名对话(rename.js, rpc.js)   │
│   [DOMContentLoaded]               │   功能开关 / 提示词注入            │
│    manager.js plus.js leaderboard  │                                  │
├───────────────────────────────────┴──────────────────────────────────┤
│  Rust (src-tauri, 两端共用)                                            │
│   trace.rs / usage.rs  validate_token → poll Trigger.dev → 模型 + 用量 │
│   store.rs             arenakit-store.json (prefs/历史/闸门)           │
│   lib.rs               on_token · page_event → 'arenakit://page'       │
│                        arena_command(dock→页面 eval)· proxy_get 白名单 │
│   pulse.rs             阈值常量(轮询在页面侧)                          │
└──────────────────────────────────────────────────────────────────────┘
```

## 编排模型:dock 是大脑,页面是手

探针 / 清理 / 重命名 / 会话探针都是 dock 里的 JS 循环(`src/lib/probe-runner.js`,安卓 `ProbeController` 的移植):每一步通过 `arena_command` 在页面里执行 `window.ArenaProbe.call(action, argsJson, reqId)`,页面完成一个安全的 DOM 动作后用 `__ARENAKIT__.send('probe-result', {reqId, ok, data})` 回话,dock 的 `rpc.js` 按 `reqId` 兑现 Promise(35s 超时)。模型名不从 DOM 猜,而是等 snoop → Rust trace 管线按 `sessionId` 给出。停止是即时的:每个 await 都与取消令牌竞速。

这样页面脚本保持无状态、随时可被 SPA 导航冲掉重新注入,而进度、计数、历史都活在不刷新的 dock 里。

## 令牌截获数据流(核心取证链)

1. 用户在 arena.ai 发一条消息 → 页面向 `/ai-proxy/realtime/.../sessions/<id>/stream` 发 SSE 请求。
2. `snoop.js`(MAIN world;fetch `tee()` 分流响应体 + EventSource / XHR 渐进读 / WebSocket 四路挂钩,不干扰页面)从 SSE 帧(或纯 JSON 体的 JWT 形状兜底)里提取 `public-access-token`(Trigger.dev JWT)+ `sessionId` + 截获时的页面路径;同时把原始帧交给页面内的 `monitor.js`(只归约为数字/标志,会话文本不出页面)。
3. `__ARENAKIT__.onToken` 先做路由(对话页 `/agent/{id}` `/c/{id}` 全收;`/agent` 新对话只认第一条新流;其他页丢弃)→ Tauri `on_token` 把 `{token, sessionId}` 送到 Rust。同一 run 后续回复的流活动(`onActivity`,≥45 s 冷却)会用同一枚令牌再跑一次查询。
4. Rust `trace.rs`:`validate_token`(校验 pub/iss/aud/exp/单一 run scope/session 匹配)→ 轮询 `https://api.trigger.dev/api/v1/runs/<runId>/events`(8 次 × 3s,`Authorization: Bearer <token>`)→ `extract_models` 从 `ai.streamText.doStream` 等 span 的 cube 标签抽出服务端真实模型名,`usage.rs` 顺带抽 Token / 费用标签。
5. 逐阶段 `arenakit://trace` 事件(token/poll/model/error/done)到 dock:轮次追踪器记录「第 N 轮 → 模型」,用量模块累加,会话历史落库,自动重命名(若开启)只在当前对话、trace 完整、每对话一次的前提下触发。**盲测模型也能看出真实身份。**

> 关键:令牌校验/解析/SSE 解析规则来自 `core.js`(扩展版)与 `ArenaProtocol.kt`(安卓版),两者已逐条对齐,移植到 Rust 时必须保持规则一致(见 DEVELOPMENT.md 的移植表)。

## 安全边界

- 页面 webview 的 capability(`capabilities/arena.json`)只开放 `on_token / page_event / store_* / proxy_get`;`arena_command` 只有 dock 能调,远程页面永远不能借 Rust 向自己 eval。
- 重命名/归档只走 Arena 自带的侧栏菜单与对话框(`conversation-rename.js`),不碰私有接口;归档不是删除。
- 探针只发送裸算式 `N op N =`,只在全新 `/agent` 且确认 Agent Mode 后发送,**绝不覆盖人工草稿**;清理只归档算式标题、跳过当前打开的对话。
- 额度轮询是页面内同源 GET,Cookie 不导出;`/api/**` 只读这一条。
- 回复监控上报的只有计数/标志和 ≤160 字符的服务端错误信息。

## 为什么注入分两个时机

- **`document_start`(init script,MAIN world)**:`bridge.js`(其余脚本都依赖它)、`snoop.js`(要在 Next.js fetch 前挂钩子)、`monitor.js`、`pulse.js`、`unlock.js`(要在 `__next_f` push 前接管)、`eni.js`(fetch 拦截)、`conversation-rename.js`、`probe.js`、`watchdog.js`(对话看门狗,只上报状态)。
- **`DOMContentLoaded`**:`manager.js` / `plus.js` / `leaderboard.js` 等 UI 脚本,等 DOM 就绪后再挂面板。

两组都由 `lib.rs::build_init_script` 打成一个 `initialization_script`(每次导航前自动重跑,SPA 路由冲不掉),每个模块各自 try/catch 隔离(一个模块顶层抛错不影响其他模块,有 Rust 单测保证)。

## 平台差异(仅这些不同)

| 关注点 | macOS (WKWebView) | Android (System WebView) |
|---|---|---|
| WebView 初始化 | Tauri 默认 | 需 `minSdk 26`,启用 `mixedContent`/DOM storage |
| 注入 MAIN world 脚本 | `initialization_script` | 同,Tauri 2 mobile 支持 |
| 需要 Cookie 的请求 | 在页面内同源 fetch(`pulse.js`),无需导出 | 同 |
| 原生 HTTP(trace) | reqwest,只带 Trigger.dev 公开令牌 | 同 |
| dock 面板 | 右侧子 webview(`Window::add_child`,仅桌面) | **内嵌模式**:mobile 一窗一 webview,`Window::add_child` 不存在;`scripts/bundle-dock.mjs` 把 dock.js + lib + `embed/shell.js` 打成一个经典脚本 `src/embed/dock-embedded.gen.js`,init 脚本在 DOMContentLoaded 后把同一套 dock 标记/样式装进页面的 shadow root(参考安卓应用 v0.6.4 的扁平状态胶囊 + 贴底 Bottom Sheet:单击胶囊开面板、长按快捷菜单、拖动自动贴边、对话底部上拉刷新)。原生壳 `src-tauri/android/MainActivity.kt` 按系统栏 / 输入法 insets 给 WebView 内容加 padding,页面顶部与状态栏平齐;`LinkTab.kt` 在 `onWebViewCreate` 时叠一层原生 WebView 作为「页面链接标签」(页面经 `ArenaKitAndroid` 桥打开,Rust `links.rs` 的 `on_navigation` 兜底),并接管返回键(链接页 → 面板 → 页面历史)。dock.js 通过 `__ARENAKIT_EMBED__` 识别:DOM 查询走 shadow root,页面动作走 `lib/page-actions.js` 的 `run()`(直接调用,不 eval,不受页面 CSP 影响),事件订阅需 `capabilities/arena-mobile.json` 的 `core:event:allow-listen` |
| 签名 | Apple 开发者证书(或自签本地用) | keystore(复用 arena-trace-android 的 CI 方案) |

## 网络与代理注意

- arena.ai 走 mihomo fake-ip(198.18.0.0/15);`api.trigger.dev` 与 `portal/api.preview.arena.ai` 子域可能被代理规则路由到死 egress,原生请求需允许直连或走正确 egress(见 arena-trace-inspector skill)。
- `/api/**` 有严格 allowlist 网关 + reCAPTCHA Enterprise;本项目**只读 trace,不碰 `/api/**` 写接口**。
