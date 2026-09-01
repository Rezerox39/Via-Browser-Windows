#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ── WebView2 Runtime pre-flight check ──────────────────────────────
    // Tauri requires a compatible WebView2 Runtime.  If it is missing the
    // user sees a branded dialog explaining the problem and offering an
    // install-retry flow instead of a raw crash.
    #[cfg(target_os = "windows")]
    {
        match via_browser_lib::runtime::check_webview2_runtime() {
            Ok(ver) => {
                println!("[Via] WebView2 Runtime detected: {ver}");
            }
            Err(e) => {
                eprintln!("[Via] WebView2 Runtime not found: {e}");
                if via_browser_lib::runtime::show_prerequisite_dialog(&e).is_err() {
                    eprintln!("[Via] User cancelled setup. Exiting.");
                    return;
                }
            }
        }
    }

    via_browser_lib::run()
}
