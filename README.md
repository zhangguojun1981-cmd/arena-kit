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

# 出 Android apk(需 Android SDK/NDK)
cargo tauri android init   # 首次
cargo tauri android build
```

完整开发流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 目录

```
arena-kit/
├── docs/               开发文档、架构、功能移植清单
├── injected/           注入 arena.ai 页面的脚本(MAIN world)
├── src/                Tauri 前端(HUD overlay + 控制面板)
├── src-tauri/          Rust 核心(WebView 初始化、trace/额度网络层)
├── vendor/             上游项目来源与许可说明
└── .github/workflows/  CI:构建 dmg + apk
```

## 上游与许可

见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。各上游脚本保留其原许可(MIT / GPLv3),本仓库整合代码私有。
