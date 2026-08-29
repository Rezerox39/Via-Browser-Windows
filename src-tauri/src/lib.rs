mod adblock;
mod commands;
mod init;
mod settings;

use commands::{BrowserState, SettingsState};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle();
            let loaded = commands::load_settings(&handle);
            handle.manage(SettingsState(Mutex::new(loaded)));
            Ok(())
        })
        .manage(BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_tab,
            commands::close_tab,
            commands::navigate_tab,
            commands::select_tab,
            commands::eval_tab,
            commands::get_tab_url,
            commands::list_tabs,
            commands::get_settings,
            commands::set_settings,
            commands::user_agent_for,
            commands::block_url,
            commands::get_filters_css,
            commands::blocked_total,
            commands::clear_data,
            commands::set_night_mode,
            commands::search_suggest,
        ])
        .run(tauri::generate_context!())
        .expect("error while running via browser");
}
