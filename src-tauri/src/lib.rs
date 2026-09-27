//! ArenaKit Tauri core library.
//! Shared by the macOS and Android builds. Wires WebView script injection, the
//! trace pipeline, the page↔dock event relay and the persistent store.
//!
//! Layout (see docs/ARCHITECTURE.md):
//!   arena webview  — https://arena.ai + injected/*.js (bridge first)
//!   dock webview   — src/dock.html, the native UI (persistent, never reloads)
//!   Rust           — thin relay: trace polling, store, page_event → dock,
//!                    arena_command (dock → page eval), proxy_get allowlist.

pub mod pulse;
pub mod store;
pub mod trace;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

// ── injected scripts (bundled at compile time) ───────────────────────────
// MAIN-world, must run before arena.ai's own JS. Order matters: bridge first
// (everything else talks through it), then the GM shim, then the hooks.
const BRIDGE_JS: &str = include_str!("../../injected/bridge.js");
const GM_SHIM_JS: &str = include_str!("../../injected/gm-shim.js");
const SNOOP_JS: &str = include_str!("../../injected/snoop.js");
const UNLOCK_JS: &str = include_str!("../../injected/unlock.js");
const ENI_JS: &str = include_str!("../../injected/eni.js");
// document_idle UI scripts.
const MANAGER_JS: &str = include_str!("../../injected/manager.js");
const PLUS_JS: &str = include_str!("../../injected/plus.js");
const LEADERBOARD_JS: &str = include_str!("../../injected/leaderboard.js");

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
/// DOMContentLoaded so they see a ready DOM.
fn build_init_script() -> String {
    let mut s = String::new();
    // document_start scripts.
    guarded(&mut s, "bridge", BRIDGE_JS);
    guarded(&mut s, "gm-shim", GM_SHIM_JS);
    guarded(&mut s, "snoop", SNOOP_JS);
    guarded(&mut s, "unlock", UNLOCK_JS);
    guarded(&mut s, "eni", ENI_JS);
    // defer UI scripts until the DOM is ready.
    s.push_str("(function(){var run=function(){\n");
    guarded(&mut s, "manager", MANAGER_JS);
    guarded(&mut s, "plus", PLUS_JS);
    guarded(&mut s, "leaderboard", LEADERBOARD_JS);
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
    if let Ok(mut last) = state.last_token.lock() {
        if *last == token {
            last.clear();
        }
    }
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
    emit_trace(
        &app,
        json!({
            "stage":"token","sessionId":session_id,"runId":claims.run_id,
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
    let base = |extra: Value| -> Value {
        let mut v = json!({"sessionId": session_id, "runId": claims.run_id});
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
        // Outcome of this attempt: Ok(status text) = retry later, Err((fatal, msg)) = stop.
        let outcome: Result<String, (bool, String)> = match resp {
            Err(_) => {
                if attempt >= TRACE_MAX_ATTEMPTS {
                    Err((false, "trace 请求失败或超时，请检查网络".into()))
                } else {
                    Ok("trace 请求失败或超时，请检查网络".into())
                }
            }
            Ok(r) => {
                let status = r.status().as_u16();
                if !r.status().is_success() {
                    let label = trace::trace_status_label(status);
                    if trace::is_fatal_trace_status(status) || attempt >= TRACE_MAX_ATTEMPTS {
                        Err((trace::is_fatal_trace_status(status), label))
                    } else {
                        Ok(label)
                    }
                } else {
                    match r.text().await {
                        Err(_) => Ok("trace 读取失败".into()),
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
                emit_trace(&app, base(json!({"stage":"poll","attempt":attempt,"max":TRACE_MAX_ATTEMPTS,"status":format!("{}，等待重试 {}/{}", status, attempt, TRACE_MAX_ATTEMPTS)})));
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
    let models = match trace::extract_models(trace_json, run_id) {
        Ok(m) => m,
        Err(e) => {
            if attempt >= TRACE_MAX_ATTEMPTS {
                return Err((false, e));
            }
            return Ok(e);
        }
    };
    if models.is_empty() {
        if attempt >= TRACE_MAX_ATTEMPTS {
            return Err((false, "trace 未包含模型标签；不猜测模型".into()));
        }
        return Ok("trace 暂无模型标签".into());
    }
    let model_json: Vec<Value> = models
        .iter()
        .map(|m| json!({"model": m.model, "provider": m.provider, "partial": m.partial}))
        .collect();
    let partial = models.iter().any(|m| m.partial);
    let complete = !partial || attempt >= TRACE_MAX_ATTEMPTS;
    let status = if complete { "已识别模型" } else { "已识别模型，等待调用完成" };
    let checked_at = now_millis();
    emit_trace(
        app,
        base(json!({
            "stage":"model","attempt":attempt,"max":TRACE_MAX_ATTEMPTS,
            "checkedAt": checked_at,
            "models": model_json,
            "complete": complete,
            "status": status
        })),
    );
    if complete {
        Ok("__done__".into())
    } else {
        Ok(status.to_string())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let init = build_init_script();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            on_token,
            page_event,
            store_get,
            store_set,
            store_keys,
            proxy_get,
            arena_command
        ])
        .setup(move |app| {
            // Persistent store + trace state, available to every command.
            let data_dir = app.path().app_data_dir()?;
            app.manage(store::Store::open(data_dir.join("arenakit-store.json")));
            app.manage(TraceState::default());

            // Split-view window: arena.ai webview on the left, ArenaKit native
            // dock webview on the right. The dock lives in its own webview (not
            // injected into the page), so arena redesigns can't break it.
            let width = 1360.0_f64;
            let height = 900.0_f64;
            let dock_w = 320.0_f64;

            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("ArenaKit")
                .inner_size(width, height)
                .build()?;

            // Left: arena.ai. The init script is injected before page load AND
            // on every navigation (Tauri re-runs initialization scripts per
            // navigation), mirroring the Android WebViewClient re-injection.
            let _arena = window.add_child(
                tauri::webview::WebviewBuilder::new(
                    "arena",
                    WebviewUrl::External("https://arena.ai".parse().unwrap()),
                )
                .initialization_script(&init)
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
        let s = build_init_script();
        // bridge first, every module wrapped, UI scripts deferred.
        assert!(s.starts_with("try{\n"));
        assert!(s.find("__ARENAKIT__").unwrap() < s.find("GM_getValue").unwrap());
        for name in ["bridge", "gm-shim", "snoop", "unlock", "eni", "manager", "plus", "leaderboard"] {
            assert!(s.contains(&format!("[ArenaKit] {} init failed", name)), "{}", name);
        }
        assert!(s.contains("DOMContentLoaded"));
    }

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("abc-123"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("bad/id"));
        assert!(!valid_session_id(&"x".repeat(129)));
    }
}
