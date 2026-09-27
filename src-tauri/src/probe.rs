//! Auto-probe / cleanup / quick-send orchestrator — a port of
//! arena-trace-android `ProbeController.kt` onto Tauri.
//!
//! The loop runs in Rust and drives the arena.ai page through discrete
//! JS-RPC calls (`window.ArenaProbe.call(action, args, reqId)` from
//! injected/probe.js); the page answers through `page_event{kind:"probe"}`.
//! Model names come from the app's existing snoop → `fetch_trace` pipeline,
//! keyed by session id (see `TabMemory` in lib.rs).
//!
//! Everything is explicit-start / cancellable-stop. The probe sends REAL
//! messages that consume quota — the UI says so before [start].

use crate::probe_logic as logic;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const RPC_TIMEOUT: Duration = Duration::from_secs(35);
pub const MODEL_WAIT: Duration = Duration::from_secs(45);
/// Space out probe rounds so we don't hammer Arena and trip 429 rate limits.
pub const ROUND_PACING: Duration = Duration::from_secs(2);
const LOG_KEEP: usize = 40;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ProbeConfig {
    /// Raw target text ("opus5, fable5, gpt6" — commas / newlines, `/regex/` allowed).
    #[serde(default)]
    pub targets: String,
    #[serde(default = "default_rounds")]
    pub max_rounds: u32,
    /// true = keep probing until EVERY target is hit; false = stop at first hit.
    #[serde(default = "yes")]
    pub find_all: bool,
    /// Rename the hit conversation to `<prefix><model>[-NNN]`.
    #[serde(default = "yes")]
    pub auto_rename: bool,
    /// Optional title prefix ("探针·").
    #[serde(default)]
    pub prefix: String,
    /// Append the per-model `-NNN` counter (probe mode); off = draw mode.
    #[serde(default = "yes")]
    pub suffix: bool,
}

fn yes() -> bool {
    true
}
fn default_rounds() -> u32 {
    5
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            targets: logic::DEFAULT_TARGETS.join(", "),
            max_rounds: 5,
            find_all: true,
            auto_rename: true,
            prefix: String::new(),
            suffix: true,
        }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ProbeStatus {
    pub active: bool,
    /// "idle" | "probe" | "cleanup" | "quick"
    pub kind: String,
    pub round: u32,
    pub max_rounds: u32,
    pub hits: Vec<logic::Hit>,
    pub archived: u32,
    pub log: Vec<String>,
    pub last: String,
}

/// Per-tab runtime of the orchestrator.
#[derive(Default)]
pub struct ProbeRuntime {
    pub status: ProbeStatus,
    pub cancel: Arc<AtomicBool>,
    pub suffix_counters: std::collections::BTreeMap<String, u32>,
}

impl ProbeRuntime {
    fn begin(&mut self, kind: &str, max_rounds: u32) -> Arc<AtomicBool> {
        self.cancel = Arc::new(AtomicBool::new(false));
        self.status = ProbeStatus {
            active: true,
            kind: kind.into(),
            round: 0,
            max_rounds,
            hits: Vec::new(),
            archived: 0,
            log: Vec::new(),
            last: String::new(),
        };
        self.cancel.clone()
    }
    fn push_log(&mut self, line: &str) {
        self.status.last = line.to_string();
        self.status.log.push(line.to_string());
        while self.status.log.len() > LOG_KEEP {
            self.status.log.remove(0);
        }
    }
}

// ── JS-RPC plumbing ──────────────────────────────────────────────────────

type Waiter = tokio::sync::oneshot::Sender<Value>;

fn pending() -> &'static Mutex<HashMap<String, Waiter>> {
    static P: OnceLock<Mutex<HashMap<String, Waiter>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

static REQ_SEQ: AtomicU64 = AtomicU64::new(0);

/// Called from `page_event{kind:"probe"}` (any thread).
pub fn deliver(payload: &Value) {
    let Some(req_id) = payload.get("reqId").and_then(Value::as_str) else { return };
    let waiter = pending().lock().unwrap_or_else(|p| p.into_inner()).remove(req_id);
    if let Some(tx) = waiter {
        let _ = tx.send(payload.clone());
    }
}

/// One JS-RPC call: throws on `ok:false`, on a closed page or on timeout.
pub async fn rpc(app: &AppHandle, label: &str, action: &str, args: Value) -> Result<Value, String> {
    let req_id = format!("r{}", REQ_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    pending().lock().unwrap_or_else(|p| p.into_inner()).insert(req_id.clone(), tx);
    let wv = app.get_webview(label).ok_or_else(|| "页面已关闭".to_string())?;
    let js = format!(
        "window.ArenaProbe&&window.ArenaProbe.call({},{},{});",
        serde_json::to_string(action).unwrap_or_default(),
        serde_json::to_string(&args.to_string()).unwrap_or_default(),
        serde_json::to_string(&req_id).unwrap_or_default()
    );
    if let Err(e) = wv.eval(&js) {
        pending().lock().unwrap_or_else(|p| p.into_inner()).remove(&req_id);
        return Err(format!("{action}: {e}"));
    }
    match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(res)) => {
            if res.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(res.get("data").cloned().unwrap_or(json!({})))
            } else {
                Err(res.get("error").and_then(Value::as_str).unwrap_or("失败").to_string())
            }
        }
        Ok(Err(_)) => Err(format!("{action}: 页面桥接已关闭")),
        Err(_) => {
            pending().lock().unwrap_or_else(|p| p.into_inner()).remove(&req_id);
            Err(format!("{action} 超时"))
        }
    }
}

// ── glue back into lib.rs (state access, events) ────────────────────────

/// What the orchestrator needs from the host. Implemented in lib.rs.
pub trait Host: Send + Sync + 'static {
    /// Models resolved so far for (tab, session), oldest first.
    fn models_for(&self, label: &str, session_id: &str) -> Option<Vec<String>>;
    /// Mutate this tab's runtime; returns false when the tab is gone.
    fn with_runtime(&self, label: &str, f: &mut dyn FnMut(&mut ProbeRuntime));
    /// Publish a progress line + the current status snapshot to shell & HUD.
    fn publish(&self, label: &str, text: Option<&str>);
    /// Session currently open in that tab (from the last nav/state report).
    fn current_session(&self, label: &str) -> Option<String>;
}

fn log(host: &dyn Host, label: &str, line: String) {
    host.with_runtime(label, &mut |rt| rt.push_log(&line));
    host.publish(label, Some(&line));
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

async fn await_models(host: &dyn Host, label: &str, session_id: &str, cancel: &AtomicBool) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + MODEL_WAIT;
    while tokio::time::Instant::now() < deadline && !cancelled(cancel) {
        if let Some(m) = host.models_for(label, session_id) {
            if !m.is_empty() {
                return m;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Vec::new()
}

async fn pace(cancel: &AtomicBool) {
    for _ in 0..4 {
        if cancelled(cancel) {
            return;
        }
        tokio::time::sleep(ROUND_PACING / 4).await;
    }
}

/// Start the probe loop for a tab. Returns Err if one is already running.
pub fn start(app: AppHandle, host: Arc<dyn Host>, label: String, cfg: ProbeConfig) -> Result<(), String> {
    let targets = logic::parse_targets(&cfg.targets);
    if targets.is_empty() {
        return Err("请先填写至少一个探针目标".into());
    }
    if cfg.max_rounds == 0 || cfg.max_rounds > 200 {
        return Err("轮数需在 1–200 之间".into());
    }
    let mut already = false;
    let mut cancel = Arc::new(AtomicBool::new(false));
    host.with_runtime(&label, &mut |rt| {
        if rt.status.active {
            already = true;
        } else {
            cancel = rt.begin("probe", cfg.max_rounds);
        }
    });
    if already {
        return Err("探针 / 清理已在运行".into());
    }
    tauri::async_runtime::spawn(async move {
        run_probe(&app, host.as_ref(), &label, &cfg, targets, cancel).await;
    });
    Ok(())
}

async fn run_probe(app: &AppHandle, host: &dyn Host, label: &str, cfg: &ProbeConfig, targets: Vec<String>, cancel: Arc<AtomicBool>) {
    let mut hits: Vec<logic::Hit> = Vec::new();
    let mut renamed_any = false;
    let mode = if cfg.find_all { "命中全部才停" } else { "命中即停" };
    log(host, label, format!("开始探针 · 目标 {} · {mode} · 最多 {} 轮", targets.join("、"), cfg.max_rounds));
    let mut outcome = String::new();
    'rounds: for round in 1..=cfg.max_rounds {
        if cancelled(&cancel) {
            break;
        }
        host.with_runtime(label, &mut |rt| rt.status.round = round);
        let outstanding = logic::remaining_targets(&targets, &hits);
        let pacing = if cfg.find_all { format!("待命中 {}", outstanding.join("、")) } else { "命中即停".to_string() };
        let prompt = logic::random_prompt();
        log(host, label, format!("第 {round} 轮 · 发送 \"{prompt}\" · {pacing}"));

        // 1) fresh chat, 2) confirm Agent Mode, 3) send the probe prompt
        let steps: [(&str, Value); 3] = [
            ("newChat", json!({})),
            ("ensureAgentMode", json!({})),
            ("send", json!({ "prompt": prompt })),
        ];
        let mut session_id = String::new();
        for (action, args) in steps {
            if cancelled(&cancel) {
                break 'rounds;
            }
            match rpc(app, label, action, args).await {
                Ok(v) => {
                    if action == "send" {
                        session_id = v.get("session").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                }
                Err(e) => {
                    outcome = format!("探针中断:{e}");
                    break 'rounds;
                }
            }
        }
        if session_id.is_empty() {
            log(host, label, "未拿到会话 id,跳过本轮".into());
            pace(&cancel).await;
            continue;
        }

        // 4) wait for the model name via the snoop → trace pipeline
        let models = await_models(host, label, &session_id, &cancel).await;
        if cancelled(&cancel) {
            break;
        }
        if models.is_empty() {
            log(host, label, format!("第 {round} 轮未识别模型,继续"));
            pace(&cancel).await;
            continue;
        }
        log(host, label, format!("识别到:{}", models.join(" / ")));

        // 5) match against the FULL target list every round (non-draining).
        let round_hits = logic::match_targets(&models, &targets);
        for h in &round_hits {
            log(host, label, format!("命中目标 {} → {}", h.target, h.model));
            hits.push(h.clone());
        }
        let snapshot = hits.clone();
        host.with_runtime(label, &mut |rt| rt.status.hits = snapshot.clone());
        host.publish(label, None);

        if !round_hits.is_empty() && cfg.auto_rename {
            let model = models.first().cloned().unwrap_or_else(|| round_hits[0].model.clone());
            let mut suffix = None;
            if cfg.suffix {
                let mut s = String::new();
                host.with_runtime(label, &mut |rt| s = logic::next_suffix(&model, &mut rt.suffix_counters));
                suffix = Some(s);
            }
            let title = logic::compose_title(&cfg.prefix, &model, suffix.as_deref());
            match rpc(app, label, "rename", json!({ "sessionId": session_id, "title": title })).await {
                Ok(_) => log(host, label, format!("已重命名为 {title}")),
                Err(e) => log(host, label, format!("重命名失败:{e}")),
            }
            renamed_any = true;
        }

        if cfg.find_all {
            if logic::all_targets_hit(&targets, &hits) {
                log(host, label, "全部目标已命中,停止".into());
                break;
            }
        } else if !round_hits.is_empty() {
            log(host, label, "命中,按设置停止".into());
            break;
        }
        pace(&cancel).await;
    }
    if outcome.is_empty() {
        let hit_str = if hits.is_empty() {
            "无".to_string()
        } else {
            hits.iter().map(|h| format!("{}→{}", h.target, h.model)).collect::<Vec<_>>().join("、")
        };
        outcome = if cancelled(&cancel) { format!("探针已停止(命中 {} 个)", hits.len()) } else { format!("探针结束 · 命中:{hit_str}") };
    }
    // Auto-rename opens the sidebar to reach a chat's ⋯ menu; close it once.
    if renamed_any {
        let _ = rpc(app, label, "collapseSidebar", json!({})).await;
    }
    host.with_runtime(label, &mut |rt| {
        rt.status.active = false;
        rt.push_log(&outcome);
    });
    host.publish(label, Some(&outcome));
}

/// Stop whatever is running on that tab (takes effect between steps).
pub fn stop(host: &dyn Host, label: &str) -> bool {
    let mut was_active = false;
    host.with_runtime(label, &mut |rt| {
        was_active = rt.status.active;
        rt.cancel.store(true, Ordering::Relaxed);
    });
    was_active
}

/// Sidebar title sweep: archive chats whose title is bare arithmetic (probe
/// residue). Never deletes; never touches user-named chats; skips the chat
/// that is currently open.
pub fn cleanup(app: AppHandle, host: Arc<dyn Host>, label: String) -> Result<(), String> {
    let mut already = false;
    let mut cancel = Arc::new(AtomicBool::new(false));
    host.with_runtime(&label, &mut |rt| {
        if rt.status.active {
            already = true;
        } else {
            cancel = rt.begin("cleanup", 0);
        }
    });
    if already {
        return Err("探针 / 清理已在运行".into());
    }
    tauri::async_runtime::spawn(async move {
        run_cleanup(&app, host.as_ref(), &label, cancel).await;
    });
    Ok(())
}

async fn fetch_sidebar(app: &AppHandle, label: &str, expand: bool) -> Result<Vec<logic::SidebarItem>, String> {
    let data = rpc(app, label, "sidebarList", json!({ "expand": expand })).await?;
    let items = data.get("items").cloned().unwrap_or(json!([]));
    serde_json::from_value::<Vec<logic::SidebarItem>>(items).map_err(|e| format!("侧栏数据无法解析: {e}"))
}

async fn run_cleanup(app: &AppHandle, host: &dyn Host, label: &str, cancel: Arc<AtomicBool>) {
    let keep = host.current_session(label);
    let mut ok = 0u32;
    let mut failed = 0u32;
    let mut sidebar_opened = false;
    let outcome;
    log(host, label, "扫描侧栏算式标题…".into());
    'sweep: {
        // Open the sidebar ONCE up front; later scans pass expand=false.
        if let Err(e) = rpc(app, label, "sidebarList", json!({ "expand": true })).await {
            outcome = format!("清理中断:{e}");
            break 'sweep;
        }
        sidebar_opened = true;
        let mut done: std::collections::HashSet<String> = Default::default();
        let mut archived: std::collections::HashSet<String> = Default::default();
        let mut consecutive_failures = 0;
        loop {
            if cancelled(&cancel) {
                outcome = format!("清理已停止(已归档 {ok})");
                break 'sweep;
            }
            // After an archive the sidebar may still be repopulating, so an
            // empty result isn't conclusive — retry twice with fresh loads.
            let mut candidate = None;
            for (i, wait_ms) in [0u64, 1000, 1500].iter().enumerate() {
                if *wait_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(*wait_ms)).await;
                }
                match fetch_sidebar(app, label, false).await {
                    Ok(list) => {
                        candidate = logic::arithmetic_cleanup_candidates(&list, keep.as_deref())
                            .into_iter()
                            .find(|c| !done.contains(&c.session_id));
                    }
                    Err(e) => {
                        if i == 2 {
                            outcome = format!("清理中断:{e}");
                            break 'sweep;
                        }
                    }
                }
                if candidate.is_some() {
                    break;
                }
            }
            let Some(c) = candidate else { break };
            if ok + failed == 0 {
                log(host, label, "发现算式标题对话,开始归档".into());
            }
            // Extension-parity hardening: reveal the (virtualized) row first,
            // archive from its ⋯ menu without opening the chat, retry once.
            let mut last_err = String::new();
            let mut archived_ok = false;
            for attempt in 0..2 {
                let reveal = rpc(app, label, "revealSidebarItem", json!({ "sessionId": c.session_id })).await;
                let res = match reveal {
                    Ok(_) => rpc(app, label, "archive", json!({ "sessionId": c.session_id, "requireCurrentUrl": false, "manageSidebar": false })).await,
                    Err(e) => Err(e),
                };
                match res {
                    Ok(_) => {
                        archived_ok = true;
                        break;
                    }
                    Err(e) => {
                        last_err = e;
                        if attempt == 0 {
                            tokio::time::sleep(Duration::from_millis(1200)).await;
                        }
                    }
                }
            }
            done.insert(c.session_id.clone());
            if archived_ok {
                ok += 1;
                archived.insert(c.session_id.clone());
                consecutive_failures = 0;
                host.with_runtime(label, &mut |rt| rt.status.archived = ok);
                log(host, label, format!("已归档 {}", c.title));
            } else {
                failed += 1;
                consecutive_failures += 1;
                log(host, label, format!("归档 {} 失败:{last_err}", c.title));
                if consecutive_failures >= 3 {
                    log(host, label, "连续失败已中止".into());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        // Post-sweep recount: report anything still left behind.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let remaining = match fetch_sidebar(app, label, false).await {
            Ok(list) => logic::arithmetic_cleanup_candidates(&list, keep.as_deref())
                .iter()
                .filter(|c| !archived.contains(&c.session_id))
                .count() as i64,
            Err(_) => -1,
        };
        let tail = if remaining > 0 {
            format!(",仍有 {remaining} 个未归档(可再点一次清理)")
        } else if failed > 0 {
            format!(",失败 {failed}")
        } else {
            String::new()
        };
        outcome = if ok == 0 && failed == 0 && remaining <= 0 {
            "没有需要归档的算式标题对话".to_string()
        } else {
            format!("清理完成 · 已归档 {ok}{tail}(仅归档,未删除)")
        };
    }
    if sidebar_opened {
        let _ = rpc(app, label, "collapseSidebar", json!({})).await;
    }
    host.with_runtime(label, &mut |rt| {
        rt.status.active = false;
        rt.push_log(&outcome);
    });
    host.publish(label, Some(&outcome));
}

/// One-off: fill the CURRENTLY open conversation's composer with `text` and
/// send it. Refused while a probe / cleanup is running.
pub async fn quick_send(app: &AppHandle, host: &dyn Host, label: &str, text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("请先填写要发送的内容".into());
    }
    let mut active = false;
    host.with_runtime(label, &mut |rt| active = rt.status.active);
    if active {
        return Err("探针运行中,请先停止再发送".into());
    }
    let data = rpc(app, label, "sendToCurrent", json!({ "text": text })).await?;
    let session = data.get("session").and_then(Value::as_str).unwrap_or("").to_string();
    log(host, label, "已发送到当前对话".into());
    Ok(session)
}

/// Auto-rename after a normal (non-probe) identification: once per session,
/// only while nothing else drives the page.
pub async fn auto_rename(app: &AppHandle, host: &dyn Host, label: &str, session_id: &str, title: &str) -> Result<(), String> {
    let mut active = false;
    host.with_runtime(label, &mut |rt| active = rt.status.active);
    if active {
        return Err("探针运行中,跳过自动重命名".into());
    }
    rpc(app, label, "rename", json!({ "sessionId": session_id, "title": title })).await?;
    log(host, label, format!("已自动重命名为 {title}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_and_deserialize() {
        let c: ProbeConfig = serde_json::from_str(r#"{"targets":"opus5"}"#).unwrap();
        assert_eq!(c.max_rounds, 5);
        assert!(c.find_all && c.auto_rename && c.suffix);
        assert_eq!(ProbeConfig::default().targets, "opus5, fable5, gpt6");
    }

    #[test]
    fn runtime_log_is_capped() {
        let mut rt = ProbeRuntime::default();
        let c = rt.begin("probe", 3);
        assert!(!c.load(Ordering::Relaxed));
        for i in 0..(LOG_KEEP + 5) {
            rt.push_log(&format!("l{i}"));
        }
        assert_eq!(rt.status.log.len(), LOG_KEEP);
        assert_eq!(rt.status.last, format!("l{}", LOG_KEEP + 4));
    }

    #[test]
    fn deliver_resolves_pending_waiter() {
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        pending().lock().unwrap().insert("rX".into(), tx);
        deliver(&json!({"reqId": "rX", "ok": true, "data": {"a": 1}}));
        let v = rx.blocking_recv().unwrap();
        assert_eq!(v["data"]["a"], 1);
        deliver(&json!({"reqId": "nope"})); // unknown id is ignored
    }
}
