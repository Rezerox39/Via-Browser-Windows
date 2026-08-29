use serde::{Deserialize, Serialize};

pub const DEFAULT_HOMEPAGE: &str = "https://www.bing.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub homepage: String,
    pub search_engine: String,
    pub ua_mode: String,
    pub custom_ua: String,
    pub adblock_enabled: bool,
    pub clear_on_exit: bool,
    pub user_css: String,
    pub user_js: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            homepage: DEFAULT_HOMEPAGE.to_string(),
            search_engine: "Google".to_string(),
            ua_mode: "Desktop".to_string(),
            custom_ua: String::new(),
            adblock_enabled: true,
            clear_on_exit: false,
            user_css: String::new(),
            user_js: String::new(),
        }
    }
}

pub fn resolve_ua(settings: &Settings) -> Option<String> {
    match settings.ua_mode.as_str() {
        "Mobile" => Some(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36".into(),
        ),
        "Via Android" => Some(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 Via/7.2.1".into(),
        ),
        "Custom" => {
            let ua = settings.custom_ua.trim();
            if ua.is_empty() { None } else { Some(ua.to_string()) }
        }
        _ => None,
    }
}
