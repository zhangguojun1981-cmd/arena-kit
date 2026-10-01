# ArenaKit

一个跨平台(macOS + Android)的 **arena.ai 增强客户端**。把 arena.ai 网页封装进原生 WebView,并注入一组增强脚本 + 内建取证 HUD,一份代码同时产出 **`.dmg`** 和 **`.apk`**。

> 私有工具,仅供本人研究使用。含运行令牌截获逻辑,**只读、不改写服务端请求**。

## 它做什么

ArenaKit = 网页套壳(A) + 原生 dock 取证面板(B) + 提示词注入。整合了以下能力:

| 能力 | 来源 | 类别 |
|---|---|---|
| 模型筛选/分类/排序、70 厂商识别、分组、云同步 | [Arena-Manager](https://github.com/JimAchievo/Arena-Manager) | A 前端注入 |
| 解锁 Claude Opus 全系 + 150+ 隐藏/盲测模型(默认关,开关改动后自动刷新页面) | [Model-Unlocker](https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension) | A 前端注入 |
| 排行榜"性价比"列、价格、模型年龄、模态图标 | [Arena.ai-Plus](https://github.com/chen-dahan/Arena.ai-Plus) | A 前端注入 |
| ~~个人投票胜负统计~~(已下线:上游只适配 lmarena 旧域名,在 arena.ai 上不生效) | [personal-leaderboard](https://github.com/wrapss/lmarena-personal-leaderboard) | — |
| 每新对话自动注入系统提示词(默认关;开启后输入框右上角浮一个「ENI」小标,经典与 Agent 模式都生效) | [Arena-Ai (ENI)](https://github.com/peyton2065/Arena-Ai) | 提示词注入 |
| **截获运行令牌 → 拉 trace → 显示服务端真实模型名**,按**轮次**解析模型(非首轮模型高亮) | [arena-trace-inspector](https://github.com/AI-modelsAPI/arena-trace-inspector) / [-android](https://github.com/AI-modelsAPI/arena-trace-android) | B 取证 |
| **使用额度(Token / 费用,非百分比)**:本轮 / 本会话 / 累计,Token / 费用覆盖率,按运行查看历史记录,证据来源折叠(span 级 ID 可复制),证据 JSON 导出 | arena-trace-inspector | B 取证 |
| **额度百分比** + 三色进度条 + 锚定的重置倒计时 | arena-trace-android (pulse) | B 取证 |
| **会话历史**:本地记录、搜索、分页加载、一键打开 / 查看运行、删除、导出、清空,**归档当前对话并删除记录** | arena-trace-inspector / -android | B 取证 |
| **重命名对话**:识别模型后手动 / 自动改名,可加统一前缀 | arena-trace-android + 前缀为 ArenaKit 新增 | B 取证 |
| **模型指纹探测**:当服务端 trace 给不出真名时,发固定探针 → 页面侧把回复**只归约成数字 / 类别特征**(原文不出页面)→ 在 opus / fable / gpt6 三系列间做**统计概率估计**(非真名,`SOURCE_RANK=2`,服务端真名随时覆盖);可设会话数、可选在置信度 ≥ 阈值(默认 0.85)时按估计重命名;需用户确认后才发消息、消耗额度;阈值未经 Arena 校准,仅供参考 | ArenaKit 新增(统计推测,非真名) | B 取证 |
| **回复监控**:空回复 / 报错 / 中断 / 停滞自动标记到轮次 | ArenaKit 新增 | B 取证 |
| **状态胶囊 + 底部面板**(安卓,按参考安卓应用 v0.6.4 StatusPillView 还原):36 dp 扁平胶囊 = 额度环(弧长 = 剩余 %,数字在环内;蓝 ≥20% / 琥珀 10–19% / 红 <10%,回复异常时红色描边闪烁)+ 一行标签(模型 / 任务进度 / 闪现,设置里可选「百分比 + 模型 / 百分比 / 模型」)+ 可选 ⟳ 区(设置「悬浮窗显示刷新按钮」,默认开);单击胶囊开面板(触点抖动 ≤12 px 仍算单击,WebView 吞掉指针事件时也按 click 兜底)、点 ⟳ 刷新、长按快捷菜单(探针 / 会话探针 / 清理 / 刷新 / 切换账号 / 面板)、拖动后自动贴边;面板为贴底 Bottom Sheet(抓手横条 + 右上 ✕ 关闭,无刷新按钮):模型 + 状态行 + 额度倒计时 + 活动日志 + 对话 / 探针 / 工具 / 账号 / 更多页签。**macOS 只有右侧面板(dock)分栏**,页面里没有悬浮胶囊 | arena-trace-android (StatusPillView / ControlPanel) | B 取证 |
| **账号**:登录 Arena 后自动记录当前账号(会话 Cookie 快照,随令牌轮换持续刷新);**一键切换**已保存的账号 = 换 Cookie + 刷新;「添加另一个账号」清掉当前登录去登第二个;每个账号可填邮箱 / 密码 / **2FA 密钥(TOTP,支持 otpauth:// 链接)**——列表里实时显示 6 位动态码与剩余秒数、一键复制;已保存会话失效时**登录助手**接手:先判断页面是已登录还是未登录(游客),已登录不动页面;未登录时 Google 账号直接跳转 Google 登录(Google 账号列表里点目标邮箱,或填邮箱 / 密码 / 验证器动态码),Arena 邮箱账号直接提交邮箱 + 密码(邮箱验证码流程会在面板里等你输入邮件里的验证码并代填;你一点页面助手就暂停 10 秒,不会和你抢着点;Google 登录页卡住超过 25 秒会浮出「重试 / 返回 Arena」)。凭据明文存本机 store,不上传 | ArenaKit 新增 | 通用 |
| **刷新**:工具页 / 快捷菜单 / 对话滚到底后按住上拉 / macOS ⌘R,刷新时顶部进度条;**回复出错或空白时自动刷新**(看门狗,可关) | arena-trace-android (requestReload / ReplyWatchdog) | B 取证 |
| **页面链接标签**:点到其他站点的链接、target=_blank、window.open 在应用内「链接页」打开(安卓原生 WebView 图层:✕ / 标题 / 域名 / ⟳ / 在浏览器中打开 / 复制 / 分享;桌面独立窗口),对话不被替换;登录 / 验证域名留在原地,mailto / tel 交给其他应用 | arena-trace-android (LinkPolicy / LinkTab) | B 取证 |
| **设置**:主题(跟随系统 / 亮色 / 暗色)、悬浮球显示(百分比 + 模型 / 百分比 / 模型,仅安卓)、截获会话流 / 额度轮询 / 回复监控 / 悬浮窗显示刷新按钮 / 自动刷新开关 | arena-trace-android (DayNight) / arena-trace-inspector(监听开关) | 通用 |
| **macOS 键鼠 + 菜单栏**:Esc 逐层关闭(对话框 → 菜单)、悬停高亮;菜单栏「页面」:刷新 ⌘R(经 dock:防抖 + 忙碌确认 + 进度条)、后退 ⌘[ / 前进 ⌘]、在浏览器中打开 ⌘⇧O、复制链接 ⌘⇧C,对焦点所在的链接标签窗口同样生效(对应安卓链接页工具栏) | ArenaKit 新增(桌面对齐安卓) | 通用 |

完整链接、许可与克隆命令见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。

## 技术栈

**Tauri 2.0**(Rust 核心 + Web 前端 + 各平台系统 WebView)。一套代码,`cargo tauri build` 出 macOS `.dmg`,`cargo tauri android build` 出 `.apk`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

```bash
# 前置:Rust、Node、Tauri CLI v2
cargo install tauri-cli --version "^2"

# 桌面开发
cargo tauri dev

# 出 macOS dmg（当前机器架构；CI 同时出 Apple 芯片 *_aarch64.dmg 与 Intel *_x64.dmg）
cargo tauri build
cargo tauri build --target x86_64-apple-darwin   # 在 Apple 芯片机器上交叉出 Intel 包（先 rustup target add x86_64-apple-darwin）

# 出 Android apk(需 Android SDK/NDK;dock 以内嵌模式装进页面,见 docs/ARCHITECTURE.md)
node scripts/bundle-dock.mjs   # 改过 src/ 后重新生成 src/embed/dock-embedded.gen.js
cargo tauri android init       # 首次
cp -R src-tauri/android/. src-tauri/gen/android/   # 覆盖 MainActivity(状态栏 insets + 链接页桥 + 返回键)、LinkTab.kt、自适应图标,CI 同样这么做
cargo tauri android build --apk --target aarch64

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
├── src-tauri/          Rust 核心(WebView 初始化、trace/用量、store、IPC 中继、capabilities)+ android/ 覆盖层(MainActivity insets / 链接页桥 / 返回键、LinkTab.kt、自适应图标)+ icons/
├── tests/              node:test 单测(逻辑库直接 import;注入脚本用 node:vm 跑)
├── scripts/            check-syntax.mjs、bundle-dock.mjs(安卓内嵌 dock 打包)、make-icons.py(图标渲染)
├── vendor/             上游项目来源与许可说明
└── .github/workflows/  CI:node-test → rust-test → dmg(aarch64 + x64)+ apk → Release(附件为 .dmg/.apk 原文件)
```

## 上游与许可

见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)。各上游脚本保留其原许可(MIT / GPLv3),本仓库整合代码私有。
