//! ArenaKit Tauri core library.
//! Shared by the macOS and Android builds. Wires WebView script injection and
//! the trace/pulse IPC commands.

pub mod trace;
pub mod pulse;

use serde::Serialize;
use serde_json::Value;

/// The MAIN-world scripts that must run before arena.ai's own JS.
/// Loaded from injected/*.js at build time via include_str!.
/// STATUS (M0): only snoop is include_str-ready; the rest are added as their
/// GM_* shims land (see docs/DEVELOPMENT.md §2).
pub const SNOOP_JS: &str = include_str!("../../injected/snoop.js");

#[derive(Serialize)]
pub struct ModelReport {
    pub run_id: String,
    pub models: Vec<ModelOut>,
}

#[derive(Serialize)]
pub struct ModelOut {
    pub model: String,
    pub provider: String,
    pub partial: bool,
}

/// M3: called when snoop.js hands back a {sessionId, token}. Validates the
/// token, then (M3 live) polls Trigger.dev and returns the server-side model.
#[tauri::command]
async fn fetch_trace(token: String, session_id: String) -> Result<ModelReport, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let claims = trace::validate_token(&token, &session_id, now)?;
    // TODO(M3): reqwest GET https://api.trigger.dev/api/v1/runs/{run}/events
    // 8x @ 3s with Authorization: Bearer <token>, then extract_models.
    Err(format!(
        "M3 未接线：令牌校验通过 run={} exp={}，实况轮询待实现",
        claims.run_id, claims.exp
    ))
}

/// Bypass page CORS for logo/price/gist fetches used by injected scripts.
#[tauri::command]
async fn proxy_get(_url: String) -> Result<Value, String> {
    // TODO(M2): reqwest GET with WebView cookies, return JSON/text.
    Err("proxy_get 未接线（M2）".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![fetch_trace, proxy_get])
        .run(tauri::generate_context!())
        .expect("error while running ArenaKit");
}
