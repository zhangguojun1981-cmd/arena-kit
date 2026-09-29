# ArenaKit 0.5.0 全量审计报告

> 审计对象:`build-45` / 0.5.0(`origin/arena/01a0ea41-arena-kit`,tip `08f4e60`)。
> 范围:`injected/`、`src/`(dock、`src/lib`、`src/embed`)、`src-tauri/`(Rust + capabilities + Kotlin)、`scripts/`、`tests/`、`.github/workflows/`、`docs/`、`vendor/`。
> 约 1.9 万行源码(不含 `*.gen.js` 与测试)。审计分支:`arena/01a0ea6b-arena-kit`(已合并 0.5.0)。

## 0. 结论

0.5.0 的整体质量明显高于 0.1.0:模块各自 `try/catch` 隔离、按域名门控注入(`__ARENAKIT_ON_ARENA__`)、远程 capability 很窄、链接路由与登录态有 TTL 和主机校验、CI 拆成 node-test / rust-test / 打 tag 才构建。审计没有发现需要推翻架构的问题,但找到 **1 个可被利用的安全漏洞、1 个整块功能失效、若干加固与冗余项**,均已修复并有回归测试。

| # | 级别 | 问题 | 状态 |
|---|------|------|------|
| 1 | **P1 安全** | `proxy_get` 域名白名单可绕过(SSRF) | 已修复 |
| 2 | **P1 功能** | `plus.js` / `leaderboard.js` 仍调用 `chrome.*`,「排行榜性价比列」整块不工作 | 已修复 |
| 3 | P2 安全 | 已保存账号的登录会话(刷新令牌)对 arena.ai 页面脚本可读 | 桌面端已修复;安卓为设计限制(见 §5) |
| 4 | P2 安全 | 桌面端把页面触发的任意 URL scheme 交给系统 `open` | 已修复 |
| 5 | P2 安全 | `arenakit-store.json` 明文会话文件权限 0644 | 已修复(0600) |
| 6 | P3 健壮 | `proxy_get` 不校验状态码 / 跟随任意重定向 / 无大小上限 / 每次新建 client | 已修复 |
| 7 | P3 健壮 | `Store::set` 在锁外写盘,并发时旧快照可能覆盖新快照 | 已修复 |
| 8 | P3 安全 | 头像 URL 拼进 CSS `url("…")`,`esc()` 挡不住 | 已修复 |
| 9 | P3 安全 | 分组 logo 的 `svgHtml`(页面抓取 / 远程配置)未清洗即 `innerHTML` | 已修复 |
| 10 | P3 逻辑 | `dock.js` 里一个永远走不到的分支(致命错误时模型副标题不更新) | 已修复 |
| 11 | P3 最小权限 | CI 顶层授予 `contents: write`,所有 job 继承 | 已修复 |
| 12 | 冗余 | 死代码 / 未使用依赖 / 未使用变量 / 文档泄露本机路径 | 已清理 |
| 13 | P3 安全 | 管理员 GitHub token 明文存进持久化设置 | 已修复(仅内存,旧值加载时清除) |
| 14 | P3 健壮 | 远程规则 `patterns` 直接 `new RegExp`(ReDoS 面) | 已修复(长度/数量/嵌套量词/反向引用检查) |
| 15 | P3 健壮 | `trace` 用字符串哨兵 `"__done__"`;`generation` 映射只增不减 | 已修复(`Poll` 枚举 + 全局递增计数 + 结束清理) |
| 16 | 功能诚实 | `leaderboard.js` 在 arena.ai 上不记录任何投票,README 却列为功能 | 已下线并更正文档 |

## 1. 发现与修复详情

### 1.1 P1 —— `proxy_get` 白名单绕过(`src-tauri/src/lib.rs`)

原实现用 `url.split('/').nth(2)` 取"主机"再 `ends_with(".arena.ai")`。`#`、`?`、`\` 在 WHATWG URL(`reqwest` 使用的解析器)里会终止 authority,所以下列地址通过检查,但请求实际发往攻击者主机:

```
https://evil.example#.arena.ai/        https://evil.example?.arena.ai/
https://evil.example\.arena.ai/        https://127.0.0.1:8080#.arena.ai/
```

这个命令自 0.5.0 起对 **arena.ai 页面上的任意脚本**开放(`capabilities/arena.json`),因此第三方脚本 / XSS 可借它探测本机与内网服务(SSRF)。同时,合法的 `arena.ai:443` 反而被拒。
我在 Node(同一 WHATWG 算法)中复现了全部 5 个绕过用例。

**修复**:改用真正的 URL 解析器(`proxy_target()`),要求 `https` + 解析后的 `host_str()` 命中白名单(精确或子域)+ 无用户名/密码 + 端口为空或 443;client 使用 `redirect::Policy::custom`,**每一跳重定向重新过白名单**(≤3 跳);非 2xx 返回错误(原来 404 页面会被当成数据,`GM_xmlhttpRequest` 收到"200");响应上限 8 MiB(先看 `Content-Length`,再流式累计);client 改为进程内复用(连接复用、避免每次 TLS 握手)。
新增 Rust 单测:`proxy_target_*` 三条(合法 6 个、绕过 8 个、其它 scheme/端口/垃圾输入 7 个)。这 21 个用例我用 Node `URL` 做了逻辑镜像验证。

### 1.2 P1 —— 「排行榜性价比列」整块失效(`injected/plus.js`)

两个脚本是浏览器扩展的移植,仍直接调用 `chrome.storage` / `chrome.runtime`,WebView 里没有 `chrome`:`plus.js` 的 `loadPreferences()` 报 warn 后继续,随后 `new TooltipManager()` 抛 `ReferenceError: chrome is not defined`(异步,所以模块级 `try/catch` 抓不到,是未处理的 Promise 拒绝),**一列都注入不了**;(`leaderboard.js` 同样受影响,后已下线,见 §1.6。)dock「更多」里的开关因此形同虚设。
在 jsdom 里按 `build_init_script` 的真实顺序执行 0.5.0 注入管线可复现;修复后注入 3 个自定义列、无未处理拒绝。

另外 `plus.js:750` 引用了未定义的 `COLUMN_TOOLTIPS`(eslint `no-undef`),表头悬浮提示会抛错。

**修复**:
- `gm-shim.js` 提供 `window.__AK_CHROME__`(`storage.sync/local` 基于 localStorage,Promise 与回调两种风格;`runtime.getURL` 返回内联 SVG data URL)。**不**在 `window` 上定义 `chrome`(否则页面会误以为运行在 Chrome 扩展里,还可被站点嗅探)。
- `plus.js` 改为 `(function (chrome) { … })(window.__AK_CHROME__)`,不需要改 Rust。
- `plus.js`:补上 `COLUMN_TOOLTIPS`;OpenRouter 价格请求只发一次(原来价格、上下文各请求一次);MutationObserver 回调用 `requestAnimationFrame` 合并;OpenRouter 返回的第三方文本进入 `innerHTML` 前转义;通知默认关闭(桌面 WebView 不应在用户没要求时弹权限申请)。
- `gm-shim.js`:`GM_xmlhttpRequest` **带 `headers` 的请求不再走无法转发请求头的原生代理**(原来带 `Authorization` 的 GitHub gist 请求会静默丢头);回调只触发一次(原来 `onload` 抛错会再进入 `onerror`)。

### 1.3 P2 —— 已保存账号的会话对页面脚本可读

`accounts` 键里保存着每个账号的会话 Cookie(含 Supabase 刷新令牌)。`capabilities/arena.json` 授予了 `store_get/set/keys` 且**没有键名限制**,于是 arena.ai 页面里的任何脚本(第三方统计、XSS)都能读走全部已保存账号,或用 `store_set` 覆盖 `accounts` 植入自己的会话。
桌面端页面侧没有任何代码调用 `store_*`(dock 是独立 webview,用 `default.json`),所以**直接从 `arena.json` 移除这三项权限**,功能不受影响。安卓的 dock 内嵌在页面里,需要这三项,见 §5。
`tests/compat-and-capabilities.test.mjs` 固化了这条约束。

### 1.4 P2 —— 桌面端把任意 scheme 交给系统(`lib.rs::open_external`)

`Route::ExternalApp` 在桌面端会把 `smb:` / `ssh:` / `vnc:` / Windows 的 `ms-msdt:` 之类交给 `open` / `FileProtocolHandler`,页面里一个重定向就能拉起注册了该 scheme 的程序。新增 `links::is_desktop_openable()`:桌面只放行 `http(s)` 和 `mailto:` / `tel:` / `sms:`。安卓路径不变(Kotlin 一侧已是 `BROWSABLE`-only 且清空 component/selector)。

### 1.5 其它加固

- **`store.rs`**:写盘移到锁内(此前先克隆整个 Map、放锁、再写文件;两次并发 `set` 会共用同一个 `.tmp` 且可能乱序落盘,目前只是因为同步命令跑在主线程才碰巧安全);序列化直接借用 `&Map`,少一次整表克隆;文件以 `0600` 创建(`write_private`)。
- **`dock.js` 头像**:`esc()` 转成 `&quot;` 后,浏览器在解析 CSS 前会把它还原,能跳出 `url("…")`(CSS 注入 / 追踪)。新增 `avatarStyle()`,仅接受不含引号/括号/反斜杠的 `https` URL;无效头像回退成首字母。
- **`manager.js` svgHtml**:新增 `sanitizeSvg()`(DOM 解析后移除 `script/foreignObject/iframe/object/embed`、`on*` 属性、`javascript:` 值,并缓存)。刻意**保留** `<style>` 与 `data:` 图片,避免品牌 logo 显示回退。在 jsdom 中验证了恶意样例被清除、正常 logo 原样保留。
- **`dock.js` 死分支**:`else if (p.stage === 'error' && p.fatal)` 被前面的 `else if (p.stage === 'error')` 覆盖(eslint `no-dupe-else-if`)。按原意把「致命错误时副标题显示错误文本」并入前一分支。
- **CI**:顶层权限改为 `contents: read`,仅 `release` job 声明 `contents: write`。

### 1.6 第二轮修复(按本报告 §5 建议)

- **管理员 token**(`manager.js`):`adminToken` 不再写入持久化设置,只保存在内存(重新打开页面需重填);加载时 `delete` 旧版本已落盘的值。导出本来就排除它。`gistToken`(Gist 同步功能需要持久化)保持不变,见 §5。
- **远程规则正则**:新增 `compileRemotePattern()`——单条 ≤200 字符、每条规则 ≤20 个 pattern、规则总数 ≤500、拒绝反向引用与"重复的、内部又含量词的分组"(`(a+)+` 一类),非法者丢弃而不是让整份远程配置失败。内置的 94 条正则全部通过自检(测试固化),典型 ReDoS 写法均被拒。
- **`lib.rs` trace 轮询**:`Ok("__done__")` 哨兵换成 `enum Poll { Done, Continue(String) }`,类型系统保证不会与状态文本混淆。`TraceState.generation` 原为"每会话 +1",若直接清理条目会让新查询复用编号、被仍在 sleep 的旧轮询误判为存活(僵尸重复轮询),所以先改成**全局递增、永不复用**的计数器,再在轮询结束后 `release_generation`(仅当条目仍归自己所有)。
- **下线 `leaderboard.js`**:上游只适配旧域名,arena.ai 上 `getModelNames()` 恒为空,不会记录任何投票。我不知道 arena.ai 当前的 DOM 选择器,不能凭猜测补;已删除脚本与 Rust 注入项,README / 文档如实标注,`vendor/UPSTREAM.md` 保留来源记录。

## 2. 冗余 / 废旧代码(均无行为变化)

| 位置 | 处理 |
|------|------|
| `src-tauri/src/pulse.rs` | 整个模块无调用者(自述"仅保留阈值")。删除并同步 `docs/`;页面侧 `injected/pulse.js`、`src/lib/pulse.js` 才是实现 |
| `tauri-plugin-http` 依赖 + `.plugin(...)` + `http:default` | 没有任何 JS 使用 `plugin:http`(全仓 grep),却给 dock 授权。移除;`Cargo.lock` 未入库,不影响 |
| `manager.js` `VIEW_MODES`、`probe.js` `exact`、`bundle-dock.mjs` `toId`、测试里的 `h` | 未使用变量,删除 |
| `vendor/UPSTREAM.md` | 去掉个人本机绝对路径(`/Users/…`) |
| `Cargo.toml` | `[dev-dependencies]` 下的失效注释更新 |

## 3. 已核对、无需改动(避免误改)

- 每个注入模块独立 `guarded()`;域名门控;`arena_command` 只给 dock;`on_navigation` 走 `links.rs` 路由;`LoginState` 有 TTL + 主机校验。
- `links.rs` 里手写的 `host_and_path` 只会拿到 `tauri::Url::as_str()` 的规范化串(`\` 已被换成 `/`),所以不受 `evil.com\@arena.ai` 类写法影响;`open_tab` 命令另有 `is_web_url` 与长度上限。
- 安卓 `LinkTab.kt` / `MainActivity.kt`:页面桥只接受 arena 域的 `WebMessageListener`,旧接口仅暴露"开链接"命令并有 16 KiB 上限;外部启动清空 component/selector、只允许 `BROWSABLE`。
- `dock.js` 的 `innerHTML` 全部经过 `esc()`(除上面的头像),数字字段来自本地记录。
- eslint 剩余 6 条为**误报**:3 条 `no-control-regex`(有意剥离控制字符:`account.js`、`conversation-rename.js`、`rename.js`),2 条 `no-misleading-character-class`(有意剥离零宽连字符 `\u200d`),1 条 `ArenaProbeBridge`(已用 `typeof` 守卫)。

## 4. 性能

- `proxy_get`:共享 client(连接复用),body 流式受限。
- `Store::set`:去掉整表克隆。
- `plus.js`:OpenRouter 请求 2 次 → 1 次;DOM 变更回调按帧合并(此前每次 mutation 都同步扫描整张榜单)。
- `manager.js`:`sanitizeSvg` 结果缓存,列表重绘不重复解析。

## 5. 遗留风险与建议(未改动,需要决策 / 真机验证)

1. **安卓:登录会话仍对页面脚本可读**。dock 内嵌在 arena.ai 页面里,必须能 `store_get('accounts')`。要根治需要把会话存储移出页面可达的通道(例如 Rust 内部保存,dock 只拿账号元数据,切换时才由 Rust 下发 Cookie)。这是架构改动,且无法在没有真机的环境里验证,建议单独立项。
2. **会话明文落盘**(0.5.0 既定设计,`ARCHITECTURE.md` 已说明)。现在文件为 0600;更稳妥的做法是系统钥匙串(macOS Keychain / Android Keystore),同样需要真机验证。
3. **`gistToken`** 仍在页面 `localStorage`(`ak_gm_*`)里,与页面同源脚本可读。这是 Gist 同步功能的前提;若要收紧,应改为存 Rust 侧并由 `proxy_get` 之外的专用命令发起请求。管理员推送功能(连续点击 5 次进入)建议仅保留在独立构建里。
4. **`src-tauri/tauri.conf.json` 的 `csp` 为 null**。dock 是本地页且转义完整,但持有 `arena_command`。建议在真机验证后启用类似 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src ipc: http://ipc.localhost`;**本次未启用**——写错一项就会让整个 dock 在 macOS 上无法工作,而我没有可运行的 WKWebView 来验证。
5. **`links.rs::host_and_path`** 手写解析,当前因输入已被 `Url::as_str()` 规范化而安全;若将来有别的调用路径传入原始字符串,应改用 `Url`。
6. **`plus.js`**(GPLv3 上游)随应用分发的许可证问题见 `vendor/UPSTREAM.md`。

> 更正:本报告初版曾写"`eni.js` 默认开启的提示词含越狱风格内容"。核对 0.5.0 后**该结论不成立**——ENI 在 0.5.0 中默认关闭(`prefs.eniOn = false`,提示词默认为空,脚本头部亦注明),无需改动。

## 6. 验证

| 项目 | 结果 |
|------|------|
| `node scripts/check-syntax.mjs` | 通过 |
| `node scripts/bundle-dock.mjs` / `--check` | 已重新生成 `dock-embedded.gen.js`;`up to date` |
| `node --test 'tests/**/*.test.mjs'`(CI 同款命令) | **250 / 250 通过**(合并后基线 244,新增 `compat-and-capabilities.test.mjs` 8 条,并删除我旧版会与 0.5.0 冲突的 `injected.test.mjs`) |
| eslint(9,自建配置) | 从 18 条降到 6 条,剩余全部为 §3 所述误报 |
| jsdom 端到端跑 0.5.0 注入管线 | 修复前:`plus.js` 未处理拒绝、0 个自定义列;修复后:无拒绝、3 个列 |
| Rust | **本环境没有 Rust 工具链(且 crates.io 不可达),未能 `cargo check / test`**。已用 tree-sitter 对所有 `.rs` 做语法解析(全部通过),`proxy_target` 的判定逻辑用 Node `URL` 做了等价验证 |

**请在合并前跑一次 `cargo test --lib`(CI 的 `rust-test` job 会跑)**。本次 Rust 改动:`lib.rs`(`proxy_target` / `proxy_client` / `proxy_get` / `open_external`、`Poll` 枚举、`TraceState.counter` / `release_generation`、移除 leaderboard 注入)、`links.rs`(`is_desktop_openable`)、`store.rs`(锁内写盘、`write_private`)、删除 `pulse.rs`。`Poll` / `release_generation` 没有单测(需要 `AppHandle`),请特别留意 CI 的编译结果。其中使用的 API 均为稳定接口(`OnceLock`≥1.70、`Option::is_some_and`≥1.70,`rust-version = 1.77` 满足)。

## 7. 变更文件

`injected/{gm-shim,plus,manager,probe}.js`(删 `leaderboard.js`) · `src/dock.js`(+ 重新生成的 `src/embed/dock-embedded.gen.js`) · `src-tauri/src/{lib,links,store}.rs`(删 `pulse.rs`) · `src-tauri/{Cargo.toml,capabilities/arena.json,capabilities/default.json}` · `.github/workflows/build.yml` · `scripts/bundle-dock.mjs` · `tests/{compat-and-capabilities.test.mjs(新),probe-runner.test.mjs}` · `README.md` · `docs/{AUDIT,ARCHITECTURE,DEVELOPMENT}.md` · `vendor/UPSTREAM.md`
