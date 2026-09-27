//! ArenaKit Tauri core library.
//! Shared by the macOS and Android builds. Wires WebView script injection, the
//! trace pipeline, the page↔dock event relay and the persistent store.
//!
//! Layout (see docs/ARCHITECTURE.md):
//!   arena webview  — https://arena.ai + injected/*.js (bridge first)
//!   dock webview   — src/dock.html, the native UI (persistent, never reloads)
//!   Rust           — thin relay: trace polling, store, page_event → dock,
//!                    arena_command (dock → page eval), proxy_get allowlist.
//! Mobile (Android) has a single webview per window, so the dock is instead
//! bundled (scripts/bundle-dock.mjs → src/embed/dock-embedded.gen.js) and
//! mounted inside the arena page by the init script; it then talks to Rust
//! through the same commands/events as the desktop dock.

pub mod links;
pub mod pulse;
pub mod store;
pub mod trace;
pub mod usage;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize};
use tauri::{Emitter, Manager, WebviewUrl};

// ── injected scripts (bundled at compile time) ───────────────────────────
// MAIN-world, must run before arena.ai's own JS. Order matters: bridge first
// (everything else talks through it), then the GM shim, then the hooks.
const BRIDGE_JS: &str = include_str!("../../injected/bridge.js");
const GM_SHIM_JS: &str = include_str!("../../injected/gm-shim.js");
const SNOOP_JS: &str = include_str!("../../injected/snoop.js");
// Reply monitor: reduces the SSE frames snoop.js taps to counts/flags in-page.
const MONITOR_JS: &str = include_str!("../../injected/monitor.js");
// Daily-quota poller: same-origin GET /api/me/pulse with the page's own cookies.
const PULSE_JS: &str = include_str!("../../injected/pulse.js");
const UNLOCK_JS: &str = include_str!("../../injected/unlock.js");
const ENI_JS: &str = include_str!("../../injected/eni.js");
// Page-side RPC layer for the dock orchestrator (probe / rename / archive /
// session probe): stateless DOM actions, answered via bridge 'probe-result'.
const CONVERSATION_RENAME_JS: &str = include_str!("../../injected/conversation-rename.js");
const PROBE_JS: &str = include_str!("../../injected/probe.js");
// Conversation watchdog: reports error-card / empty-reply states of the open
// conversation (`watch` page event); the dock's policy decides on auto reload.
const WATCHDOG_JS: &str = include_str!("../../injected/watchdog.js");
// Link interceptor: <a> clicks / target=_blank / window.open to other sites go
// to the in-app link tab instead of replacing the conversation (links.rs is the
// navigation-level safety net behind it).
const LINKS_JS: &str = include_str!("../../injected/links.js");
// document_idle UI scripts.
const MANAGER_JS: &str = include_str!("../../injected/manager.js");
const PLUS_JS: &str = include_str!("../../injected/plus.js");
const LEADERBOARD_JS: &str = include_str!("../../injected/leaderboard.js");
// The whole dock (dock.js + lib + embed/shell.js) as one classic script,
// mounted inside the arena page after DOMContentLoaded: always on mobile, and
// the default "pill" layout on desktop (same status pill + bottom sheet UI).
const DOCK_EMBED_JS: &str = include_str!("../../src/embed/dock-embedded.gen.js");

/// Desktop window layout (设置 → 桌面布局, `prefs.desktopLayout`), read from the
/// store at startup. `Pill` = one webview, the embedded pill + bottom sheet
/// (Android parity, default); `Dock` = split view with the dock in its own
/// webview on the right.
#[cfg(any(desktop, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopLayout {
    Pill,
    Dock,
}

#[cfg(any(desktop, test))]
fn desktop_layout(prefs: &Value) -> DesktopLayout {
    match prefs.get("desktopLayout").and_then(|v| v.as_str()) {
        Some("dock") => DesktopLayout::Dock,
        _ => DesktopLayout::Pill,
    }
}

/// Trace polling: 8 attempts, 3 s apart (extension background.js parity).
const TRACE_MAX_ATTEMPTS: u32 = 8;
const TRACE_POLL_SECS: u64 = 3;

/// Wrap one script in its own try/catch so a top-level throw in one module
/// (e.g. a userscript touching `chrome.*`) can never abort the rest of the
/// init bundle — WebKit stops executing the whole init script at the first
/// uncaught exception.
fn guarded(out: &mut String, name: &str, src: &str) {
    out.push_str("try{\n");
    out.push_str(src);
    out.push_str(&format!(
        "\n}}catch(e){{console.warn('[ArenaKit] {} init failed',e);}}\n",
        name
    ));
}

/// Assemble the bridge + all injected scripts into one init script that runs
/// in the MAIN world before page load. UI scripts are deferred to
/// DOMContentLoaded so they see a ready DOM. `embedded_dock` (mobile) is
/// appended last in the deferred block, after every page hook it drives.
fn build_init_script(embedded_dock: Option<&str>, platform: &str) -> String {
    let mut s = String::new();
    // Lets the (embedded) dock tell desktop from Android: settings rows,
    // keyboard shortcuts, touch-only hints.
    s.push_str(&format!("window.__ARENAKIT_PLATFORM__={};\n", json!(platform)));
    // document_start scripts.
    guarded(&mut s, "bridge", BRIDGE_JS);
    guarded(&mut s, "gm-shim", GM_SHIM_JS);
    guarded(&mut s, "snoop", SNOOP_JS);
    guarded(&mut s, "monitor", MONITOR_JS);
    guarded(&mut s, "pulse", PULSE_JS);
    guarded(&mut s, "unlock", UNLOCK_JS);
    guarded(&mut s, "eni", ENI_JS);
    guarded(&mut s, "conversation-rename", CONVERSATION_RENAME_JS);
    guarded(&mut s, "probe", PROBE_JS);
    guarded(&mut s, "watchdog", WATCHDOG_JS);
    guarded(&mut s, "links", LINKS_JS);
    // defer UI scripts until the DOM is ready.
    s.push_str("(function(){var run=function(){\n");
    guarded(&mut s, "manager", MANAGER_JS);
    guarded(&mut s, "plus", PLUS_JS);
    guarded(&mut s, "leaderboard", LEADERBOARD_JS);
    if let Some(dock) = embedded_dock {
        guarded(&mut s, "dock-embedded", dock);
    }
    s.push_str("};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();\n");
    s
}

// ── trace pipeline ───────────────────────────────────────────────────────

/// Per-app trace state: the last token handed over by snoop.js (the same SSE
/// token is re-emitted per frame; only the first sighting may start a lookup)
/// and a per-session generation counter so a newer token cancels an older
/// lookup for the same conversation (background.js `cancelLookup`).
#[derive(Default)]
pub struct TraceState {
    last_token: Mutex<String>,
    generation: Mutex<HashMap<String, u64>>,
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Opaque, non-reversible key for a run token (reference HistoryLogic.tokenKey).
/// Arena may deliver the same run scope for every turn of a conversation, so the
/// dock keys turns by the TOKEN, never by the run id. In-memory use only.
fn token_key(token: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Every stage of the pipeline is reported on ONE event so the dock can render
/// a status line and the per-turn timeline from a single listener:
///   {stage:"token"|"poll"|"model"|"error"|"done", sessionId, runId?, status, ...}
fn emit_trace(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("arenakit://trace", payload);
}

fn is_live(app: &tauri::AppHandle, session_id: &str, generation: u64) -> bool {
    let state = app.state::<TraceState>();
    let map = match state.generation.lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    map.get(session_id).copied() == Some(generation)
}

/// Allow the same token to start a new lookup later (extension clears
/// `lastToken` whenever a lookup ends).
fn forget_token(app: &tauri::AppHandle, token: &str) {
    let state = app.state::<TraceState>();
    // Bind the lock result so its temporary is dropped before `state`
    // (tail-expression temporaries outlive locals otherwise — E0597).
    let guard = state.last_token.lock();
    if let Ok(mut last) = guard {
        if *last == token {
            last.clear();
        }
    };
}

/// Called when snoop.js hands back a {sessionId, token}. Validates the token,
/// then polls Trigger.dev in the background (8x @ 3s), emitting staged
/// `arenakit://trace` events. Returns immediately.
#[tauri::command]
fn on_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, TraceState>,
    token: String,
    session_id: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("会话 ID 无效".into());
    }
    {
        let mut last = state.last_token.lock().map_err(|_| "状态不可用".to_string())?;
        if *last == token {
            return Ok(());
        }
        *last = token.clone();
    }
    let claims = match trace::validate_token(&token, &session_id, now_secs()) {
        Ok(c) => c,
        Err(e) => {
            emit_trace(
                &app,
                json!({"stage":"error","sessionId":session_id,"fatal":false,"status":e}),
            );
            return Err(e);
        }
    };
    let generation = {
        let mut g = state.generation.lock().map_err(|_| "状态不可用".to_string())?;
        let n = g.entry(session_id.clone()).or_insert(0);
        *n += 1;
        *n
    };
    let expires_at_ms: u64 = (claims.exp * 1000.0) as u64;
    let key = token_key(&token);
    emit_trace(
        &app,
        json!({
            "stage":"token","sessionId":session_id,"runId":claims.run_id,"tokenKey":key,
            "expiresAt":expires_at_ms,
            "status":"已取得本次运行标识，读取 trace…"
        }),
    );
    tauri::async_runtime::spawn(async move {
        poll_trace(app, token, session_id, claims, generation).await;
    });
    Ok(())
}

async fn poll_trace(
    app: tauri::AppHandle,
    token: String,
    session_id: String,
    claims: trace::Claims,
    generation: u64,
) {
    let key = token_key(&token);
    let base = |extra: Value| -> Value {
        let mut v = json!({"sessionId": session_id, "runId": claims.run_id, "tokenKey": key});
        if let (Some(dst), Some(src)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in src {
                dst.insert(k.clone(), val.clone());
            }
        }
        v
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_trace(&app, base(json!({"stage":"error","fatal":true,"status":format!("HTTP 客户端初始化失败: {}", e)})));
            forget_token(&app, &token);
            return;
        }
    };
    // Fixed origin, exact run scope, no redirects, no cookies, no write endpoints.
    let url = format!(
        "https://api.trigger.dev/api/v1/runs/{}/events",
        claims.run_id
    );
    let mut attempt: u32 = 0;
    loop {
        if !is_live(&app, &session_id, generation) {
            return;
        }
        if now_secs() >= claims.exp - 5.0 {
            emit_trace(&app, base(json!({"stage":"error","fatal":false,"status":"令牌已过期，请发送新的消息"})));
            forget_token(&app, &token);
            return;
        }
        attempt += 1;
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .send()
            .await;
        if !is_live(&app, &session_id, generation) {
            return;
        }
        let retry = |label: &str| format!("{}，等待重试 {}/{}", label, attempt, TRACE_MAX_ATTEMPTS);
        // Outcome of this attempt: Ok(status text) = retry later, Err((fatal, msg)) = stop.
        let outcome: Result<String, (bool, String)> = match resp {
            Err(_) => {
                if attempt >= TRACE_MAX_ATTEMPTS {
                    Err((false, "trace 请求失败或超时，请检查网络".into()))
                } else {
                    Ok(retry("trace 请求失败或超时"))
                }
            }
            Ok(r) => {
                let status = r.status().as_u16();
                if !r.status().is_success() {
                    let label = trace::trace_status_label(status);
                    if trace::is_fatal_trace_status(status) || attempt >= TRACE_MAX_ATTEMPTS {
                        Err((trace::is_fatal_trace_status(status), label))
                    } else {
                        Ok(retry(&label))
                    }
                } else {
                    match r.text().await {
                        Err(_) => Ok(retry("trace 读取失败")),
                        Ok(text) if text.len() > 4 * 1024 * 1024 => {
                            Err((true, "trace 超过 4 MB，停止解析".into()))
                        }
                        Ok(text) => match serde_json::from_str::<Value>(&text) {
                            Err(_) => Err((true, "trace 不是有效 JSON".into())),
                            Ok(trace_json) => handle_trace(&app, &base, &claims.run_id, &trace_json, attempt),
                        },
                    }
                }
            }
        };
        // Never poll past the attempt cap, whatever the retry reason was.
        let outcome = match outcome {
            Ok(s) if s != "__done__" && attempt >= TRACE_MAX_ATTEMPTS => Err((false, s)),
            other => other,
        };
        match outcome {
            Err((fatal, msg)) => {
                emit_trace(&app, base(json!({"stage":"error","fatal":fatal,"attempt":attempt,"status":msg})));
                forget_token(&app, &token);
                return;
            }
            Ok(status) => {
                if status == "__done__" {
                    emit_trace(&app, base(json!({"stage":"done","attempt":attempt,"status":"trace 读取完成"})));
                    forget_token(&app, &token);
                    return;
                }
                emit_trace(&app, base(json!({"stage":"poll","attempt":attempt,"max":TRACE_MAX_ATTEMPTS,"status":status})));
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(TRACE_POLL_SECS)).await;
    }
}

/// Parse one trace snapshot. Emits a `model` stage when model labels are
/// present. Returns Ok("__done__") when polling should stop, Ok(status) to
/// keep polling, Err((fatal,msg)) to stop with an error.
fn handle_trace(
    app: &tauri::AppHandle,
    base: &dyn Fn(Value) -> Value,
    run_id: &str,
    trace_json: &Value,
    attempt: u32,
) -> Result<String, (bool, String)> {
    let retry = |label: &str| format!("{}，等待重试 {}/{}", label, attempt, TRACE_MAX_ATTEMPTS);
    let models = match trace::extract_models(trace_json, run_id) {
        Ok(m) => m,
        Err(e) => {
            if attempt >= TRACE_MAX_ATTEMPTS {
                return Err((false, e));
            }
            return Ok(retry(&e));
        }
    };
    if models.is_empty() {
        if attempt >= TRACE_MAX_ATTEMPTS {
            return Err((false, "trace 未包含模型标签；不猜测模型".into()));
        }
        return Ok(retry("trace 暂无模型标签"));
    }
    let model_json: Vec<Value> = models
        .iter()
        .map(|m| json!({"model": m.model, "provider": m.provider, "partial": m.partial}))
        .collect();
    // Span-level Token / cost labels (usage.rs). Polling continues while any
    // span is partial or lacks a token/cost label, so the usage can catch up.
    let spans = usage::extract_usage(trace_json, run_id);
    let usage_complete = usage::is_complete(&spans) && !models.iter().any(|m| m.partial);
    let complete = usage_complete || attempt >= TRACE_MAX_ATTEMPTS;
    let status = if usage_complete {
        "已识别模型".to_string()
    } else if complete {
        "已识别模型（用量标签未补齐）".to_string()
    } else {
        format!("已识别模型，等待用量补齐 {}/{}", attempt, TRACE_MAX_ATTEMPTS)
    };
    let checked_at = now_millis();
    let spans_json = serde_json::to_value(&spans).unwrap_or(Value::Array(Vec::new()));
    // Optional strength / effort tier ("high", "max", …); empty when absent.
    let model_names: Vec<String> = models.iter().map(|m| m.model.clone()).collect();
    let strength = trace::extract_effort(trace_json, run_id, &model_names).unwrap_or_default();
    emit_trace(
        app,
        base(json!({
            "stage":"model","attempt":attempt,"max":TRACE_MAX_ATTEMPTS,
            "checkedAt": checked_at,"strength": strength,
            "models": model_json,
            "spans": spans_json,
            "complete": complete,
            "status": status
        })),
    );
    if complete {
        Ok("__done__".into())
    } else {
        Ok(status)
    }
}

// ── relay / store / misc commands ────────────────────────────────────────

/// Page → dock relay. Injected scripts call `__ARENAKIT__.send(name, payload)`;
/// the dock listens to "arenakit://page". Rust never inspects the payload.
#[tauri::command]
fn page_event(app: tauri::AppHandle, name: String, payload: Value) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("事件名无效".into());
    }
    app.emit("arenakit://page", json!({"name": name, "payload": payload}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn store_get(store: tauri::State<'_, store::Store>, key: String) -> Value {
    store.get(&key)
}

#[tauri::command]
fn store_set(store: tauri::State<'_, store::Store>, key: String, value: Value) -> Result<(), String> {
    store.set(&key, value)
}

#[tauri::command]
fn store_keys(store: tauri::State<'_, store::Store>, prefix: String) -> Vec<String> {
    store.keys(&prefix)
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

/// Eval arbitrary JS inside the arena.ai page webview. Called by the native
/// dock (dock.js) to drive probe RPCs, toggle the manager panel, set
/// unlock/plus/eni config, etc. Only the bundled dock may call this
/// (capabilities/default.json); the remote page cannot.
#[tauri::command]
async fn arena_command(app: tauri::AppHandle, js: String) -> Result<(), String> {
    let wv = app
        .get_webview("arena")
        .ok_or_else(|| "arena webview 未找到".to_string())?;
    wv.eval(&js).map_err(|e| e.to_string())
}

// ── link tab (reference LinkTab / LinkPolicy) ────────────────────────────

/// Open `url` in the in-app link tab. Desktop: a separate window (no init
/// scripts, no IPC — the tab is a plain browser view). Mobile: the native
/// LinkTab layer (MainActivity overlay) is driven from the page, so hand the
/// URL to injected/links.js, which talks to it.
fn open_link_tab(app: &tauri::AppHandle, url: String) {
    if !links::is_web_url(&url) {
        return;
    }
    #[cfg(desktop)]
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static TABS: AtomicUsize = AtomicUsize::new(0);
        let Ok(parsed) = url.parse::<tauri::Url>() else { return };
        let label = format!("tab-{}", TABS.fetch_add(1, Ordering::Relaxed));
        let title = parsed
            .host_str()
            .map(|h| format!("{} — ArenaKit 链接", h.trim_start_matches("www.")))
            .unwrap_or_else(|| "ArenaKit 链接".to_string());
        let handle = app.clone();
        // Never build a window from inside a navigation callback: queue it.
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = tauri::WebviewWindowBuilder::new(&handle, &label, WebviewUrl::External(parsed))
                .title(title)
                .inner_size(1000.0, 760.0)
                .build()
            {
                eprintln!("[ArenaKit] link tab failed: {e}");
            }
        });
    }
    #[cfg(mobile)]
    {
        page_links_call(app, "open", &url);
    }
}

/// Hand a non-web URL (mailto:, tel:, intent: …) to the OS / another app.
fn open_external(app: &tauri::AppHandle, url: String) {
    #[cfg(desktop)]
    {
        let _ = app;
        // One argument, no shell parsing: the URL can never inject a command.
        #[cfg(target_os = "macos")]
        let spawned = std::process::Command::new("open").arg(&url).spawn();
        #[cfg(target_os = "windows")]
        let spawned = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        #[cfg(all(unix, not(target_os = "macos")))]
        let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
        if let Err(e) = spawned {
            eprintln!("[ArenaKit] external link failed: {e}");
        }
    }
    #[cfg(mobile)]
    {
        page_links_call(app, "external", &url);
    }
}

/// Mobile: call `window.__ARENAKIT_LINKS__.<method>(url)` in the arena page.
#[cfg(mobile)]
fn page_links_call(app: &tauri::AppHandle, method: &str, url: &str) {
    let Some(wv) = app.get_webview("arena") else { return };
    let js = format!(
        "window.__ARENAKIT_LINKS__&&window.__ARENAKIT_LINKS__.{}({})",
        method,
        json!(url)
    );
    let _ = wv.eval(&js);
}

/// Route a main-frame navigation of the arena webview (Tauri `on_navigation`).
/// Returns whether the webview may load the URL itself.
fn route_navigation(app: &tauri::AppHandle, url: &tauri::Url) -> bool {
    match links::route_main(url.as_str()) {
        links::Route::InPlace => true,
        links::Route::NewTab => {
            open_link_tab(app, url.to_string());
            false
        }
        links::Route::ExternalApp => {
            open_external(app, url.to_string());
            false
        }
        links::Route::Block => false,
    }
}

/// injected/links.js (a tapped link / target=_blank / window.open in the
/// arena page) → open the in-app link tab. Desktop: a new window; on mobile
/// the page talks to the native tab directly and this is a no-op (false).
#[tauri::command]
fn open_tab(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    if url.len() > 8192 || !links::is_web_url(&url) {
        return Err("仅支持 http(s) 链接".into());
    }
    if cfg!(mobile) {
        // Android: links.js talks to the native LinkTab directly.
        return Ok(false);
    }
    open_link_tab(&app, url);
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            on_token,
            page_event,
            store_get,
            store_set,
            store_keys,
            proxy_get,
            open_tab,
            arena_command
        ])
        .setup(move |app| {
            // Persistent store + trace state, available to every command.
            let data_dir = app.path().app_data_dir()?;
            app.manage(store::Store::open(data_dir.join("arenakit-store.json")));
            app.manage(TraceState::default());

            // Desktop, default "pill" layout: ONE webview — the arena.ai page
            // with the dock embedded as a status pill + bottom sheet, exactly
            // like Android (设置 → 桌面布局 switches to the split view below).
            #[cfg(desktop)]
            let layout = desktop_layout(&app.state::<store::Store>().get("prefs"));
            #[cfg(desktop)]
            if layout == DesktopLayout::Pill {
                let init = build_init_script(Some(DOCK_EMBED_JS), "desktop");
                let nav_app = app.handle().clone();
                let _arena = tauri::WebviewWindowBuilder::new(
                    app,
                    "arena",
                    WebviewUrl::External("https://arena.ai".parse().unwrap()),
                )
                .title("ArenaKit")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 600.0)
                .initialization_script(&init)
                // Links to other sites open in a separate window, never over
                // the conversation (links.rs).
                .on_navigation(move |url| route_navigation(&nav_app, url))
                .build()?;
            }

            // Desktop, "dock" layout: split-view window: arena.ai webview on
            // the left, ArenaKit native dock webview on the right. The dock
            // lives in its own webview (not injected into the page), so arena
            // redesigns can't break it.
            #[cfg(desktop)]
            if layout == DesktopLayout::Dock {
                let init = build_init_script(None, "desktop");
                let width = 1360.0_f64;
                let height = 900.0_f64;
                let dock_w = 320.0_f64;

                let window = tauri::window::WindowBuilder::new(app, "main")
                    .title("ArenaKit")
                    .inner_size(width, height)
                    .build()?;

                // Left: arena.ai. The init script is injected before page load
                // AND on every navigation (Tauri re-runs initialization scripts
                // per navigation), mirroring the Android WebViewClient
                // re-injection.
                let nav_app = app.handle().clone();
                let _arena = window.add_child(
                    tauri::webview::WebviewBuilder::new(
                        "arena",
                        WebviewUrl::External("https://arena.ai".parse().unwrap()),
                    )
                    .initialization_script(&init)
                    // Links to other sites open in a separate window, never
                    // over the conversation (links.rs).
                    .on_navigation(move |url| route_navigation(&nav_app, url))
                    .auto_resize(),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(width - dock_w, height),
                )?;

                // Right: the native dock (bundled frontend, dock.html).
                let _dock = window.add_child(
                    tauri::webview::WebviewBuilder::new(
                        "dock",
                        WebviewUrl::App("dock.html".into()),
                    )
                    .auto_resize(),
                    LogicalPosition::new(width - dock_w, 0.0),
                    LogicalSize::new(dock_w, height),
                )?;
            }

            // Mobile: one full-screen webview ("arena", also the window label —
            // capabilities/arena*.json match the webview label). The dock is
            // part of the init script and mounts itself inside the page.
            #[cfg(mobile)]
            {
                let init = build_init_script(Some(DOCK_EMBED_JS), "mobile");
                let nav_app = app.handle().clone();
                let _arena = tauri::WebviewWindowBuilder::new(
                    app,
                    "arena",
                    WebviewUrl::External("https://arena.ai".parse().unwrap()),
                )
                .initialization_script(&init)
                // Links to other sites open in the native link tab layer
                // (MainActivity overlay), never over the conversation.
                .on_navigation(move |url| route_navigation(&nav_app, url))
                .build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ArenaKit");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_isolates_every_module() {
        let s = build_init_script(None, "desktop");
        // platform stamp, then bridge first, every module wrapped, UI scripts deferred.
        assert!(s.starts_with("window.__ARENAKIT_PLATFORM__=\"desktop\";\ntry{\n"));
        assert!(build_init_script(None, "mobile").starts_with("window.__ARENAKIT_PLATFORM__=\"mobile\";\n"));
        assert!(s.find("__ARENAKIT__").unwrap() < s.find("GM_getValue").unwrap());
        for name in ["bridge", "gm-shim", "snoop", "monitor", "pulse", "unlock", "eni", "conversation-rename", "probe", "watchdog", "links", "manager", "plus", "leaderboard"] {
            assert!(s.contains(&format!("[ArenaKit] {} init failed", name)), "{}", name);
        }
        assert!(s.contains("DOMContentLoaded"));
        assert!(!s.contains("dock-embedded init failed"));
    }

    #[test]
    fn embedded_dock_is_appended_last_in_the_deferred_block() {
        let s = build_init_script(Some("/*DOCK*/"), "mobile");
        let dock = s.find("/*DOCK*/").unwrap();
        assert!(s.find("[ArenaKit] leaderboard init failed").unwrap() < dock);
        // bridge.js has its own DOMContentLoaded hook; the deferred-run trailer is the LAST one.
        assert!(dock < s.rfind("DOMContentLoaded").unwrap());
        assert!(s.contains("[ArenaKit] dock-embedded init failed"));
        // the committed bundle is a self-contained classic script
        let bundle = include_str!("../../src/embed/dock-embedded.gen.js");
        assert!(bundle.starts_with("/* GENERATED by scripts/bundle-dock.mjs"));
        assert!(bundle.contains("__define(\"dock.js\""));
        assert!(bundle.contains("__define(\"embed/shell.js\""));
        assert!(!bundle.contains("\nimport "));
    }

    #[test]
    fn desktop_layout_defaults_to_the_pill() {
        assert_eq!(desktop_layout(&json!({"desktopLayout": "dock"})), DesktopLayout::Dock);
        assert_eq!(desktop_layout(&json!({"desktopLayout": "pill"})), DesktopLayout::Pill);
        assert_eq!(desktop_layout(&json!({"desktopLayout": 3})), DesktopLayout::Pill);
        assert_eq!(desktop_layout(&json!({})), DesktopLayout::Pill);
        assert_eq!(desktop_layout(&Value::Null), DesktopLayout::Pill);
    }

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("abc-123"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("bad/id"));
        assert!(!valid_session_id(&"x".repeat(129)));
    }
}
