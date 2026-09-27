//! Pure probe logic — ported from arena-trace-android `ProbeLogic.kt`
//! (itself a port of the extension's `auto-draw.js`). Target parsing and
//! matching, arithmetic-title detection, cleanup candidates and the per-model
//! title suffix counter live here so they can be unit tested without a
//! webview. No DOM, no network.

use fancy_regex::Regex;
use std::collections::{BTreeMap, HashSet};

pub const DEFAULT_TARGETS: [&str; 3] = ["opus5", "fable5", "gpt6"];

const PROMPT_OPERATORS: [char; 6] = ['+', '-', '*', '/', '×', '÷'];

/// A fresh random arithmetic prompt ("473×82=", "57+906="). Every probe round
/// sends a DIFFERENT expression so probe-created chats don't all share one
/// title. The shape stays `N op N =`, which both the page-side send guard
/// (`isOwnPrompt` in injected/probe.js) and the cleanup sweep
/// (`is_arithmetic_title`) accept — random content, still instantly ours.
pub fn random_prompt() -> String {
    let a = 1 + (rand_u32() % 999);
    let b = 1 + (rand_u32() % 999);
    let op = PROMPT_OPERATORS[(rand_u32() % PROMPT_OPERATORS.len() as u32) as usize];
    format!("{a}{op}{b}=")
}

fn rand_u32() -> u32 {
    // uuid v4 is backed by the OS RNG; good enough for prompt variety and it
    // avoids pulling in another crate.
    let b = *uuid::Uuid::new_v4().as_bytes();
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn family_pattern(fam: &str) -> Option<&'static str> {
    Some(match fam {
        "opus5" => r"(?:claude[-_\s.]*)?opus[-_\s.]*5(?:[-_.]\d+)?(?!\d)",
        "fable5" => r"(?:claude[-_\s.]*)?fable[-_\s.]*5(?:[-_.]\d+)?(?!\d)",
        "gpt6" => r"(?:chat)?gpt[-_\s.]*6(?:[-_\s.]*astra|[-_\s.]*pro)?(?!\d)",
        _ => return None,
    })
}

fn alias(norm: &str) -> Option<&'static str> {
    Some(match norm {
        "opus5" | "claudeopus5" => "opus5",
        "fable5" | "claudefable5" | "fable51" | "claudefable51" => "fable5",
        "gpt6" | "chatgpt6" | "gpt6astra" | "gpt6pro" | "astra" => "gpt6",
        _ => return None,
    })
}

/// lower-case + strip everything non-alphanumeric (matches the JS normalize).
pub fn normalize(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Split a user target string into 2..80-char tokens, deduped, max 20.
pub fn parse_targets(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in text.split(|c: char| matches!(c, ',' | '，' | ';' | '；' | '\n')) {
        let t = part.trim().trim_end_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
        let n = t.chars().count();
        if (2..=80).contains(&n) && !out.contains(&t) {
            out.push(t);
        }
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// Compile one target into a case-insensitive regex:
///  - `/body/flags` → the user's own regex (`i` is forced on; body ≤ 120)
///  - known alias → the model family pattern
///  - otherwise → the literal, escaped, with separators made fuzzy (`[-_\s.]*`)
pub fn compile_target(target: &str) -> Option<Regex> {
    let raw = target.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.len() >= 3 && raw.starts_with('/') {
        if let Some(last) = raw.rfind('/') {
            if last > 0 {
                let body = &raw[1..last];
                let flags: String = raw[last + 1..].chars().filter(|c| "gimsuy".contains(*c)).collect();
                if body.is_empty() || body.len() > 120 {
                    return None;
                }
                let mut prefix = String::from("(?i");
                if flags.contains('s') {
                    prefix.push('s');
                }
                if flags.contains('m') {
                    prefix.push('m');
                }
                prefix.push(')');
                return Regex::new(&format!("{prefix}{body}")).ok();
            }
        }
    }
    if let Some(fam) = alias(&normalize(raw)) {
        return Regex::new(&format!("(?i){}", family_pattern(fam)?)).ok();
    }
    // Literal with fuzzy separators.
    let mut escaped = String::new();
    let mut sep = false;
    for c in raw.chars() {
        if c == '-' || c == '_' || c == '.' || c.is_whitespace() {
            if !sep {
                escaped.push_str(r"[-_\s.]*");
                sep = true;
            }
            continue;
        }
        sep = false;
        if r".*+?^${}()|[]\".contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    Regex::new(&format!("(?i){escaped}")).ok()
}

fn matches(re: &Regex, text: &str) -> bool {
    re.is_match(text).unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Hit {
    pub target: String,
    pub model: String,
}

/// For each target, the first model it matches (raw or normalized).
pub fn match_targets(models: &[String], targets: &[String]) -> Vec<Hit> {
    let mut hits = Vec::new();
    for target in targets {
        let Some(re) = compile_target(target) else { continue };
        if let Some(model) = models.iter().find(|m| matches(&re, m) || matches(&re, &normalize(m))) {
            hits.push(Hit { target: target.clone(), model: model.clone() });
        }
    }
    hits
}

/// Targets not yet hit (compared by normalized name).
pub fn remaining_targets(targets: &[String], hits: &[Hit]) -> Vec<String> {
    let found: HashSet<String> = hits.iter().map(|h| normalize(&h.target)).collect();
    targets.iter().filter(|t| !found.contains(&normalize(t))).cloned().collect()
}

/// findAll stop condition: every target has been hit at least once across
/// all rounds. Hit targets are never removed from the matching pool.
pub fn all_targets_hit(targets: &[String], hits: &[Hit]) -> bool {
    !targets.is_empty() && remaining_targets(targets, hits).is_empty()
}

fn fold_title(t: &str) -> String {
    t.chars()
        .filter(|c| !matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'))
        .map(|c| match c {
            '＋' => '+',
            '－' | '−' => '-',
            '＊' => '*',
            '／' => '/',
            '＝' => '=',
            x => x,
        })
        .collect()
}

fn is_bare_arithmetic(s: &str) -> bool {
    // ^\s*\d{1,4}\s*[+\-*/×÷]\s*\d{1,4}\s*=\s*$
    let s = s.trim();
    let Some(eq) = s.strip_suffix('=') else { return false };
    let body = eq.trim_end();
    let mut chars = body.chars().peekable();
    let mut a = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            a.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if a.is_empty() || a.len() > 4 {
        return false;
    }
    while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
        chars.next();
    }
    match chars.next() {
        Some(c) if PROMPT_OPERATORS.contains(&c) => {}
        _ => return false,
    }
    while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
        chars.next();
    }
    let mut b = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            b.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if b.is_empty() || b.len() > 4 {
        return false;
    }
    chars.all(|c| c.is_whitespace())
}

/// A pure-arithmetic conversation title ("1+1=", "12 - 4 ="). Only our own
/// probe sends produce these — a human names chats with words — so a title
/// sweep can archive probe residue without touching user-named chats. Titles
/// with an ANSWER after "=" ("1+1=2") do NOT match.
pub fn is_arithmetic_title(t: &str) -> bool {
    is_bare_arithmetic(&fold_title(t))
}

/// Matches any prompt shape the probe is allowed to send (kept in sync with
/// the `isOwnPrompt` guard in injected/probe.js).
pub fn is_own_prompt(t: &str) -> bool {
    is_bare_arithmetic(t)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SidebarItem {
    #[serde(rename = "sessionId", alias = "session_id")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
}

/// Sidebar entries whose title is bare arithmetic, deduped by session,
/// skipping the currently open chat.
pub fn arithmetic_cleanup_candidates(sidebar: &[SidebarItem], keep_session_id: Option<&str>) -> Vec<SidebarItem> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in sidebar {
        if c.session_id.is_empty() || seen.contains(&c.session_id) {
            continue;
        }
        if keep_session_id == Some(c.session_id.as_str()) {
            continue;
        }
        if !is_arithmetic_title(&c.title) {
            continue;
        }
        seen.insert(c.session_id.clone());
        out.push(SidebarItem { session_id: c.session_id.clone(), title: c.title.chars().take(300).collect() });
    }
    out
}

/// Next 3-digit suffix for a model, updating the per-model counter map.
pub fn next_suffix(model: &str, counters: &mut BTreeMap<String, u32>) -> String {
    let mut key = normalize(model);
    if key.is_empty() {
        key = "model".into();
    }
    let n = counters.get(&key).copied().unwrap_or(0) + 1;
    counters.insert(key, n);
    format!("{n:03}")
}

/// Conversation title for a probe hit / auto-rename: `<prefix><model>[-NNN]`.
/// Arena caps titles at 100 characters; the prefix is trimmed first so the
/// model name (the part that matters) survives.
pub fn compose_title(prefix: &str, model: &str, suffix: Option<&str>) -> String {
    let model = model.trim();
    let tail = suffix.map(|s| format!("-{s}")).unwrap_or_default();
    let budget = 100usize.saturating_sub(model.chars().count() + tail.chars().count());
    let prefix: String = prefix.trim_start().chars().take(budget).collect();
    format!("{prefix}{model}{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn prompts_are_bare_arithmetic() {
        for _ in 0..50 {
            let p = random_prompt();
            assert!(is_own_prompt(&p), "{p}");
            assert!(is_arithmetic_title(&p), "{p}");
        }
    }

    #[test]
    fn parse_targets_splits_and_dedups() {
        assert_eq!(parse_targets("opus5, fable5；gpt6\nopus5, x"), s(&["opus5", "fable5", "gpt6"]));
        assert_eq!(parse_targets("  claude-opus-5.  "), s(&["claude-opus-5"]));
        assert!(parse_targets("").is_empty());
    }

    #[test]
    fn family_aliases_match_real_labels() {
        let models = s(&["claude-opus-5-20260101", "gpt-6-astra", "claude-fable-5.1"]);
        let hits = match_targets(&models, &s(&["opus5", "gpt6", "fable5"]));
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].model, "claude-opus-5-20260101");
        assert_eq!(hits[1].model, "gpt-6-astra");
        assert_eq!(hits[2].model, "claude-fable-5.1");
        // negative lookahead: "opus-50" is not opus5
        assert!(match_targets(&s(&["claude-opus-50"]), &s(&["opus5"])).is_empty());
        assert!(match_targets(&s(&["gpt-60"]), &s(&["gpt6"])).is_empty());
    }

    #[test]
    fn literal_and_regex_targets() {
        assert_eq!(match_targets(&s(&["Gemini 3 Pro"]), &s(&["gemini-3-pro"])).len(), 1);
        assert_eq!(match_targets(&s(&["gemini3pro"]), &s(&["gemini-3 pro"])).len(), 1);
        assert_eq!(match_targets(&s(&["deepseek-v4"]), &s(&["/deep.*v4/"])).len(), 1);
        assert!(compile_target("/(/").is_none());
        assert!(compile_target("").is_none());
        assert!(compile_target("a").is_some());
    }

    #[test]
    fn remaining_and_all_hit() {
        let targets = s(&["opus5", "gpt6"]);
        let hits = vec![Hit { target: "Opus5".into(), model: "claude-opus-5".into() }];
        assert_eq!(remaining_targets(&targets, &hits), s(&["gpt6"]));
        assert!(!all_targets_hit(&targets, &hits));
        assert!(!all_targets_hit(&[], &[]));
    }

    #[test]
    fn arithmetic_titles() {
        for t in ["1+1=", "12 - 4 =", " 999×3= ", "\u{200b}7/7=", "12＋3＝", "5 − 2 ="] {
            assert!(is_arithmetic_title(t), "{t:?}");
        }
        for t in ["1+1=2", "hello", "12345+1=", "1+=", "=", "a+b=", "1+1"] {
            assert!(!is_arithmetic_title(t), "{t:?}");
        }
    }

    #[test]
    fn cleanup_candidates_skip_current_and_dedup() {
        let side = vec![
            SidebarItem { session_id: "a".into(), title: "1+1=".into() },
            SidebarItem { session_id: "a".into(), title: "1+1=".into() },
            SidebarItem { session_id: "b".into(), title: "hello".into() },
            SidebarItem { session_id: "c".into(), title: "3*3=".into() },
        ];
        let c = arithmetic_cleanup_candidates(&side, Some("c"));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].session_id, "a");
    }

    #[test]
    fn suffix_counter_and_titles() {
        let mut counters = BTreeMap::new();
        assert_eq!(next_suffix("claude-opus-5", &mut counters), "001");
        assert_eq!(next_suffix("Claude Opus 5", &mut counters), "002");
        assert_eq!(next_suffix("gpt-6", &mut counters), "001");
        assert_eq!(compose_title("", "gpt-6", Some("001")), "gpt-6-001");
        assert_eq!(compose_title("探针·", "gpt-6", None), "探针·gpt-6");
        let long = "x".repeat(150);
        let t = compose_title(&long, "claude-opus-5", Some("001"));
        assert_eq!(t.chars().count(), 100);
        assert!(t.ends_with("claude-opus-5-001"));
    }
}
