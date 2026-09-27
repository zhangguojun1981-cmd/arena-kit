# ArenaKit

一个跨平台(macOS + Android)的 **arena.ai 增强客户端**。把 arena.ai 网页封装进原生 WebView,并注入一组增强脚本 + 内建取证 HUD,一份代码同时产出 **`.dmg`** 和 **`.apk`**。

> 私有工具,仅供本人研究使用。含运行令牌截获逻辑,**只读、不改写服务端请求**。

## 它做什么

ArenaKit = 网页套壳(A) + 原生 dock 取证面板(B) + 提示词注入。整合了以下能力:

| 能力 | 来源 | 类别 |
|---|---|---|
| 模型筛选/分类/排序、70 厂商识别、分组、云同步 | [Arena-Manager](https://github.com/JimAchievo/Arena-Manager) | A 前端注入 |
| 解锁 Claude Opus 全系 + 150+ 隐藏/盲测模型 | [Model-Unlocker](https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension) | A 前端注入 |
| 排行榜"性价比"列、价格、模型年龄、模态图标 | [Arena.ai-Plus](https://github.com/chen-dahan/Arena.ai-Plus) | A 前端注入 |
| 个人投票胜负统计 | [personal-leaderboard](https://github.com/wrapss/lmarena-personal-leaderboard) | A 前端注入 |
| 每新对话自动注入系统提示词 | [Arena-Ai (ENI)](https://github.com/peyton2065/Arena-Ai) | 提示词注入 |
| **截获运行令牌 → 拉 trace → 显示服务端真实模型名**,按**轮次**解析模型(非首轮模型高亮) | [arena-trace-inspector](https://github.com/AI-modelsAPI/arena-trace-inspector) / [-android](https://github.com/AI-modelsAPI/arena-trace-android) | B 取证 |
| **使用额度(Token / 费用)**:本轮 / 本会话 / 累计,证据 JSON 导出 | arena-trace-inspector | B 取证 |
| **额度百分比** + 三色进度条 + 锚定的重置倒计时 | arena-trace-android (pulse) | B 取证 |
| **会话历史**:本地记录、搜索、一键打开、删除、导出、清空 | arena-trace-inspector / -android | B 取证 |
| **重命名对话**:识别模型后手动 / 自动改名,可加统一前缀 | arena-trace-android + 前缀为 ArenaKit 新增 | B 取证 |
| **自动探针(抽卡)**:新建对话 → 发算式 → 等 trace → 匹配目标 → 命中改名 | arena-trace-android (ProbeController) | B 取证 |
| **自动清理**:归档算式标题的探针残留(仅归档不删除) | arena-trace-android | B 取证 |
| **会话探针**:向当前对话发一条探针,识别「这一轮」实际模型 | arena-trace-android (quickSend) | B 取证 |
| **回复监控**:空回复 / 报错 / 中断 / 停滞自动标记到轮次 | ArenaKit 新增 | B 取证 |

完整链接、许可与克隆命令见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。

## 技术栈

**Tauri 2.0**(Rust 核心 + Web 前端 + 各平台系统 WebView)。一套代码,`cargo tauri build` 出 macOS `.dmg`,`cargo tauri android build` 出 `.apk`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

```bash
# 前置:Rust、Node、Tauri CLI v2
cargo install tauri-cli --version "^2"

# 桌面开发
cargo tauri dev

# 出 macOS dmg
cargo tauri build

# 出 Android apk(需 Android SDK/NDK;dock 以内嵌模式装进页面,见 docs/ARCHITECTURE.md)
node scripts/bundle-dock.mjs   # 改过 src/ 后重新生成 src/embed/dock-embedded.gen.js
cargo tauri android init       # 首次
cargo tauri android build --apk --debug --target aarch64

# 单测 / 语法检查(无需 Rust 工具链)
node --test 'tests/**/*.test.mjs'
node scripts/check-syntax.mjs
```

完整开发流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 目录

```
arena-kit/
├── docs/               开发文档、架构、功能移植清单
├── injected/           注入 arena.ai 页面的脚本(MAIN world):bridge/snoop/monitor/pulse/probe/…
├── src/                dock 面板(dock.html/js/css)+ src/lib/ 纯逻辑库 + src/embed/ 安卓内嵌 dock(shell + 生成的 bundle)
├── src-tauri/          Rust 核心(WebView 初始化、trace/用量、store、IPC 中继、capabilities)
├── tests/              node:test 单测(逻辑库直接 import;注入脚本用 node:vm 跑)
├── scripts/            check-syntax.mjs、bundle-dock.mjs(安卓内嵌 dock 打包)
├── vendor/             上游项目来源与许可说明
└── .github/workflows/  CI:node-test → rust-test → dmg + apk → Release(附件为 .dmg/.apk 原文件)
```

## 上游与许可

见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。各上游脚本保留其原许可(MIT / GPLv3),本仓库整合代码私有。
