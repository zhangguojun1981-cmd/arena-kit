fn main() {
    // Declare the app's own commands so tauri-build autogenerates
    // `allow-<command>` / `deny-<command>` permissions for them. This is what
    // lets the REMOTE arena.ai page (capabilities/arena.json) call a strict
    // subset of commands, while the bundled dock (capabilities/default.json)
    // gets the rest. Without an app manifest, remote origins can call nothing.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "on_token",
            "page_event",
            "proxy_get",
            "arena_command",
            "store_get",
            "store_set",
            "store_keys",
        ])),
    )
    .expect("failed to run tauri-build");
}
