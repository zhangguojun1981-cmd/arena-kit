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
| **额度百分比 + 三色进度条 + 重置倒计时** | [arena-trace-android](https://github.com/AI-modelsAPI/arena-trace-android) (pulse) | B 原生取证 |
| 自动抽卡/探针、清理探测残留、会话历史 | [arena-trace-inspector](https://github.com/AI-modelsAPI/arena-trace-inspector)(待移植) | B 原生取证 |

完整链接、许可与克隆命令见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。

## 界面

一套**扁平、极简**的设计系统(`src/theme.css`),亮 / 暗两套主题(跟随系统或手动切换),无渐变无投影,单一强调色,全部用 CSS 变量驱动:

| 界面 | 位置 | 说明 |
|---|---|---|
| **侧栏 Dock** | 桌面端窗口右侧独立 WebView(`src/dock.html`) | 服务端模型(含最近记录)、今日额度仪表、功能开关、提示词注入;可折叠卡片、主题切换 |
| **页内 HUD** | 注入 arena.ai 页面的 Shadow DOM(`src/hud.js`) | 可拖动胶囊,点击展开模型 / 额度卡片;移动端默认开启,桌面端可在 Dock 里打开 |
| **预览页** | `src/index.html` | 浏览器里无需 Tauri 即可审阅亮 / 暗两版 Dock 与 HUD(`npm run preview`) |

## 技术栈

**Tauri 2**(Rust 核心 + 纯 HTML/CSS/JS 前端,无打包器 + 各平台系统 WebView)。一套代码,`tauri build` 出 macOS `.dmg`,`tauri android build` 出 `.apk`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

```bash
# 前置:Rust、Node ≥ 20、Tauri CLI v2
npm install -g @tauri-apps/cli@^2

# 前端 / 注入脚本自检(语法门禁 + 单元测试,无需 Rust)
npm test

# 浏览器里预览界面(亮/暗 Dock + HUD,示例数据)
npm run preview            # http://localhost:4173/

# 桌面开发
tauri dev

# 出 macOS dmg
tauri build

# 出 Android apk(需 Android SDK/NDK,设置 NDK_HOME)
tauri android init          # 首次
tauri android build --apk --debug --target aarch64

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
│   ├── dock.html/css/js  桌面侧栏 Dock
│   ├── hud.js/css      页内 HUD(Shadow DOM,由 Rust init script 注入)
│   ├── lib/format.js   纯函数视图助手(可测)
│   └── index.html      浏览器预览画廊
├── src-tauri/          Rust 核心(窗口布局、init script 组装、trace/额度网络层)
│   ├── capabilities/   default.json(本地 Dock)/ arena.json(远程 arena.ai 页面)
│   └── permissions/    应用命令的 ACL 权限(tauri-build 自动生成)
├── scripts/            check-syntax.mjs(init bundle 语法门禁)、serve.mjs、make-icons.py
├── tests/              node:test 单元测试(format / bootstrap / shim)
├── vendor/             上游项目来源与许可说明
└── .github/workflows/  CI:web 自检 → cargo test → dmg + apk
```

## 上游与许可

见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。各上游脚本保留其原许可(MIT / GPLv3),本仓库整合代码私有。
