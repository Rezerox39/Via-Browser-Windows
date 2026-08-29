//! Via's actual Reader Mode, extracted from the Android APK (j6/w.java + j6/c0.java).
//! These are the unmodified originals: Readability.js, Via's readerable
//! detection, Via's reader CSS, and Via's full reader renderer.

const READABILITY: &str = include_str!("../assets/reader/readability.js");
const READERABLE: &str = include_str!("../assets/reader/readerable.js");
const READER_CSS: &str = include_str!("../assets/reader/reader.css");
const READER_RENDER: &str = include_str!("../assets/reader/reader-render.js");
const READER_CLOSE: &str = include_str!("../assets/reader/reader-close.js");

/// Full script that loads Readability, the readerable detector, Via's reader
/// CSS, then runs Via's renderer (which auto-runs once the DOM is ready).
#[tauri::command]
pub fn reader_bundle() -> String {
    let css_json = serde_json::to_string(READER_CSS).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  if (window.__viaReaderLoaded) return;
  {READABILITY}
  {READERABLE}
  var st = document.createElement("style");
  st.id = "__via_reader_css__";
  st.textContent = {css_json};
  (document.head || document.documentElement).appendChild(st);
  window.__viaReaderLoaded = true;
}})();
{READER_RENDER}
"#
    )
}

/// Removes the reader overlay and restores the page (Via's close script).
#[tauri::command]
pub fn reader_close() -> String {
    READER_CLOSE.to_string()
}
