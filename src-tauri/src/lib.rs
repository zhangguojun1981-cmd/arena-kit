//! ArenaKit Tauri core library.
//! Shared by the macOS and Android builds. Wires WebView script injection and
//! the trace/pulse IPC commands.

pub mod trace;
pub mod pulse;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

// ── injected scripts (bundled at compile time) ───────────────────────────
// MAIN-world, must run before arena.ai's own JS.
const GM_SHIM_JS: &str = include_str!("../../injected/gm-shim.js");
const SNOOP_JS: &str = include_str!("../../injected/snoop.js");
const UNLOCK_JS: &str = include_str!("../../injected/unlock.js");
const ENI_JS: &str = include_str!("../../injected/eni.js");
// document_idle UI scripts.
const MANAGER_JS: &str = include_str!("../../injected/manager.js");
const PLUS_JS: &str = include_str!("../../injected/plus.js");
const LEADERBOARD_JS: &str = include_str!("../../injected/leaderboard.js");

/// Injected before any page script. Exposes window.__ARENAKIT__ using Tauri's
/// IPC. Kept tiny and dependency-free.
const BRIDGE_BOOTSTRAP: &str = r#"
(() => {
  if (window.__ARENAKIT__) return;
  const invoke = (cmd, args) =>
    (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
      ? window.__TAURI_INTERNALS__.invoke(cmd, args)
      : Promise.reject(new Error('no tauri runtime'));
  window.__ARENAKIT__ = {
    onToken: (payload) => invoke('fetch_trace', { token: payload.token, sessionId: payload.sessionId })
      .catch((e) => console.warn('[ArenaKit] fetch_trace', e)),
    proxyGet: (url) => invoke('proxy_get', { url }),
  };
})();
"#;

/// Assemble the bridge + all injected scripts into one init script that runs
/// in the MAIN world before page load. UI scripts are deferred to
/// DOMContentLoaded so they see a ready DOM.
fn build_init_script() -> String {
    let mut s = String::new();
    s.push_str(BRIDGE_BOOTSTRAP);
    // document_start scripts (order matters: shim first, then hooks).
    s.push_str(GM_SHIM_JS);
    s.push_str("\n;");
    s.push_str(SNOOP_JS);
    s.push_str("\n;");
    s.push_str(UNLOCK_JS);
    s.push_str("\n;");
    s.push_str(ENI_JS);
    s.push_str("\n;");
    // defer UI scripts until the DOM is ready.
    s.push_str("(function(){var run=function(){try{");
    s.push_str(MANAGER_JS);
    s.push_str("\n}catch(e){console.warn('[ArenaKit] manager',e);}try{");
    s.push_str(PLUS_JS);
    s.push_str("\n}catch(e){console.warn('[ArenaKit] plus',e);}try{");
    s.push_str(LEADERBOARD_JS);
    s.push_str("\n}catch(e){console.warn('[ArenaKit] leaderboard',e);}};");
    s.push_str("if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();\n");
    s
}

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

/// Called when snoop.js hands back a {sessionId, token}. Validates the token,
/// polls Trigger.dev (8x @ 3s), extracts the server-side model, and emits it.
#[tauri::command]
async fn fetch_trace(
    app: tauri::AppHandle,
    token: String,
    session_id: String,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let claims = trace::validate_token(&token, &session_id, now).map_err(|e| {
        let _ = app.emit(
            "arenakit://error",
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
                                let _ = app.emit("arenakit://models", report);
                                return Ok(());
                            }
                        }
                    }
                }
            } else if trace::is_fatal_trace_status(status) {
                let msg = trace::trace_status_label(status);
                let _ = app.emit(
                    "arenakit://error",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let init = build_init_script();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![fetch_trace, proxy_get])
        .setup(move |app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval(&init);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ArenaKit");
}
