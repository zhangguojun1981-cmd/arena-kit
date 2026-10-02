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
#[cfg(desktop)]
mod menu;
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
const SNOOP_JS: &str = include_str!("../../injected/snoop.js");
// Reply monitor: reduces the SSE frames snoop.js taps to counts/flags in-page.
const MONITOR_JS: &str = include_str!("../../injected/monitor.js");
// Model-fingerprint reducer: receives the SAME SSE frames in-page, but only for
// a dock-armed fixed probe, and only ever ships numeric features (histogram
// counts / one normalized categorical pick) — never reply text — via the
// 'fingerprint-sample' page event.
const FINGERPRINT_JS: &str = include_str!("../../injected/fingerprint.js");
// Daily-quota poller: same-origin GET /api/me/pulse with the page's own cookies.
const PULSE_JS: &str = include_str!("../../injected/pulse.js");
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
// Multi-account: session snapshot / restore / one-tap re-login. Runs on every
// page of this webview — accounts.google.com included — so the Google side of
// a re-login (account chooser → Continue) works where no IPC exists.
const ACCOUNT_JS: &str = include_str!("../../injected/account.js");
// The whole dock (dock.js + lib + embed/shell.js) as one classic script,
// mounted inside the arena page after DOMContentLoaded: always on mobile, and
// the default "pill" layout on desktop (same status pill + bottom sheet UI).
const DOCK_EMBED_JS: &str = include_str!("../../src/embed/dock-embedded.gen.js");

/// Desktop window layout: macOS uses a fixed split-view (`arena.ai` webview
/// on the left, native dock in its own webview on the right). The
/// `prefs.desktopLayout` setting is no longer honoured — the embedded pill
/// is Android-only.
#[cfg(any(desktop, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopLayout {
    Dock,
}

#[cfg(any(desktop, test))]
fn desktop_layout(prefs: &Value) -> DesktopLayout {
    // Historical `desktopLayout` prefs are accepted but ignored: the dock
    // split view is the only macOS layout now.
    let _ = prefs.get("desktopLayout");
    DesktopLayout::Dock
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

/// Host gate for the arena-only document_start modules (page hooks, stream
/// taps, watchdog, ENI, link routing). The same webview also loads the
/// sign-in pages (accounts.google.com …) and third-party frames (Cloudflare
/// Turnstile); wrapping their fetch / XHR / WebSocket / window.open and
/// watching their DOM there bought nothing and could stall them.
const ARENA_HOST_FLAG: &str = "window.__ARENAKIT_ON_ARENA__=/(^|\\.)(arena\\.ai|lmarena\\.ai)$/.test(location.hostname||'');\n";

fn guarded_arena(out: &mut String, name: &str, src: &str) {
    out.push_str("if(window.__ARENAKIT_ON_ARENA__){\n");
    guarded(out, name, src);
    out.push_str("}\n");
}

/// Assemble the bridge + all injected scripts into one init script that runs
/// in the MAIN world before page load. UI scripts are deferred to
/// DOMContentLoaded so they see a ready DOM. `embedded_dock` (mobile) is
/// appended last in the deferred block, after every page hook it drives.
fn build_init_script(embedded_dock: Option<&str>, platform: &str, guard: &str) -> String {
    let mut s = String::new();
    // Lets the (embedded) dock tell desktop from Android: settings rows,
    // keyboard shortcuts, touch-only hints.
    s.push_str(&format!("window.__ARENAKIT_PLATFORM__={};\n", json!(platform)));
    // document_start scripts.
    guarded(&mut s, "bridge", BRIDGE_JS);
    // arena only (see ARENA_HOST_FLAG); bridge / account run on the sign-in
    // hosts too — the Google half of a re-login lives there.
    s.push_str(ARENA_HOST_FLAG);
    guarded_arena(&mut s, "snoop", SNOOP_JS);
    guarded_arena(&mut s, "monitor", MONITOR_JS);
    guarded_arena(&mut s, "fingerprint", FINGERPRINT_JS);
    guarded_arena(&mut s, "pulse", PULSE_JS);
    guarded_arena(&mut s, "eni", ENI_JS);
    guarded_arena(&mut s, "conversation-rename", CONVERSATION_RENAME_JS);
    guarded_arena(&mut s, "probe", PROBE_JS);
    guarded_arena(&mut s, "watchdog", WATCHDOG_JS);
    guarded_arena(&mut s, "links", LINKS_JS);
    guarded(&mut s, "account", ACCOUNT_JS);
    // defer the embedded dock until the DOM is ready — and only on arena
    // itself: the same webview also shows sign-in pages (accounts.google.com …)
    // where the pill / dock must not appear.
    s.push_str("(function(){if(!/(^|\\.)(arena\\.ai|lmarena\\.ai)$/.test(location.hostname||''))return;var run=function(){\n");
    if let Some(dock) = embedded_dock {
        // The launch token exists only as this closure's argument: page scripts
        // cannot read it, and the embedded dock (mobile: it runs INSIDE the
        // arena page, so the webview label cannot tell it from the page) sends
        // it along with every credential-store call. See `store_access_ok`.
        let wrapped = format!("(function(__AK_GUARD__){{\n{}\n}})({});", dock, json!(guard));
        guarded(&mut s, "dock-embedded", &wrapped);
    }
    s.push_str("};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}})();\n");
    s
}

// ── re-login (multi-account) ─────────────────────────────────────────────
/// The account a re-login is running for ({accountId, email, startedAt} — no
/// credentials: the old password / TOTP helper is gone). Memory only, for at
/// most LOGIN_TTL_SECS, and pushed into
/// the arena webview on every finished page load of arena.ai or a sign-in
/// host — that is how injected/account.js receives them on
/// accounts.google.com, where the page has no IPC (capabilities are
/// arena.ai-only). Cleared by the page (`login_clear`) once the session cookie
/// is back, by the dock, or by the TTL.
const LOGIN_TTL_SECS: u64 = 10 * 60;

#[derive(Default)]
pub struct LoginState {
    pending: Mutex<Option<(Value, std::time::Instant)>>,
}

impl LoginState {
    fn set(&self, creds: Value) {
        if let Ok(mut g) = self.pending.lock() {
            *g = Some((creds, std::time::Instant::now()));
        }
    }
    fn clear(&self) {
        if let Ok(mut g) = self.pending.lock() {
            *g = None;
        }
    }
    /// The pending re-login target, dropping it once the TTL has passed.
    fn current(&self) -> Option<Value> {
        let mut g = self.pending.lock().ok()?;
        if let Some((_, at)) = g.as_ref() {
            if at.elapsed().as_secs() > LOGIN_TTL_SECS {
                *g = None;
            }
        }
        g.as_ref().map(|(v, _)| v.clone())
    }
}

/// JS that hands the re-login target to injected/account.js (`__AK_LOGIN_APPLY__`).
fn login_push_js(creds: &Value) -> String {
    format!(
        "window.__AK_LOGIN_APPLY__&&window.__AK_LOGIN_APPLY__({});",
        creds
    )
}

/// Only arena itself and the sign-in hosts links.rs keeps in place may receive
/// the pending login — never an arbitrary third-party page.
fn login_host_ok(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    links::is_arena_host(host) || links::is_auth_flow(host, url.path())
}

/// What to eval into the webview after a page load finished (None = nothing).
fn login_pending_js(state: &LoginState, url: &tauri::Url) -> Option<String> {
    let creds = state.current()?;
    if !login_host_ok(url) {
        return None;
    }
    Some(login_push_js(&creds))
}

/// Dock (or the embedded dock inside the arena page): start a re-login for one
/// saved account. `creds` = {accountId, email, startedAt}.
#[tauri::command]
fn login_set(state: tauri::State<'_, LoginState>, creds: Value) -> Result<(), String> {
    if !creds.is_object() {
        return Err("登录信息无效".into());
    }
    if creds.to_string().len() > 16 * 1024 {
        return Err("登录信息过大".into());
    }
    state.set(creds);
    Ok(())
}

/// Page (session cookie is back) or dock: forget the pending login.
#[tauri::command]
fn login_clear(state: tauri::State<'_, LoginState>) -> Result<(), String> {
    state.clear();
    Ok(())
}

/// Safari-equivalent UA for the macOS webview. WKWebView's bare default
/// ("… AppleWebKit/605.1.15 (KHTML, like Gecko)") is what Google's sign-in
/// rejects as an embedded browser (403 disallowed_useragent); Android does the
/// same fix natively in MainActivity.kt (drops "; wv" / "Version/4.0").
#[cfg(desktop)]
const DESKTOP_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

// ── trace pipeline ───────────────────────────────────────────────────────

/// Per-app trace state: the last token handed over by snoop.js (the same SSE
/// token is re-emitted per frame; only the first sighting may start a lookup)
/// and a per-session generation counter so a newer token cancels an older
/// lookup for the same conversation (background.js `cancelLookup`).
/// Bound on concurrently polling Trigger.dev lookups (A5): page-side token spam
/// must not be able to spawn an unbounded number of background tasks.
const TRACE_MAX_INFLIGHT: usize = 8;

#[derive(Default)]
pub struct TraceState {
    last_token: Mutex<String>,
    /// session id → generation of the lookup that currently owns it.
    generation: Mutex<HashMap<String, u64>>,
    /// Process-wide, never reused: pruning a finished session's entry must not
    /// let a later lookup take a number an older, still-sleeping poll holds.
    counter: std::sync::atomic::AtomicU64,
    /// Number of lookups currently polling Trigger.dev (see TRACE_MAX_INFLIGHT).
    inflight: std::sync::atomic::AtomicUsize,
}

/// Reserve one of the TRACE_MAX_INFLIGHT lookup slots, or return false if full.
fn try_acquire_trace(inflight: &std::sync::atomic::AtomicUsize) -> bool {
    let mut current = inflight.load(std::sync::atomic::Ordering::Relaxed);
    loop {
        if current >= TRACE_MAX_INFLIGHT {
            return false;
        }
        match inflight.compare_exchange_weak(
            current,
            current + 1,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(next) => current = next,
        }
    }
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
    let _ = app.emit_to(tauri::EventTarget::labeled(dock_label()), "arenakit://trace", payload);
}

/// The webview label the dock listens on (§2.3): its own `dock` webview on
/// desktop, the shared `arena` webview on mobile (single-webview platforms).
/// Desktop page scripts, even with event permission, never see dock events.
#[cfg(desktop)]
pub(crate) const fn dock_label() -> &'static str {
    "dock"
}
#[cfg(mobile)]
pub(crate) const fn dock_label() -> &'static str {
    "arena"
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
        let n = state.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        g.insert(session_id.clone(), n);
        n
    };
    if !try_acquire_trace(&state.inflight) {
        forget_token(&app, &token);
        return Err("同时进行的 trace 查询过多".into());
    }
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
        poll_trace(app.clone(), token, session_id, claims, generation).await;
        app.state::<TraceState>()
            .inflight
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    });
    Ok(())
}

/// Forget a finished lookup's session entry (only if it still owns it), so the
/// map does not grow by one entry per conversation for the life of the app.
fn release_generation(app: &tauri::AppHandle, session_id: &str, generation: u64) {
    let state = app.state::<TraceState>();
    let guard = state.generation.lock();
    if let Ok(mut map) = guard {
        if map.get(session_id).copied() == Some(generation) {
            map.remove(session_id);
        }
    };
}

async fn poll_trace(
    app: tauri::AppHandle,
    token: String,
    session_id: String,
    claims: trace::Claims,
    generation: u64,
) {
    let handle = app.clone();
    let sid = session_id.clone();
    poll_trace_loop(app, token, session_id, claims, generation).await;
    release_generation(&handle, &sid, generation);
}

/// What one successfully handled poll means for the loop.
enum Poll {
    /// Everything that can be learned has been emitted — stop polling.
    Done,
    /// Keep polling; the text is the status line for the dock.
    Continue(String),
}

async fn poll_trace_loop(
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
        // Outcome of this attempt: Ok(Poll) = carry on / finished, Err((fatal, msg)) = stop.
        let outcome: Result<Poll, (bool, String)> = match resp {
            Err(_) => {
                if attempt >= TRACE_MAX_ATTEMPTS {
                    Err((false, "trace 请求失败或超时，请检查网络".into()))
                } else {
                    Ok(Poll::Continue(retry("trace 请求失败或超时")))
                }
            }
            Ok(r) => {
                let status = r.status().as_u16();
                if !r.status().is_success() {
                    let label = trace::trace_status_label(status);
                    if trace::is_fatal_trace_status(status) || attempt >= TRACE_MAX_ATTEMPTS {
                        Err((trace::is_fatal_trace_status(status), label))
                    } else {
                        Ok(Poll::Continue(retry(&label)))
                    }
                } else {
                    match read_capped_to(r, 4 * 1024 * 1024).await {
                        Err(e) if e == "响应过大" => {
                            Err((true, "trace 超过 4 MB，停止解析".into()))
                        }
                        Err(_) => Ok(Poll::Continue(retry("trace 读取失败"))),
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
            Ok(Poll::Continue(s)) if attempt >= TRACE_MAX_ATTEMPTS => Err((false, s)),
            other => other,
        };
        match outcome {
            Err((fatal, msg)) => {
                emit_trace(&app, base(json!({"stage":"error","fatal":fatal,"attempt":attempt,"status":msg})));
                forget_token(&app, &token);
                return;
            }
            Ok(Poll::Done) => {
                emit_trace(&app, base(json!({"stage":"done","attempt":attempt,"status":"trace 读取完成"})));
                forget_token(&app, &token);
                return;
            }
            Ok(Poll::Continue(status)) => {
                emit_trace(&app, base(json!({"stage":"poll","attempt":attempt,"max":TRACE_MAX_ATTEMPTS,"status":status})));
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(TRACE_POLL_SECS)).await;
    }
}

/// Parse one trace snapshot. Emits a `model` stage when model labels are
/// present. Returns `Poll::Done` when polling should stop, `Poll::Continue(status)`
/// to keep polling, Err((fatal,msg)) to stop with an error.
fn handle_trace(
    app: &tauri::AppHandle,
    base: &dyn Fn(Value) -> Value,
    run_id: &str,
    trace_json: &Value,
    attempt: u32,
) -> Result<Poll, (bool, String)> {
    let retry = |label: &str| format!("{}，等待重试 {}/{}", label, attempt, TRACE_MAX_ATTEMPTS);
    let models = match trace::extract_models(trace_json, run_id) {
        Ok(m) => m,
        Err(e) => {
            if attempt >= TRACE_MAX_ATTEMPTS {
                return Err((false, e));
            }
            return Ok(Poll::Continue(retry(&e)));
        }
    };
    if models.is_empty() {
        if attempt >= TRACE_MAX_ATTEMPTS {
            return Err((false, "trace 未包含模型标签；不猜测模型".into()));
        }
        return Ok(Poll::Continue(retry("trace 暂无模型标签")));
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
        Ok(Poll::Done)
    } else {
        Ok(Poll::Continue(status))
    }
}

// ── relay / store / misc commands ────────────────────────────────────────

/// Page events the injected scripts are allowed to relay to the dock. The page
/// is partly untrusted (arena's own JS, analytics, a possible XSS share the
/// MAIN world with our hooks), so the relay accepts only this fixed set of
/// names and caps the serialized payload size — a page cannot invent an event
/// the dock does not expect, nor flood it with an oversized blob. This set is
/// the exact union of the `__ARENAKIT__.send(name, …)` names the injected
/// scripts use (snoop/account/pulse/monitor/watchdog/links/probe/
/// fingerprint) plus the two dock-bus names (openDock, menu) a page may relay.
const ALLOWED_PAGE_EVENTS: &[&str] = &[
    "nav",
    "account",
    "account-result",
    "login",
    "pulse",
    "reply-monitor",
    "fingerprint-sample",
    "watch",
    "link-tab",
    "probe-result",
    "openDock",
    "menu",
];

/// Hard cap on the serialized page-event payload. The legitimate payloads are
/// small structured objects (a token, a numeric summary, a short id list); a
/// larger body is rejected rather than relayed into the dock.
const MAX_PAGE_EVENT_BYTES: usize = 64 * 1024;

/// Page → dock relay. Injected scripts call `__ARENAKIT__.send(name, payload)`;
/// the dock listens to "arenakit://page". Rust does not interpret the payload's
/// MEANING, but it does gate the event name against an allowlist and cap the
/// payload size so the untrusted page cannot drive arbitrary dock events.
#[tauri::command]
fn page_event(app: tauri::AppHandle, name: String, payload: Value) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("事件名无效".into());
    }
    if !ALLOWED_PAGE_EVENTS.contains(&name.as_str()) {
        return Err("事件名不被允许".into());
    }
    // Reject an oversized payload (serialized length). null/small objects pass.
    if let Ok(encoded) = serde_json::to_string(&payload) {
        if encoded.len() > MAX_PAGE_EVENT_BYTES {
            return Err("事件负载过大".into());
        }
    } else {
        return Err("事件负载无法序列化".into());
    }
    app.emit_to(
        tauri::EventTarget::labeled(dock_label()),
        "arenakit://page",
        json!({"name": name, "payload": payload}),
    )
    .map_err(|e| e.to_string())
}

/// Per-launch random token for the credential keys of the store.
///
/// Desktop: the dock is its own webview (label `dock`) and the arena page has
/// no store permission at all. Mobile: the dock is embedded in the arena page,
/// so label checks cannot separate it from page scripts (analytics, an XSS);
/// it is handed this token through the closure of its init script instead.
pub struct DockGuard(pub String);

impl DockGuard {
    fn new() -> DockGuard {
        DockGuard(random_token())
    }
}

/// 32 random bytes as hex: the OS RNG where there is one (macOS, Android,
/// Linux), else a time / address / counter mix hashed with `RandomState`.
fn random_token() -> String {
    use std::io::Read;
    let mut buf = [0u8; 32];
    let filled = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_ok();
    if !filled {
        use std::hash::{BuildHasher, Hasher};
        let addr = &buf as *const _ as usize;
        for chunk in buf.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(now_millis() as u128);
            h.write_usize(addr);
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// May this caller touch `key`? Ordinary keys: always (that is what the store
/// is for). Credential keys (`store::is_protected`): the native dock webview,
/// or a caller presenting the launch token.
fn store_access_ok(key: &str, webview_label: &str, given: Option<&str>, expected: &str) -> bool {
    if !store::is_protected(key) || webview_label == "dock" {
        return true;
    }
    !expected.is_empty() && given == Some(expected)
}

#[tauri::command]
fn store_get(
    webview: tauri::Webview,
    store: tauri::State<'_, store::Store>,
    guard: tauri::State<'_, DockGuard>,
    key: String,
    guard_token: Option<String>,
) -> Result<Value, String> {
    if !store_access_ok(&key, webview.label(), guard_token.as_deref(), &guard.0) {
        return Err("无权访问该键".into());
    }
    Ok(store.get(&key))
}

#[tauri::command]
fn store_set(
    webview: tauri::Webview,
    store: tauri::State<'_, store::Store>,
    guard: tauri::State<'_, DockGuard>,
    key: String,
    value: Value,
    guard_token: Option<String>,
) -> Result<(), String> {
    if !store_access_ok(&key, webview.label(), guard_token.as_deref(), &guard.0) {
        return Err("无权访问该键".into());
    }
    store.set(&key, value)
}

/// Credential keys are left out of the listing unless the caller may see them.
#[tauri::command]
fn store_keys(
    webview: tauri::Webview,
    store: tauri::State<'_, store::Store>,
    guard: tauri::State<'_, DockGuard>,
    prefix: String,
    guard_token: Option<String>,
) -> Vec<String> {
    let trusted = store_access_ok("accounts", webview.label(), guard_token.as_deref(), &guard.0);
    store
        .keys(&prefix)
        .into_iter()
        .filter(|k| trusted || !store::is_protected(k))
        .collect()
}

/// Hosts (and their subdomains) `proxy_get` may fetch: what the injected
/// scripts legitimately need (price table, gist / raw scripts, arena itself).
const PROXY_HOSTS: [&str; 4] = ["raw.githubusercontent.com", "api.github.com", "openrouter.ai", "arena.ai"];
/// Response bodies larger than this are refused (a page-callable command must
/// not be able to make the app buffer an arbitrarily large download).
const PROXY_MAX_BYTES: usize = 8 * 1024 * 1024;
const PROXY_MAX_REDIRECTS: usize = 3;

/// Parse `raw` with a real URL parser and accept it only when it is a plain
/// `https://<allowlisted host>[:443]/…` URL without credentials.
///
/// The check must run on the PARSED host: splitting the string on `/` lets
/// `https://evil.example#.arena.ai/`, `https://evil.example?.arena.ai` and
/// `https://evil.example\.arena.ai` through, because `#`, `?` and `\` end the
/// authority for the WHATWG parser that `reqwest` uses.
fn proxy_target(raw: &str) -> Result<tauri::Url, String> {
    let url = raw
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| "proxy_get 拒绝无效地址".to_string())?;
    let host = url.host_str().map(links::normalize_host).unwrap_or_default();
    let host_ok = PROXY_HOSTS
        .iter()
        .any(|a| host == *a || host.ends_with(&format!(".{a}")));
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.port(), None | Some(443));
    if plain && host_ok {
        Ok(url)
    } else {
        Err("proxy_get 拒绝非白名单地址".to_string())
    }
}

/// One client for every proxied request: connection reuse, a hard timeout and
/// redirects only to addresses that pass `proxy_target` again.
fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            // api.github.com rejects requests that carry no User-Agent.
            .user_agent(concat!("ArenaKit/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() <= PROXY_MAX_REDIRECTS && proxy_target(attempt.url().as_str()).is_ok() {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .unwrap_or_default()
    })
}

/// Bypass page CORS for logo/price/gist fetches used by injected scripts.
/// Callable by scripts running on arena.ai, hence the strict allowlist, the
/// status check (an error page is not data) and the size cap.
#[tauri::command]
async fn proxy_get(url: String) -> Result<Value, String> {
    let target = proxy_target(&url)?;
    let resp = proxy_client().get(target).send().await.map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(format!("proxy_get: HTTP {}", resp.status().as_u16()));
    }
    let text = read_capped(resp).await?;
    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
}

/// A request failure with its whole cause chain. reqwest's own `Display` stops at
/// "error sending request for url (…)", which hides whether DNS, connect, TLS or a
/// timeout failed — the part that matters when a VPN / proxy app is in the way.
fn net_err(e: reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        msg.push_str(": ");
        msg.push_str(&cause.to_string());
        source = cause.source();
    }
    msg
}

/// The response body as text, refusing anything over `max` bytes (checks both
/// the advertised Content-Length and the streamed size).
async fn read_capped_to(mut resp: reqwest::Response, max: usize) -> Result<String, String> {
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err("响应过大".into());
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > max {
            return Err("响应过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// The response body as text, refusing anything over `PROXY_MAX_BYTES`.
async fn read_capped(resp: reqwest::Response) -> Result<String, String> {
    read_capped_to(resp, PROXY_MAX_BYTES).await
}

// ── GitHub Gist sync (Arena Manager's cloud backup) ──────────────────────
// The token is kept in the credential store (`secret.gistToken`) and used
// here: page scripts can set or clear it and ask for a Gist request, but can
// never read it back, and can only reach api.github.com/gists.
const GIST_TOKEN_KEY: &str = "secret.gistToken";
const GIST_MAX_BODY: usize = 2 * 1024 * 1024;

/// Only the request shapes Arena Manager's Gist sync makes (A2). A body must be
/// an object, is never `public: true` (the token must not become a "publish a
/// gist under this account" oracle for page scripts), and `files` carries plain
/// file names only.
fn vet_gist_body(body: &mut Value) -> Result<(), String> {
    let obj = body
        .as_object_mut()
        .ok_or_else(|| "Gist 请求体必须是对象".to_string())?;
    obj.insert("public".into(), Value::Bool(false));
    if let Some(files) = obj.get("files") {
        let files = files.as_object().ok_or_else(|| "Gist files 无效".to_string())?;
        let name_ok = |k: &String| {
            !k.is_empty()
                && k.len() <= 64
                && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        };
        if files.len() > 16 || !files.keys().all(name_ok) {
            return Err("Gist 文件名无效".into());
        }
    }
    Ok(())
}

/// `https://api.github.com/gists[/<id>]` for an allowed method / id pair:
/// creating (POST) takes no id, reading (GET) and updating (PATCH) need one.
fn gist_url(method: &str, gist_id: Option<&str>) -> Result<String, String> {
    let id = gist_id.map(str::trim).filter(|i| !i.is_empty());
    if let Some(i) = id {
        if i.len() > 64 || !i.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Gist ID 无效".into());
        }
    }
    match (method, id) {
        ("POST", None) => Ok("https://api.github.com/gists".to_string()),
        ("GET", Some(i)) | ("PATCH", Some(i)) => Ok(format!("https://api.github.com/gists/{i}")),
        _ => Err("不支持的 Gist 请求".into()),
    }
}

#[tauri::command]
fn gist_token_set(store: tauri::State<'_, store::Store>, token: String) -> Result<(), String> {
    let t = token.trim();
    if t.len() > 512 {
        return Err("Token 过长".into());
    }
    store.set(GIST_TOKEN_KEY, if t.is_empty() { Value::Null } else { Value::String(t.to_string()) })
}

#[tauri::command]
fn gist_token_status(store: tauri::State<'_, store::Store>) -> bool {
    store.get(GIST_TOKEN_KEY).as_str().is_some_and(|t| !t.is_empty())
}

/// → `{status, body}` (any HTTP status: the caller maps 401 / 404 itself).
#[tauri::command]
async fn gist_request(
    store: tauri::State<'_, store::Store>,
    method: String,
    gist_id: Option<String>,
    body: Option<Value>,
) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    let url = gist_url(&method, gist_id.as_deref())?;
    let token = match store.get(GIST_TOKEN_KEY) {
        Value::String(t) if !t.is_empty() => t,
        _ => return Err("未设置 GitHub Token".into()),
    };
    let target = proxy_target(&url)?;
    let client = proxy_client();
    let mut req = match method.as_str() {
        "GET" => client.get(target),
        "POST" => client.post(target),
        _ => client.patch(target),
    }
    .header("Authorization", format!("token {token}"))
    .header("Accept", "application/vnd.github.v3+json");
    if let Some(mut b) = body {
        vet_gist_body(&mut b)?;
        let text = serde_json::to_string(&b).map_err(|e| e.to_string())?;
        if text.len() > GIST_MAX_BODY {
            return Err("请求体过大".into());
        }
        req = req.header("Content-Type", "application/json").body(text);
    }
    let resp = req.send().await.map_err(net_err)?;
    let status = resp.status().as_u16();
    let text = read_capped(resp).await?;
    Ok(json!({ "status": status, "body": text }))
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
        // The desktop OS hands the URL to whatever registered its scheme
        // (smb:, ssh:, ms-msdt: …): only web and mail/phone links go out.
        if !links::is_desktop_openable(&url) {
            eprintln!("[ArenaKit] blocked external scheme: {}", url.split(':').next().unwrap_or(""));
            return;
        }
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
        .invoke_handler(tauri::generate_handler![
            on_token,
            page_event,
            store_get,
            store_set,
            store_keys,
            proxy_get,
            gist_request,
            gist_token_set,
            gist_token_status,
            open_tab,
            arena_command,
            login_set,
            login_clear
        ])
        .setup(move |app| {
            // Persistent store + trace state, available to every command.
            let data_dir = app.path().app_data_dir()?;
            app.manage(store::Store::open(data_dir.join("arenakit-store.json")));
            app.manage(TraceState::default());
            app.manage(DockGuard::new());
            app.manage(LoginState::default());

            // Desktop: split-view window. `arena.ai` webview on the left,
            // ArenaKit native dock webview on the right. The dock lives in
            // its own webview (not injected into the page), so arena redesigns
            // can't break it. The embedded pill is Android-only now; the
            // `prefs.desktopLayout` setting was removed.
            #[cfg(desktop)]
            {
                let _ = desktop_layout(&app.state::<store::Store>().get("prefs"));
                let init = build_init_script(None, "desktop", "");
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
                let load_app = app.handle().clone();
                let _arena = window.add_child(
                    tauri::webview::WebviewBuilder::new(
                        "arena",
                        WebviewUrl::External("https://arena.ai/agent".parse().unwrap()),
                    )
                    .initialization_script(&init)
                    .user_agent(DESKTOP_USER_AGENT)
                    // Links to other sites open in a separate window, never
                    // over the conversation (links.rs).
                    .on_navigation(move |url| route_navigation(&nav_app, url))
                    // Pending account login → hand the target to the page
                    // (arena.ai or a sign-in host) once it finished loading.
                    .on_page_load(move |wv, payload| {
                        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            return;
                        }
                        let state = load_app.state::<LoginState>();
                        if let Some(js) = login_pending_js(&state, payload.url()) {
                            let _ = wv.eval(&js);
                        }
                    })
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
            // Desktop menu bar: 「页面」 (刷新 ⌘R · 后退 ⌘[ · 前进 ⌘] · 在浏览器中打开
            // · 复制链接) on top of Tauri's default Edit / Window menus — the
            // desktop counterpart of the Android link tab toolbar.
            #[cfg(desktop)]
            menu::install(app)?;

            #[cfg(mobile)]
            {
                let init = build_init_script(Some(DOCK_EMBED_JS), "mobile", &app.state::<DockGuard>().0);
                let nav_app = app.handle().clone();
                let load_app = app.handle().clone();
                let _arena = tauri::WebviewWindowBuilder::new(
                    app,
                    "arena",
                    WebviewUrl::External("https://arena.ai/agent".parse().unwrap()),
                )
                .initialization_script(&init)
                // Links to other sites open in the native link tab layer
                // (MainActivity overlay), never over the conversation.
                .on_navigation(move |url| route_navigation(&nav_app, url))
                // Pending account login → target to the page after load
                // (the embedded dock died with the previous page, Rust remembers).
                .on_page_load(move |wv, payload| {
                    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        return;
                    }
                    let state = load_app.state::<LoginState>();
                    if let Some(js) = login_pending_js(&state, payload.url()) {
                        let _ = wv.eval(&js);
                    }
                })
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
    fn credential_keys_need_the_dock_or_the_launch_token() {
        let tok = "abc123";
        // Ordinary keys: anyone who may use the store.
        assert!(store_access_ok("prefs", "arena", None, tok));
        // Credential keys: the native dock webview, or the token.
        for key in ["accounts", "secret.gistToken"] {
            assert!(store_access_ok(key, "dock", None, tok), "{key}: dock");
            assert!(store_access_ok(key, "arena", Some(tok), tok), "{key}: token");
            assert!(!store_access_ok(key, "arena", None, tok), "{key}: page without token");
            assert!(!store_access_ok(key, "arena", Some("wrong"), tok), "{key}: wrong token");
            assert!(!store_access_ok(key, "arena", Some(""), ""), "{key}: empty token never matches");
        }
    }

    #[test]
    fn launch_tokens_are_long_hex_and_differ() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn gist_requests_are_limited_to_the_gists_api() {
        assert_eq!(gist_url("POST", None).unwrap(), "https://api.github.com/gists");
        assert_eq!(gist_url("POST", Some("  ")).unwrap(), "https://api.github.com/gists");
        assert_eq!(gist_url("GET", Some("abc123")).unwrap(), "https://api.github.com/gists/abc123");
        assert_eq!(gist_url("PATCH", Some("abc123")).unwrap(), "https://api.github.com/gists/abc123");
        for (m, id) in [
            ("GET", None),
            ("PATCH", None),
            ("DELETE", Some("abc")),
            ("POST", Some("abc")),
            ("GET", Some("../user")),
            ("GET", Some("a/b")),
            ("GET", Some("abc?x=1")),
        ] {
            assert!(gist_url(m, id).is_err(), "{m} {id:?}");
        }
        // Whatever the id, the target passes the proxy allowlist.
        assert!(proxy_target(&gist_url("GET", Some("abc123")).unwrap()).is_ok());
    }

    #[test]
    fn gist_bodies_are_private_and_plainly_named() {
        let mut b = json!({"public": true, "files": {"arena-manager-data.json": {"content": "{}"}}});
        vet_gist_body(&mut b).unwrap();
        assert_eq!(b["public"], json!(false));
        for bad in [
            json!([]),
            json!("x"),
            json!({"files": "x"}),
            json!({"files": {"../x": {}}}),
            json!({"files": {"a b.json": {}}}),
        ] {
            let mut v = bad;
            assert!(vet_gist_body(&mut v).is_err());
        }
    }

    #[test]
    fn trace_inflight_limit_is_atomic_and_bounded() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let n = AtomicUsize::new(0);
        for _ in 0..TRACE_MAX_INFLIGHT {
            assert!(try_acquire_trace(&n));
        }
        assert!(!try_acquire_trace(&n), "the {TRACE_MAX_INFLIGHT}+1 th lookup is refused");
        n.fetch_sub(1, Ordering::AcqRel);
        assert!(try_acquire_trace(&n), "a freed slot can be re-acquired");
    }

    #[test]
    fn proxy_target_accepts_allowlisted_https_hosts() {
        for u in [
            "https://openrouter.ai/api/v1/models",
            "https://raw.githubusercontent.com/o/r/main/x.js",
            "https://api.github.com/gists/1",
            "https://arena.ai/api/x",
            "https://ARENA.AI:443/api/x",
            "https://cdn.arena.ai/a.png?x=1#frag",
        ] {
            assert!(proxy_target(u).is_ok(), "{u}");
        }
    }

    #[test]
    fn proxy_target_rejects_authority_confusion() {
        // The host the request would really go to is NOT allowlisted in any of these.
        for u in [
            "https://evil.example#.arena.ai/",
            "https://evil.example?.arena.ai/",
            "https://evil.example\\.arena.ai/",
            "https://127.0.0.1:8080#.arena.ai/",
            "https://arena.ai@evil.example/",
            "https://arena.ai:pw@evil.example/",
            "https://evilarena.ai/",
            "https://arena.ai.evil.example/",
        ] {
            assert!(proxy_target(u).is_err(), "{u}");
        }
    }

    #[test]
    fn proxy_target_rejects_other_schemes_ports_and_junk() {
        for u in [
            "http://openrouter.ai/api/v1/models",
            "https://openrouter.ai:8443/api",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "//openrouter.ai/x",
            "openrouter.ai/x",
            "",
        ] {
            assert!(proxy_target(u).is_err(), "{u}");
        }
    }

    #[test]
    fn init_script_isolates_every_module() {
        let s = build_init_script(None, "desktop", "");
        // platform stamp, then bridge first, every module wrapped, UI scripts deferred.
        assert!(s.starts_with("window.__ARENAKIT_PLATFORM__=\"desktop\";\ntry{\n"));
        assert!(build_init_script(None, "mobile", "").starts_with("window.__ARENAKIT_PLATFORM__=\"mobile\";\n"));
        assert!(s.find("__ARENAKIT__").unwrap() < s.find("[ArenaKit] snoop init failed").unwrap());
        for name in ["bridge", "snoop", "monitor", "fingerprint", "pulse", "eni", "conversation-rename", "probe", "watchdog", "links", "account"] {
            assert!(s.contains(&format!("[ArenaKit] {} init failed", name)), "{}", name);
        }
        assert!(s.contains("DOMContentLoaded"));
        assert!(!s.contains("dock-embedded init failed"));
        // the account script runs at document_start (before the deferred UI
        // block); the TOTP lib is gone with the old login helper
        assert!(!s.contains("totp init failed"));
        let account = s.find("[ArenaKit] account init failed").unwrap();
        let deferred = s.find("var run=function(){").unwrap();
        assert!(account < deferred);
        // UI scripts / the embedded dock only mount on arena hosts
        assert!(s.contains("(arena\\.ai|lmarena\\.ai)$/.test(location.hostname||''))return;"));
        assert!(s.find("lmarena\\.ai)$/.test(location.hostname").unwrap() < deferred);
        // page hooks are gated to arena hosts; the login helper is not
        let flag = s.find("window.__ARENAKIT_ON_ARENA__=").unwrap();
        for name in ["snoop", "monitor", "fingerprint", "pulse", "eni", "conversation-rename", "probe", "watchdog", "links"] {
            let at = s.find(&format!("[ArenaKit] {} init failed", name)).unwrap();
            let gate = s[..at].rfind("if(window.__ARENAKIT_ON_ARENA__){").unwrap();
            assert!(flag < gate, "{}", name);
            assert!(!s[gate..at].contains("init failed"), "{} sits in its own gate", name);
        }
        for name in ["bridge", "account"] {
            let at = s.find(&format!("[ArenaKit] {} init failed", name)).unwrap();
            let open = s[..at].rfind("if(window.__ARENAKIT_ON_ARENA__){");
            let close_before = open.map(|o| s[o..at].contains("init failed',e);}\n}\n")).unwrap_or(true);
            assert!(close_before, "{} runs on every host", name);
        }
    }

    #[test]
    fn login_state_ttl_hosts_and_js() {
        let st = LoginState::default();
        let arena: tauri::Url = "https://arena.ai/".parse().unwrap();
        let google: tauri::Url = "https://accounts.google.com/v3/signin/identifier?x=1".parse().unwrap();
        let other: tauri::Url = "https://example.com/login".parse().unwrap();
        assert!(login_pending_js(&st, &arena).is_none(), "nothing pending");
        st.set(json!({"accountId": "a1", "email": "a@b.c", "startedAt": 1}));
        let js = login_pending_js(&st, &arena).unwrap();
        assert!(js.starts_with("window.__AK_LOGIN_APPLY__&&window.__AK_LOGIN_APPLY__({"));
        assert!(js.contains("\"email\":\"a@b.c\""));
        assert!(login_pending_js(&st, &google).is_some(), "sign-in host gets it");
        assert!(login_pending_js(&st, &other).is_none(), "third-party page never gets it");
        // still pending after a non-matching host
        assert!(st.current().is_some());
        st.clear();
        assert!(login_pending_js(&st, &arena).is_none());
        // expired entries are dropped on read (checked_sub: a freshly booted CI
        // runner may not have LOGIN_TTL_SECS of monotonic clock behind it)
        if let Some(past) = std::time::Instant::now().checked_sub(std::time::Duration::from_secs(LOGIN_TTL_SECS + 1)) {
            if let Ok(mut g) = st.pending.lock() {
                *g = Some((json!({}), past));
            }
            assert!(st.current().is_none());
        }
        assert!(login_host_ok(&"https://appleid.apple.com/auth/authorize".parse().unwrap()));
        assert!(login_host_ok(&"https://xyz.supabase.co/auth/v1/authorize".parse().unwrap()));
        assert!(!login_host_ok(&"https://arena.ai.evil.com/".parse().unwrap()));
    }

    #[test]
    fn embedded_dock_is_appended_last_in_the_deferred_block() {
        let s = build_init_script(Some("/*DOCK*/"), "mobile", "tok-123");
        let dock = s.find("/*DOCK*/").unwrap();
        // bridge.js has its own DOMContentLoaded hook; the deferred-run trailer is the LAST one.
        assert!(dock < s.rfind("DOMContentLoaded").unwrap());
        assert!(s.contains("[ArenaKit] dock-embedded init failed"));
        // the launch token is only the wrapper's argument, never a page global
        assert!(s.contains("(function(__AK_GUARD__){"));
        assert!(s.contains("})(\"tok-123\");"));
        assert_eq!(s.matches("tok-123").count(), 1);
        assert!(!build_init_script(None, "desktop", "tok-123").contains("tok-123"));
        // the committed bundle is a self-contained classic script
        let bundle = include_str!("../../src/embed/dock-embedded.gen.js");
        assert!(bundle.starts_with("/* GENERATED by scripts/bundle-dock.mjs"));
        assert!(bundle.contains("__define(\"dock.js\""));
        assert!(bundle.contains("__define(\"embed/shell.js\""));
        assert!(!bundle.contains("\nimport "));
    }

    #[test]
    fn desktop_layout_is_always_dock_on_macos() {
        // macOS / desktop only ships the split-view (Dock) layout now — the
        // embedded pill is Android-only. Historical `desktopLayout` prefs are
        // accepted but ignored.
        assert_eq!(desktop_layout(&json!({"desktopLayout": "dock"})), DesktopLayout::Dock);
        assert_eq!(desktop_layout(&json!({"desktopLayout": "pill"})), DesktopLayout::Dock);
        assert_eq!(desktop_layout(&json!({"desktopLayout": 3})), DesktopLayout::Dock);
        assert_eq!(desktop_layout(&json!({})), DesktopLayout::Dock);
        assert_eq!(desktop_layout(&Value::Null), DesktopLayout::Dock);
    }

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("abc-123"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("bad/id"));
        assert!(!valid_session_id(&"x".repeat(129)));
    }

    #[test]
    fn page_event_allowlist_covers_every_injected_sender() {
        // The relay must accept exactly the page events the injected scripts
        // can emit — the fingerprint reducer's 'fingerprint-sample' included —
        // and nothing a hostile page could invent. These are the literal
        // `__ARENAKIT__.send(name, …)` names across injected/, plus the two
        // dock-bus names (openDock, menu) a page may relay.
        for name in [
            "nav",
            "account",
            "account-result",
            "login",
            "pulse",
            "reply-monitor",
            "fingerprint-sample",
            "watch",
            "link-tab",
            "probe-result",
            "openDock",
            "menu",
        ] {
            assert!(
                ALLOWED_PAGE_EVENTS.contains(&name),
                "allowlist is missing injected sender {name}"
            );
        }
        // Names a page must NOT be able to drive.
        for name in ["", "on_token", "proxy_get", "store_set", "arbitrary", "fingerprint"] {
            assert!(
                !ALLOWED_PAGE_EVENTS.contains(&name),
                "allowlist should not contain {name:?}"
            );
        }
        // The size cap is a sane, finite guard for the small structured payloads
        // the page is allowed to relay (a numeric summary, a short id list).
        assert_eq!(MAX_PAGE_EVENT_BYTES, 64 * 1024);
    }
}
