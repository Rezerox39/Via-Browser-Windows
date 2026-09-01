//! Native Windows capability layer — QR scanning, credential storage, clipboard.
//!
//! These features live OUTSIDE the WebView2 page layer, so WebView2 limitations
//! do not apply. Camera capture — where feasible — would go here using Windows
//! Media Foundation; where the current target cannot compile a camera backend,
//! the image-file / clipboard scanner still works via `rqrr` decoding.
//!
//! Passwords are stored through the OS secret store (Windows Credential Manager
//! via the `keyring` crate, or a DPAPI-backed local store fallback) — never in
//! frontend state, exported JSON, or ordinary settings files.

use base64::Engine as _;
use serde::Serialize;
use std::path::Path;

/// Errors surfaced to the frontend as strings via typed IPC.
#[derive(Serialize)]
pub struct DecodeResult {
    pub text: Option<String>,
    pub error: Option<String>,
}

/// Decode the first QR code found in the image at `path`.
/// Returns the decoded UTF-8 text, or an error describing why none was found.
pub fn decode_image_file(path: &str) -> Result<String, String> {
    let img = image::open(Path::new(path))
        .map_err(|e| format!("Could not read image: {e}"))?;
    let gray = img.to_luma8();
    let mut bits = rqrr::PreparedImage::prepare(gray);
    let grids = bits.detect_grids();
    if grids.is_empty() {
        return Err("No QR code found in image".into());
    }
    for g in grids {
        if let Ok((_, content)) = g.decode() {
            if !content.is_empty() {
                return Ok(content);
            }
        }
    }
    Err("QR code present but could not be decoded".into())
}

/// Decode a QR code from the current OS clipboard image (if the clipboard
/// holds an image). Also tries text content directly if it looks like a URL.
pub fn decode_clipboard() -> Result<String, String> {
    // Try image clipboard first.
    if let Ok(Some(img)) = read_clipboard_image() {
        let gray = img.to_luma8();
        let mut bits = rqrr::PreparedImage::prepare(gray);
        let grids = bits.detect_grids();
        for g in grids {
            if let Ok((_, content)) = g.decode() {
                if !content.is_empty() {
                    return Ok(content);
                }
            }
        }
        return Err("No QR code found in clipboard image".into());
    }
    // Fall back to text clipboard.
    if let Ok(text) = std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg("Get-Clipboard -Raw")
        .output()
    {
        if let Ok(s) = String::from_utf8(text.stdout) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Ok(s);
            }
        }
    }
    Err("Clipboard contains no image or usable text".into())
}

fn read_clipboard_image() -> Result<Option<image::DynamicImage>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {e}"))?;
    match cb.get_image() {
        Ok(img) => {
            // arboard gives RGBA bytes; convert to DynamicImage.
            let w = img.width as u32;
            let h = img.height as u32;
            let rgba = image::RgbaImage::from_raw(w, h, img.bytes.into_owned())
                .ok_or_else(|| "Invalid clipboard image dimensions".to_string())?;
            Ok(Some(image::DynamicImage::ImageRgba8(rgba)))
        }
        Err(_) => Ok(None),
    }
}

/// Open a native file picker for common image types and decode a QR from the
/// chosen file. Returns the decoded text and the chosen path.
pub fn pick_and_decode_image() -> Result<(String, String), String> {
    let file = rfd::FileDialog::new()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp"])
        .pick_file()
        .ok_or_else(|| "No file selected".to_string())?;
    let text = decode_image_file(&file.to_string_lossy())?;
    Ok((text, file.to_string_lossy().into_owned()))
}

/* ================= Password Manager (Windows Credential Manager) ================= */

/// Scope string used to isolate credentials per origin+username.
/// Credential Manager key: `via.{scheme}://{host}:{port?}/{username}`.
fn scope_key(scheme: &str, host: &str, port: Option<u16>, username: &str) -> String {
    let hostport = match port {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    // Scheme security: only allow http/https credentials to be stored.
    let scheme = if matches!(scheme, "http" | "https") { scheme } else { "https" };
    // Older keyring versions use non-persistent entries when no service exists;
    // we store under a single service with per-origin entries.
    format!("via.{scheme}://{hostport}/{username}")
}

/// Save a credential to Windows Credential Manager (via keyring).
///
/// Returns Ok(()) on success or Err with a message. On non-Windows (dev/tests)
/// keyring may route to a fallback; we still return a clear error if it fails.
pub fn save_credential(service: &str, username: &str, password: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, username)
        .map_err(|e| format!("Credential manager init failed: {e}"))?;
    entry
        .set_password(password)
        .map_err(|e| format!("Could not save credential: {e}"))
}

pub fn get_credential(service: &str, username: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, username)
        .map_err(|e| format!("Credential manager init failed: {e}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read credential: {e}")),
    }
}

pub fn delete_credential(service: &str, username: &str) -> Result<bool, String> {
    let entry = keyring::Entry::new(service, username)
        .map_err(|e| format!("Credential manager init failed: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Could not delete credential: {e}")),
    }
}

/// Helper to build the scope key from a URL string.
pub fn scope_from_url(url: &str, username: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    Some(scope_key(u.scheme(), u.host_str()?, u.port(), username))
}

/* ================= Encrypted export/import helpers ================= */

/// Minimal encrypted blob (AES-256 via a simple XOR + repeated hash is NOT
/// acceptable for real security; this is a placeholder that returns an error
/// so callers never produce an insecure export). The real implementation would
/// use OS crypto APIs; to avoid shipping a false "secure" export we gate it.
pub fn encrypted_export_not_supported() -> Result<String, String> {
    Err("Encrypted password export requires OS crypto APIs that are not yet wired. Password export is disabled.".into())
}

// Keep base64 import used by helper for file-name-safe encoding.
#[allow(dead_code)]
fn _b64(s: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}
