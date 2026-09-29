//! Desktop application menu (macOS menu bar; window menu elsewhere).
//!
//! Tauri's default menu has App / File / Edit / View / Window / Help but no
//! page actions, and WKWebView has no reload shortcut of its own. The 「页面」
//! submenu gives every ArenaKit window what the Android link tab's toolbar
//! offers (⟳ · 在浏览器中打开 · 复制链接) plus page history, with browser
//! shortcuts. The default menu is kept so Edit (copy / paste / select all)
//! and Window (⌘W closes a link tab, ⌘M minimises) keep working.
//!
//! Routing: a focused `tab-*` window is a plain browser view, so the action
//! runs right there (eval / url). Otherwise the action targets the arena page:
//! reload / back / forward are relayed to the dock as the page event `menu`
//! (dock.js → `requestReload` with its debounce, busy confirm and progress
//! bar, or `navBack` / `navForward`), while 在浏览器中打开 / 复制链接 only need
//! the current URL and are done natively.
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

pub const RELOAD: &str = "page-reload";
pub const BACK: &str = "page-back";
pub const FORWARD: &str = "page-forward";
pub const OPEN_EXTERNAL: &str = "page-open-external";
pub const COPY_LINK: &str = "page-copy-link";

/// Menu id → dock / tab action name (`None` for ids that are not ours, e.g.
/// the predefined Edit items).
pub fn action_for(id: &str) -> Option<&'static str> {
    match id {
        RELOAD => Some("reload"),
        BACK => Some("back"),
        FORWARD => Some("forward"),
        OPEN_EXTERNAL => Some("open-external"),
        COPY_LINK => Some("copy-link"),
        _ => None,
    }
}

/// Build the default menu + 「页面」 and install it with its event handler.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
    let handle = app.handle();
    let page = SubmenuBuilder::new(handle, "页面")
        .item(&MenuItemBuilder::with_id(RELOAD, "刷新").accelerator("CmdOrCtrl+R").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id(BACK, "后退").accelerator("CmdOrCtrl+[").build(handle)?)
        .item(&MenuItemBuilder::with_id(FORWARD, "前进").accelerator("CmdOrCtrl+]").build(handle)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id(OPEN_EXTERNAL, "在浏览器中打开")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(handle)?,
        )
        .item(&MenuItemBuilder::with_id(COPY_LINK, "复制链接").accelerator("CmdOrCtrl+Shift+C").build(handle)?)
        .build()?;
    let menu = Menu::default(handle)?;
    menu.append(&page)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if let Some(action) = action_for(&event.id().0) {
            dispatch(app, action);
        }
    });
    Ok(())
}

/// Where a menu action goes: the focused link-tab window, else the arena page.
enum Target {
    Tab(tauri::WebviewWindow),
    Arena,
}

fn focused_target(app: &AppHandle) -> Target {
    for (label, ww) in app.webview_windows() {
        if label.starts_with("tab-") && ww.is_focused().unwrap_or(false) {
            return Target::Tab(ww);
        }
    }
    Target::Arena
}

fn dispatch(app: &AppHandle, action: &str) {
    match focused_target(app) {
        Target::Tab(ww) => tab_action(app, &ww, action),
        Target::Arena => arena_action(app, action),
    }
}

fn tab_action(app: &AppHandle, ww: &tauri::WebviewWindow, action: &str) {
    match action {
        "reload" => {
            let _ = ww.eval("location.reload()");
        }
        "back" => {
            let _ = ww.eval("history.back()");
        }
        "forward" => {
            let _ = ww.eval("history.forward()");
        }
        "open-external" => {
            if let Ok(url) = ww.url() {
                crate::open_external(app, url.to_string());
            }
        }
        "copy-link" => {
            if let Ok(url) = ww.url() {
                copy_text(&url.to_string());
            }
        }
        _ => {}
    }
}

fn arena_action(app: &AppHandle, action: &str) {
    match action {
        "reload" | "back" | "forward" => {
            // dock.js onPage('menu'): reload → requestReload('menu'), back / forward → navBack / navForward.
            let _ = app.emit("arenakit://page", json!({"name": "menu", "payload": {"action": action}}));
        }
        "open-external" | "copy-link" => {
            let Some(wv) = app.get_webview("arena") else { return };
            let Ok(url) = wv.url() else { return };
            if action == "copy-link" {
                copy_text(&url.to_string());
            } else {
                crate::open_external(app, url.to_string());
            }
        }
        _ => {}
    }
}

/// Put `text` on the system clipboard (macOS `pbcopy`; one process, the text
/// goes through stdin so it is never shell-parsed).
#[cfg(target_os = "macos")]
fn copy_text(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    match Command::new("pbcopy").stdin(Stdio::piped()).spawn() {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            child.wait().map(|s| s.success()).unwrap_or(false)
        }
        Err(e) => {
            eprintln!("[ArenaKit] pbcopy failed: {e}");
            false
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_text(text: &str) -> bool {
    eprintln!("[ArenaKit] clipboard not wired on this platform: {text}");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_map_to_actions_and_foreign_ids_are_ignored() {
        assert_eq!(action_for(RELOAD), Some("reload"));
        assert_eq!(action_for(BACK), Some("back"));
        assert_eq!(action_for(FORWARD), Some("forward"));
        assert_eq!(action_for(OPEN_EXTERNAL), Some("open-external"));
        assert_eq!(action_for(COPY_LINK), Some("copy-link"));
        assert_eq!(action_for("copy"), None);
        assert_eq!(action_for(""), None);
    }
}
