# Arena.ai —— 新建会话 / Agent 模式 / GitHub 连接 与 仓库选择 自动化指南

> 探测时间：2026-09-28。以真实 DOM + 已加载 JS chunk 逆向 + 未鉴权端点探测为依据。
> ⚠️ 事实边界：GitHub 连接/仓库列表这些**需要登录态**才能实测返回体；本次以匿名态探测得到端点、
> 请求/响应 Schema、UI 选择器和交互时序，**未用真实已登录账号跑通仓库真实数据**。登录后字段名不变，
> 但首次接入请用真实账号 dump 一次 `/api/coding/github/repos` 等响应校准。

---

## 0. 总览：四件事的自动化路径

| 目标 | 推荐方式 | 备注 |
|---|---|---|
| 新建会话 | 直接导航到模式对应 URL | 无需点 New Chat |
| Agent 模式选择 | 导航到 `/agent`，或点模式下拉选 Agent Mode | Agent 有独立 URL |
| GitHub 开关打开（连接） | 走 `/api/coding/github/connect/start` → 弹窗 OAuth → postMessage 回收 | 首次需 GitHub App 授权，之后免 |
| GitHub 项目选择 | 读 `/api/coding/github/repos`＋`/branches`，DOM 选或直接带进会话创建 body | 真正"选仓库"发生在创建会话时的 payload |

前提：**必须已登录 Arena**（见上一份 `arena-google-login-flow.md`）。所有 `/api/coding/...` 端点匿名访问返回 `401` 或 `{"message":"User not found"}`（已实测）。

---

## 1. 新建会话 & 模式选择

### 1.1 四种模式与对应 URL（已实测）
模式下拉里有 4 项，每项切换后 SPA 会改 URL：

| 下拉项 | 说明 | 切换后 URL |
|---|---|---|
| **Agent Mode** | Built for complex tasks（含 GitHub 编码） | `https://arena.ai/agent` |
| Battle Mode | Battle 2 anonymous models | `https://arena.ai/`（首页即 battle） |
| Side by Side | Compare 2 models | `https://arena.ai/text/side-by-side?model_a=...&model_b=...` |
| Direct | Chat with 1 model | `https://arena.ai/text/direct?model_a=...` |

**自动化最省事：直接导航**。要 Agent 模式就 `page.goto('https://arena.ai/agent')`，无需操作下拉，也无需点 "New Chat"（New Chat 链接本身就指向 `/agent`）。

### 1.2 若要用 UI 切换模式（DOM 方式）
```js
// 1) 打开模式下拉（触发按钮是 radix combobox，文本是当前模式名）
button[role="combobox"]            // 文本 "Agent"/"Battle"/"Side by Side"/"Direct"
// 2) 下拉项是 radix option（注意：是 DIV，不是 button）
[role="option"]                    // 文本含 "Agent Mode" / "Battle Mode" / ...
                                   // 当前选中项带 data-state="checked"
```
Playwright：
```python
page.click('button[role="combobox"]')
page.click('div[role="option"]:has-text("Agent Mode")')
page.wait_for_url("**/agent")
```

### 1.3 输入框 & 发送（关键坑）
输入区**不是 `<textarea>`**，而是 TipTap/ProseMirror 富文本：
```
div.ProseMirror.tiptap[contenteditable="true"]     // data-placeholder="Ask anything…"
button[aria-label="Send message"]                  // 空文本时 disabled
button[aria-label="Add files and connections"]     // 左下"回形针"，打开 Connections 弹窗
```
自动化填文本要用 contenteditable 方式（不能用 `fill()` 到 textarea）：
```python
box = page.locator('div.ProseMirror[contenteditable="true"]')
box.click()
box.type("帮我重构这个仓库的登录模块")   # 或 page.keyboard.insert_text(...)
page.click('button[aria-label="Send message"]')
```

### 1.4 会话创建的真实请求（Agent/coding 模式）
点发送后前端 POST（已从 JS 抓到确切 body 形状）：
```
POST /api/coding-agent/sessions
Content-Type: application/json
credentials: same-origin        # 带 Cookie
body: {
  "repoId":   <number>,          // 选中的 GitHub 仓库 id（不选仓库可不传/为空）
  "repoOwner":"<ownerLogin>",
  "repoName": "<name>",
  "baseBranch":"<branch name>",  // 默认取该仓库 defaultBranch
  "message":  "<你的任务文本>",
  "timingInputId":"<内部计时id>",           // 可省
  "enabledConnectors":["..."]               // 可选，启用的连接器 slug 数组
}
```
> 这一步就是"GitHub 项目选择"最终落地的地方：**选仓库 = 往这个 body 填 repoId/repoOwner/repoName/baseBranch**。
> 若想完全绕过 UI，登录态下自己组这个 POST 即可（repoId 从 §3 的 repos 接口拿）。

---

## 2. "GitHub 开关打开" = 连接 GitHub（OAuth + App 安装）

### 2.1 UI 触发路径
两个入口，最终都调用同一个 hook `useConnectGithub`：
- 输入框下方的推广条 **"Connect your GitHub"** → 右侧黑色 **Connect** 按钮（`button:has-text("Connect")`）。
- 左下"回形针" `button[aria-label="Add files and connections"]` → 弹出 **Connections** 面板 → **GitHub** 行（`button[aria-label="Connect GitHub"]`）。

Connections 弹窗结构（已实测）：
```
[data-radix-popper-content-wrapper]
  button[aria-label="Connect GitHub"]   → 文本 "GitHub"
  button                                → 文本 "Add files / Up to 25MB per file"（本地文件上传，input[type=file]）
```

### 2.2 连接的底层机制（从 JS 逆向）
点 Connect 后前端逻辑（`useConnectGithub` → `useStartGithub`）：

1. 若当前是**匿名用户** → 先弹登录框（`setLocation("coding-github-connect")`），不发请求。→ **所以必须先登录。**
2. 已登录 → `mutate()`：
   ```
   GET /api/coding/github/connect/start     # 返回一个 GitHub 授权 URL（字符串）
   ```
3. 前端 `window.open(<那个url>, "github-oauth")` **弹窗**打开 GitHub 授权页。
4. 主页面 `window.addEventListener("message", ...)` 等弹窗回传：
   ```
   event.data = { type: "coding-github-oauth", success: true }         // 成功
              或 { type:"coding-github-oauth", error:"access_denied" } // 用户取消
   ```
   来源校验：`isTrustedOAuthOrigin(event.origin)` 必须通过，且 `event.data.type==="coding-github-oauth"`。
5. 成功后前端 `invalidateQueries` 刷新连接状态，若变 `connected` 就打开工作区。
6. 另有轮询：`setInterval` 每 500ms 检查弹窗 `closed`，关掉即视为 `cancelled`。

对应还有一个**安装**入口（选择把 GitHub App 装到哪些仓库/组织）：
```
GET /api/coding/github/connect/install   # useInstallGithub，同样是拿 url 再 window.open
```
UI 上是仓库选择器旁的 **"Manage repositories"** / GitHub settings 齿轮（`aria-label="GitHub settings"`，tooltip "Manage repositories on GitHub"），按钮 pending 时文案 "Opening GitHub…"。

### 2.3 连接状态机（已从 zod schema 抓到）
```
CODING_GITHUB_CONNECTION_STATUS = {
  DISCONNECTED: "disconnected",   // 没连
  INSTALLED:    "installed",      // App 装了但未完成 OAuth 关联（或反之）
  CONNECTED:    "connected"       // 完全可用
}
```
查询状态：
```
GET /api/coding/github/connection   → { status: "disconnected|installed|connected" }
GET /api/coding/github/status       → 含服务健康/中断横幅指标（outage banner）
POST /api/coding/github/disconnect  → { success: true }   # 断开
```

### 2.4 自动化连接（两条路线）

**路线 A：走真实浏览器 UI（首次必须）**
GitHub App 首次授权/安装只能人工在 github.com 完成（选组织、选仓库范围、点 Authorize/Install），无法纯脚本。做法：
```python
# 已登录 arena 的持久化浏览器上下文
page.goto("https://arena.ai/agent")
# 触发连接（拦截 window.open 拿到真实授权 url，或直接让它弹）
page.on("popup", lambda p: handle_github_oauth(p))   # 在弹窗里点 Authorize / Install
page.click('button:has-text("Connect")')             # 或 Connections→Connect GitHub
# 等主页面连接状态变 connected
page.wait_for_function("""() => fetch('/api/coding/github/connection',{credentials:'same-origin'})
  .then(r=>r.json()).then(d=>d.status==='connected')""")
```
弹窗里（github.com）若已登录 GitHub 且之前装过 App，通常只需点一次 Authorize 就自动回跳并 postMessage；首次要选安装范围。

**路线 B：连接一次后纯 API 复用（推荐用于自动化）**
一旦 §2.4-A 完成，连接状态存在服务端（与你的 Arena 账号绑定），后续脚本**带 Arena 登录 Cookie** 即可直接：
- `GET /api/coding/github/connection` 确认 `connected`
- `GET /api/coding/github/repos` 列仓库（§3）
- 直接 `POST /api/coding-agent/sessions` 建会话并指定仓库（§1.4）

不用每次重连。只有 App 被卸载/权限撤销才需重跑 A。

---

## 3. GitHub 项目（仓库 / 分支）选择

### 3.1 列仓库（分页，游标）
```
GET /api/coding/github/repos?limit=100[&cursor=<nextCursor>]
credentials: same-origin
→ {
   repos: [ {
     id: number,               // ← 会话创建要用的 repoId
     fullName: "owner/name",
     name: "name",
     ownerLogin: "owner",      // ← repoOwner
     ownerType: string|null,
     defaultBranch: "main",    // ← baseBranch 默认值
     private: boolean,
     visibility: string|null,
     description: string|null,
     homepage: string|null,
     language: string|null,
     sizeKb: number|null,
     stargazersCount: number, ...
   }, ... ],
   nextCursor: string|null,
   hasNextPage: boolean
}
```
翻页：`hasNextPage` 为真时带 `cursor=nextCursor` 再请求。

### 3.2 列分支（针对某仓库）
```
GET /api/coding/github/branches?repoId=<id>&limit=100[&cursor=...]
→ {
   branches: [ { name: "main", commitSha: "abc123..." }, ... ],
   nextCursor: string|null,
   hasNextPage: boolean
}
```

### 3.3 UI 里的仓库选择器（如果走 DOM）
仓库选择器（登录+连接后才出现在 Agent 工作区）：
```
placeholder      = "Select a repository"
searchPlaceholder= "Search repositories…"
emptyText        = "No repositories found."
```
它是个带搜索+无限滚动加载（loadMoreRef）的下拉。选中某仓库触发分析事件 `coding_repo_selected`，把 `{id, fullName}` 存入状态；随后自动加载该仓库分支，默认选 `defaultBranch`。
> DOM 层没有稳定 id，建议按 `placeholder="Select a repository"` 定位下拉、输入仓库名过滤、点匹配项。**更稳的做法是走 §3.1 API 拿 repoId 后直接 §1.4 建会话**，绕开这个虚拟列表下拉。

### 3.4 纯 API 建会话（把"选仓库"一步做完）
```python
import requests
S = requests.Session()
S.cookies.update(arena_cookies)   # 已登录 Arena 的 Cookie（含 arena-auth-prod-v1）
base = "https://arena.ai"

# 1) 确认已连 GitHub
assert S.get(f"{base}/api/coding/github/connection").json()["status"] == "connected"

# 2) 找目标仓库
repos, cursor = [], None
while True:
    q = {"limit": 100}
    if cursor: q["cursor"] = cursor
    d = S.get(f"{base}/api/coding/github/repos", params=q).json()
    repos += d["repos"]
    if not d["hasNextPage"]: break
    cursor = d["nextCursor"]
repo = next(r for r in repos if r["fullName"] == "myorg/myrepo")

# 3) （可选）选非默认分支
branch = repo["defaultBranch"]
# br = S.get(f"{base}/api/coding/github/branches", params={"repoId":repo["id"],"limit":100}).json()["branches"]

# 4) 建 Agent 编码会话
r = S.post(f"{base}/api/coding-agent/sessions", json={
    "repoId":    repo["id"],
    "repoOwner": repo["ownerLogin"],
    "repoName":  repo["name"],
    "baseBranch":branch,
    "message":   "重构登录模块，补齐单元测试",
})
r.raise_for_status()
session = r.json()   # 含新会话 id，可据此跳转/轮询
```
> 会话创建的错误码（从 JS 抓到，便于处理）：`not_connected`(未连 GitHub)、`repo_not_found`、`repo_bootstrap_failed`(仓库没有初始 commit)、`github_request_failed`(GitHub 暂时不可用)、`GithubOAuthError`(需重连)。空仓库需先在 GitHub 建初始提交。

---

## 4. 端点清单速查

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/coding/github/connect/start` | GET | 拿 GitHub OAuth 授权 URL（前端 window.open） |
| `/api/coding/github/connect/install` | GET | 拿 GitHub App 安装/管理仓库 URL |
| `/api/coding/github/connection` | GET | 连接状态 `{status}` |
| `/api/coding/github/status` | GET | 服务健康/中断横幅 |
| `/api/coding/github/repos` | GET | 仓库列表（`?limit=&cursor=`） |
| `/api/coding/github/branches` | GET | 分支列表（`?repoId=&limit=&cursor=`） |
| `/api/coding/github/disconnect` | POST | 断开连接 `{success}` |
| `/api/coding-agent/sessions` | POST | 建编码会话（带 repo/branch/message） |

全部要 `credentials: same-origin`（Arena 登录 Cookie）。匿名 → 401 / `{"message":"User not found"}`（已实测）。

---

## 5. 完整自动化流程（推荐）

```
[准备] 用真实浏览器 + 持久化 profile 登录 Arena（Google 登录见 arena-google-login-flow.md）
        导出/保留 Arena 登录 Cookie（arena-auth-prod-v1 等）

[一次性] 打开 https://arena.ai/agent
         点 "Connect"（或 Connections→Connect GitHub）
         在弹出的 github.com 窗口人工完成 Authorize + 选安装仓库范围
         等 /api/coding/github/connection == "connected"
         → 之后此账号长期保持连接

[每次任务] 方式①（纯 API，最稳）：
            GET /repos 找 repoId → POST /api/coding-agent/sessions 建会话
          方式②（走 UI）：
            goto /agent → 选 Agent Mode（或直接 /agent 就是）
            → 回形针/Connect 确认已连
            → 仓库下拉 "Select a repository" 搜索并选仓库、选分支
            → ProseMirror 输入框写任务 → Send message
```

## 6. 关键选择器汇总（DOM 自动化）

```
# 模式
button[role="combobox"]                          # 模式下拉触发（文本=当前模式）
div[role="option"]:has-text("Agent Mode")        # 下拉项（DIV，非 button；选中带 data-state="checked"）

# 输入 & 发送
div.ProseMirror.tiptap[contenteditable="true"]   # 输入框（data-placeholder="Ask anything…"）
button[aria-label="Send message"]                # 发送（空内容时 disabled）
button[aria-label="Add files and connections"]   # 回形针 → Connections 弹窗

# GitHub 连接
button:has-text("Connect")                       # 推广条连接按钮
button[aria-label="Connect GitHub"]              # Connections 弹窗内 GitHub 行
button[aria-label="Dismiss GitHub promotion"]    # 关闭推广条
button[aria-label="GitHub settings"]             # 仓库管理齿轮（tooltip: Manage repositories on GitHub）

# 仓库选择器（连接后出现）
[placeholder="Select a repository"]              # 仓库下拉
[searchPlaceholder="Search repositories…"]       # 其搜索框
```

## 7. 注意与红线
- 所有 coding 端点**依赖 Arena 登录态**；无登录一切免谈。先跑通登录（Cookie 复用最省心）。
- GitHub App 首次授权/改安装范围**只能真人在 github.com 点**，脚本无法代点 Authorize/Install；连一次后 API 长期复用。
- `window.open` 弹窗被浏览器拦截会直接失败（前端有 "Allow pop-ups" 报错）——自动化时用非 headless 或监听 `popup` 事件接管。
- 建会话是**真实动作**（会在你 GitHub 仓库开分支/提交、消耗额度），自动化前确认目标仓库正确、message 无误。
- 本报告的响应体字段来自 JS 内的 zod schema（可靠），但**未用登录态实测真实数据**；接入时先 dump 一次真实响应核对。
