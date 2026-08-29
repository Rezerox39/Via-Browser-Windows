use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder};

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
pub const NAV_HEIGHT: f64 = 56.0;

fn main_window(app: &tauri::AppHandle) -> Result<tauri::Window, String> {
    app.get_window("main").ok_or_else(|| "main window not found".to_string())
}

fn tab_bounds(app: &tauri::AppHandle) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let wvwin = app.get_webview_window("main").unwrap();
    let size = wvwin.inner_size().ok().unwrap_or(tauri::PhysicalSize::new(1280, 800));
    let width = size.width.max(640) as f64;
    let height = (size.height.saturating_sub(NAV_HEIGHT as u32) as f64).max(320.0);
    // y=0: the webview fills from the very top down to the bottom nav bar.
    (LogicalPosition::new(0.0, 0.0), LogicalSize::new(width, height))
}

/// Reposition/resize every tab webview after the window is resized.
pub fn relayout_tabs(app: &tauri::AppHandle) {
    let state = app.state::<BrowserState>();
    let labels: Vec<String> = state.tabs.lock().unwrap().values().cloned().collect();
    let (_, size) = tab_bounds(app);
    for l in labels {
        if let Some(wv) = app.get_webview(&l) {
            let _ = wv.set_size(size);
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

fn persist_settings(app: &tauri::AppHandle, s: &Settings) {
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
        "Bing" => "https://api.bing.com/osjson.aspx?query={q}",
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
    let (pos, size) = tab_bounds(&app);

    let mut builder = WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(parsed.clone()))
        .initialization_script(init::build(&s))
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
                    let _ = win.emit("tab-title", serde_json::json!({ "id": id, "title": title }));
                }
            }
        })
        .on_navigation(move |url| {
            // Main-frame adblock: block navigation to blocked hosts.
            if s.adblock_enabled {
                if adblock::load_default_filters().block(url.as_str()).is_some() {
                    return false;
                }
            }
            true
        });

    if let Some(ua) = settings::resolve_ua(&s) {
        builder = builder.user_agent(&ua);
    }

    let webview = window
        .add_child(builder, pos, size)
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
    format!("https://www.bing.com/search?q={q}")
}
