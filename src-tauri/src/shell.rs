use std::sync::Mutex;
use tauri::{Emitter, Manager, Url, WebviewBuilder, WebviewUrl};

use crate::commands::{diag_log, BrowserState};

/// The native browser shell manages:
/// 1. The navigation overlay WebView (always above browsing WebViews)
/// 2. The menu overlay WebView (full-window, slides in from right)
/// 3. The tabs overlay WebView (centered panel)
/// 4. Overlay positions (draggable, persisted)
/// 5. Navigation commands routed to the active tab
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

pub struct MenuOverlay {
    pub label: String,
    pub visible: bool,
}

pub struct TabsOverlay {
    pub label: String,
    pub visible: bool,
}

pub struct ShellState {
    pub overlay: Mutex<Option<NavOverlay>>,
    pub overlay_ready: Mutex<bool>,
    pub overlay_creating: Mutex<bool>,
    pub drag: Mutex<Option<DragSession>>,
    pub menu: Mutex<Option<MenuOverlay>>,
    pub tabs_panel: Mutex<Option<TabsOverlay>>,
}

#[derive(Clone, Copy)]
pub struct DragSession {
    pub origin_x: f64,
    pub origin_y: f64,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            overlay: Mutex::new(None),
            overlay_ready: Mutex::new(false),
            overlay_creating: Mutex::new(false),
            drag: Mutex::new(None),
            menu: Mutex::new(None),
            tabs_panel: Mutex::new(None),
        }
    }
}

const OVERLAY_LABEL: &str = "nav-overlay";
const OVERLAY_WIDTH: f64 = 360.0;
const OVERLAY_HEIGHT: f64 = 108.0;
const MENU_LABEL: &str = "menu-overlay";
const TABS_LABEL: &str = "tabs-overlay";

// ═══════ Position persistence ═══════

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

// ═══════ Shared navigation commands (routed to active tab) ═══════

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
                    if let Some(bounds) = crate::commands::tab_bounds(app) {
                        let _ = wv.set_bounds(bounds);
                    }
                    let _ = wv.show();
                    let _ = wv.navigate(Url::parse("tauri://localhost/newtab.html").unwrap());
                }
            }
            ensure_overlay_above(app);
            Ok(())
        }
        None => Err("no active tab".into()),
    }
}

pub fn hide_all_tabs(app: &tauri::AppHandle) {
    let browser = app.state::<BrowserState>();
    let labels: Vec<String> = browser.tabs.lock().unwrap().values().cloned().collect();
    for label in labels {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.hide();
        }
    }
}

pub fn eval_main(app: &tauri::AppHandle, js: &str) {
    if let Some(wv) = app.get_webview("main") {
        let _ = wv.eval(js);
    } else if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(js);
    }
}

// ═══════ Native menu overlay ═══════

pub fn nav_menu(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] menu -> native overlay");
    let state = app.state::<ShellState>();
    let menu = state.menu.lock().unwrap();
    let visible = menu.as_ref().map(|m| m.visible).unwrap_or(false);
    drop(menu);
    if visible {
        hide_menu_overlay(app);
    } else {
        show_menu_overlay(app);
    }
    Ok(())
}

fn show_menu_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let has_label = state.menu.lock().unwrap().as_ref().map(|m| m.label.clone());
    if let Some(ref label) = has_label {
        if let Some(wv) = app.get_webview(label) {
            let _ = wv.show();
            if let Some(menu) = state.menu.lock().unwrap().as_mut() {
                menu.visible = true;
            }
            diag_log("[NAV-OVERLAY] menu visible=true");
            return;
        }
    }
    drop(has_label);
    let _ = create_menu_overlay(app);
}

pub fn hide_menu_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let has_label = state.menu.lock().unwrap().as_ref().map(|m| m.label.clone());
    if let Some(ref label) = has_label {
        if let Some(wv) = app.get_webview(label) {
            let _ = wv.hide();
        }
        if let Some(menu) = state.menu.lock().unwrap().as_mut() {
            menu.visible = false;
        }
        diag_log("[NAV-OVERLAY] menu visible=false");
    }
}

fn create_menu_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] create_menu_overlay called");
    let state = app.state::<ShellState>();
    {
        let menu = state.menu.lock().unwrap();
        if menu.is_some() {
            drop(menu);
            show_menu_overlay(app);
            return Ok(());
        }
    }
    let window = app.get_window("main").ok_or("main window not found")?;
    let win_size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;

    let position = tauri::LogicalPosition::new(0.0, 0.0);
    let size = tauri::LogicalSize::new(win_w, win_h);

    let overlay_app = app.clone();
    let builder = WebviewBuilder::new(MENU_LABEL, WebviewUrl::App("menu-overlay.html".into()))
        .transparent(true)
        .on_navigation(move |url| {
            if url.scheme() == "via-action" {
                let action = url.host_str().unwrap_or("").to_string();
                diag_log(&format!("[NAV-OVERLAY] menu via-action action={}", action));
                let app2 = overlay_app.clone();
                let _ = overlay_app.run_on_main_thread(move || {
                    handle_menu_action(&app2, &action);
                });
                return false;
            }
            true
        });

    let webview = window.add_child(builder, tauri::Position::Logical(position), tauri::Size::Logical(size))
        .map_err(|e| {
            diag_log(&format!("[SHELL] menu overlay create FAILED: {}", e));
            e.to_string()
        })?;

    let _ = webview.hide();
    *state.menu.lock().unwrap() = Some(MenuOverlay { label: MENU_LABEL.to_string(), visible: false });
    diag_log("[SHELL] menu overlay CREATED");

    show_menu_overlay(app);
    Ok(())
}

fn handle_menu_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "close-menu" => { hide_menu_overlay(app); }
        "close-tabs" => { hide_tabs_overlay(app); }
        a if a.starts_with("menu-item:") => {
            let item_action = a[10..].to_string();
            diag_log(&format!("[NAV-OVERLAY] menu-item: {}", item_action));
            hide_menu_overlay(app);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit("menu-action", &item_action);
            }
        }
        a if a.starts_with("tab-switch:") => {
            let id_str = a[11..].to_string();
            if let Ok(id) = id_str.parse::<u32>() {
                diag_log(&format!("[NAV-OVERLAY] tab-switch id={}", id));
                hide_tabs_overlay(app);
                let _ = crate::commands::select_tab_native(&app, id);
                let _ = crate::commands::show_tab(app.clone(), id);
                ensure_overlay_above(app);
            }
        }
        a if a.starts_with("tab-close:") => {
            let id_str = a[10..].to_string();
            if let Ok(id) = id_str.parse::<u32>() {
                diag_log(&format!("[NAV-OVERLAY] tab-close id={}", id));
                let _ = crate::commands::close_tab_native(&app, id);
                refresh_tabs_overlay(app);
            }
        }
        "tab-new" => {
            diag_log("[NAV-OVERLAY] tab-new");
            // Do NOT hide tabs overlay yet — let create_tab → show_tab handle it.
            // Refresh the tabs panel after a short delay to show the new tab.
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                refresh_tabs_overlay(&app2);
            });
        }
        _ => diag_log(&format!("[NAV-OVERLAY] unknown action: {}", action)),
    }
}

// ═══════ Native tabs overlay ═══════

pub fn nav_tabs(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[NAV] tabs -> native overlay");
    let state = app.state::<ShellState>();
    let panel = state.tabs_panel.lock().unwrap();
    let visible = panel.as_ref().map(|p| p.visible).unwrap_or(false);
    drop(panel);
    if visible {
        hide_tabs_overlay(app);
    } else {
        show_tabs_overlay(app);
    }
    Ok(())
}

fn show_tabs_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let has_label = state.tabs_panel.lock().unwrap().as_ref().map(|p| p.label.clone());
    if let Some(ref label) = has_label {
        if let Some(wv) = app.get_webview(label) {
            refresh_tabs_overlay(app);
            let _ = wv.show();
            if let Some(panel) = state.tabs_panel.lock().unwrap().as_mut() {
                panel.visible = true;
            }
            diag_log("[NAV-OVERLAY] tabs visible=true");
            return;
        }
    }
    drop(has_label);
    let _ = create_tabs_overlay(app);
}

pub fn hide_tabs_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let has_label = state.tabs_panel.lock().unwrap().as_ref().map(|p| p.label.clone());
    if let Some(ref label) = has_label {
        if let Some(wv) = app.get_webview(label) {
            let _ = wv.hide();
        }
        if let Some(panel) = state.tabs_panel.lock().unwrap().as_mut() {
            panel.visible = false;
        }
        diag_log("[NAV-OVERLAY] tabs visible=false");
    }
}

fn create_tabs_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    diag_log("[SHELL] create_tabs_overlay called");
    let state = app.state::<ShellState>();
    {
        let panel = state.tabs_panel.lock().unwrap();
        if panel.is_some() {
            drop(panel);
            show_tabs_overlay(app);
            return Ok(());
        }
    }
    let window = app.get_window("main").ok_or("main window not found")?;
    let win_size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;

    let position = tauri::LogicalPosition::new(0.0, 0.0);
    let size = tauri::LogicalSize::new(win_w, win_h);

    let overlay_app = app.clone();
    let builder = WebviewBuilder::new(TABS_LABEL, WebviewUrl::App("tabs-overlay.html".into()))
        .transparent(true)
        .on_navigation(move |url| {
            if url.scheme() == "via-action" {
                let action = url.host_str().unwrap_or("").to_string();
                diag_log(&format!("[NAV-OVERLAY] tabs via-action action={}", action));
                let app2 = overlay_app.clone();
                let _ = overlay_app.run_on_main_thread(move || {
                    handle_menu_action(&app2, &action);
                });
                return false;
            }
            true
        });

    let webview = window.add_child(builder, tauri::Position::Logical(position), tauri::Size::Logical(size))
        .map_err(|e| {
            diag_log(&format!("[SHELL] tabs overlay create FAILED: {}", e));
            e.to_string()
        })?;

    let _ = webview.hide();
    *state.tabs_panel.lock().unwrap() = Some(TabsOverlay { label: TABS_LABEL.to_string(), visible: false });
    diag_log("[SHELL] tabs overlay CREATED");

    show_tabs_overlay(app);
    Ok(())
}

/// Push current tab list to the tabs overlay via eval.
pub fn refresh_tabs_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let label = state.tabs_panel.lock().unwrap().as_ref().map(|p| p.label.clone());
    let Some(label) = label else { return };
    let Some(wv) = app.get_webview(&label) else { return };

    let browser = app.state::<BrowserState>();
    let tabs_map = browser.tabs.lock().unwrap().clone();
    let active = *browser.active.lock().unwrap();

    let tabs: Vec<serde_json::Value> = tabs_map.iter().map(|(id, lbl)| {
        let url = app.get_webview(lbl).and_then(|w| w.url().ok()).map(|u| u.to_string()).unwrap_or_default();
        serde_json::json!({
            "id": id,
            "title": url.split('/').last().unwrap_or("New Tab"),
            "url": url
        })
    }).collect();

    let data = serde_json::json!({
        "tabs": tabs,
        "active": active,
    });

    let js = format!("window.__renderTabs && window.__renderTabs({});", data);
    let _ = wv.eval(&js);
}

// ═══════ Navigation overlay (the pill bar) ═══════

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
                let app2 = overlay_app.clone();
                let _ = overlay_app.run_on_main_thread(move || {
                    match action.as_str() {
                        "back" => { let _ = nav_back(&app2); }
                        "forward" => { let _ = nav_forward(&app2); }
                        "home" => { let _ = nav_home(&app2); }
                        "tabs" => { let _ = nav_tabs(&app2); }
                        "menu" => { let _ = nav_menu(&app2); }
                        _ => {
                            // Delegate to shared handler
                            handle_menu_action(&app2, &action);
                        }
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
                            let _ = move_overlay(&app2, parts[0], parts[1]);
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

/// Destroy the current nav overlay and recreate it.
/// This puts it at the top of the z-order (last child wins in WebView2).
pub fn recreate_nav_overlay(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    // Destroy old overlay
    let old_label = {
        let mut overlay = state.overlay.lock().unwrap();
        let lbl = overlay.as_ref().map(|ov| ov.label.clone());
        *overlay = None;
        lbl
    };
    *state.overlay_ready.lock().unwrap() = false;
    *state.overlay_creating.lock().unwrap() = false;

    if let Some(label) = old_label {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.hide();
            // WebView2: dropping the handle should destroy the webview
        }
        // The webview is hidden; it will be garbage collected when the handle drops
        diag_log(&format!("[SHELL] old nav overlay hidden for replacement"));
        diag_log(&format!("[SHELL] nav overlay destroyed label={}", label));
    }

    // Recreate
    let _ = create_nav_overlay(app);
}

pub fn begin_overlay_drag(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    let origin = {
        let overlay = state.overlay.lock().unwrap();
        overlay.as_ref().map(|ov| (ov.x, ov.y))
    };
    if let Some((x, y)) = origin {
        *state.drag.lock().unwrap() = Some(DragSession { origin_x: x, origin_y: y });
    }
}

pub fn end_overlay_drag(app: &tauri::AppHandle) {
    *app.state::<ShellState>().drag.lock().unwrap() = None;
}

pub fn move_overlay(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<ShellState>();

    let (label, width, height, nx, ny) = {
        let mut overlay = state.overlay.lock().unwrap();
        let Some(ov) = overlay.as_mut() else { return Err("overlay not ready".into()) };

        let window = app.get_window("main").ok_or("main window not found")?;
        let win_size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let win_w = win_size.width as f64 / scale;
        let win_h = win_size.height as f64 / scale;

        let nx = x.clamp(0.0, (win_w - ov.width).max(0.0));
        let ny = y.clamp(0.0, (win_h - ov.height).max(0.0));

        ov.x = nx;
        ov.y = ny;

        (ov.label.clone(), ov.width, ov.height, nx, ny)
    };

    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(nx, ny).into(),
            size: tauri::LogicalSize::new(width, height).into(),
        });
    }
    diag_log(&format!("[NAV-DRAG] moved x={} y={}", nx, ny));
    save_overlay_position(app, nx, ny);
    Ok(())
}


/// Hide the nav overlay if it is ready. Used before showing a tab so the
/// webview is not covered, then recreate_nav_overlay puts it back on top.
pub fn hide_nav_overlay_if_ready(app: &tauri::AppHandle) {
    let state = app.state::<ShellState>();
    if *state.overlay_ready.lock().unwrap() {
        let label = state.overlay.lock().unwrap().as_ref().map(|ov| ov.label.clone());
        if let Some(label) = label {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.hide();
            }
        }
    }
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
