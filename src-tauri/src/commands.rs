use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    webview::DownloadEvent, Emitter, Manager, Url, WebviewBuilder,
};

use crate::adblock;
use crate::init;
use crate::settings::{self, Settings};

// ═══════ DIAGNOSTICS ═══════
pub const DIAG_BUILD: &str = "FUNCTIONAL_DIAGNOSTICS_2026_09_02_A";

// Cached initialization script — built once per settings change, reused per create_tab.
use std::sync::OnceLock;
static CACHED_INIT_SCRIPT: OnceLock<std::sync::Mutex<String>> = OnceLock::new();

/// Get or rebuild the cached init script.
pub fn get_or_build_init_script(settings: &Settings) -> String {
    let cell = CACHED_INIT_SCRIPT.get_or_init(|| std::sync::Mutex::new(String::new()));
    let mut cache = cell.lock().unwrap();
    if cache.is_empty() {
        *cache = init::build(settings);
    }
    cache.clone()
}

/// Rebuild the cached init script (call when settings change).
pub fn rebuild_init_script(settings: &Settings) {
    let cell = CACHED_INIT_SCRIPT.get_or_init(|| std::sync::Mutex::new(String::new()));
    let mut cache = cell.lock().unwrap();
    *cache = init::build(settings);
}

/// Deterministic log path: next to the exe (or Desktop fallback on Windows).
fn diag_log_path() -> std::path::PathBuf {
    // Primary: next to the exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("via-debug.log");
        }
    }
    // Fallback: Desktop
    if let Some(desktop) = dirs::desktop_dir() {
        return desktop.join("via-debug.log");
    }
    std::path::PathBuf::from("via-debug.log")
}

pub fn diag_log(msg: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{}] [RUST] {}\n", ts, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(diag_log_path())
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

/// Startup diagnostic: write initial state to log.
pub fn diag_boot() {
    diag_log("═══════════════════════════════════════");
    diag_log("  VIA BROWSER STARTUP DIAGNOSTIC");
    diag_log("═══════════════════════════════════════");
    diag_log(&format!("BUILD_ID={}", DIAG_BUILD));
    diag_log(&format!("OS={} ARCH={}", std::env::consts::OS, std::env::consts::ARCH));
    if let Ok(exe) = std::env::current_exe() {
        diag_log(&format!("EXE_PATH={}", exe.display()));
        if let Some(dir) = exe.parent() {
            diag_log(&format!("EXE_DIR={}", dir.display()));
            // Check if key files exist
            let checks = [
                ("WebView2Loader.dll", dir.join("WebView2Loader.dll")),
                ("via-browser-win.exe", exe),
            ];
            for (name, path) in &checks {
                let exists = path.exists();
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                diag_log(&format!("FILE_CHECK {} exists={} size={}", name, exists, size));
            }
        }
    }
    diag_log(&format!("LOG_PATH={}", diag_log_path().display()));
    diag_log(&format!("CWD={}", std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()));
    diag_log(&format!("TEMP_DIR={}", std::env::temp_dir().display()));
    // Check app config dir
    if let Some(dir) = dirs::config_dir() {
        diag_log(&format!("CONFIG_DIR={}", dir.display()));
    }
    if let Some(dir) = dirs::data_dir() {
        diag_log(&format!("DATA_DIR={}", dir.display()));
    }
    diag_log("═══════════════════════════════════════");
}

#[derive(Clone, Serialize)]
pub struct BrowserDiag {
    pub build: String,
    pub tab_count: usize,
    pub webview_labels: Vec<String>,
    pub active_tab: Option<u32>,
    pub next_id: u32,
    pub webview_details: Vec<WebViewDetail>,
}

#[derive(Clone, Serialize)]
pub struct WebViewDetail {
    pub label: String,
    pub webview_exists: bool,
    pub url: String,
}

// ═══════ EXISTING TYPES ═══════

#[derive(Clone, Serialize)]
pub struct SuggestItem {
    pub label: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct TabInfo {
    pub id: u32,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub active: bool,
}

#[derive(Default)]
pub struct BrowserState {
    pub tabs: Mutex<HashMap<u32, String>>,
    pub next_id: Mutex<u32>,
    pub active: Mutex<Option<u32>>,
    pub blocked: Mutex<u64>,
}

pub struct SettingsState(pub Mutex<Settings>);

const DOWNLOAD_EXTS: &[&str] = &[
    "apk", "xapk", "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "img",
    "exe", "msi", "msix", "deb", "rpm", "dmg", "pkg", "torrent",
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "3gp",
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "epub", "mobi",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "raw",
];

fn is_download_eligible(url: &Url) -> bool {
    if matches!(url.scheme(), "blob" | "data") { return true; }
    if url.host_str().is_none() { return true; }
    url.path_segments()
        .and_then(|mut segs| segs.next_back())
        .and_then(|seg| {
            let dot = seg.rfind('.')?;
            let ext = &seg[dot + 1..];
            ext.chars().all(|c| c.is_ascii_alphanumeric()).then(|| ext.to_ascii_lowercase())
        })
        .map(|ext| DOWNLOAD_EXTS.contains(&ext.as_str()))
        .unwrap_or(false)
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::Window, String> {
    app.get_window("main").ok_or_else(|| "main window not found".to_string())
}

pub fn tab_bounds(app: &tauri::AppHandle) -> Option<tauri::Rect> {
    let wvwin = app.get_webview_window("main")?;
    let physical = wvwin.inner_size().ok()?;
    if physical.width == 0 || physical.height == 0 { return None; }
    let scale = wvwin.scale_factor().unwrap_or(1.0);
    let width = physical.width as f64 / scale;
    let height = physical.height as f64 / scale;
    // Webview fills the full window — the native overlay floats above it
    Some(tauri::Rect {
        position: tauri::LogicalPosition::new(0.0, 0.0).into(),
        size: tauri::LogicalSize::new(width, height).into(),
    })
}

pub fn relayout_tabs(app: &tauri::AppHandle) {
    let state = app.state::<BrowserState>();
    let labels: Vec<String> = state.tabs.lock().unwrap().values().cloned().collect();
    let Some(bounds) = tab_bounds(app) else { return };
    for l in labels {
        if let Some(wv) = app.get_webview(&l) {
            let _ = wv.set_bounds(bounds);
        }
    }
}

// ---------- settings ----------

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    { let mut s = state.0.lock().unwrap(); *s = settings.clone(); }
    persist_settings(&app, &settings);
    Ok(())
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    if let Ok(dir) = app.path().app_config_dir() {
        let p = dir.join("via-settings.json");
        if let Ok(data) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str(&data) { return s; }
        }
    }
    Settings::default()
}

pub fn persist_settings(app: &tauri::AppHandle, s: &Settings) {
    rebuild_init_script(s);
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("via-settings.json");
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

#[tauri::command]
pub fn user_agent_for(state: tauri::State<'_, SettingsState>, mode: Option<String>) -> Option<String> {
    let s = state.0.lock().unwrap();
    let mode = mode.unwrap_or_else(|| s.ua_mode.clone());
    let mut tmp = s.clone();
    tmp.ua_mode = mode;
    settings::resolve_ua(&tmp)
}

#[tauri::command]
pub fn block_url(url: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_filters_css() -> String {
    adblock::all_cosmetic_rules_json()
}

#[tauri::command]
pub fn blocked_total(state: tauri::State<'_, BrowserState>) -> u64 {
    *state.blocked.lock().unwrap()
}

#[tauri::command]
pub async fn search_suggest(input: String) -> Vec<SuggestItem> {
    let url = Url::parse(&format!("https://suggestqueries.google.com/complete/search?client=firefox&q={}", urlencoding(&input))).unwrap();
    match fetch_text(&url) {
        Ok(body) => parse_suggest_json(&body),
        Err(_) => vec![],
    }
}

fn parse_suggest_json(body: &str) -> Vec<SuggestItem> {
    let mut items = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return items; };
    if let Some(arr) = v.as_array() {
        if let Some(sugs) = arr.get(1).and_then(|x| x.as_array()) {
            for s in sugs {
                if let Some(s) = s.as_str() {
                    items.push(SuggestItem { label: s.to_string(), url: s.to_string() });
                }
            }
        }
    }
    items
}

fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn fetch_text(url: &Url) -> Result<String, String> {
    let curl = if cfg!(target_os = "windows") { "curl.exe" } else { "curl" };
    let out = std::process::Command::new(curl)
        .arg("-s").arg("--max-time").arg("8")
        .arg("-A").arg("ViaBrowser/7.2.1")
        .arg(url.as_str())
        .output().map_err(|e| e.to_string())?;
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

// ---------- tabs ----------

#[tauri::command]
pub async fn create_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    sstate: tauri::State<'_, SettingsState>,
    url: Option<String>,
) -> Result<TabInfo, String> {
    diag_log("========================================");
    diag_log("[TAB_CREATE] BEGIN");
    diag_log(&format!("[TAB_CREATE] requested_url={:?}", url));
    diag_log(&format!("[TAB_CREATE] thread={:?}", std::thread::current().id()));

    let window = match main_window(&app) {
        Ok(w) => { diag_log("[TAB_CREATE] main_window=OK"); w }
        Err(e) => { diag_log(&format!("[TAB_CREATE] main_window=ERROR: {}", e)); return Err(e); }
    };

    let s = sstate.0.lock().unwrap().clone();
    {
        let tabs = state.tabs.lock().unwrap();
        let active = state.active.lock().unwrap();
        let next = *state.next_id.lock().unwrap();
        diag_log(&format!("[TAB_CREATE] existing_native_tabs={}, active={:?}, next_id={}", tabs.len(), *active, next));
        diag_log(&format!("[TAB_CREATE] existing_labels={:?}", tabs.values().collect::<Vec<_>>()));
    }

    let mut idx = state.next_id.lock().unwrap();
    *idx += 1;
    let id = *idx;
    let label = format!("tab-{id}");
    diag_log(&format!("[TAB_CREATE] generated_tab_id={}", id));
    diag_log(&format!("[TAB_CREATE] label={}", label));

    let target = url.unwrap_or_else(|| "newtab".to_string());
    diag_log(&format!("[TAB_CREATE] target_url={}", target));

    let is_newtab = target == "newtab";
    let webview_url = if is_newtab {
        diag_log("[TAB_CREATE] using App URL for newtab page");
        tauri::WebviewUrl::App("newtab.html".into())
    } else {
        match Url::parse(&normalize_url(&target)) {
            Ok(u) => { diag_log(&format!("[TAB_CREATE] url_parsed=OK normalized={}", u)); tauri::WebviewUrl::External(u) }
            Err(e) => { diag_log(&format!("[TAB_CREATE] url_parsed=ERROR: {}", e)); return Err(e.to_string()); }
        }
    };

    let bounds = match tab_bounds(&app) {
        Some(b) => { diag_log(&format!("[TAB_CREATE] bounds={:?}", b)); b }
        None => { diag_log("[TAB_CREATE] bounds=ERROR: window unavailable"); return Err("window unavailable".to_string()); }
    };

    let nav_settings = s.clone();
    let dl_label = label.clone();
    let nav_app = app.clone();
    let new_win_app = app.clone();

    let init_script = get_or_build_init_script(&s);
    diag_log(&format!("[TAB_CREATE] init_script_len={}", init_script.len()));
    let mut builder = WebviewBuilder::new(label.clone(), webview_url)
        .auto_resize()
        .initialization_script(&init_script)
        .on_download(move |wv, event| {
            let wv_app = wv.app_handle();
            let win = wv_app.get_webview_window("main");
            let id = wv_app.state::<BrowserState>().tabs.lock().unwrap()
                .iter().find_map(|(i, l)| if *l == dl_label { Some(*i) } else { None });
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dir = wv_app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
                    let _ = std::fs::create_dir_all(&dir);
                    let fname = real_filename(&url).unwrap_or_else(|| {
                        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                        format!("download-{ts}.zip")
                    });
                    let dest = dir.join(&fname);
                    let dest = if dest.exists() {
                        let stem = dest.file_stem().and_then(|f| f.to_str()).unwrap_or("download");
                        let ext = dest.extension().and_then(|e| e.to_str()).unwrap_or("");
                        let mut n = 1;
                        let mut candidate = dir.join(format!("{stem} ({n}).{ext}"));
                        while candidate.exists() && n < 1000 { n += 1; candidate = dir.join(format!("{stem} ({n}).{ext}")); }
                        candidate
                    } else { dest };
                    *destination = dest.clone();
                    if let Some(win) = &win {
                        let _ = win.emit("download-started", serde_json::json!({
                            "id": id, "url": url.to_string(), "path": dest.to_string_lossy(),
                        }));
                    }
                }
                DownloadEvent::Finished { url, path, success } => {
                    if success {
                        if let Some(p) = &path {
                            let store = wv_app.state::<crate::features::StoreState>();
                            crate::features::record_download(&wv_app, &store, url.to_string(), p.clone());
                        }
                    }
                    if let Some(win) = &win {
                        let _ = win.emit("download-progress", serde_json::json!({
                            "id": id, "url": url.to_string(),
                            "path": path.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                            "received": 0, "total": 0, "done": true, "success": success,
                        }));
                    }
                }
                _ => {}
            }
            true
        })
        .on_page_load(move |wv, payload| {
            let wv_app = wv.app_handle();
            let label = wv.label().to_string();
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                diag_log(&format!("[NAVIGATION] PAGE_LOAD_STARTED label={} url={}", label, payload.url()));
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let url = payload.url().to_string();
                diag_log(&format!("[TAB-LIFECYCLE] NAVIGATION_FINISHED label={} url={}", label, url));
                // Use try_lock to avoid deadlock with WebView2 callback thread
                let tabs = wv_app.state::<BrowserState>();
                let active_id = match tabs.active.try_lock() {
                    Ok(guard) => *guard,
                    Err(_) => { diag_log("[TAB-LIFECYCLE] NAV_FINISHED: active lock contention"); return; }
                };
                let id = match tabs.tabs.try_lock() {
                    Ok(guard) => guard.iter().find_map(|(i, l)| if *l == label { Some(*i) } else { None }),
                    Err(_) => { diag_log("[TAB-LIFECYCLE] NAV_FINISHED: tabs lock contention"); return; }
                };
                if let Some(id) = id {
                    if let Some(win) = wv_app.get_webview_window("main") {
                        let _ = win.emit("tab-url", serde_json::json!({ "id": id, "url": url }));
                    }
                    if active_id == Some(id) {
                        crate::shell::update_overlay_url(&wv_app, &url);
                    }
                }
            }
        })
        .on_document_title_changed(move |wv, title| {
            let wv_app = wv.app_handle();
            let label = wv.label().to_string();
            let tabs = wv_app.state::<BrowserState>();
            let id = match tabs.tabs.try_lock() {
                Ok(guard) => guard.iter().find_map(|(i, l)| if *l == label { Some(*i) } else { None }),
                Err(_) => return,
            };
            if let Some(id) = id {
                if let Some(win) = wv_app.get_webview_window("main") {
                    if let Some(rest) = title.strip_prefix("VIA:") {
                        if let Some(decoded) = percent_decode(rest) {
                            let _ = win.emit("via-msg", serde_json::json!({ "id": id, "msg": decoded }));
                        }
                        return;
                    }
                    let _ = win.emit("tab-title", serde_json::json!({ "id": id, "title": title }));
                }
            }
        })
        .on_navigation(move |url| {
            if url.scheme() == "via-action" {
                let action = url.host_str().unwrap_or("").to_string();
                diag_log(&format!("[NAVIGATION] VIA_ACTION action={}", action));
                if let Some(win) = nav_app.get_webview_window("main") {
                    let _ = win.emit("nav-action", action);
                }
                return false;
            }
            diag_log(&format!("[TAB-LIFECYCLE] ON_NAVIGATION url={}", url));
            if is_download_eligible(&url) { return true; }
            let host = url.host_str().unwrap_or("").to_lowercase();
            let mut adblock = nav_settings.adblock_enabled;
            for site in &nav_settings.sites {
                if host == site.host || host.ends_with(&format!(".{}", site.host)) {
                    adblock = site.adblock_enabled;
                    break;
                }
            }
            if adblock && adblock::load_default_filters().block(url.as_str()).is_some() {
                diag_log(&format!("[NAVIGATION] BLOCKED_BY_ADBLOCK url={}", url));
                return false;
            }
            true
        })
        .on_new_window(move |url, _features| {
            let nav_url = url.to_string();
            diag_log(&format!("[NAVIGATION] NEW_WINDOW url={}", nav_url));
            // Emit event to frontend to handle new tab creation.
            // Do NOT acquire BrowserState locks here — this callback runs on the
            // WebView2 thread and would deadlock if the Tokio thread holds the lock.
            if let Some(win) = new_win_app.get_webview_window("main") {
                let _ = win.emit("new-window-request", serde_json::json!({ "url": nav_url }));
            }
            tauri::webview::NewWindowResponse::Deny
        });

    if let Some(ua) = settings::resolve_ua(&s) {
        builder = builder.user_agent(&ua);
    }

    diag_log("[TAB_CREATE] before_add_child (posts to main thread)");
    let webview = match window.add_child(builder, bounds.position, bounds.size) {
        Ok(wv) => { diag_log("[TAB_CREATE] add_child=SUCCESS"); wv }
        Err(e) => { diag_log(&format!("[TAB_CREATE] add_child=ERROR: {}", e)); return Err(e.to_string()); }
    };

    diag_log(&format!("[TAB-LIFECYCLE] CREATED id={} label={}", id, webview.label()));
    webview.hide().ok();
    diag_log(&format!("[TAB-LIFECYCLE] ATTACHED id={} label={}", id, label));

    {
        let mut tabs = state.tabs.lock().unwrap();
        tabs.insert(id, label.clone());
    }
    *state.active.lock().unwrap() = Some(id);

    let final_count = state.tabs.lock().unwrap().len();
    let final_active = *state.active.lock().unwrap();
    diag_log(&format!("[TAB-LIFECYCLE] ACTIVATED id={} native_tab_count={}", id, final_count));
    diag_log("[TAB_CREATE] END");
    diag_log("========================================");

    Ok(TabInfo {
        id,
        url: target,
        title: String::new(),
        loading: false,
        active: true,
    })
}

#[tauri::command]
pub fn get_browser_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> BrowserDiag {
    let tabs = state.tabs.lock().unwrap();
    let active = state.active.lock().unwrap();
    let next = *state.next_id.lock().unwrap();
    let labels: Vec<String> = tabs.values().cloned().collect();

    let mut details = Vec::new();
    for (_id, label) in tabs.iter() {
        let wv_exists = app.get_webview(label).is_some();
        let url = if wv_exists {
            app.get_webview(label).and_then(|wv| wv.url().ok()).map(|u| u.to_string()).unwrap_or_default()
        } else { String::new() };
        details.push(WebViewDetail {
            label: label.clone(),
            webview_exists: wv_exists,
            url,
        });
    }

    diag_log(&format!("[STATE_QUERY] native_tabs={} active={:?} next_id={} labels={:?}", tabs.len(), *active, next, labels));
    for d in &details {
        diag_log(&format!("[STATE_QUERY]   tab_label={} webview_exists={} url={}", d.label, d.webview_exists, d.url));
    }

    BrowserDiag {
        build: DIAG_BUILD.to_string(),
        tab_count: tabs.len(),
        webview_labels: labels,
        active_tab: *active,
        next_id: next,
        webview_details: details,
    }
}

#[tauri::command]
pub fn close_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<(), String> {
    diag_log(&format!("[CLOSE_TAB] BEGIN id={}", id));
    let label = state.tabs.lock().unwrap().remove(&id);
    if let Some(label) = label {
        diag_log(&format!("[CLOSE_TAB] found_label={}", label));
        if let Some(wv) = app.get_webview(&label) {
            if app.state::<SettingsState>().0.lock().unwrap().clear_on_exit {
                let _ = wv.clear_all_browsing_data();
            }
            let _ = wv.close();
            diag_log("[CLOSE_TAB] webview.closed()");
        } else {
            diag_log("[CLOSE_TAB] webview_NOT_FOUND");
        }
    } else {
        diag_log("[CLOSE_TAB] label_NOT_FOUND");
    }
    if *state.active.lock().unwrap() == Some(id) {
        *state.active.lock().unwrap() = None;
        diag_log("[CLOSE_TAB] cleared_active");
    }
    let final_count = state.tabs.lock().unwrap().len();
    diag_log(&format!("[CLOSE_TAB] END remaining_tabs={}", final_count));
    Ok(())
}

#[tauri::command]
pub fn navigate_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
    url: String,
) -> Result<(), String> {
    diag_log(&format!("[NAVIGATE_TAB] BEGIN id={} url={}", id, url));
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    match &label {
        Some(l) => diag_log(&format!("[NAVIGATE_TAB] label={}", l)),
        None => { diag_log("[NAVIGATE_TAB] label_NOT_FOUND"); return Err("tab not found".into()); }
    }
    let label = label.unwrap();
    match app.get_webview(&label) {
        Some(wv) => {
            let parsed = Url::parse(&normalize_url(&url)).map_err(|e| e.to_string())?;
            diag_log(&format!("[NAVIGATE_TAB] calling_wv.navigate url={}", parsed));
            match wv.navigate(parsed) {
                Ok(()) => diag_log("[NAVIGATE_TAB] wv.navigate=SUCCESS"),
                Err(e) => { diag_log(&format!("[NAVIGATE_TAB] wv.navigate=ERROR: {}", e)); return Err(e.to_string()); }
            }
        }
        None => {
            diag_log("[NAVIGATE_TAB] webview_NOT_FOUND");
            return Err("webview not found".into());
        }
    }
    diag_log("[NAVIGATE_TAB] END");
    Ok(())
}

#[tauri::command]
pub fn select_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<TabInfo, String> {
    diag_log(&format!("[SELECT_TAB] BEGIN id={}", id));
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    match &label {
        Some(l) => diag_log(&format!("[SELECT_TAB] label={}", l)),
        None => { diag_log("[SELECT_TAB] label_NOT_FOUND"); return Err("tab not found".into()); }
    }
    let label = label.unwrap();
    match app.get_webview(&label) {
        Some(wv) => {
            if let Some(bounds) = tab_bounds(&app) {
                let _ = wv.set_bounds(bounds);
            }
            let _ = wv.show();
            let _ = wv.set_focus();
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            diag_log(&format!("[SELECT_TAB] webview.show+focus url={}", url));
            crate::shell::update_overlay_url(&app, &url);
            for (_, other) in state.tabs.lock().unwrap().iter() {
                if other != &label {
                    if let Some(o) = app.get_webview(other) {
                        let _ = o.hide();
                        let _ = o.set_bounds(tauri::Rect {
                            position: tauri::LogicalPosition::new(-99999.0, -99999.0).into(),
                            size: tauri::LogicalSize::new(1.0, 1.0).into(),
                        });
                    }
                }
            }
            *state.active.lock().unwrap() = Some(id);
            crate::shell::ensure_overlay_above(&app);
            diag_log(&format!("[SELECT_TAB] END active={}", id));
            return Ok(TabInfo { id, url, title: String::new(), loading: false, active: true });
        }
        None => {
            diag_log("[SELECT_TAB] webview_NOT_FOUND");
            return Err("webview not found".into());
        }
    }
}

#[tauri::command]
pub fn hide_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("tab-{}", id);
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.hide();
        let _ = wv.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(-99999.0, -99999.0).into(),
            size: tauri::LogicalSize::new(1.0, 1.0).into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn show_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("tab-{}", id);
    diag_log(&format!("[SHOW_TAB] id={} label={}", id, label));
    if let Some(wv) = app.get_webview(&label) {
        if let Some(bounds) = tab_bounds(&app) {
            let _ = wv.set_bounds(bounds);
        }
        let _ = wv.show();
        let _ = wv.set_focus();
        diag_log(&format!("[TAB-LIFECYCLE] VISIBLE id={}", id));
        // Update overlay address bar with this tab's URL
        if let Ok(url) = wv.url() {
            crate::shell::update_overlay_url(&app, &url.to_string());
        }
        // Ensure the navigation overlay stays above this webview
        crate::shell::ensure_overlay_above(&app);
    } else {
        diag_log("[SHOW_TAB] webview_NOT_FOUND");
    }
    Ok(())
}

#[tauri::command]
pub fn get_tab_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<String, String> {
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            return wv.url().map(|u| u.to_string()).map_err(|e| e.to_string());
        }
    }
    Err("tab not found".into())
}

#[tauri::command]
pub fn eval_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
    js: String,
) -> Result<(), String> {
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            wv.eval(js).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_tabs(state: tauri::State<'_, BrowserState>) -> Vec<TabInfo> {
    let tabs = state.tabs.lock().unwrap();
    let active = state.active.lock().unwrap();
    tabs.iter().map(|(id, _)| TabInfo {
        id: *id,
        url: String::new(),
        title: String::new(),
        loading: false,
        active: Some(id) == active.as_ref(),
    }).collect()
}

#[tauri::command]
pub fn clear_data(app: tauri::AppHandle, state: tauri::State<'_, BrowserState>) -> Result<(), String> {
    let labels: Vec<String> = state.tabs.lock().unwrap().values().cloned().collect();
    for l in labels {
        if let Some(wv) = app.get_webview(&l) { let _ = wv.clear_all_browsing_data(); }
    }
    Ok(())
}

#[tauri::command]
pub fn set_night_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    enabled: bool,
) -> Result<(), String> {
    let labels: Vec<String> = state.tabs.lock().unwrap().values().cloned().collect();
    let js = if enabled {
        "document.documentElement.classList.add('night-mode')"
    } else {
        "document.documentElement.classList.remove('night-mode')"
    };
    for l in labels {
        if let Some(wv) = app.get_webview(&l) { let _ = wv.eval(js); }
    }
    Ok(())
}

#[tauri::command]
pub fn navigate_to_newtab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<(), String> {
    diag_log(&format!("[NAVIGATE_NEWTAB] id={}", id));
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    match &label {
        Some(l) => {
            if let Some(wv) = app.get_webview(l) {
                // Use eval to navigate to the newtab page via the app protocol
                let js = "window.location.replace('tauri://localhost/newtab.html')";
                match wv.eval(js) {
                    Ok(()) => { diag_log("[NAVIGATE_NEWTAB] OK"); Ok(()) }
                    Err(e) => { diag_log(&format!("[NAVIGATE_NEWTAB] ERROR: {}", e)); Err(e.to_string()) }
                }
            } else {
                diag_log("[NAVIGATE_NEWTAB] webview not found");
                Err("webview not found".into())
            }
        }
        None => { diag_log("[NAVIGATE_NEWTAB] tab not found"); Err("tab not found".into()) }
    }
}

#[tauri::command]
pub fn get_active_tab_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Option<TabInfo> {
    let active = match *state.active.lock().unwrap() {
        Some(id) => id,
        None => return None,
    };
    let label = state.tabs.lock().unwrap().get(&active).cloned()?;
    let wv = app.get_webview(&label)?;
    let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
    Some(TabInfo { id: active, url, title: String::new(), loading: false, active: true })
}

#[tauri::command]
pub fn on_nav_click(
    app: tauri::AppHandle,
    action: String,
) -> Result<(), String> {
    match action.as_str() {
        "back" => crate::shell::nav_back(&app),
        "forward" => crate::shell::nav_forward(&app),
        "home" => crate::shell::nav_home(&app),
        "tabs" => crate::shell::nav_tabs(&app),
        "menu" => crate::shell::nav_menu(&app),
        _ => { diag_log(&format!("[NAV] unknown action: {}", action)); Ok(()) }
    }
}

#[tauri::command]
pub fn on_nav_drag(
    app: tauri::AppHandle,
    dx: f64,
    dy: f64,
) -> Result<(), String> {
    let state = app.state::<crate::shell::ShellState>();
    let overlay = state.overlay.lock().unwrap();
    if let Some(ref ov) = *overlay {
        crate::shell::move_overlay(&app, ov.x + dx, ov.y + dy)
    } else {
        Err("overlay not found".into())
    }
}

/// Handle address bar navigation from the overlay.
/// Parses the input as URL or search query, navigates the active tab.
#[tauri::command]
pub fn address_bar_navigate(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    sstate: tauri::State<'_, SettingsState>,
    url: String,
) -> Result<(), String> {
    let engine = sstate.0.lock().unwrap().search_engine.clone();
    let resolved = parse_address(&url, &engine);
    diag_log(&format!("[ADDR-BAR] input='{}' resolved='{}'", url, resolved));
    let active = *state.active.lock().unwrap();
    match active {
        Some(id) => {
            let label = state.tabs.lock().unwrap().get(&id).cloned();
            if let Some(label) = label {
                if let Some(wv) = app.get_webview(&label) {
                    let parsed = Url::parse(&resolved).map_err(|e| e.to_string())?;
                    wv.navigate(parsed).map_err(|e| e.to_string())?;
                    diag_log("[ADDR-BAR] navigate=OK");
                    return Ok(());
                }
            }
            Err("active tab has no webview".into())
        }
        None => Err("no active tab".into()),
    }
}

/// Diagnostic: test if tab creation works and return detailed result
#[tauri::command]
pub async fn diag_test_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    sstate: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    diag_log("═══ DIAG_TEST_TAB START ═══");
    let mut results = Vec::new();
    
    // Test 1: main window
    match main_window(&app) {
        Ok(w) => {
            let size = w.inner_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_default();
            results.push(format!("main_window=OK size={}", size));
            diag_log(&format!("[DIAG] main_window OK size={}", size));
        }
        Err(e) => {
            results.push(format!("main_window=FAIL: {}", e));
            diag_log(&format!("[DIAG] main_window FAIL: {}", e));
        }
    }
    
    // Test 2: settings
    {
        let s = sstate.0.lock().unwrap();
        results.push(format!("settings=OK engine={} ua_mode={}", s.search_engine, s.ua_mode));
        diag_log(&format!("[DIAG] settings OK engine={} ua_mode={}", s.search_engine, s.ua_mode));
    }
    
    // Test 3: browser state
    {
        let tabs = state.tabs.lock().unwrap();
        let active = state.active.lock().unwrap();
        let next = *state.next_id.lock().unwrap();
        results.push(format!("browser_state=OK tabs={} active={:?} next_id={}", tabs.len(), *active, next));
        diag_log(&format!("[DIAG] browser_state OK tabs={} active={:?}", tabs.len(), *active));
    }
    
    // Test 4: create a test tab
    diag_log("[DIAG] Creating test tab...");
    let test_url = Some("https://www.google.com".to_string());
    match create_tab(app.clone(), state.clone(), sstate.clone(), test_url).await {
        Ok(info) => {
            results.push(format!("create_tab=OK id={} url={}", info.id, info.url));
            diag_log(&format!("[DIAG] create_tab OK id={} url={}", info.id, info.url));
            
            // Test 5: check if webview exists
            let label = format!("tab-{}", info.id);
            match app.get_webview(&label) {
                Some(wv) => {
                    let wv_url = wv.url().map(|u| u.to_string()).unwrap_or_default();
                    results.push(format!("webview_exists=OK label={} url={}", label, wv_url));
                    diag_log(&format!("[DIAG] webview_exists OK label={} url={}", label, wv_url));
                    
                    // Test 6: try to navigate
                    diag_log("[DIAG] Testing navigation...");
                    match wv.navigate(Url::parse("https://www.google.com").unwrap()) {
                        Ok(()) => {
                            results.push("navigate=OK".to_string());
                            diag_log("[DIAG] navigate OK");
                        }
                        Err(e) => {
                            results.push(format!("navigate=FAIL: {}", e));
                            diag_log(&format!("[DIAG] navigate FAIL: {}", e));
                        }
                    }
                    
                    // Test 7: try eval
                    diag_log("[DIAG] Testing eval...");
                    match wv.eval("window.__via_diag = 'test_ok'") {
                        Ok(()) => {
                            results.push("eval=OK".to_string());
                            diag_log("[DIAG] eval OK");
                        }
                        Err(e) => {
                            results.push(format!("eval=FAIL: {}", e));
                            diag_log(&format!("[DIAG] eval FAIL: {}", e));
                        }
                    }
                    
                    // Clean up: close test tab
                    let _ = wv.close();
                    state.tabs.lock().unwrap().remove(&info.id);
                    diag_log("[DIAG] test tab cleaned up");
                }
                None => {
                    results.push(format!("webview_exists=FAIL: label '{}' not found", label));
                    diag_log(&format!("[DIAG] webview_exists FAIL: label '{}' not found", label));
                }
            }
        }
        Err(e) => {
            results.push(format!("create_tab=FAIL: {}", e));
            diag_log(&format!("[DIAG] create_tab FAIL: {}", e));
        }
    }
    
    // Test 8: overlay state
    let shell = app.state::<crate::shell::ShellState>();
    let overlay = shell.overlay.lock().unwrap();
    let overlay_ready = *shell.overlay_ready.lock().unwrap();
    results.push(format!("overlay=ready={} label={}", overlay_ready, overlay.as_ref().map(|o| o.label.as_str()).unwrap_or("none")));
    diag_log(&format!("[DIAG] overlay ready={} label={}", overlay_ready, overlay.as_ref().map(|o| o.label.as_str()).unwrap_or("none")));
    drop(overlay);
    
    diag_log("═══ DIAG_TEST_TAB END ═══");
    Ok(results.join("\n"))
}

// ---------- URL normalization ----------



pub fn normalize_url(input: &str) -> String {
    let t = input.trim();
    if t.is_empty() || t == "about:blank" { return "about:blank".to_string(); }
    if t.starts_with("about:") || t.starts_with("data:") || t.starts_with("javascript:") { return t.to_string(); }
    if t.starts_with("http://") || t.starts_with("https://") { return t.to_string(); }
    if t.starts_with("localhost") || is_ip_literal(t) {
        return if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    }
    if t.contains('.') && !t.contains(' ') && !t.starts_with('/') && looks_like_host(t) {
        return format!("https://{t}");
    }
    let q = urlencoding(t);
    format!("https://www.google.com/search?q={q}")
}

fn is_ip_literal(s: &str) -> bool {
    let host = s.trim_start_matches("http://").trim_start_matches("https://");
    let host = host.split('/').next().unwrap_or(host);
    host.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) && host.split('.').count() == 4
}

fn looks_like_host(s: &str) -> bool {
    let host = s.split(['/', ':']).next().unwrap_or(s);
    let mut parts = host.split('.');
    let domain = parts.next_back().unwrap_or("");
    let has_tld = domain.len() >= 2 && domain.chars().all(|c| c.is_ascii_alphabetic());
    let labels_ok = host.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    has_tld && labels_ok && host.split('.').count() >= 2
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1])?;
                let lo = hex_val(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b'+' => { out.push(b' '); i += 1; }
            b => { out.push(b); i += 1; }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn real_filename(url: &Url) -> Option<String> {
    let path = url.path_segments()?;
    let last = path.last()?;
    if last.is_empty() { return None; }
    // Simple percent-decode: replace %XX with the character
    let decoded = last.replace("%20", " ").replace("%2F", "/");
    if decoded.is_empty() || decoded == "/" { return None; }
    Some(decoded)
}

/// Emit an event to the main window (used by overlay WebViews to communicate back)
#[tauri::command]
pub fn emit_to_main(
    app: tauri::AppHandle,
    event: String,
    payload: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit(&event, &payload);
    }
    Ok(())
}

#[tauri::command]
pub fn parse_and_load_url(
    sstate: tauri::State<'_, SettingsState>,
    input: String,
) -> String {
    let engine = sstate.0.lock().unwrap().search_engine.clone();
    parse_address(&input, &engine)
}

fn parse_address(t: &str, search_engine: &str) -> String {
    let t = t.trim();
    if t.is_empty() { return settings::DEFAULT_HOMEPAGE.to_string(); }
    if let Ok(u) = Url::parse(t) {
        if u.scheme().len() > 1 && !matches!(u.scheme(), "about" | "data" | "javascript") {
            return u.to_string();
        }
    }
    if t.starts_with("localhost") || is_ip_literal(t) {
        return if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    }
    if t.contains('.') && !t.contains(' ') && !t.starts_with('/') && looks_like_host(t) {
        return format!("https://{t}");
    }
    let q = urlencoding(t);
    let template = match search_engine {
        "DuckDuckGo" => "https://duckduckgo.com/?q={q}",
        "Baidu" => "https://www.baidu.com/s?wd={q}",
        _ => "https://www.google.com/search?q={q}",
    };
    template.replace("{q}", &q)
}

// ===== Session =====
use std::collections::VecDeque;

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct SessionEntry { pub url: String, pub title: String, pub active: bool, pub order: usize }
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct SessionData { pub entries: Vec<SessionEntry>, pub version: u32 }
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct ClosedTab { pub url: String, pub title: String, pub ts: u64 }
pub struct ClosedTabStack(pub Mutex<VecDeque<ClosedTab>>);
pub struct SessionState(pub Mutex<SessionData>);

fn session_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("via-session.json")
}

pub fn load_session(app: &tauri::AppHandle) -> SessionData {
    let p = session_path(app);
    std::fs::read_to_string(&p).ok().and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default()
}

pub fn persist_session(app: &tauri::AppHandle, s: &SessionData) {
    let p = session_path(app);
    if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
}

#[tauri::command]
pub fn save_session(app: tauri::AppHandle, state: tauri::State<'_, SessionState>, entries: Vec<SessionEntry>) -> Result<(), String> {
    let mut s = state.0.lock().unwrap(); s.entries = entries; s.version = 1; persist_session(&app, &s); Ok(())
}
#[tauri::command]
pub fn restore_session(state: tauri::State<'_, SessionState>) -> Vec<SessionEntry> { state.0.lock().unwrap().entries.clone() }
#[tauri::command]
pub fn clear_session(app: tauri::AppHandle, state: tauri::State<'_, SessionState>) -> Result<(), String> {
    let mut s = state.0.lock().unwrap(); s.entries.clear(); persist_session(&app, &s); Ok(())
}
#[tauri::command]
pub fn push_closed_tab(state: tauri::State<'_, ClosedTabStack>, url: String, title: String) -> Result<(), String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut stack = state.0.lock().unwrap(); stack.push_front(ClosedTab { url, title, ts }); stack.truncate(50); Ok(())
}
#[tauri::command]
pub fn pop_closed_tab(state: tauri::State<'_, ClosedTabStack>) -> Option<ClosedTab> { state.0.lock().unwrap().pop_front() }
#[tauri::command]
pub fn list_closed_tabs(state: tauri::State<'_, ClosedTabStack>) -> Vec<ClosedTab> { state.0.lock().unwrap().iter().cloned().collect() }
