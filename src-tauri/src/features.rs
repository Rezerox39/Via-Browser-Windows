use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::process::Command;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use crate::adblock;
use crate::settings::{SiteConfig, UserScript};

/// Simple persistent JSON stores for bookmarks / history / downloads.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Store {
    pub bookmarks: Vec<Bm>,
    pub history: VecDeque<Hist>,
    pub downloads: Vec<Download>,
}

impl Default for Store {
    fn default() -> Self {
        Self { bookmarks: Vec::new(), history: VecDeque::new(), downloads: Vec::new() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bm {
    pub url: String,
    pub title: String,
    pub folder: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hist {
    pub url: String,
    pub title: String,
    pub ts: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Download {
    pub url: String,
    pub path: String,
    pub title: String,
    pub size: u64,
    pub done: bool,
}

pub struct StoreState(pub Mutex<Store>);

fn store_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("via-store.json")
}

pub fn load_store(app: &tauri::AppHandle) -> Store {
    let p = store_path(app);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_default()
}

fn persist(app: &tauri::AppHandle, s: &Store) {
    let p = store_path(app);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
}

fn app_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok()
}

// ---------- bookmarks ----------

#[tauri::command]
pub fn add_bookmark(app: tauri::AppHandle, state: tauri::State<'_, StoreState>, url: String, title: String, folder: Option<String>) -> Result<(), String> {
    let mut s = state.0.lock().unwrap();
    if s.bookmarks.iter().any(|b| b.url == url) {
        return Err("already exists".into());
    }
    s.bookmarks.push(Bm { url, title, folder: folder.unwrap_or_default() });
    persist(&app, &s);
    Ok(())
}

#[tauri::command]
pub fn remove_bookmark(app: tauri::AppHandle, state: tauri::State<'_, StoreState>, url: String) -> Result<(), String> {
    let mut s = state.0.lock().unwrap();
    s.bookmarks.retain(|b| b.url != url);
    persist(&app, &s);
    Ok(())
}

#[tauri::command]
pub fn list_bookmarks(state: tauri::State<'_, StoreState>) -> Vec<Bm> {
    state.0.lock().unwrap().bookmarks.clone()
}

#[tauri::command]
pub fn is_bookmarked(state: tauri::State<'_, StoreState>, url: String) -> bool {
    state.0.lock().unwrap().bookmarks.iter().any(|b| b.url == url)
}

// ---------- history ----------

#[tauri::command]
pub fn add_history(app: tauri::AppHandle, state: tauri::State<'_, StoreState>, url: String, title: String) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if s.history.front().map(|h| h.url.as_str()) != Some(url.as_str()) {
            s.history.push_front(Hist { url, title, ts });
            s.history.truncate(2000);
        }
    }
    {
        let s = state.0.lock().unwrap();
        persist(&app, &s);
    }
    Ok(())
}

#[tauri::command]
pub fn list_history(state: tauri::State<'_, StoreState>, q: Option<String>) -> Vec<Hist> {
    let s = state.0.lock().unwrap();
    match q {
        Some(qe) if !qe.is_empty() => s.history.iter().filter(|h| h.url.contains(&qe) || h.title.to_lowercase().contains(&qe.to_lowercase())).cloned().collect(),
        _ => s.history.iter().cloned().collect(),
    }
}

#[tauri::command]
pub fn clear_history(app: tauri::AppHandle, state: tauri::State<'_, StoreState>) -> Result<(), String> {
    state.0.lock().unwrap().history.clear();
    let s = state.0.lock().unwrap();
    persist(&app, &s);
    Ok(())
}

// ---------- downloads / save page ----------

#[tauri::command]
pub fn list_downloads(state: tauri::State<'_, StoreState>) -> Vec<Download> {
    state.0.lock().unwrap().downloads.clone()
}

#[tauri::command]
pub fn save_page(app: tauri::AppHandle, state: tauri::State<'_, StoreState>, url: String, html: String, title: String) -> Result<String, String> {
    let download_dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&download_dir);
    let safe = sanitize(&title);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = if safe.is_empty() { format!("page-{ts}.html") } else { format!("{safe}.html") };
    let path = download_dir.join(&name);
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    {
        let mut s = state.0.lock().unwrap();
        s.downloads.push(Download {
            url,
            path: path.to_string_lossy().into_owned(),
            title: name.clone(),
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            done: true,
        });
        persist(&app, &s);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Download a URL straight to the OS Downloads folder. Used by the in-page
/// download-link capture (HTML5 `download` attrs, blob/data URLs, file links)
/// as a reliable fallback when WebView2's native DownloadStarting doesn't fire.
#[tauri::command]
pub fn download_from_js(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    url: String,
    filename: Option<String>,
) -> Result<String, String> {
    let download_dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&download_dir);

    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let fname = filename
        .filter(|f| !f.trim().is_empty() && f.len() < 128)
        .map(|f| sanitize(&f))
        .filter(|f| !f.is_empty())
        .or_else(|| {
            parsed
                .path_segments()
                .and_then(|segs| segs.last())
                .filter(|f| !f.is_empty())
                .map(|f| sanitize(f))
                .filter(|f| !f.is_empty())
        })
        .unwrap_or_else(|| {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("download-{ts}")
        });

    let dest = download_dir.join(&fname);
    let _ = std::fs::remove_file(&dest); // fresh copy; no clobber logic needed for fallback

    let win = app.get_webview_window("main");
    if let Some(win) = &win {
        let _ = win.emit("download-started", serde_json::json!({
            "id": null, "url": url, "path": dest.to_string_lossy(),
        }));
    }

    println!("[via] JS download: {url} -> {}", dest.display());
    let out = Command::new(if cfg!(target_os = "windows") { "curl.exe" } else { "curl" })
        .arg("-sS")
        .arg("--max-time")
        .arg("600")
        .arg("--fail")
        .arg("-A")
        .arg("ViaBrowser/7.2.1")
        .arg("-L")
        .arg("-o")
        .arg(&dest)
        .arg(&url)
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let _ = std::fs::remove_file(&dest);
        if let Some(win) = &win {
            let _ = win.emit("download-progress", serde_json::json!({
                "id": null, "url": url, "path": dest.to_string_lossy(),
                "received": 0, "total": 0, "done": true, "success": false,
            }));
        }
        return Err(format!(
            "download failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    {
        let mut s = state.0.lock().unwrap();
        s.downloads.push(Download {
            url: url.clone(),
            path: dest.to_string_lossy().into_owned(),
            title: fname.clone(),
            size,
            done: true,
        });
        persist(&app, &s);
    }
    if let Some(win) = &win {
        let _ = win.emit("download-progress", serde_json::json!({
            "id": null, "url": url, "path": dest.to_string_lossy(),
            "received": size, "total": size, "done": true, "success": true,
        }));
    }
    Ok(dest.to_string_lossy().into_owned())
}

fn sanitize(s: &str) -> String {
    let bad = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let mut out: String = s.chars().filter(|c| !bad.contains(c)).collect();
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}

// ---------- browser data / cookies ----------

fn tab_labels(app: &tauri::AppHandle) -> Vec<String> {
    app.state::<crate::commands::BrowserState>()
        .tabs
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub fn get_cookies(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for label in tab_labels(&app) {
        if let Some(wv) = app.get_webview(&label) {
            if let Ok(cs) = wv.cookies() {
                for c in cs {
                    out.push(serde_json::json!({
                        "name": c.name(),
                        "value": c.value(),
                        "domain": c.domain(),
                        "path": c.path(),
                        "expires": c.expires().is_some(),
                    }));
                }
            }
        }
    }
    out
}

#[tauri::command]
pub fn clear_cookies(app: tauri::AppHandle) -> Result<(), String> {
    for label in tab_labels(&app) {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.clear_all_browsing_data();
        }
    }
    Ok(())
}

// ---------- user scripts ----------

#[tauri::command]
pub fn list_scripts(state: tauri::State<'_, crate::commands::SettingsState>) -> Vec<UserScript> {
    state.0.lock().unwrap().scripts.clone()
}

#[tauri::command]
pub fn save_script(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::SettingsState>,
    script: UserScript,
) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        if let Some(existing) = s.scripts.iter_mut().find(|x| x.id == script.id) {
            *existing = script;
        } else {
            s.scripts.push(script);
        }
    }
    let settings = state.0.lock().unwrap().clone();
    crate::commands::persist_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
pub fn delete_script(app: tauri::AppHandle, state: tauri::State<'_, crate::commands::SettingsState>, id: String) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        s.scripts.retain(|x| x.id != id);
    }
    let settings = state.0.lock().unwrap().clone();
    crate::commands::persist_settings(&app, &settings);
    Ok(())
}

// ---------- site configuration ----------

#[tauri::command]
pub fn list_site_configs(state: tauri::State<'_, crate::commands::SettingsState>) -> Vec<SiteConfig> {
    state.0.lock().unwrap().sites.clone()
}

#[tauri::command]
pub fn save_site_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::SettingsState>,
    cfg: SiteConfig,
) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        if let Some(existing) = s.sites.iter_mut().find(|x| x.host == cfg.host) {
            *existing = cfg;
        } else {
            s.sites.push(cfg);
        }
    }
    let settings = state.0.lock().unwrap().clone();
    crate::commands::persist_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
pub fn delete_site_config(app: tauri::AppHandle, state: tauri::State<'_, crate::commands::SettingsState>, host: String) -> Result<(), String> {
    {
        let mut s = state.0.lock().unwrap();
        s.sites.retain(|x| x.host != host);
    }
    let settings = state.0.lock().unwrap().clone();
    crate::commands::persist_settings(&app, &settings);
    Ok(())
}

// ---------- network log ----------

#[tauri::command]
pub fn network_log(state: tauri::State<'_, crate::commands::SettingsState>, rows: Vec<Vec<String>>, clear: bool) -> Vec<Vec<String>> {
    let mut s = state.0.lock().unwrap();
    if clear {
        s.pages_log.clear();
    } else if !rows.is_empty() {
        s.pages_log.extend(rows);
        s.pages_log.truncate(5000);
    }
    s.pages_log.clone()
}

// ---------- mark as ad ----------

#[tauri::command]
pub fn mark_as_ad(app: tauri::AppHandle, domain: String, selector: String) -> Result<(), String> {
    let dir = app_dir(&app);
    adblock::set_user_filter(dir.as_deref(), Some(&domain), &selector);
    Ok(())
}

#[tauri::command]
pub fn remove_marked_ad(app: tauri::AppHandle, index: usize) -> Result<(), String> {
    let dir = app_dir(&app);
    adblock::remove_user_filter(dir.as_deref(), index);
    Ok(())
}

#[tauri::command]
pub fn list_marked_ads() -> Vec<String> {
    adblock::user_filter_rules()
}

#[tauri::command]
pub fn all_cosmetic_rules() -> String {
    adblock::all_cosmetic_rules_json()
}

#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_size(path: String) -> u64 {
    std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
pub fn open_download(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_download(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    sstate: tauri::State<'_, crate::commands::SettingsState>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("via-backup-{ts}.via"));
    let store = store.0.lock().unwrap().clone();
    let settings = sstate.0.lock().unwrap().clone();
    let payload = serde_json::json!({
        "app": "via-browser-win",
        "version": "7.2.1",
        "store": store,
        "settings": settings,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn import_backup(
    app: tauri::AppHandle,
    path: String,
    store: tauri::State<'_, StoreState>,
    sstate: tauri::State<'_, crate::commands::SettingsState>,
) -> Result<(), String> {
    import_via(&app, &path, &store, &sstate)
}

#[tauri::command]
pub fn import_latest_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    sstate: tauri::State<'_, crate::commands::SettingsState>,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let mut candidates: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "via").unwrap_or(false))
        .collect();
    candidates.sort_by_key(|e| std::fs::metadata(e.path()).and_then(|m| m.modified()).ok());
    let newest = candidates.last().ok_or_else(|| "no backup".to_string())?;
    import_via(&app, &newest.path().to_string_lossy(), &store, &sstate)
}

fn import_via(
    app: &tauri::AppHandle,
    path: &str,
    store: &tauri::State<'_, StoreState>,
    sstate: &tauri::State<'_, crate::commands::SettingsState>,
) -> Result<(), String> {
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    if let Some(st) = v.get("store") {
        if let Ok(st) = serde_json::from_value::<Store>(st.clone()) {
            *store.0.lock().unwrap() = st;
        }
    }
    if let Some(se) = v.get("settings") {
        if let Ok(se) = serde_json::from_value::<crate::settings::Settings>(se.clone()) {
            *sstate.0.lock().unwrap() = se;
        }
    }
    crate::commands::persist_settings(app, &sstate.0.lock().unwrap());
    {
        let s = store.0.lock().unwrap();
        persist(app, &s);
    }
    Ok(())
}
