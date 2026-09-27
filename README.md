# ArenaKit

一个跨平台(macOS + Android)的 **arena.ai 增强客户端**。把 arena.ai 网页封装进原生 WebView,并注入一组增强脚本 + 内建取证 HUD,一份代码同时产出 **`.dmg`** 和 **`.apk`**。

> 私有工具,仅供本人研究使用。含运行令牌截获逻辑,**只读、不改写服务端请求**。

## 它做什么

ArenaKit = 网页套壳(A) + 取证 HUD(B) + 提示词注入。整合了以下能力:

| 能力 | 来源 | 类别 |
|---|---|---|
| 模型筛选/分类/排序、70 厂商识别、分组、云同步 | [Arena-Manager](https://github.com/JimAchievo/Arena-Manager) | A 前端注入 |
| 解锁 Claude Opus 全系 + 150+ 隐藏/盲测模型 | [Model-Unlocker](https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension) | A 前端注入 |
| 排行榜"性价比"列、价格、模型年龄、模态图标 | [Arena.ai-Plus](https://github.com/chen-dahan/Arena.ai-Plus) | A 前端注入 |
| 个人投票胜负统计 | [personal-leaderboard](https://github.com/wrapss/lmarena-personal-leaderboard) | A 前端注入 |
| 每新对话自动注入系统提示词 | [Arena-Ai (ENI)](https://github.com/peyton2065/Arena-Ai) | 提示词注入 |
| **截获运行令牌 → 拉 trace → 显示服务端真实模型名** | [arena-trace-inspector](https://github.com/AI-modelsAPI/arena-trace-inspector) / [-android](https://github.com/AI-modelsAPI/arena-trace-android) | B 原生取证 |
| **回复监控**:每轮回复一个令牌 = 一轮;显示"第 N 轮 · 模型",同一会话内模型切换高亮,保留最近 6 轮 | [arena-trace-android](https://github.com/AI-modelsAPI/arena-trace-android) (TurnTracker) | B 原生取证 |
| **会话记忆**:切回某个对话时回放已识别模型 / 用量;新对话清空显示 | [arena-trace-android](https://github.com/AI-modelsAPI/arena-trace-android) (restoreModelForSession) | B 原生取证 |
| **使用额度(非百分比)**:trace 里的 Token 数与费用标签,本轮 + 本会话累计,只读原始标签不推算 | [arena-trace-inspector](https://github.com/AI-modelsAPI/arena-trace-inspector) (usage.js) | B 原生取证 |
| **额度百分比 + 三色进度条 + 重置倒计时** | [arena-trace-android](https://github.com/AI-modelsAPI/arena-trace-android) (pulse) | B 原生取证 |
| **自动探针 / 抽卡**:新建对话 → 发随机算式 → 读回模型 → 目标命中(别名 / 模糊 / `/正则/`)→ 改名 `前缀+模型名-NNN`;命中全部才停 / 命中即停 | [arena-trace-android](https://github.com/AI-modelsAPI/arena-trace-android) (ProbeController) ← auto-draw.js | C 自动化 |
| **自动清理**:侧栏算式标题(探针残留)逐个经 Arena 自己的 ⋯ 菜单归档,不删除、跳过当前对话、失败重试、结束复查 | 同上 | C 自动化 |
| **自动重命名**:识别后把对话改名为 `前缀+模型名`(每个对话一次);**快捷发送**:把设定文本发到当前对话(会话探针) | 同上 | C 自动化 |

完整链接、许可与克隆命令见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。

## 界面

一套**扁平、极简**的设计系统(`src/theme.css`),亮 / 暗两套主题(跟随系统或手动切换),无渐变无投影,单一强调色,全部用 CSS 变量驱动:

| 界面 | 位置 | 说明 |
|---|---|---|
| **壳 Shell** | 桌面端唯一的本地 WebView(`src/shell.html`),铺满窗口 | 顶部 44px 标签栏(每个 arena 页面一个标签,可单独关闭 / 切换 / 中键关闭)、首页(账号管理)、右侧 340px 侧栏 Dock |
| **首页 · 账号** | Shell 中间区域(没有激活标签时可见) | 应用**默认打开首页而不是 arena.ai**。添加 / 编辑账号(名称、代理节点、颜色、备注、测试代理),每个账号"打开 arena"→ 新标签;同一账号可开多页 |
| **arena 标签页** | 原生子 WebView,覆盖在 Shell 的中间区域 | 每个标签绑定一个账号:独立数据存储(Cookie / localStorage / IndexedDB 互不可见)+ 该账号的代理节点;`+` 按钮弹出原生菜单选择账号 |
| **侧栏 Dock** | Shell 右列 | 镜像**当前激活标签**:服务端模型(含最近记录、本轮 Token/费用)、回复监控(轮次 / 会话记忆 / 累计用量)、今日额度仪表、功能开关(含自动重命名)、自动探针 / 清理、快捷发送、提示词注入;后台标签的事件会缓存,切回时回放 |
| **页内 HUD** | 注入 arena.ai 页面的 Shadow DOM(`src/hud.js`) | 可拖动胶囊,点击展开模型 / 轮次 / 用量 / 额度卡片;移动端默认开启,并提供"首页"与"开始探针 / 停止 / 清理 / 快捷发送"(用首页保存的自动化设置) |
| **手机首页** | 同一个 `shell.html`,`data-mode="mobile"` | Android 启动页:"打开 Arena"按钮 + 功能说明;arena.ai 在同一个 WebView 里打开,HUD 里的"首页"回来 |
| **预览页** | `src/index.html` | 浏览器里无需 Tauri 即可审阅 Shell(首页 / 多标签)、亮 / 暗 Dock、手机首页与 HUD(`npm run preview`) |

### 多账号与代理节点

* 账号保存在应用配置目录的 `accounts.json`(macOS:`~/Library/Application Support/com.ati.arenakit/`),字段:名称、`proxy`(`http://host:port` 或 `socks5://host:port`,不支持带密码)、颜色、备注。
* **隔离**:macOS 14+ 用 `WKWebsiteDataStore(forIdentifier:)`,每个账号一份存储;Windows / Linux 用独立 `data_directory`。首次打开需登录一次,之后各自记住。
* **代理**:页面流量走该账号的节点;Rust 侧替页面发出的请求(trace 轮询、`proxy_get`)也走同一节点。macOS 14+ 与 Linux 为逐页面生效;Windows 的 WebView2 只认第一个(进程级)。
* **Android**:系统 WebView 只有一份 Cookie 存储且代理是进程级的,因此手机端是**单账号**;多账号请用系统"应用分身",节点选择交给 Clash 等 VPN。

## 技术栈

**Tauri 2**(Rust 核心 + 纯 HTML/CSS/JS 前端,无打包器 + 各平台系统 WebView)。一套代码,`tauri build` 出 macOS `.dmg`,`tauri android build` 出 `.apk`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

```bash
# 前置:Rust、Node ≥ 20;Tauri CLI 作为 devDependency 安装
npm ci

# 前端 / 注入脚本自检(语法门禁 + 单元测试,无需 Rust)
npm test

# 浏览器里预览界面(Shell / 亮暗 Dock / 手机首页 / HUD,示例数据)
npm run preview            # http://localhost:4173/  · /shell.html?tabs=1 · /shell.html?mode=mobile

# 桌面开发
npm run tauri dev

# 出 macOS dmg
npm run tauri build

# 出 Android apk(需 Android SDK/NDK,设置 NDK_HOME)
# 注意:必须经 `npm run tauri` 调用,init 会把调用方式记进 Gradle 工程
npm run tauri -- android init          # 首次
npm run tauri -- android build --apk --debug --target aarch64

# 重新生成应用图标(需 python3 + Pillow)
npm run icons
```

完整开发流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 目录

```
arena-kit/
├── docs/               开发文档、架构、功能移植清单
├── injected/           注入 arena.ai 页面的脚本(MAIN world)
│   ├── bootstrap.js    window.__ARENAKIT__:IPC 桥 + 模块开关 + 状态上报
│   ├── gm-shim.js      GM_* 与 chrome.storage/runtime 的 localStorage 垫片
│   └── *.js            上游移植脚本(snoop / unlock / eni / manager / plus / leaderboard)
├── src/                前端(无打包器)
│   ├── theme.css       设计令牌:亮/暗主题、间距、圆角、字体
│   ├── shell.html/css/js 桌面壳:标签栏 + 首页(账号)+ Dock;也是手机首页
│   ├── dock.css/js       侧栏 Dock(标记位于 shell.html 内)
│   ├── hud.js/css      页内 HUD(Shadow DOM,由 Rust init script 注入)
│   ├── lib/format.js   纯函数视图助手(可测)
│   └── index.html      浏览器预览画廊
├── src-tauri/          Rust 核心(窗口/标签布局、账号与会话、init script 组装、trace/额度网络层)
│   ├── src/sessions.rs 账号簿(accounts.json)、代理校验、标签列表(纯数据,可测)
│   ├── android-overlay/ 覆盖到 gen/android 的原生文件(MainActivity:系统栏 / 键盘 inset)
│   ├── capabilities/   default.json(本地 Shell)/ arena.json(远程 arena.ai 标签页)
│   └── permissions/    应用命令的 ACL 权限(tauri-build 自动生成)
├── scripts/            check-syntax.mjs(init bundle 语法门禁)、apply-android-overlay.sh、serve.mjs、make-icons.py
├── tests/              node:test 单元测试(format / bootstrap / shim / dock-layout / shell 接线)
├── vendor/             上游项目来源与许可说明
└── .github/workflows/  CI:web 自检 → cargo test → dmg + apk
```

## 上游与许可

见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。各上游脚本保留其原许可(MIT / GPLv3),本仓库整合代码私有。
