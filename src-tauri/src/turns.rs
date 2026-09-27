//! Per-conversation turn tracking ("回复监控 / 轮次解析") — ported from
//! arena-trace-android `TurnTracker.kt`.
//!
//! Arena issues a fresh run token per turn, and a turn may be routed to a
//! different model — so each new token is a new turn. `routed` is true when
//! a turn's model differs from the CURRENT conversation's first resolved
//! model. A non-empty session id that differs from the tracked one means the
//! chat was switched (sidebar tap, probe newChat); that switch — observed at
//! token time — is the authoritative reset point. Navigation events also
//! reset, but only best-effort (replaceState can be missed).

use serde::Serialize;
use std::collections::VecDeque;

/// Keep only the most recent turns on the status line.
pub const MAX_HISTORY: usize = 6;

#[derive(Debug, Default, Clone)]
pub struct TurnTracker {
    /// Conversation the tracked turns belong to; "" before the first token.
    pub session_id: String,
    /// 1-based number of the current turn within `session_id`.
    pub turn_count: u32,
    /// First resolved model of the current conversation ("" until resolved).
    pub first_model: String,
    /// Model of the previous turn.
    pub last_model: String,
    /// true when the current turn's model differs from the conversation's first.
    pub routed: bool,
    history: VecDeque<TurnEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TurnEntry {
    pub turn: u32,
    pub model: String,
}

/// What the UI gets after a token or a resolved model.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TurnView {
    pub session_id: String,
    pub turn: u32,
    pub model: String,
    pub first_model: String,
    pub routed: bool,
    /// true when this turn's model differs from the previous turn's.
    pub changed: bool,
    pub headline: String,
    pub history: Vec<TurnEntry>,
}

impl TurnTracker {
    /// Forget all turn state, optionally binding to a new conversation.
    pub fn reset(&mut self, new_session_id: &str) {
        self.session_id = new_session_id.to_string();
        self.turn_count = 0;
        self.first_model.clear();
        self.last_model.clear();
        self.routed = false;
        self.history.clear();
    }

    /// Clear only the routed flag (when echoing a remembered model for a chat
    /// we are not live-tracking).
    pub fn clear_routed(&mut self) {
        self.routed = false;
    }

    /// A fresh run token arrived = a new turn. Returns (turn, switched).
    pub fn on_token(&mut self, session_id: &str) -> (u32, bool) {
        let switched = !session_id.is_empty() && session_id != self.session_id;
        if switched {
            self.reset(session_id);
        }
        self.turn_count += 1;
        (self.turn_count, switched)
    }

    /// Record the resolved model for `turn` and build the status view.
    pub fn record(&mut self, turn: u32, model: &str) -> TurnView {
        if self.first_model.is_empty() {
            self.first_model = model.to_string();
        }
        self.routed = model != self.first_model;
        let changed = !self.last_model.is_empty() && model != self.last_model;
        self.last_model = model.to_string();
        self.history.push_back(TurnEntry { turn, model: model.to_string() });
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
        let headline = if self.routed && changed {
            format!("第 {turn} 轮 · 已切换模型 → {model}")
        } else if self.routed {
            format!("第 {turn} 轮 · {model}(非首轮模型)")
        } else {
            format!("第 {turn} 轮 · {model}")
        };
        TurnView {
            session_id: self.session_id.clone(),
            turn,
            model: model.to_string(),
            first_model: self.first_model.clone(),
            routed: self.routed,
            changed,
            headline,
            history: self.history.iter().cloned().collect(),
        }
    }

    /// "本会话: R1 m1 · R2 m2" — newest last.
    pub fn history_line(&self) -> String {
        let parts: Vec<String> = self.history.iter().map(|e| format!("R{} {}", e.turn, e.model)).collect();
        format!("本会话: {}", parts.join(" · "))
    }

    pub fn history(&self) -> Vec<TurnEntry> {
        self.history.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_count_per_session_and_reset_on_switch() {
        let mut t = TurnTracker::default();
        assert_eq!(t.on_token("s1"), (1, true));
        assert_eq!(t.on_token(""), (2, false), "empty session keeps the conversation");
        assert_eq!(t.on_token("s1"), (3, false));
        assert_eq!(t.on_token("s2"), (1, true));
        assert_eq!(t.session_id, "s2");
    }

    #[test]
    fn routed_flag_compares_with_first_model() {
        let mut t = TurnTracker::default();
        t.on_token("s1");
        let v1 = t.record(1, "gpt-6");
        assert!(!v1.routed && !v1.changed);
        assert_eq!(v1.headline, "第 1 轮 · gpt-6");
        t.on_token("s1");
        let v2 = t.record(2, "claude-opus-5");
        assert!(v2.routed && v2.changed);
        assert_eq!(v2.headline, "第 2 轮 · 已切换模型 → claude-opus-5");
        t.on_token("s1");
        let v3 = t.record(3, "claude-opus-5");
        assert!(v3.routed && !v3.changed);
        assert_eq!(v3.headline, "第 3 轮 · claude-opus-5(非首轮模型)");
        assert_eq!(t.history_line(), "本会话: R1 gpt-6 · R2 claude-opus-5 · R3 claude-opus-5");
        t.on_token("s1");
        let v4 = t.record(4, "gpt-6");
        assert!(!v4.routed && v4.changed, "back to the first model is not routed");
    }

    #[test]
    fn history_is_capped() {
        let mut t = TurnTracker::default();
        t.on_token("s");
        for i in 1..=(MAX_HISTORY as u32 + 3) {
            t.record(i, "m");
        }
        assert_eq!(t.history().len(), MAX_HISTORY);
        assert_eq!(t.history()[0].turn, 4);
        t.clear_routed();
        assert!(!t.routed);
    }
}
