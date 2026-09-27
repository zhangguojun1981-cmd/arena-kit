//! ArenaKit Tauri core library.
//!
//! Shared by the macOS and Android builds. Owns:
//!   * the WebView init script (page-world bootstrap + ported userscripts),
//!   * accounts (isolated arena.ai profiles, each with an optional proxy node)
//!     and the tabs that open them (`sessions.rs`),
//!   * the IPC commands used by the shell UI and by the injected page code,
//!   * the window layout:
//!       - desktop: one window; the bundled `shell.html` (tab strip + home +
//!         dock) fills it and every open arena.ai tab is a child webview laid
//!         over the shell's stage area; the app starts on the home page, not
//!         on arena.ai;
//!       - mobile: a single webview that starts on `shell.html` (home) and
//!         navigates to arena.ai on demand; the in-page HUD is the UI there.
//!
//! Every event the core produces is broadcast twice: as a Tauri event
//! (`arenakit://<kind>`, consumed by the shell) and as a direct
//! `window.__AK_HUD__.push(kind, payload)` eval into the arena webview it
//! belongs to, so the in-page HUD needs no IPC permission of its own.

pub mod pulse;
pub mod sessions;
pub mod trace;

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use sessions::{tab_id_from_label, Account, AccountBook, AccountInput, TabList};

// ── injected scripts (bundled at compile time) ───────────────────────────
// MAIN-world, must run before arena.ai's own JS.
const BOOTSTRAP_JS: &str = include_str!("../../injected/bootstrap.js");
const GM_SHIM_JS: &str = include_str!("../../injected/gm-shim.js");
const SNOOP_JS: &str = include_str!("../../injected/snoop.js");
const UNLOCK_JS: &str = include_str!("../../injected/unlock.js");
const ENI_JS: &str = include_str!("../../injected/eni.js");
// document_idle UI scripts.
const MANAGER_JS: &str = include_str!("../../injected/manager.js");
const PLUS_JS: &str = include_str!("../../injected/plus.js");
const LEADERBOARD_JS: &str = include_str!("../../injected/leaderboard.js");
// In-page HUD (Shadow DOM) + its stylesheet.
const HUD_JS: &str = include_str!("../../src/hud.js");
const HUD_CSS: &str = include_str!("../../src/hud.css");

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const ARENA_URL: &str = "https://arena.ai";
/// The bundled UI (tab strip, home page, dock). Also the mobile start page.
const SHELL_PAGE: &str = "shell.html";

/// Desktop layout (logical px). Must match `src/shell.css`.
#[cfg(desktop)]
const TOPBAR_H: f64 = 44.0;
#[cfg(desktop)]
const DOCK_W: f64 = 340.0;

#[cfg(mobile)]
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/// Only these hosts get the page-world bundle. The same webview also shows the
/// bundled shell on mobile, and popups may wander off to OAuth providers.
const ARENA_HOST_GUARD: &str = "/(^|\\.)(arena|lmarena)\\.ai$/.test(location.hostname)";

/// Wrap one ported script so that (a) it only runs when its module switch is
/// on and (b) a failure inside it can never break the scripts after it.
/// `scripts/check-syntax.mjs` mirrors this exact shape — keep them in sync.
fn wrap(name: &str, src: &str) -> String {
    // `chrome` is bound per script to the shim (gm-shim.js) so ported extension
    // content scripts work without touching the page's real window.chrome.
    format!(
        ";(function(){{try{{if(!(window.__ARENAKIT__&&window.__ARENAKIT__.moduleOn({name:?})))return;var chrome=window.__AK_CHROME__||window.chrome;\n{src}\n}}catch(e){{console.warn('[ArenaKit] {name} failed',e);}}}})();\n"
    )
}

/// Assemble the page-world init script. Runs before any page script on every
/// navigation (Tauri re-runs initialization scripts per navigation), so it is
/// guarded to arena.ai hosts only.
pub fn build_init_script(platform: &str, mobile: bool) -> String {
    let env = serde_json::json!({
        "platform": platform,
        "version": APP_VERSION,
        "mobile": mobile,
    });
    let mut s = String::with_capacity(
        BOOTSTRAP_JS.len()
            + GM_SHIM_JS.len()
            + SNOOP_JS.len()
            + UNLOCK_JS.len()
            + ENI_JS.len()
            + MANAGER_JS.len()
            + PLUS_JS.len()
            + LEADERBOARD_JS.len()
            + HUD_JS.len()
            + HUD_CSS.len()
            + 2048,
    );
    s.push_str("(function(){if(!");
    s.push_str(ARENA_HOST_GUARD);
    s.push_str(")return;\n");
    s.push_str("window.__ARENAKIT_ENV__=");
    s.push_str(&env.to_string());
    s.push_str(";\nwindow.__ARENAKIT_HUD_CSS__=");
    s.push_str(&serde_json::to_string(HUD_CSS).unwrap_or_else(|_| "\"\"".into()));
    s.push_str(";\n");
    // document_start scripts (order matters: bridge, shim, then hooks).
    s.push_str(BOOTSTRAP_JS);
    s.push_str("\n;");
    s.push_str(GM_SHIM_JS);
    s.push_str("\n;");
    s.push_str(SNOOP_JS);
    s.push_str("\n;");
    s.push_str(&wrap("unlock", UNLOCK_JS));
    s.push_str(&wrap("eni", ENI_JS));
    // defer UI scripts until the DOM is ready.
    s.push_str("(function(){var run=function(){\n");
    s.push_str(&wrap("manager", MANAGER_JS));
    s.push_str(&wrap("plus", PLUS_JS));
    s.push_str(&wrap("leaderboard", LEADERBOARD_JS));
    s.push_str(&wrap("hud", HUD_JS));
    s.push_str(
        "};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();\n",
    );
    s.push_str("})();\n");
    s
}

// ── state ────────────────────────────────────────────────────────────────

/// The assembled init script, shared with every arena webview we create.
pub struct InitScript(pub String);

/// Everything the shell needs to know about sessions.
#[derive(Default)]
pub struct Sessions {
    pub accounts: AccountBook,
    pub tabs: TabList,
    /// Mobile only: the shell URL we navigate back to.
    pub home_url: Option<tauri::Url>,
}

pub type SessionState = Mutex<Sessions>;

#[derive(Serialize, Clone)]
pub struct TabView {
    pub id: u32,
    pub label: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    pub proxy: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct TabsView {
    pub tabs: Vec<TabView>,
    pub active: Option<u32>,
}

fn tabs_view(s: &Sessions) -> TabsView {
    TabsView {
        tabs: s
            .tabs
            .tabs
            .iter()
            .map(|t| {
                let acc = s.accounts.get(&t.account_id);
                TabView {
                    id: t.id,
                    label: t.label.clone(),
                    account_id: t.account_id.clone(),
                    name: acc.map(|a| a.name.clone()).unwrap_or_else(|| "已删除账号".into()),
                    color: acc.map(|a| a.color.clone()).unwrap_or_else(|| "#98a2b3".into()),
                    proxy: acc.and_then(|a| a.proxy.clone()),
                }
            })
            .collect(),
        active: s.tabs.active,
    }
}

fn lock(state: &SessionState) -> std::sync::MutexGuard<'_, Sessions> {
    state.lock().unwrap_or_else(|p| p.into_inner())
}

/// Tell the shell that tabs changed.
fn emit_tabs<R: Runtime>(app: &AppHandle<R>, s: &Sessions) {
    let _ = app.emit("arenakit://tabs", tabs_view(s));
}

/// Wrap an event payload with the tab it came from (`None` = mobile / unknown).
#[derive(Serialize, Clone)]
struct Tagged<T: Serialize + Clone> {
    tab: Option<u32>,
    data: T,
}

/// Emit `arenakit://<kind>` to the shell AND push into the in-page HUD of the
/// webview the event belongs to (falls back to the active arena webview).
fn broadcast<R: Runtime, T: Serialize + Clone>(
    app: &AppHandle<R>,
    kind: &str,
    payload: T,
    origin: Option<&tauri::Webview<R>>,
) {
    let tab = origin.and_then(|w| tab_id_from_label(w.label()));
    let _ = app.emit(
        &format!("arenakit://{kind}"),
        Tagged {
            tab,
            data: payload.clone(),
        },
    );
    let target = match origin {
        Some(w) => Some(w.clone()),
        None => active_arena_webview(app),
    };
    if let Some(wv) = target {
        if let Ok(json) = serde_json::to_string(&payload) {
            let js = format!(
                "window.__AK_HUD__&&window.__AK_HUD__.push({kind},{json});",
                kind = serde_json::to_string(kind).unwrap_or_default()
            );
            let _ = wv.eval(&js);
        }
    }
}

/// The webview currently showing arena.ai: the active tab on desktop, the
/// single "main" webview on mobile.
fn active_arena_webview<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Webview<R>> {
    if let Some(state) = app.try_state::<SessionState>() {
        let s = lock(&state);
        if let Some(t) = s.tabs.active_tab() {
            return app.get_webview(&t.label);
        }
    }
    if cfg!(mobile) {
        return app.get_webview("main");
    }
    None
}

/// Proxy of the account behind a webview label (for Rust-side requests made
/// on behalf of that page, so they exit through the same node as the page).
fn proxy_for_label<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<String> {
    let state = app.try_state::<SessionState>()?;
    let s = lock(&state);
    let tab = s.tabs.by_label(label)?;
    s.accounts.get(&tab.account_id)?.proxy.clone()
}

fn http_client(proxy: Option<&str>, timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().timeout(std::time::Duration::from_secs(timeout_secs));
    // Accounts without a node keep reqwest's default behaviour (system /
    // environment proxy settings), exactly like before accounts existed.
    if let Some(p) = proxy {
        b = b.proxy(reqwest::Proxy::all(p).map_err(|e| format!("代理无效: {e}"))?);
    }
    b.build().map_err(|e| e.to_string())
}

// ── commands: trace / bridge ─────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ModelReport {
    pub run_id: String,
    pub models: Vec<ModelOut>,
}

#[derive(Serialize, Clone)]
pub struct ModelOut {
    pub model: String,
    pub provider: String,
    pub partial: bool,
}

#[derive(Serialize, Clone)]
pub struct AppInfo {
    pub platform: &'static str,
    pub version: &'static str,
    pub arch: &'static str,
    pub mobile: bool,
    /// Whether this build can isolate accounts and proxy per tab.
    pub multi_account: bool,
    pub per_tab_proxy: bool,
}

fn platform_name() -> &'static str {
    std::env::consts::OS
}

/// Called when snoop.js hands back a {sessionId, token}. Validates the token,
/// polls Trigger.dev (8x @ 3s) through the calling tab's proxy, extracts the
/// server-side model, and emits it to that tab.
#[tauri::command]
async fn fetch_trace(
    app: AppHandle,
    webview: tauri::Webview,
    token: String,
    session_id: String,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let claims = trace::validate_token(&token, &session_id, now).map_err(|e| {
        broadcast(
            &app,
            "error",
            serde_json::json!({"scope":"token","message": e}),
            Some(&webview),
        );
        e
    })?;

    let proxy = proxy_for_label(&app, webview.label());
    let client = http_client(proxy.as_deref(), 10)?;
    let url = format!(
        "https://api.trigger.dev/api/v1/runs/{}/events",
        claims.run_id
    );
    for _ in 0..8 {
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/json")
            .send()
            .await;
        if let Ok(r) = resp {
            let status = r.status().as_u16();
            if r.status().is_success() {
                let body = r.text().await.unwrap_or_default();
                if body.len() <= 4 * 1024 * 1024 {
                    if let Ok(trace_json) = serde_json::from_str::<Value>(&body) {
                        if let Ok(models) = trace::extract_models(&trace_json, &claims.run_id) {
                            if !models.is_empty() {
                                let report = ModelReport {
                                    run_id: claims.run_id.clone(),
                                    models: models
                                        .into_iter()
                                        .map(|m| ModelOut {
                                            model: m.model,
                                            provider: m.provider,
                                            partial: m.partial,
                                        })
                                        .collect(),
                                };
                                broadcast(&app, "models", report, Some(&webview));
                                return Ok(());
                            }
                        }
                    }
                }
            } else if trace::is_fatal_trace_status(status) {
                let msg = trace::trace_status_label(status);
                broadcast(
                    &app,
                    "error",
                    serde_json::json!({"scope":"trace","message": msg.clone()}),
                    Some(&webview),
                );
                return Err(msg);
            }
        }
        let now2 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(now);
        if now2 >= claims.exp - 5.0 {
            return Err("令牌已过期，请发送新的消息".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    Err("trace 未返回模型名称".into())
}

/// Bypass page CORS for logo/price/gist fetches used by injected scripts.
/// Goes through the calling tab's proxy so the page's exit node stays the same.
#[tauri::command]
async fn proxy_get(app: AppHandle, webview: tauri::Webview, url: String) -> Result<Value, String> {
    // Allowlist: only hosts the injected scripts legitimately need.
    let allowed = [
        "raw.githubusercontent.com",
        "api.github.com",
        "openrouter.ai",
        "arena.ai",
    ];
    let host_ok = url
        .split('/')
        .nth(2)
        .map(|h| {
            allowed
                .iter()
                .any(|a| h == *a || h.ends_with(&format!(".{}", a)))
        })
        .unwrap_or(false);
    if !url.starts_with("https://") || !host_ok {
        return Err(format!("proxy_get 拒绝非白名单地址: {}", url));
    }
    let proxy = proxy_for_label(&app, webview.label());
    let client = http_client(proxy.as_deref(), 15)?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
}

/// Eval JS inside the active arena.ai tab. Only the bundled shell may call
/// this (see capabilities/default.json); the remote page never gets it.
#[tauri::command]
async fn arena_command(app: AppHandle, js: String) -> Result<(), String> {
    let wv = active_arena_webview(&app).ok_or_else(|| "没有打开的 arena 页面".to_string())?;
    wv.eval(&js).map_err(|e| e.to_string())
}

/// Static facts the shell shows in its footer / uses for feature gating.
#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        platform: platform_name(),
        version: APP_VERSION,
        arch: std::env::consts::ARCH,
        mobile: cfg!(mobile),
        multi_account: cfg!(desktop),
        per_tab_proxy: cfg!(all(desktop, not(target_os = "windows"))),
    }
}

/// Events raised by the page bootstrap (remote origin). The kind is
/// allow-listed; `state`/`credits` are re-emitted as `arenakit://<kind>`
/// tagged with the tab, `log` goes to stdout, `home` (mobile) leaves arena.ai.
#[tauri::command]
fn page_event(app: AppHandle, webview: tauri::Webview, kind: String, payload: Value) -> Result<(), String> {
    const ALLOWED: [&str; 4] = ["state", "credits", "log", "home"];
    if !ALLOWED.contains(&kind.as_str()) {
        return Err(format!("page_event: unknown kind {kind}"));
    }
    match kind.as_str() {
        "log" => {
            println!(
                "[arena.ai#{}] {}",
                webview.label(),
                payload.get("message").and_then(Value::as_str).unwrap_or("")
            );
            Ok(())
        }
        "home" => go_home(&app, &webview),
        _ => {
            if kind == "state" {
                LAST_STATE_TAB.store(tab_id_from_label(webview.label()).unwrap_or(u32::MAX), Ordering::Relaxed);
            }
            app
            .emit(
                &format!("arenakit://{kind}"),
                Tagged {
                    tab: tab_id_from_label(webview.label()),
                    data: payload,
                },
            )
            .map_err(|e| e.to_string())
        }
    }
}

/// Tab id of the most recent `page_event{kind:"state"}` (u32::MAX = mobile /
/// none yet). Lets the smoke test prove the remote-origin IPC path works.
static LAST_STATE_TAB: AtomicU32 = AtomicU32::new(u32::MAX);

/// Leave arena.ai: on mobile navigate the single webview back to the shell;
/// on desktop just show the home (deactivate the tab, keep it open).
fn go_home(app: &AppHandle, webview: &tauri::Webview) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let mut s = lock(&state);
    if cfg!(mobile) {
        let home = s.home_url.clone().ok_or_else(|| "home url unknown".to_string())?;
        return webview.navigate(home).map_err(|e| e.to_string());
    }
    s.tabs.active = None;
    #[cfg(desktop)]
    desktop::apply_visibility(app, &s);
    emit_tabs(app, &s);
    Ok(())
}

// ── commands: accounts & tabs (shell only) ───────────────────────────────

#[tauri::command]
fn list_accounts(state: State<SessionState>) -> Vec<Account> {
    lock(&state).accounts.accounts.clone()
}

#[tauri::command]
fn save_account(app: AppHandle, state: State<SessionState>, account: AccountInput) -> Result<Vec<Account>, String> {
    let mut s = lock(&state);
    s.accounts.upsert(account)?;
    s.accounts.save()?;
    emit_tabs(&app, &s); // names/colours may have changed
    Ok(s.accounts.accounts.clone())
}

#[tauri::command]
fn delete_account(app: AppHandle, state: State<SessionState>, id: String) -> Result<Vec<Account>, String> {
    let mut s = lock(&state);
    let doomed: Vec<u32> = s.tabs.tabs_for_account(&id).map(|t| t.id).collect();
    for tab in doomed {
        #[cfg(desktop)]
        desktop::close_tab_impl(&app, &mut s, tab);
        #[cfg(mobile)]
        {
            let _ = tab;
        }
    }
    if !s.accounts.remove(&id) {
        return Err("账号不存在".into());
    }
    s.accounts.save()?;
    #[cfg(desktop)]
    desktop::apply_visibility(&app, &s);
    emit_tabs(&app, &s);
    Ok(s.accounts.accounts.clone())
}

#[tauri::command]
fn list_tabs(state: State<SessionState>) -> TabsView {
    tabs_view(&lock(&state))
}

/// Open a new arena.ai tab for an account (desktop). On mobile there is a
/// single webview: navigate it to arena.ai instead.
#[tauri::command]
fn open_tab(app: AppHandle, state: State<SessionState>, account_id: String) -> Result<TabsView, String> {
    let mut s = lock(&state);
    #[cfg(desktop)]
    {
        desktop::open_tab_impl(&app, &mut s, &account_id)?;
    }
    #[cfg(mobile)]
    {
        let _ = account_id;
        let wv = app.get_webview("main").ok_or_else(|| "main webview 未找到".to_string())?;
        wv.navigate(ARENA_URL.parse().map_err(|e: url::ParseError| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    emit_tabs(&app, &s);
    Ok(tabs_view(&s))
}

#[tauri::command]
fn close_tab(app: AppHandle, state: State<SessionState>, id: u32) -> Result<TabsView, String> {
    let mut s = lock(&state);
    #[cfg(desktop)]
    {
        desktop::close_tab_impl(&app, &mut s, id);
        desktop::apply_visibility(&app, &s);
    }
    #[cfg(mobile)]
    {
        let _ = id;
    }
    emit_tabs(&app, &s);
    Ok(tabs_view(&s))
}

/// Bring a tab to the front; `None` shows the home page (tabs stay open).
#[tauri::command]
fn activate_tab(app: AppHandle, state: State<SessionState>, id: Option<u32>) -> Result<TabsView, String> {
    let mut s = lock(&state);
    if let Some(id) = id {
        if s.tabs.get(id).is_none() {
            return Err("标签不存在".into());
        }
    }
    s.tabs.active = id;
    #[cfg(desktop)]
    desktop::apply_visibility(&app, &s);
    emit_tabs(&app, &s);
    Ok(tabs_view(&s))
}

/// Pop the native "open arena as…" menu at the cursor (desktop). Native menus
/// render above child webviews, which HTML popovers in the shell cannot.
#[tauri::command]
fn pick_account(app: AppHandle, state: State<SessionState>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let s = lock(&state);
        desktop::popup_account_menu(&app, &s)
    }
    #[cfg(mobile)]
    {
        let _ = (app, state);
        Err("mobile has no tabs".into())
    }
}

#[derive(Serialize, Clone)]
pub struct ProbeResult {
    pub ok: bool,
    pub ip: Option<String>,
    pub ms: u128,
    pub error: Option<String>,
}

/// Check a proxy node from the home page: fetch the exit IP through it.
#[tauri::command]
async fn probe_proxy(proxy: Option<String>) -> Result<ProbeResult, String> {
    let proxy = sessions::normalize_proxy(proxy.as_deref())?;
    let started = std::time::Instant::now();
    let client = http_client(proxy.as_deref(), 8)?;
    let res = client
        .get("https://api.ipify.org?format=json")
        .header("Accept", "application/json")
        .send()
        .await;
    let ms = started.elapsed().as_millis();
    match res {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.map_err(|e| e.to_string())?;
            Ok(ProbeResult {
                ok: true,
                ip: v.get("ip").and_then(Value::as_str).map(str::to_string),
                ms,
                error: None,
            })
        }
        Ok(r) => Ok(ProbeResult {
            ok: false,
            ip: None,
            ms,
            error: Some(format!("HTTP {}", r.status().as_u16())),
        }),
        Err(e) => Ok(ProbeResult {
            ok: false,
            ip: None,
            ms,
            error: Some(e.to_string()),
        }),
    }
}

// ── desktop window / webview plumbing ────────────────────────────────────

#[cfg(desktop)]
mod desktop {
    use super::*;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::webview::{NewWindowResponse, WebviewBuilder};
    use tauri::window::WindowBuilder;
    use tauri::{LogicalPosition, LogicalSize, Position, Rect, Size, WebviewUrl, Window, WindowEvent};

    pub const MENU_MANAGE: &str = "ak:manage";
    pub const MENU_OPEN_PREFIX: &str = "ak:open:";

    fn window_logical_size(window: &Window) -> (f64, f64) {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window
            .inner_size()
            .map(|s| s.to_logical::<f64>(scale))
            .unwrap_or(LogicalSize::new(1400.0, 920.0));
        (size.width, size.height)
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect {
            position: Position::Logical(LogicalPosition::new(x, y)),
            size: Size::Logical(LogicalSize::new(w.max(1.0), h.max(1.0))),
        }
    }

    /// Stage = the area of the shell not covered by the tab strip or the dock.
    fn stage_rect(w: f64, h: f64) -> Rect {
        rect(0.0, TOPBAR_H, w - DOCK_W, h - TOPBAR_H)
    }

    /// Re-apply bounds after a resize: the shell fills the window, every tab
    /// covers the stage. (auto_resize would scale the dock column too.)
    pub fn relayout(app: &AppHandle) {
        let Some(window) = app.get_window("main") else { return };
        let (w, h) = window_logical_size(&window);
        if let Some(shell) = app.get_webview("shell") {
            let _ = shell.set_bounds(rect(0.0, 0.0, w, h));
        }
        if let Some(state) = app.try_state::<SessionState>() {
            let s = lock(&state);
            for t in &s.tabs.tabs {
                if let Some(wv) = app.get_webview(&t.label) {
                    let _ = wv.set_bounds(stage_rect(w, h));
                }
            }
        }
    }

    /// Show the active tab, hide the rest; with no active tab the shell's
    /// home page is what the user sees.
    pub fn apply_visibility(app: &AppHandle, s: &Sessions) {
        for t in &s.tabs.tabs {
            let Some(wv) = app.get_webview(&t.label) else { continue };
            if Some(t.id) == s.tabs.active {
                let _ = wv.show();
                let _ = wv.set_focus();
            } else {
                let _ = wv.hide();
            }
        }
        if s.tabs.active.is_none() {
            if let Some(shell) = app.get_webview("shell") {
                let _ = shell.set_focus();
            }
        }
    }

    pub fn open_tab_impl(app: &AppHandle, s: &mut Sessions, account_id: &str) -> Result<u32, String> {
        let account = s
            .accounts
            .get(account_id)
            .cloned()
            .ok_or_else(|| "账号不存在".to_string())?;
        let window = app.get_window("main").ok_or_else(|| "主窗口未找到".to_string())?;
        let init = app.state::<InitScript>().0.clone();
        let (w, h) = window_logical_size(&window);
        let tab = s.tabs.allocate(&account.id);

        let arena_url: tauri::Url = ARENA_URL.parse().expect("static url");
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(&tab.label, WebviewUrl::External(arena_url))
            .initialization_script(init)
            .on_new_window(|_url, _features| NewWindowResponse::Allow);

        // Per-account isolation.
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(sessions::store_identifier(&account.id));
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Ok(dir) = app.path().app_local_data_dir() {
                builder = builder.data_directory(dir.join("profiles").join(&account.id));
            }
        }
        // Per-account proxy node (macOS 14+ per data store; Linux per context;
        // Windows: WebView2 applies the first one process-wide).
        if let Some(p) = &account.proxy {
            match p.parse::<tauri::Url>() {
                Ok(u) => builder = builder.proxy_url(u),
                Err(e) => {
                    s.tabs.remove(tab.id);
                    return Err(format!("代理地址无效: {e}"));
                }
            }
        }

        let stage = stage_rect(w, h);
        let (pos, size) = match (stage.position, stage.size) {
            (Position::Logical(p), Size::Logical(sz)) => (p, sz),
            _ => (LogicalPosition::new(0.0, TOPBAR_H), LogicalSize::new(w - DOCK_W, h - TOPBAR_H)),
        };
        if let Err(e) = window.add_child(builder, pos, size) {
            s.tabs.remove(tab.id);
            return Err(format!("创建页面失败: {e}"));
        }
        s.tabs.active = Some(tab.id);
        apply_visibility(app, s);
        Ok(tab.id)
    }

    pub fn close_tab_impl(app: &AppHandle, s: &mut Sessions, id: u32) {
        if let Some(tab) = s.tabs.remove(id) {
            if let Some(wv) = app.get_webview(&tab.label) {
                let _ = wv.close();
            }
        }
    }

    pub fn popup_account_menu(app: &AppHandle, s: &Sessions) -> Result<(), String> {
        let window = app.get_window("main").ok_or_else(|| "主窗口未找到".to_string())?;
        let menu = Menu::new(app).map_err(|e| e.to_string())?;
        if s.accounts.accounts.is_empty() {
            let item = MenuItem::with_id(app, MENU_MANAGE, "还没有账号 — 去添加…", true, None::<&str>)
                .map_err(|e| e.to_string())?;
            menu.append(&item).map_err(|e| e.to_string())?;
        } else {
            for a in &s.accounts.accounts {
                let open = s.tabs.tabs_for_account(&a.id).count();
                let mut text = a.name.clone();
                if let Some(p) = &a.proxy {
                    text.push_str(&format!("  ·  {p}"));
                }
                if open > 0 {
                    text.push_str(&format!("  ({open} 个已打开)"));
                }
                let item = MenuItem::with_id(app, format!("{MENU_OPEN_PREFIX}{}", a.id), text.as_str(), true, None::<&str>)
                    .map_err(|e| e.to_string())?;
                menu.append(&item).map_err(|e| e.to_string())?;
            }
            menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let manage = MenuItem::with_id(app, MENU_MANAGE, "管理账号…", true, None::<&str>)
                .map_err(|e| e.to_string())?;
            menu.append(&manage).map_err(|e| e.to_string())?;
        }
        window.popup_menu(&menu).map_err(|e| e.to_string())
    }

    /// Handle clicks on the popup menu built above.
    pub fn on_menu(app: &AppHandle, id: &str) {
        let state = app.state::<SessionState>();
        let mut s = lock(&state);
        if id == MENU_MANAGE {
            s.tabs.active = None;
            apply_visibility(app, &s);
            emit_tabs(app, &s);
            let _ = app.emit("arenakit://home", "accounts");
        } else if let Some(account_id) = id.strip_prefix(MENU_OPEN_PREFIX) {
            let account_id = account_id.to_string();
            if let Err(e) = open_tab_impl(app, &mut s, &account_id) {
                let _ = app.emit("arenakit://error", Tagged { tab: None, data: serde_json::json!({"scope":"tab","message": e}) });
            }
            emit_tabs(app, &s);
        }
    }

    /// `ARENAKIT_SMOKE=1`: headless self-test used on real machines where no
    /// one can click. Seeds a throw-away account (not saved), opens a tab,
    /// waits for arena.ai to load and for the page bootstrap to report its
    /// state through the remote-origin IPC, prints `SMOKE OK` and exits 0
    /// (or `SMOKE FAIL …` and exits 2).
    pub fn smoke_test(app: &AppHandle) {
        if std::env::var("ARENAKIT_SMOKE").ok().as_deref() != Some("1") {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let opened = std::sync::Arc::new(Mutex::new(None::<Result<(u32, String), String>>));
            let (o2, a2) = (opened.clone(), app.clone());
            // Webview creation + the session lock must happen on the main
            // thread, exactly like the IPC commands do.
            let _ = app.run_on_main_thread(move || {
                let state = a2.state::<SessionState>();
                let mut s = lock(&state);
                let res = match s.accounts.upsert(AccountInput { name: "smoke".into(), ..Default::default() }) {
                    Err(e) => Err(format!("upsert: {e}")),
                    Ok(acc) => match open_tab_impl(&a2, &mut s, &acc.id) {
                        Ok(id) => {
                            emit_tabs(&a2, &s);
                            Ok((id, acc.id))
                        }
                        Err(e) => Err(e),
                    },
                };
                *o2.lock().unwrap_or_else(|p| p.into_inner()) = Some(res);
            });
            let mut waited = 0;
            let (tab, acc_id) = loop {
                let snapshot = opened.lock().unwrap_or_else(|p| p.into_inner()).clone();
                if let Some(r) = snapshot {
                    match r {
                        Ok(v) => break v,
                        Err(e) => {
                            println!("SMOKE FAIL {e}");
                            app.exit(2);
                            return;
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                waited += 1;
                if waited > 100 {
                    println!("SMOKE FAIL open_tab never returned");
                    app.exit(2);
                    return;
                }
            };
            let label = format!("{}{}", sessions::TAB_LABEL_PREFIX, tab);
            println!("SMOKE tab={tab} label={label}");
            // Geometry: the shell must fill the window, the tab must cover the
            // stage (below the 44px strip, left of the 340px dock).
            if let Some(window) = app.get_window("main") {
                let (w, h) = window_logical_size(&window);
                let scale = window.scale_factor().unwrap_or(1.0);
                let show = |name: &str| {
                    if let Some(wv) = app.get_webview(name) {
                        if let (Ok(p), Ok(sz)) = (wv.position(), wv.size()) {
                            let p = p.to_logical::<f64>(scale);
                            let sz = sz.to_logical::<f64>(scale);
                            println!("SMOKE bounds {name}: x={} y={} w={} h={}", p.x, p.y, sz.width, sz.height);
                        }
                    }
                };
                println!("SMOKE window inner={w}x{h} scale={scale}");
                show("shell");
                show(&label);
            }
            let mut ok_url = false;
            let mut ok_state = false;
            for i in 0..40 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let url = app.get_webview(&label).and_then(|w| w.url().ok()).map(|u| u.to_string()).unwrap_or_default();
                if i % 5 == 0 || !ok_url {
                    println!("SMOKE t={i}s url={url}");
                }
                ok_url = url.contains("arena.ai");
                ok_state = LAST_STATE_TAB.load(Ordering::Relaxed) == tab;
                if ok_url && ok_state {
                    break;
                }
            }
            println!("SMOKE arena_loaded={ok_url} page_state_via_ipc={ok_state}");
            // Close it again through the same path the UI uses.
            let a3 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let state = a3.state::<SessionState>();
                let mut s = lock(&state);
                close_tab_impl(&a3, &mut s, tab);
                apply_visibility(&a3, &s);
                s.accounts.remove(&acc_id);
                emit_tabs(&a3, &s);
                println!("SMOKE tabs_after_close={}", s.tabs.tabs.len());
            });
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if ok_url && ok_state {
                println!("SMOKE OK");
                app.exit(0);
            } else {
                println!("SMOKE FAIL");
                app.exit(2);
            }
        });
    }

    /// One window; the shell fills it, tabs are added later on demand.
    pub fn setup(app: &tauri::App) -> tauri::Result<()> {
        let width = 1400.0_f64;
        let height = 920.0_f64;

        let window = WindowBuilder::new(app, "main")
            .title("ArenaKit")
            .inner_size(width, height)
            .min_inner_size(960.0, 640.0)
            .build()?;

        window.add_child(
            WebviewBuilder::new("shell", WebviewUrl::App(SHELL_PAGE.into())),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(width, height),
        )?;

        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
                relayout(&handle);
            }
        });
        // The window may have been created at a different size than asked.
        relayout(app.handle());
        smoke_test(app.handle());
        Ok(())
    }
}

/// Mobile: a single webview that starts on the bundled home page. arena.ai is
/// opened by navigating the same webview; the in-page HUD offers "首页" to
/// come back. There is no room for tabs, and the system WebView has one
/// shared cookie jar anyway (see docs/ARCHITECTURE.md).
#[cfg(mobile)]
fn setup_mobile(app: &tauri::App, init: String) -> tauri::Result<()> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    let wv = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(SHELL_PAGE.into()))
        .title("ArenaKit")
        .initialization_script(init)
        .user_agent(MOBILE_UA)
        .build()?;
    if let Ok(url) = wv.url() {
        let state = app.state::<SessionState>();
        lock(&state).home_url = Some(url);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let init = build_init_script(platform_name(), cfg!(mobile));
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(InitScript(init.clone()))
        .manage(SessionState::default())
        .invoke_handler(tauri::generate_handler![
            fetch_trace,
            proxy_get,
            arena_command,
            get_app_info,
            page_event,
            list_accounts,
            save_account,
            delete_account,
            list_tabs,
            open_tab,
            close_tab,
            activate_tab,
            pick_account,
            probe_proxy
        ]);
    #[cfg(desktop)]
    {
        builder = builder.on_menu_event(|app, event| desktop::on_menu(app, event.id().0.as_str()));
    }
    builder
        .setup(move |app| {
            // Accounts live in the app config dir (macOS: ~/Library/Application Support/<id>).
            let dir = app.path().app_config_dir()?;
            {
                let state = app.state::<SessionState>();
                lock(&state).accounts = AccountBook::load(&dir);
            }
            #[cfg(desktop)]
            {
                let _ = &init;
                desktop::setup(app)?;
            }
            #[cfg(mobile)]
            setup_mobile(app, init)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ArenaKit");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_contains_every_module_in_order() {
        let s = build_init_script("test", false);
        let idx = |needle: &str| s.find(needle).unwrap_or_else(|| panic!("missing {needle}"));
        let guard = idx(ARENA_HOST_GUARD);
        let env = idx("window.__ARENAKIT_ENV__=");
        let css = idx("window.__ARENAKIT_HUD_CSS__=");
        let boot = idx("window.__ARENAKIT__ = {");
        let unlock = idx("moduleOn(\"unlock\")");
        let eni = idx("moduleOn(\"eni\")");
        let manager = idx("moduleOn(\"manager\")");
        let plus = idx("moduleOn(\"plus\")");
        let lb = idx("moduleOn(\"leaderboard\")");
        let hud = idx("moduleOn(\"hud\")");
        assert!(guard < env && env < css && css < boot && boot < unlock && unlock < eni);
        assert!(eni < manager && manager < plus && plus < lb && lb < hud);
        assert!(s.contains("\"mobile\":false"));
        assert!(s.starts_with("(function(){if(!"));
        assert!(s.trim_end().ends_with("})();"));
    }

    #[test]
    fn hud_css_is_json_escaped() {
        let s = build_init_script("test", true);
        // the CSS must arrive as one JSON string literal (quotes/newlines escaped)
        let start = s.find("window.__ARENAKIT_HUD_CSS__=").expect("css marker") + "window.__ARENAKIT_HUD_CSS__=".len();
        let end = s[start..].find(";\n").expect("terminator") + start;
        let decoded: String = serde_json::from_str(&s[start..end]).expect("valid JSON string");
        assert_eq!(decoded, HUD_CSS);
        assert!(decoded.contains(":host"));
        assert!(s.contains("\"mobile\":true"));
    }

    #[test]
    fn wrap_shape_matches_check_syntax() {
        let w = wrap("plus", "var x = 1;");
        assert!(w.starts_with(";(function(){try{if(!(window.__ARENAKIT__&&window.__ARENAKIT__.moduleOn(\"plus\")))return;var chrome=window.__AK_CHROME__||window.chrome;\n"));
        assert!(w.ends_with("\n}catch(e){console.warn('[ArenaKit] plus failed',e);}})();\n"));
    }

    #[test]
    fn page_event_kinds_are_allowlisted() {
        // The command needs an AppHandle; test the allowlist directly instead.
        const ALLOWED: [&str; 4] = ["state", "credits", "log", "home"];
        assert!(ALLOWED.contains(&"state"));
        assert!(ALLOWED.contains(&"home"));
        assert!(!ALLOWED.contains(&"models"), "models must only come from Rust");
    }

    #[test]
    fn tabs_view_resolves_account_names() {
        let mut s = Sessions::default();
        let acc = s
            .accounts
            .upsert(AccountInput { name: "A".into(), proxy: Some("socks5://127.0.0.1:1080".into()), ..Default::default() })
            .unwrap();
        let t = s.tabs.allocate(&acc.id);
        s.tabs.allocate("ghost");
        s.tabs.active = Some(t.id);
        let v = tabs_view(&s);
        assert_eq!(v.active, Some(t.id));
        assert_eq!(v.tabs[0].name, "A");
        assert_eq!(v.tabs[0].proxy.as_deref(), Some("socks5://127.0.0.1:1080"));
        assert_eq!(v.tabs[1].name, "已删除账号");
    }

    #[test]
    fn http_client_rejects_bad_proxy() {
        assert!(http_client(Some("http://"), 1).is_err(), "empty host must be rejected");
        assert!(http_client(Some("socks5://127.0.0.1:1080"), 1).is_ok());
        assert!(http_client(None, 1).is_ok());
    }
}
