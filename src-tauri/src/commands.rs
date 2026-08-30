use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    webview::DownloadEvent, Emitter, Manager, Url, WebviewBuilder,
};

use crate::adblock;
use crate::init;
use crate::settings::{self, Settings};

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
    pub tabs: Mutex<HashMap<u32, String>>, // tab id -> webview label
    pub next_id: Mutex<u32>,
    pub active: Mutex<Option<u32>>,
    pub blocked: Mutex<u64>,
}

pub struct SettingsState(pub Mutex<Settings>);

/// Height of the HTML bottom navigation bar — must match CSS `--nav-h`.
/// The native webview is positioned at the very top (y=0) with a height that
/// never includes the bottom bar area, so the nav bar always stays visible.
pub const NAV_HEIGHT: f64 = 60.0; // must match CSS --nav-h

/// File extensions that WebView2 hands off to the download engine instead of
/// rendering. Never let the adblock navigation hook veto these: a "blocked"
/// navigation to a direct file URL silently kills the download before
/// `on_download` ever sees it.
const DOWNLOAD_EXTS: &[&str] = &[
    "apk", "xapk", "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "img",
    "exe", "msi", "msix", "deb", "rpm", "dmg", "pkg", "torrent",
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "3gp",
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "epub", "mobi",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "raw",
];

fn is_download_eligible(url: &Url) -> bool {
    if matches!(url.scheme(), "blob" | "data") {
        return true;
    }
    // A URL that is missing a host (e.g. a browser-internal scheme) can never
    // be an ad target; don't risk blocking a download initiated from one.
    if url.host_str().is_none() {
        return true;
    }
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

/// Compute the target bounds for every tab webview in *logical* pixels.
///
/// The HTML bottom nav bar is 60 CSS px tall, which is already a logical
/// unit: on high-DPI Windows the runtime converts logical -> physical via the
/// window's scale factor, so subtracting 60 here is DPI-correct (no gap, no
/// overlap). Returns `None` only when the window is transiently unavailable
/// (e.g. during fullscreen transition or teardown) so resize is skipped.
fn tab_bounds(app: &tauri::AppHandle) -> Option<tauri::Rect> {
    let wvwin = app.get_webview_window("main")?;
    let physical = wvwin.inner_size().ok()?;
    if physical.width == 0 || physical.height == 0 {
        return None;
    }
    let scale = wvwin.scale_factor().unwrap_or(1.0);
    let width = physical.width as f64 / scale;
    let height = physical.height as f64 / scale;
    // In fullscreen the OS bottom nav bar is hidden, so the webview may fill
    // the whole window. Otherwise it must stop above the HTML bottom bar.
    let h = if wvwin.is_fullscreen().unwrap_or(false) {
        height
    } else {
        (height - NAV_HEIGHT).max(320.0)
    };
    Some(tauri::Rect {
        position: tauri::LogicalPosition::new(0.0, 0.0).into(),
        size: tauri::LogicalSize::new(width, h).into(),
    })
}

/// Reposition/resize every tab webview after the window is resized or its
/// scale factor changes (incl. fullscreen toggles). Safely no-ops if the
/// window or a webview is unavailable. Uses the atomic `set_bounds` so a tab
/// webview can never end up with a stale width/height racing a move.
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
    {
        let mut s = state.0.lock().unwrap();
        *s = settings.clone();
    }
    persist_settings(&app, &settings);
    Ok(())
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    if let Ok(dir) = app.path().app_config_dir() {
        let p = dir.join("via-settings.json");
        if let Ok(data) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str(&data) {
                return s;
            }
        }
    }
    Settings::default()
}

pub fn persist_settings(app: &tauri::AppHandle, s: &Settings) {
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

// ---------- adblock ----------

#[tauri::command]
pub fn block_url(url: String) -> Option<adblock::BlockResult> {
    adblock::load_default_filters().block(&url)
}

#[tauri::command]
pub fn get_filters_css(url: String) -> String {
    adblock::load_default_filters().cosmetic_css(&url)
}

#[tauri::command]
pub fn blocked_total(state: tauri::State<'_, BrowserState>) -> u64 {
    *state.blocked.lock().unwrap()
}

// ---------- search suggestions ----------

#[tauri::command]
pub fn search_suggest(query: String, engine: String) -> Result<Vec<SuggestItem>, String> {
    let url = engine_url(&engine, &query)?;
    let body = fetch_text(&url)?;
    Ok(parse_suggest(&body).into_iter().take(10).collect())
}

fn engine_url(engine: &str, query: &str) -> Result<Url, String> {
    let q = urlencoding(query.trim());
    let template = match engine {
        "DuckDuckGo" => "https://duckduckgo.com/ac/?q={q}&type=list",
        "Baidu" => "https://suggestion.baidu.com/su?wd={q}",
        _ => "https://suggestqueries.google.com/complete/search?client=firefox&q={q}",
    };
    Url::parse(&template.replace("{q}", &q)).map_err(|e| e.to_string())
}

fn parse_suggest(body: &str) -> Vec<SuggestItem> {
    let mut items = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return items;
    };
    if let Some(arr) = v.as_array() {
        if let Some(sugs) = arr.get(1).and_then(|x| x.as_array()) {
            for s in sugs {
                if let Some(s) = s.as_str() {
                    items.push(SuggestItem { label: s.to_string(), url: s.to_string() });
                }
            }
        } else {
            for s in arr {
                if let Some(phrase) = s.get("phrase").and_then(|p| p.as_str()) {
                    items.push(SuggestItem { label: phrase.to_string(), url: phrase.to_string() });
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
        .arg("-s")
        .arg("--max-time")
        .arg("8")
        .arg("-A")
        .arg("ViaBrowser/7.2.1")
        .arg(url.as_str())
        .output()
        .map_err(|e| e.to_string())?;
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
    let window = main_window(&app)?;
    let s = sstate.0.lock().unwrap().clone();

    let mut idx = state.next_id.lock().unwrap();
    *idx += 1;
    let id = *idx;
    let label = format!("tab-{id}");
    // Tabs start at about:blank. The local HTML homepage is shown until the
    // user types a query/URL — we never auto-navigate to an external site.
    let target = url.unwrap_or_else(|| "about:blank".to_string());
    let parsed = Url::parse(&normalize_url(&target)).map_err(|e| e.to_string())?;
    let bounds = tab_bounds(&app).ok_or_else(|| "window unavailable".to_string())?;

    let nav_settings = s.clone(); // captured by on_navigation (site overrides)
    let dl_label = label.clone();
    // auto_resize keeps every child webview filling the window natively on
    // resize (Tauri's runtime re-applies proportional bounds on each window
    // resize); relayout_tabs() then corrects the fixed 60px nav offset.
    let mut builder = WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(parsed.clone()))
        .auto_resize()
        .initialization_script(init::build(&s))
        .on_download(move |wv, event| {
            let wv_app = wv.app_handle();
            let win = wv_app.get_webview_window("main");
            let id = wv_app
                .state::<BrowserState>()
                .tabs
                .lock()
                .unwrap()
                .iter()
                .find_map(|(i, l)| if *l == dl_label { Some(*i) } else { None });
            match event {
                DownloadEvent::Requested { url, destination } => {
                    println!("[via] DOWNLOAD REQUESTED: {:?}", url.to_string());
                    // Prefer the OS Downloads folder; never leave `destination`
                    // unset — wry only forwards a valid absolute path when we
                    // assign one here, otherwise the transfer is silently dropped.
                    let dir = wv_app
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| std::env::temp_dir());
                    let _ = std::fs::create_dir_all(&dir);
                    // Decode the real filename; fall back to a ?filename= /
                    // ?file= / ?name= query param, then a timestamped name.
                    let fname = url
                        .path_segments()
                        .and_then(|segs| segs.last())
                        .filter(|f| !f.is_empty())
                        .and_then(|f| percent_decode(f))
                        .filter(|f| !f.is_empty() && f.len() < 128)
                        .or_else(|| {
                            url.query_pairs().find_map(|(k, v)| {
                                matches!(k.as_ref(), "filename" | "file" | "name" | "download")
                                    .then(|| v.to_string())
                                    .filter(|f| !f.is_empty() && f.len() < 128)
                            })
                        })
                        .unwrap_or_else(|| {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            format!("download-{ts}")
                        });
                    let dest = dir.join(&fname);
                    // If a file with that name exists, avoid clobbering.
                    let dest = if dest.exists() {
                        let stem = dest.file_stem().and_then(|f| f.to_str()).unwrap_or("download");
                        let ext = dest.extension().and_then(|e| e.to_str()).unwrap_or("");
                        let mut n = 1;
                        let mut candidate = dir.join(format!("{stem} ({n}).{ext}"));
                        while candidate.exists() && n < 1000 {
                            n += 1;
                            candidate = dir.join(format!("{stem} ({n}).{ext}"));
                        }
                        candidate
                    } else {
                        dest
                    };
                    *destination = dest.clone();
                    println!("[via]   -> authorizing download to {}", dest.display());
                    if let Some(win) = &win {
                        let _ = win.emit("download-started", serde_json::json!({
                            "id": id, "url": url.to_string(), "path": dest.to_string_lossy(),
                        }));
                        let _ = win.emit("download-progress", serde_json::json!({
                            "id": id, "url": url.to_string(), "path": dest.to_string_lossy(), "received": 0, "total": 0, "done": false,
                        }));
                    }
                }
                DownloadEvent::Finished { url, path, success } => {
                    println!("[via] DOWNLOAD FINISHED: {:?} success={}", url.to_string(), success);
                    if success {
                        if let Some(p) = &path {
                            let store = wv_app.state::<crate::features::StoreState>();
                            crate::features::record_download(&wv_app, &store, url.to_string(), p.clone());
                        }
                    }
                    if let Some(win) = &win {
                        let _ = win.emit("download-progress", serde_json::json!({
                            "id": id, "url": url.to_string(),
                            "path": path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                            "received": 0, "total": 0, "done": true, "success": success,
                        }));
                    }
                }
                _ => {}
            }
            // Let the download proceed.
            true
        })
        .on_page_load(move |wv, payload| {
            let wv_app = wv.app_handle();
            let label = wv.label().to_string();
            let url = payload.url().to_string();
            let tabs = wv_app.state::<BrowserState>();
            let id = tabs.tabs.lock().unwrap().iter().find_map(|(i, l)| if *l == label { Some(*i) } else { None });
            if let Some(id) = id {
                if let Some(win) = wv_app.get_webview_window("main") {
                    let _ = win.emit(
                        "tab-url",
                        serde_json::json!({ "id": id, "url": url }),
                    );
                }
            }
            let _ = wv_app;
        })
        .on_document_title_changed(move |wv, title| {
            let wv_app = wv.app_handle();
            let label = wv.label().to_string();
            let tabs = wv_app.state::<BrowserState>();
            let id = tabs.tabs.lock().unwrap().iter().find_map(|(i, l)| if *l == label { Some(*i) } else { None });
            if let Some(id) = id {
                if let Some(win) = wv_app.get_webview_window("main") {
                    // Secure page->host bridge: "VIA:" + URI-encoded JSON [action, data].
                    if let Some(rest) = title.strip_prefix("VIA:") {
                        if let Some(decoded) = percent_decode(rest) {
                            let _ = win.emit(
                                "via-msg",
                                serde_json::json!({ "id": id, "msg": decoded }),
                            );
                        }
                        return;
                    }
                    let _ = win.emit("tab-title", serde_json::json!({ "id": id, "title": title }));
                }
            }
        })
        .on_navigation(move |url| {
            println!("[via] NAVIGATING TO: {url}");
            // Direct file URLs (and blob:/data: schemes) are downloads, not
            // pages. Adblock must never veto them or the file transfer is
            // canceled before the download engine even starts.
            if is_download_eligible(&url) {
                println!("[via]   -> download-eligible URL, navigation allowed");
                return true;
            }
            // Main-frame adblock: block navigation to blocked hosts.
            // Honours the default toggle and per-site ("Site configuration") overrides.
            let host = url.host_str().unwrap_or("").to_lowercase();
            let mut adblock = nav_settings.adblock_enabled;
            for site in &nav_settings.sites {
                if host == site.host || host.ends_with(&format!(".{}", site.host)) {
                    adblock = site.adblock_enabled;
                    break;
                }
            }
            if adblock && adblock::load_default_filters().block(url.as_str()).is_some() {
                return false;
            }
            true
        })
        .on_new_window(move |url, _features| {
            // Websites open download links (and many pages) with
            // `target="_blank"`. WebView2 turns that into a new-window request.
            // Letting WebView2 read the HTTP headers is the CORRECT way to tell
            // a real download (Content-Disposition: attachment) from a page:
            // no extension guessing. So we navigate the ACTIVE tab here and deny
            // the native OS window. If it's a file, WebView2 cancels the visual
            // navigation and fires on_download (which saves + emits progress).
            // If it's a real page, it just loads in the active tab.
            let active = app.state::<BrowserState>().active.lock().unwrap().clone();
            let label = active
                .and_then(|id| app.state::<BrowserState>().tabs.lock().unwrap().get(&id).cloned());
            let nav_url = url.clone();
            match label {
                Some(label) => {
                    if let Some(wv) = app.get_webview(&label) {
                        println!("[via] target=_blank -> active tab: {nav_url}");
                        let _ = wv.navigate(nav_url);
                    }
                }
                None => {
                    // No active tab yet: surface to the frontend, which creates one.
                    let _ = app
                        .get_webview_window("main")
                        .map(|win| win.emit("new-window-request", serde_json::json!({ "url": nav_url.to_string() })));
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });

    if let Some(ua) = settings::resolve_ua(&s) {
        builder = builder.user_agent(&ua);
    }

    let webview = window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|e| e.to_string())?;
    // Start hidden: the pure-black local homepage is shown until the user
    // navigates somewhere (the frontend calls show_tab on navigation).
    webview.hide().ok();

    {
        let mut tabs = state.tabs.lock().unwrap();
        tabs.insert(id, label.clone());
    }
    *state.active.lock().unwrap() = Some(id);

    Ok(TabInfo {
        id,
        url: target,
        title: String::new(),
        loading: false,
        active: true,
    })
}

#[tauri::command]
pub fn close_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<(), String> {
    let label = state.tabs.lock().unwrap().remove(&id);
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            if app.state::<SettingsState>().0.lock().unwrap().clear_on_exit {
                let _ = wv.clear_all_browsing_data();
            }
            let _ = wv.close();
        }
    }
    if *state.active.lock().unwrap() == Some(id) {
        *state.active.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
pub fn navigate_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
    url: String,
) -> Result<(), String> {
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let parsed = Url::parse(&normalize_url(&url)).map_err(|e| e.to_string())?;
            wv.navigate(parsed).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn select_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    id: u32,
) -> Result<TabInfo, String> {
    let label = state.tabs.lock().unwrap().get(&id).cloned();
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.show();
            let _ = wv.set_focus();
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            for (_, other) in state.tabs.lock().unwrap().iter() {
                if other != &label {
                    if let Some(o) = app.get_webview(other) {
                        let _ = o.hide();
                    }
                }
            }
            *state.active.lock().unwrap() = Some(id);
            return Ok(TabInfo { id, url, title: String::new(), loading: false, active: true });
        }
    }
    Err("tab not found".into())
}

#[tauri::command]
pub fn hide_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("tab-{id}");
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn show_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("tab-{id}");
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.show();
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
        if let Some(wv) = app.get_webview(&l) {
            let _ = wv.clear_all_browsing_data();
        }
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
        r#"var s=document.createElement('style');s.id='via-night';s.textContent='html{filter:invert(1) hue-rotate(180deg) brightness(.92) contrast(.9)}img,video,canvas,iframe,svg,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}';document.documentElement.appendChild(s);"#
    } else {
        r#"var s=document.getElementById('via-night');if(s)s.remove();"#
    };
    for l in labels {
        if let Some(wv) = app.get_webview(&l) {
            let _ = wv.eval(js.to_string());
        }
    }
    Ok(())
}

pub fn normalize_url(input: &str) -> String {
    let t = input.trim();
    if t.is_empty() {
        return settings::DEFAULT_HOMEPAGE.to_string();
    }
    if t.contains('.') && !t.contains(' ') {
        if t.starts_with("http://") || t.starts_with("https://") {
            return t.to_string();
        }
        return format!("https://{}", t);
    }
    let q = urlencoding(t);
    format!("https://www.google.com/search?q={q}")
}

/// Minimal percent-decoder ("%XX" -> byte), returning None on malformed input.
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

/// Central URL/search router (Via-style). Decides whether `input` is a URL or
/// a search query and returns the fully-qualified URL to load. Mirrors Via's
/// address-bar handling: explicit schemes pass through, a bare domain-ish
/// string gets https://, everything else becomes a search on the active engine.
pub fn parse_address(input: &str, search_engine: &str) -> String {
    let t = input.trim();
    if t.is_empty() {
        return settings::DEFAULT_HOMEPAGE.to_string();
    }
    if let Ok(u) = Url::parse(t) {
        if u.scheme().len() > 1 && !matches!(u.scheme(), "about" | "data" | "javascript") {
            return u.to_string();
        }
    }
    // localhost / IP literals are URLs
    if t.starts_with("localhost") || is_ip_literal(t) {
        return if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    }
    // domain-like: contains a dot + a TLD-ish tail, no spaces
    let no_scheme = t;
    if no_scheme.contains('.')
        && !no_scheme.contains(' ')
        && !no_scheme.starts_with('/')
        && looks_like_host(no_scheme)
    {
        return format!("https://{no_scheme}");
    }
    // otherwise: search
    let q = urlencoding(no_scheme);
    let template = match search_engine {
        "DuckDuckGo" => "https://duckduckgo.com/?q={q}",
        "Baidu" => "https://www.baidu.com/s?wd={q}",
        _ => "https://www.google.com/search?q={q}",
    };
    template.replace("{q}", &q)
}

fn is_ip_literal(s: &str) -> bool {
    let host = s.trim_start_matches("http://").trim_start_matches("https://");
    let host = host.split('/').next().unwrap_or(host);
    host.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) && host.split('.').count() == 4
}

fn looks_like_host(s: &str) -> bool {
    // 'example.com', 'www.example.com/path', 'sub.example.co.uk:8080'
    let host = s.split(['/', ':']).next().unwrap_or(s);
    let mut parts = host.split('.');
    let domain = parts.next_back().unwrap_or("");
    let has_tld = domain.len() >= 2 && domain.chars().all(|c| c.is_ascii_alphabetic());
    let labels_ok = host.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    has_tld && labels_ok && host.split('.').count() >= 2
}

#[tauri::command]
pub fn parse_and_load_url(
    sstate: tauri::State<'_, SettingsState>,
    input: String,
) -> String {
    let engine = sstate.0.lock().unwrap().search_engine.clone();
    parse_address(&input, &engine)
}
