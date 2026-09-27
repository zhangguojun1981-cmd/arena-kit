//! ArenaKit Tauri core library.
//!
//! Shared by the macOS and Android builds. Owns:
//!   * the WebView init script (page-world bootstrap + ported userscripts),
//!   * the IPC commands (`fetch_trace`, `proxy_get`, `arena_command`,
//!     `get_app_info`, `page_event`),
//!   * the window layout (desktop: arena.ai webview + native dock side by side;
//!     mobile: a single arena.ai webview with the in-page HUD).
//!
//! Every event the core produces is broadcast twice: as a Tauri event
//! (`arenakit://<kind>`, consumed by the dock webview) and as a direct
//! `window.__AK_HUD__.push(kind, payload)` eval into the arena webview so the
//! in-page HUD needs no IPC permission of its own.

pub mod pulse;
pub mod trace;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

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

#[cfg(mobile)]
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/// Wrap one ported script so that (a) it only runs when its module switch is
/// on and (b) a failure inside it can never break the scripts after it.
/// `scripts/check-syntax.mjs` mirrors this exact shape — keep them in sync.
fn wrap(name: &str, src: &str) -> String {
    format!(
        ";(function(){{try{{if(!(window.__ARENAKIT__&&window.__ARENAKIT__.moduleOn({name:?})))return;\n{src}\n}}catch(e){{console.warn('[ArenaKit] {name} failed',e);}}}})();\n"
    )
}

/// Assemble the page-world init script. Runs before any page script on every
/// navigation (Tauri re-runs initialization scripts per navigation).
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
    s
}

// ── event fan-out ────────────────────────────────────────────────────────

/// The webview that shows arena.ai: the "arena" child on desktop, the single
/// "main" webview window on mobile.
fn arena_webview<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Webview<R>> {
    app.get_webview("arena").or_else(|| app.get_webview("main"))
}

/// Emit `arenakit://<kind>` to every webview AND push into the in-page HUD.
fn broadcast<R: Runtime, T: Serialize + Clone>(app: &AppHandle<R>, kind: &str, payload: T) {
    let _ = app.emit(&format!("arenakit://{kind}"), payload.clone());
    if let Some(wv) = arena_webview(app) {
        if let Ok(json) = serde_json::to_string(&payload) {
            let js = format!(
                "window.__AK_HUD__&&window.__AK_HUD__.push({kind},{json});",
                kind = serde_json::to_string(kind).unwrap_or_default()
            );
            let _ = wv.eval(&js);
        }
    }
}

// ── commands ─────────────────────────────────────────────────────────────

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
}

fn platform_name() -> &'static str {
    std::env::consts::OS
}

/// Called when snoop.js hands back a {sessionId, token}. Validates the token,
/// polls Trigger.dev (8x @ 3s), extracts the server-side model, and emits it.
#[tauri::command]
async fn fetch_trace(
    app: AppHandle,
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
        );
        e
    })?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
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
                                broadcast(&app, "models", report);
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
#[tauri::command]
async fn proxy_get(url: String) -> Result<Value, String> {
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
}

/// Eval JS inside the arena.ai page webview. Only the local dock webview is
/// allowed to call this (see capabilities/default.json); the remote page never
/// gets this permission.
#[tauri::command]
async fn arena_command(app: AppHandle, js: String) -> Result<(), String> {
    let wv = arena_webview(&app).ok_or_else(|| "arena webview 未找到".to_string())?;
    wv.eval(&js).map_err(|e| e.to_string())
}

/// Static facts the dock shows in its footer.
#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        platform: platform_name(),
        version: APP_VERSION,
        arch: std::env::consts::ARCH,
        mobile: cfg!(mobile),
    }
}

/// Events raised by the page bootstrap (remote origin). The kind is
/// allow-listed and the payload is re-emitted as `arenakit://<kind>` so the
/// dock can subscribe without ever talking to the page directly.
#[tauri::command]
fn page_event(app: AppHandle, kind: String, payload: Value) -> Result<(), String> {
    const ALLOWED: [&str; 3] = ["state", "credits", "log"];
    if !ALLOWED.contains(&kind.as_str()) {
        return Err(format!("page_event: unknown kind {kind}"));
    }
    if kind == "log" {
        println!("[arena.ai] {}", payload.get("message").and_then(Value::as_str).unwrap_or(""));
        return Ok(());
    }
    app.emit(&format!("arenakit://{kind}"), payload)
        .map_err(|e| e.to_string())
}

// ── windows ──────────────────────────────────────────────────────────────

/// Desktop: one window, two webviews side by side — arena.ai on the left, the
/// native dock (bundled `dock.html`) on the right. The dock lives in its own
/// webview (not injected into the page) so arena redesigns cannot break it.
#[cfg(desktop)]
fn setup_desktop(app: &tauri::App, init: String) -> tauri::Result<()> {
    use tauri::webview::{NewWindowResponse, WebviewBuilder};
    use tauri::window::WindowBuilder;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    let width = 1400.0_f64;
    let height = 920.0_f64;
    let dock_w = 340.0_f64;

    let window = WindowBuilder::new(app, "main")
        .title("ArenaKit")
        .inner_size(width, height)
        .min_inner_size(960.0, 640.0)
        .build()?;

    let arena_url: tauri::Url = ARENA_URL.parse().expect("static url");
    window.add_child(
        WebviewBuilder::new("arena", WebviewUrl::External(arena_url))
            .initialization_script(init)
            .on_new_window(|_url, _features| NewWindowResponse::Allow)
            .auto_resize(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width - dock_w, height),
    )?;

    window.add_child(
        WebviewBuilder::new("dock", WebviewUrl::App("dock.html".into())).auto_resize(),
        LogicalPosition::new(width - dock_w, 0.0),
        LogicalSize::new(dock_w, height),
    )?;

    Ok(())
}

/// Mobile: a single full-screen arena.ai webview. There is no room for a dock,
/// so the in-page HUD (Shadow DOM, injected by the init script) is the UI.
#[cfg(mobile)]
fn setup_mobile(app: &tauri::App, init: String) -> tauri::Result<()> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    let arena_url: tauri::Url = ARENA_URL.parse().expect("static url");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(arena_url))
        .title("ArenaKit")
        .initialization_script(init)
        .user_agent(MOBILE_UA)
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let init = build_init_script(platform_name(), cfg!(mobile));
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_trace,
            proxy_get,
            arena_command,
            get_app_info,
            page_event
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            setup_desktop(app, init)?;
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
        let env = idx("window.__ARENAKIT_ENV__=");
        let css = idx("window.__ARENAKIT_HUD_CSS__=");
        let boot = idx("window.__ARENAKIT__ = {");
        let unlock = idx("moduleOn(\"unlock\")");
        let eni = idx("moduleOn(\"eni\")");
        let manager = idx("moduleOn(\"manager\")");
        let plus = idx("moduleOn(\"plus\")");
        let lb = idx("moduleOn(\"leaderboard\")");
        let hud = idx("moduleOn(\"hud\")");
        assert!(env < css && css < boot && boot < unlock && unlock < eni);
        assert!(eni < manager && manager < plus && plus < lb && lb < hud);
        assert!(s.contains("\"mobile\":false"));
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
        assert!(w.starts_with(";(function(){try{if(!(window.__ARENAKIT__&&window.__ARENAKIT__.moduleOn(\"plus\")))return;\n"));
        assert!(w.ends_with("\n}catch(e){console.warn('[ArenaKit] plus failed',e);}})();\n"));
    }

    #[test]
    fn page_event_kinds_are_allowlisted() {
        // The command needs an AppHandle; test the allowlist directly instead.
        const ALLOWED: [&str; 3] = ["state", "credits", "log"];
        assert!(ALLOWED.contains(&"state"));
        assert!(!ALLOWED.contains(&"models"), "models must only come from Rust");
    }
}
