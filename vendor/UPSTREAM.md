# 上游来源与许可

ArenaKit 整合了以下开源项目。各上游脚本移植进 `injected/` 时在文件头保留来源与原许可标注。

| 上游 | 仓库 | 许可 | 用于 ArenaKit 的部分 |
|---|---|---|---|
| Arena-Manager | github.com/JimAchievo/Arena-Manager | MIT | `injected/manager.js` — 模型筛选/分类/排序/云同步 |
| Arena Model Unlocker | github.com/theraker526/Arena-AI-Model-Unlocker-Extension | (未声明,README 注明 research use) | `injected/unlock.js` — 解锁隐藏模型 |
| Arena.ai Plus | github.com/chen-dahan/Arena.ai-Plus | GPLv3 | `injected/plus.js` — 排行榜性价比列 |
| LMArena Personal Leaderboard | github.com/wrapss/lmarena-personal-leaderboard | (见仓库) | `injected/leaderboard.js` — 个人投票统计 |
| Arena ENI Prompt Injector | github.com/peyton2065/Arena-Ai | (未声明) | `injected/eni.js` — 系统提示词注入 |
| Arena Trace Inspector | github.com/AI-modelsAPI/arena-trace-inspector (fork) | 私有 | `snoop.js` / `trace.rs` / HUD / autodraw — 取证核心 |
| Arena Trace (Android) | github.com/AI-modelsAPI/arena-trace-android | 私有 | `pulse.rs` / `cookies.rs` / 已验证的额度轮询逻辑 |

## 许可注意

- GPLv3(Arena.ai-Plus):若 `plus.js` 以修改后形式随本应用分发,该文件及其衍生受 GPLv3 约束。本仓库私有、仅本人使用,不对外分发;若日后公开需评估 GPLv3 传染性,或将 plus 功能做成运行时可选的独立注入包。
- MIT(Arena-Manager):保留版权与许可声明即可。
- 未声明许可的两个(Unlocker、ENI):按"仅个人研究、不分发"使用;若公开需先联系作者或重写。
- 取证核心(inspector/android)是本人私有仓库,自有版权。

## 源码快照位置

上游源码克隆快照在 `/Users/zhangguojun/Downloads/arena-sources/`(不纳入本仓库,仅移植所需片段进 `injected/`,文件头标注来源 commit)。
