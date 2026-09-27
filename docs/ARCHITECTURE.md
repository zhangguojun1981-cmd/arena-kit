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
│   ├── [MAIN world 注入] bootstrap.js  window.__ARENAKIT__ 桥 + 模块开关 │
│   ├── [MAIN world 注入] gm-shim.js    GM_* / chrome.storage 垫片       │
│   └── [idle 注入]       hud.js        页内 HUD(Shadow DOM,可拖动)    │
├──────────────── IPC (window.__ARENAKIT__ / invoke) ───────────┤
│  Rust 核心 (src-tauri/src/lib.rs) —— 两端共用                 │
│   ├── build_init_script  组装 env + bootstrap + shim + 各模块(按开关) │
│   ├── sessions.rs  账号簿 accounts.json / 代理校验 / 标签列表   │
│   ├── trace.rs   validate_token → poll Trigger.dev → 抽模型名 + Token/费用标签 │
│   ├── turns.rs   回复监控:每令牌一轮,routed = 与首轮模型不同  │
│   ├── probe.rs / probe_logic.rs  自动探针 / 清理 / 快捷发送 / 自动重命名(JS-RPC 驱动页面) │
│   ├── pulse.rs   额度阈值 / 退避(轮询循环待接入)              │
│   └── broadcast  事件带 tab 标签 emit 给 Shell + eval 进对应页面 HUD │
├─────────────────────────────────────────────────────────────┤
│  桌面 Shell (src/shell.html) —— 唯一本地 WebView,铺满窗口     │
│   ├── 顶栏 44px:标签(每个 arena 页面)/ + 选账号 / 首页        │
│   ├── 首页(账号管理);激活标签时被原生子 WebView 覆盖          │
│   └── 右列 340px Dock:模型卡 / 额度 / 开关 / 提示词 / 主题     │
│  arena 标签页 = 子 WebView(arena-<n>):账号数据存储 + 代理节点 │
└─────────────────────────────────────────────────────────────┘
```

## 界面设计系统

- **令牌化**:`src/theme.css` 定义颜色、字体、圆角、动效的 CSS 变量;亮/暗由 `<html data-theme="light|dark">` 驱动,缺省跟随 `prefers-color-scheme`。Dock 的主题偏好存 `localStorage.ak_theme`,首屏前内联脚本先行应用避免闪烁。
- **扁平极简**:无渐变、无投影,层次全部来自表面色阶(`--bg` → `--surface` → `--surface-2/3`)与 1px 发丝线;单一强调色(iris),状态色只用于状态(ok / warn / danger)。
- **两套壳,一套语言**:Shell(桌面本地 WebView:标签栏 + 首页 + Dock)与 HUD(页内 Shadow DOM,不受 arena 样式影响)共享同一组令牌值与排版规则;HUD 自动跟随 arena 的 `html.dark`。
- **可预览**:`npm run preview` 起静态服务,`src/index.html` 用 iframe 并排展示 Shell(首页 / 多标签)、亮/暗 Dock、手机首页与 HUD,均使用示例数据,无需 Tauri。

## 账号 / 标签 / 代理(桌面)

- **默认首页**:窗口启动只创建 `shell` 子 WebView(铺满窗口),不加载 arena.ai。用户在首页(或顶栏 `+` 的原生菜单)选一个账号才创建标签。
- **标签 = 子 WebView**:`open_tab(account_id)` 用 `Window::add_child` 创建 `arena-<n>`,位置/尺寸恰好覆盖 Shell 的中间区域(`TOPBAR_H = 44`,`DOCK_W = 340`,与 `shell.css` 一致);窗口 `Resized` 时 Rust 重算所有子 WebView 的 bounds(不用 `auto_resize`,它会按比例拉伸 Dock 列)。切换标签 = `show()/hide()`;关闭 = `close()`;没有激活标签时首页可见。
- **账号隔离**:每个标签用账号的 16 字节 `data_store_identifier`(macOS 14+,`WKWebsiteDataStore(forIdentifier:)`)或独立 `data_directory`(Windows / Linux)。同一账号的多个标签共享登录态(像浏览器多开同一站点)。
- **代理节点**:`WebviewBuilder::proxy_url`(`http://` / `socks5://`,需 Cargo feature `macos-proxy`,因此 `minimumSystemVersion = 14.0`)。Rust 侧替页面发出的请求(`fetch_trace` 轮询 Trigger.dev、`proxy_get`)用调用方 WebView 的标签查到账号,构造带同一代理的 reqwest Client,保证页面与后台请求同一出口。
- **事件归属**:所有 `arenakit://*` 事件的 payload 为 `{ tab, data }`;`page_event` / `fetch_trace` 的 `Webview` 参数给出来源标签。Dock 只渲染激活标签,后台标签的事件进缓存,切回时回放;`arenakit://tabs` 通知 Shell 重绘标签栏。
- **ACL**:`capabilities/default.json`(`local: true`,webviews `shell` + `main`)拥有全部命令;`capabilities/arena.json`(远程 `arena.ai`,webviews `arena-*` + `main`)只有 `fetch_trace / proxy_get / page_event / get_app_info`。原生弹出菜单(`Window::popup_menu`)用于选账号,因为 HTML 弹层会被子 WebView 遮住。

## 自动化(探针 / 清理 / 重命名)与回复监控

- **分工与安卓版一致**:页面侧 `injected/probe.js` / `injected/rename.js` 只做"一步一动作"的 DOM 操作(新建对话、确认 Agent Mode、填算式并发送、扫侧栏、归档、重命名),全部经 Arena 自己的 UI;循环在 Rust `probe.rs` 里,通过 `webview.eval("ArenaProbe.call(action,args,reqId)")` 发起、页面用 `page_event{kind:"probe"}` 回传结果(`tokio::oneshot` 等待,35 s 超时)。模型名来自已有的 snoop → `fetch_trace` 链路,按 `sessionId` 存入该标签的 `TabMemory`,探针轮询它(最多 45 s)。
- **安全红线**(照搬扩展):不覆盖用户草稿(`noDraft`)、只发送 / 只清理纯算式标题、发送前多重守卫(页面 / 模式 / 会话未变)、连续失败 3 次中止、归档≠删除、跳过当前对话、每个操作后关闭自己打开的菜单。
- **回复监控**:`fetch_trace` 收到令牌即 `TurnTracker::on_token`(会话变化则重置)并广播 `arenakit://turn`;识别完成后 `record()` 给出 `第 N 轮 · 模型` / `已切换模型 →`(routed)和最近 6 轮历史,随 `arenakit://models` 一起下发。
- **会话记忆**:`bootstrap.js` 钩住 pushState / replaceState / popstate 上报 `page_event{kind:"nav"}`;Rust 按 `/agent/<id>` 回放 `models_by_session` / `usage_by_session`(`restored:true`)或发 `cleared:true` 让 UI 清空。
- **用量**:`trace::extract_usage` 只读模型 span 上的 `tabler-hash`(Token,支持 k/m/b 后缀 → 标记 ≈)与 `tabler-currency-dollar`(费用)标签,`summarize_usage` 给本轮 / 本会话累计,缺失就说"未提供"。
- **移动端**:没有 Dock,HUD 里提供开始探针 / 停止 / 清理 / 快捷发送(两次点按确认),命令由 `capabilities/mobile-hud.json`(仅 android / iOS、仅 `main` 远程 webview)放行;参数在首页"自动化设置"里保存(`settings.json`)。

## 令牌截获数据流(核心取证链)

1. 用户在 arena.ai 发一条消息 → 页面向 `/ai-proxy/realtime/.../sessions/<id>/stream` 发 SSE 请求。
2. `snoop.js`(MAIN world,`tee()` 分流响应体,不干扰页面)从 SSE 帧里提取 `public-access-token`(Trigger.dev JWT)+ `sessionId`。
3. 通过 `window.__ARENAKIT__.onToken` → Tauri IPC(`fetch_trace`)把 `{token, sessionId}` 送到 Rust;远程页面的 IPC 由 `capabilities/arena.json` 精确授权(只开放 fetch_trace / proxy_get / page_event / get_app_info)。
4. Rust `trace.rs`:`validate_token`(校验 pub/iss/aud/exp/单一 run scope/session 匹配)→ 轮询 `https://api.trigger.dev/api/v1/runs/<runId>/events`(8 次 × 3s,带 `Authorization: Bearer <token>`)→ `extract_models` 从 `ai.streamText.doStream` 等 span 的 cube 标签抽出服务端真实模型名。
5. 结果经 `broadcast` 同时发到 Dock(`arenakit://models` 事件)与页内 HUD(`__AK_HUD__.push`)。**盲测模型也能看出真实身份。**

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
| 界面 | Shell(标签栏 + 首页 + Dock)+ N 个 arena 标签子 WebView(`add_child`) | 单个 WebView(`WebviewWindowBuilder`):启动在 `shell.html` 手机首页,"打开 Arena"导航到 arena.ai,HUD 的"首页"按钮经 `page_event{kind:"home"}` 导航回来 |
| 多账号 / 代理 | 每标签独立数据存储 + 代理节点 | **单账号**:系统 WebView 只有一份 Cookie 存储、代理为进程级(`ProxyController`);多账号用系统"应用分身",节点交给 Clash 等 VPN |
| 系统栏 | — | Tauri 模板 `enableEdgeToEdge()` 让页面顶到状态栏下;`android-overlay/.../MainActivity.kt` 给内容根加 systemBars + cutout + IME 的 padding(CI 在 `android init` 后覆盖) |
| 悬浮 HUD | 可在 Dock 里打开(默认关) | 默认开;如需系统级悬浮球再加 `SYSTEM_ALERT_WINDOW`(二期) |
| 签名 | Apple 开发者证书(或自签本地用) | keystore(复用 arena-trace-android 的 CI 方案) |

## 网络与代理注意

- arena.ai 走 mihomo fake-ip(198.18.0.0/15);`api.trigger.dev` 与 `portal/api.preview.arena.ai` 子域可能被代理规则路由到死 egress,原生请求需允许直连或走正确 egress(见 arena-trace-inspector skill)。
- `/api/**` 有严格 allowlist 网关 + reCAPTCHA Enterprise;本项目**只读 trace,不碰 `/api/**` 写接口**。
