//! usage.rs — span-level Token / trace-cost extraction from a Trigger.dev run
//! trace. Ported from arena-trace-inspector `usage.js` (extractUsage,
//! parseTokenLabel, parseCostLabel) and `evidence.js` (label allowlist).
//!
//! Rules kept in lockstep with the extension:
//!   * only leaf model spans (`ai.streamText.doStream` etc.) of the given run
//!   * only OBSERVED trace labels are parsed — `tabler-hash` (tokens) and
//!     `tabler-currency-dollar` (cost); never infer provider prices or
//!     input/output splits; unknown stays `None`, zero stays `Some(0)`
//!   * dedup by spanId (a later snapshot replaces the same span)
//!   * `isPartial` / `isError` / `isCancelled` are surfaced as tri-state flags
//!   * nothing else of the raw trace leaves this function (no message text)
//!
//! Merging snapshots across polls, per-session totals and formatting happen in
//! the dock (`src/lib/usage.js`), which is unit-tested with node:test.

use serde::Serialize;
use serde_json::Value;

use crate::trace::{span_name, trace_events, CUBE_ICONS, MODEL_SPANS};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpanUsage {
    pub span_id: String,
    pub model: String,
    /// provider icon without the `ai-provider-` prefix ("" when absent)
    pub provider: String,
    /// raw `style.icon` when it looks like `ai-provider-*` (evidence)
    pub provider_icon: Option<String>,
    pub tokens: Option<u64>,
    pub tokens_approximate: bool,
    /// raw observed label ("6.6k") — only when it parsed
    pub token_label: Option<String>,
    pub cost_usd: Option<f64>,
    /// raw observed label ("$0.0133") — only when it parsed
    pub cost_label: Option<String>,
    pub partial: Option<bool>,
    pub error: Option<bool>,
    pub cancelled: Option<bool>,
}

/// "6.6k" → (6600, approximate=true); "1,024" → (1024, false); "unknown" → None.
pub fn parse_token_label(label: &str) -> Option<(u64, bool)> {
    let s: String = label.trim().chars().filter(|c| *c != ',').collect();
    if s.is_empty() {
        return None;
    }
    // numeric prefix: digits with at most one '.', at least one digit
    let mut end = 0;
    let mut dots = 0;
    for (i, c) in s.char_indices() {
        if c.is_ascii_digit() {
            end = i + 1;
        } else if c == '.' && dots == 0 && end > 0 {
            dots += 1;
            end = i + 1;
        } else {
            break;
        }
    }
    if end == 0 || s[..end].ends_with('.') {
        return None;
    }
    let number: f64 = s[..end].parse().ok()?;
    let rest = s[end..].trim_start();
    let (mult, approximate) = match rest.to_ascii_lowercase().as_str() {
        "" => (1.0, false),
        "k" => (1e3, true),
        "m" => (1e6, true),
        "b" => (1e9, true),
        _ => return None,
    };
    let value = (number * mult).round();
    if !value.is_finite() || value < 0.0 || value > 9007199254740991.0 {
        return None;
    }
    Some((value as u64, approximate))
}

/// "$0.0133" → Some(0.0133); "$0" → Some(0.0); "€1.00" / "-1" → None.
pub fn parse_cost_label(label: &str) -> Option<f64> {
    let s: String = label.trim().chars().filter(|c| *c != ',').collect();
    let body = s.strip_prefix('$')?.trim_start();
    if body.is_empty() {
        return None;
    }
    let mut dots = 0;
    for (i, c) in body.char_indices() {
        if c.is_ascii_digit() {
            continue;
        }
        if c == '.' && dots == 0 && i > 0 && i + 1 < body.len() {
            dots += 1;
            continue;
        }
        return None;
    }
    body.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn provider_icon(event: &Value) -> Option<String> {
    let icon = event.get("style")?.get("icon")?.as_str()?;
    let rest = icon.strip_prefix("ai-provider-")?;
    if rest.is_empty()
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return None;
    }
    Some(icon.to_string())
}

fn flag(event: &Value, key: &str) -> Option<bool> {
    event.get(key).and_then(|v| v.as_bool())
}

/// Mirrors usage.js extractUsage (minus the evidence envelope, which the dock
/// rebuilds from the raw labels returned here).
pub fn extract_usage(trace: &Value, run_id: &str) -> Vec<SpanUsage> {
    let mut out: Vec<SpanUsage> = Vec::new();
    let events = match trace_events(trace) {
        Some(e) => e,
        None => return out,
    };
    for event in &events {
        if event.get("runId").and_then(|v| v.as_str()) != Some(run_id) {
            continue;
        }
        let span_id = match event.get("spanId").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        if !MODEL_SPANS.contains(&span_name(event).as_str()) {
            continue;
        }
        let empty = Vec::new();
        let items = event
            .get("style")
            .and_then(|s| s.get("accessory"))
            .and_then(|a| a.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        let text_for = |icon: &str| -> Option<String> {
            items
                .iter()
                .find(|i| i.get("icon").and_then(|v| v.as_str()) == Some(icon))
                .and_then(|i| i.get("text").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        };
        let token_label = text_for("tabler-hash");
        let cost_label = text_for("tabler-currency-dollar");
        let tokens = token_label.as_deref().and_then(parse_token_label);
        let cost_usd = cost_label.as_deref().and_then(parse_cost_label);
        let model: String = items
            .iter()
            .find(|i| {
                i.get("icon")
                    .and_then(|v| v.as_str())
                    .map(|ic| CUBE_ICONS.contains(&ic))
                    .unwrap_or(false)
            })
            .and_then(|i| i.get("text").and_then(|v| v.as_str()))
            .unwrap_or("")
            .chars()
            .take(200)
            .collect();
        let icon = provider_icon(event);
        let span = SpanUsage {
            span_id: span_id.clone(),
            model,
            provider: icon
                .as_deref()
                .map(|s| s.trim_start_matches("ai-provider-").to_string())
                .unwrap_or_default(),
            provider_icon: icon,
            tokens: tokens.map(|t| t.0),
            tokens_approximate: tokens.map(|t| t.1).unwrap_or(false),
            token_label: if tokens.is_some() { token_label.map(|s| s.chars().take(40).collect()) } else { None },
            cost_usd,
            cost_label: if cost_usd.is_some() { cost_label.map(|s| s.chars().take(40).collect()) } else { None },
            partial: flag(event, "isPartial"),
            error: flag(event, "isError"),
            cancelled: flag(event, "isCancelled"),
        };
        // Same span seen twice in one snapshot: later wins, position kept.
        if let Some(pos) = out.iter().position(|s| s.span_id == span_id) {
            out[pos] = span;
        } else {
            out.push(span);
        }
    }
    out
}

/// background.js stops polling once nothing is partial and every span carries
/// both a token and a cost label; otherwise it keeps re-reading (≤ 8 attempts)
/// to let the usage labels catch up.
pub fn is_complete(spans: &[SpanUsage]) -> bool {
    spans.iter().all(|s| {
        s.partial != Some(true) && s.tokens.is_some() && s.cost_usd.is_some()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(span_id: &str, token: &str, cost: &str) -> Value {
        json!({
            "runId": "run_x", "spanId": span_id, "message": "ai.streamText.doStream", "isPartial": false,
            "style": {"icon": "ai-provider-anthropic", "accessory": {"items": [
                {"text": "model", "icon": "tabler-cube"},
                {"text": token, "icon": "tabler-hash"},
                {"text": cost, "icon": "tabler-currency-dollar"}
            ]}}
        })
    }

    #[test]
    fn observed_token_and_cost_labels_and_unknown_values() {
        assert_eq!(parse_token_label("6.6k"), Some((6600, true)));
        assert_eq!(parse_token_label("1,024"), Some((1024, false)));
        assert_eq!(parse_token_label("1.5M"), Some((1_500_000, true)));
        assert_eq!(parse_token_label(" 400 "), Some((400, false)));
        assert_eq!(parse_token_label("0"), Some((0, false)));
        assert_eq!(parse_token_label("unknown"), None);
        assert_eq!(parse_token_label("?"), None);
        assert_eq!(parse_token_label("1.k"), None);
        assert_eq!(parse_cost_label("$0.0133"), Some(0.0133));
        assert_eq!(parse_cost_label("$0"), Some(0.0));
        assert_eq!(parse_cost_label("$ 1,000.5"), Some(1000.5));
        assert_eq!(parse_cost_label("€1.00"), None);
        assert_eq!(parse_cost_label("-1"), None);
        assert_eq!(parse_cost_label("$1e5"), None);
    }

    #[test]
    fn counts_leaf_span_once_excludes_parent_and_other_run() {
        let e = event("s1", "6.6k", "$0.0133");
        let mut parent = e.clone();
        parent["spanId"] = json!("parent");
        parent["message"] = json!("ai.streamText");
        let mut other = e.clone();
        other["spanId"] = json!("other");
        other["runId"] = json!("other");
        let trace = json!({"events": [e.clone(), e, parent, other, event("s2", "400", "$0.001")]});
        let spans = extract_usage(&trace, "run_x");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].tokens, Some(6600));
        assert!(spans[0].tokens_approximate);
        assert_eq!(spans[0].token_label.as_deref(), Some("6.6k"));
        assert_eq!(spans[0].cost_usd, Some(0.0133));
        assert_eq!(spans[0].provider, "anthropic");
        assert_eq!(spans[0].provider_icon.as_deref(), Some("ai-provider-anthropic"));
        assert_eq!(spans[0].model, "model");
        assert_eq!(spans[1].tokens, Some(400));
        assert_eq!(spans[0].partial, Some(false));
        assert_eq!(spans[0].error, None);
        assert!(is_complete(&spans));
    }

    #[test]
    fn unknown_labels_stay_none_and_block_completion() {
        let trace = json!({"events": [event("s1", "?", "?")]});
        let spans = extract_usage(&trace, "run_x");
        assert_eq!(spans[0].tokens, None);
        assert_eq!(spans[0].token_label, None);
        assert_eq!(spans[0].cost_usd, None);
        assert!(!is_complete(&spans));
        let mixed = extract_usage(&json!({"events": [event("s1", "0", "$0"), event("s2", "?", "?")]}), "run_x");
        assert_eq!(mixed[0].tokens, Some(0));
        assert_eq!(mixed[0].cost_usd, Some(0.0));
        assert!(!is_complete(&mixed));
    }

    #[test]
    fn partial_span_blocks_completion_and_flags_are_tristate() {
        let mut e = event("s1", "10", "$0.1");
        e["isPartial"] = json!(true);
        e["isError"] = json!(false);
        let spans = extract_usage(&json!({"events": [e]}), "run_x");
        assert_eq!(spans[0].partial, Some(true));
        assert_eq!(spans[0].error, Some(false));
        assert_eq!(spans[0].cancelled, None);
        assert!(!is_complete(&spans));
        assert!(is_complete(&[]));
    }

    #[test]
    fn rejects_malformed_provider_icons_and_missing_span_ids() {
        let mut e = event("s1", "10", "$0.1");
        e["style"]["icon"] = json!("ai-provider-<bad>");
        let spans = extract_usage(&json!({"events": [e]}), "run_x");
        assert_eq!(spans[0].provider_icon, None);
        assert_eq!(spans[0].provider, "");
        let mut no_span = event("s1", "10", "$0.1");
        no_span.as_object_mut().unwrap().remove("spanId");
        assert!(extract_usage(&json!({"events": [no_span]}), "run_x").is_empty());
        assert!(extract_usage(&json!({"nope": 1}), "run_x").is_empty());
    }
}
