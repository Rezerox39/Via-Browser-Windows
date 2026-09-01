//! WebView2 Runtime detection and prerequisite error dialog.
//!
//! Before Tauri can create any webview, a compatible Microsoft WebView2
//! Runtime must be installed on the user's machine.  This module detects
//! both per-user and per-machine installations via the Windows registry,
//! and when the runtime is missing it shows a Via-branded native dialog
//! that lets the user install the Evergreen Bootstrapper or retry.

use std::ffi::CString;

// ── Win32 FFI declarations ───────────────────────────────────────────

#[cfg_attr(windows, link(name = "user32"))]
unsafe extern "system" {
    #[cfg(windows)]
    fn MessageBoxA(
        hWnd: *mut core::ffi::c_void,
        lpText: *const i8,
        lpCaption: *const i8,
        uType: u32,
    ) -> i32;
}

// Win32 button / style constants
const MB_OKCANCEL: u32 = 0x00000001;
const MB_ICONERROR: u32 = 0x00000010;
const MB_ICONINFO: u32 = 0x00000040;
const IDOK: i32 = 1;
const IDCANCEL: i32 = 2;

// WebView2 Runtime registry GUID
const WV2_GUID: &str = "{F3017226-FE2A-4295-8BEB-235B8ED43A9A}";
const WV2_BOOTSTRAPPER_URL: &str =
    "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

// ── Public API ───────────────────────────────────────────────────────

/// Check whether a compatible WebView2 Runtime is installed.
///
/// Checks the per-user registry hive first (no elevation needed), then the
/// per-machine hive.  Returns Ok(version_string) on success or Err with a
/// human-readable explanation on failure.
pub fn check_webview2_runtime() -> Result<String, String> {
    // Strategy 1 – per-user installation (HKCU)
    if let Some(v) = registry_check("HKCU") {
        return Ok(v);
    }
    // Strategy 2 – per-machine installation (HKLM, includes WOW6432Node)
    if let Some(v) = registry_check("HKLM") {
        return Ok(v);
    }
    // Strategy 3 – try loading the DLL directly from the app dir or system32
    if probe_dll() {
        return Ok("detected via DLL presence".into());
    }
    Err("WebView2 Runtime not installed".into())
}

/// Show a Via-branded prerequisite dialog.  The dialog offers:
///   • Retry – re-check the registry
///   • Install – open the Evergreen Bootstrapper download page
///   • Close – exit the application
///
/// Returns `Ok(())` when a runtime is available (after retry succeeds or
/// the user installs it externally) or `Err(())` when the user cancels.
pub fn show_prerequisite_dialog(error: &str) -> Result<(), ()> {
    let title = CString::new("Via Browser — Setup Required").unwrap();

    let body = CString::new(format!(
        "Via Browser needs Microsoft WebView2 Runtime to display web pages.\n\n\
         Error: {error}\n\n\
         WebView2 is a free runtime from Microsoft. It is NOT Microsoft Edge.\n\n\
         Click \"Install\" to open the official download page, install the\n\
         Evergreen Bootstrapper, then click \"Retry\".\n\n\
         If you are offline, download the Evergreen Standalone Installer from:\n\
         https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n\n\
         Detected architecture: {}",
        std::env::consts::ARCH
    ))
    .unwrap();

    let install_label = CString::new("Install WebView2").unwrap();
    let retry_label = CString::new("Retry").unwrap();

    loop {
        // Dialog 1: Explain the problem with Retry / Install / Cancel buttons.
        // We use two sequential MB dialogs to simulate a multi-button dialog:
        //   First:  MB_ICONERROR | MB_RETRYCANCEL  →  Retry or Cancel
        //   Then if Retry: re-check; if Cancel: ask "Install?".
        #[cfg(windows)]
        {
            unsafe {
                let result = MessageBoxA(
                    core::ptr::null_mut(),
                    body.as_ptr(),
                    title.as_ptr(),
                    MB_OKCANCEL | MB_ICONERROR,
                );
                if result == IDOK {
                    // Retry
                    match check_webview2_runtime() {
                        Ok(_ver) => return Ok(()),
                        Err(_) => {
                            // Offer to open the download page
                            let confirm = CString::new(
                                "WebView2 is still missing.\n\n\
                                 Click OK to open the official download page,\n\
                                 install the Evergreen Bootstrapper, then come\n\
                                 back and click Retry.\n\n\
                                 Copy this link if needed:\n\
                                 https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
                            )
                            .unwrap();
                            let retry2 = MessageBoxA(
                                core::ptr::null_mut(),
                                confirm.as_ptr(),
                                title.as_ptr(),
                                MB_OKCANCEL | MB_ICONINFO,
                            );
                            if retry2 == IDOK {
                                let _ = open_url(WV2_BOOTSTRAPPER_URL);
                                // Now show a "Retry / Cancel" dialog
                                let retry_text =
                                    CString::new("Click OK after installing WebView2 Runtime.").unwrap();
                                let r3 = MessageBoxA(
                                    core::ptr::null_mut(),
                                    retry_text.as_ptr(),
                                    title.as_ptr(),
                                    MB_OKCANCEL | MB_ICONINFO,
                                );
                                if r3 == IDOK {
                                    if check_webview2_runtime().is_ok() {
                                        return Ok(());
                                    }
                                    // Still missing – loop again
                                } else {
                                    return Err(());
                                }
                            }
                        }
                    }
                } else {
                    return Err(());
                }
            }
        }

        // Non-Windows: can't show a native dialog; just return error.
        #[cfg(not(windows))]
        {
            eprintln!("[Via] {error}");
            eprintln!("[Via] Please install Microsoft WebView2 Runtime:");
            eprintln!("[Via]   {WV2_BOOTSTRAPPER_URL}");
            return Err(());
        }
    }
}

// ── Internal helpers ─────────────────────────────────────────────────

/// Check a single registry hive for the WebView2 Runtime version.
fn registry_check(hive: &str) -> Option<String> {
    let paths = [
        format!(
            "{hive}\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{WV2_GUID}"
        ),
        format!(
            "{hive}\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{WV2_GUID}"
        ),
    ];
    for path in &paths {
        if let Some(v) = read_registry_value(path, "pv") {
            if !v.is_empty() && v != "0.0.0.0" {
                return Some(v);
            }
        }
    }
    None
}

/// Read a single string value from the Windows registry via PowerShell.
fn read_registry_value(path: &str, value_name: &str) -> Option<String> {
    let ps = format!(
        "Get-ItemProperty -Path '{path}' -Name '{value_name}' \
         -ErrorAction SilentlyContinue | Select-Object -ExpandProperty '{value_name}'"
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || out.status.code() != Some(0) { None } else { Some(s) }
}

/// Last-resort check: see if the WebView2 loader DLL is next to the exe.
fn probe_dll() -> bool {
    let names = ["WebView2Loader.dll", "EvergreenLoader.dll"];
    for name in &names {
        if std::path::PathBuf::from(name).exists() {
            return true;
        }
        // Also check next to the current exe.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                if dir.join(name).exists() {
                    return true;
                }
            }
        }
    }
    false
}

/// Open a URL in the default browser via PowerShell Start-Process.
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("Start-Process '{url}'"),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open browser: {e}"))
}
