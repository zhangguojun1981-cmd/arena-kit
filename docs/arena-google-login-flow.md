# arena.ai 谷歌邮箱登录流程探测报告（供自动化使用）

> 探测时间：2026-09-28 ・ 站点：https://arena.ai （www.arena.ai 会 301 到 arena.ai）
> git_commit: 7155b3a901f305e7403bf750ab1388922f13056e
> 本报告仅针对「使用 Google 登录」，未创建任何 Google 账号，未完成真实授权。

---

## 0. 一句话结论

Arena 用 **Supabase Auth (GoTrue)** 做后端，Google 登录是 **标准 OAuth2 Authorization Code + PKCE**。
前端点击「Continue with Google」本质上只是 **整页跳转** 到
`/nextjs-api/sign-in/google?...`，随后由服务器一路 302/307 重定向：

```
arena.ai/nextjs-api/sign-in/google
   ↓ 307
accounts.google.com/o/oauth2/v2/auth   ← 用户在这里选账号/授权（Google 侧）
   ↓ (Google 回调)
auth.arena.ai/auth/v1/callback         ← GoTrue 交换 Google code
   ↓ 302
arena.ai/nextjs-api/callback/google    ← Next.js 用 PKCE code_verifier 换 session
   ↓ 307 → returnTo (默认 "/")
写入 Cookie: arena-auth-prod-v1 (base64 的 Supabase session JSON)
```

**「新账号」和「已登录过的账号」在 Arena 侧走的是同一条链路**，差异 100% 发生在
Google 页面（`accounts.google.com`）：
- 未登录过 Google / 首次授权 → Google 显示登录框 + 授权同意页（因为 Arena 带了 `prompt=consent`）。
- 已在该浏览器登录过 Google → Google 显示 **账号选择器（account chooser）**，列出已保存的 Google 账号让你点选。
- 已授权过 Arena 的账号 → 选中后可能直接跳过同意页（若 Google 记住授权）。

Arena 自己不保存「Google 账号列表」；你看到的「有记录让你选」是 **Google 账号选择器**，属于 Google 的会话/Cookie，不是 Arena 的。

---

## 1. 认证后端与关键常量

| 项目 | 值 |
|---|---|
| Auth 后端 | Supabase GoTrue，自定义域 `https://auth.arena.ai`（`/auth/v1/*`） |
| Supabase 项目 | `huogzoeqzcrdvkwtvodi.supabase.co`（JWT `iss` 可见） |
| Google OAuth client_id | `899073161779-tneq1jnh66s8kfvckhedkhp8kvkj8lnp.apps.googleusercontent.com` |
| Google redirect_uri（固定） | `https://auth.arena.ai/auth/v1/callback` |
| OAuth scope | `email profile` |
| OAuth 参数 | `response_type=code`，`access_type=offline`，`prompt=consent` |
| 流程类型 | Authorization Code + **PKCE**（`persistSession` 开启） |
| 会话 Cookie | `arena-auth-prod-v1`（值 = `base64-` + Supabase session JSON） |
| PKCE 验证串 Cookie | `arena-auth-prod-v1-code-verifier`（值 = `base64-` + verifier） |
| 登录错误 Cookie | `__arena_auth_error`（base64 JSON，如 `{"message":"no_user_data"}`，Max-Age=120s） |

### arena-auth-prod-v1 会话结构（解码后）
```json
{
  "access_token": "<JWT>",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1790584936,
  "refresh_token": "<opaque, 约12字符>",
  "user": { "id": "...", "aud": "authenticated", "role": "authenticated",
            "email": "...", "is_anonymous": true/false, ... }
}
```
- access_token 是 JWT，1 小时过期，`iss = https://huogzoeqzcrdvkwtvodi.supabase.co/auth/v1`。
- **未登录时也有这个 Cookie**：Arena 一进站就创建一个 `is_anonymous:true` 的匿名 Supabase 用户（用来暂存聊天记录）。登录只是把匿名用户「升级/合并」成真实账号。

---

## 2. 前端触发点（DOM）

登录入口不是独立 `/login` 页（`/login` 返回 404），而是弹窗：

1. 侧栏底部按钮 `Log In`（文本精确等于 `Log In` 的 `<button>`）。
2. 弹窗标题 `Log In or Create Account`，含：
   - `Continue with Google`（`<button variant=outline>`，图标 `d.Google`）
   - 分隔线 `OR`
   - 邮箱输入框 `input[name="email"]` + `Continue with email`

### 「Continue with Google」按钮的真实行为（反编译自 JS chunk）
点击后不发 XHR，而是拼 query 后 **整页跳转**：
```js
// 埋点
analytics.capture({action:"login_clicked", params:{location, provider:"google", ...}})

// 构造参数
const e = new URLSearchParams({ shouldLinkHistory: String(shouldLinkHistory) }); // true/false
e.set("marketingConsent", String(marketingConsent));      // true/false
if (registeredCountryCode) e.set("registeredCountryCode", registeredCountryCode); // 如 "JP"
e.set("returnTo", returnTo);   // 登录成功后要回到的路径，默认 "/"

window.location.href = `/nextjs-api/sign-in/google?${e.toString()}`;
```
所以自动化根本不需要点那个按钮，直接导航到下面的 URL 即可。

---

## 3. 完整请求序列（可直接用于自动化）

### Step 1 — 发起（Arena → Google）
```
GET https://arena.ai/nextjs-api/sign-in/google
      ?shouldLinkHistory=true
      &marketingConsent=false
      &registeredCountryCode=JP
      &returnTo=%2F
```
- 前置条件：请求要带上当前浏览器的 Cookie（尤其 `arena-auth-prod-v1` 匿名会话、`arena-auth-prod-v1-code-verifier`）。服务器据此把当前匿名用户 id 塞进 `custom_state`。
- 响应：`307`，`Location` 指向 Google：
```
https://accounts.google.com/o/oauth2/v2/auth
   ?access_type=offline
   &client_id=899073161779-tneq1jnh66s8kfvckhedkhp8kvkj8lnp.apps.googleusercontent.com
   &prompt=consent
   &redirect_to=https%3A%2F%2Farena.ai%2Fnextjs-api%2Fcallback%2Fgoogle%3Faction%3Dsign-in%26custom_state%3D<BASE64>
   &redirect_uri=https%3A%2F%2Fauth.arena.ai%2Fauth%2Fv1%2Fcallback
   &response_type=code
   &scope=email+profile
   &state=<uuid>
```
- `custom_state` 是 base64 的 JSON，实测解出：
```json
{"arenaUserId":"<当前匿名 arena 用户>",
 "anonSupabaseUserId":"<当前匿名 supabase 用户>",
 "shouldLinkHistory":true,
 "registeredCountryCode":"JP",
 "returnTo":"/"}
```
  → 这就是「把匿名会话的聊天记录合并到登录后账号」的载体。

### Step 2 — Google 侧（人工/账号选择器）
在 `accounts.google.com` 上：
- **新账号流程**：输入 Google 邮箱+密码（+可能 2FA）→ 首次会展示 Arena 的授权同意页 → 点「继续/允许」。
- **已登录过流程**：Google 直接显示 **账号选择器**，列出该浏览器 profile 里已登录的 Google 账号 → 点选一个即可（若之前已授权过 Arena，通常跳过同意页）。

授权成功后 Google 重定向到 `redirect_uri`：
```
https://auth.arena.ai/auth/v1/callback?code=<google_code>&state=<uuid>
```

### Step 3 — GoTrue 交换（auth.arena.ai）
GoTrue 拿 Google 的 code 换 Google token → 用 email 找到/创建 Supabase 用户 → 生成自己的一次性 code → 302 跳回 `redirect_to`：
```
https://arena.ai/nextjs-api/callback/google?action=sign-in&custom_state=<BASE64>&code=<supabase_code>
```
（直接打 `https://auth.arena.ai/auth/v1/authorize?provider=google` 也会 302 到 Google，说明 GoTrue authorize 端点标准可用。）

### Step 4 — Arena 落地（换 session，写 Cookie）
```
GET https://arena.ai/nextjs-api/callback/google?action=sign-in&custom_state=...&code=<supabase_code>
```
- 服务器读 `code` + `arena-auth-prod-v1-code-verifier` Cookie，用 PKCE 向 GoTrue `/auth/v1/token?grant_type=pkce` 换 session。
- 成功：`Set-Cookie: arena-auth-prod-v1=base64-<session json>` + `307 Location: <returnTo>`（默认 `/`）。此后带该 Cookie 访问即为已登录。
- 失败：`Set-Cookie: __arena_auth_error=base64({"message":"..."})`（Max-Age 120s）+ `307 → /`。实测无有效 code/verifier 时 message = `no_user_data`。

### 相关辅助端点
| 端点 | 方法 | 说明 |
|---|---|---|
| `/nextjs-api/sign-out` | POST | 登出（GET 返回 405/307）。清 `arena-auth-prod-v1` |
| `/nextjs-api/sign-in/email` | POST | 邮箱+密码登录：`{email,password,shouldLinkHistory,...}`，失败 `{"error":"Invalid email or password"}` |
| `/nextjs-api/sign-up/magic-link` | POST | 邮箱注册发链接：`{email,fullName,shouldLinkHistory,marketingConsent,registeredCountryCode}` |
| GoTrue `/auth/v1/token?grant_type=refresh_token` | POST | 刷新 access_token，需 header `apikey:<anon>` + body `{refresh_token}` |

---

## 4. 自动化实现指南

### 关键限制（务必先看）
- **Google 登录无法在 App 内置 WebView / 无头 UA 中完成**：`accounts.google.com` 会拒绝 `disallowed_useragent` / "browser is not secure"。必须用 **真实浏览器上下文**（系统 Chrome，或桌面版 Playwright/Selenium 用真 Chrome、非 headless 或带反检测）。
- 因此自动化只有两条现实路线：
  1. **复用已登录 Cookie**（推荐，最稳）：手动在真浏览器登录一次，导出 `arena-auth-prod-v1` Cookie，之后脚本直接带 Cookie 访问，过期时用 refresh_token 续期。
  2. **驱动持久化 profile 的真 Chrome 走账号选择器**（对应「已登录过让你选」）：用一个已登录目标 Google 账号的 Chrome user-data-dir，自动化只需在账号选择器点选对应账号。

### 路线 A：Cookie 复用（无需每次过 Google）
```
1. 真浏览器完成一次 Google 登录，拿到 Cookie arena-auth-prod-v1（base64- 开头整段）。
2. 脚本请求时带 Header:
   Cookie: arena-auth-prod-v1=base64-XXXX...
3. 校验是否已登录：解码 Cookie → 取 user.is_anonymous；false 且 access_token 未过期即为已登录。
4. access_token 过期（expires_at 到点）时刷新：
   POST https://auth.arena.ai/auth/v1/token?grant_type=refresh_token
   Header: apikey: <SUPABASE_ANON_KEY>   content-type: application/json
   Body:   {"refresh_token":"<Cookie里的 refresh_token>"}
   → 返回新 access_token / refresh_token，重新拼回 arena-auth-prod-v1 Cookie。
```
> 注意：刷新需要 Supabase **anon apikey**。本次探测未在前端 JS / HTML 中找到明文 anon key（可能通过 BFF 注入或运行时下发）。抓一次真实登录后的网络请求（找发往 `auth.arena.ai/auth/v1/token` 的请求，其 `apikey` 请求头即是），或直接让 Arena 的 `/nextjs-api/*` 服务端代理刷新（服务端持有 key），是更省事的做法。

### 路线 B：Playwright 驱动真 Chrome（模拟「已登录过让你选」）
```python
from playwright.sync_api import sync_playwright

USER_DATA_DIR = "/path/to/chrome-profile-with-google-logged-in"  # 关键：该 profile 已登录目标 Google 账号
TARGET_EMAIL  = "you@gmail.com"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        USER_DATA_DIR, headless=False,           # Google 基本拒绝 headless
        channel="chrome",                          # 用真 Chrome，不用 bundled chromium
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = ctx.new_page()

    # 直接发起 Google 登录（跳过点按钮）
    page.goto("https://arena.ai/nextjs-api/sign-in/google"
              "?shouldLinkHistory=true&marketingConsent=false&registeredCountryCode=JP&returnTo=%2F")

    # —— 分叉点 ——
    # 已登录过：出现账号选择器，点目标账号
    try:
        page.wait_for_url("**/accounts.google.com/**", timeout=15000)
        picker = page.locator(f'[data-identifier="{TARGET_EMAIL}"]')
        if picker.count():
            picker.first.click()                 # 已登录过 → 直接选账号
        else:
            # 未登录过 → 走输入邮箱/密码流程
            page.fill('input[type=email]', TARGET_EMAIL); page.click('#identifierNext')
            page.fill('input[type=password]', "<password>"); page.click('#passwordNext')
        # 若出现同意页（首次授权）点继续
        cont = page.get_by_role("button", name=lambda n: n and ("Continue" in n or "继续" in n or "Allow" in n))
        if cont.count(): cont.first.click()
    except Exception:
        pass

    # 回到 arena 即成功
    page.wait_for_url("https://arena.ai/**", timeout=30000)

    # 导出会话 Cookie 供后续复用
    cookies = ctx.cookies("https://arena.ai")
    auth = next(c for c in cookies if c["name"] == "arena-auth-prod-v1")
    print(auth["value"])
    ctx.close()
```

### 判断「新账号 vs 已登录过」的信号
| 阶段 | 未登录过 | 已登录过 |
|---|---|---|
| Google 页面 | 邮箱/密码输入框（`input[type=email]`） | 账号选择器列表（多个 `[data-identifier="邮箱"]` 卡片） |
| 同意页 | 出现 Arena 授权同意页 | 通常跳过（曾授权则不再问） |
| 回到 Arena 后 | 新建 Arena 用户；Cookie user.is_anonymous=false 且首次 | 关联到已有 Arena 用户 |
| 前端表现 | 需补资料/引导 | 直接进已有账号+历史 |

> 站点侧无法区分两者——都是同一 `sign-in` 动作；真正「有记录让你选」的记忆体在 Google 的 `accounts.google.com` Cookie 里。

---

## 4.5 两步验证 (2FA / MFA) 分支 —— 位于 Google 侧

> ⚠️ 重要事实边界：2FA 质询页只在"密码正确"后由 `accounts.google.com` 弹出，
> Arena / auth.arena.ai 完全不介入。本节的选择器基于 Google **标准质询 UI**
> （长期稳定，但 Google 会不定期改版，且各账号可用方式不同），**本次未用真实账号触发验证**，
> 首次接入务必用你的真实账号 dump 一次实际页面校准选择器。

### 触发时机
`#passwordNext` 点击后，Google 分三种走向：
1. 账号无 2FA → 直接授权/回调，无本节步骤。
2. 账号只配了一种 2FA → 直接进入该方式的质询页。
3. 账号配了多种 2FA → 先进**方式选择页**（"选择验证方式 / Choose how you want to sign in"）。
   任意质询页通常都有"**Try another way / 尝试其他方式**"链接可回到选择页。

### 各 2FA 方式的页面与选择器（Google 标准）
| 方式 | 页面文案 | 输入/操作元素 | 可否程序化 |
|---|---|---|---|
| **验证器 App (TOTP)** | "Get a verification code from Google Authenticator" | `input#totpPin` / `input[name="totpPin"]` → `#totpNext` | ✅ 最适合自动化（用共享密钥 + pyotp 生成） |
| **短信/语音验证码** | "A text message with a code…" | `input#idvPin` / `input[name="Pin"]` → 提交 | ⚠️ 需带外读短信 |
| **Google 手机提示 (Tap Yes)** | "Check your phone / 轻点是" | 无输入，等另一台设备点确认 | ❌ 需真人/设备，建议切到 TOTP |
| **备用码 (Backup codes)** | "Enter one of your backup codes" | `input#backupCodePinInput` / `input[name="backupCode"]` | ✅ 可用一次性码 |
| **安全密钥 / Passkey (WebAuthn)** | "Use your security key / passkey" | WebAuthn API | ❌ 基本无法用 DOM 自动化 |
| **方式选择页** | "选择验证方式" | 列表项按文案/`[data-challengetype]` 点选；"Try another way"链接 | — |

### 自动化推荐策略（强烈建议）
为让流程可全自动，**给目标 Google 账号配一个你自己掌握密钥的验证器 (TOTP)**，用 `pyotp` 生成验证码：

```python
import pyotp

TOTP_SECRET = "<你在 Google 两步验证里保存的 Authenticator 密钥>"  # base32

def handle_2fa(page):
    # 密码提交后，可能停在某个质询页或选择页
    page.wait_for_timeout(2000)
    url = page.url
    if "challenge" not in url and "signin/v2" not in url and "accounts.google.com" not in url:
        return  # 无 2FA，已跳走

    # 1) 若在选择页 / 非 TOTP 页，尽量切到验证器路径
    try:
        another = page.get_by_text(lambda t: t and ("Try another way" in t or "尝试其他方式" in t))
        # 若当前不是 TOTP 页，就点"其他方式"再选验证器
        if page.locator('input#totpPin').count() == 0 and another.count():
            another.first.click()
            page.wait_for_timeout(1000)
        # 在选择页点"Google Authenticator / 身份验证器"
        opt = page.get_by_text(lambda t: t and ("Authenticator" in t or "身份验证器" in t or "验证器" in t))
        if page.locator('input#totpPin').count() == 0 and opt.count():
            opt.first.click()
            page.wait_for_timeout(1000)
    except Exception:
        pass

    # 2) 填入 TOTP
    if page.locator('input#totpPin').count():
        page.fill('input#totpPin', pyotp.TOTP(TOTP_SECRET).now())
        page.click('#totpNext')
        page.wait_for_timeout(2000)
        return

    # 3) 短信验证码（需你带外提供，如从短信网关读取）
    if page.locator('input#idvPin').count():
        code = get_sms_code()          # 你自己实现
        page.fill('input#idvPin', code)
        page.keyboard.press('Enter')
        return

    # 4) 手机提示/安全密钥：无法程序化，抛出让人工介入
    raise RuntimeError("遇到 Google 手机提示或安全密钥，需人工确认")
```

把 `handle_2fa(page)` 插在路线 B 的「填密码 `#passwordNext` 之后、等待回到 arena 之前」。

### 常见坑
- **"此浏览器或应用可能不安全"**：自动化被 Google 识别时会卡在这里，连密码页都过不去。对策：用**持久化的真实 Chrome profile**（`channel="chrome"`、非 headless、`--disable-blink-features=AutomationControlled`，或 undetected-chromedriver），最好该 profile 平时就人工登录过 Google。
- **TOTP 有 30s 时窗**：生成后尽快提交；跨窗口失败就重取 `pyotp...now()` 重填。
- **验证码/提示页文案随语言变化**：按 `input` 的 `id`（`totpPin`/`idvPin`/`backupCodePinInput`）匹配比按文案稳。
- **只想登录一次**：过完 2FA 后立即导出 `arena-auth-prod-v1` Cookie，改用路线 A（Cookie + refresh_token）续期，就再也不用碰 2FA。

## 5. 自动化最小步骤清单

1. 用真 Chrome（持久化 profile，已登录目标 Google 账号）。
2. 可选：先访问 `https://arena.ai/` 拿到匿名 `arena-auth-prod-v1` + `-code-verifier` Cookie（要合并历史才需要）。
3. 导航 `GET /nextjs-api/sign-in/google?shouldLinkHistory=true&marketingConsent=false&registeredCountryCode=<国家码>&returnTo=/`。
4. 在 `accounts.google.com`：
   - 有账号选择器 → 点 `[data-identifier="目标邮箱"]`；
   - 没有 → 填邮箱→`#identifierNext`→填密码→`#passwordNext`（+2FA）；
   - **密码正确后如有两步验证，Google 会弹出验证方式**：优先走验证器 TOTP（`input#totpPin`→`#totpNext`，见 §4.5），配了多种时会先出方式选择页；
   - 有同意页 → 点「继续/Allow」。
5. 等待 URL 回到 `https://arena.ai/**`（中途会经过 `auth.arena.ai/auth/v1/callback` → `arena.ai/nextjs-api/callback/google`，全自动 302，无需干预）。
6. 校验：Cookie `arena-auth-prod-v1` 存在且解码后 `user.is_anonymous=false` → 登录成功。若出现 `__arena_auth_error` Cookie 则失败，解码看 message。
7. 导出 `arena-auth-prod-v1`（含 refresh_token）持久化；后续用路线 A 直接带 Cookie，过期用 refresh_token 续期，避免每次过 Google。

---

## 6. 待补充（本次未拿到的值）
- **Supabase anon apikey**：前端未明文暴露；刷新 token 或直连 GoTrue 需要它。抓一次真实登录的 `auth.arena.ai/auth/v1/token` 请求头 `apikey` 即得，或走 Arena 服务端代理。
- 真实成功回调写入的完整 `arena-auth-prod-v1` 结构（登录态、非匿名）：需一次真实 Google 登录后 dump。
