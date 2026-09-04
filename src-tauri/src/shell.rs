use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewBuilder, WebviewUrl};

use crate::commands::{diag_log, BrowserState};

/// The native browser shell manages:
/// 1. The navigation overlay WebView (always above browsing WebViews)
/// 2. Overlay position (draggable, persisted)
/// 3. Navigation commands routed to the active tab

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
    pub menu_overlay: Mutex<Option<NavOverlay>>,
    pub menu_open: Mutex<bool>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            overlay: Mutex::new(None),
            overlay_ready: Mutex::new(false),
            overlay_creating: Mutex::new(false),
            menu_overlay: Mutex::new(None),
            menu_open: Mutex::new(false),
        }
    }
}

const OVERLAY_LABEL: &str = "nav-overlay";
const OVERLAY_WIDTH: f64 = 360.0;
const OVERLAY_HEIGHT: f64 = 108.0;
const MENU_LABEL: &str = "menu-overlay";
const MENU_WIDTH: f64 = 340.0;

/// Create the native floating navigation overlay.
/// This overlay is a transparent child WebView that sits ABOVE all browsing WebViews.
/// RACE-SAFE: Uses overlay_creating guard to prevent concurrent add_child calls
/// which cause WebView2 deadlocks on Windows.
pub fn create_nav_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] create_nav_overlay called");

    let state = app.state::<ShellState>();

    // Already created? Return immediately.
    if *state.overlay_ready.lock().unwrap() {
        diag_log("[SHELL] overlay already ready, skipping");
        return Ok(());
    }

    // Another thread is currently creating it? Return immediately.
    // The first thread will finish and set overlay_ready=true.
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

    // Position at bottom center
    let x = (win_w - OVERLAY_WIDTH) / 2.0;
    let y = win_h - OVERLAY_HEIGHT - 20.0;

    let position = tauri::LogicalPosition::new(x, y);
    let size = tauri::LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT);

    // Create transparent WebView for the nav overlay
    let builder = WebviewBuilder::new(OVERLAY_LABEL, WebviewUrl::App("nav-overlay.html".into()))
        .transparent(true);

    let webview = window.add_child(builder, tauri::Position::Logical(position), tauri::Size::Logical(size))
        .map_err(|e| {
            diag_log(&format!("[SHELL] overlay create FAILED: {}", e));
            // Clear creating guard so future attempts can retry
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
    // Clear creating flag BEFORE setting ready, so any waiting thread sees ready=true
    *state.overlay_creating.lock().unwrap() = false;
    *state.overlay_ready.lock().unwrap() = true;

    // Show overlay but do NOT call set_focus() — it steals keyboard focus from the browsing WebView
    let _ = webview.show();

    diag_log("[SHELL] overlay z-order=above-webview — READY");

    Ok(())
}

/// Move the overlay to a new position (called by drag events from the overlay JS)
pub fn move_overlay(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let mut overlay = state.overlay.lock().unwrap();
    if let Some(ref mut ov) = *overlay {
        // Clamp to window bounds
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
    }
    Ok(())
}

/// Ensure the overlay stays above all other webviews after a tab switch or navigation.
/// If overlay doesn't exist yet, spawns background creation — NEVER blocks the caller.
pub fn ensure_overlay_above(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let ready = *state.overlay_ready.lock().unwrap();
    if !ready {
        diag_log("[SHELL] ensure_overlay_above: not ready, spawning creation thread");
        // Spawn in background so we NEVER block show_tab/select_tab
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
            // NOTE: do NOT set_focus() — it steals keyboard focus from the browsing WebView
        }
    }
}

/// Clamp overlay position after window resize
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
        }
    }
}

/// Create the floating menu overlay (child WebView above browsing WebViews)
pub fn create_menu_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] Creating menu overlay");
    let window = app.get_window("main").ok_or("main window not found")?;
    let bounds = crate::commands::tab_bounds(app).ok_or("window unavailable")?;

    let builder = tauri::WebviewBuilder::new(MENU_LABEL, tauri::WebviewUrl::App("menu-overlay.html".into()))
        .transparent(true);

    let webview = window.add_child(builder, bounds.position, bounds.size)
        .map_err(|e| {
            diag_log(&format!("[SHELL] menu overlay create FAILED: {}", e));
            e.to_string()
        })?;

    webview.hide().ok();

    let state = app.state::<ShellState>();
    *state.menu_overlay.lock().unwrap() = Some(NavOverlay {
        label: MENU_LABEL.to_string(),
        x: 0.0, y: 0.0,
        width: MENU_WIDTH, height: 0.0,
    });

    diag_log("[SHELL] menu overlay CREATED");
    Ok(())
}

/// Handle navigation commands from the overlay
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
                    // Navigate to newtab page via absolute asset path
                    wv.eval("window.location.replace('tauri://localhost/newtab.html')").map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        None => Err("no active tab".into()),
    }
}

pub fn nav_tabs(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] tabs");
    // Emit event to frontend to show tab panel
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("nav-action", "tabs");
    }
    Ok(())
}

pub fn nav_menu(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] menu");
    let state = app.state::<ShellState>();
    let is_open = *state.menu_open.lock().unwrap();

    if is_open {
        // Close menu overlay
        *state.menu_open.lock().unwrap() = false;
        let label = state.menu_overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
        if let Some(label) = label {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.eval("document.getElementById('menu-panel').classList.remove('open');");
                std::thread::sleep(std::time::Duration::from_millis(300));
                let _ = wv.hide();
            }
        }
        diag_log("[NAV] menu CLOSED");
    } else {
        // Open menu overlay — create if needed
        if state.menu_overlay.lock().unwrap().is_none() {
            let _ = create_menu_overlay(app);
        }
        let label = state.menu_overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
        if let Some(label) = label {
            if let Some(wv) = app.get_webview(&label) {
                if let Some(bounds) = crate::commands::tab_bounds(app) {
                    let _ = wv.set_bounds(bounds);
                }
                let _ = wv.show();
                let _ = wv.eval("document.getElementById('menu-panel').classList.add('open');");
                *state.menu_open.lock().unwrap() = true;
                diag_log("[NAV] menu OPENED");
            }
        }
    }
    Ok(())
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
            // Use base64 encoding to safely pass URL through JS
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
