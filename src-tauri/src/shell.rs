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
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            overlay: Mutex::new(None),
            overlay_ready: Mutex::new(false),
        }
    }
}

const OVERLAY_LABEL: &str = "nav-overlay";
const OVERLAY_WIDTH: f64 = 360.0;
const OVERLAY_HEIGHT: f64 = 56.0;

/// Create the native floating navigation overlay.
/// This overlay is a transparent child WebView that sits ABOVE all browsing WebViews.
pub fn create_nav_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] Creating navigation overlay");

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
            e.to_string()
        })?;

    diag_log("[SHELL] overlay CREATED");
    diag_log(&format!("[SHELL] overlay_position x={} y={} w={} h={}", x, y, OVERLAY_WIDTH, OVERLAY_HEIGHT));

    let state = app.state::<ShellState>();
    *state.overlay.lock().unwrap() = Some(NavOverlay {
        label: OVERLAY_LABEL.to_string(),
        x, y,
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
    });
    *state.overlay_ready.lock().unwrap() = true;

    // Ensure overlay is always visible and on top
    let _ = webview.show();
    let _ = webview.set_focus();

    diag_log("[SHELL] overlay z-order=above-webview");
    diag_log("[SHELL] ready");

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
/// Re-creates it if it was dropped.
pub fn ensure_overlay_above(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let ready = *state.overlay_ready.lock().unwrap();
    if !ready {
        let _ = create_nav_overlay(app);
        return;
    }
    let label = state.overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.show();
            let _ = wv.set_focus();
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
                    // Navigate to newtab page
                    wv.eval("window.location.href = 'newtab.html'").map_err(|e| e.to_string())?;
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
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("nav-action", "menu");
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
