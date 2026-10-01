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
│    account.js 会话 Cookie 快照/恢复│   账号切换(accounts.js,          │
│               + 一键重新登录       │     account-flow.js)             │
│   [DOMContentLoaded]               │   功能开关 / 提示词注入            │
│    manager.js plus.js              │                                  │
├───────────────────────────────────┴──────────────────────────────────┤
│  Rust (src-tauri, 两端共用)                                            │
│   trace.rs / usage.rs  validate_token → poll Trigger.dev → 模型 + 用量 │
│   store.rs             arenakit-store.json (prefs/历史/闸门)           │
│   lib.rs               on_token · page_event → 'arenakit://page'       │
│                        arena_command(dock→页面 eval)· proxy_get 白名单 │
│                        login_set/clear:待登录凭据(内存,10 min TTL)   │
│                        → on_page_load 推给 arena / accounts.google.com │
└──────────────────────────────────────────────────────────────────────┘
```

## 编排模型:dock 是大脑,页面是手

探针 / 清理 / 重命名 / 会话探针都是 dock 里的 JS 循环(`src/lib/probe-runner.js`,安卓 `ProbeController` 的移植):每一步通过 `arena_command` 在页面里执行 `window.ArenaProbe.call(action, argsJson, reqId)`,页面完成一个安全的 DOM 动作后用 `__ARENAKIT__.send('probe-result', {reqId, ok, data})` 回话,dock 的 `rpc.js` 按 `reqId` 兑现 Promise(35s 超时)。模型名不从 DOM 猜,而是等 snoop → Rust trace 管线按 `sessionId` 给出。显示时(表头 / 胶囊 / 服务端模型模块)由 `src/lib/model-resolve.js` 按可信度依次查:本次运行 → 本地历史记录(流会话 id / 页面 id / 记录里的 `pageIds`)→ 运行 span 标签 → 轮次追踪 → 最后才按会话标题推断(标「标题推断」,不写入记录);历史加载完成、标题稍后到达、trace 结束无标签时重新解析。停止是即时的:每个 await 都与取消令牌竞速。

这样页面脚本保持无状态、随时可被 SPA 导航冲掉重新注入,而进度、计数、历史都活在不刷新的 dock 里。

## 令牌截获数据流(核心取证链)

1. 用户在 arena.ai 发一条消息 → 页面向 `/ai-proxy/realtime/.../sessions/<id>/stream` 发 SSE 请求。
2. `snoop.js`(MAIN world;fetch `tee()` 分流响应体 + EventSource / XHR 渐进读 / WebSocket 四路挂钩,不干扰页面)从 SSE 帧(或纯 JSON 体的 JWT 形状兜底)里提取 `public-access-token`(Trigger.dev JWT)+ `sessionId` + 截获时的页面路径;同时把原始帧交给页面内的 `monitor.js`(只归约为数字/标志,会话文本不出页面)。
3. `__ARENAKIT__.onToken` 先做路由(对话页 `/agent/{id}` `/c/{id}` 全收;`/agent` 新对话只认第一条新流;其他页丢弃)→ Tauri `on_token` 把 `{token, sessionId}` 送到 Rust。同一 run 后续回复的流活动(`onActivity`,≥45 s 冷却)会用同一枚令牌再跑一次查询。
4. Rust `trace.rs`:`validate_token`(校验 pub/iss/aud/exp/单一 run scope/session 匹配)→ 轮询 `https://api.trigger.dev/api/v1/runs/<runId>/events`(8 次 × 3s,`Authorization: Bearer <token>`)→ `extract_models` 从 `ai.streamText.doStream` 等 span 的 cube 标签抽出服务端真实模型名,`usage.rs` 顺带抽 Token / 费用标签。
5. 逐阶段 `arenakit://trace` 事件(token/poll/model/error/done)到 dock:轮次追踪器记录「第 N 轮 → 模型」,用量模块累加,会话历史落库,自动重命名(若开启)只在当前对话、trace 完整、每对话一次的前提下触发。**盲测模型也能看出真实身份。**

> 关键:令牌校验/解析/SSE 解析规则来自 `core.js`(扩展版)与 `ArenaProtocol.kt`(安卓版),两者已逐条对齐,移植到 Rust 时必须保持规则一致(见 DEVELOPMENT.md 的移植表)。

## trace 失败时的指纹兜底(统计推测,不是真名)

trace 管线依赖一枚**明确指定单一 run 的** Trigger.dev 公开令牌:令牌缺失 / 过期 / scope 不匹配 / Trigger.dev 事件不含模型标签时,`extract_models` 给不出服务端真名。此时 ArenaKit 可退回一条**完全独立、离线、统计性**的推测链——它给出的是「指纹推测」而非「已确认」,信任等级低于任何服务端信号。

```
服务端真名(trace / 历史记录)              ← 唯一可信「已确认」来源,SOURCE_RANK 最高
      │  缺失时才启用 ↓
指纹推测(fingerprint,source='fingerprint',SOURCE_RANK=2)
      │
      ├─ 被动:监控已有回复 → 页面侧归约成结构化特征(数字/类别,绝不出原文)
      └─ 主动:probe-runner 发固定探针(需用户再次确认 + 预算上限)→ 同样归约
                        ↓
      src/lib/fingerprint.js classify():判别式白化 + softmax,带 OOD / margin / confidence 三道门
                        ↓
      通过 → estimatedModel + family(opus/fable/gpt6);任一门不过 → unresolved / unknown(宁可无结论)
```

- **数据流**:页面侧(`injected/fingerprint.js` + `probe.js`)把回复**只归约成数字 / 类别特征**,经 flag 门控的 `fingerprint-sample` 安全事件通道传给 dock;**原文永不过桥**。dock 的 `fingerprint-runner.js` 按协议累积特征,`fingerprint.js` 的 `classify()` 对照离线 bank(`src/lib/fingerprint-banks.js`,`data/fingerprint/*` 的冻结副本,**不走网络**,远端配置无法替换参考分布)打分。
- **信任顺序**(`src/lib/model-resolve.js`):指纹推测的 `SOURCE_RANK=2`,**低于**本次运行 / 历史记录里的服务端真名,**高于**标题推断;一旦服务端真名到达(trace 后续成功),**立即覆盖**指纹推测。指纹**绝不覆盖已确认的模型,也绝不触发自动重命名**(自动重命名只认服务端真名)。
- **两协议严格分离**:ModelTrace 长整数直方图(`modeltrace-long-integers-v1`)与 fpverify 类别电池(`fpverify-battery-v1`)各自独立评分,**候选概率永不跨协议合并**。
- **诚实边界**:bank 是作者自述第三方渠道的**起始先验**,未经真实匹配渠道的 Arena 盲测标定(`DEFAULT_THRESHOLDS.calibrated=false`,UI 标注「未完成 Arena 校准」);family ≠ 精确版本;softmax 不是标定后的正确概率。离线评估脚手架(`scripts/fingerprint-calibrate.mjs`)只公布内部可分性上界,不等于 Arena 真实准确率。详见 `docs/FINGERPRINT.md`。
- **门禁**:缺 bank 不发送;未确认不发探针、不新建会话、不消耗额度;取消即时生效且不超预算重发。主动探针这条路**默认关闭**,只在用户单独确认后小规模受控启用。

## 安全边界

- 页面 webview 的 capability(`capabilities/arena.json`)只开放 `on_token / page_event / store_* / proxy_get`;`arena_command` 只有 dock 能调,远程页面永远不能借 Rust 向自己 eval。
- 重命名/归档只走 Arena 自带的侧栏菜单与对话框(`conversation-rename.js`),不碰私有接口;归档不是删除。
- 探针只发送裸算式 `N op N =`,只在全新 `/agent` 且确认 Agent Mode 后发送,**绝不覆盖人工草稿**;清理只归档算式标题、跳过当前打开的对话。
- 额度轮询是页面内同源 GET,Cookie 不导出;`/api/**` 只读这一条。
- 回复监控上报的只有计数/标志和 ≤160 字符的服务端错误信息。
- 账号:会话 Cookie 快照**明文**存在本机 `arenakit-store.json` 的 `accounts` 键(文件权限 0600),不上传、不经任何第三方;桌面端 arena 页面本身没有 `store_*` 权限(只有 dock 有;安卓内嵌 dock 跑在页面里,因此 `arena-mobile.json` 仍需授予);**不保存任何密码 / 2FA 密钥**(0.4.9 删除了登录助手,旧版存的 `login{password,totp}` 加载时丢弃)。重新登录时只把「是谁」`{accountId, email, startedAt}` 放在 Rust 内存里(TTL),且只推给 arena 域和 `links.rs` 认定的登录域(`login_host_ok`)。切换账号不调用 signOut(那会吊销刷新令牌),只换 Cookie。

## 账号:一键切换与一键重新登录

Arena 的登录 = Supabase SSR 分块 Cookie(`arena-auth-prod-v1.0/.1`,值 `base64-` + base64url JSON,含 access/refresh token 与 user),没有站内 2FA;Google 登录是整页跳转到 `accounts.google.com`(`links.js` 让登录域留在主 webview)。因此:

- **快照**:`injected/account.js` 读 `document.cookie`,拼块、解码,得到 `{loggedIn, anonymous, userId, email, name, avatar, provider, expiresAt, cookies, sig, scope}`;每 4 s 轮询 + `visibilitychange`,签名变了就 `send('account')`(刷新令牌会轮换,旧令牌复用会吊销整族,所以快照必须跟着变)。`dock` 侧 `applySnapshot` 合并进 `accounts` store,登录后的账号自动被记录。
- **游客态不是账号**:arena 对未登录访客做 Supabase 匿名登录(JWT `is_anonymous: true`、无邮箱、Cookie 名和正式登录一模一样)。快照只把「非匿名且有邮箱」的会话算作 `loggedIn`(`accounts.js isRealLogin`),游客 / 解析不出邮箱的会话既不建记录也不改动已有记录,只把 `activeId` 清空;旧版本存下来的游客记录(只有 userId、没有邮箱 / 登录邮箱 / 备注)在 `normalizeAccount` 里被丢弃。
- **切换**(`src/lib/account-flow.js` `switchTo`):先 RPC `snapshot` 让当前账号最新 → 存 `pending:{type:'switch',id}` → RPC `restore{cookies, scope, expectSig, navigate:'/'}`:页面先核对当前 Cookie 签名仍等于 dock 快照的 `expectSig`(不等 = 这中间令牌又轮换了 → 返回 `{stale, previous}`,dock 把 `previous` 存成离开账号的最新令牌后重试一次),再按站点原有的 host / `Domain=.arena.ai` 作用域写回(先删旧块及其兄弟块),核对无残留后**在同一个任务里** `location.replace('/')` 跳到站点首页——不刷新原来的对话 URL(那是上一个账号的对话,新账号打不开,加载失败后站点会把会话清掉变成游客态),也不给站点自己的 auth 客户端把旧会话写回来的空档。跳转后第一份快照由 `resolvePending` 定夺:是目标 → `switched`;别的账号 → `other`;未登录 / 游客态 → `lost`(该账号存的会话被服务端拒绝 = 令牌族已吊销,永远回不来,所以 `dropSession` 把它的 Cookie 从记录里清掉,卡片从「切换」变成「登录」,由用户点「登录」走一键重新登录)。`switched` 之后还有 20 s 核对窗(`VERIFY_MS`):站点的 auth 客户端在加载后刷新令牌失败会先登出再匿名登录,这时到来的游客快照同样按 `lost` 处理,而不是当成用户自己退出。pending 持久化,因为安卓内嵌 dock 随页面一起消亡。
- **换 Cookie 与下一个文档之间的空档**(`injected/account.js`):`restore` / `clear` 带 `navigate` 应答后,页面先 `freezeAuthWrites()`——给 `document.cookie` 装一个丢弃 auth Cookie 写入的 setter(Cookie Store API 同样拦),旧页面里正在飞的令牌刷新回来也写不回旧会话;同时删掉 web storage 里的会话副本(`sb-*-auth-token` / 同名键),免得站点客户端用旧副本复活旧账号并烧掉新账号的刷新令牌。`restore` 还把期望的会话写进 sessionStorage `arenakit.account.expect`(30 s 有效),下一个文档在 document_start 复核:签名一致 → `intact`;同一 userId 但令牌变了(服务端在中间件里刷新过)→ `rotated`;别的账号 / 游客 / 空 → 在站点脚本运行前重写期望的 Cookie 并再加载一次(`reapplied:…`,戳先消费,最多一次)。结果随 `init` 快照的 `bootCheck` 上报,dock 记进活动日志(`账号会话核对: …`)。
- **添加账号**(`add`):保存当前 → `pending:add` → RPC `clear{navigate:'/'}`(游客 Cookie 一并清)→ 首页 → 用户登录 → 第一份**真实**登录快照 → `added`(期间出现的游客会话只提示「游客状态不会被记录」)。
- **一键重新登录**(0.4.10,`startLogin`;0.4.9 起取代登录助手):账号都先由用户手工登录一次(之后被自动记录);会话失效(`lost`)时**不自动登录**,卡片显示「登录」由用户点。dock `invoke('login_set',{creds:{accountId,email,startedAt}})`,Rust 存内存;页面还有别的真实会话就 `clear{navigate:'/agent'}`,否则直接 RPC `login{creds}`。之后每次页面加载 Rust 在 `on_page_load` 里 eval `__AK_LOGIN_APPLY__(creds)`(arena 与 Google 域都推)。account.js——arena:`goGoogle` = 清掉失效的 auth Cookie / web storage 会话 + `freezeAuthWrites` → `location.assign('/nextjs-api/sign-in/google?shouldLinkHistory=false&marketingConsent=false&returnTo=%2Fagent')`(不点网站按钮:它带 `shouldLinkHistory=true`,会话已死时返回 `{"error":"Auth session missing!"}`);`/nextjs-api/*` 页面返回 JSON 错误 → 再试一次 → `error` + `replace('/agent')`;Google:账号选择页点 `[data-identifier=邮箱]` → 确认页点「继续」;回到 arena 已登录 = `done` → `login_clear`。需要输入账号 / 密码 / 验证码等 → 页面底部说明条交给用户。每次只走一趟 OAuth(sessionStorage `arenakit.relogin.try`),不循环;真实点按暂停 10 s;5 min 超时。**添加账号** = `login_set {mode:'add'}`,同样的 Google 入口,账号选择页点「使用其他账号」,账号输入页交给用户,任何登录成功都算完成。
- UA:WKWebView 默认 UA 会被 Google 判为内嵌浏览器(`disallowed_useragent`),桌面用 Safari 等价 UA(`DESKTOP_USER_AGENT`),安卓 `MainActivity.kt` 去掉 `; wv` / `Version/4.0`。
- 已在沙箱里实测的部分(`tests/account-flow.test.mjs`、`tests/account.test.mjs`):真实的 account.js 跑在带 Domain / Max-Age 语义的 Cookie 罐上,经真实 RPC + flow 完成「首登自动记录 → 添加第二个 → 令牌轮换跟随 → 来回切换 → 会话失效 → 点登录 → arena 点登录 / 勾同意 / Google → Google 选账号 → 继续 → 登录成功清理」;以及游客会话不入列表、`expectSig` 拒换重试、切换落在游客态判 `lost`、交给用户的各种 Google 页面、模型名里的「Google」按钮不会被误点。**未在真机验证**:arena.ai 登录框与 Google 确认页的真实 DOM 文字、服务端是否接受换回去的刷新令牌、Rust `on_page_load` 时序。

## 为什么注入分两个时机

- **`document_start`(init script,MAIN world)**:`bridge.js`(其余脚本都依赖它)、`snoop.js`(要在 Next.js fetch 前挂钩子)、`monitor.js`、`pulse.js`、`unlock.js`(要在 `__next_f` push 前接管)、`eni.js`(fetch 拦截)、`conversation-rename.js`、`probe.js`、`watchdog.js`(对话看门狗,只上报状态)。
- **`DOMContentLoaded`**:`manager.js` / `plus.js` 等 UI 脚本,等 DOM 就绪后再挂面板。

两组都由 `lib.rs::build_init_script` 打成一个 `initialization_script`(每次导航前自动重跑,SPA 路由冲不掉),每个模块各自 try/catch 隔离(一个模块顶层抛错不影响其他模块,有 Rust 单测保证)。

## 平台差异(仅这些不同)

| 关注点 | macOS (WKWebView) | Android (System WebView) |
|---|---|---|
| WebView 初始化 | Tauri 默认 | 需 `minSdk 26`,启用 `mixedContent`/DOM storage |
| 注入 MAIN world 脚本 | `initialization_script` | 同,Tauri 2 mobile 支持 |
| 需要 Cookie 的请求 | 在页面内同源 fetch(`pulse.js`),无需导出 | 同 |
| 原生 HTTP(trace) | reqwest,只带 Trigger.dev 公开令牌 | 同 |
| dock 面板 | **分栏模式**(唯一桌面布局):`lib.rs` 启动时 `desktop_layout()` 直接返回 `Dock`,起一个 `Window "main"`(1360×900),装两个子 webview——左 `arena`(`https://arena.ai`,init 脚本只含 bridge/snoop/... 等注入,平台标记 `__ARENAKIT_PLATFORM__="desktop"`),右 `dock`(`dock.html`,与安卓同一份前端,通过 `WebviewUrl::App` 加载)。`prefs.desktopLayout` 已废弃,旧值被忽略。键鼠补齐:window 捕获阶段 `keydown`:Esc → `handleBack()`、⌘/Ctrl+R / F5 → `fire('refresh')`(dock `requestReload`:防抖、忙碌确认、进度条)、⌘[ / ⌘] → `history.back/forward`(编辑框内不拦截);`@media (hover: hover)` 悬停样式;能力 `capabilities/arena.json` 只给页面必需的命令,不授予 `core:event:*` / `login_set`(桌面 dock 自有 webview,页面不订阅事件)。菜单栏「页面」(`menu.rs`):刷新 ⌘R / 后退 / 前进经 `arenakit://page` 事件 `menu` 交给 dock,在浏览器中打开 / 复制链接原生完成,焦点在 `tab-*` 链接窗口时直接作用于该窗口(= 安卓链接页工具栏) | **内嵌模式**:mobile 一窗一 webview,`Window::add_child` 不存在;`scripts/bundle-dock.mjs` 把 dock.js + lib + `embed/shell.js` 打成一个经典脚本 `src/embed/dock-embedded.gen.js`,init 脚本在 DOMContentLoaded 后把同一套 dock 标记/样式装进页面的 shadow root(参考安卓应用 v0.6.4 的扁平状态胶囊 + 贴底 Bottom Sheet:胶囊 = 额度环 + 标签 + 可选 ⟳ 区,单击胶囊开面板、点 ⟳ 刷新、长按快捷菜单、拖动自动贴边、对话底部上拉刷新)。原生壳 `src-tauri/android/MainActivity.kt` 按系统栏 / 输入法 insets 给 WebView 内容加 padding,页面顶部与状态栏平齐;`LinkTab.kt` 在 `onWebViewCreate` 时叠一层原生 WebView 作为「页面链接标签」(页面经 `ArenaKitAndroid` 桥打开,Rust `links.rs` 的 `on_navigation` 兜底),并接管返回键(链接页 → 面板 → 页面历史)。dock.js 通过 `__ARENAKIT_EMBED__` 识别:DOM 查询走 shadow root,页面动作走 `lib/page-actions.js` 的 `run()`(直接调用,不 eval,不受页面 CSP 影响),事件订阅需 `capabilities/arena-mobile.json` 的 `core:event:allow-listen` |
| 签名 | Apple 开发者证书(或自签本地用) | keystore(复用 arena-trace-android 的 CI 方案) |

## 网络与代理注意

- arena.ai 走 mihomo fake-ip(198.18.0.0/15);`api.trigger.dev` 与 `portal/api.preview.arena.ai` 子域可能被代理规则路由到死 egress,原生请求需允许直连或走正确 egress(见 arena-trace-inspector skill)。
- `/api/**` 有严格 allowlist 网关 + reCAPTCHA Enterprise;本项目**只读 trace,不碰 `/api/**` 写接口**。
