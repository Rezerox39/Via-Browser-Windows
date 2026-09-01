mod adblock;
mod commands;
mod features;
mod init;
mod native;
mod reader;
pub mod runtime;
mod settings;

use std::sync::Mutex;
use tauri::{Manager, WindowEvent};

use commands::{BrowserState, ClosedTabStack, SessionState, SettingsState};
use features::StoreState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            let loaded = commands::load_settings(&handle);
            if let Ok(dir) = handle.path().app_config_dir() {
                adblock::load_user_filters(&dir);
            }
            handle.manage(SettingsState(Mutex::new(loaded)));
            handle.manage(StoreState(Mutex::new(features::load_store(&handle))));
            let session = commands::load_session(&handle);
            handle.manage(SessionState(Mutex::new(session)));
            handle.manage(ClosedTabStack(Mutex::new(std::collections::VecDeque::new())));

            if let Some(win) = app.get_webview_window("main") {
                let handle = handle.clone();
                win.on_window_event(move |event| {
                    match event {
                        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                            commands::relayout_tabs(&handle);
                        }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .manage(BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            // tabs & navigation
            commands::create_tab,
            commands::close_tab,
            commands::show_tab,
            commands::hide_tab,
            commands::select_tab,
            commands::navigate_tab,
            commands::eval_tab,
            commands::get_tab_url,
            commands::list_tabs,
            // settings & browser
            commands::get_settings,
            commands::set_settings,
            commands::user_agent_for,
            commands::block_url,
            commands::get_filters_css,
            commands::blocked_total,
            commands::clear_data,
            commands::set_night_mode,
            commands::search_suggest,
            commands::parse_and_load_url,
            // session
            commands::save_session,
            commands::restore_session,
            commands::clear_session,
            commands::push_closed_tab,
            commands::pop_closed_tab,
            commands::list_closed_tabs,
            // features
            features::add_bookmark,
            features::remove_bookmark,
            features::list_bookmarks,
            features::is_bookmarked,
            features::add_history,
            features::list_history,
            features::clear_history,
            features::list_downloads,
            features::save_page,
            features::download_from_js,
            features::save_blob_download,
            features::get_cookies,
            features::clear_cookies,
            features::list_scripts,
            features::save_script,
            features::delete_script,
            features::list_site_configs,
            features::save_site_config,
            features::delete_site_config,
            features::network_log,
            features::mark_as_ad,
            features::remove_marked_ad,
            features::list_marked_ads,
            features::all_cosmetic_rules,
            features::open_external,
            features::file_size,
            features::open_download,
            features::reveal_download,
            features::export_backup,
            features::import_backup,
            features::import_latest_backup,
            features::list_homepage_shortcuts,
            features::save_homepage_shortcuts,
            // reader
            reader::reader_bundle,
            reader::reader_close,
            // native: QR + passwords
            qr_scan_image,
            qr_scan_clipboard,
            qr_pick_and_scan,
            save_password,
            get_password,
            delete_password,
            password_save_supported,
        ])
        .run(tauri::generate_context!())
        .expect("error while running via browser");
}

/* ─── Native Tauri commands ─── */

#[tauri::command]
fn qr_scan_image(path: String) -> Result<String, String> {
    native::decode_image_file(&path)
}

#[tauri::command]
fn qr_scan_clipboard() -> Result<String, String> {
    native::decode_clipboard()
}

#[tauri::command]
fn qr_pick_and_scan() -> Result<String, String> {
    let (text, _path) = native::pick_and_decode_image()?;
    Ok(text)
}

#[tauri::command]
fn save_password(service: String, username: String, password: String) -> Result<(), String> {
    native::save_credential(&service, &username, &password)
}

#[tauri::command]
fn get_password(service: String, username: String) -> Result<Option<String>, String> {
    native::get_credential(&service, &username)
}

#[tauri::command]
fn delete_password(service: String, username: String) -> Result<bool, String> {
    native::delete_credential(&service, &username)
}

/// Report whether password storage is supported on this platform.
#[tauri::command]
fn password_save_supported() -> bool {
    // keyring crate works on Windows (Credential Manager) and Linux (secret-service).
    // On macOS it uses Keychain. If it fails at runtime, save_password returns Err.
    cfg!(any(target_os = "windows", target_os = "linux", target_os = "macos"))
}
