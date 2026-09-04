use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};

use crate::commands::{diag_log, BrowserState};

/// The native browser shell manages:
/// 1. The navigation overlay WebView (always above browsing WebViews)
/// 2. The menu overlay WebView (right-side drawer, above browsing WebViews)
/// 3. Overlay positions (draggable, persisted)
/// 4. Navigation commands routed to the active tab
///
/// CRITICAL: The `on_navigation` callback runs on the WebView2 compositor thread,
/// NOT the main thread. Any window/webview management call (`add_child`, `set_bounds`,
/// `show`, `hide`, `eval`) MUST be dispatched to the main thread via
/// `app.run_on_main_thread()` to avoid deadlock.

pub struct NavOverlay {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct ShellState {
    pub overlay: Mutex<Option<NavOverlay>>,
    pub overlay_ready: Mutex<bool>,
    pub overlay_creating: Mutex<bool>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            overlay: Mutex::new(None),
            overlay_ready: Mutex::new(false),
            overlay_creating: Mutex::new(false),
        }
    }
}

const OVERLAY_LABEL: &str = "nav-overlay";
const OVERLAY_WIDTH: f64 = 360.0;
const OVERLAY_HEIGHT: f64 = 108.0;
// ─── Position persistence ───

fn pos_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("overlay_pos.json"))
}

fn load_overlay_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    if let Some(path) = pos_file(app) {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                let x = val.get("x").and_then(|v| v.as_f64());
                let y = val.get("y").and_then(|v| v.as_f64());
                if let (Some(x), Some(y)) = (x, y) {
                    return Some((x, y));
                }
            }
        }
    }
    None
}

fn save_overlay_position(app: &tauri::AppHandle, x: f64, y: f64) {
    if let Some(path) = pos_file(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let data = serde_json::json!({ "x": x, "y": y });
        let _ = std::fs::write(&path, serde_json::to_string(&data).unwrap_or_default());
    }
}

// ─── Shared navigation commands (routed to active tab) ───

pub fn nav_back(app: &tauri::AppHandle) -> Result<(), String> {
    let browser = app.state::<BrowserState>();
    let active = *browser.active.lock().unwrap();
    match active {
        Some(id) => {
            diag_log(&format!("[NAV] back tab={}", id));
            let label = browser.tabs.lock().unwrap().get(&id).cloned();
            if let Some(label) = label {
                if let Some(wv) = app.get_webview(&label) {
                    wv.eval("history.back()").map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        None => Err("no active tab".into()),
    }
}

pub fn nav_forward(app: &tauri::AppHandle) -> Result<(), String> {
    let browser = app.state::<BrowserState>();
    let active = *browser.active.lock().unwrap();
    match active {
        Some(id) => {
            diag_log(&format!("[NAV] forward tab={}", id));
            let label = browser.tabs.lock().unwrap().get(&id).cloned();
            if let Some(label) = label {
                if let Some(wv) = app.get_webview(&label) {
                    wv.eval("history.forward()").map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        None => Err("no active tab".into()),
    }
}

pub fn nav_home(app: &tauri::AppHandle) -> Result<(), String> {
    let browser = app.state::<BrowserState>();
    let active = *browser.active.lock().unwrap();
    match active {
        Some(id) => {
            diag_log(&format!("[NAV] home tab={}", id));
            let label = browser.tabs.lock().unwrap().get(&id).cloned();
            if let Some(label) = label {
                if let Some(wv) = app.get_webview(&label) {
                    // Ensure the active tab is visible first, then navigate home.
                    if let Some(bounds) = crate::commands::tab_bounds(app) {
                        let _ = wv.set_bounds(bounds);
                    }
                    let _ = wv.show();
                    let _ = wv.eval("window.location.replace('tauri://localhost/newtab.html')");
                }
            }
            crate::shell::ensure_overlay_above(app);
            Ok(())
        }
        None => Err("no active tab".into()),
    }
}

pub fn nav_tabs(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] tabs");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("nav-action", "tabs");
    }
    Ok(())
}

pub fn nav_menu(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] menu -> frontend side-menu");
    // The full Via menu (side-menu with all items) lives in the main webview.
    // Emit nav-action "menu" and the frontend toggles it, hiding tab webviews
    // so the main webview (and its menu DOM) becomes visible.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("nav-action", "menu");
    }
    Ok(())
}


// ─── Navigation overlay (the pill bar) ───

pub fn create_nav_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] create_nav_overlay called");

    let state = app.state::<ShellState>();

    if *state.overlay_ready.lock().unwrap() {
        diag_log("[SHELL] overlay already ready, skipping");
        return Ok(());
    }

    {
        let mut creating = state.overlay_creating.lock().unwrap();
        if *creating {
            diag_log("[SHELL] overlay already being created by another thread, skipping");
            return Ok(());
        }
        *creating = true;
    }

    diag_log("[SHELL] Creating navigation overlay — starting add_child");

    let window = app.get_window("main")
        .ok_or("main window not found")?;

    let win_size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;

    // Load persisted position or default to bottom center
    let (x, y) = match load_overlay_position(app) {
        Some((sx, sy)) => {
            let x = sx.clamp(0.0, (win_w - OVERLAY_WIDTH).max(0.0));
            let y = sy.clamp(0.0, (win_h - OVERLAY_HEIGHT).max(0.0));
            (x, y)
        }
        None => {
            let x = (win_w - OVERLAY_WIDTH) / 2.0;
            let y = win_h - OVERLAY_HEIGHT - 20.0;
            (x, y)
        }
    };

    let position = tauri::LogicalPosition::new(x, y);
    let size = tauri::LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT);

    let overlay_app = app.clone();
    let builder = WebviewBuilder::new(OVERLAY_LABEL, WebviewUrl::App("nav-overlay.html".into()))
        .transparent(true)
        .on_navigation(move |url| {
            if url.scheme() == "via-action" {
                let action = url.host_str().unwrap_or("").to_string();
                diag_log(&format!("[NAV-OVERLAY] via-action action={}", action));
                // Dispatch ALL operations to the main thread to avoid WebView2 deadlock.
                // The on_navigation callback runs on the WebView2 compositor thread.
                let app2 = overlay_app.clone();
                let _ = overlay_app.run_on_main_thread(move || {
                    match action.as_str() {
                        "back" => { let _ = nav_back(&app2); }
                        "forward" => { let _ = nav_forward(&app2); }
                        "home" => { let _ = nav_home(&app2); }
                        "tabs" => { let _ = nav_tabs(&app2); }
                        "menu" => { let _ = nav_menu(&app2); }
                        a if a.starts_with("menu-item:") => {
                            let item_action = a[10..].to_string();
                            diag_log(&format!("[NAV-OVERLAY] menu-item: {}", item_action));
                            if let Some(win) = app2.get_webview_window("main") {
                                let _ = win.emit("menu-action", item_action);
                            }
                        }
                        _ => diag_log(&format!("[NAV-OVERLAY] unknown via-action: {}", action)),
                    }
                });
                return false;
            }
            if url.scheme() == "via-drag" {
                if let Some(coords) = url.host_str() {
                    let parts: Vec<f64> = coords.split(',').filter_map(|p| p.parse().ok()).collect();
                    if parts.len() == 2 {
                        let app2 = overlay_app.clone();
                        let _ = overlay_app.run_on_main_thread(move || {
                            // Read current position, apply delta, and move
                            let state = app2.state::<ShellState>();
                            let current = { state.overlay.lock().unwrap().as_ref().map(|ov| (ov.x, ov.y)) };
                            if let Some((cx, cy)) = current {
                                let _ = move_overlay(&app2, cx + parts[0], cy + parts[1]);
                            }
                        });
                    }
                }
                return false;
            }
            true
        });

    let webview = window.add_child(builder, tauri::Position::Logical(position), tauri::Size::Logical(size))
        .map_err(|e| {
            diag_log(&format!("[SHELL] overlay create FAILED: {}", e));
            *state.overlay_creating.lock().unwrap() = false;
            e.to_string()
        })?;

    diag_log("[SHELL] overlay CREATED via add_child");
    diag_log(&format!("[SHELL] overlay_position x={} y={} w={} h={}", x, y, OVERLAY_WIDTH, OVERLAY_HEIGHT));

    *state.overlay.lock().unwrap() = Some(NavOverlay {
        label: OVERLAY_LABEL.to_string(),
        x, y,
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
    });
    *state.overlay_creating.lock().unwrap() = false;
    *state.overlay_ready.lock().unwrap() = true;

    let _ = webview.show();
    diag_log("[NAV-OVERLAY] z-order=above-webview — READY");

    Ok(())
}

pub fn move_overlay(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let mut overlay = state.overlay.lock().unwrap();
    if let Some(ref mut ov) = *overlay {
        let window = app.get_window("main").ok_or("main window not found")?;
        let win_size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let win_w = win_size.width as f64 / scale;
        let win_h = win_size.height as f64 / scale;

        let x = x.clamp(0.0, (win_w - ov.width).max(0.0));
        let y = y.clamp(0.0, (win_h - ov.height).max(0.0));

        ov.x = x;
        ov.y = y;

        if let Some(wv) = app.get_webview(&ov.label) {
            let _ = wv.set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(x, y).into(),
                size: tauri::LogicalSize::new(ov.width, ov.height).into(),
            });
        }
        diag_log(&format!("[NAV-DRAG] moved x={} y={}", x, y));

        let (nx, ny) = (ov.x, ov.y);
        drop(overlay);
        save_overlay_position(app, nx, ny);
    }
    Ok(())
}

pub fn ensure_overlay_above(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let ready = *state.overlay_ready.lock().unwrap();
    if !ready {
        diag_log("[SHELL] ensure_overlay_above: not ready, spawning creation thread");
        let app2 = app.clone();
        std::thread::spawn(move || {
            let _ = create_nav_overlay(&app2);
        });
        return;
    }
    let label = state.overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.show();
        }
    }
}

pub fn clamp_overlay_position(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let mut overlay = state.overlay.lock().unwrap();
    if let Some(ref mut ov) = *overlay {
        let window = match app.get_window("main") {
            Some(w) => w,
            None => return,
        };
        let win_size = match window.inner_size() {
            Ok(s) => s,
            Err(_) => return,
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let win_w = win_size.width as f64 / scale;
        let win_h = win_size.height as f64 / scale;

        let needs_clamp = ov.x > win_w - ov.width || ov.y > win_h - ov.height;
        if needs_clamp {
            ov.x = ov.x.clamp(0.0, (win_w - ov.width).max(0.0));
            ov.y = ov.y.clamp(0.0, (win_h - ov.height).max(0.0));
            if let Some(wv) = app.get_webview(&ov.label) {
                let _ = wv.set_bounds(tauri::Rect {
                    position: tauri::LogicalPosition::new(ov.x, ov.y).into(),
                    size: tauri::LogicalSize::new(ov.width, ov.height).into(),
                });
            }
            diag_log(&format!("[SHELL] overlay clamped x={} y={}", ov.x, ov.y));
            let (nx, ny) = (ov.x, ov.y);
            drop(overlay);
            save_overlay_position(app, nx, ny);
        }
    }
}

/// Update overlay tab count display
pub fn update_overlay_tab_count(app: &tauri::AppHandle, count: usize) {
    let state = app.state::<ShellState>();
    let label = state.overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let js = format!("var e=document.getElementById('tab-count');if(e)e.textContent='{}';", count);
            let _ = wv.eval(&js);
        }
    }
}

/// Update the address bar URL shown in the navigation overlay.
pub fn update_overlay_url(app: &tauri::AppHandle, url: &str) {
    let state = app.state::<ShellState>();
    let label = state.overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes());
            let js = format!(
                "if(window.__updateAddressBar)window.__updateAddressBar(atob('{}'));",
                encoded
            );
            let _ = wv.eval(&js);
        }
    }
}
