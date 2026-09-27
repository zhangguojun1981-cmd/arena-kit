//! Accounts and tabs ("sessions").
//!
//! An *account* is a named, isolated browsing profile for arena.ai with an
//! optional proxy node. On desktop every account can be opened in any number
//! of *tabs*; each tab is its own child webview created with the account's
//! data store (cookies / localStorage / IndexedDB are never shared between
//! accounts) and the account's proxy. Accounts are persisted as JSON in the
//! app config directory; tabs live only for the process.
//!
//! This module is platform-independent data + validation so it can be unit
//! tested without a Tauri runtime. The webview plumbing lives in `lib.rs`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ACCOUNTS_FILE: &str = "accounts.json";

/// Colours offered for the account dot (flat palette, works on both themes).
pub const PALETTE: [&str; 8] = [
    "#5b5bd6", "#1f9d6a", "#d48806", "#e0434a", "#0e8ab0", "#b0489a", "#6b7c3f", "#7a5c3e",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
    /// `http://host:port` or `socks5://host:port`, no credentials.
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub note: String,
    /// Unix seconds.
    #[serde(default)]
    pub created: u64,
}

fn default_color() -> String {
    PALETTE[0].to_string()
}

/// Input accepted from the shell UI when creating / editing an account.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct AccountInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AccountsFile {
    #[serde(default)]
    pub accounts: Vec<Account>,
}

/// Normalise and validate a proxy URL. Returns `Ok(None)` for "no proxy".
///
/// Only the schemes the webview engines accept are allowed (`http`,
/// `socks5`), the host must be present and credentials are rejected because
/// neither WebKit's `proxyConfigurations` nor WebView2's `--proxy-server`
/// carry them.
pub fn normalize_proxy(raw: Option<&str>) -> Result<Option<String>, String> {
    let raw = match raw.map(str::trim) {
        None | Some("") => return Ok(None),
        Some(s) => s,
    };
    // Be forgiving about a missing scheme: "127.0.0.1:7890" → http.
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|e| format!("代理地址无法解析: {e}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "socks5" {
        return Err(format!(
            "代理只支持 http:// 或 socks5://(收到 {scheme}://)"
        ));
    }
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "代理地址缺少主机名".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("暂不支持带账号密码的代理,请使用本地无鉴权端口".into());
    }
    let port = url
        .port()
        .unwrap_or(if scheme == "socks5" { 1080 } else { 8080 });
    if url.path() != "/" && !url.path().is_empty() {
        return Err("代理地址不应包含路径".into());
    }
    Ok(Some(format!("{scheme}://{host}:{port}")))
}

/// Derive the 16-byte WebKit data-store identifier for an account.
/// The id is a UUID string; fall back to a stable hash for foreign ids.
pub fn store_identifier(account_id: &str) -> [u8; 16] {
    if let Ok(u) = uuid::Uuid::parse_str(account_id) {
        return *u.as_bytes();
    }
    // FNV-1a over the id, twice with different seeds, to fill 16 bytes.
    let mut out = [0u8; 16];
    for (half, seed) in [(0usize, 0xcbf2_9ce4_8422_2325u64), (8, 0x84222325_cbf29ce4u64)] {
        let mut h = seed;
        for b in account_id.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        out[half..half + 8].copy_from_slice(&h.to_le_bytes());
    }
    out
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// In-memory account book with load/save helpers.
#[derive(Default, Debug)]
pub struct AccountBook {
    pub accounts: Vec<Account>,
    pub path: Option<PathBuf>,
}

impl AccountBook {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(ACCOUNTS_FILE);
        let accounts = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<AccountsFile>(&s).ok())
            .map(|f| f.accounts)
            .unwrap_or_default();
        Self {
            accounts,
            path: Some(path),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(&AccountsFile {
            accounts: self.accounts.clone(),
        })
        .map_err(|e| e.to_string())?;
        // Write-then-rename so a crash never leaves a truncated file.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    /// Create or update. Returns the stored account.
    pub fn upsert(&mut self, input: AccountInput) -> Result<Account, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("账号名称不能为空".into());
        }
        if name.chars().count() > 40 {
            return Err("账号名称过长(最多 40 字)".into());
        }
        let proxy = normalize_proxy(input.proxy.as_deref())?;
        let color = input
            .color
            .as_deref()
            .map(str::trim)
            .filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()))
            .map(str::to_string);
        let note = input.note.unwrap_or_default().trim().chars().take(200).collect::<String>();

        if let Some(id) = input.id.as_deref().filter(|s| !s.is_empty()) {
            let acc = self
                .accounts
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or_else(|| "账号不存在".to_string())?;
            acc.name = name.to_string();
            acc.proxy = proxy;
            if let Some(c) = color {
                acc.color = c;
            }
            acc.note = note;
            return Ok(acc.clone());
        }

        let color = color.unwrap_or_else(|| PALETTE[self.accounts.len() % PALETTE.len()].to_string());
        let acc = Account {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            proxy,
            color,
            note,
            created: now_secs(),
        };
        self.accounts.push(acc.clone());
        Ok(acc)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.accounts.len();
        self.accounts.retain(|a| a.id != id);
        before != self.accounts.len()
    }
}

// ── tabs ─────────────────────────────────────────────────────────────────

pub const TAB_LABEL_PREFIX: &str = "arena-";

#[derive(Clone, Debug)]
pub struct Tab {
    pub id: u32,
    pub label: String,
    pub account_id: String,
}

#[derive(Default, Debug)]
pub struct TabList {
    pub tabs: Vec<Tab>,
    pub active: Option<u32>,
    next: u32,
}

impl TabList {
    pub fn allocate(&mut self, account_id: &str) -> Tab {
        self.next += 1;
        let tab = Tab {
            id: self.next,
            label: format!("{TAB_LABEL_PREFIX}{}", self.next),
            account_id: account_id.to_string(),
        };
        self.tabs.push(tab.clone());
        tab
    }

    pub fn get(&self, id: u32) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    pub fn by_label(&self, label: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.label == label)
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.active.and_then(|id| self.get(id))
    }

    /// Remove a tab; returns the tab that should become active afterwards
    /// (the neighbour to the left, like a browser), or `None` for "home".
    pub fn remove(&mut self, id: u32) -> Option<Tab> {
        let Some(pos) = self.tabs.iter().position(|t| t.id == id) else {
            return None;
        };
        let removed = self.tabs.remove(pos);
        if self.active == Some(id) {
            self.active = if self.tabs.is_empty() {
                None
            } else {
                Some(self.tabs[pos.saturating_sub(1).min(self.tabs.len() - 1)].id)
            };
        }
        Some(removed)
    }

    pub fn tabs_for_account<'a>(&'a self, account_id: &'a str) -> impl Iterator<Item = &'a Tab> + 'a {
        self.tabs.iter().filter(move |t| t.account_id == account_id)
    }
}

/// Parse a tab id out of a webview label (`arena-7` → 7).
pub fn tab_id_from_label(label: &str) -> Option<u32> {
    label.strip_prefix(TAB_LABEL_PREFIX)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_normalisation() {
        assert_eq!(normalize_proxy(None).unwrap(), None);
        assert_eq!(normalize_proxy(Some("  ")).unwrap(), None);
        assert_eq!(normalize_proxy(Some("127.0.0.1:7890")).unwrap().unwrap(), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy(Some("SOCKS5://10.0.0.2:1080/")).unwrap().unwrap(), "socks5://10.0.0.2:1080");
        assert_eq!(normalize_proxy(Some("socks5://host")).unwrap().unwrap(), "socks5://host:1080");
        assert!(normalize_proxy(Some("https://x:1")).is_err());
        assert!(normalize_proxy(Some("socks5://u:p@h:1")).is_err());
        assert!(normalize_proxy(Some("http://h:1/path")).is_err());
        assert!(normalize_proxy(Some("::bad")).is_err());
    }

    #[test]
    fn store_identifier_is_stable_and_distinct() {
        let a = store_identifier("6f1c2b4e-1111-4222-8333-444455556666");
        let b = store_identifier("6f1c2b4e-1111-4222-8333-444455556667");
        assert_ne!(a, b);
        assert_eq!(a, store_identifier("6f1c2b4e-1111-4222-8333-444455556666"));
        let c = store_identifier("legacy-id");
        assert_eq!(c, store_identifier("legacy-id"));
        assert_ne!(c, store_identifier("legacy-id2"));
    }

    #[test]
    fn account_book_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ak-test-{}", uuid::Uuid::new_v4()));
        let mut book = AccountBook::load(&dir);
        assert!(book.accounts.is_empty());
        let a = book
            .upsert(AccountInput { name: " 主号 ".into(), proxy: Some("127.0.0.1:7890".into()), ..Default::default() })
            .unwrap();
        assert_eq!(a.name, "主号");
        assert_eq!(a.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(a.color, PALETTE[0]);
        let b = book.upsert(AccountInput { name: "小号".into(), ..Default::default() }).unwrap();
        assert_eq!(b.color, PALETTE[1]);
        book.save().unwrap();

        let again = AccountBook::load(&dir);
        assert_eq!(again.accounts, book.accounts);

        // edit keeps id, validates proxy
        let edited = book
            .upsert(AccountInput { id: Some(a.id.clone()), name: "主号2".into(), proxy: None, color: Some("#000000".into()), note: Some("x".into()) })
            .unwrap();
        assert_eq!(edited.id, a.id);
        assert_eq!(edited.proxy, None);
        assert_eq!(edited.color, "#000000");
        assert!(book
            .upsert(AccountInput { id: Some(a.id.clone()), name: "主号2".into(), proxy: Some("ftp://x".into()), ..Default::default() })
            .is_err());
        assert!(book.remove(&a.id));
        assert!(!book.remove(&a.id));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tab_list_neighbour_activation() {
        let mut tabs = TabList::default();
        let t1 = tabs.allocate("a");
        let t2 = tabs.allocate("a");
        let t3 = tabs.allocate("b");
        assert_eq!(t1.label, "arena-1");
        assert_eq!(tab_id_from_label(&t3.label), Some(3));
        assert_eq!(tab_id_from_label("shell"), None);
        tabs.active = Some(t2.id);
        tabs.remove(t2.id);
        assert_eq!(tabs.active, Some(t1.id), "left neighbour becomes active");
        tabs.active = Some(t1.id);
        tabs.remove(t1.id);
        assert_eq!(tabs.active, Some(t3.id), "first remaining when leftmost closed");
        tabs.remove(t3.id);
        assert_eq!(tabs.active, None);
        assert_eq!(tabs.tabs_for_account("a").count(), 0);
    }
}
