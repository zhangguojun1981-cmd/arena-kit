//! Link routing for the arena webview — port of the reference app's
//! `web/LinkPolicy.kt` (arena-trace-android).
//!
//! The Arena webview must never be navigated away from the conversation by a
//! link: a web link to another site opens in the in-app link tab (a native
//! WebView layer on Android, a separate window on desktop); Arena itself,
//! sign-in / challenge hosts and passive schemes load in place; `mailto:` /
//! `tel:` / `intent:` … go to other apps; `file:` / `content:` / `javascript:`
//! are never loaded.
//!
//! Tauri's `on_navigation` only knows the URL — no gesture, redirect or
//! hit-test information — so a web URL to another site is treated as a tapped
//! link. The page-side interceptor (injected/links.js) sees the real click and
//! handles `target=_blank` / `window.open` before a navigation ever starts;
//! this is the safety net behind it. Pure functions, unit-tested below.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Let the webview load it where it is.
    InPlace,
    /// Open it in the in-app link tab, over the conversation.
    NewTab,
    /// Hand it to another app (mail, dialer, store, deep link …).
    ExternalApp,
    /// Swallow it.
    Block,
}

const ARENA_DOMAINS: [&str; 2] = ["arena.ai", "lmarena.ai"];
const WEB_SCHEMES: [&str; 2] = ["http", "https"];
const PASSIVE_SCHEMES: [&str; 3] = ["about", "blob", "data"];
const FORBIDDEN_SCHEMES: [&str; 4] = ["file", "content", "javascript", "vbscript"];
const AUTH_HOSTS: [&str; 5] = [
    "accounts.google.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "login.live.com",
    "challenges.cloudflare.com",
];
const AUTH_SUFFIXES: [&str; 4] = [".supabase.co", ".auth0.com", ".clerk.accounts.dev", ".firebaseapp.com"];
const AUTH_PATHS: [(&str, &[&str]); 4] = [
    ("github.com", &["/login", "/session"]),
    ("discord.com", &["/oauth2", "/api/oauth2"]),
    ("x.com", &["/i/oauth2"]),
    ("twitter.com", &["/i/oauth2"]),
];

pub fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// arena.ai (or lmarena.ai) itself or one of its subdomains — not look-alikes.
pub fn is_arena_host(host: &str) -> bool {
    let h = normalize_host(host);
    !h.is_empty()
        && ARENA_DOMAINS
            .iter()
            .any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

/// Sign-in / challenge flows must stay in the arena webview so they can finish
/// there (cookies and the redirect back to Arena).
pub fn is_auth_flow(host: &str, path: &str) -> bool {
    let h = normalize_host(host);
    if h.is_empty() {
        return false;
    }
    if AUTH_HOSTS.contains(&h.as_str()) || AUTH_SUFFIXES.iter().any(|s| h.ends_with(s)) {
        return true;
    }
    let bare = h.strip_prefix("www.").unwrap_or(&h);
    AUTH_PATHS
        .iter()
        .find(|(d, _)| *d == bare)
        .map(|(_, paths)| {
            paths
                .iter()
                .any(|p| path == *p || path.starts_with(&format!("{p}/")))
        })
        .unwrap_or(false)
}

/// The URL scheme in lower case ("" when there is none).
fn scheme_of(url: &str) -> String {
    let u = url.trim();
    match u.find(':') {
        Some(i) if i > 0
            && u[..i]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) =>
        {
            u[..i].to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

/// Host and path of an http(s) URL without pulling in a parser: `scheme://host[:port]/path?…`.
fn host_and_path(url: &str) -> (String, String) {
    let u = url.trim();
    let rest = match u.find("://") {
        Some(i) => &u[i + 3..],
        None => return (String::new(), String::new()),
    };
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let rest = &rest[..end];
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if host.starts_with('[') {
        host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or(host).to_string()
    };
    (host, path.to_string())
}

/// A main-frame navigation of the arena webview (same window).
pub fn route_main(url: &str) -> Route {
    let scheme = scheme_of(url);
    if scheme.is_empty() || PASSIVE_SCHEMES.contains(&scheme.as_str()) {
        return Route::InPlace;
    }
    if FORBIDDEN_SCHEMES.contains(&scheme.as_str()) {
        return Route::Block;
    }
    if WEB_SCHEMES.contains(&scheme.as_str()) {
        let (host, path) = host_and_path(url);
        if is_arena_host(&host) || is_auth_flow(&host, &path) {
            return Route::InPlace;
        }
        return Route::NewTab;
    }
    Route::ExternalApp
}

/// Only http(s) URLs are ever opened in a tab, a browser, copied or shared.
pub fn is_web_url(url: &str) -> bool {
    let u = url.trim();
    let scheme = scheme_of(u);
    WEB_SCHEMES.contains(&scheme.as_str()) && u.len() > scheme.len() + 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_and_its_subdomains_are_internal() {
        for h in ["arena.ai", "ARENA.AI", "arena.ai.", "auth.arena.ai", "lmarena.ai", "www.lmarena.ai"] {
            assert!(is_arena_host(h), "{h}");
        }
    }

    #[test]
    fn look_alike_hosts_are_not_arena() {
        for h in ["evilarena.ai", "arena.ai.evil.com", "arena.aii", ""] {
            assert!(!is_arena_host(h), "{h}");
        }
    }

    #[test]
    fn external_web_links_open_a_new_tab() {
        assert_eq!(route_main("https://example.com/docs"), Route::NewTab);
        assert_eq!(route_main("http://github.com/owner/repo"), Route::NewTab);
        assert_eq!(route_main("HTTPS://Example.COM:8443/x?y=1#z"), Route::NewTab);
    }

    #[test]
    fn arena_navigation_stays_in_place() {
        assert_eq!(route_main("https://arena.ai/agent/abc"), Route::InPlace);
        assert_eq!(route_main("https://arena.ai/"), Route::InPlace);
        assert_eq!(route_main("https://user:pw@auth.arena.ai/callback?code=1"), Route::InPlace);
    }

    #[test]
    fn sign_in_flows_stay_in_the_arena_webview() {
        for u in [
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://appleid.apple.com/auth/authorize",
            "https://abcd.supabase.co/auth/v1/authorize",
            "https://github.com/login/oauth/authorize",
            "https://www.github.com/session",
            "https://challenges.cloudflare.com/turnstile",
        ] {
            assert_eq!(route_main(u), Route::InPlace, "{u}");
        }
        // …but ordinary pages on the same sites are links like any other.
        assert_eq!(route_main("https://github.com/loginator/repo"), Route::NewTab);
        assert_eq!(route_main("https://www.google.com/search"), Route::NewTab);
    }

    #[test]
    fn other_schemes_go_to_other_apps_or_are_blocked() {
        assert_eq!(route_main("mailto:someone@example.com"), Route::ExternalApp);
        assert_eq!(route_main("tel:+85212345678"), Route::ExternalApp);
        assert_eq!(route_main("intent://scan/#Intent;scheme=zxing;end"), Route::ExternalApp);
        assert_eq!(route_main("market://details?id=x"), Route::ExternalApp);
        assert_eq!(route_main("file:///sdcard/secret.txt"), Route::Block);
        assert_eq!(route_main("content://com.example.provider/x"), Route::Block);
        assert_eq!(route_main("JavaScript:alert(1)"), Route::Block);
    }

    #[test]
    fn passive_schemes_load_in_place() {
        assert_eq!(route_main("about:blank"), Route::InPlace);
        assert_eq!(route_main("blob:https://arena.ai/1234"), Route::InPlace);
        assert_eq!(route_main("data:text/plain,hi"), Route::InPlace);
        assert_eq!(route_main(""), Route::InPlace);
        assert_eq!(route_main("/relative/path:with-colon"), Route::InPlace);
    }

    #[test]
    fn only_http_urls_count_as_web_urls() {
        assert!(is_web_url("https://example.com"));
        assert!(is_web_url("HTTP://example.com/x"));
        assert!(!is_web_url("https://"));
        assert!(!is_web_url("blob:https://arena.ai/1"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url(""));
    }
}
