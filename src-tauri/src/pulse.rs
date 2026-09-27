//! pulse.rs — daily-free-credit polling.
//! Ported from arena-trace-android `PulseClient.kt` / `PulseTiming.kt`.
//! STATUS: the live poll runs in the arena webview (injected/pulse.js — a
//! same-origin GET carries the user's cookies, which a Rust client would not
//! have) and the countdown/anchoring lives in src/lib/pulse.js. This module
//! keeps the shared thresholds so Rust-side consumers agree with the dock.

/// Back-off after a 429, honoring Retry-After when present (seconds).
/// Mirrors PulseTiming: clamp to [1, 300] seconds.
pub fn backoff_secs(retry_after: Option<u64>) -> u64 {
    retry_after.unwrap_or(60).clamp(1, 300)
}

/// Whether the credit gauge is in the warning (yellow) or danger (red) band.
/// Mirrors the Android HUD progress-bar thresholds: <10% red, <20% yellow.
#[derive(Debug, PartialEq)]
pub enum CreditBand {
    Danger,
    Warning,
    Ok,
}

pub fn credit_band(remaining: f64, total: f64) -> CreditBand {
    if total <= 0.0 {
        return CreditBand::Ok;
    }
    let pct = remaining / total;
    if pct < 0.10 {
        CreditBand::Danger
    } else if pct < 0.20 {
        CreditBand::Warning
    } else {
        CreditBand::Ok
    }
}

// Poll cadence (60 s, 15 s after a cookie change, 429 → Retry-After capped at
// 10 min) is implemented page-side in injected/pulse.js.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_defaults_and_clamps() {
        assert_eq!(backoff_secs(None), 60);
        assert_eq!(backoff_secs(Some(5)), 5);
        assert_eq!(backoff_secs(Some(0)), 1);
        assert_eq!(backoff_secs(Some(9999)), 300);
    }

    #[test]
    fn credit_bands_match_hud_thresholds() {
        assert_eq!(credit_band(5.0, 100.0), CreditBand::Danger);
        assert_eq!(credit_band(15.0, 100.0), CreditBand::Warning);
        assert_eq!(credit_band(50.0, 100.0), CreditBand::Ok);
        assert_eq!(credit_band(1.0, 0.0), CreditBand::Ok);
    }
}
