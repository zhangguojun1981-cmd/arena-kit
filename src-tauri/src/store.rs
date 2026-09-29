//! store.rs — tiny persistent JSON key/value store shared by the dock and the
//! page scripts (preferences, conversation history, probe counters).
//!
//! One file, `<app_data_dir>/arenakit-store.json`, written atomically (tmp +
//! rename) on every set. Values are arbitrary JSON; setting `null` removes the
//! key. This replaces chrome.storage.local (extension) / SharedPreferences
//! (Android) — see docs/DEVELOPMENT.md §7.

use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Store {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl Store {
    /// Load the store from disk (missing/corrupt file → empty store).
    pub fn open(path: PathBuf) -> Store {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .unwrap_or_default();
        Store {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn get(&self, key: &str) -> Value {
        self.data
            .lock()
            .map(|d| d.get(key).cloned().unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    }

    /// Keys starting with `prefix` (empty prefix = all keys), sorted.
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        self.data
            .lock()
            .map(|d| {
                d.keys()
                    .filter(|k| k.starts_with(prefix))
                    .cloned()
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    }

    /// Set (or remove, when `value` is null) and persist.
    ///
    /// The write happens while the lock is held: two overlapping sets could
    /// otherwise finish out of order (an older snapshot replacing a newer one)
    /// and would share the same `.tmp` file.
    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        if key.is_empty() || key.len() > 256 {
            return Err("store key 无效".into());
        }
        let mut d = self.data.lock().map_err(|_| "store 状态不可用".to_string())?;
        if value.is_null() {
            d.remove(key);
        } else {
            d.insert(key.to_string(), value);
        }
        let snapshot = serde_json::to_string(&*d).map_err(|e| e.to_string())?;
        self.persist(&snapshot)
    }

    fn persist(&self, snapshot: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        write_private(&tmp, snapshot).map_err(|e| e.to_string())?;
        if std::fs::rename(&tmp, &self.path).is_err() {
            // Fallback for filesystems that refuse to replace on rename.
            write_private(&self.path, snapshot).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(())
    }
}

/// Write `data` to `path`, readable by the current user only (0600 on unix):
/// the store holds saved login sessions, and the default umask (0644) would
/// let other local users read them.
fn write_private(path: &std::path::Path, data: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(data.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "arenakit-store-test-{}-{}.json",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn set_get_roundtrip_and_reload() {
        let path = temp_path("roundtrip");
        let store = Store::open(path.clone());
        store.set("prefs", json!({"renamePrefix": "AK-"})).unwrap();
        assert_eq!(store.get("prefs")["renamePrefix"], "AK-");
        // Reopen from disk.
        let again = Store::open(path.clone());
        assert_eq!(again.get("prefs")["renamePrefix"], "AK-");
        assert_eq!(again.get("missing"), Value::Null);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn null_removes_and_keys_filter_by_prefix() {
        let path = temp_path("keys");
        let store = Store::open(path.clone());
        store.set("history.a", json!(1)).unwrap();
        store.set("history.b", json!(2)).unwrap();
        store.set("prefs", json!(3)).unwrap();
        assert_eq!(store.keys("history."), vec!["history.a", "history.b"]);
        store.set("history.a", Value::Null).unwrap();
        assert_eq!(store.keys("history."), vec!["history.b"]);
        assert!(store.set("", json!(1)).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_file_yields_empty_store() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "not json").unwrap();
        let store = Store::open(path.clone());
        assert!(store.keys("").is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn store_file_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("perm");
        let store = Store::open(path.clone());
        store.set("accounts", json!({"list": []})).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_file(&path);
    }
}
