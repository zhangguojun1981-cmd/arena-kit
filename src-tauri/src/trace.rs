//! trace.rs — token validation + trace model extraction.
//! Ported from arena-trace-inspector `core.js` and arena-trace-android
//! `ArenaProtocol.kt`. Rules are kept in lockstep with both; the unit tests
//! at the bottom mirror `tests/core.test.mjs` and `ArenaProtocolTest.kt`.
//!
//! STATUS (M0 scaffold): validate_token + extract_models are implemented and
//! unit-tested. The HTTP polling loop (fetch_models) is stubbed with the exact
//! contract but no live call yet — wire it in M3.

use base64::Engine;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Claims {
    pub run_id: String,
    pub exp: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelHit {
    pub model: String,
    pub provider: String,
    pub partial: bool,
}

const RUN_ID_OK: fn(&str) -> bool = |s| {
    s.starts_with("run_") && s.len() > 4 && s[4..].chars().all(|c| c.is_ascii_alphanumeric())
};

/// base64url decode (no padding required), mirrors core.js decode64.
fn decode64(text: &str) -> Option<Vec<u8>> {
    let s: String = text.chars().map(|c| match c {
        '-' => '+',
        '_' => '/',
        x => x,
    }).collect();
    let pad = (4 - s.len() % 4) % 4;
    let padded = format!("{}{}", s, "=".repeat(pad));
    base64::engine::general_purpose::STANDARD.decode(padded).ok()
}

fn run_id_from_claims(claims: &Value) -> Option<String> {
    if let Some(run) = claims.get("run").and_then(|v| v.as_str()) {
        if RUN_ID_OK(run) {
            return Some(run.to_string());
        }
    }
    let scopes = claims.get("scopes").and_then(|v| v.as_array());
    let mut runs: Vec<String> = Vec::new();
    if let Some(scopes) = scopes {
        for scope in scopes {
            if let Some(s) = scope.as_str() {
                if let Some(rest) = s.strip_prefix("read:runs:") {
                    if RUN_ID_OK(rest) && !runs.contains(&rest.to_string()) {
                        runs.push(rest.to_string());
                    }
                }
            }
        }
    }
    if runs.len() == 1 {
        Some(runs.remove(0))
    } else {
        None
    }
}

/// Decoding is NOT signature verification — Trigger.dev validates on GET.
/// Mirrors core.js validateToken / ArenaProtocol.validateToken.
pub fn validate_token(token: &str, session_id: &str, now: f64) -> Result<Claims, String> {
    if token.len() > 16384 || token.split('.').count() != 3 {
        return Err("令牌格式不符合预期".into());
    }
    let payload = token.split('.').nth(1).ok_or("无法解析令牌")?;
    let bytes = decode64(payload).ok_or("无法解析令牌")?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| "无法解析令牌")?;

    if claims.get("pub").and_then(|v| v.as_bool()) != Some(true)
        || claims.get("iss").and_then(|v| v.as_str()) != Some("https://id.trigger.dev")
    {
        return Err("不是预期的公开运行令牌".into());
    }
    // aud may be string, array, or absent.
    let aud_ok = match claims.get("aud") {
        None => true,
        Some(Value::String(s)) => s == "https://api.trigger.dev",
        Some(Value::Array(a)) => {
            a.is_empty() || a.iter().any(|x| x.as_str() == Some("https://api.trigger.dev"))
        }
        _ => false,
    };
    if !aud_ok {
        return Err("不是预期的公开运行令牌".into());
    }
    let exp = claims.get("exp").and_then(|v| v.as_f64()).ok_or("令牌已过期，请发送新的测试消息")?;
    if !exp.is_finite() || exp <= now + 5.0 {
        return Err("令牌已过期，请发送新的测试消息".into());
    }
    let run_id = run_id_from_claims(&claims).ok_or("令牌必须仅明确指定一个可读取运行")?;

    // Session scope must match, if any read:sessions: scopes are present.
    if let Some(scopes) = claims.get("scopes").and_then(|v| v.as_array()) {
        let session_scopes: Vec<&str> = scopes
            .iter()
            .filter_map(|s| s.as_str())
            .filter(|s| s.starts_with("read:sessions:"))
            .collect();
        let want = format!("read:sessions:{}", session_id);
        if !session_scopes.is_empty() && !session_scopes.contains(&want.as_str()) {
            return Err("令牌与当前流会话不匹配".into());
        }
    }
    Ok(Claims { run_id, exp })
}

pub fn is_fatal_trace_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 429)
}

/// Human label for a fatal trace status, mirrors core.js traceStatusLabel.
pub fn trace_status_label(status: u16) -> String {
    match status {
        401 => "令牌被拒绝或已过期".into(),
        403 => "该令牌无权读取 trace".into(),
        404 => "运行 trace 不存在".into(),
        429 => "接口限流，已停止查询".into(),
        _ => format!("trace 返回 HTTP {}", status),
    }
}

const MODEL_SPANS: [&str; 4] = [
    "ai.streamText.doStream",
    "ai.generateText.doGenerate",
    "ai.streamObject.doStream",
    "ai.generateObject.doGenerate",
];
const CUBE_ICONS: [&str; 3] = ["tabler-cube", "cube", "tabler-box"];

fn span_name(event: &Value) -> String {
    for key in ["message", "name", "spanName"] {
        if let Some(s) = event.get(key).and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

fn trace_events(trace: &Value) -> Option<Vec<Value>> {
    for path in [["events"], ["spans"]] {
        if let Some(arr) = trace.get(path[0]).and_then(|v| v.as_array()) {
            return Some(arr.clone());
        }
    }
    if let Some(arr) = trace.get("data").and_then(|d| d.get("events")).and_then(|v| v.as_array()) {
        return Some(arr.clone());
    }
    if let Some(arr) = trace.get("data").and_then(|v| v.as_array()) {
        if arr.iter().all(|x| x.is_object()) {
            return Some(arr.clone());
        }
    }
    None
}

fn cube_items(event: &Value) -> Vec<(String, bool)> {
    let items = event
        .get("style").and_then(|s| s.get("accessory")).and_then(|a| a.get("items"))
        .and_then(|v| v.as_array());
    let partial = event.get("isPartial").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut out = Vec::new();
    if let Some(items) = items {
        for item in items {
            let icon = item.get("icon").and_then(|v| v.as_str()).unwrap_or("");
            let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if CUBE_ICONS.contains(&icon) && !text.trim().is_empty() && text.len() <= 200 {
                out.push((text.to_string(), partial));
            }
        }
    }
    out
}

/// Mirrors core.js extractModels: model-span cube labels first, then any
/// same-run cube label as fallback; dedup by (model, provider).
pub fn extract_models(trace: &Value, run_id: &str) -> Result<Vec<ModelHit>, String> {
    let events = trace_events(trace).ok_or("trace 格式不符合预期")?;
    let provider_of = |e: &Value| {
        e.get("style").and_then(|s| s.get("icon")).and_then(|v| v.as_str())
            .unwrap_or("").trim_start_matches("ai-provider-").to_string()
    };
    let mut found: Vec<ModelHit> = Vec::new();
    for event in &events {
        if event.get("runId").and_then(|v| v.as_str()) != Some(run_id) {
            continue;
        }
        if !MODEL_SPANS.contains(&span_name(event).as_str()) {
            continue;
        }
        for (text, partial) in cube_items(event) {
            found.push(ModelHit { model: text, provider: provider_of(event), partial });
        }
    }
    if found.is_empty() {
        for event in &events {
            if event.get("runId").and_then(|v| v.as_str()) != Some(run_id) {
                continue;
            }
            for (text, partial) in cube_items(event) {
                found.push(ModelHit { model: text, provider: provider_of(event), partial });
            }
        }
    }
    // dedup by (model, provider)
    let mut seen = std::collections::HashSet::new();
    found.retain(|m| seen.insert((m.model.clone(), m.provider.clone())));
    Ok(found)
}


// ─────────────────────────── usage (tokens / cost) ───────────────────────────
// Ported from arena-trace-inspector `usage.js`: only the labels Trigger.dev
// already renders on a model span are read (tabler-hash = tokens,
// tabler-currency-dollar = cost). Nothing is inferred from provider price
// lists; a span without a label reports `None`.

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SpanUsage {
    pub span_id: String,
    pub model: String,
    pub provider: String,
    pub tokens: Option<u64>,
    pub tokens_approximate: bool,
    pub cost_usd: Option<f64>,
    pub partial: bool,
    pub error: bool,
    pub cancelled: bool,
}

/// "12,345", "12.3k", "1.2M" → tokens (approximate when a unit suffix is used).
pub fn parse_token_label(label: &str) -> Option<(u64, bool)> {
    let t: String = label.trim().chars().filter(|c| *c != ',').collect();
    let (num, unit) = match t.chars().last() {
        Some(c) if c.is_ascii_alphabetic() => (&t[..t.len() - 1], Some(c.to_ascii_lowercase())),
        _ => (t.as_str(), None),
    };
    let num = num.trim();
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit() || c == '.') || num.matches('.').count() > 1 {
        return None;
    }
    let value: f64 = num.parse().ok()?;
    let mult = match unit {
        None => 1.0,
        Some('k') => 1e3,
        Some('m') => 1e6,
        Some('b') => 1e9,
        Some(_) => return None,
    };
    let v = (value * mult).round();
    if !v.is_finite() || v < 0.0 || v > 9e15 {
        return None;
    }
    Some((v as u64, unit.is_some()))
}

/// "$0.0123" → 0.0123
pub fn parse_cost_label(label: &str) -> Option<f64> {
    let t: String = label.trim().chars().filter(|c| *c != ',').collect();
    let body = t.strip_prefix('$')?.trim();
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    body.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)
}

pub fn extract_usage(trace: &Value, run_id: &str) -> Vec<SpanUsage> {
    let Some(events) = trace_events(trace) else { return Vec::new() };
    let mut out: Vec<SpanUsage> = Vec::new();
    for event in &events {
        if event.get("runId").and_then(|v| v.as_str()) != Some(run_id) {
            continue;
        }
        let Some(span_id) = event.get("spanId").and_then(|v| v.as_str()) else { continue };
        if !MODEL_SPANS.contains(&span_name(event).as_str()) {
            continue;
        }
        let items = event
            .get("style").and_then(|s| s.get("accessory")).and_then(|a| a.get("items"))
            .and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let text_of = |icon: &str| {
            items.iter().find(|i| i.get("icon").and_then(|v| v.as_str()) == Some(icon))
                .and_then(|i| i.get("text")).and_then(|v| v.as_str()).map(str::to_string)
        };
        let model = items.iter()
            .find(|i| CUBE_ICONS.contains(&i.get("icon").and_then(|v| v.as_str()).unwrap_or("")))
            .and_then(|i| i.get("text")).and_then(|v| v.as_str()).unwrap_or("")
            .chars().take(200).collect::<String>();
        let provider = event.get("style").and_then(|s| s.get("icon")).and_then(|v| v.as_str())
            .filter(|s| s.starts_with("ai-provider-"))
            .map(|s| s.trim_start_matches("ai-provider-").to_string()).unwrap_or_default();
        let tokens = text_of("tabler-hash").and_then(|l| parse_token_label(&l));
        let cost_usd = text_of("tabler-currency-dollar").and_then(|l| parse_cost_label(&l));
        let flag = |k: &str| event.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        if let Some(existing) = out.iter_mut().find(|s| s.span_id == span_id) {
            if tokens.is_some() { existing.tokens = tokens.map(|t| t.0); existing.tokens_approximate = tokens.map(|t| t.1).unwrap_or(false); }
            if cost_usd.is_some() { existing.cost_usd = cost_usd; }
            existing.partial = flag("isPartial");
            continue;
        }
        out.push(SpanUsage {
            span_id: span_id.to_string(),
            model,
            provider,
            tokens: tokens.map(|t| t.0),
            tokens_approximate: tokens.map(|t| t.1).unwrap_or(false),
            cost_usd,
            partial: flag("isPartial"),
            error: flag("isError"),
            cancelled: flag("isCancelled"),
        });
    }
    out
}

/// Totals over a set of spans (dedup by span id), mirroring summarizeUsage.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct UsageTotals {
    pub span_count: usize,
    pub tokens: Option<u64>,
    pub tokens_approximate: bool,
    pub cost_usd: Option<f64>,
    pub token_coverage: usize,
    pub cost_coverage: usize,
    pub partial: bool,
}

pub fn summarize_usage(spans: &[SpanUsage]) -> UsageTotals {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&SpanUsage> = spans.iter().filter(|s| seen.insert(s.span_id.clone())).collect();
    let with_tokens: Vec<&&SpanUsage> = unique.iter().filter(|s| s.tokens.is_some()).collect();
    let with_cost: Vec<&&SpanUsage> = unique.iter().filter(|s| s.cost_usd.is_some()).collect();
    UsageTotals {
        span_count: unique.len(),
        tokens: if with_tokens.is_empty() { None } else { Some(with_tokens.iter().map(|s| s.tokens.unwrap_or(0)).sum()) },
        tokens_approximate: with_tokens.iter().any(|s| s.tokens_approximate),
        cost_usd: if with_cost.is_empty() { None } else { Some((with_cost.iter().map(|s| s.cost_usd.unwrap_or(0.0)).sum::<f64>() * 1e9).round() / 1e9) },
        token_coverage: with_tokens.len(),
        cost_coverage: with_cost.len(),
        partial: unique.iter().any(|s| s.partial),
    }
}

// ─────────────────────────── tests ───────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn make_token(payload: Value) -> String {
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        format!("aaa.{}.bbb", b)
    }

    #[test]
    fn valid_token_with_run_scope() {
        let tok = make_token(json!({
            "pub": true, "iss": "https://id.trigger.dev",
            "aud": "https://api.trigger.dev", "exp": 9_999_999_999u64,
            "scopes": ["read:runs:run_abc123", "read:sessions:sess1"]
        }));
        let c = validate_token(&tok, "sess1", 1000.0).unwrap();
        assert_eq!(c.run_id, "run_abc123");
    }

    #[test]
    fn rejects_expired() {
        let tok = make_token(json!({
            "pub": true, "iss": "https://id.trigger.dev",
            "exp": 100u64, "run": "run_x"
        }));
        assert!(validate_token(&tok, "s", 1000.0).is_err());
    }

    #[test]
    fn rejects_wrong_issuer() {
        let tok = make_token(json!({
            "pub": true, "iss": "https://evil", "exp": 9_999_999_999u64, "run": "run_x"
        }));
        assert!(validate_token(&tok, "s", 1000.0).is_err());
    }

    #[test]
    fn rejects_session_mismatch() {
        let tok = make_token(json!({
            "pub": true, "iss": "https://id.trigger.dev", "exp": 9_999_999_999u64,
            "run": "run_x", "scopes": ["read:sessions:other"]
        }));
        assert!(validate_token(&tok, "mine", 1000.0).is_err());
    }

    #[test]
    fn rejects_multiple_runs() {
        let tok = make_token(json!({
            "pub": true, "iss": "https://id.trigger.dev", "exp": 9_999_999_999u64,
            "scopes": ["read:runs:run_a", "read:runs:run_b"]
        }));
        assert!(validate_token(&tok, "s", 1000.0).is_err());
    }

    #[test]
    fn extracts_model_from_cube_span() {
        let trace = json!({"events": [
            {"runId": "run_x", "message": "ai.streamText.doStream",
             "style": {"icon": "ai-provider-anthropic",
                       "accessory": {"items": [{"icon": "tabler-cube", "text": "claude-opus-5"}]}}}
        ]});
        let m = extract_models(&trace, "run_x").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].model, "claude-opus-5");
        assert_eq!(m[0].provider, "anthropic");
    }

    #[test]
    fn dedups_repeated_models() {
        let trace = json!({"events": [
            {"runId": "run_x", "name": "ai.streamText.doStream",
             "style": {"accessory": {"items": [{"icon": "cube", "text": "gpt-6"}]}}},
            {"runId": "run_x", "name": "ai.streamText.doStream",
             "style": {"accessory": {"items": [{"icon": "cube", "text": "gpt-6"}]}}}
        ]});
        assert_eq!(extract_models(&trace, "run_x").unwrap().len(), 1);
    }

    #[test]
    fn fatal_status_matches_core() {
        assert!(is_fatal_trace_status(401));
        assert!(is_fatal_trace_status(429));
        assert!(!is_fatal_trace_status(500));
    }

    #[test]
    fn usage_labels_parse_like_the_extension() {
        assert_eq!(parse_token_label("12,345"), Some((12345, false)));
        assert_eq!(parse_token_label("12.3k"), Some((12300, true)));
        assert_eq!(parse_token_label("1.5M"), Some((1_500_000, true)));
        assert_eq!(parse_token_label("abc"), None);
        assert_eq!(parse_token_label("1.2.3"), None);
        assert_eq!(parse_cost_label("$0.0123"), Some(0.0123));
        assert_eq!(parse_cost_label("$ 1,000.5"), Some(1000.5));
        assert_eq!(parse_cost_label("0.01"), None);
    }

    #[test]
    fn usage_extraction_and_totals() {
        let trace = json!({"events": [
            {"runId": "run_1", "spanId": "s1", "message": "ai.streamText.doStream", "isPartial": false,
             "style": {"icon": "ai-provider-openai", "accessory": {"items": [
                {"icon": "tabler-cube", "text": "gpt-6"},
                {"icon": "tabler-hash", "text": "1.2k"},
                {"icon": "tabler-currency-dollar", "text": "$0.0030"}]}}},
            {"runId": "run_1", "spanId": "s2", "message": "ai.streamText.doStream", "isPartial": true,
             "style": {"accessory": {"items": [{"icon": "tabler-cube", "text": "gpt-6"}]}}},
            {"runId": "run_1", "spanId": "s3", "message": "other", "style": {"accessory": {"items": [{"icon": "tabler-hash", "text": "999"}]}}},
            {"runId": "run_2", "spanId": "s4", "message": "ai.streamText.doStream", "style": {"accessory": {"items": [{"icon": "tabler-hash", "text": "5"}]}}}
        ]});
        let spans = extract_usage(&trace, "run_1");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].tokens, Some(1200));
        assert!(spans[0].tokens_approximate);
        assert_eq!(spans[0].cost_usd, Some(0.003));
        assert_eq!(spans[0].provider, "openai");
        assert_eq!(spans[1].tokens, None);
        assert!(spans[1].partial);
        let t = summarize_usage(&spans);
        assert_eq!(t.span_count, 2);
        assert_eq!(t.tokens, Some(1200));
        assert_eq!(t.token_coverage, 1);
        assert_eq!(t.cost_coverage, 1);
        assert!(t.partial && t.tokens_approximate);
        assert_eq!(summarize_usage(&[]), UsageTotals::default());
    }
}
