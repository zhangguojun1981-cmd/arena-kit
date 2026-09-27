# 上游来源与许可

ArenaKit 整合了以下开源/私有项目。各上游脚本移植进 `injected/` 时在文件头保留来源与原许可标注。接手者可直接点开下列链接对照原始实现。

## 前端注入类(移植进 `injected/`)

| 上游 | 仓库链接 | 许可 | 用于 ArenaKit 的部分 |
|---|---|---|---|
| Arena-Manager(筛选助手本体) | https://github.com/JimAchievo/Arena-Manager | MIT | `injected/manager.js` — 模型筛选/分类/排序/分组/云同步 |
| Arena Model Unlocker | https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension | 未声明(README 注明 research use) | `injected/unlock.js` — 解锁 Opus 全系 + 150+ 隐藏/盲测模型 |
| Arena.ai Plus | https://github.com/chen-dahan/Arena.ai-Plus | GPLv3 | `injected/plus.js` — 排行榜性价比列/价格/模型年龄 |
| LMArena Personal Leaderboard | https://github.com/wrapss/lmarena-personal-leaderboard | 见仓库(未在 README 明示) | `injected/leaderboard.js` — 个人投票胜负统计 |
| Arena ENI Prompt Injector | https://github.com/peyton2065/Arena-Ai | 未声明 | `injected/eni.js` — 每新对话注入系统提示词 |

镜像/参考(功能同源,接手时可对照):
- Arena-Manager 也发布在 GreasyFork:https://greasyfork.org/scripts/563029-arena-manager （源码 tab 可看最新版 v5.2.1）

## 取证核心类(私有仓库,本人自有版权)

| 上游 | 仓库链接 | 说明 | 用于 ArenaKit 的部分 |
|---|---|---|---|
| Arena Trace Inspector(Chrome MV3 扩展) | https://github.com/AI-modelsAPI/arena-trace-inspector | 截 SSE 令牌→查 Trigger.dev trace→显示服务端真实模型名;含 auto-draw 探针/清理/HUD/会话历史/用量 | `injected/snoop.js`、`src-tauri/src/trace.rs` + `usage.rs`、`src/lib/usage.js`、`src/lib/history.js`、`injected/pulse.js` 的接口形状 |
| Arena Trace(Android 原生,现已公开) | https://github.com/AI-modelsAPI/arena-trace-android | 上述扩展的 Kotlin 移植;WebView + 原生编排(ProbeController/ProbeLogic/TurnTracker/PulseTiming)+ 页面侧 `probe.js`/`conversation-rename.js` | `injected/probe.js`、`injected/conversation-rename.js`(逐字节同源)、`src/lib/probe-logic.js`、`src/lib/probe-runner.js`、`src/lib/turns.js`、`src/lib/pulse.js`、`src/lib/rpc.js` |

> 注入时机参考安卓版:`arena-trace-android` 的 `MainActivity.kt` 用 `WebViewClient.onPageFinished` + `doUpdateVisitedHistory`（SPA pushState 导航）重新注入 `snoop.js`。ArenaKit 桌面端对应用 Tauri 的 `WebviewBuilder::initialization_script`（每次导航前自动重跑），等价地保证注入不被 SPA 路由冲掉。

## 许可注意(接手前必读)

- **GPLv3(Arena.ai-Plus)**：若 `plus.js` 以修改后形式随本应用分发，该文件及其衍生受 GPLv3 约束。本仓库私有、仅本人使用，不对外分发；若日后公开需评估 GPLv3 传染性，或将 plus 功能做成运行时可选的独立注入包。
- **MIT(Arena-Manager)**：保留版权与许可声明即可。
- **未声明许可的两个(Unlocker、ENI)**：按"仅个人研究、不分发"使用；若公开需先联系作者或重写。
- **取证核心(inspector/android)**：本人私有仓库，自有版权。

## 源码快照位置(本机)

上游源码克隆快照在本机 `/Users/zhangguojun/Downloads/arena-sources/`（不纳入本仓库，仅移植所需片段进 `injected/`，文件头标注来源）。接手者若无此目录，按上表链接自行 `git clone` 即可：

```bash
mkdir -p arena-sources && cd arena-sources
git clone https://github.com/JimAchievo/Arena-Manager
git clone https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension
git clone https://github.com/chen-dahan/Arena.ai-Plus
git clone https://github.com/wrapss/lmarena-personal-leaderboard
git clone https://github.com/peyton2065/Arena-Ai
git clone https://github.com/AI-modelsAPI/arena-trace-inspector   # 私有,需授权
git clone https://github.com/AI-modelsAPI/arena-trace-android     # 已公开
```
