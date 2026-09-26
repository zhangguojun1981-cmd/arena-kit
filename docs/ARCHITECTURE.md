# ArenaKit 架构

## 一句话

一个 Tauri 2 应用:原生窗口里嵌系统 WebView 打开 `https://arena.ai`,在页面注入增强脚本(筛选/解锁/提示词),同时用 Rust 网络层完成"截令牌→查真实模型→盯额度"的取证,结果画在前端 HUD 上。macOS 与 Android 共用同一套 Rust + JS,仅 WebView 宿主不同。

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│  平台宿主 (Tauri Runtime)                                     │
│   macOS  → WKWebView          Android → android.webkit.WebView │
├─────────────────────────────────────────────────────────────┤
│  WebView: https://arena.ai (用户真实登录态 / Cookie)          │
│   ├── [MAIN world 注入] snoop.js   截 SSE 里的运行令牌         │
│   ├── [MAIN world 注入] unlock.js  改 __next_f 数据解锁隐藏模型 │
│   ├── [MAIN world 注入] eni.js     fetch 钩子注入系统提示词    │
│   └── [idle 注入]       manager.js 筛选/分类/排序 UI(油猴移植)│
│         plus.js / leaderboard.js  排行榜列 / 投票统计          │
├──────────────── IPC (window.__ARENAKIT__ / invoke) ───────────┤
│  Rust 核心 (src-tauri) —— 两端共用                            │
│   ├── trace.rs   validate_token → poll Trigger.dev → 抽模型名  │
│   ├── pulse.rs   60s 轮询额度,切账号即刷,429 退避            │
│   ├── cookies.rs 从 WebView 读 arena.ai Cookie 供原生请求      │
│   └── inject.rs  按平台把 injected/*.js 装进 WebView           │
├─────────────────────────────────────────────────────────────┤
│  前端 HUD (src/) —— 两端共用 DOM overlay                     │
│   悬浮球 / 模型名卡片 / 额度进度条 / 探针控制 / 设置面板       │
└─────────────────────────────────────────────────────────────┘
```

## 令牌截获数据流(核心取证链)

1. 用户在 arena.ai 发一条消息 → 页面向 `/ai-proxy/realtime/.../sessions/<id>/stream` 发 SSE 请求。
2. `snoop.js`(MAIN world,`tee()` 分流响应体,不干扰页面)从 SSE 帧里提取 `public-access-token`(Trigger.dev JWT)+ `sessionId`。
3. 通过 `window.postMessage` → Tauri IPC 把 `{token, sessionId}` 送到 Rust。
4. Rust `trace.rs`:`validate_token`(校验 pub/iss/aud/exp/单一 run scope/session 匹配)→ 轮询 `https://api.trigger.dev/api/v1/runs/<runId>/events`(8 次 × 3s,带 `Authorization: Bearer <token>`)→ `extract_models` 从 `ai.streamText.doStream` 等 span 的 cube 标签抽出服务端真实模型名。
5. 结果经 IPC 回前端 HUD 显示。**盲测模型也能看出真实身份。**

> 关键:令牌校验/解析/SSE 解析规则来自 `core.js`(扩展版)与 `ArenaProtocol.kt`(安卓版),两者已逐条对齐,移植到 Rust 时必须保持规则一致(见 DEVELOPMENT.md 的移植表)。

## 为什么注入分两个时机 / 两个 world

- **MAIN world + `document_start`**:`snoop.js`(要在 Next.js fetch 前挂钩子)、`unlock.js`(要在 `__next_f` push 前接管)、`eni.js`(fetch 拦截)。必须在页面脚本之前、且与页面共享 `window`。
- **默认时机 + `document_idle`**:`manager.js` 等 UI 脚本,等 DOM 就绪后再挂面板。

Tauri 里用 `WebviewWindowBuilder::initialization_script`(MAIN world 等价,页面加载前执行)承载前者;后者可在前端 `DOMContentLoaded` 后 `eval` 注入,或同样用 init script 内部延迟挂载。

## 平台差异(仅这些不同)

| 关注点 | macOS (WKWebView) | Android (System WebView) |
|---|---|---|
| WebView 初始化 | Tauri 默认 | 需 `minSdk 26`,启用 `mixedContent`/DOM storage |
| 注入 MAIN world 脚本 | `initialization_script` | 同,Tauri 2 mobile 支持 |
| 原生 HTTP 带 Cookie | reqwest + WKHTTPCookieStore 导出 | reqwest + CookieManager 导出 |
| 悬浮 HUD | 前端 overlay(窗口内) | 前端 overlay;如需系统级悬浮球再加 `SYSTEM_ALERT_WINDOW`(二期) |
| 签名 | Apple 开发者证书(或自签本地用) | keystore(复用 arena-trace-android 的 CI 方案) |

## 网络与代理注意

- arena.ai 走 mihomo fake-ip(198.18.0.0/15);`api.trigger.dev` 与 `portal/api.preview.arena.ai` 子域可能被代理规则路由到死 egress,原生请求需允许直连或走正确 egress(见 arena-trace-inspector skill)。
- `/api/**` 有严格 allowlist 网关 + reCAPTCHA Enterprise;本项目**只读 trace,不碰 `/api/**` 写接口**。
