use serde::{Deserialize, Serialize};

pub const DEFAULT_HOMEPAGE: &str = "https://www.google.com/";

/// A single user script (Tampermonkey-style) executed on matching pages.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct UserScript {
    pub id: String,
    pub name: String,
    pub match_urls: String, // semicolon-separated; empty = all
    pub code: String,
    pub enabled: bool,
}

impl Default for UserScript {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New script".into(),
            match_urls: String::new(),
            code: String::new(),
            enabled: true,
        }
    }
}

/// Per-site configuration override (Via's "Site configuration").
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteConfig {
    pub host: String,
    pub ua_mode: String,       // "", "Desktop", "Mobile", "Custom"
    pub adblock_enabled: bool, // host-level adblock override
}

impl Default for SiteConfig {
    fn default() -> Self {
        Self { host: String::new(), ua_mode: String::new(), adblock_enabled: true }
    }
}

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
    pub night_mode: bool,
    pub desktop_mode: bool,
    pub text_size: f64,          // zoom factor, 0.5..=3.0; 1.0 = normal
    pub show_images: bool,       // false = hide all images (img { display:none })
    pub network_log: bool,       // "Network log" capture toggle
    pub search_suggest: bool,     // live search suggestions (off by default:
                                  // avoids per-keystroke network calls that
                                  // trigger CAPTCHA/typing lag)
    pub game_mode: bool,         // Via's "Game mode" (max performance / block refresh)
    pub read_aloud_enabled: bool,
    pub scripts: Vec<UserScript>,
    pub sites: Vec<SiteConfig>,
    pub pages_log: Vec<Vec<String>>,
    pub restore_tabs: bool,
    pub homepage_shortcuts: Vec<HomeShortcut>,
    pub toolbar_layout: ToolbarLayout,
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
            night_mode: false,
            desktop_mode: true,
            text_size: 1.0,
            show_images: true,
            network_log: false,
            search_suggest: false,
            game_mode: false,
            read_aloud_enabled: false,
            scripts: Vec::new(),
            sites: Vec::new(),
            pages_log: Vec::new(),
            restore_tabs: false,
            homepage_shortcuts: Vec::new(),
            toolbar_layout: ToolbarLayout::default(),
        }
    }
}

pub fn resolve_ua(settings: &Settings) -> Option<String> {
    match settings.ua_mode.as_str() {
        "Desktop" => Some(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0".into(),
        ),
        "Mobile" => Some(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36".into(),
        ),
        "Via" => Some(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 Via/7.2.1".into(),
        ),
        "Custom" => {
            let ua = settings.custom_ua.trim();
            if ua.is_empty() { None } else { Some(ua.to_string()) }
        }
        _ => None,
    }
}

/// A single homepage speed-dial shortcut (Via's "Add to homepage").
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HomeShortcut {
    pub label: String,
    pub url: String,
    pub icon: String,
}

impl Default for HomeShortcut {
    fn default() -> Self {
        Self { label: String::new(), url: String::new(), icon: "🌐".into() }
    }
}

/// Toolbar customization layout (Via-style).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolbarLayout {
    /// Where the toolbar is placed: "top" (default), "bottom".
    pub placement: String,
    /// Ordered list of toolbar button IDs to show.  Omitted IDs are hidden.
    pub visible: Vec<String>,
    /// Compact two-row mode: split toolbar into two rows for wide screens.
    pub compact_two_row: bool,
}

impl Default for ToolbarLayout {
    fn default() -> Self {
        Self {
            placement: "top".into(),
            visible: vec![
                "back".into(), "fwd".into(), "reload".into(),
                "addr".into(), "home".into(), "menu".into(), "tabs".into(),
            ],
            compact_two_row: false,
        }
    }
}
