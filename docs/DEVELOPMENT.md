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
- **Rust**(`src-tauri/`):取证网络层(trace/pulse)、Cookie 导出、WebView 初始化与脚本注入、IPC 命令。两端共用。
- **JS/TS**(`injected/` + `src/`):注入 arena.ai 的增强脚本、HUD overlay UI。两端共用。
- 平台特定代码极少:仅 WebView 宿主创建与权限声明,由 Tauri 封装。

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

### M4 — 额度 HUD(pulse)
- 移植 `pulse.rs`:60s 轮询额度,三色进度条,切账号即刷,429 退避。
- 验收:HUD 显示额度百分比 + 倒计时;切账号数据刷新。

### M5 — 自动探针 / 清理 / 历史(安卓待移植的二期)
- 移植 `auto-draw.js`(自动抽卡:新建对话→填 prompt→发送→匹配目标→命中改名)、`conversation-rename.js`(清理算式标题残留)、`history.js`(会话历史本地记录)。
- 验收:探针能跑完设定轮数,命中即停,清理不误删。

### M6 — Android 出包
- `cargo tauri android build` 出 apk,复用 arena-trace-android 的 keystore/CI 方案。
- 验收:真机安装,登录、截令牌、额度、注入脚本全部可用。

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
| `injected/snoop.js` | inspector `snoop.js` | JS→JS | 几乎原样。`postMessage` 目标改为 Tauri IPC 桥(`window.__ARENAKIT__.onToken`)。**sessionFromUrl 正则必须与 trace.rs 的 streamSession 保持 lockstep** |
| `injected/manager.js` | Arena-Manager `Arena Manager.user.js` | JS→JS | 去掉 `GM_*`:`GM_setValue/getValue`→`localStorage` 或 Tauri store;`GM_xmlhttpRequest`(取 Logo/Gist)→ Tauri `invoke` 走 Rust fetch 绕过 CORS;`GM_addStyle`→ `document.head` 插 style |
| `injected/unlock.js` | Model-Unlocker `main.js` + `boot.js` | JS→JS | `boot.js` 的设置(`window._ac`)改由前端配置注入;`main.js` 的 `__next_f`/fetch 改写逻辑原样。必须 `document_start` MAIN world |
| `injected/plus.js` | Arena.ai-Plus `content.js` | JS→JS | 拉 OpenRouter 价格的 fetch 改走 Rust(避免 CORS);其余原样 |
| `injected/leaderboard.js` | personal-leaderboard `content.js` | JS→JS | 纯本地统计,存储改 Tauri store |
| `injected/eni.js` | Arena-Ai `arena-prompt-injector.user.js` | JS→JS | 保留 fetch 钩子注入 prompt;`GM_*` 设置面板改前端;去掉 Unicode 混淆(私有工具无需对抗自己) |
| `src-tauri/src/trace.rs` | inspector `core.js` + android `ArenaProtocol.kt` `TraceClient.kt` | JS/Kotlin→Rust | validateToken(pub/iss/aud/exp/单一 run scope/session 匹配)、extractModels(cube 标签)、8×3s 轮询。**逐条对齐两版规则** |
| `src-tauri/src/pulse.rs` | android `PulseClient.kt` `PulseTiming.kt` | Kotlin→Rust | 60s 轮询;cookie 签名变化即刷;429 按 Retry-After 退避 |
| `src-tauri/src/cookies.rs` | android WebView cookie 导出 | Kotlin→Rust | 从 WebView 读 arena.ai Cookie 注入 reqwest |
| `src/hud.*` | inspector `hud.js` `panel.js` `view-model.js` | JS→JS | overlay DOM,两端共用 |
| `injected/autodraw.js` | inspector `auto-draw.js` | JS→JS | M5;保留所有 real-DOM pitfall 规避(见下) |

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
- **Android**:CI 出 debug apk(参考 arena-trace-android 的 `.github/workflows/android.yml`,GitHub Actions 跑单测 + 构建,产物在 Artifacts),真机安装验证。
- 排障沿真实会话/请求转储/服务日志对齐;取证先落地(把错误体、状态码写进可见日志)再改;禁"听起来合理"的推测修复。

---

## 6. 已知坑与规避

- **代理/fake-ip**:mihomo 把 `*.arena.ai` 映射到 198.18.0.0/15;`api.trigger.dev` 与 `api.preview.arena.ai` 子域可能路由到死 egress。原生 reqwest 需允许直连或走正确 egress。curl 直连能通则是代理规则问题,不是站点问题。
- **TipTap/ProseMirror 编辑器**:自动填 prompt 时 `Input.insertText` 和 keyDown+char 都失败/重复,只有逐字符 `char` 事件可行(桌面 CDP);移植 autodraw 到 WebView 注入时用页面内 `execCommand`/InputEvent 逐字符方案,先在真机验证。
- **Shadow DOM 关闭**:读状态用可访问性树/DOM 查询要注意,arena 部分组件 shadow 关闭。
- **WebView 上下文失效**:Android WebView 被系统回收/重建后注入脚本会失联,需在 `onPageFinished`/Tauri page-load 事件里重新注入,并让 HUD 检测失联后提示刷新而非空转。
- **Model-Unlocker 依赖 Next.js 内部结构**(`__next_f`、`disable-opus` 字段);arena 改版会失效,失效时 fetch 钩子静默透传(安全不破坏),需版本探测告警。

---

## 7. IPC 契约(前端 ↔ Rust)

前端注入脚本通过 `window.__ARENAKIT__` 与 Rust 通信(Tauri init script 里预置):

```
// 页面 → Rust
__ARENAKIT__.onToken({sessionId, token})     // snoop 截到令牌
invoke('fetch_trace', {token, sessionId})     // 触发取证(或由 onToken 内部触发)
invoke('proxy_get', {url})                     // 绕 CORS 的原生 GET(Logo/价格/Gist)
invoke('get_credits')                          // 拉额度

// Rust → 前端(事件)
'arenakit://models'    {models: [{model, provider, partial}], runId}
'arenakit://credits'   {remaining, total, resetAt}
'arenakit://error'     {scope, message}
```

命令定义在 `src-tauri/src/lib.rs`,capabilities 在 `src-tauri/capabilities/default.json` 白名单授权。
