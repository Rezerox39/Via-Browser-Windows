mod adblock;
mod commands;
mod features;
mod init;
mod reader;
mod settings;

use std::sync::Mutex;
use tauri::{Manager, WindowEvent};

use commands::{BrowserState, SettingsState};
use features::StoreState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle();
            let loaded = commands::load_settings(&handle);
            if let Ok(dir) = handle.path().app_config_dir() {
                adblock::load_user_filters(&dir);
            }
            handle.manage(SettingsState(Mutex::new(loaded)));
            handle.manage(StoreState(Mutex::new(features::load_store(&handle))));

            // Keep every tab webview above the HTML bottom nav bar when the
            // window is resized (native webviews don't follow CSS layout).
            if let Some(win) = app.get_webview_window("main") {
                let handle = handle.clone();
                win.on_window_event(move |event| {
                    // Resize + HiDPI scale changes + fullscreen toggles all
                    // require re-calculating the child webview bounds. The
                    // handler is safe no-ops when the window is transitioning.
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
            reader::reader_bundle,
            reader::reader_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running via browser");
}
