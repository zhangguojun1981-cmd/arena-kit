# ArenaKit 0.5.0 二次审计(第二意见)

日期:2026-09-29 · 对象:`main` = 0.5.0(合并提交 `1c06840`,树同 `267fc29`)· 方法:全量静态阅读 + 可执行的 JS 回归测试。
沙箱没有 Rust / Android 工具链,`src-tauri/**` 与 Kotlin 只能读、不能编译——凡涉及 Rust 的改动都只给补丁、不落盘(§6),需要在有 `cargo` 的机器上验证。

审计范围(按事先确认的四部分):

1. 逐条复核 `docs/AUDIT.md` 的 24 项「已修复」是否真的落在代码里(§1);
2. 安全:注入脚本 ↔ Rust 的 IPC 边界、capability、令牌 / Cookie 流、`innerHTML` 与远程配置(§2);
3. 功能对照 `docs/DEVELOPMENT.md` §3 不变量与 §7 IPC 契约(§3);
4. 健壮性 / 冗余 / CI(§4)。

## 0. 结论

上一轮审计的 24 项修复**全部核实在代码中**(其中 3 项按其自述仍需真机确认)。这一轮没有发现可以越过 capability 或从远程页面直接读到凭据的漏洞;找到 **1 个供应链型 XSS 面(P2)**、**2 个页面可滥用的能力(P3)**、若干健壮性与文档漂移问题。能在沙箱里验证的都已修复并附回归测试(JS 263 条全绿);Rust / Kotlin 侧给出补丁。

| # | 级别 | 问题 | 处理 |
|---|------|------|------|
| A1 | **P2 安全** | `manager.js` 自动拉取第三方仓库的 `company-rules.json`,其中 `icon` 字符串原样进入 `innerHTML`(`getOrgLogoHtml`);「推荐配置」差异弹窗把远程模型名 / 分组名未转义拼进 `innerHTML`;分组页签 `data-mode` 属性未转义 | **已修复** + 测试 |
| A2 | P3 安全 | `gist_request` 允许任何页面脚本用用户的 GitHub token `POST /gists`(任意内容、可 `public:true`)——页面拿到一个「以用户身份发布 Gist」的写入口 | 补丁见 §6.1(Rust,未编译) |
| A3 | P3 最小权限 | 桌面 `capabilities/arena.json` 给远程页面授予 `core:event:allow-listen/unlisten` 与 `allow-login-set`,但桌面 dock 是独立 webview,页面里没有任何脚本订阅事件或调用 `login_set` | **已收窄** + 测试;文档同步 |
| A4 | P3 安全(仅测试包) | 安卓 debug 包的 `DEBUG_EVAL` 是 `RECEIVER_EXPORTED` 的广播接收器,设备上任意 App 都能在 arena 页面里执行任意 JS | 补丁见 §6.4(Kotlin) |
| A5 | P4 健壮 | `on_token` 对并发查询没有上限;`poll_trace_loop` 先 `r.text()` 读完整个响应再检查 4 MB | 补丁见 §6.2 / §6.3 |
| A6 | P4 健壮 | `store_set` 的 value 无大小上限,安卓页面脚本可把 store 文件撑大(每次 set 全量落盘) | 补丁见 §6.5 |
| A7 | P3 健壮 / 供应链 | `Cargo.lock` 被 `.gitignore` 忽略:应用 crate 不锁依赖,CI 每次解析最新次版本,构建不可复现 | 建议提交 `Cargo.lock`(§4.2) |
| A8 | 功能 | `npm test`(`node --test tests/`)在 Node 22 上直接失败(目录形式不再支持),与 CI 的 glob 命令不一致 | **已修复** |
| A9 | 文档 | `DEVELOPMENT.md` 仍写 `fetch_trace` / `arenakit://models`、「7 个命令」、旧的 `login` 阶段名、"0.5.1 起下线";§7 表缺 `gist_*` | **已更正** |
| A10 | 设计限制 | 安卓单 webview 内页面脚本可劫持 `__TAURI_INTERNALS__` / 伪造 `probe-result` / `account-result` / 改写非凭据键——与 AUDIT §5 同一上限 | 记录(§7) |

## 1. 复核 `docs/AUDIT.md` 的 24 项

| # | AUDIT 项 | 核实结果 |
|---|---|---|
| 1 | `proxy_get` 白名单绕过 | ✅ `proxy_target`:仅 https、无 userinfo、端口 443、`PROXY_HOSTS` 精确或子域匹配;重定向 ≤3 次且每跳重新校验 |
| 2 | `plus.js` / `leaderboard.js` 的 `chrome.*` | ✅ `plus.js` 以 `(function (chrome) {…})(window.__AK_CHROME__)` 运行;`leaderboard.js` 已删除。注:`chrome.runtime.getURL('icons/icon128.png')` 在 shim 里没有对应项,返回 `''`——只影响(默认关闭的)Battle 通知图标,无害 |
| 3 | 桌面页面可读已保存会话 | ✅ `arena.json` 无任何 `allow-store-*`(测试 `capabilities: the remote arena.ai page stays narrow` 守着) |
| 4 | 桌面任意 scheme 交给 `open` | ✅ `links::is_desktop_openable`(http/https/mailto/tel/sms);`open_external` 单参数、不经 shell |
| 5 | store 文件 0644 | ✅ `write_private` 以 0600 创建临时文件再 rename(rename 失败的回退路径会保留旧文件的权限位——仅老文件、极端情况) |
| 6 | `proxy_get` 状态码 / 重定向 / 大小 / client | ✅ `read_capped` 8 MiB、`Policy::custom` ≤3 跳且每跳重校验、`proxy_client()` 复用、15 s 超时 |
| 7 | `Store::set` 锁外写盘 | ✅ 写盘在 `MutexGuard` 内 |
| 8 | 头像 URL 进 CSS `url()` | ✅ `avatarStyle`:`^https://[^\s"'()\\]+$` + `esc` |
| 9 | `svgHtml` 未清洗 | ✅ `sanitizeSvg`(DOMParser、去 `script/foreignObject/iframe/object/embed`、去 `on*` / `javascript:`)。可再补:`<style>`、`<use href>`、`<a href>` 目前放行——SVG 内 `<a>` 不会执行脚本,`<style>` 只影响 manager 面板内部,接受 |
| 10 | dock 不可达分支 | ✅ `dock.js:559` 致命错误时更新副标题 |
| 11 | CI 顶层 `contents: write` | ✅ 顶层 `contents: read`,仅 `release` job 提权 |
| 12 | 死代码 / 依赖 / 路径 | ✅ 未再发现 `pulse.rs`、`hud.js`、`leaderboard.js`;`Cargo.toml` 无多余依赖;测试 `Cargo.toml only lists the plugins lib.rs registers` |
| 13 | 管理员 token 落盘 | ✅ 测试守着 `settings.adminToken` 不写、加载时删除 |
| 14 | 远程 `patterns` ReDoS | ✅ `compileRemotePattern`(≤200 字符、无反向引用、无嵌套量词)+ 测试 |
| 15 | `"__done__"` 哨兵 / generation 只增 | ✅ `enum Poll`、`counter` 全局递增、`release_generation` |
| 16 | `leaderboard.js` 下线 | ✅ 文件、注入项、README 均已移除 |
| 17 | 安卓凭据键守卫 | ✅ `DockGuard` 32 字节 `/dev/urandom`;`store_access_ok`:非凭据键放行、`dock` 标签放行、否则比对令牌;`store_keys` 过滤。残余同 AUDIT §5(§7) |
| 18 | Gist token 在 `localStorage` | ✅ `secret.gistToken` 在 Rust;页面只有 `gist_token_set / status / request`;`manager.js` 有 `migrateGistToken` 迁移旧值 |
| 19 | dock `csp: null` | ✅ 严格 CSP 已配置(`script-src 'self'`、`connect-src ipc: http://ipc.localhost`),测试守着;**仍需真机确认** dock 正常(AUDIT 自述) |
| 20 | `host_and_path` 手写解析 | ✅ `tauri::Url` 解析 + 回归测试(`https://user:pw@auth.arena.ai/…`、`\\`、`#@`) |
| 21 | `allowBackup` | ✅ `scripts/patch-android-manifest.mjs` + CI 调用 + 测试;**仍需真机确认**(反编译 APK 看清单) |
| 22 | `api.github.com` 无 UA | ✅ `proxy_client()` 设 `ArenaKit/<version>` |
| 23 | `toast()` innerHTML / 轮次号 | ✅ `toast` 用 `textContent`;dock `R${esc(e.turn)}` |
| 24 | 许可声明 | ✅ `THIRD_PARTY_NOTICES.md`、`vendor/UPSTREAM.md` 存在 |

结论:24/24 落地;#19、#21 与 AUDIT 一样标记为「需真机确认」。

## 2. 安全新发现

### 2.1 A1 · P2 —— 第三方远程配置进 `innerHTML`(`injected/manager.js`)

**路径。** `manager.js` 在每次页面加载时自动 `loadRemoteConfig()`:经 `proxy_get`(白名单 `raw.githubusercontent.com`)拉取 `JimAchievo/Arena-Manager` 仓库 `main` 分支的 `company-rules.json`,其 `COMPANY_RULES[].icon` / `company` 被原样保存;`getOrgLogoHtml()` 直接 `return rule.icon` / `return fallbackIcon`,调用处(卡片、侧栏、详情)都是模板字符串 → `innerHTML`。`icon` 若是 `<img src=x onerror=…>` 就会在 **arena.ai 页面上下文**执行。「推荐配置」(`recommended-config.json`,用户点一下才拉)同样把远程模型名 / 分组名未转义拼进差异弹窗(`showDiffModal` 的 `trunc()` / `groups.join`),应用后 `icon` 还会写进本地模型数据,以后每次渲染都触发。上游脚本已有 `compileRemotePattern`(AUDIT #14)和 `sanitizeSvg`(#9)守住了 `patterns` 与 `svgHtml`,但漏了这两个字符串。

**为什么在 ArenaKit 里比在浏览器里严重。** 一旦在 arena 页面里拿到执行权,攻击者得到的不只是 arena 会话(Cookie、`document.cookie` 可读的 Supabase 会话),还有整套页面侧 IPC:`on_token` / `proxy_get` / `gist_request`(用用户的 GitHub token 写 Gist,见 2.2)/ 安卓上的 `store_set` 与内嵌 dock 的 DOM。触发条件是上游仓库被投毒或维护者作恶——概率低、影响高,定 P2。

**修复(已落盘)。**
- `DataManager.plainRemoteText(v, max)`:只接受无 `<>&"'`、无控制字符、≤max 的短文本;`loadRemoteConfig` 用它清洗 `company`(≤64)与 `icon`(≤8,否则 `❔`),没有可用 `company` 的规则丢弃;
- `getOrgLogoHtml` 在 sink 处对 `rule.icon` / `fallbackIcon` / 缓存 logo 的 `src` 一律 `esc()`(图标只可能是 emoji / 短文本,从不需要是标记);`esc()` 改为 `String(s)`,非字符串不再抛错,`null` 不再渲染成 `"null"`;
- `showDiffModal` 的 `trunc()` 转义每个名字,分组名改走同一函数;分组页签 `data-mode="group_${this.esc(name)}"`;
- 回归测试:`tests/compat-and-capabilities.test.mjs` → `manager.js: remote config strings are plain text and icons are escaped at the innerHTML sink`。

### 2.2 A2 · P3 —— `gist_request` 是页面可用的「以用户身份写 Gist」入口(`lib.rs`)

`gist_url` 允许 `POST /gists`(无 id)、`GET|PATCH /gists/{id}`。token 存在 Rust 里页面读不到,这一点没问题;但 `arena.json` / `arena-mobile.json` 都给了页面 `allow-gist-request`,于是 arena.ai 上**任何**脚本(站方 JS、第三方分析脚本、上面 2.1 那样的注入)都可以在用户配置过 Gist 同步后,用用户的 token 建任意内容、任意数量、`public:true` 的 Gist,或 PATCH 用户已有 gist id(id 猜不到,但页面能从 manager 的 `localStorage` 设置里读到 `settings.gistId`)。这是把 GitHub token 的能力(`gist` scope)整体借给了页面。

`manager.js` 自己只做三种请求:`POST` 建 **secret** gist,文件名固定 `arena-manager-data.json`;`PATCH` 同名文件;`GET`。Rust 侧可以把请求形状钉死而不影响功能——补丁见 §6.1:body 必须是对象、强制 `public=false`、`files` 键只允许 `[A-Za-z0-9._-]{1,64}`(或直接只允许 `arena-manager-data.json`)、≤16 个文件。这不能阻止页面用用户 token 覆盖用户自己的备份(同源上限),但堵住了「公开发布 / 垃圾 gist」这一类越权。

### 2.3 A3 · P3 —— 桌面远程页面的多余授权(已收窄)

`capabilities/arena.json`(`windows:["main"]`,桌面)原本授予 `core:event:allow-listen`、`core:event:allow-unlisten`、`allow-login-set`。核实:

- 桌面永远 `build_init_script(None, "desktop", "")`——dock 不内嵌;`grep` 全部注入脚本与 `src/`,只有 dock(`src/dock.js` / 安卓的 `dock-embedded.gen.js`)调用 `listen()`;
- `login_set` 只在 `src/lib/account-flow.js`(dock)里调用;页面侧 `account.js` 只调 `login_clear`。

多余的 `login_set` 意味着 arena 页面脚本可以给 Rust 塞一个 `{email}` 目标,让 `on_page_load` 在之后 10 分钟内每次加载(含 accounts.google.com)都 `eval` `__AK_LOGIN_APPLY__`,`account.js` 随即 `clearAuth()`(把用户登出)并跳到 Google 登录、在账号选择页自动点「继续」。页面自己也能清 Cookie 跳转,所以不算新增能力,但它把影响延伸到了 Google 域(那里页面本没有 IPC)。多余的 `listen` 则让页面能订阅 `arenakit://page`(含 `account` 快照——虽然都是页面自己发的)。

已改:`arena.json` 只剩 `on_token` `page_event` `proxy_get` `gist_*`×3 `open_tab` `login_clear`;`arena-mobile.json`(dock 内嵌)不变;`default.json` 保留 `login_set`。新增测试 `desktop arena.json grants the page no event subscription and no login_set`。**需要一次桌面运行确认**:账号页「一键重新登录」、探针、账号切换仍正常(理论上不受影响,因为这些都由 dock webview 发起)。

进一步(未做,§6.6):Rust 侧 `emit()` 是全局广播,可改成 `emit_to(dock 标签)`,桌面上页面即便有 listen 权限也收不到。

### 2.4 A4 · P3(仅 debug 包)—— `DEBUG_EVAL` 广播接收器对外导出(`DebugHooks.kt`)

`ContextCompat.registerReceiver(..., RECEIVER_EXPORTED)` 且无权限保护:同一设备上的任意 App 发一条 `com.ati.arenakit.DEBUG_EVAL` 广播就能在 arena 页面里执行任意 JS(读 Cookie、调 IPC),结果还会写到外部存储 `debug-<id>.json`。只在 `arenakit.debug` 清单标记存在时安装(CI 只给 `debug-*` 标签 / `android_debug` 派发加),`build-<n>` 正式包没有——所以只影响拿 debug 包日常使用的人。补丁见 §6.4:要求广播带上启动时打印到 logcat 的一次性 nonce(adb 使用者能看到,别的 App 看不到),并把结果文件放进应用私有目录。

### 2.5 A5 · P4 —— `on_token` 无并发上限、trace 响应全量读取

- `on_token` 只用 `last_token` 去重「上一枚」令牌;每枚新令牌都会 `spawn` 一个最多 8 次请求的轮询。令牌无签名校验(设计如此,Trigger.dev 在 GET 时校验),页面脚本可以随意铸造 `pub:true` 的 JWT,以不同 `sessionId` 触发 N 个并发循环——把应用当成对 `api.trigger.dev` 的小型放大器。补丁 §6.2:在 `TraceState` 里维护进行中计数,超过 8 个直接拒绝。
- `poll_trace_loop` 用 `r.text().await` 读完整个 body 后才比较 4 MB;`read_capped` 已经存在,直接复用即可(§6.3)。

### 2.6 A6 · P4 —— `store_set` 无 value 上限(`store.rs`)

键长 ≤256 有检查,value 没有;每次 `set` 都把整个 store 序列化落盘。安卓上页面脚本可写非凭据键,持续写大 value 会拖慢每次落盘并占满存储。补丁 §6.5:`store_set` 拒绝序列化后 > 4 MiB 的 value。

### 2.7 其它核对过、无需改动的点

- `trace.rs`:token ≤16 KB、`run_id` 仅 `run_` + 字母数字(拼进 URL 路径安全)、`exp` 留 5 s 余量、`aud` 三态、session scope 校验——与 `bridge.js` / `conversation-rename.js` / `probe.js` 的 `[a-zA-Z0-9-]{1,128}` 会话 id 规则一致。
- `links.rs` / `links.js` 两份路由表逐项一致(域名、认证主机、`intent:` 处理);`ExternalLinks.open` 清空 `component` / `selector` 并加 `BROWSABLE`,`intent:` 只允许 `browser_fallback_url` 的 http(s) 回退。
- 链接页 WebView:`allowFileAccess=false`、`allowContentAccess=false`、无多窗口;`ArenaKitAndroid` 现代通道限 `https://arena.ai` / `https://*.arena.ai`,旧 `JavascriptInterface` 只接受打开 URL 类命令。
- 桌面 `tab-N` 窗口无 init 脚本、无 capability(`invoke` 一律被 ACL 拒绝)。
- `account.js`:`restore` 只接受 `isAuthName` 且 `validValue`(≤8192、无 `;`/控制字符)的 Cookie;`navigateTo` 只允许同源路径;Google 页面上不代填任何密码 / 验证码,只点「继续」/ 选择目标邮箱行。快照(含 refresh_token)只经 `page_event` 到 dock,持久化在 0600 的 store——与 AUDIT §5 结论相同。
- `page-actions.js` 所有 eval 字符串经 `jsString`(JSON + U+2028/9 + `</script`)构造;`rpc.js` 的 `reqId` 是顺序号,页面可伪造应答——但页面本来就是应答方,同源上限。
- `pulse.js` / `probe.js` 对 `/api/**` 只有 GET(`/api/me/pulse`、`/api/coding/github/connection|repos`);全仓唯一的写请求是 `manager.js` 维护者专用的「上传推荐配置」(`PUT api.github.com/repos/...`,用当场输入的 token,不落盘)。
- `unlock.js` 的重写保长度、只碰 `text/x-component`,出错透传;`snoop.js` 的 `fetch` 包装保留 `url` / `redirected`。
- `gm-shim.js` 在登录域也会运行(定义 `GM_*` 全局)——无害,可选地加上 arena 域门控。

## 3. 功能对照文档(§3 不变量 / §7 契约)

| 不变量 / 契约 | 位置 | 结果 |
|---|---|---|
| 只在探针命中后重命名 | `probe-runner.js` draw/findAll → `rename` 仅在 `hit` 后;`conversation-rename.js` 走站内 ⋯ 菜单 | ✅ |
| 清理正则 `^\s*\d{1,4}\s*[+\-*/×÷]\s*\d{1,4}\s*=\s*$` | `probe-logic.js:96`、`probe.js:31`(两处同一正则) | ✅ |
| `isAgentLabel=/^Agent(\s+Mode)?\b/i`,不写死 "Agent Mode" | `probe.js:106`;选项匹配用 `/agent\s*mode/i` | ✅ |
| `sessionFromUrl` 与 Rust 锁步 | 0.5.0 的 Rust 不再解析流 URL(仅 Trigger.dev 轮询);`snoop.js` 与扩展 `core.js` 锁步;会话 id 字符集与 `valid_session_id` 一致 | ✅(文档措辞可更新) |
| 先等侧栏链接再宣布「无可清理」 | `probe.js sidebarList`:`waitFor(collectSidebar().length>0, 6000)` 后 `loadAllSidebar()` | ✅ |
| 默认 5 轮;命中 / 连续 3 次失败 / 不可跳过失败即停 | `dock.js:991` 默认 5(1–100);`MAX_CONSECUTIVE_FAILURES=3`;`send()` 在非 Agent 模式拒绝发送 | ✅ |
| 令牌只读,不写 `/api/**` | 见 2.7 | ✅ |
| §7 命令表 | 实际页面命令 8 个(桌面)/ 12 个(安卓,含 `store_*` 与 `login_set`),文档写「7 个」且缺 `gist_*` 三行 | 已更正 |
| §7 `login` 阶段名 | 代码:`arena-google|arena-add|arena-retry|arena-waiting|user-active|…`;文档仍是 0.4.9 的 `arena-open|arena-agree|arena-google-direct` | 已更正;dock 侧 `dock.js:1523-1526` 用的是新名字,功能无误 |
| M3 描述 | `fetch_trace` / `arenakit://models` 早已改为 `on_token` / `arenakit://trace` | 已更正 |
| 版本号 | `DEVELOPMENT.md` 写 "0.5.1 起 leaderboard.js 已下线",而版本是 0.5.0 | 已更正 |

## 4. 健壮性 / 冗余 / CI

### 4.1 已修

- **`npm test` 失效**:`package.json` 的 `node --test tests/` 在 Node 22 报 `Cannot find module …/tests`(目录参数不再被接受),而 CI 用的是 `node --test 'tests/**/*.test.mjs'`。已统一为 glob。
- 文档漂移见 §3。

### 4.2 建议(未做)

- **提交 `Cargo.lock`**:`.gitignore` 第 4 行忽略了它。这是应用而非库,Cargo 官方建议锁定;不锁的后果是 CI 每次解析最新的 `tauri 2.x` / `reqwest` / `tokio` 次版本,一次上游发布就可能让 `rust-test` 红掉或悄悄改变行为(供应链角度也差)。在有 `cargo` 的机器上 `cargo generate-lockfile`(或直接把当前构建产生的 lock 提交)并从 `.gitignore` 移除。
- **看门狗自动刷新不看草稿**:`requestReload('watchdog')` 不确认编辑框里是否有未发送文本;回复出错时用户很可能正在打字。建议自动刷新前经 `page-actions` 问一下页面(`probe.js` 已有 `composer()`),有草稿则只做 `NAG`(提示手动刷新)。参考应用行为如此,归为改进而非缺陷。
- `Store::persist` 的 rename 失败回退会直接写入已有文件——老版本留下的 0644 文件不会被改成 0600;可在回退分支先 `remove_file` 再 `write_private`。
- `random_token()` 在没有 `/dev/urandom` 的平台退化为 `RandomState` 混合——目前只有安卓用到令牌,安卓一定有 urandom;若日后 Windows 也内嵌 dock,应改用 `getrandom`。
- 调试签名密钥(`.github/android/debug.keystore`,口令 `android`)公开:任何人都能生成同签名、更高 `versionCode` 的 APK 覆盖安装正式包(AUDIT #24 已声明)。正式分发前必须换成 secrets 里的私钥。
- `unlock.js` 依赖 Next.js `__next_f` 与 `disable-opus` 字段(DEVELOPMENT §6 已列):建议加一个「重写命中计数」上报,失效时 dock 能提示,而不是静默透传。

### 4.3 冗余核查

- `src/embed/dock-embedded.gen.js` / `assets.gen.js` 与源一致(`bundle-dock --check` 通过);
- `tests/` 33 个文件 263 条全部有效;无孤儿脚本;`vendor/UPSTREAM.md` 与 `injected/` 一致;
- `gm-shim.js` 的 `GM_registerMenuCommand` 只是入注册表(`__AK_MENU__`),没有 UI 消费——是无害的存根,可保留。

## 5. 本次改动清单(已在工作树中,JS 263/263 通过)

| 文件 | 改动 |
|---|---|
| `injected/manager.js` | A1:`plainRemoteText`、`loadRemoteConfig` 清洗、`getOrgLogoHtml` sink 转义、`esc()` 容错、`showDiffModal` / 分组页签转义 |
| `src-tauri/capabilities/arena.json` | A3:移除 `core:event:allow-listen/unlisten`、`allow-login-set`;描述更新 |
| `package.json` | A8:`scripts.test` → `node --test "tests/**/*.test.mjs"` |
| `tests/compat-and-capabilities.test.mjs` | 新增 2 条回归测试(A1、A3) |
| `docs/DEVELOPMENT.md` | A9:M2 版本号、M3 命令 / 事件名、§7 表补 `gist_*`、`login_set` 授权范围、capability 段、`login` 阶段名 |
| `docs/ARCHITECTURE.md` | A3 对应的一句 |
| `docs/AUDIT-2.md` | 本报告 |

验证:

```bash
npm test                              # 263 pass
node scripts/check-syntax.mjs         # 全部 ok
node scripts/bundle-dock.mjs --check  # up to date
# 桌面 / 安卓真机:账号页「一键重新登录」「切换账号」、探针、Manager 面板(分组页签、推荐配置差异弹窗)
```

## 6. 未落盘的补丁(Rust / Kotlin,未编译验证)

### 6.1 `gist_request` 请求形状(A2,`src-tauri/src/lib.rs`)

```rust
/// Only the request shapes Arena Manager's Gist sync makes. A body must be an
/// object, is never `public: true` (the token must not become a "publish a
/// gist under this account" oracle for page scripts) and `files` carries plain
/// file names only.
fn vet_gist_body(body: &mut Value) -> Result<(), String> {
    let obj = body.as_object_mut().ok_or_else(|| "Gist 请求体必须是对象".to_string())?;
    obj.insert("public".into(), Value::Bool(false));
    if let Some(files) = obj.get("files") {
        let files = files.as_object().ok_or_else(|| "Gist files 无效".to_string())?;
        let name_ok = |k: &String| {
            !k.is_empty()
                && k.len() <= 64
                && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        };
        if files.len() > 16 || !files.keys().all(name_ok) {
            return Err("Gist 文件名无效".into());
        }
    }
    Ok(())
}
```

`gist_request` 中:

```rust
    if let Some(mut b) = body {
        vet_gist_body(&mut b)?;
        let text = serde_json::to_string(&b).map_err(|e| e.to_string())?;
        if text.len() > GIST_MAX_BODY {
            return Err("请求体过大".into());
        }
        req = req.header("Content-Type", "application/json").body(text);
    }
```

单测(放进 `mod tests`):

```rust
    #[test]
    fn gist_bodies_are_private_and_plainly_named() {
        let mut b = json!({"public": true, "files": {"arena-manager-data.json": {"content": "{}"}}});
        vet_gist_body(&mut b).unwrap();
        assert_eq!(b["public"], json!(false));
        for bad in [json!([]), json!({"files": {"../x": {}}}), json!({"files": {"a b.json": {}}}), json!({"files": "x"})] {
            let mut v = bad;
            assert!(vet_gist_body(&mut v).is_err());
        }
    }
```

更严格的可选项:`files` 只允许 `arena-manager-data.json`(`manager.js` 两处都用这个常量)。

### 6.2 `on_token` 并发上限(A5)

```rust
const TRACE_MAX_INFLIGHT: usize = 8;

#[derive(Default)]
pub struct TraceState {
    // …既有字段…
    inflight: std::sync::atomic::AtomicUsize,
}
```

`on_token` 在 `validate_token` 通过之后、`spawn` 之前:

```rust
    if state.inflight.load(Ordering::Relaxed) >= TRACE_MAX_INFLIGHT {
        forget_token(&app, &token);
        return Err("同时进行的 trace 查询过多".into());
    }
    state.inflight.fetch_add(1, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        poll_trace(app.clone(), token, session_id, claims, generation).await;
        app.state::<TraceState>().inflight.fetch_sub(1, Ordering::Relaxed);
    });
```

(`poll_trace` 所有返回路径都会回到这里,计数一定归还。)

### 6.3 trace 响应流式限量(A5)

`poll_trace_loop` 里把

```rust
                    match r.text().await {
                        Err(_) => Ok(Poll::Continue(retry("trace 读取失败"))),
                        Ok(text) if text.len() > 4 * 1024 * 1024 => {
                            Err((true, "trace 超过 4 MB，停止解析".into()))
                        }
                        Ok(text) => …
```

改为复用 `read_capped`(把上限做成参数):

```rust
async fn read_capped_to(mut resp: reqwest::Response, max: usize) -> Result<String, String> { /* 现 read_capped 主体,PROXY_MAX_BYTES → max */ }
async fn read_capped(resp: reqwest::Response) -> Result<String, String> { read_capped_to(resp, PROXY_MAX_BYTES).await }
…
                    match read_capped_to(r, 4 * 1024 * 1024).await {
                        Err(e) if e == "响应过大" => Err((true, "trace 超过 4 MB，停止解析".into())),
                        Err(_) => Ok(Poll::Continue(retry("trace 读取失败"))),
                        Ok(text) => match serde_json::from_str::<Value>(&text) { … },
                    }
```

### 6.4 `DebugHooks` 加一次性 nonce(A4,`DebugHooks.kt`)

```kotlin
object DebugHooks {
  private val nonce: String by lazy {
    val b = ByteArray(16); java.security.SecureRandom().nextBytes(b)
    b.joinToString("") { "%02x".format(it) }
  }
  fun install(activity: Activity, webView: WebView): BroadcastReceiver {
    Log.i(TAG, "DEBUG_EVAL nonce=$nonce  (pass as --es nonce <value>)")
    …
      override fun onReceive(context: Context, intent: Intent) {
        if (intent.getStringExtra("nonce") != nonce) { Log.w(TAG, "DEBUG_EVAL: bad nonce, ignored"); return }
        …
```

并把 `File(context.getExternalFilesDir(null), …)` 改为 `context.filesDir`(`adb shell run-as com.ati.arenakit cat files/debug-<id>.json` 仍可读)。用 `adb logcat -s ArenaKitDebug` 拿到 nonce 后使用;其它 App 读不到 logcat,也就发不出有效广播。

### 6.5 `store_set` value 上限(A6,`store.rs`)

```rust
const STORE_MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
…
    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        if key.is_empty() || key.len() > 256 {
            return Err("store key 无效".into());
        }
        if !value.is_null() {
            let n = serde_json::to_vec(&value).map_err(|e| e.to_string())?.len();
            if n > STORE_MAX_VALUE_BYTES {
                return Err("store value 过大".into());
            }
        }
        …
```

### 6.6 事件定向发送(可选,§2.3)

`emit_trace` / `page_event` / `menu.rs` 里的 `app.emit(...)` 改为 `app.emit_to(tauri::EventTarget::labeled(dock_label()), ...)`,其中 `dock_label()` 在桌面返回 `"dock"`,移动端返回 `"arena"`。桌面上即使页面有事件权限也收不到 dock 专属事件;安卓不变。

## 7. 残余风险(与 AUDIT §5 相同的边界,记录以免重复审计)

- **安卓单 webview 的同源上限**:页面脚本可劫持 `__TAURI_INTERNALS__.invoke` / `window.ipc.postMessage` 截获 dock 的调用参数(含启动令牌),可伪造 `probe-result` / `account-result`,可改写非凭据键(`prefs` 等)间接影响 dock 行为,可直接操作 shadow root 里的 dock。根治只有把 dock 放进独立 webview(需 Tauri 移动端支持多 webview)。桌面无此问题。
- **无签名校验的 Trigger.dev 令牌**:设计如此,后果只是多余的失败请求(6.2 限量)。
- **仍需真机确认**:AUDIT #19(dock CSP)、#21(`allowBackup`)、以及本轮 A3(桌面 capability 收窄后账号 / 探针流程)。
- **公开的 debug 签名密钥**、`Cargo.lock` 未锁定:见 §4.2。
